export { Gateway } from './gateway';
export type { GatewayFullConfig } from './gateway';

export { StreamBuffer } from './stream-buffer';

export { HeartbeatScheduler } from './heartbeat';
export type { HeartbeatConfig } from './heartbeat';

export { StatusReactionTracker } from './status-reactions';
export { InboundDebouncer } from './inbound-debounce';
export { MessageQueue } from './message-queue';
export { formatEnvelope, formatElapsed } from './envelope';

export { TerminalChannel, terminalChannel } from './channels/terminal';
export type { TerminalConfig } from './channels/terminal';

export { WebChatChannel, webchatChannel } from './channels/webchat';
export type { WebChatConfig } from './channels/webchat';

export { TelegramChannel, telegramChannel } from './channels/telegram';
export type { TelegramConfig } from './channels/telegram';

export { DiscordChannel, discordChannel } from './channels/discord';
export type { DiscordConfig } from './channels/discord';

export { SlackChannel, slackChannel } from './channels/slack';
export type { SlackConfig } from './channels/slack';

export { WhatsAppChannel, whatsappChannel } from './channels/whatsapp';
export type { WhatsAppChannelConfig } from './channels/whatsapp';

export { PairingMiddleware, pairing } from './middleware/pairing';
export type { PairingConfig } from './middleware/pairing';

export { DmPolicyMiddleware, dmPolicy } from './middleware/dm-policy';
export type { DmPolicyConfig, DmPolicyMode } from './middleware/dm-policy';

export { RateLimitMiddleware, rateLimit } from './middleware/rate-limit';
export type { RateLimitConfig } from './middleware/rate-limit';

export { OwnerCommandsMiddleware, ownerCommands } from './middleware/owner-commands';
export type { OwnerCommandsConfig, CommandLevel } from './middleware/owner-commands';

export { createHookRegistry } from './hooks';
export type { HookName, HookHandler, HookRegistry } from './hooks';

export { AutoExtractMiddleware, autoExtract } from './middleware/auto-extract';
export type {
  AutoExtractConfig,
  EntityExtractor,
  ExtractedEntities,
} from './middleware/auto-extract';

export { generateCapabilitiesDoc } from './capabilities';
export type { CapabilitiesInput } from './capabilities';

export { RuntimeBuilder } from './runtime-builder';
export type { AssistantConfig, BuiltRuntime, RuntimeBuilderOpts } from './runtime-builder';

export { SimpleTimerStore } from './simple-timer-store';

export { MediaProcessor } from './media/media-processor';
export type { MediaProcessResult, SttProvider } from './media/media-processor';
export { LocalWhisper } from './media/whisper-local';
export { createWhisperDownloadTool } from './media/whisper-tool';
export { GroqSttProvider, OpenAISttProvider } from './media/whisper-api';
export type { GroqSttConfig, OpenAISttConfig } from './media/whisper-api';
export { DeepgramSttProvider } from './media/deepgram-stt';
export type { DeepgramSttConfig } from './media/deepgram-stt';

export { createSelfConfigTools } from './tools/self-config';

export {
  AssistantConfigSchema,
  type AssistantConfigInput,
  type AssistantConfigOutput,
} from './assistant-config';

export { adaptMarkdown, chunkMessage, getPlatformLimit } from './formatters/markdown';
export { chunkDiscordText } from './formatters/discord-chunker';
export type { ChunkDiscordTextOpts } from './formatters/discord-chunker';
export { markdownToWhatsApp } from './formatters/whatsapp-markdown';

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
  StatusPhase,
  StatusReactionConfig,
  DebounceConfig,
  EnvelopeConfig,
  QueueMode,
} from '@cogitator-ai/types';
