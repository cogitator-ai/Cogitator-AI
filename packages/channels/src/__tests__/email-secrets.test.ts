import { describe, expect, it } from 'vitest';
import { secretsEqual } from '../channels/email/auth';

describe('secretsEqual', () => {
  it('matches only the same secret, whatever the lengths', () => {
    expect(secretsEqual('s3cret-token', 's3cret-token')).toBe(true);
    expect(secretsEqual('s3cret-tokeN', 's3cret-token')).toBe(false);
    expect(secretsEqual('s3cret', 's3cret-token')).toBe(false);
    expect(secretsEqual('s3cret-token-and-more', 's3cret-token')).toBe(false);
    expect(secretsEqual('', 's3cret-token')).toBe(false);
    expect(secretsEqual('пароль', 'пароль')).toBe(true);
  });
});
