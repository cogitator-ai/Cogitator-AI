import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { log, printBanner } from '../utils/logger.js';

export const buildCommand = new Command('build')
  .description('Bundle gateway config into a production-ready file with esbuild')
  .option('-c, --config <path>', 'Path to gateway config file', 'src/gateway.ts')
  .option('-o, --outfile <path>', 'Output file path', 'dist/cogitator.mjs')
  .option('--target <version>', 'Node.js target version', 'node20')
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
      minify: boolean;
      quiet: boolean;
    }) => {
      if (!options.quiet) printBanner();

      const configPath = resolve(process.cwd(), options.config);
      const outfile = resolve(process.cwd(), options.outfile);

      if (!existsSync(configPath)) {
        log.error(`Config not found: ${configPath}`);
        log.dim('Run "cogitator init" to create a project first');
        process.exit(1);
      }

      type EsbuildLike = {
        build(options: Record<string, unknown>): Promise<{
          metafile?: { inputs: Record<string, unknown> };
        }>;
      };
      let esbuild: EsbuildLike;
      try {
        // @ts-expect-error esbuild is an optional dependency
        esbuild = await import('esbuild');
      } catch {
        log.error('esbuild is required for building. Install it:');
        log.dim('  pnpm add -D esbuild');
        process.exit(1);
      }

      const outDir = resolve(outfile, '..');
      if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
      }

      log.step(`Bundling ${chalk.dim(relative(process.cwd(), configPath))}`);
      const startTime = performance.now();

      const result = await esbuild.build({
        entryPoints: [configPath],
        bundle: true,
        platform: 'node',
        target: options.target,
        format: 'esm',
        outfile,
        sourcemap: options.sourcemap,
        minify: options.minify,
        treeShaking: true,
        metafile: true,
        external: [
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
        ],
        banner: {
          js: [
            '#!/usr/bin/env node',
            'import { createRequire } from "module";',
            'const require = createRequire(import.meta.url);',
          ].join('\n'),
        },
      });

      const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
      const size = statSync(outfile);
      const sizeStr = formatSize(size.size);

      console.log();
      log.success(`Built in ${elapsed}s`);
      console.log();
      console.log(`  ${chalk.bold('Output')}   ${relative(process.cwd(), outfile)}`);
      console.log(`  ${chalk.bold('Size')}     ${sizeStr}`);
      console.log(`  ${chalk.bold('Target')}   ${options.target}`);

      if (result.metafile) {
        const inputs = Object.keys(result.metafile.inputs).length;
        console.log(`  ${chalk.bold('Modules')}  ${inputs} files bundled`);
      }

      console.log();
      log.dim(`Run: node ${relative(process.cwd(), outfile)}`);
      console.log();
    }
  );

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
