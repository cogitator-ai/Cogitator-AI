import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const loadConfig = require('next/dist/server/config').default;
const { PHASE_PRODUCTION_SERVER } = require('next/constants');

test('production keeps the runtime route cache in bounded memory only', async () => {
  const dashboard = fileURLToPath(new URL('../', import.meta.url));
  const config = await loadConfig(PHASE_PRODUCTION_SERVER, dashboard);

  assert.equal(config.experimental.isrFlushToDisk, false);
  assert.ok(config.cacheMaxMemorySize > 0 && config.cacheMaxMemorySize <= 50 * 1024 * 1024);
});
