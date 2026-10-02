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
  /**
   * Called when the user asks to leave (Ctrl+C, Ctrl+D, `/quit`).
   * Defaults to raising SIGINT so the host application can shut down gracefully.
   */
  onExit?: () => void;
}

const EXIT_COMMANDS = new Set(['/quit', '/exit', 'exit']);

export class TerminalChannel implements Channel {
  readonly type: ChannelType = 'terminal';
  private handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private rl: Interface | null = null;
  private msgCounter = 0;
  private lastLineCount = 0;
  private responding = false;
  private questionPending = false;
  private closing = false;
  private readonly userName: string;
  private readonly userId: string;
  private readonly promptStr: string;
  private readonly onExit?: () => void;

  constructor(config: TerminalConfig = {}) {
    this.userName = config.userName || userInfo().username;
    this.userId = config.userId || 'owner';
    this.promptStr = config.prompt || '> ';
    this.onExit = config.onExit;
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.rl) return;
    if (!process.stdin.isTTY && !process.env.COGITATOR_FORCE_TERMINAL) return;

    this.closing = false;
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    this.rl = rl;

    rl.on('SIGINT', () => this.requestExit());
    rl.on('close', () => {
      this.rl = null;
      this.questionPending = false;
      if (!this.closing) this.requestExit();
    });

    this.showPrompt();
  }

  async stop(): Promise<void> {
    if (this.rl) {
      this.closing = true;
      const rl = this.rl;
      this.rl = null;
      this.questionPending = false;
      rl.close();
    }
  }

  async sendText(_channelId: string, text: string, _options?: SendOptions): Promise<string> {
    const id = `term_${++this.msgCounter}`;
    const unsolicited = !this.responding && this.questionPending;
    if (unsolicited) process.stdout.write('\r\x1b[K');
    this.writeOutput(text);
    if (unsolicited) this.rl?.prompt(true);
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

  private requestExit(): void {
    if (this.onExit) {
      this.onExit();
      return;
    }
    process.kill(process.pid, 'SIGINT');
  }

  private countRenderedLines(lines: string[]): number {
    const columns = process.stdout.columns;
    if (!columns || columns <= 0) return lines.length;
    return lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / columns)), 0);
  }

  private writeOutput(text: string): void {
    const lines = text.split('\n');
    this.lastLineCount = this.countRenderedLines(lines);
    process.stdout.write(lines.join('\n') + '\n');
  }

  private showPrompt(): void {
    if (!this.rl || this.responding || this.questionPending) return;
    this.questionPending = true;
    this.rl.question(this.promptStr, (input) => {
      this.questionPending = false;
      void this.handleInput(input);
    });
  }

  private async handleInput(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) {
      this.showPrompt();
      return;
    }

    if (EXIT_COMMANDS.has(text)) {
      this.requestExit();
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
    } finally {
      this.responding = false;
      this.showPrompt();
    }
  }
}

export function terminalChannel(config?: TerminalConfig): Channel {
  return new TerminalChannel(config);
}
