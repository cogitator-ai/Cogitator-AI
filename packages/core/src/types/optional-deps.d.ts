declare module 'nodemailer' {
  interface TransportOptions {
    host?: string;
    port?: number;
    secure?: boolean;
    auth?: {
      user: string;
      pass: string;
    };
  }

  interface MailOptions {
    from?: string;
    to?: string;
    subject?: string;
    text?: string;
    html?: string;
    replyTo?: string;
    cc?: string;
    bcc?: string;
  }

  interface SentMessageInfo {
    messageId: string;
  }

  interface Transporter {
    sendMail(options: MailOptions): Promise<SentMessageInfo>;
  }

  export function createTransport(options: TransportOptions): Transporter;
}

declare module 'better-sqlite3' {
  interface Statement {
    readonly reader: boolean;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
  }

  interface Database {
    prepare(sql: string): Statement;
    close(): void;
    exec(sql: string): void;
  }

  interface DatabaseConstructor {
    new (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}

declare module 'langfuse' {
  interface TraceOptions {
    id?: string;
    name: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
    userId?: string;
    sessionId?: string;
    tags?: string[];
  }

  interface SpanOptions {
    name: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }

  interface GenerationOptions {
    name: string;
    model: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
    modelParameters?: Record<string, unknown>;
  }

  interface LangfuseGeneration {
    id: string;
    end(options?: {
      output?: unknown;
      usage?: { input?: number; output?: number; total?: number };
    }): void;
  }

  interface LangfuseSpan {
    id: string;
    span(options: SpanOptions): LangfuseSpan;
    generation(options: GenerationOptions): LangfuseGeneration;
    end(options?: { output?: unknown }): void;
  }

  interface LangfuseTrace {
    id: string;
    span(options: SpanOptions): LangfuseSpan;
    generation(options: GenerationOptions): LangfuseGeneration;
    update(options: { output?: unknown; metadata?: Record<string, unknown> }): void;
  }

  export class Langfuse {
    constructor(options: {
      publicKey: string;
      secretKey: string;
      baseUrl?: string;
      flushAt?: number;
      flushInterval?: number;
    });
    trace(options: TraceOptions): LangfuseTrace;
    flush(): Promise<void>;
    shutdown(): Promise<void>;
  }
}
