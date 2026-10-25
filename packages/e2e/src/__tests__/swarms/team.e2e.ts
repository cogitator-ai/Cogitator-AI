import { describe, it, expect, beforeAll } from 'vitest';
import type { Cogitator } from '@cogitator-ai/core';
import { Swarm } from '@cogitator-ai/swarms';
import type { SwarmEvent, TeamEventMap, TeamEventType } from '@cogitator-ai/types';
import { createTestAgent, createTestCogitator, ollamaSkipReason } from '../../helpers/setup';

const describeE2E = describe.skipIf((await ollamaSkipReason()) !== null);

function member(name: string, focus: string) {
  return createTestAgent({
    name,
    instructions: `You are ${name}, ${focus}. When you get a task, do it in one or two sentences, then call update_task with the task id, status "completed" and your result.`,
    maxIterations: 4,
    maxTokens: 256,
    temperature: 0,
  });
}

function teamSwarm(cogitator: Cogitator, seeded: boolean) {
  const lead = createTestAgent({
    name: 'editor',
    instructions:
      'You are the editor of a small team. Plan the work with create_task when asked to, and write short final answers from the results of your team.',
    maxIterations: 4,
    maxTokens: 256,
    temperature: 0,
  });
  return new Swarm(cogitator, {
    name: seeded ? 'team-seeded' : 'team-planned',
    strategy: 'team',
    supervisor: lead,
    workers: [member('fact-finder', 'who finds facts'), member('writer', 'who writes clearly')],
    team: {
      maxLeadTurns: 2,
      maxTurnsPerMember: 2,
      maxConcurrentMembers: 1,
      ...(seeded && {
        tasks: [
          { title: 'Name one fact about the Moon', assignee: 'fact-finder' },
          { title: 'Write one sentence about the Moon', dependsOn: ['task-1'], assignee: 'writer' },
        ],
      }),
    },
  });
}

function collect(swarm: Swarm) {
  const events: SwarmEvent[] = [];
  swarm.on('*', (event) => {
    events.push(event);
  });
  const ofType = <T extends TeamEventType>(type: T): TeamEventMap[T][] =>
    events.filter((event) => event.type === type).map((event) => event.data as TeamEventMap[T]);
  return { events, ofType };
}

describeE2E('Swarms: agent teams', () => {
  let cogitator: Cogitator;

  beforeAll(() => {
    cogitator = createTestCogitator();
  });

  it(
    'works through a seeded task list on a real model and always ends',
    { timeout: 240_000 },
    async () => {
      const swarm = teamSwarm(cogitator, true);
      const { ofType } = collect(swarm);

      const result = await swarm.run({
        input: 'Write a short note about the Moon',
        saveHistory: false,
      });

      expect(typeof result.output).toBe('string');
      const team = result.teamResult!;
      expect(['completed', 'stalled', 'turn-limit']).toContain(team.stopReason);
      expect(team.tasks.map((task) => task.id)).toEqual(['task-1', 'task-2']);
      for (const task of team.tasks) {
        expect(['pending', 'in_progress', 'completed']).toContain(task.status);
      }
      if (team.tasks[1].status !== 'pending') expect(team.tasks[0].status).toBe('completed');

      expect(ofType('team:start')).toHaveLength(1);
      expect(ofType('team:complete')).toEqual([
        expect.objectContaining({ stopReason: team.stopReason }),
      ]);
      const started = ofType('team:member-started');
      expect(started.some((data) => data.member === 'fact-finder' && data.reason === 'task')).toBe(
        true
      );
      expect(team.members.find((state) => state.name === 'fact-finder')!.turns).toBeLessThanOrEqual(
        2
      );
      expect(team.leadTurns).toBeLessThanOrEqual(3);

      const claims = ofType('team:task-claimed').map((data) => `${data.task.id}:${data.member}`);
      expect(new Set(claims).size).toBe(claims.length);
    }
  );

  it('lets the lead plan the work and ends within the bounds', { timeout: 240_000 }, async () => {
    const swarm = teamSwarm(cogitator, false);
    const { ofType } = collect(swarm);

    const result = await swarm.run({
      input:
        'Create one task with create_task: "Name the largest planet", assigned to fact-finder. Then end your turn.',
      saveHistory: false,
    });

    expect(typeof result.output).toBe('string');
    const team = result.teamResult!;
    expect(['completed', 'no-tasks', 'stalled', 'turn-limit']).toContain(team.stopReason);
    for (const task of team.tasks) expect(task.createdBy).toBe('editor');
    expect(ofType('team:task-created')).toHaveLength(team.tasks.length);
    expect(team.memberTurns).toBeLessThanOrEqual(4);
    expect(team.leadTurns).toBeLessThanOrEqual(3);
  });
});
