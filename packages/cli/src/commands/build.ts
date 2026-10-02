import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { log, printBanner } from '../utils/logger.js';
import { importOptionalPackage } from '../utils/module-loader.js';
import { BUNDLE_MARKER } from '../utils/daemon.js';

export const BUNDLE_EXTERNALS = [
  'grammy',
  'discord.js',
  '@slack/bolt',
  '@whiskeysockets/baileys',
  'ws',
  'better-sqlite3',
  'pg',
  'ioredis',
  'mongodb',
  '@qdrant/js-client-rest',
  'playwright',
  'playwright-core',
];

interface EsbuildBuildResult {
  metafile?: { inputs: Record<string, unknown> };
}

interface EsbuildApi {
  build(options: Record<string, unknown>): Promise<EsbuildBuildResult>;
}

function isEsbuildApi(value: unknown): value is EsbuildApi {
  return (
    typeof value === 'object' &&
    value !== null &&
    'build' in value &&
    typeof value.build === 'function'
  );
}

async function loadEsbuild(projectDir: string): Promise<EsbuildApi | null> {
  const mod = await importOptionalPackage('esbuild', projectDir);
  if (!mod) return null;
  if (isEsbuildApi(mod)) return mod;
  return isEsbuildApi(mod.default) ? mod.default : null;
}

export function createGatewayEntry(configPath: string): string {
  return `import * as entry from ${JSON.stringify(configPath)};

const gateway = entry.gateway;

if (gateway && typeof gateway.start === 'function' && typeof gateway.stop === 'function') {
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(\`[cogitator] Received \${signal}, shutting down...\`);
    try {
      await gateway.stop();
      process.exit(0);
    } catch (error) {
      console.error('[cogitator] Shutdown failed:', error);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await gateway.start();
  const channels = gateway.stats?.connectedChannels ?? [];
  console.log(\`[cogitator] Gateway started\${channels.length ? \`: \${channels.join(', ')}\` : ''}\`);
}
`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const buildCommand = new Command('build')
  .description('Bundle a gateway config into a self-starting production file with esbuild')
  .option('-c, --config <path>', 'Path to gateway config file', 'src/gateway.ts')
  .option('-o, --outfile <path>', 'Output file path', 'dist/cogitator.mjs')
  .option('--target <version>', 'Node.js target version', 'node22')
  .option('--sourcemap', 'Generate sourcemap', true)
  .option('--no-sourcemap', 'Disable sourcemap')
  .option('--minify', 'Minify output')
  .option('-q, --quiet', 'Minimal output')
  .action(
    async (options: {
      config: string;
      outfile: string;
      target: string;
      sourcemap: boolean;
      minify?: boolean;
      quiet?: boolean;
    }) => {
      if (!options.quiet) printBanner();

      const cwd = process.cwd();
      const configPath = resolve(cwd, options.config);
      const outfile = resolve(cwd, options.outfile);

      if (!existsSync(configPath)) {
        log.error(`Config not found: ${configPath}`);
        log.dim('Run "cogitator init" to create a project first');
        process.exit(1);
      }

      const esbuild = await loadEsbuild(cwd);
      if (!esbuild) {
        log.error('esbuild is required for building. Install it:');
        log.dim('  pnpm add -D esbuild');
        process.exit(1);
      }

      mkdirSync(dirname(outfile), { recursive: true });

      log.step(`Bundling ${chalk.dim(relative(cwd, configPath))}`);
      const startTime = performance.now();

      let result: EsbuildBuildResult;
      try {
        result = await esbuild.build({
          stdin: {
            contents: createGatewayEntry(configPath),
            resolveDir: dirname(configPath),
            sourcefile: 'cogitator-entry.mjs',
            loader: 'js',
          },
          bundle: true,
          platform: 'node',
          target: options.target,
          format: 'esm',
          outfile,
          sourcemap: options.sourcemap,
          minify: options.minify ?? false,
          treeShaking: true,
          metafile: true,
          logLevel: options.quiet ? 'error' : 'warning',
          external: BUNDLE_EXTERNALS,
          banner: {
            js: [
              '#!/usr/bin/env node',
              `import { createRequire as ${BUNDLE_MARKER} } from "module";`,
              `const require = ${BUNDLE_MARKER}(import.meta.url);`,
            ].join('\n'),
          },
        });
      } catch (error) {
        log.error('Build failed');
        if (error instanceof Error) log.dim(error.message);
        process.exit(1);
      }

      const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
      const sizeStr = formatSize(statSync(outfile).size);

      console.log();
      log.success(`Built in ${elapsed}s`);
      console.log();
      console.log(`  ${chalk.bold('Output')}   ${relative(cwd, outfile)}`);
      console.log(`  ${chalk.bold('Size')}     ${sizeStr}`);
      console.log(`  ${chalk.bold('Target')}   ${options.target}`);

      if (result.metafile) {
        const inputs = Object.keys(result.metafile.inputs).length;
        console.log(`  ${chalk.bold('Modules')}  ${inputs} files bundled`);
      }

      console.log();
      log.dim(`Run: node ${relative(cwd, outfile)}`);
      log.dim('Or in background: cogitator daemon start');
      console.log();
    }
  );
