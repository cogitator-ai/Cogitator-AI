export { Gateway } from './gateway';
export type { GatewayFullConfig } from './gateway';

export { StreamBuffer } from './stream-buffer';

export { WebChatChannel, webchatChannel } from './channels/webchat';
export type { WebChatConfig } from './channels/webchat';

export { TelegramChannel, telegramChannel } from './channels/telegram';
export type { TelegramConfig } from './channels/telegram';

export { DiscordChannel, discordChannel } from './channels/discord';
export type { DiscordConfig } from './channels/discord';

export { SlackChannel, slackChannel } from './channels/slack';
export type { SlackConfig } from './channels/slack';

export { PairingMiddleware, pairing } from './middleware/pairing';
export type { PairingConfig } from './middleware/pairing';

export { RateLimitMiddleware, rateLimit } from './middleware/rate-limit';
export type { RateLimitConfig } from './middleware/rate-limit';

export { adaptMarkdown, chunkMessage, getPlatformLimit } from './formatters/markdown';

export type {
  Channel,
  ChannelMessage,
  ChannelUser,
  ChannelType,
  Attachment,
  SendOptions,
  StreamConfig,
  GatewayConfig,
  GatewayStats,
  GatewayMiddleware,
  MiddlewareContext,
} from '@cogitator-ai/types';
