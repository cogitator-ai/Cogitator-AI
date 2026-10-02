import { describe, it, expect } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';
import { pluginCall, runPlugin } from '../helpers/run-plugin';

interface CompressionOutput {
  result: string;
  originalSize: number;
  resultSize: number;
  ratio?: number;
  error?: string;
}

interface SigningOutput {
  publicKey?: string;
  privateKey?: string;
  signature?: string;
  valid?: boolean;
  algorithm: string;
  error?: string;
}

const compression = pluginCall<CompressionOutput>('compression', 'compression');
const signing = pluginCall<SigningOutput>('signing', 'signing');

const TEXTS = [
  '',
  'a',
  'hello hello hello',
  'The quick brown fox jumps over the lazy dog. '.repeat(300),
  'Привет мир 😀'.repeat(50),
  randomBytes(3000).toString('base64'),
  'ab'.repeat(40000),
];

describe('compression plugin', () => {
  it.each([0, 1, 6, 9])('produces gzip that zlib can inflate (level %i)', (level) => {
    for (const text of TEXTS) {
      const out = compression({ data: text, operation: 'compress', level });
      expect(out.error).toBeUndefined();
      expect(gunzipSync(Buffer.from(out.result, 'base64')).toString('utf8')).toBe(text);
    }
  });

  it('inflates gzip produced by zlib at every level', () => {
    for (const text of TEXTS) {
      for (const level of [1, 6, 9]) {
        const gz = gzipSync(Buffer.from(text, 'utf8'), { level }).toString('base64');
        const out = compression({ data: gz, operation: 'decompress' });
        expect(out.error).toBeUndefined();
        expect(out.result).toBe(text);
      }
    }
  });

  it('round-trips binary data with base64 encodings', () => {
    const bin = randomBytes(5000);
    const compressed = compression({
      data: bin.toString('base64'),
      operation: 'compress',
      inputEncoding: 'base64',
    });
    expect(gunzipSync(Buffer.from(compressed.result, 'base64')).equals(bin)).toBe(true);

    const restored = compression({
      data: gzipSync(bin).toString('base64'),
      operation: 'decompress',
      outputEncoding: 'base64',
    });
    expect(Buffer.from(restored.result, 'base64').equals(bin)).toBe(true);
  });

  it('actually compresses repetitive data', () => {
    const out = compression({ data: 'abc'.repeat(10000), operation: 'compress', level: 1 });
    expect(out.resultSize).toBeLessThan(out.originalSize / 10);
  });

  it('detects corrupted gzip payloads', () => {
    const gz = gzipSync(Buffer.from('important data '.repeat(20)));
    gz[gz.length - 9] ^= 0xff;
    const corrupted = compression({ data: gz.toString('base64'), operation: 'decompress' });
    expect(corrupted.error).toBeDefined();

    const notGzip = compression({ data: 'aGVsbG8=', operation: 'decompress' });
    expect(notGzip.error).toContain('Invalid gzip header');
  });

  it('validates level and operation', () => {
    expect(compression({ data: 'x', operation: 'compress', level: 10 }).error).toContain('level');
    expect(compression({ data: 'x', operation: 'compress', level: 2.5 }).error).toContain('level');
    expect(compression({ data: 'x', operation: 'explode' }).error).toContain('Unknown operation');
  });
});

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function nodeKeys(seed: Buffer) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, publicKey, rawPublic };
}

describe('signing plugin', () => {
  it('requires a seed for generateKeypair because WASM has no secure RNG', () => {
    const result = runPlugin<SigningOutput>('signing', 'signing', {
      operation: 'generateKeypair',
      algorithm: 'ed25519',
    });
    expect(result.code).toBe(1);
    expect(result.output.error).toContain('seed');
    expect(result.output.algorithm).toBe('ed25519');
  });

  it('derives the same public key as node:crypto from a seed', () => {
    const seed = randomBytes(32);
    const out = signing({
      operation: 'generateKeypair',
      algorithm: 'ed25519',
      seed: seed.toString('hex'),
    });
    expect(out.privateKey).toBe(seed.toString('hex'));
    expect(out.publicKey).toBe(nodeKeys(seed).rawPublic.toString('hex'));
  });

  it('produces signatures identical to node:crypto and verifies them', () => {
    const seed = randomBytes(32);
    const { privateKey, rawPublic } = nodeKeys(seed);
    for (const message of ['hello', '', 'Привет 😀']) {
      const out = signing({
        operation: 'sign',
        algorithm: 'ed25519',
        privateKey: seed.toString('hex'),
        message,
      });
      const expected = nodeSign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex');
      expect(out.signature).toBe(expected);

      const verified = signing({
        operation: 'verify',
        algorithm: 'ed25519',
        publicKey: rawPublic.toString('hex'),
        signature: expected,
        message,
      });
      expect(verified.valid).toBe(true);
    }
  });

  it('works with base64-encoded keys and signatures (padded)', () => {
    const seed = randomBytes(32);
    const { publicKey } = nodeKeys(seed);
    const keys = signing({
      operation: 'generateKeypair',
      algorithm: 'ed25519',
      seed: seed.toString('base64'),
      encoding: 'base64',
    });
    expect(keys.privateKey).toBe(seed.toString('base64'));

    const signed = signing({
      operation: 'sign',
      algorithm: 'ed25519',
      privateKey: keys.privateKey,
      message: 'msg',
      encoding: 'base64',
    });
    expect(signed.error).toBeUndefined();
    expect(
      nodeVerify(null, Buffer.from('msg'), publicKey, Buffer.from(signed.signature!, 'base64'))
    ).toBe(true);
  });

  it('rejects tampered messages, signatures and invalid public keys', () => {
    const seed = randomBytes(32);
    const { privateKey, rawPublic } = nodeKeys(seed);
    const signature = nodeSign(null, Buffer.from('original'), privateKey).toString('hex');

    expect(
      signing({
        operation: 'verify',
        algorithm: 'ed25519',
        publicKey: rawPublic.toString('hex'),
        signature,
        message: 'tampered',
      }).valid
    ).toBe(false);

    const badKey = Buffer.alloc(32, 0xff).toString('hex');
    expect(
      signing({
        operation: 'verify',
        algorithm: 'ed25519',
        publicKey: badKey,
        signature,
        message: 'original',
      }).valid
    ).toBe(false);
  });

  it('validates key and seed lengths', () => {
    expect(
      signing({ operation: 'generateKeypair', algorithm: 'ed25519', seed: 'abcd' }).error
    ).toContain('Invalid seed length');
    expect(
      signing({ operation: 'sign', algorithm: 'ed25519', privateKey: 'abcd', message: 'x' }).error
    ).toContain('Invalid private key length');
  });
});
