import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VoicePipeline } from '../../pipeline/voice-pipeline';
import type { STTProvider, TTSProvider, VADProvider } from '../../types';

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

  describe('process()', () => {
    it('runs full STT -> Agent -> TTS pipeline', async () => {
      const audio = Buffer.from('test-audio');
      await pipeline.process(audio);

      expect(stt.transcribe).toHaveBeenCalledWith(audio);
      expect(agent.run).toHaveBeenCalledWith('Hello');
      expect(tts.synthesize).toHaveBeenCalledWith('Hi there!');
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

      expect(agent.run).toHaveBeenCalledWith('What is the weather?');
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
