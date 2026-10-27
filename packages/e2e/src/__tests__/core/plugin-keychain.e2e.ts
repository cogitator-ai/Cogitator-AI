import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { experimental_keychainSecretStore } from '@cogitator-ai/core';

const supported =
  process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32';

describe.skipIf(process.env.TEST_KEYCHAIN !== 'true' || !supported)(
  'Core: plugin secrets in the system keychain',
  () => {
    it(
      'saves, reads and deletes a secret in the credential store of the system',
      { timeout: 30_000 },
      async () => {
        const store = experimental_keychainSecretStore();
        const service = `cogitator-plugin:e2e-${randomUUID()}@test`;
        const secret = `s3cret "quoted" ${randomUUID()}\nsecond line`;
        try {
          await store.set(service, 'token', secret);
          expect(await store.get(service, 'token')).toBe(secret);
          await store.set(service, 'token', 'replaced');
          expect(await store.get(service, 'token')).toBe('replaced');
        } finally {
          await store.delete(service, 'token');
        }
        expect(await store.get(service, 'token')).toBeUndefined();
      }
    );
  }
);
