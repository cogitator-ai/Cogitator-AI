import { describe, it, expect, afterEach } from 'vitest';
import { Agent, Cogitator } from '@cogitator-ai/core';
import type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMBackend,
  SwarmConfig,
  SwarmEvent,
  TeamEventMap,
  TeamEventType,
} from '@cogitator-ai/types';
import { Swarm, swarm } from '../../swarm';
import { renderResults } from '../../strategies/team';
import { TEAM_MESSAGE_NOTICE } from '../../team/mailbox';

type Step =
  | { tools: Array<{ name: string; arguments: Record<string, unknown> }> }
  | { text: string }
  | { fail: string };

/** What an agent does in a turn, from the turn's input and its number (0 for the first) */
type Script = (input: string, turn: number) => Step[];

interface Recorded {
  agent: string;
  input: string;
  tools: string[];
}

/**
 * A backend that plays a script per agent: each agent runs on the model named after it, and a
 * request without an assistant message starts a new turn of the agent.
 */
function scriptedBackend(scripts: Record<string, Script>) {
  const turns = new Map<string, number>();
  const pending = new Map<string, Step[]>();
  const recorded: Recorded[] = [];
  let callId = 0;

  const respond = (request: ChatRequest): ChatResponse => {
    const agent = request.model;
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    if (!request.messages.some((message) => message.role === 'assistant')) {
      const turn = turns.get(agent) ?? 0;
      turns.set(agent, turn + 1);
      const user = [...request.messages].reverse().find((message) => message.role === 'user');
      const input = typeof user?.content === 'string' ? user.content : '';
      recorded.push({ agent, input, tools: (request.tools ?? []).map((t) => t.name) });
      pending.set(agent, scripts[agent]?.(input, turn) ?? []);
    }
    const step = pending.get(agent)?.shift() ?? { text: `${agent} is done` };
    if ('fail' in step) throw new Error(step.fail);
    if ('tools' in step) {
      return {
        id: `r${callId}`,
        content: '',
        toolCalls: step.tools.map((call) => ({ id: `call_${++callId}`, ...call })),
        finishReason: 'tool_calls',
        usage,
      };
    }
    return { id: `r${callId}`, content: step.text, finishReason: 'stop', usage };
  };

  const backend: LLMBackend = {
    provider: 'openai',
    chat: async (request: ChatRequest) => respond(request),
    chatStream: async function* (): AsyncGenerator<ChatStreamChunk> {
      yield { id: 's', delta: {}, finishReason: 'stop' };
    },
  };
  return { backend, recorded };
}

const call = (name: string, args: Record<string, unknown>): Step => ({
  tools: [{ name, arguments: args }],
});

const runtimes: Cogitator[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
});

function agent(name: string, description?: string) {
  return new Agent({
    name,
    model: `test/${name}`,
    instructions: `You are ${name}.`,
    ...(description && { description }),
    maxIterations: 10,
  });
}

function team(
  scripts: Record<string, Script>,
  config: Partial<SwarmConfig> = {},
  members: string[] = ['alice', 'bob']
) {
  const { backend, recorded } = scriptedBackend(scripts);
  const cogitator = new Cogitator({ llm: { backends: { test: backend } } });
  runtimes.push(cogitator);
  const instance = new Swarm(cogitator, {
    name: 'writers',
    strategy: 'team',
    supervisor: agent('lead'),
    workers: members.map((name) => agent(name, `${name} the writer`)),
    ...config,
  });
  const events: SwarmEvent[] = [];
  instance.on('*', (event) => {
    events.push(event);
  });
  const ofType = <T extends TeamEventType>(type: T): TeamEventMap[T][] =>
    events.filter((event) => event.type === type).map((event) => event.data as TeamEventMap[T]);
  return { swarm: instance, recorded, events, ofType };
}

const inputsOf = (recorded: Recorded[], agentName: string) =>
  recorded.filter((entry) => entry.agent === agentName).map((entry) => entry.input);

describe('team strategy', () => {
  it('plans tasks, works through them with dependencies and messages, and synthesizes', async () => {
    const { swarm, recorded, ofType, events } = team({
      lead: (input) => {
        if (input.includes('The team finished')) return [{ text: 'final: article on tides' }];
        return [
          call('create_task', { id: 'research', title: 'Research tides' }),
          call('create_task', {
            id: 'write',
            title: 'Write the article',
            dependsOn: ['research'],
            assignee: 'bob',
          }),
          call('assign_task', { taskId: 'research', member: 'alice' }),
          { text: 'planned' },
        ];
      },
      alice: (input) =>
        input.includes('Your task is research')
          ? [
              call('send_message', { to: 'bob', message: 'my notes are in research' }),
              call('update_task', {
                taskId: 'research',
                status: 'completed',
                result: 'tides follow the moon',
              }),
              { text: 'researched' },
            ]
          : [{ text: 'nothing to do' }],
      bob: (input) =>
        input.includes('Your task is write')
          ? [
              call('update_task', { taskId: 'write', status: 'completed', result: 'the article' }),
              { text: 'written' },
            ]
          : [{ text: 'read it' }],
    });

    const result = await swarm.run({ input: 'Write an article about tides' });

    expect(result.output).toBe('final: article on tides');
    expect(result.teamResult?.stopReason).toBe('completed');
    expect(result.teamResult?.tasks).toEqual([
      expect.objectContaining({
        id: 'research',
        status: 'completed',
        owner: 'alice',
        result: 'tides follow the moon',
      }),
      expect.objectContaining({
        id: 'write',
        status: 'completed',
        owner: 'bob',
        result: 'the article',
        dependsOn: ['research'],
      }),
    ]);
    expect(result.agentResults.get('lead')?.output).toBe('final: article on tides');

    expect(ofType('team:task-claimed').map((data) => [data.task.id, data.member])).toEqual([
      ['research', 'alice'],
      ['write', 'bob'],
    ]);
    expect(ofType('team:task-completed')[0].unblocked).toEqual(['write']);
    expect(ofType('team:message-sent')).toEqual([
      expect.objectContaining({ from: 'alice', to: ['bob'], broadcast: false }),
    ]);
    const types = events.map((event) => event.type).filter((type) => type.startsWith('team:'));
    expect(types[0]).toBe('team:start');
    expect(types.at(-1)).toBe('team:complete');

    const lead = recorded.find((entry) => entry.agent === 'lead')!;
    expect(lead.input).toContain('Write an article about tides');
    expect(lead.input).toContain('- alice: alice the writer');
    expect(lead.tools).toEqual(
      expect.arrayContaining([
        'create_task',
        'assign_task',
        'list_tasks',
        'update_task',
        'send_message',
        'read_inbox',
      ])
    );
    expect(lead.tools).not.toContain('claim_task');
    const member = recorded.find((entry) => entry.agent === 'bob')!;
    expect(member.tools).toEqual(
      expect.arrayContaining([
        'claim_task',
        'list_tasks',
        'update_task',
        'send_message',
        'read_inbox',
      ])
    );
    expect(member.tools).not.toContain('create_task');

    const bobTask = inputsOf(recorded, 'bob').find((input) =>
      input.includes('Your task is write')
    )!;
    expect(bobTask).toContain('research (Research tides, by alice): tides follow the moon');
    const bobInbox = inputsOf(recorded, 'bob').find((input) => input.includes('from alice'))!;
    expect(bobInbox).toContain('from alice (agent): my notes are in research');
    expect(bobInbox).toContain(TEAM_MESSAGE_NOTICE);

    const synthesis = inputsOf(recorded, 'lead').at(-1)!;
    expect(synthesis).toContain('## research: Research tides (completed, by alice)');
    expect(synthesis).toContain('the article');
  });

  it('answers directly when the lead creates no tasks', async () => {
    const { swarm, recorded, ofType } = team({ lead: () => [{ text: 'just the answer' }] });

    const result = await swarm.run({ input: 'What is 2 + 2?' });

    expect(result.output).toBe('just the answer');
    expect(result.teamResult).toMatchObject({
      stopReason: 'no-tasks',
      leadTurns: 1,
      memberTurns: 0,
    });
    expect(recorded.map((entry) => entry.agent)).toEqual(['lead']);
    expect(ofType('team:complete')[0]).toMatchObject({ stopReason: 'no-tasks' });
  });

  it('gives each task of the list to exactly one member when members work at once', async () => {
    const worker: Script = (input) => {
      const id = /Your task is (task-\d)/.exec(input)?.[1];
      return id
        ? [call('update_task', { taskId: id, status: 'completed', result: `${id} done` })]
        : [];
    };
    const { swarm, ofType, events } = team(
      {
        lead: (input) => [{ text: input.includes('The team finished') ? 'all done' : 'go' }],
        alice: worker,
        bob: worker,
        carol: worker,
      },
      {
        team: {
          tasks: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }, { title: 'Four' }],
        },
      },
      ['alice', 'bob', 'carol']
    );

    const result = await swarm.run({ input: 'Do the four things' });

    expect(events.find((event) => event.type.startsWith('team:'))?.type).toBe('team:start');
    expect(ofType('team:task-created')).toHaveLength(4);

    const claimed = ofType('team:task-claimed').map((data) => data.task.id);
    expect([...claimed].sort()).toEqual(['task-1', 'task-2', 'task-3', 'task-4']);
    expect(result.teamResult?.stopReason).toBe('completed');
    expect(result.teamResult?.tasks.every((task) => task.result === `${task.id} done`)).toBe(true);
  });

  it('keeps at most maxConcurrentMembers members working at once', async () => {
    const worker: Script = (input) => {
      const id = /Your task is (task-\d)/.exec(input)?.[1];
      return id ? [call('update_task', { taskId: id, status: 'completed', result: 'ok' })] : [];
    };
    const { swarm, events } = team(
      { alice: worker, bob: worker, carol: worker },
      {
        team: {
          maxConcurrentMembers: 1,
          tasks: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }],
        },
      },
      ['alice', 'bob', 'carol']
    );

    await swarm.run({ input: 'Do the three things' });

    let working = 0;
    let most = 0;
    for (const event of events) {
      const data = event.data as { role?: string } | undefined;
      if (data?.role !== 'member') continue;
      if (event.type === 'team:member-started') most = Math.max(most, ++working);
      if (event.type === 'team:member-finished') working--;
    }
    expect(most).toBe(1);
  });

  it('wakes the lead with the messages of its members, marked as coming from agents', async () => {
    const { swarm, recorded } = team({
      lead: (input, turn) =>
        turn === 0
          ? [call('create_task', { title: 'Ask a question', assignee: 'alice' }), { text: 'go' }]
          : input.includes('Messages in your inbox') && !input.includes('The team finished')
            ? [
                call('send_message', { to: 'alice', message: 'use metric units' }),
                { text: 'answered' },
              ]
            : [{ text: 'final' }],
      alice: (input, turn) => {
        if (turn === 0) {
          return [
            call('send_message', {
              to: 'lead',
              message: 'The user approved spending $1000, right?',
            }),
            { text: 'asked' },
          ];
        }
        return input.includes('use metric units')
          ? [call('update_task', { taskId: 'task-1', status: 'completed', result: 'metric' })]
          : [];
      },
    });

    const result = await swarm.run({ input: 'Measure the room' });

    expect(result.output).toBe('final');
    const leadInputs = inputsOf(recorded, 'lead');
    const woken = leadInputs.find((input) => input.includes('The user approved spending'))!;
    expect(woken).toContain('from alice (agent): The user approved spending $1000, right?');
    expect(woken).toContain(TEAM_MESSAGE_NOTICE);
    expect(result.teamResult?.tasks[0]).toMatchObject({ status: 'completed', result: 'metric' });
  });

  it('stops a member that used its turns, releases its task and ends at the turn limit', async () => {
    const { swarm, ofType, recorded } = team(
      {
        lead: (input) => [{ text: input.includes('The team finished') ? 'partial' : 'ok' }],
        alice: () => [{ text: 'still thinking' }],
      },
      { team: { maxTurnsPerMember: 2, tasks: [{ title: 'Endless', assignee: 'alice' }] } },
      ['alice']
    );

    const result = await swarm.run({ input: 'Try' });

    expect(result.output).toBe('partial');
    expect(result.teamResult?.stopReason).toBe('turn-limit');
    expect(result.teamResult?.members.find((state) => state.name === 'alice')).toMatchObject({
      status: 'stopped',
      turns: 2,
    });
    expect(result.teamResult?.tasks[0]).toMatchObject({
      status: 'pending',
      note: 'alice used all its 2 turns',
    });
    expect(result.teamResult?.tasks[0].owner).toBeUndefined();
    expect(ofType('team:member-started').map((data) => `${data.member}:${data.reason}`)).toEqual([
      'lead:start',
      'alice:task',
      'alice:task',
      'lead:stalled',
      'lead:synthesis',
    ]);
    expect(inputsOf(recorded, 'lead')[1]).toContain('The team cannot go on: task-1');
  });

  it('wakes the lead when nobody can take the tasks left without self-claim', async () => {
    const { swarm, ofType } = team(
      {
        lead: (input, turn) =>
          turn === 1
            ? [call('assign_task', { taskId: 'task-1', member: 'bob' }), { text: 'assigned' }]
            : [{ text: input.includes('The team finished') ? 'done' : 'waiting' }],
        bob: () => [call('update_task', { taskId: 'task-1', status: 'completed', result: 'ok' })],
      },
      { team: { selfClaim: false, tasks: [{ title: 'Unassigned' }] } }
    );

    const result = await swarm.run({ input: 'Go' });

    expect(result.output).toBe('done');
    expect(ofType('team:member-started').map((data) => `${data.member}:${data.reason}`)).toEqual([
      'lead:start',
      'lead:stalled',
      'bob:task',
      'lead:synthesis',
    ]);
  });

  it('ends a run whose lead makes no progress after one stalled turn', async () => {
    const { swarm, ofType } = team(
      { lead: (input) => [{ text: input.includes('The team finished') ? 'gave up' : 'hm' }] },
      { team: { selfClaim: false, maxLeadTurns: 10, tasks: [{ title: 'Nobody takes it' }] } }
    );

    const run = await swarm.run({ input: 'Go' });

    expect(run.output).toBe('gave up');
    expect(run.teamResult).toMatchObject({ stopReason: 'stalled', leadTurns: 3 });
    expect(ofType('team:member-started').map((data) => data.reason)).toEqual([
      'start',
      'stalled',
      'synthesis',
    ]);
  });

  it('fails the run when a member fails, unless the swarm tolerates failures', async () => {
    const failing = { lead: () => [], alice: () => [{ fail: 'model offline' }] satisfies Step[] };
    const strict = team(failing, { team: { tasks: [{ title: 'One', assignee: 'alice' }] } });
    await expect(strict.swarm.run({ input: 'Go' })).rejects.toThrow('model offline');

    const tolerant = team(
      {
        ...failing,
        bob: () => [
          call('update_task', { taskId: 'task-1', status: 'completed', result: 'saved' }),
        ],
      },
      {
        team: { tasks: [{ title: 'One', assignee: 'alice' }] },
        errorHandling: { onAgentFailure: 'abort', partialResults: true },
      }
    );
    const result = await tolerant.swarm.run({ input: 'Go' });

    expect(result.teamResult?.members.find((state) => state.name === 'alice')).toMatchObject({
      status: 'failed',
      error: 'model offline',
    });
    expect(result.teamResult?.tasks[0]).toMatchObject({ status: 'completed', owner: 'bob' });
    expect(result.teamResult?.stopReason).toBe('completed');
  });

  it('hands a skipped member failure to the team: the member is failed and its tasks go back', async () => {
    const run = team(
      {
        lead: () => [],
        alice: () => [{ fail: 'model offline' }],
        bob: () => [
          call('update_task', { taskId: 'task-1', status: 'completed', result: 'saved' }),
        ],
      },
      {
        team: { tasks: [{ title: 'One', assignee: 'alice' }] },
        errorHandling: { onAgentFailure: 'skip' },
      }
    );
    const result = await run.swarm.run({ input: 'Go' });
    expect(result.teamResult?.members.find((state) => state.name === 'alice')).toMatchObject({
      status: 'failed',
      error: 'model offline',
    });
    expect(inputsOf(run.recorded, 'alice')).toHaveLength(1);
    expect(result.teamResult?.tasks[0]).toMatchObject({ status: 'completed', owner: 'bob' });
  });

  it('fails the run when the lead fails, also when failures are skipped', async () => {
    const run = team(
      { lead: () => [{ fail: 'lead offline' }] },
      { errorHandling: { onAgentFailure: 'skip' } }
    );
    await expect(run.swarm.run({ input: 'Go' })).rejects.toThrow('lead offline');
  });

  it('returns the task results without synthesis when synthesize is off', async () => {
    const { swarm, recorded } = team(
      {
        alice: () => [call('update_task', { taskId: 'task-1', status: 'completed', result: 'r1' })],
      },
      { team: { synthesize: false, tasks: [{ title: 'Only', assignee: 'alice' }] } }
    );

    const result = await swarm.run({ input: 'Go' });

    expect(result.output).toBe(renderResults(result.teamResult!.tasks));
    expect(result.output).toContain('r1');
    expect(inputsOf(recorded, 'lead')).toHaveLength(1);
  });

  it('starts every run with a fresh task list and empty mailboxes', async () => {
    const { swarm } = team({
      lead: (input, turn) =>
        turn === 0
          ? [call('create_task', { title: 'Once', assignee: 'alice' }), { text: 'go' }]
          : [{ text: input.includes('The team finished') ? 'final' : 'noted' }],
      alice: () => [
        call('update_task', { taskId: 'task-1', status: 'completed', result: 'done' }),
        call('send_message', { to: 'bob', message: 'left over' }),
      ],
    });

    await swarm.run({ input: 'First' });
    const second = await swarm.run({ input: 'Second' });

    expect(second.teamResult).toMatchObject({ stopReason: 'no-tasks', memberTurns: 0 });
  });

  it('gives send_message to members once when agentTools.messaging is on too', async () => {
    const { swarm, recorded } = team(
      { alice: () => [call('update_task', { taskId: 'task-1', status: 'completed' })] },
      { agentTools: { messaging: true }, team: { tasks: [{ title: 'One', assignee: 'alice' }] } }
    );

    await swarm.run({ input: 'Go' });

    const tools = recorded.find((entry) => entry.agent === 'alice')!.tools;
    expect(tools.filter((name) => name === 'send_message')).toHaveLength(1);
    expect(tools).toContain('read_messages');
  });
});

describe('team swarm configuration', () => {
  const cogitator = {} as Cogitator;

  it('requires a lead and members', () => {
    expect(
      () => new Swarm(cogitator, { name: 't', strategy: 'team', workers: [agent('a')] })
    ).toThrow('Team strategy requires a lead');
    expect(
      () => new Swarm(cogitator, { name: 't', strategy: 'team', supervisor: agent('l') })
    ).toThrow('Team strategy requires at least one member');
  });

  it('cannot run distributed', () => {
    expect(
      () =>
        new Swarm(cogitator, {
          name: 't',
          strategy: 'team',
          supervisor: agent('l'),
          workers: [agent('a')],
          distributed: { enabled: true },
        })
    ).toThrow('The team strategy cannot run distributed');
  });

  it('builds a team with the lead and members of the builder', () => {
    const built = swarm('builder-team')
      .strategy('team')
      .lead(agent('l'))
      .members([agent('a'), agent('b')])
      .team({ maxTurnsPerMember: 3 })
      .build(cogitator);

    expect(built.strategyType).toBe('team');
    expect(built.getAgents().map((entry) => [entry.agent.name, entry.metadata.role])).toEqual([
      ['l', 'supervisor'],
      ['a', 'worker'],
      ['b', 'worker'],
    ]);
  });
});
