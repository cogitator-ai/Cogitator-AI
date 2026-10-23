import { createHash, createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TwilioSessionTokens,
  twilioSignature,
  validateTwilioSignature,
  validateTwilioWebhook,
  verifyTwilioUpgrade,
} from '../../telephony/twilio-security';

const AUTH_TOKEN = '12345';
const DOC_URL = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const DOC_PARAMS = {
  CallSid: 'CA1234567890ABCDE',
  Caller: '+12349013030',
  Digits: '1234',
  From: '+12349013030',
  To: '+18005551212',
};
const DOC_SIGNATURE = '0/KCTR6DLpKmkAf8muzZqo1nDgQ=';

function upgradeRequest(signature: string | undefined): IncomingMessage {
  return {
    headers: signature === undefined ? {} : { 'x-twilio-signature': signature },
  } as IncomingMessage;
}

describe('Twilio request signatures', () => {
  it('matches the example of the Twilio documentation', () => {
    expect(twilioSignature(AUTH_TOKEN, DOC_URL, DOC_PARAMS)).toBe(DOC_SIGNATURE);
    expect(
      validateTwilioSignature({
        authToken: AUTH_TOKEN,
        signature: DOC_SIGNATURE,
        url: DOC_URL,
        params: DOC_PARAMS,
      })
    ).toBe(true);
  });

  it('refuses a tampered parameter, URL, signature or token', () => {
    const base = {
      authToken: AUTH_TOKEN,
      signature: DOC_SIGNATURE,
      url: DOC_URL,
      params: DOC_PARAMS,
    };
    expect(validateTwilioSignature({ ...base, params: { ...DOC_PARAMS, Digits: '9' } })).toBe(
      false
    );
    expect(validateTwilioSignature({ ...base, url: `${DOC_URL}&x=1` })).toBe(false);
    expect(validateTwilioSignature({ ...base, signature: `${DOC_SIGNATURE.slice(0, -2)}A=` })).toBe(
      false
    );
    expect(validateTwilioSignature({ ...base, signature: 'short' })).toBe(false);
    expect(validateTwilioSignature({ ...base, authToken: 'other' })).toBe(false);
    expect(validateTwilioSignature({ ...base, signature: undefined })).toBe(false);
  });

  it('accepts the URL signed with or without its default port', () => {
    const signature = twilioSignature(AUTH_TOKEN, 'https://mycompany.com:443/voice', {});
    expect(
      validateTwilioSignature({
        authToken: AUTH_TOKEN,
        signature,
        url: 'https://mycompany.com/voice',
      })
    ).toBe(true);
  });

  it('signs the distinct values of a repeated parameter in order, as the Twilio libraries do', () => {
    const expected = createHmac('sha1', AUTH_TOKEN).update('https://x.test/aa1a2').digest('base64');
    expect(expected).toBe('wwF/3j86LUmu17mrXthAh4n8lu0=');
    expect(twilioSignature(AUTH_TOKEN, 'https://x.test/a', { a: ['2', '1', '2'] })).toBe(expected);
    expect(
      validateTwilioWebhook({
        authToken: AUTH_TOKEN,
        signature: expected,
        url: 'https://x.test/a',
        body: 'a=2&a=1&a=2',
      })
    ).toBe(true);
  });

  describe('validateTwilioWebhook', () => {
    it('validates a form-encoded webhook', () => {
      const body = new URLSearchParams(DOC_PARAMS).toString();
      expect(
        validateTwilioWebhook({
          authToken: AUTH_TOKEN,
          signature: DOC_SIGNATURE,
          url: DOC_URL,
          body,
        })
      ).toBe(true);
      expect(
        validateTwilioWebhook({
          authToken: AUTH_TOKEN,
          signature: DOC_SIGNATURE,
          url: DOC_URL,
          body: body.replace('1234', '4321'),
        })
      ).toBe(false);
    });

    it('validates a JSON body through bodySHA256', () => {
      const body = JSON.stringify({ event: 'call' });
      const hash = createHash('sha256').update(body).digest('hex');
      const url = `https://mycompany.com/hook?bodySHA256=${hash}`;
      const signature = twilioSignature(AUTH_TOKEN, url);
      expect(validateTwilioWebhook({ authToken: AUTH_TOKEN, signature, url, body })).toBe(true);
      expect(
        validateTwilioWebhook({ authToken: AUTH_TOKEN, signature, url, body: `${body} ` })
      ).toBe(false);
    });
  });

  describe('verifyTwilioUpgrade', () => {
    const streamUrl = 'wss://voice.example.com/twilio';

    it('accepts the stream URL signed with no parameters, with or without a trailing slash', () => {
      const options = { authToken: AUTH_TOKEN, streamUrl };
      expect(
        verifyTwilioUpgrade(upgradeRequest(twilioSignature(AUTH_TOKEN, streamUrl)), options)
      ).toBe(true);
      expect(
        verifyTwilioUpgrade(upgradeRequest(twilioSignature(AUTH_TOKEN, `${streamUrl}/`)), options)
      ).toBe(true);
      expect(
        verifyTwilioUpgrade(upgradeRequest(twilioSignature(AUTH_TOKEN, streamUrl)), {
          authToken: AUTH_TOKEN,
          streamUrl: `${streamUrl}/`,
        })
      ).toBe(true);
    });

    it('refuses a missing, tampered or foreign signature', () => {
      const options = { authToken: AUTH_TOKEN, streamUrl };
      expect(verifyTwilioUpgrade(upgradeRequest(undefined), options)).toBe(false);
      expect(
        verifyTwilioUpgrade(upgradeRequest(twilioSignature(AUTH_TOKEN, `${streamUrl}x`)), options)
      ).toBe(false);
      expect(
        verifyTwilioUpgrade(upgradeRequest(twilioSignature('wrong-token', streamUrl)), options)
      ).toBe(false);
    });
  });
});

describe('TwilioSessionTokens', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('grants a token once, with its metadata', () => {
    const tokens = new TwilioSessionTokens();
    const token = tokens.issue({ metadata: { caller: '+15550001' } });
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(tokens.size).toBe(1);
    expect(tokens.consume(token)?.metadata).toEqual({ caller: '+15550001' });
    expect(tokens.consume(token)).toBeUndefined();
    expect(tokens.size).toBe(0);
  });

  it('binds a token to the call it was issued for', () => {
    const tokens = new TwilioSessionTokens();
    const bound = tokens.issue({ callSid: 'CA1' });
    expect(tokens.consume(bound, 'CA1')?.callSid).toBe('CA1');
    const stolen = tokens.issue({ callSid: 'CA1' });
    expect(tokens.consume(stolen, 'CA2')).toBeUndefined();
    expect(tokens.consume(stolen, 'CA1')).toBeUndefined();
    const free = tokens.issue();
    expect(tokens.consume(free, 'CA9')).toBeDefined();
  });

  it('caps the tokens waiting to be used', () => {
    const tokens = new TwilioSessionTokens({ maxPending: 2 });
    const first = tokens.issue();
    tokens.issue();
    expect(() => tokens.issue()).toThrow('Too many');
    tokens.consume(first);
    expect(() => tokens.issue()).not.toThrow();
    expect(() => new TwilioSessionTokens({ maxPending: 0 })).toThrow(RangeError);
  });

  it('refuses an unknown or missing token', () => {
    const tokens = new TwilioSessionTokens();
    tokens.issue();
    expect(tokens.consume('nope')).toBeUndefined();
    expect(tokens.consume(undefined)).toBeUndefined();
    expect(tokens.consume('')).toBeUndefined();
  });

  it('refuses an expired token and forgets expired ones', () => {
    vi.useFakeTimers();
    const tokens = new TwilioSessionTokens({ ttl: 1_000 });
    const expired = tokens.issue();
    const fresh = tokens.issue();
    vi.advanceTimersByTime(1_000);
    expect(tokens.consume(expired)).toBeUndefined();
    expect(tokens.consume(fresh)).toBeUndefined();
    const next = tokens.issue();
    vi.advanceTimersByTime(999);
    expect(tokens.consume(next)).toBeDefined();
    expect(tokens.size).toBe(0);
  });

  it('rejects a ttl that is not positive', () => {
    expect(() => new TwilioSessionTokens({ ttl: 0 })).toThrow(RangeError);
  });
});
