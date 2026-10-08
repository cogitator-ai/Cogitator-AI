import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installErrorCode } from '../kit/package-manager.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/install-errors');

function output(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.txt`), 'utf-8');
}

describe('the code of a failed install', () => {
  it.each([
    ['npm-no-version', 'ETARGET', 1],
    ['npm-not-found', 'E404', 1],
    ['npm-offline', 'ECONNREFUSED', 1],
    ['npm-postinstall', 'ELIFECYCLE', 3],
    ['pnpm-no-version', 'ERR_PNPM_NO_MATCHING_VERSION', 1],
    ['pnpm-not-found', 'ERR_PNPM_FETCH_404', 1],
    ['pnpm-offline', 'ERR_PNPM_META_FETCH_FAIL', 1],
    ['pnpm-postinstall', 'ELIFECYCLE', 3],
    ['yarn4-no-version', 'YN0082', 1],
    ['yarn4-not-found', 'YN0035', 1],
    ['yarn4-offline', 'ECONNREFUSED', 1],
    ['yarn4-postinstall', 'YN0009', 1],
    ['yarn1-no-version', 'NO_MATCHING_VERSION', 1],
    ['yarn1-not-found', 'HTTP_404', 1],
    ['yarn1-offline', 'ECONNREFUSED', 1],
    ['yarn1-postinstall', 'ELIFECYCLE', 3],
    ['bun-no-version', 'NO_MATCHING_VERSION', 1],
    ['bun-not-found', 'HTTP_404', 1],
    ['bun-offline', 'ECONNREFUSED', 1],
    ['bun-postinstall', 'ELIFECYCLE', 3],
  ])('from the output of %s is %s', (name, code, exitCode) => {
    expect(installErrorCode(output(name), exitCode)).toBe(code);
  });

  it.each([
    ['pnpm', ' ERR_PNPM_TOKEN_SECRET123  install script output', 'ERR_PNPM_OTHER'],
    ['npm', 'npm error code ESECRET123\nnpm error something', 'NPM_OTHER'],
    ['Yarn', '➤ YN9123: │ secret\n➤ YN0000: · Failed with errors', 'EXIT_1'],
    ['Bun', 'error: SecretToken123 leaked\n', 'EXIT_1'],
    ['Bun', 'error: GET https://registry.zebra.dev/x - 123\n', 'EXIT_1'],
  ])('never takes an unknown %s code from output a script could print', (_pm, text, code) => {
    expect(installErrorCode(text, 1)).toBe(code);
  });

  it('is the exit code when the output names no cause', () => {
    expect(installErrorCode('something went wrong in /Users/zebra/app\n', 137)).toBe('EXIT_137');
  });
});
