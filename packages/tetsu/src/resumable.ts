import { hook } from '@tetsujs/core';
import type { Requires } from '@tetsujs/core';
import { sse } from '@tetsujs/sse';
import type { ServerSentEvent, SseOptions } from '@tetsujs/sse';
import { lastEventIdOf, parseStreamEventId } from '@cogitator-ai/server-shared';
import type { ResumableStreams, StreamFollower } from '@cogitator-ai/server-shared';
import type { CallerFields } from './auth.js';
import { refusalError } from './errors.js';
import { findAgent } from './operations.js';
import { DONE_EVENT } from './streaming.js';
import type { CogitatorDeps } from './types.js';

/** The frames of a resumable stream as server-sent events with their ids, `[DONE]` after `finish` */
export async function* resumableEvents(
  stream: StreamFollower,
  signal: AbortSignal
): AsyncGenerator<ServerSentEvent, void, undefined> {
  for await (const frame of stream.frames(signal)) {
    yield frame.id === undefined ? { data: frame.event } : { data: frame.event, id: frame.id };
    if (frame.event.type === 'finish') yield DONE_EVENT;
  }
}

/**
 * The `beforeParse` hook of the agent stream routes, after the caller hook: answers a request
 * that names the last event it got (`Last-Event-ID`, or `?lastEventId=`) with the rest of its
 * stream, before the body is read, since a reconnect needs none. A stream the server does not
 * keep for the caller answers `404 STREAM_NOT_FOUND`. An id that is not `<streamId>:<seq>` goes
 * on to validation, which refuses it. Without resumable streams it does nothing.
 */
export function reconnectHook(
  deps: CogitatorDeps,
  streams: ResumableStreams | undefined,
  options: () => SseOptions
) {
  return hook.beforeParse(
    async (ctx: Requires<CallerFields> & { readonly params: Readonly<Record<string, string>> }) => {
      if (!streams) return undefined;
      const lastEventId = lastEventIdOf(
        ctx.req.headers.get('last-event-id'),
        new URL(ctx.req.url).searchParams.getAll('lastEventId')
      );
      if (lastEventId === undefined || !parseStreamEventId(lastEventId)) return undefined;
      findAgent(deps, ctx.params.name ?? '');
      const attached = await streams.reconnect(lastEventId, ctx.cogitatorAuth?.userId);
      if (!attached.ok) throw refusalError(attached.error);
      return sse(ctx, (signal) => resumableEvents(attached.stream, signal), options());
    }
  );
}
