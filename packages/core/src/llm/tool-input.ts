import type { ToolInputStreamPart } from '@cogitator-ai/types';

interface StreamedCall {
  id?: string;
  name?: string;
  arguments: string;
  started: boolean;
  ended: boolean;
  /** Argument text that came before the call's id and name */
  pending: string;
}

/** A piece of a tool call as a provider streams it: any of its id, name and argument text */
export interface ToolCallPiece {
  id?: string;
  name?: string;
  arguments?: string;
}

/** A tool call a provider streamed, as {@link ToolInputStream} assembled it */
export interface StreamedToolCall<K> {
  key: K;
  id: string;
  name: string;
  /** The JSON text of its arguments, as it arrived */
  arguments: string;
}

/**
 * The tool calls a provider streams, each keyed by the provider's own index of the call, and the
 * `toolInput` parts of stream chunks they make. A call keeps the first id and name it got, so an
 * empty or changed id in a later piece neither restarts nor renames it. It starts once its id and
 * name are known, argument text that came before goes out right after its start, and it ends
 * once with {@link end}.
 */
export class ToolInputStream<K = number> {
  private readonly calls = new Map<K, StreamedCall>();

  /** The parts the piece of the call at `key` adds */
  piece(key: K, piece: ToolCallPiece): ToolInputStreamPart[] {
    let call = this.calls.get(key);
    if (!call) {
      call = { arguments: '', started: false, ended: false, pending: '' };
      this.calls.set(key, call);
    }
    if (piece.id && !call.id) call.id = piece.id;
    if (piece.name && !call.name) call.name = piece.name;
    if (piece.arguments) call.arguments += piece.arguments;
    const parts: ToolInputStreamPart[] = [];
    if (call.ended) return parts;
    if (!call.started && call.id && call.name) {
      call.started = true;
      parts.push({ type: 'start', toolCallId: call.id, toolName: call.name });
      if (call.pending) {
        parts.push({ type: 'delta', toolCallId: call.id, delta: call.pending });
        call.pending = '';
      }
    }
    if (piece.arguments) {
      if (call.started && call.id) {
        parts.push({ type: 'delta', toolCallId: call.id, delta: piece.arguments });
      } else {
        call.pending += piece.arguments;
      }
    }
    return parts;
  }

  /** The part that says the model finished writing the call at `key`, once */
  end(key: K): ToolInputStreamPart[] {
    const call = this.calls.get(key);
    if (!call?.started || call.ended || !call.id) return [];
    call.ended = true;
    return [{ type: 'end', toolCallId: call.id }];
  }

  /** The end parts of every call but `except` that has not ended yet */
  endOthers(except: K): ToolInputStreamPart[] {
    return [...this.calls.keys()].filter((key) => key !== except).flatMap((key) => this.end(key));
  }

  /** The end parts of every call that has not ended yet */
  endAll(): ToolInputStreamPart[] {
    return [...this.calls.keys()].flatMap((key) => this.end(key));
  }

  /** The calls streamed so far, in the order their keys first came */
  entries(): StreamedToolCall<K>[] {
    return [...this.calls.entries()].map(([key, call]) => ({
      key,
      id: call.id ?? '',
      name: call.name ?? '',
      arguments: call.arguments,
    }));
  }
}
