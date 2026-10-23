import { posix } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { WorkspaceError } from '@cogitator-ai/types';

/** What a wrapper reports about a command with a marker line, see {@link MarkerScanner}. */
export type MarkerKind = 'pgid' | 'exit' | 'cwd';

/**
 * Takes the wrapper's markers (`__cogitator_<token>_pgid:<n>`, `..._exit:<n>` and `..._cwd:<n>`,
 * each on a line of its own) out of a command's stderr wherever they appear, so a shell warning
 * printed before them changes nothing, and hands the rest on. Text that may be the start of a
 * marker is held until it is known.
 */
export class MarkerScanner {
  private readonly decoder = new StringDecoder('utf8');
  private held = '';
  private readonly start: string;
  private readonly pattern: RegExp;

  constructor(
    token: string,
    private readonly emit: (text: string) => void,
    private readonly onMarker: (kind: MarkerKind, value: number) => void
  ) {
    this.start = `__cogitator_${token}_`;
    this.pattern = new RegExp(`__cogitator_${token}_(pgid|exit|cwd):(\\d+)\\n`);
  }

  push(chunk: Buffer): void {
    this.held += this.decoder.write(chunk);
    for (;;) {
      const match = this.pattern.exec(this.held);
      if (!match) break;
      if (match.index > 0) this.emit(this.held.slice(0, match.index));
      this.held = this.held.slice(match.index + match[0].length);
      this.onMarker(match[1] as MarkerKind, Number(match[2]));
    }
    const keep = this.heldFrom();
    if (keep > 0) {
      this.emit(this.held.slice(0, keep));
      this.held = this.held.slice(keep);
    }
  }

  end(): void {
    this.held += this.decoder.end();
    if (this.held) this.emit(this.held);
    this.held = '';
  }

  /** Where the text that may still become a marker begins. */
  private heldFrom(): number {
    const full = this.held.indexOf(this.start);
    if (full !== -1) return full;
    for (let length = Math.min(this.start.length - 1, this.held.length); length > 0; length--) {
      if (this.start.startsWith(this.held.slice(-length))) return this.held.length - length;
    }
    return this.held.length;
  }
}

/** Text of a stream up to a byte limit, every piece reported as it arrives. */
export class StreamText {
  private readonly decoder = new StringDecoder('utf8');
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(
    private readonly limit: number,
    private readonly listener?: (chunk: string) => void
  ) {}

  /** Text already decoded, such as stderr with the wrapper's markers taken out. */
  pushText(text: string): void {
    this.listener?.(text);
    this.keep(Buffer.from(text, 'utf8'));
  }

  push(chunk: Buffer): void {
    if (this.listener) {
      const text = this.decoder.write(chunk);
      if (text) this.listener(text);
    }
    this.keep(chunk);
  }

  private keep(chunk: Buffer): void {
    const room = this.limit - this.size;
    if (chunk.length > room) this.truncated = true;
    if (room <= 0) return;
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(kept);
    this.size += kept.length;
  }

  text(): string {
    if (this.listener) {
      const rest = this.decoder.end();
      if (rest) this.listener(rest);
    }
    return new StringDecoder('utf8').end(Buffer.concat(this.chunks));
  }
}

/** `cwd` as a path relative to the root with `/` separators, `.` for the root. */
export function normalizeCwd(cwd: string): string {
  if (cwd === '' || cwd === '.') return '.';
  if (cwd.startsWith('/')) {
    throw new WorkspaceError('INVALID_PATH', 'cwd must be relative to the root', { path: cwd });
  }
  const normalized = trimTrailingSlashes(posix.normalize(cwd));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new WorkspaceError('OUTSIDE_ROOT', `${cwd} is outside the workspace`, { path: cwd });
  }
  return normalized === '' || normalized === '.' ? '.' : normalized;
}

/** `value` without its trailing slashes, in linear time. */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

/** The error a command rejects with when its signal aborted it. */
export function aborted(signal: AbortSignal): WorkspaceError {
  const reason: unknown = signal.reason;
  const detail =
    reason instanceof Error ? reason.message : reason === undefined ? '' : String(reason);
  return new WorkspaceError('ABORTED', detail ? `Command aborted: ${detail}` : 'Command aborted', {
    cause: reason,
  });
}

/** `error` as a `WorkspaceError` of code `IO`, unless it already is a `WorkspaceError`. */
export function ioError(what: string, error: unknown): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  return new WorkspaceError('IO', `${what}: ${message(error)}`, { cause: error });
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
