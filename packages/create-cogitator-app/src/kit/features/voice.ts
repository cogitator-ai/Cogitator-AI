import { code } from '../code.js';
import { runScript } from '../package-manager.js';
import { providerInfo } from '../providers.js';
import { hasFeature, type ProjectSpec } from '../spec.js';
import { cogitatorVersion } from '../versions.js';
import { LIFECYCLE_TS } from './shared.js';
import type { FeatureModule } from './types.js';

export const VOICE_PORT = 3000;

const REALTIME_TOOLS_TS = code`
  import { type Cogitator, type Tool, toolToSchema } from '@cogitator-ai/core';
  import type { RealtimeTool } from '@cogitator-ai/voice';

  /**
   * The assistant's tools in the shape a realtime session takes. Each call runs
   * through \`cogitator.invokeTool\`, so arguments are validated and timeouts kept
   * the way an agent run does it. Tools that need approval are left out: a voice
   * session has nobody to click Approve.
   */
  export function realtimeTools(runtime: Cogitator, tools: readonly Tool[]): RealtimeTool[] {
    return tools
      .filter((tool) => !tool.requiresApproval)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: toolToSchema(tool).parameters,
        execute: async (args) => {
          const result = await runtime.invokeTool(tool, args, { agentId: 'voice' });
          return result.error ? { error: result.error } : result.result;
        },
      }));
  }
`;

function voiceEntry(spec: ProjectSpec): string {
  const provider = spec.provider === 'google' ? 'gemini' : 'openai';
  const envKey = providerInfo(spec.provider).envKey ?? 'OPENAI_API_KEY';
  const inputRate = provider === 'openai' ? 24_000 : 16_000;
  return code`
    import { readFile } from 'node:fs/promises';
    import { createServer } from 'node:http';
    import { timingSafeEqual } from 'node:crypto';
    import { createCogitatorRunner, VoiceAgent } from '@cogitator-ai/voice';
    import { agents, cogitator } from './cogitator.js';
    import { loadEnv } from './env.js';
    import { onShutdown } from './lifecycle.js';
    import { tools } from './tools/index.js';
    import { realtimeTools } from './voice/tools.js';

    const env = loadEnv();
    const production = process.env.NODE_ENV === 'production';
    const port = Number(env.PORT ?? ${VOICE_PORT});
    const host = env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1');
    if (production && !env.VOICE_TOKEN) {
      throw new Error('Set VOICE_TOKEN in production: every voice session costs realtime API time');
    }

    /** The browser page, from public/ next to src/ and dist/. */
    const page = await readFile(new URL('../public/index.html', import.meta.url));

    function allowed(token: string | null): boolean {
      if (!env.VOICE_TOKEN) return true;
      if (!token) return false;
      const a = Buffer.from(token);
      const b = Buffer.from(env.VOICE_TOKEN);
      return a.length === b.length && timingSafeEqual(a, b);
    }

    const voice = new VoiceAgent({
      mode: 'realtime',
      agent: createCogitatorRunner(cogitator, agents.assistant),
      realtimeProvider: '${provider}',
      realtimeApiKey: env.${envKey},
      tools: realtimeTools(cogitator, tools),
      transport: {
        path: '/voice',
        maxConnections: 10,
        verifyClient: (req) => allowed(new URL(req.url ?? '/', 'http://localhost').searchParams.get('token')),
      },
    });
    voice.on('error', (error) => console.error(\`voice: \${error.message}\`));

    const server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      } else if (path === '/config') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ inputSampleRate: ${inputRate} }));
      } else if (path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
      } else {
        res.writeHead(404).end();
      }
    });
    voice.attach(server);

    server.listen(port, host, () => {
      console.log(\`Open http://\${host}:\${port} and talk to the assistant\`);
    });

    onShutdown(async () => {
      await voice.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await cogitator.close();
    });
  `;
}

const INDEX_HTML = code`
  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Voice assistant</title>
      <style>
        :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
        body { margin: 0; display: grid; place-items: center; min-height: 100vh; }
        main { width: min(40rem, 100% - 2rem); display: grid; gap: 1rem; }
        button { font: inherit; padding: 0.75rem 1.25rem; border-radius: 999px; border: 1px solid currentColor; cursor: pointer; }
        form { display: flex; gap: 0.5rem; }
        input { flex: 1; font: inherit; padding: 0.5rem 0.75rem; }
        ol { list-style: none; padding: 0; display: grid; gap: 0.5rem; }
        li b { text-transform: capitalize; }
        #status { opacity: 0.7; }
      </style>
    </head>
    <body>
      <main>
        <h1>Talk to the assistant</h1>
        <button id="talk" type="button">Start talking</button>
        <p id="status">Not connected</p>
        <form id="text"><input name="message" placeholder="Or type a message" autocomplete="off" /><button type="submit">Send</button></form>
        <ol id="log"></ol>
      </main>
      <script type="module">
        const OUTPUT_RATE = 24000;
        const RECORDER = \`class Recorder extends AudioWorkletProcessor {
          process(inputs) {
            const input = inputs[0][0];
            if (input) {
              const pcm = new Int16Array(input.length);
              for (let i = 0; i < input.length; i++) {
                const s = Math.max(-1, Math.min(1, input[i]));
                pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
              }
              this.port.postMessage(pcm.buffer, [pcm.buffer]);
            }
            return true;
          }
        }
        registerProcessor('recorder', Recorder);\`;

        const $ = (id) => document.getElementById(id);
        let socket, input, output, stream;
        let playhead = 0;
        const playing = new Set();

        const status = (text) => { $('status').textContent = text; };
        const log = (who, text) => {
          const item = document.createElement('li');
          item.innerHTML = '<b></b>: <span></span>';
          item.querySelector('b').textContent = who;
          item.querySelector('span').textContent = text;
          $('log').prepend(item);
        };

        function stopPlayback() {
          for (const node of playing) node.stop();
          playing.clear();
          playhead = output ? output.currentTime : 0;
        }

        function play(buffer) {
          const pcm = new Int16Array(buffer);
          const audio = output.createBuffer(1, pcm.length, OUTPUT_RATE);
          const channel = audio.getChannelData(0);
          for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;
          const node = output.createBufferSource();
          node.buffer = audio;
          node.connect(output.destination);
          node.onended = () => playing.delete(node);
          playhead = Math.max(playhead, output.currentTime);
          node.start(playhead);
          playhead += audio.duration;
          playing.add(node);
        }

        function onEvent(event) {
          if (event.type === 'speech_start') stopPlayback();
          if (event.type === 'transcript' && event.isFinal !== false && event.text) log(event.role ?? 'you', event.text);
          if (event.type === 'agent_response' && event.text) log('assistant', event.text);
        }

        async function connect() {
          const { inputSampleRate } = await (await fetch('/config')).json();
          const token = new URLSearchParams(location.hash.slice(1)).get('token');
          const url = new URL('/voice', location.href);
          url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          if (token) url.searchParams.set('token', token);

          output = new AudioContext({ sampleRate: OUTPUT_RATE });
          input = new AudioContext({ sampleRate: inputSampleRate });
          await input.audioWorklet.addModule(URL.createObjectURL(new Blob([RECORDER], { type: 'text/javascript' })));
          stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
          const recorder = new AudioWorkletNode(input, 'recorder');
          input.createMediaStreamSource(stream).connect(recorder);

          socket = new WebSocket(url);
          socket.binaryType = 'arraybuffer';
          recorder.port.onmessage = (message) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(message.data);
          };
          socket.onopen = () => status('Listening. Speak, or type below.');
          socket.onmessage = (message) => (typeof message.data === 'string' ? onEvent(JSON.parse(message.data)) : play(message.data));
          socket.onclose = (event) => {
            status(event.code === 1000 ? 'Disconnected' : \`Disconnected: \${event.reason || event.code}\`);
            disconnect();
          };
          $('talk').textContent = 'Stop';
        }

        function disconnect() {
          stopPlayback();
          for (const track of stream?.getTracks() ?? []) track.stop();
          input?.close();
          output?.close();
          if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000);
          socket = input = output = stream = undefined;
          $('talk').textContent = 'Start talking';
        }

        $('talk').addEventListener('click', () => (socket ? disconnect() : connect().catch((error) => status(error.message))));
        $('text').addEventListener('submit', (event) => {
          event.preventDefault();
          const field = event.target.elements.message;
          if (!socket || socket.readyState !== WebSocket.OPEN || !field.value.trim()) return;
          socket.send(JSON.stringify({ type: 'text', text: field.value }));
          log('you', field.value);
          field.value = '';
        });
      </script>
    </body>
  </html>
`;

const VOICE_TEST_TS = code`
  import { describe, expect, it } from 'vitest';
  import { agents } from '../src/cogitator.js';
  import { tools } from '../src/tools/index.js';
  import { realtimeTools } from '../src/voice/tools.js';
  import { mockCogitator } from './helpers.js';

  describe('realtime tools', () => {
    it('offers the assistant tools as JSON Schema', () => {
      const { cogitator } = mockCogitator();
      const bridged = realtimeTools(cogitator, tools);
      const calculator = bridged.find((tool) => tool.name === 'calculator');
      expect(calculator?.parameters).toMatchObject({ type: 'object', properties: { expression: expect.any(Object) } });
      expect(agents.assistant.instructions).toBeTruthy();
    });

    it('runs a call through the runtime and validates its arguments', async () => {
      const { cogitator } = mockCogitator();
      const calculator = realtimeTools(cogitator, tools).find((tool) => tool.name === 'calculator');
      expect(await calculator?.execute({ expression: '6 * 7' })).toEqual({ expression: '6 * 7', result: 42 });
      expect(await calculator?.execute({ expression: 42 })).toMatchObject({ error: expect.any(String) });
      await cogitator.close();
    });
  });
`;

/** A realtime voice agent: speech in, speech out, in the browser over WebSocket. */
export const voiceFeature: FeatureModule = {
  id: 'feature:voice',
  applies: (spec) => hasFeature(spec, 'voice'),
  apply(project) {
    project
      .dependency('@cogitator-ai/voice', cogitatorVersion('@cogitator-ai/voice'))
      .file('src/voice/tools.ts', REALTIME_TOOLS_TS)
      .file('public/index.html', INDEX_HTML)
      .file('tests/voice.test.ts', VOICE_TEST_TS)
      .envVar({
        name: 'PORT',
        description: 'Port of the voice page and WebSocket',
        example: String(VOICE_PORT),
        required: false,
        secret: false,
      })
      .envVar({
        name: 'HOST',
        description: 'Interface to listen on: 127.0.0.1 in development, 0.0.0.0 in production',
        example: '127.0.0.1',
        required: false,
        secret: false,
      })
      .envVar({
        name: 'VOICE_TOKEN',
        description: 'Token the voice page needs in its URL (#token=...), mandatory in production',
        required: false,
        secret: true,
        deploy: true,
      })
      .instruct('You are speaking out loud: keep answers short, plain and easy to follow by ear.');
    project.deploy.kind = 'server';
    project.deploy.port = VOICE_PORT;
    project.deploy.healthPath = '/health';
  },
  finalize(project) {
    const { spec } = project;
    if (spec.app === 'script') {
      project.file('src/index.ts', voiceEntry(spec)).file('src/lifecycle.ts', LIFECYCLE_TS);
    }
    project.section(
      'Voice',
      code`
        \`src/index.ts\` serves \`public/index.html\` and a realtime \`VoiceAgent\` on \`/voice\` (${spec.provider === 'google' ? 'Gemini Live' : 'OpenAI Realtime'}): the page streams the microphone as PCM16, plays the answer and lets you interrupt by talking. \`src/voice/tools.ts\` hands the assistant's tools to the realtime session through \`cogitator.invokeTool\`, leaving out tools that need approval. Run \`${runScript(spec.packageManager, 'dev')}\` and open http://localhost:${VOICE_PORT}. In production set \`VOICE_TOKEN\` and open the page with \`#token=<token>\`.
      `
    );
  },
};
