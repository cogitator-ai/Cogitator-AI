import http from 'node:http';
import { Agent } from '@cogitator-ai/core';
import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import {
  VoiceAgent,
  DeepgramSTT,
  ElevenLabsTTS,
  OpenAITTS,
  EnergyVAD,
  TwilioSessionTokens,
  createCogitatorRunner,
  twilioStreamTwiml,
  validateTwilioWebhook,
} from '@cogitator-ai/voice';

const PORT = Number(process.env.PORT ?? 8080);
const MAX_WEBHOOK_BODY = 64 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > MAX_WEBHOOK_BODY) req.destroy(new Error('Webhook body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function main() {
  header('05 - Twilio Phone Agent (Media Streams)');

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const publicHost = process.env.PUBLIC_HOST;
  const deepgramKey = process.env.DEEPGRAM_API_KEY;
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (
    !process.env.GOOGLE_API_KEY ||
    !authToken ||
    !publicHost ||
    !deepgramKey ||
    (!elevenLabsKey && !openaiKey)
  ) {
    console.log(
      'Set GOOGLE_API_KEY, TWILIO_AUTH_TOKEN, PUBLIC_HOST (the public host of this server, such as ' +
        'abc.ngrok.app), DEEPGRAM_API_KEY and ELEVENLABS_API_KEY or OPENAI_API_KEY to run this example'
    );
    process.exit(0);
  }

  const webhookUrl = `https://${publicHost}/voice`;
  const streamUrl = `wss://${publicHost}/twilio`;

  section('1. Create the Cogitator agent');
  const cogitator = createCogitator({ memory: { adapter: 'memory' } });
  const agent = new Agent({
    name: 'phone-assistant',
    model: DEFAULT_MODEL,
    instructions:
      'You answer phone calls for a small bakery. Speak in one or two short sentences. ' +
      'The bakery is open 7am to 3pm, Tuesday to Sunday.',
  });

  section('2. Create the voice agent for phone audio');
  const voiceAgent = new VoiceAgent({
    agent: createCogitatorRunner(cogitator, agent),
    mode: 'pipeline',
    stt: new DeepgramSTT({ apiKey: deepgramKey, model: 'nova-3' }),
    tts: elevenLabsKey
      ? new ElevenLabsTTS({ apiKey: elevenLabsKey })
      : new OpenAITTS({ apiKey: openaiKey! }),
    vad: () => new EnergyVAD({ threshold: 0.02, sampleRate: 8000 }),
    bargeIn: true,
  });
  voiceAgent.on('call_start', (call) =>
    console.log(`  Call ${call.callSid} from ${call.grant?.metadata.from ?? 'unknown'}`)
  );
  voiceAgent.on('dtmf', (_sessionId, digit) => console.log(`  Caller pressed ${digit}`));
  voiceAgent.on('session_end', (id) => console.log(`  Session ended: ${id}`));
  voiceAgent.on('error', (err) => console.error(`  Error: ${err.message}`));

  section('3. Serve the TwiML webhook and the media stream');
  const tokens = new TwilioSessionTokens();
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/voice') {
      res.writeHead(404).end();
      return;
    }
    readBody(req)
      .then((body) => {
        const signature = req.headers['x-twilio-signature'];
        const valid = validateTwilioWebhook({
          authToken,
          signature: Array.isArray(signature) ? signature[0] : signature,
          url: webhookUrl,
          body,
        });
        if (!valid) {
          res.writeHead(403).end();
          return;
        }
        const params = new URLSearchParams(body);
        const token = tokens.issue({
          callSid: params.get('CallSid') ?? undefined,
          metadata: { from: params.get('From') ?? 'unknown' },
        });
        const twiml = twilioStreamTwiml({ url: streamUrl, token });
        res.writeHead(200, { 'Content-Type': 'text/xml' }).end(twiml);
      })
      .catch(() => res.writeHead(400).end());
  });

  voiceAgent.attachTwilio(server, {
    authToken,
    streamUrl,
    tokens,
    dtmfInput: (digit) =>
      digit === '0' ? 'The caller pressed 0 to hear the opening hours.' : undefined,
  });
  await new Promise<void>((resolve) => server.listen(PORT, resolve));

  console.log(`Listening on port ${PORT}`);
  console.log(`Set the voice webhook of your Twilio number to POST ${webhookUrl}`);
  console.log(`Calls stream to ${streamUrl}. Press Ctrl+C to stop.\n`);

  process.on('SIGINT', async () => {
    await voiceAgent.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cogitator.close();
    process.exit(0);
  });
}

void main();
