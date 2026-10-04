import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startDashboard, type Dashboard } from './dashboard/server.js';
import {
  createOpenRouterBackend,
  DEFAULT_MODELS,
  fetchModelCatalogue,
  MATRIX_EXTRA_MODELS,
} from './llm.js';
import { PACKAGE_DIR, publishedPackages } from './packages.js';
import { terminalReporter } from './reporters/terminal.js';
import { GauntletRunner } from './runner/runner.js';
import type { ServiceUrls } from './runner/types.js';
import { stages } from './stages/index.js';

const HELP = `Cogitator gauntlet: runs every published package together against real models.

Usage: pnpm gauntlet [options]

  --only <ids>        comma-separated stage ids (their dependencies run too)
  --list              print the stages and exit
  --port <n>          dashboard port (default 4400)
  --no-dashboard      do not start the dashboard
  --exit              close the dashboard when the run ends
  --json <path>       also write the report here (always written to reports/latest.json)
  --concurrency <n>   stages running at once (default 4)
  --keep-tmp          keep the temporary files of the run
  --verbose           print stage log lines
  -h, --help          show this help

Environment: OPENROUTER_API_KEY (required, also read from packages/gauntlet/.env),
GAUNTLET_MODELS, GAUNTLET_POSTGRES_URL, GAUNTLET_REDIS_URL, GAUNTLET_QDRANT_URL.`;

function services(): ServiceUrls {
  return {
    postgres:
      process.env.GAUNTLET_POSTGRES_URL ??
      'postgresql://gauntlet:gauntlet@127.0.0.1:55432/gauntlet',
    redis: process.env.GAUNTLET_REDIS_URL ?? 'redis://127.0.0.1:56379',
    qdrant: process.env.GAUNTLET_QDRANT_URL ?? 'http://127.0.0.1:56333',
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      only: { type: 'string' },
      list: { type: 'boolean', default: false },
      port: { type: 'string', default: '4400' },
      'no-dashboard': { type: 'boolean', default: false },
      exit: { type: 'boolean', default: false },
      json: { type: 'string' },
      concurrency: { type: 'string', default: '4' },
      'keep-tmp': { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (values.list) {
    for (const stage of stages) {
      process.stdout.write(
        `${stage.id.padEnd(22)} ${stage.title}\n${''.padEnd(22)} ${stage.packages.join(', ')}\n`
      );
    }
    return 0;
  }

  const envFile = join(PACKAGE_DIR, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    process.stderr.write(
      'OPENROUTER_API_KEY is not set. Export it or put it in packages/gauntlet/.env.\n'
    );
    return 2;
  }

  const models = process.env.GAUNTLET_MODELS
    ? process.env.GAUNTLET_MODELS.split(',')
        .map((model) => model.trim())
        .filter(Boolean)
    : [...DEFAULT_MODELS];
  const catalogue = await fetchModelCatalogue([...new Set([...models, ...MATRIX_EXTRA_MODELS])]);
  if (catalogue.missing.length) {
    process.stderr.write(
      `OpenRouter does not know these models: ${catalogue.missing.join(', ')}\n`
    );
    return 2;
  }
  if (catalogue.withoutTools.length) {
    process.stderr.write(
      `These models do not support tool calls on OpenRouter: ${catalogue.withoutTools.join(', ')}\n`
    );
    return 2;
  }

  let runner: GauntletRunner | undefined;
  const backend = createOpenRouterBackend(apiKey, (stageId, model, usage) =>
    runner?.recordModelCall(stageId, model, usage)
  );
  runner = new GauntletRunner({
    stages,
    services: services(),
    models,
    backend,
    prices: catalogue.prices,
    publishedPackages: publishedPackages(),
    only: values.only
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean),
    concurrency: Number(values.concurrency),
    keepTmp: values['keep-tmp'],
  });

  let dashboard: Dashboard | undefined;
  if (!values['no-dashboard']) {
    const active = runner;
    dashboard = await startDashboard(Number(values.port), () => active.snapshot());
    process.stdout.write(`Dashboard: ${dashboard.url}\n\n`);
  }

  const print = terminalReporter(values.verbose);
  runner.on('event', (event) => {
    print(event);
    dashboard?.publish(event);
  });

  const report = await runner.run();

  const reports = join(PACKAGE_DIR, 'reports');
  await mkdir(reports, { recursive: true });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(join(reports, 'latest.json'), json);
  if (values.json) await writeFile(resolve(values.json), json);

  if (dashboard) {
    if (values.exit) {
      await dashboard.close();
    } else {
      process.stdout.write(`Dashboard stays up at ${dashboard.url}. Press Ctrl+C to exit.\n`);
      await new Promise<void>((done) => process.once('SIGINT', () => done()));
      await dashboard.close();
    }
  }
  return report.passed ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exit(2);
  }
);
