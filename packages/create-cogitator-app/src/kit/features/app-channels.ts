import { code } from '../code.js';
import { runScript } from '../package-manager.js';
import type { ChannelKind } from '../spec.js';
import { cogitatorVersion, VERSIONS } from '../versions.js';
import { LIFECYCLE_TS, startupImports, startupStatements } from './shared.js';
import type { FeatureModule } from './types.js';

export const WEBCHAT_PORT = 18789;

interface ChannelSetup {
  factory: string;
  expression: string;
  packages: Array<[string, string]>;
  env: Array<{ name: string; description: string; required: boolean }>;
}

const CHANNEL_SETUP: Record<ChannelKind, ChannelSetup> = {
  telegram: {
    factory: 'telegramChannel',
    expression: 'telegramChannel({ token: env.TELEGRAM_BOT_TOKEN })',
    packages: [['grammy', VERSIONS.grammy]],
    env: [
      {
        name: 'TELEGRAM_BOT_TOKEN',
        description: 'Telegram bot token, from @BotFather',
        required: true,
      },
    ],
  },
  discord: {
    factory: 'discordChannel',
    expression: 'discordChannel({ token: env.DISCORD_BOT_TOKEN, mentionOnly: true })',
    packages: [['discord.js', VERSIONS.discord]],
    env: [
      {
        name: 'DISCORD_BOT_TOKEN',
        description: 'Discord bot token, from the Developer Portal',
        required: true,
      },
    ],
  },
  slack: {
    factory: 'slackChannel',
    expression: code`
      slackChannel({
        token: env.SLACK_BOT_TOKEN,
        signingSecret: env.SLACK_SIGNING_SECRET,
        appToken: env.SLACK_APP_TOKEN,
      })
    `,
    packages: [['@slack/bolt', VERSIONS.slackBolt]],
    env: [
      { name: 'SLACK_BOT_TOKEN', description: 'Slack bot token (xoxb-...)', required: true },
      { name: 'SLACK_SIGNING_SECRET', description: 'Slack signing secret', required: true },
      {
        name: 'SLACK_APP_TOKEN',
        description: 'Slack app token (xapp-...) for Socket Mode, HTTP mode without it',
        required: false,
      },
    ],
  },
  webchat: {
    factory: 'webchatChannel',
    expression: `webchatChannel({ port: Number(env.WEBCHAT_PORT ?? ${WEBCHAT_PORT}) })`,
    packages: [['ws', VERSIONS.ws]],
    env: [],
  },
};

/** A messaging bot: one Gateway that answers on every chosen channel with the assistant. */
export const appChannelsFeature: FeatureModule = {
  id: 'app:channels',
  applies: (spec) => spec.app === 'channels',
  apply(project) {
    const { spec } = project;
    project.dependency('@cogitator-ai/channels', cogitatorVersion('@cogitator-ai/channels'));

    for (const channel of spec.channels) {
      const setup = CHANNEL_SETUP[channel];
      for (const [name, version] of setup.packages) project.dependency(name, version);
      for (const variable of setup.env) project.envVar({ ...variable, secret: true });
    }
    if (spec.channels.includes('webchat')) {
      project.envVar({
        name: 'WEBCHAT_PORT',
        description: 'Port of the WebChat WebSocket',
        example: String(WEBCHAT_PORT),
        required: false,
        secret: false,
      });
      project.deploy.port = WEBCHAT_PORT;
    }

    project
      .file('src/lifecycle.ts', LIFECYCLE_TS)
      .devDependency('tsx', VERSIONS.tsx)
      .script('dev', 'tsx watch --env-file-if-exists=.env src/index.ts')
      .script('build', 'tsc -p tsconfig.build.json')
      .script('start', 'node --env-file-if-exists=.env dist/index.js');
    project.deploy.kind = 'worker';

    project.instruct(
      'You talk to people through chat apps, so keep answers short and conversational.'
    );
  },
  finalize(project) {
    const { spec } = project;
    const channels = spec.channels.map((channel) => CHANNEL_SETUP[channel]);
    const memory = spec.memory !== 'none';

    project.file(
      'src/gateway.ts',
      code`
        import { Gateway, ${channels.map((c) => c.factory).join(', ')} } from '@cogitator-ai/channels';
        import { agents, cogitator } from './cogitator.js';
        import { loadEnv } from './env.js';
        ${startupImports(project)}

        const env = loadEnv();
        ${startupStatements(project)}
        ${memory && 'const memory = await cogitator.getMemory();'}

        /**
         * The assistant on its channels. \`src/index.ts\` starts it, and so do
         * \`cogitator assistant\` (with a live dashboard), \`cogitator build\` and
         * \`cogitator daemon\`, which look for this export.
         */
        export const gateway = new Gateway({
          cogitator,
          agent: agents.assistant,
          channels: [
            ${channels.map((c) => `${c.expression},`).join('\n')}
          ],
          ${
            memory &&
            code`
              ...(memory && {
                memory,
                session: { compaction: { strategy: 'hybrid' as const, messageThreshold: 50, keepRecent: 10 } },
              }),
            `
          }
          stream: { flushInterval: 500, minChunkSize: 20 },
          onError: (error, message) => {
            console.error(\`[\${message.channelType}:\${message.userId}] \${error.message}\`);
          },
        });
      `
    );

    const webchat = spec.channels.includes('webchat');
    project.file(
      'src/index.ts',
      code`
        import { cogitator } from './cogitator.js';
        ${webchat && "import { loadEnv } from './env.js';"}
        import { gateway } from './gateway.js';
        import { onShutdown } from './lifecycle.js';

        await gateway.start();
        console.log(\`The assistant is listening on \${gateway.stats.connectedChannels.join(', ')}\`);
        ${webchat && `console.log(\`WebChat: ws://localhost:\${loadEnv().WEBCHAT_PORT ?? ${WEBCHAT_PORT}}/ws\`);`}

        onShutdown(async () => {
          await gateway.stop();
          await cogitator.close();
        });
      `
    );

    const pm = spec.packageManager;
    project.section(
      'Bot',
      code`
        \`src/gateway.ts\` builds a \`Gateway\` from \`@cogitator-ai/channels\` that answers on ${spec.channels.join(', ')} with \`agents.assistant\`, and \`src/index.ts\` starts it. Each chat is its own thread${memory ? ' in memory, compacted when it grows long' : ''}. Channel tokens come from \`.env\`. \`${runScript(pm, 'dev')}\` runs it with reload on change, \`cogitator assistant\` with a live dashboard, \`cogitator daemon start\` in the background.
      `
    );
  },
};
