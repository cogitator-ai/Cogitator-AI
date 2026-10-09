import type { Attachment } from '@cogitator-ai/types';
import { FeedError, retryAfterOf } from './errors';

/**
 * The bytes of an attachment: its buffer, or its URL downloaded. Fails with
 * `invalid_post` when it is over `maxBytes`, without reading past the limit,
 * or when the URL does not serve it, and with `unavailable` (or
 * `rate_limited`) when its host fails for now, so the post is tried again.
 */
export async function attachmentBytes(
  feed: string,
  attachment: Attachment,
  options: { maxBytes: number; fetch?: typeof fetch; what: string }
): Promise<Uint8Array> {
  const tooLarge = (size: number) =>
    new FeedError(
      feed,
      'invalid_post',
      `${options.what} is ${size} bytes, the feed takes up to ${options.maxBytes}`
    );
  if (attachment.buffer) {
    if (attachment.buffer.byteLength > options.maxBytes)
      throw tooLarge(attachment.buffer.byteLength);
    return attachment.buffer;
  }
  if (!attachment.url) {
    throw new FeedError(feed, 'invalid_post', `${options.what} has neither a buffer nor a url`);
  }
  const unreachable = (error: unknown) =>
    new FeedError(
      feed,
      'unavailable',
      `Could not download ${options.what} from ${attachment.url}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(attachment.url);
  } catch (error) {
    throw unreachable(error);
  }
  if (!response.ok) {
    const { status } = response;
    const code =
      status === 429
        ? 'rate_limited'
        : status === 408 || status >= 500
          ? 'unavailable'
          : 'invalid_post';
    const retryAfter = retryAfterOf(response.headers);
    await response.body?.cancel().catch(() => {});
    throw new FeedError(
      feed,
      code,
      `Could not download ${options.what} from ${attachment.url}: HTTP ${status}`,
      { status, ...(retryAfter !== undefined && { retryAfter }) }
    );
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    await response.body?.cancel();
    throw tooLarge(declared);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw unreachable(error);
    }
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw unreachable(error);
    }
    const { done, value } = chunk;
    if (done) break;
    size += value.byteLength;
    if (size > options.maxBytes) {
      await reader.cancel();
      throw tooLarge(size);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Fails with `invalid_post` unless the attachment is an image. */
export function assertImage(feed: string, attachment: Attachment, what: string): void {
  if (attachment.type !== 'image' || !attachment.mimeType.startsWith('image/')) {
    throw new FeedError(
      feed,
      'invalid_post',
      `${what} must be an image, got ${attachment.type} (${attachment.mimeType})`
    );
  }
}
