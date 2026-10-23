import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VoicePipeline } from '../../pipeline/voice-pipeline';
import type { STTProvider, TTSProvider, VADEvent, VADProvider } from '../../types';
import { float32ToPcm16 } from '../../audio';

function createMockSTT(): STTProvider {
  return {
    name: 'mock-stt',
    transcribe: vi.fn().mockResolvedValue({ text: 'Hello' }),
    createStream: vi.fn().mockReturnValue({
      write: vi.fn(),
      close: vi.fn().mockResolvedValue({ text: 'Hello from stream' }),
      on: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      removeAllListeners: vi.fn().mockReturnThis(),
    }),
  };
}

function createMockTTS(): TTSProvider {
  return {
    name: 'mock-tts',
    synthesize: vi.fn().mockResolvedValue(Buffer.from('audio-data')),
    streamSynthesize: vi.fn().mockImplementation(async function* () {
      yield Buffer.from('chunk1');
      yield Buffer.from('chunk2');
    }),
  };
}

function createMockAgent() {
  return { run: vi.fn().mockResolvedValue({ content: 'Hi there!' }) };
}

describe('VoicePipeline', () => {
  let stt: STTProvider;
  let tts: TTSProvider;
  let agent: ReturnType<typeof createMockAgent>;
  let pipeline: VoicePipeline;

  beforeEach(() => {
    vi.clearAllMocks();
    stt = createMockSTT();
    tts = createMockTTS();
    agent = createMockAgent();
    pipeline = new VoicePipeline({ stt, tts, agent });
  });

  it('creates with required config', () => {
    expect(pipeline).toBeInstanceOf(VoicePipeline);
  });

  it('creates with optional VAD and sampleRate', () => {
    const vad: VADProvider = {
      name: 'mock-vad',
      process: vi.fn().mockReturnValue({ type: 'silence' }),
      reset: vi.fn(),
    };
    const p = new VoicePipeline({ stt, tts, agent, vad, sampleRate: 48000 });
    expect(p).toBeInstanceOf(VoicePipeline);
  });

  describe('a VAD per session', () => {
    /** Starts speaking on loud audio, and stays speaking until reset */
    class LatchVAD implements VADProvider {
      readonly name = 'latch';
      speaking = false;
      resets = 0;
      process(samples: Float32Array): VADEvent {
        if (this.speaking) return { type: 'speech', probability: 1 };
        if (samples.some((s) => Math.abs(s) > 0.1)) {
          this.speaking = true;
          return { type: 'speech_start' };
        }
        return { type: 'silence' };
      }
      reset(): void {
        this.speaking = false;
        this.resets++;
      }
    }

    const loud = float32ToPcm16(new Float32Array(160).fill(0.5));

    it('gives each session a VAD from the factory', async () => {
      const made: LatchVAD[] = [];
      const p = new VoicePipeline({
        stt,
        tts,
        agent,
        vad: () => {
          const vad = new LatchVAD();
          made.push(vad);
          return vad;
        },
      });
      const first = p.createSession();
      const second = p.createSession();
      expect(made).toHaveLength(2);

      const started = vi.fn();
      second.on('speech_start', started);
      first.pushAudio(loud);
      await vi.waitFor(() => expect(made[0]!.speaking).toBe(true));
      expect(made[1]!.speaking).toBe(false);
      expect(started).not.toHaveBeenCalled();

      first.interrupt();
      expect(made[0]!.resets).toBe(1);
      expect(made[1]!.resets).toBe(0);
    });

    it('clones an instance that can be cloned', () => {
      const clones: LatchVAD[] = [];
      const template = Object.assign(new LatchVAD(), {
        clone: () => {
          const vad = new LatchVAD();
          clones.push(vad);
          return vad;
        },
      });
      const p = new VoicePipeline({ stt, tts, agent, vad: template });
      p.createSession().pushAudio(loud);
      p.createSession();
      expect(clones).toHaveLength(2);
      expect(template.speaking).toBe(false);
    });

    it('disposes the VAD a session made when it closes, never a shared one', async () => {
      const made: Array<LatchVAD & { dispose: ReturnType<typeof vi.fn> }> = [];
      const fromFactory = new VoicePipeline({
        stt,
        tts,
        agent,
        vad: () => {
          const vad = Object.assign(new LatchVAD(), { dispose: vi.fn() });
          made.push(vad);
          return vad;
        },
      });
      await fromFactory.createSession().close();
      expect(made[0]!.dispose).toHaveBeenCalledTimes(1);

      const shared = Object.assign(new LatchVAD(), { dispose: vi.fn() });
      const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
      try {
        await new VoicePipeline({ stt, tts, agent, vad: shared }).createSession().close();
      } finally {
        warn.mockRestore();
      }
      expect(shared.dispose).not.toHaveBeenCalled();
    });

    it('warns when sessions share a VAD without clone', () => {
      const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
      try {
        const p = new VoicePipeline({ stt, tts, agent, vad: new LatchVAD() });
        p.createSession();
        expect(warn).not.toHaveBeenCalled();
        p.createSession();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('no clone()'), {
          code: 'COGITATOR_SHARED_VAD',
        });
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('process()', () => {
    it('runs full STT -> Agent -> TTS pipeline', async () => {
      const audio = Buffer.from('test-audio');
      await pipeline.process(audio);

      expect(stt.transcribe).toHaveBeenCalledWith(audio);
      expect(agent.run).toHaveBeenCalledWith('Hello', undefined);
      expect(tts.synthesize).toHaveBeenCalledWith('Hi there!', undefined);
    });

    it('answers with run() and one synthesis even when the runner streams', async () => {
      const stream = vi.fn();
      const p = new VoicePipeline({ stt, tts, agent: { ...agent, stream } });

      const result = await p.process(Buffer.from('test-audio'));

      expect(result.response).toBe('Hi there!');
      expect(stream).not.toHaveBeenCalled();
      expect(tts.synthesize).toHaveBeenCalledTimes(1);
    });

    it('rejects a maxSentenceLength that is not a positive integer', () => {
      expect(() =>
        new VoicePipeline({ stt, tts, agent, maxSentenceLength: 0 }).createSession()
      ).toThrow(RangeError);
    });

    it('passes ttsOptions to synthesize', async () => {
      const ttsOptions = { format: 'pcm16' as const, voice: 'nova' };
      const p = new VoicePipeline({ stt, tts, agent, ttsOptions });

      await p.process(Buffer.from('test-audio'));

      expect(tts.synthesize).toHaveBeenCalledWith('Hi there!', ttsOptions);
    });

    it('returns transcript, response, and audio', async () => {
      const audio = Buffer.from('test-audio');
      const result = await pipeline.process(audio);

      expect(result.transcript).toBe('Hello');
      expect(result.response).toBe('Hi there!');
      expect(result.audio).toEqual(Buffer.from('audio-data'));
    });

    it('passes transcript to agent correctly', async () => {
      (stt.transcribe as ReturnType<typeof vi.fn>).mockResolvedValue({
        text: 'What is the weather?',
      });
      agent.run.mockResolvedValue({ content: 'It is sunny today.' });

      const result = await pipeline.process(Buffer.from('audio'));

      expect(agent.run).toHaveBeenCalledWith('What is the weather?', undefined);
      expect(result.transcript).toBe('What is the weather?');
      expect(result.response).toBe('It is sunny today.');
    });

    it('propagates STT errors', async () => {
      (stt.transcribe as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('STT failed'));

      await expect(pipeline.process(Buffer.from('audio'))).rejects.toThrow('STT failed');
    });

    it('propagates agent errors', async () => {
      agent.run.mockRejectedValue(new Error('Agent failed'));

      await expect(pipeline.process(Buffer.from('audio'))).rejects.toThrow('Agent failed');
    });

    it('propagates TTS errors', async () => {
      (tts.synthesize as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('TTS failed'));

      await expect(pipeline.process(Buffer.from('audio'))).rejects.toThrow('TTS failed');
    });
  });

  describe('createSession()', () => {
    it('returns a PipelineSession', () => {
      const session = pipeline.createSession();
      expect(session).toBeDefined();
      expect(typeof session.pushAudio).toBe('function');
      expect(typeof session.interrupt).toBe('function');
      expect(typeof session.close).toBe('function');
    });
  });
});
