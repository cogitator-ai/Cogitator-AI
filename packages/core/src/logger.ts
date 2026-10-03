import type { LoggingConfig } from '@cogitator-ai/types';
import { builtinModule, readEnv } from './utils/env';

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
  /** Minimum log level to output; `'silent'` outputs nothing. Default: 'info' */
  level?: LogLevel | 'silent';
  /** Output format: 'json' for production, 'pretty' for development. Default: 'pretty' */
  format?: 'json' | 'pretty';
  /** Custom output function. Default: console.log/warn/error */
  output?: (entry: LogEntry, formatted: string) => void;
}

const LOG_LEVELS: Record<LogLevel | 'silent', number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: Number.POSITIVE_INFINITY,
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
  private levelName: LogLevel | 'silent';
  private level: number;
  private format: 'json' | 'pretty';
  private output?: (entry: LogEntry, formatted: string) => void;
  private context: LogContext;

  constructor(options: LoggerOptions = {}, context: LogContext = {}) {
    this.levelName =
      options.level && Object.hasOwn(LOG_LEVELS, options.level) ? options.level : 'info';
    this.level = LOG_LEVELS[this.levelName];
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
    return new Logger(
      {
        level: this.levelName,
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
const VALID_LOG_LEVELS = new Set<string>(['debug', 'info', 'warn', 'error']);

export function getLogger(): Logger {
  const envLevel = readEnv('LOG_LEVEL');
  const level: LogLevel =
    envLevel && VALID_LOG_LEVELS.has(envLevel) ? (envLevel as LogLevel) : 'info';
  defaultLogger ??= new Logger({
    level,
    format: readEnv('NODE_ENV') === 'production' ? 'json' : 'pretty',
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

interface AppendFileModule {
  appendFileSync(path: string, data: string): void;
}

/**
 * A logger built from the `logging` section of the Cogitator config:
 * `level`, `format`, and `destination` — `'file'` appends one line per entry
 * to `filePath` (JSON unless `format` says otherwise). Where the runtime has no file system, or `filePath` is
 * missing, it logs to the console and says why.
 */
export function createLoggerFromConfig(config: LoggingConfig): Logger {
  const options: LoggerOptions = {
    ...(config.level && { level: config.level }),
    ...(config.format && { format: config.format }),
  };
  if (config.destination !== 'file') return new Logger(options);

  const fs = builtinModule<AppendFileModule>('node:fs');
  if (!config.filePath || !fs) {
    const logger = new Logger(options);
    logger.warn(
      config.filePath
        ? 'logging.destination is "file", but this runtime has no file system; logging to the console'
        : 'logging.destination is "file", but logging.filePath is not set; logging to the console'
    );
    return logger;
  }

  const filePath = config.filePath;
  return new Logger({
    ...options,
    format: config.format ?? 'json',
    output: (_entry, formatted) => fs.appendFileSync(filePath, `${formatted}\n`),
  });
}
