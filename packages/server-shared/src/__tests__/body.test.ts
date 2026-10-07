import { describe, it, expect } from 'vitest';
import {
  isJsonMediaType,
  parseJsonBody,
  readJsonRequestBody,
  refuseNonJsonBody,
  UNSUPPORTED_MEDIA_TYPE,
} from '../index';

describe('isJsonMediaType', () => {
  it.each([
    ['application/json', true],
    ['application/json; charset=utf-8', true],
    ['Application/JSON', true],
    ['application/merge-patch+json', true],
    ['text/plain', false],
    ['text/plain; charset=utf-8', false],
    ['application/x-www-form-urlencoded', false],
    ['multipart/form-data; boundary=x', false],
    ['application/jsonp', false],
    [undefined, false],
    ['', false],
  ])('%j is JSON: %s', (contentType, expected) => {
    expect(isJsonMediaType(contentType)).toBe(expected);
  });
});

describe('refuseNonJsonBody', () => {
  it('refuses a body a browser can send across origins without a preflight', () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      expect(refuseNonJsonBody('POST', { 'content-type': type, 'content-length': '12' })).toBe(
        UNSUPPORTED_MEDIA_TYPE
      );
    }
    expect(
      refuseNonJsonBody(
        'POST',
        new Headers({ 'content-type': 'text/plain', 'transfer-encoding': 'chunked' })
      )
    ).toBe(UNSUPPORTED_MEDIA_TYPE);
  });

  it('lets JSON bodies, requests without a body and reads through', () => {
    expect(
      refuseNonJsonBody('POST', { 'content-type': 'application/json', 'content-length': '2' })
    ).toBeUndefined();
    expect(refuseNonJsonBody('POST', { 'content-length': '0' })).toBeUndefined();
    expect(refuseNonJsonBody('POST', {})).toBeUndefined();
    expect(
      refuseNonJsonBody('GET', { 'content-type': 'text/plain', 'content-length': '3' })
    ).toBeUndefined();
  });
});

describe('parseJsonBody', () => {
  it('refuses JSON text that does not say it is JSON', () => {
    expect(parseJsonBody('text/plain', '{"input":"hi"}')).toEqual({
      ok: false,
      refusal: UNSUPPORTED_MEDIA_TYPE,
    });
  });

  it('reads an empty body as no body, and refuses broken JSON', () => {
    expect(parseJsonBody('text/plain', '  ')).toEqual({ ok: true, value: undefined });
    expect(parseJsonBody('application/json', '{')).toMatchObject({
      ok: false,
      refusal: { status: 400, code: 'INVALID_INPUT' },
    });
  });
});

describe('readJsonRequestBody', () => {
  const post = (body: string, type: string) =>
    new Request('http://x/run', { method: 'POST', body, headers: { 'content-type': type } });

  it('reads a JSON body', async () => {
    expect(await readJsonRequestBody(post('{"input":"hi"}', 'application/json'))).toEqual({
      ok: true,
      value: { input: 'hi' },
    });
  });

  it('refuses a text/plain body without parsing it', async () => {
    expect(await readJsonRequestBody(post('{"input":"hi"}', 'text/plain'))).toEqual({
      ok: false,
      refusal: UNSUPPORTED_MEDIA_TYPE,
    });
  });

  it('stops at the limit', async () => {
    expect(
      await readJsonRequestBody(post('{"input":"hello"}', 'application/json'), 5)
    ).toMatchObject({
      ok: false,
      refusal: { status: 413, code: 'PAYLOAD_TOO_LARGE' },
    });
  });

  it('reads a request without a body as no body', async () => {
    expect(await readJsonRequestBody(new Request('http://x/run', { method: 'POST' }))).toEqual({
      ok: true,
      value: undefined,
    });
  });
});
