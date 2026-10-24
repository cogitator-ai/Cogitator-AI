import type { ToolInputStreamPart } from '@cogitator-ai/types';

interface StreamedCall {
  id?: string;
  name?: string;
  started: boolean;
  pending: string;
}

/** A piece of a tool call as a provider streams it: any of its id, name and argument text */
export interface ToolCallPiece {
  id?: string;
  name?: string;
  arguments?: string;
}

/**
 * Turns the pieces of tool calls a provider streams, each keyed by the provider's own index of
 * the call, into the `toolInput` parts of stream chunks. A call starts once its id and name are
 * known, and argument text that came before that goes out right after its start.
 */
export class ToolInputStream<K = number> {
  private readonly calls = new Map<K, StreamedCall>();

  /** The parts the piece of the call at `key` adds */
  piece(key: K, piece: ToolCallPiece): ToolInputStreamPart[] {
    let call = this.calls.get(key);
    if (!call) {
      call = { started: false, pending: '' };
      this.calls.set(key, call);
    }
    if (piece.id) call.id ??= piece.id;
    if (piece.name) call.name ??= piece.name;
    const parts: ToolInputStreamPart[] = [];
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
}
