import { createInterface, type Interface } from 'node:readline';
import { userInfo } from 'node:os';
import type {
  Channel,
  ChannelMessage,
  ChannelType,
  Attachment,
  SendOptions,
} from '@cogitator-ai/types';

export interface TerminalConfig {
  userName?: string;
  userId?: string;
  prompt?: string;
}

export class TerminalChannel implements Channel {
  readonly type: ChannelType = 'terminal';
  private handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private rl: Interface | null = null;
  private msgCounter = 0;
  private lastLineCount = 0;
  private responding = false;
  private readonly userName: string;
  private readonly userId: string;
  private readonly promptStr: string;

  constructor(config: TerminalConfig = {}) {
    this.userName = config.userName || userInfo().username;
    this.userId = config.userId || 'owner';
    this.promptStr = config.prompt || '> ';
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!process.stdin.isTTY && !process.env.COGITATOR_FORCE_TERMINAL) return;

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    this.rl.on('close', () => {
      process.exit(0);
    });

    this.showPrompt();
  }

  async stop(): Promise<void> {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  async sendText(_channelId: string, text: string, _options?: SendOptions): Promise<string> {
    const id = `term_${++this.msgCounter}`;
    this.writeOutput(text);
    this.responding = false;
    this.showPrompt();
    return id;
  }

  async editText(_channelId: string, _messageId: string, text: string): Promise<void> {
    if (this.lastLineCount > 0) {
      process.stdout.write(`\x1b[${this.lastLineCount}A\x1b[J`);
    }
    this.writeOutput(text);
  }

  async sendFile(_channelId: string, file: Attachment): Promise<void> {
    const label = file.filename || file.mimeType;
    const url = file.url ? ` ${file.url}` : '';
    process.stdout.write(`  [${label}]${url}\n`);
  }

  async sendTyping(): Promise<void> {}

  private writeOutput(text: string): void {
    const lines = text.split('\n');
    this.lastLineCount = lines.length;
    process.stdout.write(lines.join('\n') + '\n');
  }

  private showPrompt(): void {
    if (!this.rl || this.responding) return;
    this.rl.question(this.promptStr, (input) => {
      void this.handleInput(input);
    });
  }

  private async handleInput(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) {
      this.showPrompt();
      return;
    }

    if (text === '/quit' || text === '/exit' || text === 'exit') {
      await this.stop();
      return;
    }

    if (!this.handler) {
      this.showPrompt();
      return;
    }

    this.responding = true;
    this.lastLineCount = 0;

    const msg: ChannelMessage = {
      id: `in_${++this.msgCounter}`,
      channelType: 'terminal',
      channelId: 'terminal',
      userId: this.userId,
      userName: this.userName,
      text,
      raw: { text },
    };

    try {
      await this.handler(msg);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`Error: ${errMsg}\n`);
      this.responding = false;
      this.showPrompt();
    }
  }
}

export function terminalChannel(config?: TerminalConfig): Channel {
  return new TerminalChannel(config);
}
