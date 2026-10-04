import { randomUUID } from 'node:crypto';
import {
  cogitatorModel,
  createCogitatorProvider,
  fromAISDK,
  fromAISDKTool,
} from '@cogitator-ai/ai-sdk';
import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { createAgentHandler, createChatHandler, createResumeHandler } from '@cogitator-ai/next';
import { createOpenAIServer } from '@cogitator-ai/openai-compat';
import { Output, generateText, streamText, tool as aiTool } from 'ai';
import OpenAI from 'openai';
import { z } from 'zod';
import type { StageContext, StageDefinition } from '../runner/types.js';
import {
  startExpress,
  startFastify,
  startHonoNode,
  startKoa,
  type AdapterSetup,
} from './servers/adapters.js';
import {
  LOCKER,
  LOCKER_QUESTION,
  SERVER_AGENT,
  SERVER_AGENT_INSTRUCTIONS,
  createServerAgent,
  createServerAgents,
  lockerCode,
  mentionsLockerCode,
} from './servers/agent.js';
import {
  SHARED_ERRORS,
  TETSU_ERRORS,
  checkInputValidation,
  checkLongRun,
  probeServer,
  transcriptDifferences,
  type Agreement,
  type ServerTarget,
  type ServerTranscript,
} from './servers/probe.js';
import { serverFixture, startChildServer } from './servers/process.js';
import { readSse, validateAgentStream } from './servers/sse.js';

const SERVER_SHARED = '@cogitator-ai/server-shared';
const CORE = '@cogitator-ai/core';

/** Awaits every task, then rethrows the first failure, so parallel checks all get recorded. */
async function settleAll<T>(tasks: Promise<T>[]): Promise<T[]> {
  const outcomes = await Promise.allSettled(tasks);
  const failure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failure) throw failure.reason;
  return outcomes.map((outcome) => (outcome as PromiseFulfilledResult<T>).value);
}

function setupFor(ctx: StageContext): AdapterSetup {
  return { cogitator: ctx.cogitator, agents: createServerAgents(ctx.model) };
}

async function expectAgreement(
  ctx: StageContext,
  name: string,
  transcripts: ServerTranscript[],
  agreement: Agreement
): Promise<void> {
  await ctx.check(name, (evidence) => {
    const differences = transcriptDifferences(transcripts, agreement);
    evidence(
      'servers',
      transcripts.map((transcript) => transcript.label)
    );
    evidence('streamTypes', transcripts[0]?.stream.types);
    evidence(
      'runKeys',
      Object.fromEntries(transcripts.map((t) => [t.label, t.run.keys.join(',')]))
    );
    evidence('differences', differences);
    if (differences.length > 0) throw new Error(differences.join('\n'));
  });
}

/** Every Node adapter at once, the same requests to each, and the answers compared. */
const serverAdapters: StageDefinition = {
  id: 'server-adapters',
  title: 'Server adapters',
  description:
    'Express, Fastify, Hono and Koa serve the same agent side by side and answer the same requests with the same shared protocol.',
  packages: [
    '@cogitator-ai/express',
    '@cogitator-ai/fastify',
    '@cogitator-ai/hono',
    '@cogitator-ai/koa',
    SERVER_SHARED,
    CORE,
  ],
  needs: ['handshake'],
  timeoutMs: 240_000,
  async run(ctx) {
    const setup = setupFor(ctx);
    const targets = await ctx.check('all four adapters listen', async (evidence) => {
      const started = await settleAll([
        startExpress(ctx, setup),
        startFastify(ctx, setup),
        startHonoNode(ctx, setup),
        startKoa(ctx, setup),
      ]);
      for (const target of started) evidence(target.label, target.base);
      return started;
    });
    ctx.log(`Probing ${targets.map((target) => target.label).join(', ')}`);
    const transcripts = await settleAll(targets.map((target) => probeServer(ctx, target)));
    await expectAgreement(ctx, 'adapters answer alike', transcripts, {
      bodies: true,
      runShape: true,
      errors: true,
    });
    await settleAll(
      targets.flatMap((target) => [checkInputValidation(ctx, target), checkLongRun(ctx, target)])
    );
  },
};

/** The Hono adapter in another runtime, compared with the same adapter on Node. */
function honoRuntimeStage(runtime: 'bun' | 'deno'): StageDefinition {
  const command =
    runtime === 'bun'
      ? { command: 'bun', args: ['run', serverFixture('hono-bun.ts')] }
      : {
          command: 'deno',
          args: [
            'run',
            '--no-prompt',
            '--allow-net',
            '--allow-env=OPENROUTER_API_KEY,GAUNTLET_SERVER_MODEL',
            serverFixture('hono-deno.ts'),
          ],
        };
  const name = runtime === 'bun' ? 'Bun' : 'Deno';
  return {
    id: `hono-${runtime}`,
    title: `Hono on ${name}`,
    description: `The Hono adapter serves the same agent on ${name}${
      runtime === 'deno' ? ' with only network and env permissions' : ''
    } and answers like it does on Node.`,
    packages: ['@cogitator-ai/hono', SERVER_SHARED, CORE],
    needs: ['handshake'],
    requires: [{ kind: runtime }],
    timeoutMs: 180_000,
    async run(ctx) {
      const reference = await startHonoNode(ctx, setupFor(ctx));
      const child = await ctx.check(`hono starts on ${name}`, async (evidence) => {
        const server = await startChildServer(ctx, {
          label: `hono@${runtime}`,
          ...command,
          env: { GAUNTLET_SERVER_MODEL: ctx.model },
        });
        evidence('port', server.ready.port);
        evidence('pid', server.pid);
        return server;
      });
      const target: ServerTarget = {
        label: `hono@${runtime}`,
        base: `http://127.0.0.1:${child.ready.port}/cogitator`,
        openapiPath: '/openapi.json',
        dialect: SHARED_ERRORS,
        onUsage: (usage) => ctx.recordUsage(ctx.model, usage),
      };
      try {
        const transcripts = await settleAll([
          probeServer(ctx, reference),
          probeServer(ctx, target),
        ]);
        await expectAgreement(ctx, `${name} answers like Node`, transcripts, {
          bodies: true,
          runShape: true,
          errors: true,
        });
        await settleAll([checkInputValidation(ctx, target), checkLongRun(ctx, target)]);
      } finally {
        const output = child.output().trim();
        if (output) ctx.log(`${name} output: ${output.slice(-600)}`);
      }
    },
  };
}

/** The Tetsu controller on Bun, held to the shared stream protocol. */
const tetsu: StageDefinition = {
  id: 'tetsu',
  title: 'Tetsu on Bun',
  description:
    'The Tetsu controller serves the same agent on Bun and streams the protocol shared with the other adapters.',
  packages: ['@cogitator-ai/tetsu', SERVER_SHARED, CORE],
  needs: ['handshake'],
  requires: [{ kind: 'bun' }],
  timeoutMs: 180_000,
  async run(ctx) {
    const reference = await startHonoNode(ctx, setupFor(ctx));
    const child = await ctx.check('tetsu starts on Bun', async (evidence) => {
      const server = await startChildServer(ctx, {
        label: 'tetsu@bun',
        command: 'bun',
        args: ['run', serverFixture('tetsu-bun.ts')],
        env: { GAUNTLET_SERVER_MODEL: ctx.model },
      });
      evidence('port', server.ready.port);
      return server;
    });
    const target: ServerTarget = {
      label: 'tetsu@bun',
      base: `http://127.0.0.1:${child.ready.port}/cogitator`,
      openapiPath: `http://127.0.0.1:${child.ready.port}/openapi.json`,
      dialect: TETSU_ERRORS,
      onUsage: (usage) => ctx.recordUsage(ctx.model, usage),
    };
    try {
      const transcripts = await settleAll([probeServer(ctx, reference), probeServer(ctx, target)]);
      await expectAgreement(ctx, 'tetsu streams the shared protocol', transcripts, {
        bodies: true,
        runShape: false,
        errors: false,
      });
      await settleAll([checkInputValidation(ctx, target), checkLongRun(ctx, target)]);
    } finally {
      const output = child.output().trim();
      if (output) ctx.log(`Bun output: ${output.slice(-600)}`);
    }
  },
};

function postJson(body: unknown, signal: AbortSignal): Request {
  return new Request('http://localhost/api/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

const RunAnswer = z.object({
  output: z.string(),
  threadId: z.string(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), totalTokens: z.number() }),
  toolCalls: z.array(z.object({ id: z.string(), name: z.string() })),
  trace: z.object({ traceId: z.string(), spans: z.array(z.unknown()) }).optional(),
  status: z.enum(['completed', 'paused']).optional(),
  pendingApprovals: z
    .array(
      z.object({
        toolCallId: z.string(),
        toolName: z.string(),
        arguments: z.record(z.string(), z.unknown()),
      })
    )
    .optional(),
});

/** App Router handlers called with web Requests, no Next server: run, chat stream, approvals. */
const next: StageDefinition = {
  id: 'next',
  title: 'Next.js handlers',
  description:
    'The App Router handlers run an agent, stream a chat, and pause and resume a run for an approval, called with plain web Requests.',
  packages: ['@cogitator-ai/next', CORE],
  needs: ['handshake'],
  timeoutMs: 180_000,
  async run(ctx) {
    const agent = createServerAgent(ctx.model);

    await ctx.check('agent handler answers a run', async (evidence) => {
      const handler = createAgentHandler(ctx.cogitator, agent);
      const response = await handler(postJson({ input: LOCKER_QUESTION }, ctx.signal));
      const raw = await response.text();
      evidence('status', response.status);
      if (response.status !== 200)
        throw new Error(`Expected 200, got ${response.status}: ${raw.slice(0, 200)}`);
      const answer = RunAnswer.parse(JSON.parse(raw));
      evidence('output', answer.output.slice(0, 160));
      evidence(
        'toolCalls',
        answer.toolCalls.map((call) => call.name)
      );
      evidence('spans', answer.trace?.spans.length);
      if (!answer.toolCalls.some((call) => call.name === 'locker_code'))
        throw new Error('locker_code was not called');
      if (!mentionsLockerCode(answer.output))
        throw new Error(`The answer lacks the code: ${answer.output}`);
      if (answer.status !== 'completed') throw new Error(`Status is ${answer.status}`);
    });

    await ctx.check('chat handler streams the protocol', async (evidence) => {
      const handler = createChatHandler(ctx.cogitator, agent);
      const response = await handler(
        postJson({ messages: [{ id: 'm1', role: 'user', content: LOCKER_QUESTION }] }, ctx.signal)
      );
      evidence('status', response.status);
      if (response.status !== 200) throw new Error(`Expected 200, got ${response.status}`);
      const summary = validateAgentStream(await readSse(response));
      const threadId: unknown = Reflect.get(summary.finish, 'threadId');
      evidence('types', summary.types);
      evidence('text', summary.text.slice(0, 160));
      evidence('threadId', threadId);
      if (!summary.toolNames.includes('locker_code'))
        throw new Error('No tool-call-start for locker_code');
      if (!mentionsLockerCode(summary.text))
        throw new Error(`Streamed text lacks the code: ${summary.text}`);
      if (typeof threadId !== 'string' || !threadId) throw new Error('finish carries no threadId');
    });

    await ctx.check('handlers reject bad bodies without calling the model', async (evidence) => {
      const chat = await createChatHandler(
        ctx.cogitator,
        agent
      )(postJson({ messages: [{ role: 'assistant', content: 'hi' }] }, ctx.signal));
      const run = await createAgentHandler(
        ctx.cogitator,
        agent
      )(postJson({ input: '  ' }, ctx.signal));
      const resume = await createResumeHandler(
        ctx.cogitator,
        agent
      )(
        postJson(
          { threadId: `gauntlet-${randomUUID()}`, defaultDecision: { approved: true } },
          ctx.signal
        )
      );
      const resumeBody: unknown = await resume.json();
      evidence('chatWithoutUserMessage', chat.status);
      evidence('blankInput', run.status);
      evidence('resumeUnknownThread', { status: resume.status, body: resumeBody });
      if (chat.status !== 400)
        throw new Error(`Chat without a user message answered ${chat.status}`);
      if (run.status !== 400) throw new Error(`Blank input answered ${run.status}`);
      if (resume.status !== 409 || Reflect.get(Object(resumeBody), 'code') !== 'RUN_NOT_PAUSED') {
        throw new Error(
          `Resume of an unknown thread answered ${resume.status} ${JSON.stringify(resumeBody)}`
        );
      }
    });

    let opened = 0;
    const openLocker = tool({
      name: 'open_locker',
      description: 'Unlocks a locker door. Needs a person to approve.',
      parameters: z.object({ locker: z.string() }),
      requiresApproval: true,
      execute: async ({ locker }) => {
        opened += 1;
        return { locker, open: true };
      },
    });
    const locksmith = new Agent({
      name: 'locksmith',
      model: ctx.model,
      instructions:
        'You open lockers with the open_locker tool when asked. Confirm in one short sentence.',
      tools: [openLocker],
      maxIterations: 3,
    });

    const paused = await ctx.check('a run pauses for approval', async (evidence) => {
      const response = await createAgentHandler(
        ctx.cogitator,
        locksmith
      )(postJson({ input: `Please open locker ${LOCKER}.` }, ctx.signal));
      const answer = RunAnswer.parse(await response.json());
      evidence('status', answer.status);
      evidence(
        'pending',
        answer.pendingApprovals?.map((call) => call.toolName)
      );
      evidence('threadId', answer.threadId);
      if (answer.status !== 'paused')
        throw new Error(`Run did not pause: ${answer.status} ${answer.output}`);
      const pending = answer.pendingApprovals?.find((call) => call.toolName === 'open_locker');
      if (!pending) throw new Error('No pending open_locker call');
      if (opened !== 0) throw new Error('The tool ran before it was approved');
      return { threadId: answer.threadId, toolCallId: pending.toolCallId };
    });

    await ctx.check('resume handler runs the approved call', async (evidence) => {
      const response = await createResumeHandler(
        ctx.cogitator,
        locksmith
      )(
        postJson(
          { threadId: paused.threadId, decisions: { [paused.toolCallId]: { approved: true } } },
          ctx.signal
        )
      );
      const raw = await response.text();
      evidence('httpStatus', response.status);
      if (response.status !== 200)
        throw new Error(`Expected 200, got ${response.status}: ${raw.slice(0, 200)}`);
      const answer = RunAnswer.parse(JSON.parse(raw));
      evidence('status', answer.status);
      evidence('opened', opened);
      evidence('output', answer.output.slice(0, 160));
      if (answer.status !== 'completed') throw new Error(`Resumed run is ${answer.status}`);
      if (opened !== 1) throw new Error(`open_locker ran ${opened} times, expected once`);
    });
  },
};

/** The official OpenAI SDK against Cogitator's Assistants API server. */
const openaiCompat: StageDefinition = {
  id: 'openai-compat',
  title: 'OpenAI-compatible server',
  description:
    'The official OpenAI SDK drives assistants, threads and runs on a Cogitator server: server-side tools, client function calls and streaming.',
  packages: ['@cogitator-ai/openai-compat', CORE],
  needs: ['handshake'],
  timeoutMs: 240_000,
  async run(ctx) {
    const apiKey = `sk-gauntlet-${randomUUID()}`;
    const server = createOpenAIServer(ctx.cogitator, {
      port: await ctx.freePort(),
      host: '127.0.0.1',
      apiKeys: [apiKey],
      tools: [lockerCode],
      defaultModel: ctx.model,
    });
    await server.start();
    ctx.onCleanup(() => server.stop());
    const client = new OpenAI({ baseURL: server.getBaseUrl(), apiKey, maxRetries: 0 });
    const poll = { pollIntervalMs: 300, signal: ctx.signal };

    await ctx.check('API keys guard everything but health', async (evidence) => {
      const health = await fetch(`${server.getUrl()}/health`, { signal: ctx.signal });
      evidence('health', health.status);
      if (health.status !== 200) throw new Error(`/health answered ${health.status}`);
      const intruder = new OpenAI({
        baseURL: server.getBaseUrl(),
        apiKey: 'sk-wrong',
        maxRetries: 0,
      });
      try {
        await intruder.models.list();
      } catch (error) {
        evidence('wrongKey', error instanceof OpenAI.APIError ? error.status : String(error));
        if (error instanceof OpenAI.AuthenticationError) return;
        throw error;
      }
      throw new Error('A wrong API key was accepted');
    });

    await ctx.check('models list the cogitator model', async (evidence) => {
      const ids: string[] = [];
      for await (const model of client.models.list()) ids.push(model.id);
      evidence('models', ids);
      if (!ids.includes('cogitator')) throw new Error('The cogitator model is not listed');
    });

    const thread = await client.beta.threads.create();
    const concierge = await client.beta.assistants.create({
      name: 'concierge',
      model: 'cogitator',
      instructions: SERVER_AGENT_INSTRUCTIONS,
    });
    ctx.onCleanup(async () => {
      await client.beta.assistants.delete(concierge.id).catch(() => undefined);
      await client.beta.threads.delete(thread.id).catch(() => undefined);
    });

    const latestText = async (): Promise<string> => {
      const page = await client.beta.threads.messages.list(thread.id, { limit: 1, order: 'desc' });
      const message = page.data[0];
      if (message?.role !== 'assistant')
        throw new Error(`Latest message is from ${message?.role ?? 'nobody'}`);
      return message.content.map((part) => (part.type === 'text' ? part.text.value : '')).join('');
    };

    await ctx.check('a run uses a server-side Cogitator tool', async (evidence) => {
      await client.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: LOCKER_QUESTION,
      });
      const run = await client.beta.threads.runs.createAndPoll(
        thread.id,
        { assistant_id: concierge.id },
        poll
      );
      const text = await latestText();
      evidence('runId', run.id);
      evidence('status', run.status);
      evidence('usage', run.usage);
      evidence('answer', text.slice(0, 160));
      if (run.status !== 'completed')
        throw new Error(`Run ended ${run.status}: ${run.last_error?.message ?? ''}`);
      if (!mentionsLockerCode(text)) throw new Error(`The answer lacks the code: ${text}`);
    });

    await ctx.check('a function tool round-trips through requires_action', async (evidence) => {
      const clerk = await client.beta.assistants.create({
        name: 'clerk',
        model: 'cogitator',
        instructions:
          'You sell widgets. Always look the unit price up with get_unit_price before quoting.',
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_unit_price',
              description: 'Unit price in USD of a product from the catalog',
              parameters: {
                type: 'object',
                properties: { product: { type: 'string' } },
                required: ['product'],
              },
            },
          },
        ],
      });
      ctx.onCleanup(async () => {
        await client.beta.assistants.delete(clerk.id).catch(() => undefined);
      });
      await client.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: 'How much do 3 widgets cost in total?',
      });
      const first = await client.beta.threads.runs.createAndPoll(
        thread.id,
        { assistant_id: clerk.id },
        poll
      );
      evidence('firstStatus', first.status);
      const calls = first.required_action?.submit_tool_outputs.tool_calls ?? [];
      evidence(
        'requested',
        calls.map((call) => call.function.name)
      );
      if (first.status !== 'requires_action')
        throw new Error(`Run ended ${first.status}, not requires_action`);
      if (!calls.some((call) => call.function.name === 'get_unit_price')) {
        throw new Error('The run did not ask for get_unit_price');
      }
      const done = await client.beta.threads.runs.submitToolOutputsAndPoll(
        first.id,
        {
          thread_id: thread.id,
          tool_outputs: calls.map((call) => ({
            tool_call_id: call.id,
            output: JSON.stringify({ currency: 'USD', unit_price: 19.99 }),
          })),
        },
        poll
      );
      const text = await latestText();
      evidence('finalStatus', done.status);
      evidence('answer', text.slice(0, 160));
      if (done.status !== 'completed') throw new Error(`Run ended ${done.status}`);
      if (!/59[.,]97|19[.,]99/.test(text))
        throw new Error(`The answer ignores the submitted price: ${text}`);
    });

    await ctx.check('a streamed run emits text deltas', async (evidence) => {
      await client.beta.threads.messages.create(thread.id, {
        role: 'user',
        content: `Tell me the door code of locker ${LOCKER} again.`,
      });
      let deltas = 0;
      const stream = client.beta.threads.runs
        .stream(thread.id, { assistant_id: concierge.id }, { signal: ctx.signal })
        .on('textDelta', () => {
          deltas += 1;
        });
      const run = await stream.finalRun();
      const text = await latestText();
      evidence('status', run.status);
      evidence('deltas', deltas);
      evidence('answer', text.slice(0, 160));
      if (run.status !== 'completed') throw new Error(`Streamed run ended ${run.status}`);
      if (deltas === 0) throw new Error('No textDelta events arrived');
      if (!mentionsLockerCode(text)) throw new Error(`The answer lacks the code: ${text}`);
    });
  },
};

const DoorCode = z.object({ locker: z.string(), code: z.string() });

/** Cogitator agents as AI SDK models and back, with ai@7. */
const aiSdk: StageDefinition = {
  id: 'ai-sdk',
  title: 'Vercel AI SDK',
  description:
    'A Cogitator agent serves generateText, streamText and structured output of ai@7, an AI SDK model backs a Cogitator runtime, and an AI SDK tool runs in an agent.',
  packages: ['@cogitator-ai/ai-sdk', CORE],
  needs: ['handshake'],
  timeoutMs: 240_000,
  async run(ctx) {
    const agent = createServerAgent(ctx.model);
    const model = cogitatorModel(ctx.cogitator, agent);

    await ctx.check('the installed ai@7 gets a v4 model', (evidence) => {
      evidence('specificationVersion', model.specificationVersion);
      evidence('provider', model.provider);
      evidence('modelId', model.modelId);
      if (model.specificationVersion !== 'v4') {
        throw new Error(`Detected ${model.specificationVersion}, expected v4 for ai@7`);
      }
    });

    await ctx.check('generateText runs the agent and its tool', async (evidence) => {
      const result = await generateText({
        model,
        prompt: LOCKER_QUESTION,
        abortSignal: ctx.signal,
      });
      const metadata = result.providerMetadata?.cogitator;
      evidence('text', result.text.slice(0, 160));
      evidence(
        'toolCalls',
        result.toolCalls.map((call) => call.toolName)
      );
      evidence('usage', { input: result.usage.inputTokens, output: result.usage.outputTokens });
      evidence('metadataKeys', metadata ? Object.keys(metadata) : []);
      if (!mentionsLockerCode(result.text))
        throw new Error(`The text lacks the code: ${result.text}`);
      if (!result.toolCalls.some((call) => call.toolName === 'locker_code')) {
        throw new Error('The agent tool call is not reported as a provider-executed call');
      }
      if (!result.usage.inputTokens) throw new Error('No input tokens reported');
    });

    await ctx.check('streamText streams the agent answer', async (evidence) => {
      const result = streamText({ model, prompt: LOCKER_QUESTION, abortSignal: ctx.signal });
      let chunks = 0;
      let text = '';
      for await (const chunk of result.textStream) {
        chunks += 1;
        text += chunk;
      }
      const toolCalls = await result.toolCalls;
      evidence('chunks', chunks);
      evidence('text', text.slice(0, 160));
      evidence(
        'toolCalls',
        toolCalls.map((call) => call.toolName)
      );
      if (chunks === 0) throw new Error('No text chunks arrived');
      if (!mentionsLockerCode(text)) throw new Error(`Streamed text lacks the code: ${text}`);
    });

    await ctx.check('a provider agent answers in a schema', async (evidence) => {
      const provider = createCogitatorProvider(ctx.cogitator, { agents: [agent] });
      const result = await generateText({
        model: provider.languageModel(SERVER_AGENT),
        prompt: LOCKER_QUESTION,
        output: Output.object({ schema: DoorCode }),
        abortSignal: ctx.signal,
      });
      evidence('output', result.output);
      const parsed = DoorCode.parse(result.output);
      if (!mentionsLockerCode(parsed.code))
        throw new Error(`Wrong code: ${JSON.stringify(parsed)}`);
    });

    await ctx.check('an AI SDK model backs a Cogitator runtime', async (evidence) => {
      const bridge = new Cogitator({ llm: { backends: { bridge: fromAISDK(model) } } });
      ctx.onCleanup(() => bridge.close());
      const frontDesk = new Agent({
        name: 'front-desk',
        model: `bridge/${SERVER_AGENT}`,
        instructions: 'Answer visitor questions.',
        maxIterations: 2,
      });
      let tokens = 0;
      const run = await bridge.run(frontDesk, {
        input: LOCKER_QUESTION,
        stream: true,
        onToken: () => {
          tokens += 1;
        },
        signal: ctx.signal,
      });
      evidence('output', run.output.slice(0, 160));
      evidence('streamedTokens', tokens);
      evidence('usage', run.usage);
      if (tokens === 0) throw new Error('The wrapped model streamed nothing');
      if (!mentionsLockerCode(run.output))
        throw new Error(`The answer lacks the code: ${run.output}`);
    });

    await ctx.check('an AI SDK tool runs inside a Cogitator agent', async (evidence) => {
      let calls = 0;
      const shiftLead = aiTool({
        description: 'Name of the person leading the current shift at a desk.',
        inputSchema: z.object({ desk: z.string() }),
        execute: async ({ desk }) => {
          calls += 1;
          return { desk, lead: 'Marisol Quintero-Vale' };
        },
      });
      const receptionist = new Agent({
        name: 'receptionist',
        model: ctx.model,
        instructions: 'Look shift leads up with the shift_lead tool. Answer with the name only.',
        tools: [fromAISDKTool(shiftLead, 'shift_lead')],
        maxIterations: 3,
      });
      const run = await ctx.cogitator.run(receptionist, {
        input: 'Who leads the shift at the north desk?',
        signal: ctx.signal,
      });
      evidence(
        'toolCalls',
        run.toolCalls.map((call) => call.name)
      );
      evidence('executions', calls);
      evidence('output', run.output.slice(0, 160));
      if (calls === 0) throw new Error('The converted tool never executed');
      if (!/Quintero/i.test(run.output))
        throw new Error(`The answer ignores the tool: ${run.output}`);
    });
  },
};

export const serverStages: StageDefinition[] = [
  serverAdapters,
  honoRuntimeStage('bun'),
  honoRuntimeStage('deno'),
  tetsu,
  next,
  openaiCompat,
  aiSdk,
];
