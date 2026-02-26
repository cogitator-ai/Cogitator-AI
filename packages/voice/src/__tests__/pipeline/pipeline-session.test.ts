import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PipelineSession } from '../../pipeline/pipeline-session';
import type { STTProvider, STTStream, TTSProvider, VADProvider, VADEvent } from '../../types';

function createMockStream(): STTStream {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    write: vi.fn(),
    close: vi.fn().mockResolvedValue({ text: 'final transcript' }),
    on: vi.fn().mockImplementation(function (
      this: STTStream,
      event: string,
      cb: (...args: unknown[]) => void
    ) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
      return this;
    }),
    off: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockImplementation(function (this: STTStream) {
      listeners.clear();
      return this;
    }),
    _emit: (event: string, ...args: unknown[]) => {
      for (const cb of listeners.get(event) ?? []) cb(...args);
    },
  } as STTStream & { _emit: (event: string, ...args: unknown[]) => void };
}

function createMockSTT(stream?: STTStream): STTProvider {
  const mockStream = stream ?? createMockStream();
  return {
    name: 'mock-stt',
    transcribe: vi.fn().mockResolvedValue({ text: 'Hello' }),
    createStream: vi.fn().mockReturnValue(mockStream),
  };
}

function createMockTTS(): TTSProvider {
  return {
    name: 'mock-tts',
    synthesize: vi.fn().mockResolvedValue(Buffer.from('full-audio')),
    streamSynthesize: vi.fn().mockImplementation(async function* () {
      yield Buffer.from('chunk1');
      yield Buffer.from('chunk2');
    }),
  };
}

function createMockAgent() {
  return { run: vi.fn().mockResolvedValue({ content: 'Agent response' }) };
}

function createMockVAD(): VADProvider & { _event: VADEvent } {
  const mock = {
    name: 'mock-vad',
    _event: { type: 'silence' } as VADEvent,
    process: vi.fn().mockImplementation(() => mock._event),
    reset: vi.fn(),
  };
  return mock;
}

describe('PipelineSession', () => {
  let stt: STTProvider;
  let tts: TTSProvider;
  let agent: ReturnType<typeof createMockAgent>;
  let vad: ReturnType<typeof createMockVAD>;
  let stream: STTStream & { _emit: (event: string, ...args: unknown[]) => void };
  let session: PipelineSession;

  beforeEach(() => {
    vi.clearAllMocks();
    stream = createMockStream() as STTStream & {
      _emit: (event: string, ...args: unknown[]) => void;
    };
    stt = createMockSTT(stream);
    tts = createMockTTS();
    agent = createMockAgent();
    vad = createMockVAD();
  });

  afterEach(async () => {
    if (session) await session.close();
  });

  describe('with VAD', () => {
    beforeEach(() => {
      session = new PipelineSession({ stt, tts, agent, vad });
    });

    it('emits speech_start when VAD detects speech', async () => {
      const handler = vi.fn();
      session.on('speech_start', handler);

      vad._event = { type: 'speech_start' };
      session.pushAudio(Buffer.alloc(320));

      await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    });

    it('emits speech_end when VAD detects end', async () => {
      const handler = vi.fn();
      session.on('speech_end', handler);

      vad._event = { type: 'speech_start' };
      session.pushAudio(Buffer.alloc(320));

      vad._event = { type: 'speech_end', duration: 1500 };
      session.pushAudio(Buffer.alloc(320));

      await vi.waitFor(() => expect(handler).toHaveBeenCalled());
    });

    it('does not feed audio to STT during silence', async () => {
      vad._event = { type: 'silence' };
      session.pushAudio(Buffer.alloc(320));

      await new Promise((r) => setTimeout(r, 10));
      expect(stt.createStream).not.toHaveBeenCalled();
    });

    it('opens STT stream on speech_start', async () => {
      vad._event = { type: 'speech_start' };
      session.pushAudio(Buffer.alloc(320));

      await vi.waitFor(() => expect(stt.createStream).toHaveBeenCalled());
    });

    it('feeds audio to STT stream during speech', async () => {
      vad._event = { type: 'speech_start' };
      const chunk = Buffer.alloc(320);
      session.pushAudio(chunk);

      await vi.waitFor(() => expect(stt.createStream).toHaveBeenCalled());

      vad._event = { type: 'speech', probability: 0.9 };
      const chunk2 = Buffer.alloc(320);
      session.pushAudio(chunk2);

      await vi.waitFor(() => expect(stream.write).toHaveBeenCalledWith(chunk2));
    });
  });

  describe('without VAD', () => {
    beforeEach(() => {
      session = new PipelineSession({ stt, tts, agent });
    });

    it('starts listening immediately on pushAudio', () => {
      session.pushAudio(Buffer.alloc(320));

      expect(stt.createStream).toHaveBeenCalled();
      expect(stream.write).toHaveBeenCalled();
    });

    it('feeds all audio chunks to STT stream', () => {
      const chunk1 = Buffer.alloc(320);
      const chunk2 = Buffer.alloc(320);
      session.pushAudio(chunk1);
      session.pushAudio(chunk2);

      expect(stream.write).toHaveBeenCalledTimes(2);
    });
  });

  describe('transcript events', () => {
    beforeEach(() => {
      session = new PipelineSession({ stt, tts, agent });
    });

    it('emits partial transcript from STT', () => {
      const handler = vi.fn();
      session.on('transcript', handler);

      session.pushAudio(Buffer.alloc(320));
      stream._emit('partial', 'Hel');

      expect(handler).toHaveBeenCalledWith('Hel', false);
    });

    it('emits final transcript from STT', () => {
      const handler = vi.fn();
      session.on('transcript', handler);

      session.pushAudio(Buffer.alloc(320));
      stream._emit('final', { text: 'Hello world' });

      expect(handler).toHaveBeenCalledWith('Hello world', true);
    });
  });

  describe('agent processing', () => {
    it('emits agent_response after processing transcript', async () => {
      session = new PipelineSession({ stt, tts, agent, vad });
      const handler = vi.fn();
      session.on('agent_response', handler);

      vad._event = { type: 'speech_start' };
      session.pushAudio(Buffer.alloc(320));

      vad._event = { type: 'speech_end', duration: 1000 };
      session.pushAudio(Buffer.alloc(320));

      await vi.waitFor(() => expect(handler).toHaveBeenCalledWith('Agent response'));
    });

    it('runs agent with the STT transcript', async () => {
      (stream.close as ReturnType<typeof vi.fn>).mockResolvedValue({ text: 'Turn on the lights' });
      agent.run.mockResolvedValue({ content: 'Done!' });

      session = new PipelineSession({ stt, tts, agent, vad });

      vad._event = { type: 'speech_start' };
      session.pushAudio(Buffer.alloc(320));

      vad._event = { type: 'speech_end', duration: 500 };
      session.pushAudio(Buffer.alloc(320));

      await vi.waitFor(() => expect(agent.run).toHaveBeenCalledWith('Turn on the lights'));
    });
  });

  describe('TTS audio output', () => {
    it('emits audio chunks from TTS streaming', async () => {
      session = new PipelineSession({ stt, tts, agent, vad });
      const audioChunks: Buffer[] = [];
      session.on('audio', (chunk: Buffer) => audioChunks.push(chunk));

      vad._event = { type: 'speech_start' };
      session.pushAudio(Buffer.alloc(320));

      vad._event = { type: 'speech_end', duration: 500 };
      session.pushAudio(Buffer.alloc(320));

      await vi.waitFor(() => expect(audioChunks.length).toBeGreaterThanOrEqual(2));
      expect(audioChunks[0]).toEqual(Buffer.from('chunk1'));
      expect(audioChunks[1]).toEqual(Buffer.from('chunk2'));
    });

    it('uses streamSynthesize for lower latency', async () => {
      session = new PipelineSession({ stt, tts, agent, vad });

      vad._event = { type: 'speech_start' };
      session.pushAudio(Buffer.alloc(320));

      vad._event = { type: 'speech_end', duration: 500 };
      session.pushAudio(Buffer.alloc(320));

      await vi.waitFor(() => expect(tts.streamSynthesize).toHaveBeenCalledWith('Agent response'));
    });
  });

  describe('interrupt()', () => {
    it('stops current TTS output', async () => {
      let yieldControl!: () => void;
      const blockingPromise = new Promise<void>((resolve) => {
        yieldControl = resolve;
      });

      (tts.streamSynthesize as ReturnType<typeof vi.fn>).mockImplementation(async function* () {
        yield Buffer.from('first-chunk');
        await blockingPromise;
        yield Buffer.from('should-not-reach');
      });

      session = new PipelineSession({ stt, tts, agent, vad });
      const audioChunks: Buffer[] = [];
      session.on('audio', (chunk: Buffer) => audioChunks.push(chunk));

      vad._event = { type: 'speech_start' };
      session.pushAudio(Buffer.alloc(320));

      vad._event = { type: 'speech_end', duration: 500 };
      session.pushAudio(Buffer.alloc(320));

      await vi.waitFor(() => expect(audioChunks.length).toBe(1));

      session.interrupt();
      yieldControl();

      await new Promise((r) => setTimeout(r, 50));

      expect(audioChunks).toHaveLength(1);
      expect(audioChunks[0]).toEqual(Buffer.from('first-chunk'));
    });

    it('resets state to idle after interrupt', async () => {
      session = new PipelineSession({ stt, tts, agent, vad });

      vad._event = { type: 'speech_start' };
      session.pushAudio(Buffer.alloc(320));

      vad._event = { type: 'speech_end', duration: 500 };
      session.pushAudio(Buffer.alloc(320));

      await vi.waitFor(() => expect(tts.streamSynthesize).toHaveBeenCalled());

      session.interrupt();

      await new Promise((r) => setTimeout(r, 50));

      expect(vad.reset).toHaveBeenCalled();
    });
  });

  describe('close()', () => {
    it('cleans up resources', async () => {
      session = new PipelineSession({ stt, tts, agent, vad });

      vad._event = { type: 'speech_start' };
      session.pushAudio(Buffer.alloc(320));

      await vi.waitFor(() => expect(stt.createStream).toHaveBeenCalled());

      await session.close();

      expect(stream.removeAllListeners).toHaveBeenCalled();
    });

    it('ignores pushAudio after close', async () => {
      session = new PipelineSession({ stt, tts, agent });
      session.pushAudio(Buffer.alloc(320));
      await session.close();

      const writeCalls = (stream.write as ReturnType<typeof vi.fn>).mock.calls.length;
      session.pushAudio(Buffer.alloc(320));
      expect((stream.write as ReturnType<typeof vi.fn>).mock.calls.length).toBe(writeCalls);
    });
  });

  describe('error handling', () => {
    it('emits error on agent failure', async () => {
      agent.run.mockRejectedValue(new Error('Agent exploded'));

      session = new PipelineSession({ stt, tts, agent, vad });
      const errors: Error[] = [];
      session.on('error', (err: Error) => errors.push(err));

      vad._event = { type: 'speech_start' };
      session.pushAudio(Buffer.alloc(320));

      vad._event = { type: 'speech_end', duration: 500 };
      session.pushAudio(Buffer.alloc(320));

      await vi.waitFor(() => expect(errors.length).toBe(1));
      expect(errors[0]!.message).toBe('Agent exploded');
    });

    it('emits error on STT stream failure', async () => {
      (stream.close as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('STT crashed'));

      session = new PipelineSession({ stt, tts, agent, vad });
      const errors: Error[] = [];
      session.on('error', (err: Error) => errors.push(err));

      vad._event = { type: 'speech_start' };
      session.pushAudio(Buffer.alloc(320));

      vad._event = { type: 'speech_end', duration: 500 };
      session.pushAudio(Buffer.alloc(320));

      await vi.waitFor(() => expect(errors.length).toBe(1));
      expect(errors[0]!.message).toBe('STT crashed');
    });

    it('emits error from STT stream error event', () => {
      session = new PipelineSession({ stt, tts, agent });
      const errors: Error[] = [];
      session.on('error', (err: Error) => errors.push(err));

      session.pushAudio(Buffer.alloc(320));
      stream._emit('error', new Error('Stream error'));

      expect(errors.length).toBe(1);
      expect(errors[0]!.message).toBe('Stream error');
    });
  });

  describe('endAudio()', () => {
    it('triggers finishListening when state is listening (no VAD mode)', async () => {
      session = new PipelineSession({ stt, tts, agent });
      const handler = vi.fn();
      session.on('agent_response', handler);

      session.pushAudio(Buffer.alloc(320));
      session.endAudio();

      await vi.waitFor(() => expect(handler).toHaveBeenCalledWith('Agent response'));
      expect(stream.close).toHaveBeenCalled();
      expect(agent.run).toHaveBeenCalledWith('final transcript');
    });

    it('is a no-op when state is idle', async () => {
      session = new PipelineSession({ stt, tts, agent });

      session.endAudio();

      await new Promise((r) => setTimeout(r, 50));
      expect(stt.createStream).not.toHaveBeenCalled();
      expect(agent.run).not.toHaveBeenCalled();
    });

    it('is a no-op when state is processing', async () => {
      session = new PipelineSession({ stt, tts, agent, vad });

      vad._event = { type: 'speech_start' };
      session.pushAudio(Buffer.alloc(320));

      vad._event = { type: 'speech_end', duration: 500 };
      session.pushAudio(Buffer.alloc(320));

      const agentCallsBefore = agent.run.mock.calls.length;
      session.endAudio();

      await vi.waitFor(() => expect(agent.run).toHaveBeenCalled());
      expect(agent.run).toHaveBeenCalledTimes(agentCallsBefore === 0 ? 1 : agentCallsBefore);
    });
  });

  describe('activeProcessing', () => {
    it('close() waits for active processing to complete', async () => {
      let resolveAgent!: (value: { content: string }) => void;
      agent.run.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveAgent = resolve;
          })
      );

      session = new PipelineSession({ stt, tts, agent, vad });
      const handler = vi.fn();
      session.on('agent_response', handler);

      vad._event = { type: 'speech_start' };
      session.pushAudio(Buffer.alloc(320));

      vad._event = { type: 'speech_end', duration: 500 };
      session.pushAudio(Buffer.alloc(320));

      await vi.waitFor(() => expect(agent.run).toHaveBeenCalled());

      let closeDone = false;
      const closePromise = session.close().then(() => {
        closeDone = true;
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(closeDone).toBe(false);

      resolveAgent({ content: 'late response' });
      await closePromise;

      expect(closeDone).toBe(true);
    });
  });
});
