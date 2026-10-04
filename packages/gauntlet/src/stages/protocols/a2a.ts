import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  A2AClient,
  A2AError,
  A2AServer,
  type A2AStreamEvent,
  type A2ATask,
} from '@cogitator-ai/a2a';
import { a2aHono } from '@cogitator-ai/a2a/hono';
import { Agent, tool } from '@cogitator-ai/core';
import { getRequestListener } from '@hono/node-server';
import { z } from 'zod';
import type { StageDefinition } from '../../runner/types.js';
import {
  A2A,
  CORE,
  TYPES,
  assertCalled,
  calledTools,
  closeServer,
  excerpt,
  listen,
} from './shared.js';

/** Facts about a lighthouse that does not exist, so verdicts can only come from the registry. */
const REGISTRY = {
  name: 'Vell Island lighthouse',
  firstLit: 1893,
  designer: 'Maren Olsby',
  heightMeters: 41,
};

/** Text of the text parts in a task's artifacts, or only in its latest one. */
function artifactText(task: A2ATask, latestOnly = false): string {
  const artifacts = latestOnly ? task.artifacts.slice(-1) : task.artifacts;
  return artifacts
    .flatMap((artifact) => artifact.parts)
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n');
}

/**
 * A fact checker served over A2A behind Hono on Node with bearer auth and a signed card, called by a
 * plain client, streamed, continued, and used as a remote tool by an agent on another vendor.
 */
export const a2aStage: StageDefinition = {
  id: 'a2a',
  title: 'A2A fact checker',
  description:
    'A fact-checking agent is served over A2A, discovered by its signed card, called, streamed, continued and used as a remote tool by another agent.',
  packages: [A2A, CORE, TYPES],
  needs: ['handshake'],
  timeoutMs: 180_000,
  async run(ctx) {
    const token = randomUUID();
    const secret = randomUUID();
    let registryCalls = 0;

    const registry = tool({
      name: 'lighthouse_registry',
      description: 'The official registry record of the Vell Island lighthouse.',
      parameters: z.object({ field: z.enum(['firstLit', 'designer', 'heightMeters', 'all']) }),
      execute: async ({ field }) => {
        registryCalls++;
        return field === 'all' ? REGISTRY : { [field]: REGISTRY[field] };
      },
    });

    const factChecker = new Agent({
      name: 'fact-checker',
      description: 'Checks claims about the Vell Island lighthouse against the official registry.',
      model: ctx.model,
      instructions:
        'You check claims about the Vell Island lighthouse. Always consult lighthouse_registry first. Start your reply with TRUE or FALSE, then give the registry value in one short sentence.',
      tools: [registry],
      maxIterations: 4,
    });

    const port = await ctx.freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const a2a = new A2AServer({
      agents: { 'fact-checker': factChecker },
      cogitator: ctx.cogitator,
      cardUrl: `${baseUrl}/a2a`,
      auth: {
        type: 'bearer',
        validate: async (presented) => (presented === token ? { userId: 'gauntlet' } : false),
      },
      cardSigning: { algorithm: 'hmac-sha256', secret },
    });

    await ctx.check('server mounts on Hono', async (evidence) => {
      const app = a2aHono(a2a);
      const server = createServer(getRequestListener(app.fetch));
      await listen(server, port);
      ctx.onCleanup(() => closeServer(server));
      evidence('url', baseUrl);
      evidence('basePath', a2a.basePath);
    });

    const client = new A2AClient(baseUrl, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 90_000,
    });

    const card = await ctx.check('signed agent card is discovered', async (evidence) => {
      const card = await client.agentCard();
      evidence('name', card.name);
      evidence(
        'skills',
        card.skills.map((skill) => skill.id)
      );
      evidence('capabilities', card.capabilities);
      evidence('securitySchemes', Object.keys(card.securitySchemes ?? {}));
      if (card.name !== 'fact-checker') throw new Error(`Wrong card name: ${card.name}`);
      if (!card.skills.some((skill) => skill.id === 'lighthouse_registry')) {
        throw new Error('The card does not list the agent tool as a skill');
      }
      if (!card.capabilities.streaming) throw new Error('Streaming is not advertised');
      if (!card.securitySchemes || Object.keys(card.securitySchemes).length === 0) {
        throw new Error('Bearer auth is not advertised on the card');
      }
      const valid = await client.verifyAgentCard(secret);
      const forged = await client.verifyAgentCard('not-the-secret');
      evidence('signatureValid', valid);
      evidence('wrongSecretAccepted', forged);
      if (!valid || forged) throw new Error('Card signature verification is wrong');
      return card;
    });

    await ctx.check('request without a token is refused', async (evidence) => {
      const anonymous = new A2AClient(baseUrl, { timeout: 10_000 });
      try {
        await anonymous.sendMessage({ role: 'user', parts: [{ type: 'text', text: 'hello' }] });
      } catch (error) {
        evidence('error', error instanceof Error ? error.message : String(error));
        if (error instanceof A2AError) evidence('code', error.code);
        if (!(error instanceof A2AError) || error.code !== -32000) {
          throw new Error('Expected A2A error -32000 Unauthorized', { cause: error });
        }
        return;
      }
      throw new Error('An unauthenticated message was accepted');
    });

    const task = await ctx.check('message/send completes with an artifact', async (evidence) => {
      const before = registryCalls;
      const task = await client.sendMessage(
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'Claim: the Vell Island lighthouse was first lit in 1887.' },
          ],
        },
        undefined,
        { signal: ctx.signal }
      );
      const text = artifactText(task);
      evidence('taskId', task.id);
      evidence('state', task.status.state);
      evidence('artifacts', task.artifacts.length);
      evidence('registryCalls', registryCalls - before);
      evidence('verdict', excerpt(text));
      if (task.status.state !== 'completed') {
        throw new Error(`Task ended ${task.status.state}: ${task.status.message ?? ''}`);
      }
      if (registryCalls === before)
        throw new Error('The fact checker never consulted its registry');
      if (!/false/i.test(text) || !text.includes('1893')) {
        throw new Error('The verdict is not FALSE with the registry year');
      }
      return task;
    });

    await ctx.check('task is readable and listed', async (evidence) => {
      const fetched = await client.getTask(task.id);
      const listed = await client.listTasks({ contextId: task.contextId });
      evidence('fetchedState', fetched.status.state);
      evidence('history', fetched.history.length);
      evidence(
        'listed',
        listed.map((entry) => entry.id)
      );
      if (fetched.status.state !== 'completed') throw new Error('tasks/get lost the final state');
      if (!listed.some((entry) => entry.id === task.id))
        throw new Error('tasks/list misses the task');
    });

    await ctx.check('follow-up continues the same task', async (evidence) => {
      const followUp = await client.continueTask(
        task.id,
        'Claim: the lighthouse was designed by Maren Olsby.',
        undefined,
        { signal: ctx.signal }
      );
      const text = artifactText(followUp, true);
      evidence('state', followUp.status.state);
      evidence('sameTask', followUp.id === task.id);
      evidence('sameContext', followUp.contextId === task.contextId);
      evidence('history', followUp.history.length);
      evidence('artifacts', followUp.artifacts.length);
      evidence('verdict', excerpt(text));
      if (followUp.status.state !== 'completed')
        throw new Error(`Follow-up ended ${followUp.status.state}`);
      if (followUp.contextId !== task.contextId) throw new Error('The follow-up left the context');
      if (followUp.history.length <= task.history.length) throw new Error('History did not grow');
      if (!/true/i.test(text)) throw new Error('The follow-up verdict is not TRUE');
    });

    await ctx.check(
      'message/stream emits tokens, artifact, then final status',
      async (evidence) => {
        const events: A2AStreamEvent[] = [];
        for await (const event of client.sendMessageStream(
          {
            role: 'user',
            parts: [{ type: 'text', text: 'Claim: the Vell Island lighthouse is 41 meters tall.' }],
          },
          undefined,
          { signal: ctx.signal }
        )) {
          events.push(event);
        }
        const kinds = events.map((event) => event.type);
        const tokens = events.filter((event) => event.type === 'token').length;
        const lastArtifact = kinds.lastIndexOf('artifact-update');
        const final = events.at(-1);
        evidence('events', events.length);
        evidence('tokens', tokens);
        evidence('order', [...new Set(kinds)]);
        evidence('finalState', final?.type === 'status-update' ? final.status.state : final?.type);
        if (final?.type !== 'status-update' || final.status.state !== 'completed') {
          throw new Error('The stream did not end with a completed status');
        }
        if (lastArtifact < 0 || lastArtifact > events.length - 2) {
          throw new Error('No artifact event before the final status');
        }
        if (tokens === 0) throw new Error('No token events were streamed');
      }
    );

    await ctx.check('remote agent works as a tool for another vendor', async (evidence) => {
      const before = registryCalls;
      const remote = client.asToolFromCard(card, { name: 'fact_checker', timeout: 90_000 });
      const editor = new Agent({
        name: 'editor',
        model: ctx.models[1] ?? ctx.model,
        instructions:
          'You edit articles. Before stating any fact about the Vell Island lighthouse, verify it with the fact_checker tool, then report the verified year in one sentence.',
        tools: [remote],
        maxIterations: 4,
      });
      const run = await ctx.cogitator.run(editor, {
        input:
          'Our draft says the Vell Island lighthouse was first lit in 1901. Is that right? Give the correct year.',
        signal: ctx.signal,
      });
      evidence('model', editor.model);
      evidence('toolCalls', calledTools(run));
      evidence('remoteRegistryCalls', registryCalls - before);
      evidence('output', excerpt(run.output));
      assertCalled(run, 'fact_checker');
      if (registryCalls === before) throw new Error('The remote agent never ran its registry tool');
      if (!run.output.includes('1893'))
        throw new Error('The editor did not report the registry year');
    });
  },
};
