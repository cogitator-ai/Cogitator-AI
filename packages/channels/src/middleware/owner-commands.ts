import type { GatewayMiddleware, ChannelMessage, MiddlewareContext } from '@cogitator-ai/types';

export interface OwnerCommandsConfig {
  ownerIds: Record<string, string>;
  onStatus?: () => string;
  onSessions?: () => string;
  onUsers?: () => string;
  onCompact?: (target: string) => Promise<string>;
  onModel?: (model: string, forUser?: string) => string;
  onRestart?: () => Promise<void>;
}

type CommandHandler = (
  args: string,
  msg: ChannelMessage,
  ctx: MiddlewareContext,
  config: OwnerCommandsConfig
) => Promise<string | void>;

const COMMANDS: Record<string, CommandHandler> = {
  '/status': async (_args, _msg, _ctx, config) => {
    return config.onStatus?.() ?? 'No status handler configured';
  },

  '/sessions': async (_args, _msg, _ctx, config) => {
    return config.onSessions?.() ?? 'No sessions handler configured';
  },

  '/users': async (_args, _msg, _ctx, config) => {
    return config.onUsers?.() ?? 'No users handler configured';
  },

  '/compact': async (args, _msg, _ctx, config) => {
    if (config.onCompact) {
      return config.onCompact(args.trim() || 'current');
    }
    return 'No compact handler configured';
  },

  '/model': async (args, _msg, _ctx, config) => {
    const parts = args.trim().split(/\s+/);
    const model = parts[0];
    const forUser = parts[1];
    if (!model) return 'Usage: /model <name> [@user]';
    return config.onModel?.(model, forUser) ?? `Model set to: ${model}`;
  },

  '/restart': async (_args, _msg, _ctx, config) => {
    if (config.onRestart) {
      await config.onRestart();
      return 'Restarting...';
    }
    return 'No restart handler configured';
  },

  '/help': async () => {
    return [
      'Owner commands:',
      '  /status     — uptime, sessions, cost',
      '  /sessions   — list active sessions',
      '  /users      — list approved/blocked users',
      '  /compact    — compact conversation history',
      '  /model <n>  — switch model',
      '  /restart    — restart assistant',
      '  /pair <code> — approve new user',
      '  /help       — show this message',
    ].join('\n');
  },
};

export class OwnerCommandsMiddleware implements GatewayMiddleware {
  readonly name = 'owner-commands';
  private readonly ownerKeys: Set<string>;

  constructor(private readonly config: OwnerCommandsConfig) {
    this.ownerKeys = new Set(Object.entries(config.ownerIds).map(([type, id]) => `${type}:${id}`));
  }

  async handle(
    msg: ChannelMessage,
    ctx: MiddlewareContext,
    next: () => Promise<void>
  ): Promise<void> {
    const userKey = `${msg.channelType}:${msg.userId}`;

    if (!this.ownerKeys.has(userKey) || !msg.text.startsWith('/')) {
      await next();
      return;
    }

    const spaceIndex = msg.text.indexOf(' ');
    const command = spaceIndex === -1 ? msg.text : msg.text.slice(0, spaceIndex);
    const args = spaceIndex === -1 ? '' : msg.text.slice(spaceIndex + 1);

    const handler = COMMANDS[command];
    if (!handler) {
      await next();
      return;
    }

    const response = await handler(args, msg, ctx, this.config);
    if (response) {
      await ctx.channel.sendText(msg.channelId, response);
    }
  }
}

export function ownerCommands(config: OwnerCommandsConfig): GatewayMiddleware {
  return new OwnerCommandsMiddleware(config);
}
