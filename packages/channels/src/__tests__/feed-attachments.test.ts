import { describe, expect, it } from 'vitest';
import { attachmentBytes } from '../feeds/attachments';

const image = { type: 'image' as const, mimeType: 'image/png', url: 'https://cdn.example/a.png' };

function download(fetchImpl: () => Promise<Response>) {
  return attachmentBytes('bluesky', image, {
    maxBytes: 1_000,
    what: 'The image',
    fetch: fetchImpl as unknown as typeof fetch,
  });
}

describe('attachmentBytes', () => {
  it('downloads an image within the limit', async () => {
    const bytes = await download(async () => new Response(new Uint8Array(10)));
    expect(bytes.byteLength).toBe(10);
  });

  it.each([
    [404, 'invalid_post', false],
    [403, 'invalid_post', false],
    [408, 'unavailable', true],
    [503, 'unavailable', true],
    [429, 'rate_limited', true],
  ])('treats HTTP %i from the image host as %s', async (status, code, retryable) => {
    const error = await download(
      async () => new Response('nope', { status, headers: { 'retry-after': '7' } })
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code, retryable, status });
    if (status === 429) expect(error).toMatchObject({ retryAfter: 7_000 });
  });

  it('treats a host it cannot reach as unavailable, to be tried again', async () => {
    await expect(
      download(async () => {
        throw new TypeError('fetch failed');
      })
    ).rejects.toMatchObject({ code: 'unavailable', retryable: true });
  });
});
