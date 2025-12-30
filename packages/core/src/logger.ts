/**
 * Structured logging for Cogitator
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContext = Record<string, unknown>;

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  context?: LogContext;
}

export interface LoggerOptions {
  /** Minimum log level to output. Default: 'info' */
  level?: LogLevel;
  /** Output format: 'json' for production, 'pretty' for development. Default: 'pretty' */
  format?: 'json' | 'pretty';
  /** Custom output function. Default: console.log/warn/error */
  output?: (entry: LogEntry, formatted: string) => void;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

const RESET = '\x1b[0m';

function formatPretty(entry: LogEntry): string {
  const color = LEVEL_COLORS[entry.level];
  const levelPad = entry.level.toUpperCase().padEnd(5);
  const time = entry.timestamp.split('T')[1]?.split('.')[0] ?? entry.timestamp;

  let output = `${color}${levelPad}${RESET} ${time} ${entry.message}`;

  if (entry.context && Object.keys(entry.context).length > 0) {
    const contextStr = Object.entries(entry.context)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ');
    output += ` ${LEVEL_COLORS.debug}${contextStr}${RESET}`;
  }

  return output;
}

function formatJson(entry: LogEntry): string {
  return JSON.stringify(entry);
}

export class Logger {
  private level: number;
  private format: 'json' | 'pretty';
  private output?: (entry: LogEntry, formatted: string) => void;
  private context: LogContext;

  constructor(options: LoggerOptions = {}, context: LogContext = {}) {
    this.level = LOG_LEVELS[options.level ?? 'info'];
    this.format = options.format ?? 'pretty';
    this.output = options.output;
    this.context = context;
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    if (LOG_LEVELS[level] < this.level) return;

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      context: { ...this.context, ...context },
    };

    if (entry.context && Object.keys(entry.context).length === 0) {
      entry.context = undefined;
    }

    const formatted = this.format === 'json' ? formatJson(entry) : formatPretty(entry);

    if (this.output) {
      this.output(entry, formatted);
    } else if (level === 'error') {
      console.error(formatted);
    } else if (level === 'warn') {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context);
  }

  /**
   * Create a child logger with additional context
   */
  child(context: LogContext): Logger {
    const levelEntry = Object.entries(LOG_LEVELS).find(([, v]) => v === this.level);
    const level: LogLevel = levelEntry ? (levelEntry[0] as LogLevel) : 'info';
    return new Logger(
      {
        level,
        format: this.format,
        output: this.output,
      },
      { ...this.context, ...context }
    );
  }
}

let defaultLogger: Logger | null = null;

/**
 * Get or create the default logger
 */
export function getLogger(): Logger {
  defaultLogger ??= new Logger({
    level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
    format: process.env.NODE_ENV === 'production' ? 'json' : 'pretty',
  });
  return defaultLogger;
}

/**
 * Set the default logger
 */
export function setLogger(logger: Logger): void {
  defaultLogger = logger;
}

/**
 * Create a new logger instance
 */
export function createLogger(options?: LoggerOptions): Logger {
  return new Logger(options);
}
