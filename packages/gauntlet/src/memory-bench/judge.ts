import Anthropic from '@anthropic-ai/sdk';
import { BENCH_MODEL, Budget, callCost } from './budget.js';
import { mapConcurrent } from './runner.js';
import type { JudgeRequest } from './scoring.js';

/** What the judge said to one request. */
export interface JudgeReply {
  text: string;
  costUsd: number;
}

export interface JudgeOptions {
  client: Anthropic;
  /** Send the requests as Message Batches (half price, minutes to hours) instead of one by one */
  batch: boolean;
  budget: Budget;
  concurrency: number;
  log(line: string): void;
  /** How often a batch is checked (default 30 s) */
  pollMs?: number;
}

/** Requests a batch holds at most here; the API takes up to 100 000. */
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

async function direct(
  requests: readonly JudgeRequest[],
  options: JudgeOptions,
  replies: Map<string, JudgeReply>
): Promise<void> {
  await mapConcurrent(requests, options.concurrency, async (request) => {
    const message = await options.client.messages.create(params(request));
    const costUsd = callCost(message.usage.input_tokens, message.usage.output_tokens);
    options.budget.charge('judge', costUsd);
    replies.set(request.id, { text: textOf(message), costUsd });
  });
}

async function batched(
  requests: readonly JudgeRequest[],
  options: JudgeOptions,
  replies: Map<string, JudgeReply>
): Promise<JudgeRequest[]> {
  const failed: JudgeRequest[] = [];
  for (let start = 0; start < requests.length; start += BATCH_SIZE) {
    const chunk = requests.slice(start, start + BATCH_SIZE);
    const byCustomId = new Map(chunk.map((request, index) => [`j${start + index}`, request]));
    const batch = await options.client.messages.batches.create({
      requests: [...byCustomId].map(([customId, request]) => ({
        custom_id: customId,
        params: params(request),
      })),
    });
    options.log(`  judge batch ${batch.id}: ${chunk.length} requests`);
    let status = batch;
    while (status.processing_status !== 'ended') {
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 30_000));
      status = await options.client.messages.batches.retrieve(batch.id);
    }
    for await (const item of await options.client.messages.batches.results(batch.id)) {
      const request = byCustomId.get(item.custom_id);
      if (!request) continue;
      if (item.result.type !== 'succeeded') {
        failed.push(request);
        continue;
      }
      const { usage } = item.result.message;
      const costUsd = callCost(usage.input_tokens, usage.output_tokens, true);
      options.budget.charge('judge', costUsd);
      replies.set(request.id, { text: textOf(item.result.message), costUsd });
    }
    for (const request of chunk) {
      if (!replies.has(request.id) && !failed.includes(request)) failed.push(request);
    }
  }
  return failed;
}

/**
 * The judge's replies to `requests`, by request id: as Message Batches when `batch` is set, with
 * any request a batch did not answer sent again one by one.
 */
export async function judge(
  requests: readonly JudgeRequest[],
  options: JudgeOptions
): Promise<Map<string, JudgeReply>> {
  const replies = new Map<string, JudgeReply>();
  if (requests.length === 0) return replies;
  const estimate = requests.reduce(
    (sum, request) =>
      sum + callCost(Math.ceil(request.prompt.length / 3.5), request.maxTokens, options.batch),
    0
  );
  options.budget.reserve(estimate);
  const rest = options.batch ? await batched(requests, options, replies) : [...requests];
  if (rest.length > 0) {
    if (options.batch) options.log(`  ${rest.length} judge requests again one by one`);
    await direct(rest, options, replies);
  }
  return replies;
}
