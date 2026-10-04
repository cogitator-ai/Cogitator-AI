import { EventEmitter } from 'node:events';
import { Agent, tool, toolToSchema } from '@cogitator-ai/core';
import {
  DeepgramSTT,
  ElevenLabsTTS,
  EnergyVAD,
  OpenAISTT,
  OpenAITTS,
  RealtimeSession,
  VoiceAgent,
  VoicePipeline,
  audioMimeType,
  calculateRMS,
  createCogitatorRunner,
  detectAudioFormat,
  float32ToPcm16,
  pcm16ToFloat32,
  pcmToWav,
  resample,
  voiceTools,
  wavToPcm,
  type STTProvider,
  type STTStream,
  type TTSProvider,
  type TranscribeResult,
} from '@cogitator-ai/voice';
import { z } from 'zod';
import type { StageContext, StageDefinition } from '../../runner/types.js';
import { FrameClient, excerpt, until } from './shared.js';

const VOICE = '@cogitator-ai/voice';
const CORE = '@cogitator-ai/core';

const RATE = 16_000;
const FRAME_MS = 20;
const ORDER = 'A-7731';
const CARRIER = 'Kestrel Freight';
const SPOKEN_QUESTION = 'Where is my order A 7731, and which carrier has it?';

const SpokenAudio = z.object({ audioBase64: z.string(), format: z.string() });
const Transcript = z.object({ text: z.string() });

/** A sine tone (or silence at amplitude 0) as float samples. */
function tone(ms: number, amplitude: number, rate = RATE, hz = 440): Float32Array {
  const samples = new Float32Array(Math.round((rate * ms) / 1000));
  for (let i = 0; i < samples.length; i++)
    samples[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return samples;
}

/** Splits PCM16 audio into fixed-size frames, as a microphone would deliver it. */
function frames(pcm: Buffer, ms = FRAME_MS, rate = RATE): Buffer[] {
  const size = Math.round((rate * ms) / 1000) * 2;
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < pcm.length; offset += size)
    chunks.push(pcm.subarray(offset, offset + size));
  return chunks;
}

function orderTool(onLookup: () => void) {
  return tool({
    name: 'order_status',
    description: 'Shipping status of a customer order.',
    parameters: z.object({ order: z.string().describe('Order number, e.g. A-1234') }),
    execute: async ({ order }) => {
      onLookup();
      return order.replace(/\s+/g, '-').toUpperCase().includes('7731')
        ? { order: ORDER, status: 'shipped', carrier: CARRIER }
        : { order, status: 'unknown' };
    },
  });
}

function supportAgent(ctx: StageContext, onLookup: () => void): Agent {
  return new Agent({
    name: 'voice-desk',
    model: ctx.model,
    instructions:
      'You are a voice support agent. Look orders up with order_status. Answer in one short spoken sentence without markdown.',
    tools: [orderTool(onLookup)],
    maxIterations: 4,
  });
}

class ScriptedStream extends EventEmitter implements STTStream {
  private bytes = 0;

  constructor(private readonly onClose: (bytes: number) => TranscribeResult) {
    super();
  }

  write(chunk: Buffer): void {
    if (this.bytes === 0) this.emit('partial', 'listening');
    this.bytes += chunk.length;
  }

  async close(): Promise<TranscribeResult> {
    const result = this.onClose(this.bytes);
    this.emit('final', result);
    return result;
  }
}

/**
 * A speech recognizer for a machine without speech keys: it hears whatever audio the session
 * routes to it and reports a fixed utterance, recording how many bytes reached it.
 */
class ScriptedSTT implements STTProvider {
  readonly name = 'scripted';
  readonly heard: number[] = [];

  constructor(private readonly utterance: string) {}

  async transcribe(audio: Buffer): Promise<TranscribeResult> {
    this.heard.push(audio.length);
    return { text: this.utterance };
  }

  createStream(): STTStream {
    return new ScriptedStream((bytes) => {
      this.heard.push(bytes);
      return { text: bytes > 0 ? this.utterance : '' };
    });
  }
}

/** A synthesizer that renders each sentence as a short tone, so the audio path carries real PCM. */
class ToneTTS implements TTSProvider {
  readonly name = 'tone';
  readonly spoken: string[] = [];

  async synthesize(text: string): Promise<Buffer> {
    this.spoken.push(text);
    return pcmToWav(float32ToPcm16(tone(200, 0.3, 24_000)), 24_000);
  }

  async *streamSynthesize(text: string): AsyncGenerator<Buffer> {
    this.spoken.push(text);
    for (let i = 0; i < 2; i++) yield float32ToPcm16(tone(100, 0.3, 24_000));
  }
}

/** Proves the audio utilities, VAD, WebSocket transport and pipeline sessions work around a real agent. */
const voicePipeline: StageDefinition = {
  id: 'voice-pipeline',
  title: 'Voice pipeline',
  description:
    'Audio utilities and EnergyVAD handle synthetic speech, and a VoiceAgent serves a WebSocket client end to end: microphone frames, VAD turns, transcript, a real agent answer with a tool call, audio back, and memory across turns (speech providers scripted, no voice keys needed).',
  packages: [VOICE, CORE],
  needs: ['handshake'],
  timeoutMs: 150_000,
  async run(ctx) {
    await ctx.check('audio utilities round-trip PCM, WAV and sample rates', (evidence) => {
      const sine = tone(1000, 0.5);
      const pcm = float32ToPcm16(sine);
      const back = pcm16ToFloat32(pcm);
      const maxError = back.reduce(
        (max, value, i) => Math.max(max, Math.abs(value - (sine[i] ?? 0))),
        0
      );
      const wav = pcmToWav(pcm, RATE);
      const decoded = wavToPcm(wav);
      const downsampled = resample(sine, RATE, 8_000);
      const rms = calculateRMS(sine);
      const format = detectAudioFormat(wav);
      evidence('maxError', Number(maxError.toFixed(6)));
      evidence('wav', { bytes: wav.length, format, mime: format ? audioMimeType(format) : null });
      evidence('decoded', { sampleRate: decoded.sampleRate, samples: decoded.samples.length });
      evidence('resampled', downsampled.length);
      evidence('rms', Number(rms.toFixed(4)));
      if (maxError > 1e-3) throw new Error('PCM16 round trip lost precision');
      if (format !== 'wav' || audioMimeType('wav') !== 'audio/wav') {
        throw new Error('WAV was not detected');
      }
      if (decoded.sampleRate !== RATE || decoded.samples.length !== sine.length) {
        throw new Error('WAV decode is off');
      }
      if (Math.abs(downsampled.length - sine.length / 2) > 2) {
        throw new Error('Resampling to 8 kHz did not halve the samples');
      }
      if (Math.abs(rms - 0.5 / Math.SQRT2) > 0.01) throw new Error(`RMS of a 0.5 sine is ${rms}`);
      if (detectAudioFormat(pcm) !== null) throw new Error('Raw PCM was mistaken for a container');
    });

    await ctx.check('EnergyVAD finds the start and end of speech', (evidence) => {
      const vad = new EnergyVAD({ threshold: 0.02, silenceDuration: 300, sampleRate: RATE });
      const events: string[] = [];
      let duration = 0;
      const audio = [
        ...frames(float32ToPcm16(tone(400, 0)), FRAME_MS),
        ...frames(float32ToPcm16(tone(600, 0.4))),
        ...frames(float32ToPcm16(tone(500, 0))),
      ];
      for (const frame of audio) {
        const event = vad.process(pcm16ToFloat32(frame));
        if (event.type === 'speech_start' || event.type === 'speech_end') events.push(event.type);
        if (event.type === 'speech_end') duration = event.duration;
      }
      evidence('events', events);
      evidence('speechMs', Math.round(duration));
      if (events.join() !== 'speech_start,speech_end') {
        throw new Error(`VAD events: ${events.join()}`);
      }
      if (Math.abs(duration - 600) > 60) {
        throw new Error(`Speech measured ${duration} ms, expected about 600`);
      }
    });

    let lookups = 0;
    const stt = new ScriptedSTT(SPOKEN_QUESTION);
    const tts = new ToneTTS();
    const runtime = ctx.createCogitator({ memory: { adapter: 'memory' } });
    const voiceAgent = new VoiceAgent({
      mode: 'pipeline',
      agent: createCogitatorRunner(
        runtime,
        supportAgent(ctx, () => lookups++)
      ),
      stt,
      tts,
      vad: new EnergyVAD({ threshold: 0.02, silenceDuration: 400, sampleRate: RATE }),
      ttsOptions: { format: 'pcm16' },
      transport: { path: '/voice', maxConnections: 4 },
    });
    const voiceErrors: string[] = [];
    voiceAgent.on('error', (error) => voiceErrors.push(error.message));
    const port = await ctx.freePort();
    await voiceAgent.listen(port);
    ctx.onCleanup(() => voiceAgent.close());

    const client = await FrameClient.connect(`ws://127.0.0.1:${port}/voice`);
    ctx.onCleanup(() => client.close());
    const types = () => client.json.map((frame) => frame.type);
    const turnEnds = () => types().filter((type) => type === 'turn_end').length;

    await ctx.check(
      'a spoken question becomes a spoken answer over WebSocket',
      async (evidence) => {
        await until(() => voiceAgent.activeSessions === 1, 5_000, 'the voice session', ctx.signal);
        const speech = float32ToPcm16(tone(700, 0.4));
        const microphone = [
          ...frames(float32ToPcm16(tone(200, 0))),
          ...frames(speech),
          ...frames(float32ToPcm16(tone(700, 0))),
        ];
        for (const frame of microphone) client.sendBinary(new Uint8Array(frame));
        await client.waitFor(
          () => turnEnds() >= 1 || voiceErrors.length > 0,
          90_000,
          'the first turn_end'
        );
        if (voiceErrors.length > 0) {
          throw new Error(`VoiceAgent reported: ${voiceErrors.join('; ')}`);
        }
        const answer = client.json.find((frame) => frame.type === 'agent_response');
        const finalTranscript = client.json.find(
          (frame) => frame.type === 'transcript' && frame.isFinal === true
        );
        const audioFrames = client.frames.filter((frame) => frame.kind === 'binary').length;
        evidence('events', [...new Set(types())]);
        evidence('sttHeardBytes', [...stt.heard]);
        evidence('sentSpeechBytes', speech.length);
        evidence('answer', typeof answer?.text === 'string' ? excerpt(answer.text, 160) : null);
        evidence('audioFrames', audioFrames);
        evidence('lookups', lookups);
        for (const expected of [
          'speech_start',
          'speech_end',
          'transcript',
          'agent_response',
          'turn_end',
        ]) {
          if (!types().includes(expected)) {
            throw new Error(`No ${expected} event reached the client`);
          }
        }
        if (finalTranscript?.text !== SPOKEN_QUESTION) {
          throw new Error('The final transcript was not forwarded');
        }
        const heard = stt.heard[0] ?? 0;
        if (heard < speech.length || heard > speech.length * 2) {
          throw new Error(
            `The recognizer got ${heard} bytes for ${speech.length} bytes of speech: VAD gating is off`
          );
        }
        if (lookups === 0) throw new Error('The agent answered without order_status');
        if (typeof answer?.text !== 'string' || !answer.text.includes('Kestrel')) {
          throw new Error('The spoken answer does not name the carrier');
        }
        if (audioFrames === 0 || tts.spoken[0] !== answer.text) {
          throw new Error('The answer was not synthesized and sent');
        }
      }
    );

    await ctx.check('a text turn on the same session remembers the order', async (evidence) => {
      client.sendJson({ type: 'text', text: 'Which order number was that? Say only the number.' });
      await client.waitFor(
        () => turnEnds() >= 2 || voiceErrors.length > 0,
        90_000,
        'the second turn_end'
      );
      if (voiceErrors.length > 0) throw new Error(`VoiceAgent reported: ${voiceErrors.join('; ')}`);
      const answers = client.json.filter((frame) => frame.type === 'agent_response');
      const second = answers[1]?.text;
      evidence('answer', second);
      evidence('sessions', voiceAgent.activeSessions);
      if (typeof second !== 'string' || !second.includes('7731')) {
        throw new Error('The second turn forgot the order');
      }
    });

    await ctx.check('voice tools become agent tools as they are', async (evidence) => {
      const [transcribeVoice, speakVoice] = voiceTools({ stt, tts });
      const transcribe = tool(transcribeVoice);
      const speak = tool(speakVoice);
      const schema = toolToSchema(speak);
      const context = { agentId: 'voice-desk', runId: 'gauntlet-voice-tools', signal: ctx.signal };
      const spoken = SpokenAudio.parse(
        await speak.execute({ text: 'Your parcel is out for delivery.', format: 'pcm16' }, context)
      );
      const heard = Transcript.parse(
        await transcribe.execute({ audioBase64: spoken.audioBase64 }, context)
      );
      evidence('speakParameters', Object.keys(schema.parameters.properties));
      evidence('audioBytes', Buffer.from(spoken.audioBase64, 'base64').length);
      evidence('transcript', heard.text);
      if (!('text' in schema.parameters.properties)) {
        throw new Error('speak_text lost its text parameter');
      }
      if (spoken.format !== 'pcm16' || spoken.audioBase64.length === 0) {
        throw new Error('speak_text returned no PCM');
      }
      if (tts.spoken.at(-1) !== 'Your parcel is out for delivery.') {
        throw new Error('speak_text did not reach the synthesizer');
      }
      if (heard.text !== SPOKEN_QUESTION) {
        throw new Error('transcribe_audio did not reach the recognizer');
      }
    });

    await ctx.check('unknown control messages are reported, not fatal', async (evidence) => {
      client.sendJson({ type: 'self-destruct' });
      await until(() => voiceErrors.length > 0, 5_000, 'the error event', ctx.signal);
      evidence('error', voiceErrors[0]);
      evidence('stillConnected', voiceAgent.activeSessions);
      if (!(voiceErrors[0] ?? '').includes('Unknown control message')) {
        throw new Error('The error does not name the problem');
      }
      if (voiceAgent.activeSessions !== 1) throw new Error('The session was dropped');
      voiceErrors.length = 0;
    });
  },
};

/** Proves the OpenAI speech providers, the voice tools, the pipeline and the realtime session against the real API. */
const voiceOpenAI: StageDefinition = {
  id: 'voice-openai',
  title: 'Voice on OpenAI',
  description:
    'OpenAI TTS and STT round-trip speech through the voice tools, a VoicePipeline answers a spoken question with the gauntlet agent, and a realtime session answers a text turn with a tool.',
  packages: [VOICE, CORE],
  needs: ['handshake'],
  requires: [{ kind: 'env', name: 'OPENAI_API_KEY', why: 'OpenAI speech and realtime APIs' }],
  timeoutMs: 180_000,
  async run(ctx) {
    const apiKey = process.env.OPENAI_API_KEY ?? '';
    const stt = new OpenAISTT({ apiKey });
    const tts = new OpenAITTS({ apiKey });
    const [transcribe, speak] = voiceTools({ stt, tts });

    const question = await ctx.check(
      'speech round-trips through speak_text and transcribe_audio',
      async (evidence) => {
        const spoken = speak.parameters.parse({ text: SPOKEN_QUESTION, format: 'wav' });
        const audio = SpokenAudio.parse(await speak.execute(spoken));
        const wav = Buffer.from(audio.audioBase64, 'base64');
        const heard = Transcript.parse(
          await transcribe.execute(transcribe.parameters.parse({ audioBase64: audio.audioBase64 }))
        );
        evidence('format', detectAudioFormat(wav));
        evidence('bytes', wav.length);
        evidence('transcript', heard.text);
        if (detectAudioFormat(wav) !== 'wav') throw new Error('speak_text did not return WAV');
        if (!heard.text.replace(/\s/g, '').includes('7731')) {
          throw new Error('The transcript lost the order number');
        }
        return wav;
      }
    );

    await ctx.check('a VoicePipeline answers a spoken question', async (evidence) => {
      let lookups = 0;
      const runtime = ctx.createCogitator({ memory: { adapter: 'memory' } });
      const pipeline = new VoicePipeline({
        stt,
        tts,
        agent: createCogitatorRunner(
          runtime,
          supportAgent(ctx, () => lookups++)
        ),
        ttsOptions: { format: 'pcm16' },
      });
      const result = await pipeline.process(question, { sessionId: 'gauntlet-voice' });
      evidence('transcript', result.transcript);
      evidence('response', excerpt(result.response, 160));
      evidence('audioBytes', result.audio.length);
      evidence('lookups', lookups);
      if (lookups === 0) throw new Error('The agent answered without order_status');
      if (!result.response.includes('Kestrel')) {
        throw new Error('The answer does not name the carrier');
      }
      if (result.audio.length === 0) throw new Error('No audio was synthesized');
    });

    await ctx.check('a realtime session answers a text turn with a tool', async (evidence) => {
      const calls: string[] = [];
      const transcripts: string[] = [];
      const errors: string[] = [];
      let turns = 0;
      const session = new RealtimeSession({
        provider: 'openai',
        apiKey,
        instructions:
          'You are a support agent. Use order_status for any order question. Answer briefly.',
        tools: [
          {
            name: 'order_status',
            description: 'Shipping status of a customer order.',
            parameters: {
              type: 'object',
              properties: { order: { type: 'string' } },
              required: ['order'],
            },
            execute: async () => ({ order: ORDER, status: 'shipped', carrier: CARRIER }),
          },
        ],
      });
      ctx.onCleanup(() => session.close());
      session.on('tool_call', (name) => calls.push(name));
      session.on('transcript', (text, role) => {
        if (role === 'assistant') transcripts.push(text);
      });
      session.on('turn_end', () => turns++);
      session.on('error', (error) => errors.push(error.message));
      await session.connect();
      session.sendText(`Which carrier has order ${ORDER}?`);
      await until(
        () => (calls.length > 0 && transcripts.join('').includes('Kestrel')) || errors.length > 0,
        60_000,
        'the realtime answer',
        ctx.signal
      );
      evidence('toolCalls', calls);
      evidence('turns', turns);
      evidence('answer', excerpt(transcripts.join(''), 160));
      if (errors.length > 0) throw new Error(`Realtime session errors: ${errors.join('; ')}`);
    });
  },
};

/** Proves the ElevenLabs synthesizer and the Deepgram recognizer, batch and streaming. */
const voiceDeepgramElevenLabs: StageDefinition = {
  id: 'voice-deepgram-elevenlabs',
  title: 'Voice on Deepgram and ElevenLabs',
  description:
    'ElevenLabs synthesizes a sentence as PCM and in a stream, and Deepgram recognizes it in batch and over its streaming WebSocket with partial and final results.',
  packages: [VOICE],
  requires: [
    { kind: 'env', name: 'ELEVENLABS_API_KEY', why: 'ElevenLabs speech synthesis' },
    { kind: 'env', name: 'DEEPGRAM_API_KEY', why: 'Deepgram speech recognition' },
  ],
  timeoutMs: 120_000,
  async run(ctx) {
    const tts = new ElevenLabsTTS({ apiKey: process.env.ELEVENLABS_API_KEY ?? '' });
    const stt = new DeepgramSTT({
      apiKey: process.env.DEEPGRAM_API_KEY ?? '',
      language: 'en',
      sampleRate: RATE,
    });

    const pcm = await ctx.check('ElevenLabs synthesizes PCM and streams', async (evidence) => {
      const raw = await tts.synthesize(SPOKEN_QUESTION, { format: 'pcm16' });
      let streamed = 0;
      let chunks = 0;
      for await (const chunk of tts.streamSynthesize('Thank you for waiting.')) {
        streamed += chunk.length;
        chunks++;
      }
      const at16k = float32ToPcm16(resample(pcm16ToFloat32(raw), 24_000, RATE));
      evidence('pcmBytes', raw.length);
      evidence('seconds', Number((raw.length / 2 / 24_000).toFixed(2)));
      evidence('stream', { chunks, bytes: streamed });
      if (raw.length < 24_000) {
        throw new Error('The synthesized speech is shorter than half a second');
      }
      if (calculateRMS(pcm16ToFloat32(raw)) < 0.01) {
        throw new Error('The synthesized audio is silent');
      }
      if (chunks === 0 || streamed === 0) throw new Error('streamSynthesize yielded nothing');
      return at16k;
    });

    await ctx.check('Deepgram transcribes the WAV in one request', async (evidence) => {
      const result = await stt.transcribe(pcmToWav(pcm, RATE));
      evidence('text', result.text);
      evidence('duration', result.duration);
      if (!result.text.replace(/\s/g, '').includes('7731')) {
        throw new Error('The transcript lost the order number');
      }
    });

    await ctx.check('Deepgram streams partial and final results', async (evidence) => {
      const stream = stt.createStream({ interimResults: true, endpointing: 300 });
      const partials: string[] = [];
      const finals: string[] = [];
      stream.on('partial', (text) => partials.push(text));
      stream.on('final', (result) => finals.push(result.text));
      for (const frame of frames(pcm, 100)) {
        stream.write(frame);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      for (const frame of frames(float32ToPcm16(tone(800, 0)), 100)) stream.write(frame);
      const result = await stream.close();
      evidence('partials', partials.length);
      evidence('finals', finals);
      evidence('text', result.text);
      if (!result.text.replace(/\s/g, '').includes('7731')) {
        throw new Error('The streamed transcript lost the order number');
      }
      if (finals.length === 0) throw new Error('No final segment was emitted');
    });
  },
};

export const voiceStages: StageDefinition[] = [voicePipeline, voiceOpenAI, voiceDeepgramElevenLabs];
