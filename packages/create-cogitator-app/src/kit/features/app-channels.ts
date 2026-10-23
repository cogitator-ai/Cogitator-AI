import { code } from '../code.js';
import { runScript } from '../package-manager.js';
import type { ChannelKind } from '../spec.js';
import { cogitatorVersion, VERSIONS } from '../versions.js';
import { LIFECYCLE_TS, startupImports, startupStatements } from './shared.js';
import type { FeatureModule } from './types.js';

export const WEBCHAT_PORT = 18789;
export const GITHUB_WEBHOOK_PORT = 8787;
export const TEAMS_PORT = 3978;

/** Where Bluesky sessions and Threads tokens are kept, out of git. */
const TOKENS_PATH = '.cogitator/tokens.json';

interface ChannelSetup {
  factory: string;
  /** Other names the gateway imports from `@cogitator-ai/channels`. */
  imports?: string[];
  expression: string;
  packages: Array<[string, string]>;
  env: Array<{ name: string; description: string; required: boolean; secret?: boolean }>;
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
  bluesky: {
    factory: 'blueskyChannel',
    imports: ['FileTokenStore'],
    expression: code`
      blueskyChannel({
        identifier: env.BLUESKY_HANDLE,
        appPassword: env.BLUESKY_APP_PASSWORD,
        store: new FileTokenStore({ path: '${TOKENS_PATH}' }),
      })
    `,
    packages: [['@atproto/api', VERSIONS.atprotoApi]],
    env: [
      {
        name: 'BLUESKY_HANDLE',
        description: 'Bluesky handle of the bot account, such as yourbot.bsky.social',
        required: true,
      },
      {
        name: 'BLUESKY_APP_PASSWORD',
        description:
          'Bluesky app password (Settings, Privacy and security, App passwords), with direct messages allowed',
        required: true,
      },
    ],
  },
  threads: {
    factory: 'threadsChannel',
    imports: ['FileTokenStore'],
    expression: code`
      threadsChannel({
        accessToken: env.THREADS_ACCESS_TOKEN,
        store: new FileTokenStore({ path: '${TOKENS_PATH}' }),
      })
    `,
    packages: [],
    env: [
      {
        name: 'THREADS_ACCESS_TOKEN',
        description:
          'Threads long-lived access token; it is renewed automatically and kept in .cogitator/tokens.json',
        required: true,
      },
    ],
  },
  github: {
    factory: 'githubChannel',
    expression: code`
      githubChannel({
        token: env.GITHUB_CHANNEL_TOKEN,
        webhook: {
          secret: env.GITHUB_WEBHOOK_SECRET,
          port: Number(env.GITHUB_WEBHOOK_PORT ?? ${GITHUB_WEBHOOK_PORT}),
        },
      })
    `,
    packages: [],
    env: [
      {
        name: 'GITHUB_CHANNEL_TOKEN',
        description:
          'Token of a separate GitHub bot account, scoped to the repositories it answers in, with read and write access to issues and pull requests',
        required: true,
      },
      {
        name: 'GITHUB_WEBHOOK_SECRET',
        description:
          'Secret of the webhook that sends issues, pull requests, comments and reviews to /github/webhook',
        required: true,
      },
    ],
  },
  email: {
    factory: 'emailChannel',
    expression: code`
      emailChannel({
        address: env.EMAIL_ADDRESS,
        allowFrom: env.EMAIL_ALLOW_FROM.split(',')
          .map((entry) => entry.trim())
          .filter(Boolean),
        ...(env.EMAIL_TRUSTED_AUTHSERV_IDS && {
          trustedAuthservIds: env.EMAIL_TRUSTED_AUTHSERV_IDS.split(',').map((id) => id.trim()),
        }),
        imap: {
          host: env.EMAIL_IMAP_HOST,
          port: Number(env.EMAIL_IMAP_PORT ?? 993),
          secure: env.EMAIL_IMAP_SECURE !== 'false',
          auth: { user: env.EMAIL_IMAP_USER ?? env.EMAIL_ADDRESS, pass: env.EMAIL_IMAP_PASSWORD },
        },
        smtp: {
          host: env.EMAIL_SMTP_HOST,
          port: Number(env.EMAIL_SMTP_PORT ?? 587),
          auth: { user: env.EMAIL_SMTP_USER ?? env.EMAIL_ADDRESS, pass: env.EMAIL_SMTP_PASSWORD },
        },
      })
    `,
    packages: [
      ['imapflow', VERSIONS.imapflow],
      ['postal-mime', VERSIONS.postalMime],
      ['nodemailer', VERSIONS.nodemailer],
    ],
    env: [
      {
        name: 'EMAIL_ADDRESS',
        description: 'Address of the bot mailbox, which it reads and sends from',
        required: true,
        secret: false,
      },
      {
        name: 'EMAIL_ALLOW_FROM',
        description:
          'Who may write to the bot: addresses, domains, *.domain or *, comma-separated, since anyone can send mail',
        required: true,
        secret: false,
      },
      {
        name: 'EMAIL_TRUSTED_AUTHSERV_IDS',
        description:
          'The id the mailbox host writes in Authentication-Results (mx.google.com for Gmail), so mail with a forged sender is dropped',
        required: false,
        secret: false,
      },
      {
        name: 'EMAIL_IMAP_HOST',
        description: 'IMAP server of the mailbox, such as imap.gmail.com',
        required: true,
        secret: false,
      },
      {
        name: 'EMAIL_IMAP_PORT',
        description: 'IMAP port: 993 for TLS (default) or 143 with EMAIL_IMAP_SECURE=false',
        required: false,
        secret: false,
      },
      {
        name: 'EMAIL_IMAP_SECURE',
        description: 'Set to false for STARTTLS instead of TLS from the start',
        required: false,
        secret: false,
      },
      {
        name: 'EMAIL_IMAP_USER',
        description: 'IMAP user, EMAIL_ADDRESS when not set',
        required: false,
        secret: false,
      },
      {
        name: 'EMAIL_IMAP_PASSWORD',
        description: 'IMAP password, an app password for Gmail and Outlook',
        required: true,
      },
      {
        name: 'EMAIL_SMTP_HOST',
        description: 'SMTP server it sends through, such as smtp.gmail.com',
        required: true,
        secret: false,
      },
      {
        name: 'EMAIL_SMTP_PORT',
        description: 'SMTP port: 587 for STARTTLS (default) or 465 for TLS',
        required: false,
        secret: false,
      },
      {
        name: 'EMAIL_SMTP_USER',
        description: 'SMTP user, EMAIL_ADDRESS when not set',
        required: false,
        secret: false,
      },
      {
        name: 'EMAIL_SMTP_PASSWORD',
        description: 'SMTP password, often the same app password',
        required: true,
      },
    ],
  },
  teams: {
    factory: 'teamsChannel',
    expression: code`
      teamsChannel({
        appId: env.TEAMS_APP_ID,
        appPassword: env.TEAMS_APP_PASSWORD,
        tenantId: env.TEAMS_TENANT_ID,
        webhook: { port: Number(env.TEAMS_PORT ?? ${TEAMS_PORT}) },
      })
    `,
    packages: [],
    env: [
      {
        name: 'TEAMS_APP_ID',
        description: 'Microsoft App ID of the Azure Bot (single-tenant)',
        required: true,
        secret: false,
      },
      {
        name: 'TEAMS_APP_PASSWORD',
        description: 'Client secret of the app registration of the Azure Bot',
        required: true,
      },
      {
        name: 'TEAMS_TENANT_ID',
        description: 'Tenant ID of the app registration, the tenant whose users the bot answers',
        required: true,
        secret: false,
      },
    ],
  },
};

/** The webhook path of each channel that takes webhooks, as a route of another server. */
const WEBHOOK_ROUTES = { github: '/github/webhook', teams: '/api/messages' } as const;

type WebhookChannel = keyof typeof WEBHOOK_ROUTES;

/**
 * The webhook channels as routes of another server: GitHub's and Teams' on the WebChat
 * server when WebChat runs, GitHub's on the Teams server when Teams runs without WebChat. One
 * port then takes every webhook, and a deploy that exposes one port reaches them all.
 */
const HOSTED: Record<WebhookChannel, string> = {
  github: code`
    githubChannel({
      token: env.GITHUB_CHANNEL_TOKEN,
      webhook: { secret: env.GITHUB_WEBHOOK_SECRET },
    })
  `,
  teams: code`
    teamsChannel({
      appId: env.TEAMS_APP_ID,
      appPassword: env.TEAMS_APP_PASSWORD,
      tenantId: env.TEAMS_TENANT_ID,
    })
  `,
};

/** The server every webhook is served on: WebChat's, else Teams' own. */
function webhookHost(channels: readonly ChannelKind[]): 'webchat' | 'teams' | undefined {
  if (channels.includes('webchat')) return 'webchat';
  return channels.includes('teams') ? 'teams' : undefined;
}

/** The webhook channels served as routes of the host's server. */
function hostedChannels(channels: readonly ChannelKind[]): WebhookChannel[] {
  const host = webhookHost(channels);
  if (!host) return [];
  return (['github', 'teams'] as const).filter(
    (channel) => channel !== host && channels.includes(channel)
  );
}

function routesOf(hosted: readonly WebhookChannel[]): string {
  return `{ ${hosted.map((channel) => `'${WEBHOOK_ROUTES[channel]}': ${channel}.webhookListener()`).join(', ')} }`;
}

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
      for (const variable of setup.env) {
        project.envVar({
          ...variable,
          secret: variable.secret ?? true,
          ...(variable.required && { deploy: true }),
        });
      }
    }
    if (
      spec.channels.some((channel) => CHANNEL_SETUP[channel].imports?.includes('FileTokenStore'))
    ) {
      project.ignore(TOKENS_PATH);
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
    const host = webhookHost(spec.channels);
    if (spec.channels.includes('teams') && host === 'teams') {
      project.envVar({
        name: 'TEAMS_PORT',
        description: `Port of the Teams messaging endpoint, at /api/messages${spec.channels.includes('github') ? ', which takes the GitHub webhook at /github/webhook too' : ''}`,
        example: String(TEAMS_PORT),
        required: false,
        secret: false,
      });
      project.deploy.port = TEAMS_PORT;
    }
    if (spec.channels.includes('github') && !host) {
      project.envVar({
        name: 'GITHUB_WEBHOOK_PORT',
        description: 'Port GitHub delivers webhook events to, at /github/webhook',
        example: String(GITHUB_WEBHOOK_PORT),
        required: false,
        secret: false,
      });
      project.deploy.port = GITHUB_WEBHOOK_PORT;
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
    const webchat = spec.channels.includes('webchat');
    const github = spec.channels.includes('github');
    const teams = spec.channels.includes('teams');
    const host = webhookHost(spec.channels);
    const hosted = hostedChannels(spec.channels);
    const declarations = hosted.map((channel) => `const ${channel} = ${HOSTED[channel].trim()};`);
    const entries = spec.channels.map((channel) => {
      if (hosted.some((name) => name === channel)) return channel;
      if (channel === 'webchat' && hosted.length > 0) {
        return code`
          webchatChannel({
            port: Number(env.WEBCHAT_PORT ?? ${WEBCHAT_PORT}),
            routes: ${routesOf(hosted)},
          })
        `.trim();
      }
      if (channel === 'teams' && hosted.length > 0) {
        return code`
          teamsChannel({
            appId: env.TEAMS_APP_ID,
            appPassword: env.TEAMS_APP_PASSWORD,
            tenantId: env.TEAMS_TENANT_ID,
            webhook: {
              port: Number(env.TEAMS_PORT ?? ${TEAMS_PORT}),
              routes: ${routesOf(hosted)},
            },
          })
        `.trim();
      }
      return CHANNEL_SETUP[channel].expression.trim();
    });
    const hostPort =
      host === 'webchat'
        ? `\${loadEnv().WEBCHAT_PORT ?? ${WEBCHAT_PORT}}`
        : host === 'teams'
          ? `\${loadEnv().TEAMS_PORT ?? ${TEAMS_PORT}}`
          : `\${loadEnv().GITHUB_WEBHOOK_PORT ?? ${GITHUB_WEBHOOK_PORT}}`;
    const webhookLogs = [
      github && `console.log(\`GitHub webhook: http://localhost:${hostPort}/github/webhook\`);`,
      teams &&
        `console.log(\`Teams messaging endpoint: http://localhost:${hostPort}/api/messages\`);`,
    ].filter((line): line is string => typeof line === 'string');

    project.file(
      'src/gateway.ts',
      code`
        import { Gateway, ${[...new Set(channels.flatMap((c) => [c.factory, ...(c.imports ?? [])]))].join(', ')} } from '@cogitator-ai/channels';
        import { agents, cogitator } from './cogitator.js';
        import { loadEnv } from './env.js';
        ${startupImports(project)}

        const env = loadEnv();
        ${startupStatements(project)}
        ${memory && 'const memory = await cogitator.getMemory();'}
        ${declarations.join('\n')}

        /**
         * The assistant on its channels. \`src/index.ts\` starts it, and so do
         * \`cogitator assistant\` (with a live dashboard), \`cogitator build\` and
         * \`cogitator daemon\`, which look for this export.
         */
        export const gateway = new Gateway({
          cogitator,
          agent: agents.assistant,
          channels: [
            ${entries.map((entry) => `${entry},`).join('\n')}
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

    project.file(
      'src/index.ts',
      code`
        import { cogitator } from './cogitator.js';
        ${(webchat || github || teams) && "import { loadEnv } from './env.js';"}
        import { gateway } from './gateway.js';
        import { onShutdown } from './lifecycle.js';

        await gateway.start();
        console.log(\`The assistant is listening on \${gateway.stats.connectedChannels.join(', ')}\`);
        ${webchat && `console.log(\`WebChat: ws://localhost:\${loadEnv().WEBCHAT_PORT ?? ${WEBCHAT_PORT}}/ws\`);`}
        ${webhookLogs.join('\n')}

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
    if (spec.channels.includes('email')) {
      project.readmeSection(
        'Email',
        'The bot reads unread mail of `EMAIL_ADDRESS` over IMAP and answers in the same thread over SMTP, marking what it read. Give it a mailbox of its own, since it reads every unread mail there. It answers only `EMAIL_ALLOW_FROM` and skips auto-replies, bounces and mailing lists. A `From` address is easy to forge: set `EMAIL_TRUSTED_AUTHSERV_IDS` to the id your mailbox host writes in `Authentication-Results` (`mx.google.com` for Gmail), so mail whose DKIM, SPF or DMARC results fail for the sender domain is dropped, keep the list short and give the agent no tools a stranger must not use.'
      );
    }
    if (teams) {
      project.readmeSection(
        'Microsoft Teams',
        `Create a single-tenant Azure Bot in the Azure portal, add a client secret to its app registration and set \`TEAMS_APP_ID\`, \`TEAMS_APP_PASSWORD\` and \`TEAMS_TENANT_ID\`. Set its messaging endpoint to \`https://<your host>/api/messages\` (port ${host === 'webchat' ? `\`WEBCHAT_PORT\`, ${WEBCHAT_PORT}` : `\`TEAMS_PORT\`, ${TEAMS_PORT}`}, behind HTTPS), turn on the Microsoft Teams channel and install a Teams app whose manifest names the bot by its App ID. Every request is checked against the token Bot Framework signs it with. The bot answers users of its own tenant only, in personal chats and when @mentioned in group chats and channels, so give the agent no tools a colleague must not use.`
      );
    }
    if (github) {
      project.readmeSection(
        'GitHub',
        `On GitHub the bot answers mentions from the repository's owner, members and collaborators. Give it an account of its own and set \`GITHUB_CHANNEL_TOKEN\` to a fine-grained token of that account, scoped to the repositories it answers in (not your own token), and \`GITHUB_WEBHOOK_SECRET\` to the secret of a webhook that sends Issues, Issue comments, Pull requests, Pull request reviews and Pull request review comments to \`/github/webhook\` on port ${host === 'webchat' ? `\`WEBCHAT_PORT\` (${WEBCHAT_PORT})` : host === 'teams' ? `\`TEAMS_PORT\` (${TEAMS_PORT})` : `\`GITHUB_WEBHOOK_PORT\` (${GITHUB_WEBHOOK_PORT})`}.`
      );
    }
  },
};
