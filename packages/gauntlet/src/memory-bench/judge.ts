import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { BENCH_MODEL, Budget, callCost } from './budget.js';
import { mapConcurrent } from './runner.js';
import { sealJsonl } from './options.js';
import type { JudgeRequest } from './scoring.js';

/** What the judge said to one request. */
export interface JudgeReply {
  text: string;
  costUsd: number;
}

interface StoredBatch {
  id: string;
  /** Request ids by custom id */
  requests: Record<string, string>;
  done: boolean;
}

/**
 * The judge's replies and the batches still out, kept on disk as they come: a run stopped while
 * waiting for a batch picks it up on the next start instead of paying for it again, and a reply
 * once paid for is never asked again.
 */
export class JudgeStore {
  readonly replies = new Map<string, JudgeReply>();
  private readonly batches: StoredBatch[];

  constructor(
    private readonly repliesPath: string,
    private readonly batchesPath: string
  ) {
    sealJsonl(repliesPath);
    if (existsSync(repliesPath)) {
      for (const line of readFileSync(repliesPath, 'utf8').split('\n')) {
        const record = parseLine(line);
        if (record) this.replies.set(record.id, { text: record.text, costUsd: record.costUsd });
      }
    }
    this.batches = existsSync(batchesPath)
      ? (JSON.parse(readFileSync(batchesPath, 'utf8')) as StoredBatch[])
      : [];
  }

  /** What the stored replies cost. */
  get costUsd(): number {
    let sum = 0;
    for (const reply of this.replies.values()) sum += reply.costUsd;
    return sum;
  }

  record(id: string, reply: JudgeReply): void {
    this.replies.set(id, reply);
    appendFileSync(this.repliesPath, `${JSON.stringify({ id, ...reply })}\n`);
  }

  get openBatches(): readonly StoredBatch[] {
    return this.batches.filter((batch) => !batch.done);
  }

  addBatch(batch: StoredBatch): void {
    this.batches.push(batch);
    this.save();
  }

  closeBatch(id: string): void {
    const batch = this.batches.find((item) => item.id === id);
    if (batch) batch.done = true;
    this.save();
  }

  private save(): void {
    const partial = `${this.batchesPath}.tmp`;
    writeFileSync(partial, `${JSON.stringify(this.batches, null, 2)}\n`);
    renameSync(partial, this.batchesPath);
  }
}

function parseLine(line: string): ({ id: string } & JudgeReply) | undefined {
  if (!line.trim()) return undefined;
  try {
    const value = JSON.parse(line) as { id?: unknown; text?: unknown; costUsd?: unknown };
    return typeof value.id === 'string' &&
      typeof value.text === 'string' &&
      typeof value.costUsd === 'number'
      ? { id: value.id, text: value.text, costUsd: value.costUsd }
      : undefined;
  } catch {
    return undefined;
  }
}

export interface JudgeOptions {
  client: Anthropic;
  /** Send the requests as Message Batches (half price, minutes to hours) instead of one by one */
  batch: boolean;
  budget: Budget;
  store: JudgeStore;
  concurrency: number;
  log(line: string): void;
  /** How often a batch is checked (default 30 s) */
  pollMs?: number;
}

/** Requests a batch holds at most here, the API takes up to 100 000. */
const BATCH_SIZE = 5000;

function params(request: JudgeRequest): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: BENCH_MODEL,
    max_tokens: request.maxTokens,
    thinking: { type: 'disabled' },
    ...(request.system && { system: request.system }),
    messages: [{ role: 'user', content: request.prompt }],
  };
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim();
}

async function direct(requests: readonly JudgeRequest[], options: JudgeOptions): Promise<void> {
  let failures = 0;
  await mapConcurrent(requests, options.concurrency, async (request) => {
    try {
      const message = await options.client.messages.create(params(request));
      const costUsd = callCost(message.usage.input_tokens, message.usage.output_tokens);
      options.store.record(request.id, { text: textOf(message), costUsd });
      options.budget.charge('judge', costUsd);
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) throw error;
      failures++;
    }
  });
  if (failures > 0)
    options.log(`  ${failures} judge requests failed, judged again on the next run`);
}

/** Waits for a batch to end and records its succeeded replies. */
async function collect(batch: StoredBatch, options: JudgeOptions): Promise<void> {
  let status = await options.client.messages.batches.retrieve(batch.id);
  while (status.processing_status !== 'ended') {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 30_000));
    status = await options.client.messages.batches.retrieve(batch.id);
  }
  for await (const item of await options.client.messages.batches.results(batch.id)) {
    const requestId = batch.requests[item.custom_id];
    if (!requestId || item.result.type !== 'succeeded' || options.store.replies.has(requestId)) {
      continue;
    }
    const { usage } = item.result.message;
    const costUsd = callCost(usage.input_tokens, usage.output_tokens, true);
    options.store.record(requestId, { text: textOf(item.result.message), costUsd });
    options.budget.charge('judge', costUsd);
  }
  options.store.closeBatch(batch.id);
}

async function batched(requests: readonly JudgeRequest[], options: JudgeOptions): Promise<void> {
  for (let start = 0; start < requests.length; start += BATCH_SIZE) {
    const chunk = requests.slice(start, start + BATCH_SIZE);
    const byCustomId = new Map(chunk.map((request, index) => [`j${index}`, request]));
    const created = await options.client.messages.batches.create({
      requests: [...byCustomId].map(([customId, request]) => ({
        custom_id: customId,
        params: params(request),
      })),
    });
    const batch: StoredBatch = {
      id: created.id,
      requests: Object.fromEntries(
        [...byCustomId].map(([customId, request]) => [customId, request.id])
      ),
      done: false,
    };
    options.store.addBatch(batch);
    options.log(`  judge batch ${created.id}: ${chunk.length} requests`);
    await collect(batch, options);
  }
}

/** The requests of `requests`, in order, whose estimated cost fits what the budget has left. */
function affordable(
  requests: readonly JudgeRequest[],
  options: JudgeOptions,
  batch: boolean
): { requests: JudgeRequest[]; estimate: number } {
  const available = options.budget.availableUsd;
  let estimate = 0;
  let fitting = 0;
  for (const request of requests) {
    const cost = callCost(Math.ceil(request.prompt.length / 3.5), request.maxTokens, batch);
    if (estimate + cost > available) break;
    estimate += cost;
    fitting++;
  }
  return { requests: requests.slice(0, fitting), estimate };
}

/** Sends what the budget covers of `requests`, returning whether it covered them all. */
async function within(
  requests: readonly JudgeRequest[],
  options: JudgeOptions,
  batch: boolean
): Promise<boolean> {
  const fit = affordable(requests, options, batch);
  if (fit.requests.length < requests.length) {
    options.log(`  the budget covers ${fit.requests.length} of ${requests.length} judge requests`);
  }
  if (fit.requests.length === 0) return false;
  const release = options.budget.reserve(fit.estimate);
  try {
    if (batch) await batched(fit.requests, options);
    else await direct(fit.requests, options);
  } finally {
    release();
  }
  return fit.requests.length === requests.length;
}

/**
 * Gets the judge's reply to every request in `requests` into `options.store`: first from
 * batches an earlier run left open, then as Message Batches when `batch` is set, with any
 * request a batch did not answer sent again one by one at full price. A request that still fails
 * stays without a reply, so its answer stays unjudged for the next run. Each step sends what the
 * budget left covers at its own price, and when that is not every request the budget's refusal
 * is thrown after them. The run's judge spending is first brought up to what the stored replies
 * cost, so a reply stored by a run killed before its charge reached the ledger still counts.
 */
export async function judge(
  requests: readonly JudgeRequest[],
  options: JudgeOptions
): Promise<void> {
  options.budget.reconcile('judge', options.store.costUsd);
  for (const batch of options.store.openBatches) {
    options.log(`  collecting judge batch ${batch.id} from an earlier run`);
    await collect(batch, options);
  }
  const missing = () => requests.filter((request) => !options.store.replies.has(request.id));
  if (missing().length === 0) return;
  if (options.batch && !(await within(missing(), options, true))) {
    throw options.budget.refusal();
  }
  const rest = missing();
  if (rest.length === 0) return;
  if (options.batch) options.log(`  ${rest.length} judge requests again one by one`);
  if (!(await within(rest, options, false))) throw options.budget.refusal();
}
