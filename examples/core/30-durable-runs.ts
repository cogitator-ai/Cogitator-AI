import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Agent, tool, type Cogitator } from '@cogitator-ai/core';
import { createCogitator, header, section } from '../_shared/setup.js';

const MODEL = process.env.EXAMPLE_MODEL ?? `ollama/${process.env.OLLAMA_MODEL ?? 'qwen2.5:0.5b'}`;
const THREAD = 'quarterly-report';
const READY = 'EXPORT_STARTED';

const fetchOrders = tool({
  name: 'fetch_orders',
  description: 'Fetch the orders of a quarter',
  parameters: z.object({ quarter: z.string().describe('Quarter such as Q3') }),
  execute: async ({ quarter }) => ({ quarter, orders: 1284, revenue: 912_400 }),
});

/** In the crashing process the export never returns: the process is killed while it runs */
function exportReport(crashing: boolean) {
  return tool({
    name: 'export_report',
    description: 'Export the quarterly report as a PDF',
    parameters: z.object({ quarter: z.string() }),
    execute: async ({ quarter }) => {
      if (!crashing) return `report-${quarter}.pdf`;
      console.log(READY);
      return new Promise<string>(() => undefined);
    },
  });
}

function reporter(crashing: boolean): Agent {
  return new Agent({
    id: 'reporter',
    name: 'reporter',
    model: MODEL,
    instructions:
      'You prepare quarterly reports with your tools, then tell the user in one sentence what happened.',
    tools: [fetchOrders, exportReport(crashing)],
  });
}

/**
 * A process of `report-host` on the SQLite file both processes share: one process at a time has
 * this owner, so the next one takes its runs back at once (`takeoverOnRestart`)
 */
function processOn(database: string): Cogitator {
  return createCogitator({
    memory: { adapter: 'sqlite', sqlite: { path: database } },
    durable: { owner: 'report-host', takeoverOnRestart: true },
  });
}

async function crashingProcess(database: string) {
  const cog = processOn(database);
  await cog.run(reporter(true), {
    input: 'Prepare the Q3 report: fetch the orders and export the PDF.',
    threadId: THREAD,
    toolChoice: { type: 'function', function: { name: 'export_report' } },
  });
  console.log('The model answered without exporting, nothing to recover this time');
  process.exit(0);
}

async function main() {
  header('30 - Durable runs: a process dies mid-tool, another one finishes the run');
  const dir = mkdtempSync(join(tmpdir(), 'cogitator-durable-'));
  const database = join(dir, 'memory.db');

  try {
    section('A process starts the run and is killed while the export runs');
    const child = fork(fileURLToPath(import.meta.url), ['--crashing-process', database], {
      stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    });
    const exported = await new Promise<boolean>((resolve) => {
      createInterface({ input: child.stdout! }).on('line', (line) => {
        console.log(`  [crashing process] ${line}`);
        if (line === READY) resolve(true);
      });
      child.on('exit', () => resolve(false));
    });
    if (!exported) return;
    child.kill('SIGKILL');
    console.log('  killed the process with SIGKILL');

    section('The next process finds the run it left');
    const cog = processOn(database);
    for (const run of await cog.durableRuns()) {
      console.log(
        `  ${run.runId}: agent ${run.agentName}, ${run.iterations} model turn(s), held: ${run.held}`
      );
    }

    section('Recover it: the call that was running is reported as outcome unknown');
    const { resumed, skipped } = await cog.recoverRuns({ agents: [reporter(false)] });
    for (const { run, reason } of skipped) console.log(`  skipped ${run.runId}: ${reason}`);
    for (const { handle } of resumed) {
      const result = await handle.result;
      for (const message of result.messages.filter((entry) => entry.role === 'tool')) {
        console.log(`  ${message.name}: ${String(message.content).slice(0, 110)}`);
      }
      console.log(`\n  Answer: ${result.output}`);
    }
    console.log(`  Runs left: ${(await cog.durableRuns()).length}`);
    await cog.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--crashing-process') {
  crashingProcess(process.argv[3]).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
} else {
  main().catch(console.error);
}
