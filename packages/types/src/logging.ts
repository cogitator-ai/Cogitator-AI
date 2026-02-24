export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFormat = 'json' | 'pretty';
export type LogDestination = 'console' | 'file';

export interface LoggingConfig {
  level?: LogLevel;
  format?: LogFormat;
  destination?: LogDestination;
  filePath?: string;
}
