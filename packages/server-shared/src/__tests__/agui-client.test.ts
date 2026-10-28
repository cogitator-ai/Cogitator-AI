import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpAgent } from '@ag-ui/client';
import type { RunInterrupt, RunResult } from '@cogitator-ai/types';
import { conformancePausedResult, conformanceRunResult, encodeSSE } from '../index';
import {
  parseAGUIRunInput,
  streamAGUIRun,
  type AGUIResumeOptions,
  type AGUIRunHost,
  type AGUIRunOptions,
} from '../agui/index';

const question: RunInterrupt = {
  id: 'q1',
  kind: 'input',
  reason: 'pick_size',
  message: 'Which size?',
  toolCallId: 'c2',
  toolName: 'ask_size',
  responseSchema: { type: 'string', enum: ['S', 'M'] },
};

/** A Cogitator stand-in: the first run asks a question, the resume answers with it */
class FakeRuntime {
  readonly runs: AGUIRunOptions[] = [];
  readonly resumes: AGUIResumeOptions[] = [];
  paused: RunInterrupt[] | undefined;
  cancelled: string[] = [];

  host(threadId: string): AGUIRunHost {
    return {
      run: async (options) => {
        this.runs.push(options);
        options.onToken('Let me check the sizes. ');
        options.onToolCall({ id: 'c2', name: 'ask_size', arguments: {} });
        options.onState({ cart: ['shirt'] });
        this.paused = [question];
        return {
          ...conformancePausedResult(threadId),
          reasoning: undefined,
          pendingApprovals: [],
          interrupts: [question],
        } satisfies RunResult;
      },
      resume: async (options) => {
        this.resumes.push(options);
        this.paused = undefined;
        options.onToolResult({ callId: 'c2', name: 'ask_size', result: options.responses?.q1 });
        options.onData({ id: 'order', name: 'order', data: { size: options.responses?.q1 } });
        options.onToken(`Ordered size ${String(options.responses?.q1)}.`);
        return { ...conformanceRunResult(threadId), reasoning: undefined, structured: undefined };
      },
      pausedRun: async () => (this.paused ? { interrupts: this.paused } : undefined),
      cancelPause: async (reason) => {
        this.cancelled.push(reason);
        this.paused = undefined;
        return true;
      },
    };
  }
}

describe('AG-UI HttpAgent against streamAGUIRun', () => {
  const runtime = new FakeRuntime();
  let server: Server;
  let url = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const parsed = parseAGUIRunInput(JSON.parse(raw));
        if (!parsed.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: parsed.message } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const client = new AbortController();
        void streamAGUIRun({
          request: parsed.value,
          host: runtime.host(parsed.value.input.threadId),
          send: (event) => res.write(encodeSSE(event)),
          signal: client.signal,
          describeError: (error) => ({
            status: 500,
            message: error instanceof Error ? error.message : String(error),
            code: 'INTERNAL',
          }),
        }).finally(() => res.end());
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/agui`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('runs, pauses on a question, and resumes all interrupts at once', async () => {
    const agent = new HttpAgent({ url, threadId: 'thread_agui', initialState: { cart: [] } });
    agent.addMessage({ id: 'u1', role: 'user', content: 'Order a shirt' });

    const first = await agent.runAgent({ context: [{ description: 'Locale', value: 'en-GB' }] });
    expect(runtime.runs[0]).toMatchObject({
      input: 'Order a shirt',
      threadId: 'thread_agui',
      brief: 'Locale: en-GB',
      state: { cart: [] },
      stream: true,
    });
    expect(first.newMessages.map((message) => message.role)).toEqual(['assistant']);
    expect(agent.state).toEqual({ cart: ['shirt'] });
    expect(agent.pendingInterrupts).toEqual([
      expect.objectContaining({ id: 'q1', reason: 'pick_size', message: 'Which size?' }),
    ]);

    const second = await agent.runAgent({
      resume: [{ interruptId: 'q1', status: 'resolved', payload: 'M' }],
    });
    expect(runtime.resumes[0]?.responses).toEqual({ q1: 'M' });
    expect(agent.pendingInterrupts).toEqual([]);
    const roles = second.newMessages.map((message) => message.role);
    expect(roles).toContain('tool');
    expect(roles).toContain('activity');
    const answer = second.newMessages.find((message) => message.role === 'assistant');
    expect(answer && 'content' in answer && answer.content).toContain('Ordered size M.');
    const activity = second.newMessages.find((message) => message.role === 'activity');
    expect(activity && 'content' in activity && activity.content).toEqual({ size: 'M' });
  });

  it('ends the pause when the client cancels a question', async () => {
    const agent = new HttpAgent({ url, threadId: 'thread_cancel' });
    agent.addMessage({ id: 'u1', role: 'user', content: 'Order a hat' });
    await agent.runAgent();
    expect(agent.pendingInterrupts).toHaveLength(1);
    await agent.runAgent({ resume: [{ interruptId: 'q1', status: 'cancelled' }] });
    expect(runtime.cancelled).toEqual(['cancelled from the client']);
    expect(agent.pendingInterrupts).toEqual([]);
  });

  it('answers a request without a user message last with 400', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 't', runId: 'r', messages: [], tools: [], context: [] }),
    });
    expect(response.status).toBe(400);
  });
});
