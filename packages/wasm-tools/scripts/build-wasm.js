#!/usr/bin/env node

/**
 * WASM Build Script
 *
 * Compiles TypeScript plugins to WASM using:
 * 1. esbuild - bundle TypeScript to CommonJS
 * 2. extism-js - compile JavaScript to WASM
 *
 * Install extism-js CLI:
 *   curl -O https://raw.githubusercontent.com/extism/js-pdk/main/install.sh
 *   bash install.sh
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const srcDir = join(rootDir, 'src', 'plugins');
const distDir = join(rootDir, 'dist');
const tempDir = join(distDir, 'temp');
const wasmDir = join(distDir, 'wasm');

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function isExtismInstalled() {
  const result = spawnSync('extism-js', ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

function buildPlugin(name) {
  const inputTs = join(srcDir, `${name}.ts`);
  const inputDts = join(srcDir, `${name}.d.ts`);
  const outputJs = join(tempDir, `${name}.js`);
  const outputWasm = join(wasmDir, `${name}.wasm`);

  if (!existsSync(inputTs)) {
    console.log(`Skipping ${name}: source file not found`);
    return false;
  }

  console.log(`Building ${name}...`);

  try {
    buildSync({
      entryPoints: [inputTs],
      bundle: true,
      format: 'cjs',
      target: 'es2020',
      outfile: outputJs,
      absWorkingDir: rootDir,
      logLevel: 'warning',
    });

    // Compile to WASM with interface file
    const interfaceArgs = existsSync(inputDts) ? ['-i', inputDts] : [];
    execFileSync('extism-js', [outputJs, ...interfaceArgs, '-o', outputWasm], {
      stdio: 'inherit',
      cwd: rootDir,
    });

    console.log(`Built: ${outputWasm}\n`);
    return true;
  } catch (error) {
    console.error(`Failed to build ${name}:`, error.message);
    return false;
  }
}

function createPlaceholder(name) {
  const outputWasm = join(wasmDir, `${name}.wasm`);
  // Create empty placeholder file
  writeFileSync(outputWasm, Buffer.alloc(0));
  console.log(`Created placeholder: ${outputWasm}`);
}

function main() {
  ensureDir(tempDir);
  ensureDir(wasmDir);

  const plugins = readdirSync(srcDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => f.replace('.ts', ''));

  if (plugins.length === 0) {
    console.log('No plugins found in src/plugins/');
    return;
  }

  console.log(`Found ${plugins.length} plugin(s): ${plugins.join(', ')}\n`);

  if (!isExtismInstalled()) {
    console.log('⚠️  extism-js CLI not found. Creating placeholder files.\n');
    console.log('To build real WASM plugins, install extism-js:');
    console.log('  curl -O https://raw.githubusercontent.com/extism/js-pdk/main/install.sh');
    console.log('  bash install.sh\n');

    for (const plugin of plugins) {
      createPlaceholder(plugin);
    }

    rmSync(tempDir, { recursive: true, force: true });
    console.log('\nPlaceholders created. Run build again after installing extism-js.');
    return;
  }

  let success = 0;
  let failed = 0;

  for (const plugin of plugins) {
    if (buildPlugin(plugin)) {
      success++;
    } else {
      failed++;
    }
  }

  rmSync(tempDir, { recursive: true, force: true });

  console.log(`Build complete: ${success} succeeded, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main();
