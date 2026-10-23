import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type { Message, Tool, ToolCall } from '@cogitator-ai/types';
import { Cogitator } from '../cogitator';
import { Agent } from '../agent';
import { tool } from '../tool';
import { rankTools, toolsFoundIn, withIdentifierWords } from '../tools/tool-search';

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, arguments: args };
}

function deferredTool(name: string, description: string, parameters = z.object({})): Tool {
  return tool({
    name,
    description,
    parameters,
    deferred: true,
    execute: async () => `${name} ran`,
  });
}

const sendEmail = deferredTool(
  'sendEmail',
  'Send a message to an address',
  z.object({ recipient: z.string().describe('Mailbox to deliver to'), body: z.string() })
);
const createInvoice = deferredTool(
  'create_invoice',
  'Bill a customer',
  z.object({ amount: z.number().describe('Total in cents') })
);
const lookupWeather = deferredTool('lookup_weather', 'Forecast for a city');
const calendar = deferredTool('listCalendarEvents', 'Upcoming meetings');
const ping = tool({
  name: 'ping',
  description: 'Check the connection',
  parameters: z.object({}),
  execute: async () => 'pong',
});

const allDeferred = [sendEmail, createInvoice, lookupWeather, calendar];

function toolNames(request: { tools?: { name: string }[] } | undefined): string[] {
  return (request?.tools ?? []).map((t) => t.name).sort();
}

describe('withIdentifierWords', () => {
  it('splits camelCase, PascalCase acronyms, snake_case and kebab-case, keeping the original', () => {
    expect(withIdentifierWords('readFile')).toBe('readFile read File');
    expect(withIdentifierWords('HTTPServer')).toBe('HTTPServer HTTP Server');
    expect(withIdentifierWords('send_email-now')).toBe('send_email-now send email now');
    expect(withIdentifierWords('plain words')).toBe('plain words');
  });
});

describe('rankTools', () => {
  it('ranks by name, description and parameters, with identifiers split', () => {
    expect(rankTools(allDeferred, 'email', 3)[0]?.name).toBe('sendEmail');
    expect(rankTools(allDeferred, 'calendar events', 3)[0]?.name).toBe('listCalendarEvents');
    expect(rankTools(allDeferred, 'mailbox', 3)[0]?.name).toBe('sendEmail');
    expect(rankTools(allDeferred, 'cents', 3)[0]?.name).toBe('create_invoice');
    expect(rankTools(allDeferred, 'forecast city', 3)[0]?.name).toBe('lookup_weather');
  });

  it('finds a tool named exactly first and finds nothing for unrelated words', () => {
    expect(rankTools(allDeferred, 'lookup_weather', 1).map((t) => t.name)).toEqual([
      'lookup_weather',
    ]);
    expect(rankTools(allDeferred, 'zebra', 5)).toEqual([]);
  });

  it('keeps to the limit', () => {
    expect(rankTools(allDeferred, 'send bill forecast meetings', 2)).toHaveLength(2);
  });
});

describe('toolsFoundIn', () => {
  it('reads the loaded tools from tool_search results', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [call('t1', 'tool_search', { query: 'x' })],
      } as Message,
      {
        role: 'tool',
        toolCallId: 't1',
        content: JSON.stringify({ tools: [{ name: 'sendEmail', description: 'd' }], note: 'n' }),
      },
      {
        role: 'tool',
        toolCallId: 'other',
        name: 'fetch',
        content: JSON.stringify({ tools: [{ name: 'no', description: '' }], note: '' }),
      },
    ];
    expect([...toolsFoundIn(messages)]).toEqual(['sendEmail']);
  });
});

describe('deferred tools in a run', () => {
  it('sends no deferred schema before a search, and the found ones from the next turn on', async () => {
    const backend = new MockLLMBackend().setResponses([
      { toolCalls: [call('t1', 'tool_search', { query: 'send an email' })] },
      { toolCalls: [call('e1', 'sendEmail', { recipient: 'a@b.c', body: 'hi' })] },
      { content: 'Sent.' },
    ]);
    const cog = new Cogitator({ llm: { backends: { mock: backend }, retry: false } });
    const agent = new Agent({
      name: 'assistant',
      model: 'mock/scripted',
      instructions: 'Help.',
      tools: [ping, ...allDeferred],
    });

    const result = await cog.run(agent, { input: 'Email a@b.c' });

    const [first, second, third] = backend.getCalls();
    expect(toolNames(first)).toEqual(['ping', 'tool_search']);
    expect(toolNames(second)).toContain('sendEmail');
    expect(toolNames(second)).not.toContain('create_invoice');
    expect(toolNames(third)).toContain('sendEmail');
    const found = JSON.parse(String(result.messages.find((m) => m.toolCallId === 't1')?.content));
    expect(found.tools[0]).toEqual({
      name: 'sendEmail',
      description: 'Send a message to an address',
    });
    expect(found.note).toContain('next turn');
    expect(result.output).toBe('Sent.');
    await cog.close();
  });

  it('offers no tool_search when no tool is deferred', async () => {
    const backend = new MockLLMBackend().setResponse({ content: 'Hi.' });
    const cog = new Cogitator({ llm: { backends: { mock: backend }, retry: false } });
    await cog.run(new Agent({ name: 'a', model: 'mock/m', instructions: 'x', tools: [ping] }), {
      input: 'hi',
    });
    expect(toolNames(backend.getLastCall())).toEqual(['ping']);
    await cog.close();
  });

  it('runs a call to a deferred tool that was not loaded', async () => {
    const backend = new MockLLMBackend().setResponses([
      { toolCalls: [call('w1', 'lookup_weather', {})] },
      { content: 'Sunny.' },
    ]);
    const cog = new Cogitator({ llm: { backends: { mock: backend }, retry: false } });
    const results: (string | undefined)[] = [];
    await cog.run(
      new Agent({ name: 'a', model: 'mock/m', instructions: 'x', tools: allDeferred }),
      { input: 'weather?', onToolResult: (r) => results.push(r.error ?? String(r.result)) }
    );
    expect(results).toEqual(['lookup_weather ran']);
    await cog.close();
  });

  it('keeps tools loaded by a search in the history the run goes on from', async () => {
    const history: Message[] = [
      { role: 'user', content: 'find the invoice tool' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [call('t0', 'tool_search', { query: 'invoice' })],
      } as Message,
      {
        role: 'tool',
        toolCallId: 't0',
        name: 'tool_search',
        content: JSON.stringify({
          tools: [{ name: 'create_invoice', description: 'Bill a customer' }],
          note: 'These tools are loaded: call them from your next turn.',
        }),
      },
      { role: 'assistant', content: 'Found it.' },
    ];
    const backend = new MockLLMBackend().setResponse({ content: 'Ok.' });
    const cog = new Cogitator({ llm: { backends: { mock: backend }, retry: false } });
    await cog.run(
      new Agent({ name: 'a', model: 'mock/m', instructions: 'x', tools: allDeferred }),
      { input: 'bill them', history }
    );
    expect(toolNames(backend.getLastCall())).toEqual(['create_invoice', 'tool_search']);
    await cog.close();
  });

  it('keeps found tools loaded across a pause and resume', async () => {
    const approved = deferredTool('wire_money', 'Send money to an account');
    approved.requiresApproval = true;
    const backend = new MockLLMBackend().setResponses([
      { toolCalls: [call('t1', 'tool_search', { query: 'money' })] },
      { toolCalls: [call('m1', 'wire_money', {})] },
      { content: 'Wired.' },
    ]);
    const cog = new Cogitator({ llm: { backends: { mock: backend }, retry: false } });
    const agent = new Agent({
      name: 'bank',
      model: 'mock/m',
      instructions: 'x',
      tools: [approved, lookupWeather],
    });

    const paused = await cog.run(agent, {
      input: 'pay',
      threadId: 'thread_pay',
      onApproval: () => 'pause',
    });
    expect(paused.status).toBe('paused');

    const resumed = await cog.resume(agent, paused.checkpoint!, {
      decisions: { m1: { approved: true } },
    });
    expect(resumed.output).toBe('Wired.');
    expect(toolNames(backend.getLastCall())).toEqual(['tool_search', 'wire_money']);
    await cog.close();
  });

  it('sends a deferred tool the run forces with toolChoice', async () => {
    const backend = new MockLLMBackend().setResponses([
      { toolCalls: [call('w1', 'lookup_weather', {})] },
      { content: 'Sunny.' },
    ]);
    const cog = new Cogitator({ llm: { backends: { mock: backend }, retry: false } });
    await cog.run(
      new Agent({ name: 'a', model: 'mock/m', instructions: 'x', tools: allDeferred }),
      { input: 'weather', toolChoice: { type: 'function', function: { name: 'lookup_weather' } } }
    );
    expect(toolNames(backend.getCalls()[0])).toEqual(['lookup_weather', 'tool_search']);
    await cog.close();
  });
});
