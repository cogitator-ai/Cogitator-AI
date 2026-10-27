/**
 * cogitator schedule, cogitator inbox and cogitator trigger: the routines, schedules and inbox a
 * runtime keeps in files (`experimental_fileTriggerStores`, `.cogitator/triggers` by default),
 * changed while the runtime runs, and the API triggers of a running server
 */

import { Command, InvalidArgumentError } from 'commander';
import chalk from 'chalk';
import {
  experimental_fileTriggerStores,
  experimental_Scheduler,
  experimental_TriggerManager,
  splitTriggerId,
  type FileTriggerStores,
  type TriggerRuntime,
} from '@cogitator-ai/core';
import { channelsCron } from '@cogitator-ai/channels';
import type {
  InboxItem,
  InboxItemKind,
  InboxItemStatus,
  RoutineDefinition,
  RoutineInfo,
  TimerEntry,
} from '@cogitator-ai/types';
import { CommandError, examplesHelp, printJson, reportFailure, UsageError } from '../utils/cli.js';

/** Where the commands print */
export interface TriggersIo {
  print(line: string): void;
}

/** What the commands work on: the stores, how to print, how to reach a server */
export interface TriggersContext {
  io: TriggersIo;
  stores: (dir: string | undefined) => FileTriggerStores;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
}

const defaultContext = (): TriggersContext => ({
  io: { print: (line) => console.log(line) },
  stores: (dir) => experimental_fileTriggerStores(dir),
  fetch,
  env: process.env,
});

/** A runtime that runs nothing: the CLI only changes what the stores hold */
const storesOnly: TriggerRuntime = {
  start: () => {
    throw new CommandError('The CLI does not run routines: the runtime that polls the store does');
  },
  resume: () => Promise.reject(new CommandError('The CLI does not resume runs')),
  notify: async () => undefined,
  durable: false,
};

function managerOf(stores: FileTriggerStores): experimental_TriggerManager {
  return new experimental_TriggerManager(
    { store: stores.store, schedules: stores.schedules, inbox: stores.inbox, cron: channelsCron },
    storesOnly
  );
}

function schedulerOf(stores: FileTriggerStores): experimental_Scheduler {
  return new experimental_Scheduler({
    store: stores.schedules,
    cron: channelsCron,
    fire: () => {
      throw new CommandError('The CLI does not fire schedules');
    },
  });
}

interface Flags {
  dir?: string;
  json?: boolean;
}

/** Runs `work`, prints its lines or its JSON, and turns a failure into the exit code */
async function respond(
  command: string,
  flags: Flags,
  context: TriggersContext,
  work: () => Promise<{ message?: string; lines?: string[]; json: Record<string, unknown> }>
): Promise<number> {
  try {
    const result = await work();
    if (flags.json) {
      printJson({ command, outcome: 'ok', ...result.json });
    } else {
      for (const line of result.lines ?? []) context.io.print(line);
      if (result.message) context.io.print(`${chalk.green('✓')} ${result.message}`);
    }
    return 0;
  } catch (error) {
    if (flags.json) {
      const code = (error as { code?: unknown }).code;
      printJson({
        command,
        outcome: 'failed',
        message: error instanceof Error ? error.message : String(error),
        ...(typeof code === 'string' && { failureCode: code }),
      });
      return 1;
    }
    return reportFailure(error, { json: false });
  }
}

function when(at: number | undefined): string {
  return at === undefined ? '-' : new Date(at).toISOString().replace('.000Z', 'Z');
}

function entryLine(entry: TimerEntry): string {
  const what = entry.trigger?.routineId
    ? `${entry.trigger.routineId}.${entry.trigger.triggerId ?? '?'}`
    : entry.trigger?.agent
      ? `task of ${entry.trigger.agent}: ${String(entry.metadata?.description ?? entry.name ?? '')}`
      : String(entry.metadata?.description ?? entry.name ?? entry.workflowId);
  const timing = entry.cron
    ? `${entry.cron}${entry.timezone ? ` ${entry.timezone}` : ''}`
    : entry.interval
      ? `every ${entry.interval} ms`
      : 'once';
  const paused = entry.enabled === false ? chalk.yellow(' paused') : '';
  return `  ${entry.id}  ${what}  ${chalk.dim(timing)}  next ${when(entry.firesAt)}${paused}`;
}

function routineLine(info: RoutineInfo): string[] {
  const target =
    'agent' in info.routine.target
      ? `agent ${String(info.routine.target.agent)}`
      : `workflow ${String((info.routine.target as { workflow: unknown }).workflow)}`;
  return [
    `  ${chalk.bold(info.routine.id)}  ${chalk.dim(target)}${info.routine.enabled === false ? chalk.yellow(' disabled') : ''}`,
    ...info.triggers.map(
      (trigger) =>
        `    ${trigger.id}  ${trigger.kind}${trigger.enabled ? '' : chalk.yellow(' paused')}${
          trigger.nextFireAt !== undefined ? `  next ${when(trigger.nextFireAt)}` : ''
        }  fired ${trigger.state.fireCount}`
    ),
  ];
}

/** cogitator schedule list */
export async function runScheduleList(
  flags: Flags,
  context: TriggersContext = defaultContext()
): Promise<number> {
  return respond('schedule list', flags, context, async () => {
    const stores = context.stores(flags.dir);
    const routines = await managerOf(stores).list();
    const entries = await schedulerOf(stores).list();
    return {
      lines: [
        chalk.bold(`Routines kept in ${stores.dir}`),
        ...(routines.length > 0 ? routines.flatMap(routineLine) : [chalk.dim('  none')]),
        chalk.bold('Schedules'),
        ...(entries.length > 0 ? entries.map(entryLine) : [chalk.dim('  none')]),
      ],
      json: { dir: stores.dir, routines, schedules: entries },
    };
  });
}

export interface ScheduleAddFlags extends Flags {
  cron: string;
  timezone?: string;
  agent?: string;
  workflow?: string;
  prompt: string;
  name?: string;
  catchUp?: 'latest' | 'none' | 'all';
  overlap?: 'skip' | 'queue' | 'parallel' | 'replace';
}

/** cogitator schedule add <id> */
export async function runScheduleAdd(
  id: string,
  flags: ScheduleAddFlags,
  context: TriggersContext = defaultContext()
): Promise<number> {
  return respond('schedule add', flags, context, async () => {
    if ((flags.agent === undefined) === (flags.workflow === undefined)) {
      throw new UsageError('Give exactly one of --agent and --workflow');
    }
    const routine: RoutineDefinition = {
      id,
      prompt: flags.prompt,
      target: flags.agent !== undefined ? { agent: flags.agent } : { workflow: flags.workflow! },
      triggers: [
        { kind: 'cron', cron: flags.cron, ...(flags.timezone && { timezone: flags.timezone }) },
      ],
      ...(flags.name && { name: flags.name }),
      ...(flags.catchUp && { catchUp: flags.catchUp }),
      ...(flags.overlap && { overlap: flags.overlap }),
    };
    const info = await managerOf(context.stores(flags.dir)).create(routine);
    const next = info.triggers[0]?.nextFireAt;
    return {
      message: `Routine ${id} added, next run ${when(next)}`,
      json: { routine: info },
    };
  });
}

/** The pending schedule entries an id names: an entry, a routine's or one trigger's */
async function entriesOf(stores: FileTriggerStores, id: string): Promise<TimerEntry[]> {
  const pending = await stores.schedules.getPending();
  const exact = pending.filter((entry) => entry.id === id);
  if (exact.length > 0) return exact;
  const split = splitTriggerId(id);
  return pending.filter(
    (entry) =>
      entry.trigger?.routineId === id ||
      (split !== undefined &&
        entry.trigger?.routineId === split.routineId &&
        entry.trigger.triggerId === split.triggerId)
  );
}

/** cogitator schedule rm <id> */
export async function runScheduleRemove(
  id: string,
  flags: Flags,
  context: TriggersContext = defaultContext()
): Promise<number> {
  return respond('schedule rm', flags, context, async () => {
    const stores = context.stores(flags.dir);
    if (await managerOf(stores).remove(id)) {
      return { message: `Routine ${id} removed with its schedules`, json: { removed: id } };
    }
    const entries = await entriesOf(stores, id);
    if (entries.length === 0) throw new CommandError(`No routine of the store or schedule ${id}`);
    if (entries.some((entry) => entry.trigger?.routineId !== undefined)) {
      throw new CommandError(`${id} is a schedule of a routine defined in code`, {
        hints: ['Remove the trigger from the code, or pause it: cogitator schedule pause'],
      });
    }
    for (const entry of entries) await stores.schedules.cancel(entry.id);
    return { message: `Schedule ${id} removed`, json: { removed: id } };
  });
}

/** cogitator schedule pause|resume <id> */
export async function runSchedulePause(
  id: string,
  enabled: boolean,
  flags: Flags,
  context: TriggersContext = defaultContext()
): Promise<number> {
  const command = enabled ? 'schedule resume' : 'schedule pause';
  return respond(command, flags, context, async () => {
    const stores = context.stores(flags.dir);
    const entries = await entriesOf(stores, id);
    const triggerIds = new Set<string>();
    for (const entry of entries) {
      const { routineId, triggerId } = entry.trigger ?? {};
      if (routineId !== undefined && triggerId !== undefined) {
        triggerIds.add(`${routineId}.${triggerId}`);
      }
    }
    const split = splitTriggerId(id);
    if (split && entries.length === 0) triggerIds.add(id);
    if (entries.length === 0 && triggerIds.size === 0) {
      throw new CommandError(`No schedule, routine or trigger ${id}`);
    }
    for (const triggerId of triggerIds) {
      const routineId = splitTriggerId(triggerId)!.routineId;
      const state = (await stores.store.getTriggerState(triggerId)) ?? {
        id: triggerId,
        routineId,
        fireCount: 0,
      };
      await stores.store.saveTriggerState({ ...state, enabled });
    }
    const scheduler = schedulerOf(stores);
    for (const entry of entries) {
      if (enabled) await scheduler.resume(entry.id);
      else await scheduler.pause(entry.id);
    }
    return {
      message: `${id} ${enabled ? 'resumed' : 'paused'}`,
      json: { id, enabled, schedules: entries.map((entry) => entry.id) },
    };
  });
}

/** cogitator schedule run <id> */
export async function runScheduleRun(
  id: string,
  flags: Flags,
  context: TriggersContext = defaultContext()
): Promise<number> {
  return respond('schedule run', flags, context, async () => {
    const stores = context.stores(flags.dir);
    const entries = await entriesOf(stores, id);
    if (entries.length === 0) {
      throw new CommandError(`No schedule ${id}`, {
        hints: ['A trigger without a schedule fires through its API: cogitator trigger fire'],
      });
    }
    const scheduler = schedulerOf(stores);
    for (const entry of entries) await scheduler.runNow(entry.id);
    return {
      message: `${id} is due now: the runtime polling ${stores.dir} runs it on its next poll`,
      json: { schedules: entries.map((entry) => entry.id) },
    };
  });
}

export interface InboxFlags extends Flags {
  unread?: boolean;
  all?: boolean;
  archived?: boolean;
  kind?: InboxItemKind;
  limit?: number;
}

function itemLine(item: InboxItem): string[] {
  const mark =
    item.kind === 'failure'
      ? chalk.red('failed')
      : item.kind === 'result'
        ? chalk.green('result')
        : chalk.yellow(item.kind);
  const unread = item.status === 'unread' ? chalk.bold('* ') : '  ';
  return [
    `${unread}${item.id}  ${mark}  ${chalk.bold(item.title)}  ${chalk.dim(when(item.createdAt))}`,
    ...(item.summary ? [`    ${item.summary}`] : []),
  ];
}

/** cogitator inbox */
export async function runInboxList(
  flags: InboxFlags,
  context: TriggersContext = defaultContext()
): Promise<number> {
  return respond('inbox', flags, context, async () => {
    const stores = context.stores(flags.dir);
    const status: InboxItemStatus[] = flags.unread
      ? ['unread']
      : flags.archived
        ? ['archived']
        : flags.all
          ? ['unread', 'read', 'archived']
          : ['unread', 'read'];
    const items = await stores.inbox.list({
      status,
      ...(flags.kind && { kind: flags.kind }),
      limit: flags.limit ?? 50,
    });
    return {
      lines: items.length > 0 ? items.flatMap(itemLine) : [chalk.dim('The inbox is empty')],
      json: { items },
    };
  });
}

/** cogitator inbox read|unread|archive <id> */
export async function runInboxMark(
  id: string,
  status: InboxItemStatus,
  flags: Flags,
  context: TriggersContext = defaultContext()
): Promise<number> {
  return respond(
    `inbox ${status === 'archived' ? 'archive' : status}`,
    flags,
    context,
    async () => {
      const item = await context.stores(flags.dir).inbox.update(id, { status });
      if (!item) throw new CommandError(`No inbox item ${id}`);
      return { message: `${id} is ${status}`, json: { item } };
    }
  );
}

/** cogitator inbox show <id> */
export async function runInboxShow(
  id: string,
  flags: Flags,
  context: TriggersContext = defaultContext()
): Promise<number> {
  return respond('inbox show', flags, context, async () => {
    const item = await context.stores(flags.dir).inbox.get(id);
    if (!item) throw new CommandError(`No inbox item ${id}`);
    return {
      lines: [
        ...itemLine(item),
        ...(item.body ? ['', item.body] : []),
        '',
        chalk.dim(
          [
            item.routineId && `routine ${item.routineId}`,
            item.runId && `run ${item.runId}`,
            item.threadId && `thread ${item.threadId}`,
          ]
            .filter(Boolean)
            .join('  ')
        ),
      ],
      json: { item },
    };
  });
}

export interface FireFlags {
  text?: string;
  url?: string;
  token?: string;
  idempotencyKey?: string;
  json?: boolean;
}

/** cogitator trigger fire <id>: POSTs to the API trigger of a running server */
export async function runTriggerFire(
  id: string,
  flags: FireFlags,
  context: TriggersContext = defaultContext()
): Promise<number> {
  return respond('trigger fire', flags, context, async () => {
    const base = flags.url ?? context.env.COGITATOR_URL;
    const token = flags.token ?? context.env.COGITATOR_TRIGGER_TOKEN;
    if (!base) {
      throw new UsageError('Where is the server? Pass --url or set COGITATOR_URL', [
        'The URL the server adapter is mounted at, such as http://localhost:3000/cogitator',
      ]);
    }
    if (!token) {
      throw new UsageError('Pass --token or set COGITATOR_TRIGGER_TOKEN', [
        'Issue one with: cogitator trigger token <id>',
      ]);
    }
    const response = await context.fetch(
      `${base.replace(/\/+$/, '')}/triggers/${encodeURIComponent(id)}/fire`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(flags.idempotencyKey && { 'idempotency-key': flags.idempotencyKey }),
        },
        body: JSON.stringify(flags.text !== undefined ? { text: flags.text } : {}),
      }
    );
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
    if (!response.ok) {
      const message =
        (body as { error?: { message?: string } } | null)?.error?.message ?? String(text);
      throw new CommandError(`The server answered ${response.status}: ${message}`);
    }
    const result = body as { status?: string; runId?: string; threadId?: string; reason?: string };
    return {
      message: `${id}: ${result.status ?? 'sent'}${result.runId ? ` (run ${result.runId})` : ''}${
        result.reason ? `, ${result.reason}` : ''
      }`,
      json: { result: body },
    };
  });
}

/** cogitator trigger token <id>: issues a new token for an API trigger of a routine of the store */
export async function runTriggerToken(
  id: string,
  flags: Flags,
  context: TriggersContext = defaultContext()
): Promise<number> {
  return respond('trigger token', flags, context, async () => {
    const { token, hint } = await managerOf(context.stores(flags.dir)).issueToken(id);
    return {
      lines: [
        token,
        chalk.dim(
          'Shown once: the store keeps only its SHA-256. A token issued before stops working.'
        ),
      ],
      json: { token, hint },
    };
  });
}

function positiveInt(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new InvalidArgumentError('Expected a positive whole number.');
  }
  return number;
}

function oneOf<T extends string>(allowed: readonly T[]): (value: string) => T {
  return (value) => {
    if ((allowed as readonly string[]).includes(value)) return value as T;
    throw new InvalidArgumentError(`Expected ${allowed.join(', ')}.`);
  };
}

const dirOption = [
  '--dir <path>',
  'the folder of the stores (default: COGITATOR_TRIGGERS_DIR, else .cogitator/triggers)',
] as const;
const jsonOption = ['--json', 'print one JSON object'] as const;

export const scheduleCommand = new Command('schedule')
  .alias('schedules')
  .description('List, add, pause, resume, run now and remove the schedules of routines')
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator schedule list', 'routines of the store and every schedule'],
      [
        'cogitator schedule add digest --cron "0 9 * * 1-5" --timezone Europe/Moscow --agent assistant --prompt "Summarize the news"',
        'a routine that runs on weekdays at 9',
      ],
      ['cogitator schedule run digest', 'make it due now, the runtime runs it'],
      ['cogitator schedule pause digest.cron', 'pause one trigger'],
    ])
  );

scheduleCommand
  .command('list')
  .alias('ls')
  .description('List the routines of the store and every pending schedule')
  .option(...dirOption)
  .option(...jsonOption)
  .action(async (flags: Flags) => {
    process.exitCode = await runScheduleList(flags);
  });

scheduleCommand
  .command('add')
  .description('Add a routine to the store that runs on a cron schedule')
  .argument('<id>', 'the routine id: lowercase letters, digits, "_", ":" and "-"')
  .requiredOption('--cron <expression>', '5 or 6 fields, or a preset such as @daily')
  .requiredOption('--prompt <text>', 'the task the routine runs')
  .option('--timezone <zone>', 'IANA time zone of the cron expression')
  .option('--agent <name>', 'an agent of experimental_triggers.agents')
  .option('--workflow <name>', 'a workflow of experimental_triggers.workflows')
  .option('--name <name>', 'a name to show')
  .option('--catch-up <mode>', 'latest, none or all', oneOf(['latest', 'none', 'all'] as const))
  .option(
    '--overlap <mode>',
    'skip, queue, parallel or replace',
    oneOf(['skip', 'queue', 'parallel', 'replace'] as const)
  )
  .option(...dirOption)
  .option(...jsonOption)
  .action(async (id: string, flags: ScheduleAddFlags) => {
    process.exitCode = await runScheduleAdd(id, flags);
  });

scheduleCommand
  .command('rm')
  .alias('remove')
  .description('Remove a routine of the store with its schedules, or a schedule entry')
  .argument('<id>', 'a routine id or a schedule id')
  .option(...dirOption)
  .option(...jsonOption)
  .action(async (id: string, flags: Flags) => {
    process.exitCode = await runScheduleRemove(id, flags);
  });

scheduleCommand
  .command('run')
  .description('Make a schedule due now: the runtime polling the store runs it')
  .argument('<id>', 'a schedule id, a routine id or <routine>.<trigger>')
  .option(...dirOption)
  .option(...jsonOption)
  .action(async (id: string, flags: Flags) => {
    process.exitCode = await runScheduleRun(id, flags);
  });

scheduleCommand
  .command('pause')
  .description('Pause a schedule, a routine or one trigger of it')
  .argument('<id>', 'a schedule id, a routine id or <routine>.<trigger>')
  .option(...dirOption)
  .option(...jsonOption)
  .action(async (id: string, flags: Flags) => {
    process.exitCode = await runSchedulePause(id, false, flags);
  });

scheduleCommand
  .command('resume')
  .description('Resume what pause paused, from its next occurrence')
  .argument('<id>', 'a schedule id, a routine id or <routine>.<trigger>')
  .option(...dirOption)
  .option(...jsonOption)
  .action(async (id: string, flags: Flags) => {
    process.exitCode = await runSchedulePause(id, true, flags);
  });

export const inboxCommand = new Command('inbox')
  .description('Read the inbox: results, failures and questions of routines')
  .option('--unread', 'only unread items')
  .option('--archived', 'only archived items')
  .option('--all', 'archived items too')
  .option(
    '--kind <kind>',
    'result, approval, question or failure',
    oneOf(['result', 'approval', 'question', 'failure'] as const)
  )
  .option('--limit <n>', 'most items (default 50)', positiveInt)
  .option(...dirOption)
  .option(...jsonOption)
  .action(async (flags: InboxFlags) => {
    process.exitCode = await runInboxList(flags);
  })
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator inbox --unread', 'what came in since you last read'],
      ['cogitator inbox show inbox_abc', 'one item in full'],
      ['cogitator inbox archive inbox_abc', 'put it away'],
    ])
  );

for (const [name, status, description] of [
  ['read', 'read', 'Mark an item read'],
  ['unread', 'unread', 'Mark an item unread'],
  ['archive', 'archived', 'Archive an item'],
] as const) {
  inboxCommand
    .command(name)
    .description(description)
    .argument('<id>', 'the item id')
    .option(...dirOption)
    .option(...jsonOption)
    .action(async (id: string, flags: Flags) => {
      process.exitCode = await runInboxMark(id, status, flags);
    });
}

inboxCommand
  .command('show')
  .description('Show an item in full')
  .argument('<id>', 'the item id')
  .option(...dirOption)
  .option(...jsonOption)
  .action(async (id: string, flags: Flags) => {
    process.exitCode = await runInboxShow(id, flags);
  });

export const triggerCommand = new Command('trigger')
  .alias('triggers')
  .description('Fire API triggers of a running server and issue their tokens')
  .addHelpText(
    'after',
    examplesHelp([
      ['cogitator trigger token digest.api', 'a new token for an API trigger of the store'],
      [
        'cogitator trigger fire digest.api --text "Breaking news" --url http://localhost:3000/cogitator',
        'fire it',
      ],
    ])
  );

triggerCommand
  .command('fire')
  .description('POST to /triggers/<id>/fire of a server with the trigger token')
  .argument('<id>', '<routine>.<trigger> of an API trigger')
  .option('--text <text>', 'the text the routine gets, as untrusted data')
  .option('--url <url>', 'where the server adapter is mounted (default: COGITATOR_URL)')
  .option('--token <token>', "the trigger's token (default: COGITATOR_TRIGGER_TOKEN)")
  .option('--idempotency-key <key>', 'repeats with the same key start one run')
  .option(...jsonOption)
  .action(async (id: string, flags: FireFlags) => {
    process.exitCode = await runTriggerFire(id, flags);
  });

triggerCommand
  .command('token')
  .description('Issue a new token for an API trigger of a routine of the store, shown once')
  .argument('<id>', '<routine>.<trigger> of an API trigger')
  .option(...dirOption)
  .option(...jsonOption)
  .action(async (id: string, flags: Flags) => {
    process.exitCode = await runTriggerToken(id, flags);
  });
