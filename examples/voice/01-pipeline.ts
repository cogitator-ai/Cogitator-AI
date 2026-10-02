import { Agent } from '@cogitator-ai/core';
import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { OpenAISTT, OpenAITTS, VoicePipeline, createCogitatorRunner } from '@cogitator-ai/voice';

async function main() {
  header('01 — Voice Pipeline');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log('Set OPENAI_API_KEY to run this example');
    process.exit(0);
  }

  section('1. Configure STT & TTS');
  const stt = new OpenAISTT({ apiKey });
  const tts = new OpenAITTS({ apiKey, voice: 'coral' });
  console.log('STT: OpenAI gpt-transcribe');
  console.log('TTS: OpenAI gpt-4o-mini-tts (coral voice)');

  section('2. Create pipeline with a Cogitator agent');
  const cogitator = createCogitator();
  const agent = new Agent({
    name: 'voice-assistant',
    model: process.env.GOOGLE_API_KEY ? DEFAULT_MODEL : 'openai/gpt-6-luna',
    instructions: 'You are a voice assistant. Answer in one short sentence.',
  });
  const pipeline = new VoicePipeline({ stt, tts, agent: createCogitatorRunner(cogitator, agent) });

  section('3. Record a question (synthesized with TTS)');
  const question = await tts.synthesize('What is the capital of France?', { format: 'wav' });
  console.log(`Question audio: ${question.length} bytes (WAV)`);

  section('4. Process through pipeline');
  const result = await pipeline.process(question, { sessionId: 'example' });
  console.log(`Transcript: "${result.transcript}"`);
  console.log(`Response:   "${result.response}"`);
  console.log(`Audio size: ${result.audio.length} bytes (MP3)`);

  await cogitator.close();
  console.log('\nDone.');
}

void main();
