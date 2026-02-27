import type {
  Channel,
  ChannelMessage,
  ChannelType,
  Attachment,
  SendOptions,
} from '@cogitator-ai/types';

export interface SlackConfig {
  token: string;
  signingSecret: string;
  appToken?: string;
  port?: number;
}

interface SlackApp {
  message(handler: (event: SlackMessageEvent) => Promise<void>): void;
  start(port: number): Promise<void>;
  stop(): Promise<void>;
  client: {
    chat: {
      postMessage(options: Record<string, unknown>): Promise<{ ts?: string }>;
      update(options: Record<string, unknown>): Promise<void>;
    };
    files: {
      uploadV2(options: Record<string, unknown>): Promise<void>;
    };
  };
}

interface SlackMessageEvent {
  message: {
    ts: string;
    channel: string;
    user?: string;
    text?: string;
    subtype?: string;
  };
}

export class SlackChannel implements Channel {
  readonly type: ChannelType = 'slack';
  private handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private app: SlackApp | null = null;

  constructor(private readonly config: SlackConfig) {}

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    let bolt: { App: new (config: Record<string, unknown>) => unknown };
    try {
      bolt = (await import('@slack/bolt')) as typeof bolt;
    } catch {
      throw new Error(
        '@slack/bolt is required for Slack support. Install it: pnpm add @slack/bolt'
      );
    }

    const appConfig: Record<string, unknown> = {
      token: this.config.token,
      signingSecret: this.config.signingSecret,
    };

    if (this.config.appToken) {
      appConfig.socketMode = true;
      appConfig.appToken = this.config.appToken;
    }

    const app = new bolt.App(appConfig) as SlackApp;
    this.app = app;

    app.message(async ({ message }: SlackMessageEvent) => {
      if (!this.handler) return;
      if (!message.text || message.subtype || !message.user) return;

      const channelMessage: ChannelMessage = {
        id: message.ts,
        channelType: 'slack',
        channelId: message.channel,
        userId: message.user,
        text: message.text,
        raw: message,
      };

      await this.handler(channelMessage);
    });

    await app.start(this.config.port ?? 3000);
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
  }

  async sendText(channelId: string, text: string, options?: SendOptions): Promise<string> {
    if (!this.app) return '';

    const result = await this.app.client.chat.postMessage({
      channel: channelId,
      text,
      ...(options?.replyTo ? { thread_ts: options.replyTo } : {}),
    });

    return result.ts ?? '';
  }

  async editText(channelId: string, messageId: string, text: string): Promise<void> {
    if (!this.app) return;

    try {
      await this.app.client.chat.update({
        channel: channelId,
        ts: messageId,
        text,
      });
    } catch {}
  }

  async sendFile(channelId: string, file: Attachment): Promise<void> {
    if (!this.app) return;

    await this.app.client.files.uploadV2({
      channel_id: channelId,
      filename: file.filename ?? 'file',
      file: file.buffer ?? file.url,
    });
  }

  async sendTyping(_channelId: string): Promise<void> {}
}

export function slackChannel(config: SlackConfig): Channel {
  return new SlackChannel(config);
}
