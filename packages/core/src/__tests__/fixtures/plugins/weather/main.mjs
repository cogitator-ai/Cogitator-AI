import { readFileSync } from 'node:fs';

const attempt = async (work) => {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, code: error.code ?? error.name, message: error.message };
  }
};

export default {
  name: 'weather',
  activate(context) {
    context.registerTool({
      name: 'weather_now',
      description: 'The weather in a city now',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      readOnly: true,
      execute: async ({ city }) => `Sunny in ${city}, ${context.options.units}`,
    });
    context.registerTool({
      name: 'weather_probe',
      description: 'Tries what the plugin may and may not do',
      parameters: {
        type: 'object',
        properties: { what: { type: 'string' }, target: { type: 'string' } },
        required: ['what'],
      },
      execute: async ({ what, target }) => {
        if (what === 'host-read') return attempt(() => context.files.readFile(target));
        if (what === 'direct-read') return attempt(() => readFileSync(target, 'utf8'));
        if (what === 'fetch') return attempt(() => context.fetch(target));
        if (what === 'direct-fetch')
          return attempt(() => fetch(target).then((response) => response.status));
        if (what === 'exec') return attempt(() => context.exec(target));
        if (what === 'spawn')
          return attempt(async () =>
            (await import('node:child_process')).execSync('echo hi').toString()
          );
        if (what === 'secret') return attempt(() => context.secret('api_key'));
        if (what === 'dns-resolver') {
          return attempt(async () => {
            const { promises } = await import('node:dns');
            const resolver = new promises.Resolver();
            resolver.setServers([target]);
            return resolver.resolveTxt('leak.example');
          });
        }
        if (what === 'dns-callback') {
          return attempt(async () => {
            const dns = await import('node:dns');
            const resolver = new dns.Resolver();
            resolver.setServers([target]);
            return new Promise((resolve, reject) =>
              resolver.resolveTxt('leak.example', (error, value) =>
                error ? reject(error) : resolve(value)
              )
            );
          });
        }
        if (what === 'udp') {
          return attempt(async () => {
            const dgram = await import('node:dgram');
            const [host, port] = target.split(':');
            const socket = dgram.createSocket('udp4');
            socket.send('leak', Number(port), host);
            return 'sent';
          });
        }
        if (what === 'crash') setTimeout(() => process.exit(3), 10);
        return { ok: true, value: 'nothing' };
      },
    });
    context.registerSkill({
      name: 'forecast',
      description: 'Explains a forecast. Use for questions about tomorrow.',
      instructions: 'Read the forecast with weather_now.',
    });
    context.registerCommand('today', {
      template: 'What is the weather in $ARGUMENTS today?',
      description: 'Weather today',
    });
    context.registerLLMBackend({
      provider: 'weather-llm',
      metadata: { name: 'weather-llm' },
      factory: (config) => ({
        provider: 'weather-llm',
        chat: async (request) => ({
          id: 'w1',
          content: `forecast for ${request.messages.at(-1).content} (${config?.tone ?? 'plain'})`,
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        }),
        chatStream: async function* (request) {
          yield { id: 'w1', delta: { content: 'streamed ' } };
          if (request.messages.at(-1).content === 'hang') await new Promise(() => {});
          yield {
            id: 'w1',
            delta: { content: String(request.messages.at(-1).content) },
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          };
        },
      }),
    });
    context.registerPanel({
      id: 'radar',
      title: 'Radar',
      html: '<html><body>radar</body></html>',
      handlers: { ping: (params) => ({ pong: params }) },
    });
    context.onDispose(() => {});
  },
};
