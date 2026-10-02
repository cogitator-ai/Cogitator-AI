import { describe, it, expect } from 'vitest';
import { HttpError, toHttpError } from '../client/http-error.js';

describe('toHttpError', () => {
  it('extracts the error field from a JSON body', async () => {
    const err = await toHttpError(
      new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 })
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('Request failed: 400 - Invalid JSON');
  });

  it('falls back to the raw text body', async () => {
    const err = await toHttpError(new Response('upstream down', { status: 503 }));
    expect(err.message).toBe('Request failed: 503 - upstream down');
  });

  it('falls back to the status text for empty bodies', async () => {
    const err = await toHttpError(new Response(null, { status: 502, statusText: 'Bad Gateway' }));
    expect(err.message).toBe('Request failed: 502 - Bad Gateway');
  });
});
