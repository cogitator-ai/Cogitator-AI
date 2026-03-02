import type { GatewayMiddleware, ChannelMessage, MiddlewareContext } from '@cogitator-ai/types';

export type CommandLevel = 'owner' | 'authorized' | 'public';

export interface OwnerCommandsConfig {
  ownerIds: Record<string, string>;
  authorizedUserIds?: string[];
  publicCommands?: string[];
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

interface CommandDef {
  level: CommandLevel;
  handler: CommandHandler;
}

const COMMANDS: Record<string, CommandDef> = {
  '/status': {
    level: 'authorized',
    handler: async (_args, _msg, _ctx, config) => {
      return config.onStatus?.() ?? 'No status handler configured';
    },
  },

  '/sessions': {
    level: 'authorized',
    handler: async (_args, _msg, _ctx, config) => {
      return config.onSessions?.() ?? 'No sessions handler configured';
    },
  },

  '/users': {
    level: 'owner',
    handler: async (_args, _msg, _ctx, config) => {
      return config.onUsers?.() ?? 'No users handler configured';
    },
  },

  '/compact': {
    level: 'owner',
    handler: async (args, _msg, _ctx, config) => {
      if (config.onCompact) {
        return config.onCompact(args.trim() || 'current');
      }
      return 'No compact handler configured';
    },
  },

  '/model': {
    level: 'owner',
    handler: async (args, _msg, _ctx, config) => {
      const parts = args.trim().split(/\s+/);
      const model = parts[0];
      const forUser = parts[1];
      if (!model) return 'Usage: /model <name> [@user]';
      return config.onModel?.(model, forUser) ?? `Model set to: ${model}`;
    },
  },

  '/restart': {
    level: 'owner',
    handler: async (_args, _msg, _ctx, config) => {
      if (config.onRestart) {
        await config.onRestart();
        return 'Restarting...';
      }
      return 'No restart handler configured';
    },
  },

  '/help': {
    level: 'authorized',
    handler: async () => {
      return [
        'Commands:',
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
  },
};

const LEVEL_HIERARCHY: Record<CommandLevel, number> = {
  public: 0,
  authorized: 1,
  owner: 2,
};

export class OwnerCommandsMiddleware implements GatewayMiddleware {
  readonly name = 'owner-commands';
  private readonly ownerKeys: Set<string>;
  private readonly authorizedKeys: Set<string>;
  private readonly publicCommands: Set<string>;

  constructor(private readonly config: OwnerCommandsConfig) {
    this.ownerKeys = new Set(Object.entries(config.ownerIds).map(([type, id]) => `${type}:${id}`));

    this.authorizedKeys = new Set<string>();
    if (config.authorizedUserIds) {
      for (const id of config.authorizedUserIds) {
        this.authorizedKeys.add(id);
      }
    }

    this.publicCommands = new Set<string>();
    if (config.publicCommands) {
      for (const cmd of config.publicCommands) {
        this.publicCommands.add(cmd.startsWith('/') ? cmd : `/${cmd}`);
      }
    }
  }

  async handle(
    msg: ChannelMessage,
    ctx: MiddlewareContext,
    next: () => Promise<void>
  ): Promise<void> {
    if (!msg.text.startsWith('/')) {
      await next();
      return;
    }

    const spaceIndex = msg.text.indexOf(' ');
    const command = spaceIndex === -1 ? msg.text : msg.text.slice(0, spaceIndex);
    const args = spaceIndex === -1 ? '' : msg.text.slice(spaceIndex + 1);

    const def = COMMANDS[command];
    if (!def) {
      await next();
      return;
    }

    const userLevel = this.getUserLevel(msg);
    const requiredLevel = this.publicCommands.has(command) ? 'public' : def.level;

    if (LEVEL_HIERARCHY[userLevel] < LEVEL_HIERARCHY[requiredLevel]) {
      await next();
      return;
    }

    const response = await def.handler(args, msg, ctx, this.config);
    if (response) {
      await ctx.channel.sendText(msg.channelId, response);
    }
  }

  private getUserLevel(msg: ChannelMessage): CommandLevel {
    const userKey = `${msg.channelType}:${msg.userId}`;
    if (this.ownerKeys.has(userKey)) return 'owner';
    if (this.authorizedKeys.has(userKey) || this.authorizedKeys.has(msg.userId)) {
      return 'authorized';
    }
    return 'public';
  }
}

export function ownerCommands(config: OwnerCommandsConfig): GatewayMiddleware {
  return new OwnerCommandsMiddleware(config);
}
