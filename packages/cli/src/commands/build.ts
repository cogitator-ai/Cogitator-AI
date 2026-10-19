import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import type { BuildOptions, BuildResult } from 'esbuild';
import { log, printBanner } from '../utils/logger.js';
import { CommandError, errorMessage, examplesHelp } from '../utils/cli.js';
import { BUNDLE_MARKER } from '../utils/daemon.js';

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

export interface GatewayBuildOptions {
  configPath: string;
  outfile: string;
  target: string;
  sourcemap: boolean;
  minify?: boolean;
  quiet?: boolean;
}

/**
 * esbuild options for a gateway bundle. The project's own code is bundled,
 * while every package stays an import resolved from node_modules at runtime:
 * packages ship native addons (better-sqlite3, the ssh2 behind the Docker
 * sandbox) and optional drivers loaded on demand, which a bundle cannot
 * carry, so the bundle runs next to the project's node_modules.
 */
type GatewayBuildConfig = BuildOptions & { metafile: true };

export function gatewayBuildOptions(options: GatewayBuildOptions): GatewayBuildConfig {
  return {
    stdin: {
      contents: createGatewayEntry(options.configPath),
      resolveDir: dirname(options.configPath),
      sourcefile: 'cogitator-entry.mjs',
      loader: 'js',
    },
    bundle: true,
    packages: 'external',
    platform: 'node',
    target: options.target,
    format: 'esm',
    outfile: options.outfile,
    sourcemap: options.sourcemap,
    minify: options.minify ?? false,
    treeShaking: true,
    metafile: true,
    logLevel: options.quiet ? 'error' : 'warning',
    banner: {
      js: [
        '#!/usr/bin/env node',
        `import { createRequire as ${BUNDLE_MARKER} } from "module";`,
        `const require = ${BUNDLE_MARKER}(import.meta.url);`,
      ].join('\n'),
    },
  };
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
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator build', 'bundle src/gateway.ts into dist/cogitator.mjs'],
      ['cogitator build --minify --no-sourcemap', 'the smallest bundle'],
    ])
  )
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
        throw new CommandError(`Config not found: ${configPath}`, {
          hints: ['Run "cogitator init" to create a project first'],
        });
      }

      const esbuild = await import('esbuild');

      mkdirSync(dirname(outfile), { recursive: true });

      log.step(`Bundling ${chalk.dim(relative(cwd, configPath))}`);
      const startTime = performance.now();

      let result: BuildResult<GatewayBuildConfig>;
      try {
        result = await esbuild.build(
          gatewayBuildOptions({
            configPath,
            outfile,
            target: options.target,
            sourcemap: options.sourcemap,
            minify: options.minify,
            quiet: options.quiet,
          })
        );
      } catch (error) {
        throw new CommandError('Build failed', { hints: [errorMessage(error)] });
      }

      const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
      const sizeStr = formatSize(statSync(outfile).size);

      console.log();
      log.success(`Built in ${elapsed}s`);
      console.log();
      console.log(`  ${chalk.bold('Output')}   ${relative(cwd, outfile)}`);
      console.log(`  ${chalk.bold('Size')}     ${sizeStr}`);
      console.log(`  ${chalk.bold('Target')}   ${options.target}`);

      const inputs = Object.keys(result.metafile.inputs).length;
      console.log(`  ${chalk.bold('Modules')}  ${inputs} files bundled`);

      console.log();
      log.dim(`Run: node ${relative(cwd, outfile)}`);
      log.dim('Or in background: cogitator daemon start');
      console.log();
    }
  );
