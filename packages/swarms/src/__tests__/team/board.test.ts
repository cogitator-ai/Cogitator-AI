import { describe, it, expect, beforeEach } from 'vitest';
import type { TeamEventMap } from '@cogitator-ai/types';
import { InMemoryBlackboard } from '../../communication/blackboard';
import { SwarmEventEmitterImpl } from '../../communication/event-emitter';
import { TEAM_SECTION, TeamBoardError, TeamTaskBoard } from '../../team/board';

function setup(options: { selfClaim?: boolean; maxTasks?: number } = {}) {
  const blackboard = new InMemoryBlackboard({ enabled: true, sections: {}, trackHistory: true });
  const events = new SwarmEventEmitterImpl();
  const board = TeamTaskBoard.initialize(blackboard, events, {
    lead: 'lead',
    members: ['alice', 'bob'],
    ...options,
  });
  return { blackboard, events, board };
}

describe('TeamTaskBoard', () => {
  let board: TeamTaskBoard;
  let events: SwarmEventEmitterImpl;

  beforeEach(() => {
    ({ board, events } = setup());
  });

  describe('creating tasks', () => {
    it('numbers tasks and keeps them pending in the order they were created', () => {
      const first = board.createTask({ title: 'Research' }, 'lead');
      const second = board.createTask({ title: 'Write', dependsOn: [first.id] }, 'lead');

      expect(first).toMatchObject({ id: 'task-1', status: 'pending', createdBy: 'lead' });
      expect(second).toMatchObject({ id: 'task-2', dependsOn: ['task-1'] });
      expect(board.listTasks().map((task) => task.id)).toEqual(['task-1', 'task-2']);
    });

    it('takes a named id and skips numbers a named task already holds', () => {
      board.createTask({ id: 'task-1', title: 'Named' }, 'lead');
      expect(board.createTask({ title: 'Next' }, 'lead').id).toBe('task-2');
      expect(() => board.createTask({ id: 'task-1', title: 'Again' }, 'lead')).toThrow(
        'There is a task task-1 already'
      );
      expect(() => board.createTask({ id: 'has space', title: 'Bad' }, 'lead')).toThrow(
        'is not valid'
      );
    });

    it('lets only the lead create tasks, with dependencies already on the list', () => {
      expect(() => board.createTask({ title: 'Mine' }, 'alice')).toThrow(
        'Only the lead lead creates tasks'
      );
      expect(() => board.createTask({ title: 'Later', dependsOn: ['task-9'] }, 'lead')).toThrow(
        'The task task-9 it depends on is not on the list'
      );
      expect(() => board.createTask({ title: '  ' }, 'lead')).toThrow('A task needs a title');
      expect(() => board.createTask({ title: 'X', assignee: 'carol' }, 'lead')).toThrow(
        'carol is not a member of the team'
      );
    });

    it('holds at most maxTasks tasks', () => {
      ({ board } = setup({ maxTasks: 1 }));
      board.createTask({ title: 'One' }, 'lead');
      expect(() => board.createTask({ title: 'Two' }, 'lead')).toThrow('at most 1 tasks');
    });

    it('reports a created task, and its assignment when it has an assignee', () => {
      board.createTask({ title: 'Research', assignee: 'alice' }, 'lead');

      const types = events.getEvents().map((event) => event.type);
      expect(types).toEqual(['team:task-created', 'team:task-assigned']);
      const assigned = events.getEventsByType('team:task-assigned')[0]
        .data as TeamEventMap['team:task-assigned'];
      expect(assigned).toMatchObject({ assignee: 'alice', by: 'lead', task: { owner: 'alice' } });
    });

    it('puts the tasks of the options on the list, created by system', () => {
      const { board: seeded } = (() => {
        const blackboard = new InMemoryBlackboard({ enabled: true, sections: {} });
        return {
          board: TeamTaskBoard.initialize(blackboard, undefined, {
            lead: 'lead',
            members: ['alice'],
            tasks: [{ title: 'Seeded', assignee: 'alice' }],
          }),
        };
      })();
      expect(seeded.listTasks()).toEqual([
        expect.objectContaining({ id: 'task-1', createdBy: 'system', owner: 'alice' }),
      ]);
    });
  });

  describe('claiming', () => {
    it('gives a task to exactly one member', () => {
      const task = board.createTask({ title: 'Only one' }, 'lead');

      expect(board.claimTask('alice', task.id)).toMatchObject({
        status: 'in_progress',
        owner: 'alice',
      });
      expect(() => board.claimTask('bob', task.id)).toThrow('is in progress by alice');
      expect(events.getEventsByType('team:task-claimed')).toHaveLength(1);
    });

    it('claims the next task the member can take, its own assigned ones first', () => {
      board.createTask({ title: 'Open' }, 'lead');
      board.createTask({ title: 'For bob', assignee: 'bob' }, 'lead');

      expect(board.claimTask('bob').id).toBe('task-2');
      expect(board.claimTask('alice').id).toBe('task-1');
      expect(() => board.claimTask('alice')).toThrow('You are working on task-1 already');
      expect(board.claimTask('alice', 'task-1')).toMatchObject({ status: 'in_progress' });
      expect(events.getEventsByType('team:task-claimed')).toHaveLength(2);
    });

    it('keeps a task with unfinished dependencies from being claimed until they complete', () => {
      const research = board.createTask({ title: 'Research' }, 'lead');
      const write = board.createTask({ title: 'Write', dependsOn: [research.id] }, 'lead');

      expect(() => board.claimTask('bob', write.id)).toThrow('waits for task-1 to be completed');
      expect(board.claimableBy('bob').map((task) => task.id)).toEqual(['task-1']);

      board.claimTask('alice', research.id);
      const done = board.updateTask(research.id, { status: 'completed', result: 'facts' }, 'alice');

      expect(done.result).toBe('facts');
      const completed = events.getEventsByType('team:task-completed')[0]
        .data as TeamEventMap['team:task-completed'];
      expect(completed.unblocked).toEqual(['task-2']);
      expect(board.claimTask('bob').id).toBe('task-2');
    });

    it('lets a member work on one task at a time', () => {
      board.createTask({ title: 'One' }, 'lead');
      board.createTask({ title: 'Two' }, 'lead');
      board.claimTask('alice', 'task-1');

      expect(board.claimableBy('alice')).toEqual([]);
      expect(() => board.claimTask('alice', 'task-2')).toThrow('You are working on task-1');
      expect(() => board.updateTask('task-2', { status: 'in_progress' }, 'alice')).toThrow(
        'You are working on task-1'
      );
    });

    it('refuses a task assigned to another member', () => {
      board.createTask({ title: 'For bob', assignee: 'bob' }, 'lead');
      expect(() => board.claimTask('alice', 'task-1')).toThrow('assigned to bob');
    });

    it('leaves unassigned tasks alone without self-claim', () => {
      ({ board } = setup({ selfClaim: false }));
      board.createTask({ title: 'Open' }, 'lead');

      expect(board.claimableBy('alice')).toEqual([]);
      expect(() => board.claimTask('alice', 'task-1')).toThrow(
        'members only work on the tasks the lead assigns'
      );
      board.assignTask('task-1', 'alice', 'lead');
      expect(board.claimTask('alice').id).toBe('task-1');
    });
  });

  describe('updating', () => {
    it('lets only the owner or the lead change a task, and keeps completed tasks final', () => {
      board.createTask({ title: 'Mine' }, 'lead');
      board.claimTask('alice', 'task-1');

      expect(() => board.updateTask('task-1', { note: 'hi' }, 'bob')).toThrow(
        'The task task-1 belongs to alice'
      );
      expect(board.updateTask('task-1', { note: 'halfway' }, 'alice').note).toBe('halfway');
      board.updateTask('task-1', { status: 'completed', result: 'done' }, 'alice');
      expect(() => board.updateTask('task-1', { status: 'pending' }, 'lead')).toThrow(
        'completed tasks are final'
      );
    });

    it('releases a task back to the list without an owner', () => {
      board.createTask({ title: 'Hard' }, 'lead');
      board.claimTask('alice', 'task-1');
      const released = board.updateTask('task-1', { status: 'pending', note: 'stuck' }, 'alice');

      expect(released.owner).toBeUndefined();
      expect(released.status).toBe('pending');
      const updated = events.getEventsByType('team:task-updated')[0]
        .data as TeamEventMap['team:task-updated'];
      expect(updated).toMatchObject({ from: 'in_progress', to: 'pending', by: 'alice' });
      expect(board.claimTask('bob').id).toBe('task-1');
    });

    it('makes a member claim a task before completing it, while the lead may close one', () => {
      board.createTask({ title: 'Open' }, 'lead');
      board.createTask({ title: 'Obsolete' }, 'lead');

      expect(() => board.updateTask('task-1', { status: 'completed' }, 'alice')).toThrow(
        'not yours: claim it first'
      );
      expect(() => board.updateTask('task-1', { status: 'in_progress' }, 'lead')).toThrow(
        'Only a member starts a task'
      );
      expect(
        board.updateTask('task-2', { status: 'completed', result: 'dropped' }, 'lead').status
      ).toBe('completed');
    });

    it('starts a task when a member sets it in progress', () => {
      board.createTask({ title: 'Open' }, 'lead');
      expect(
        board.updateTask('task-1', { status: 'in_progress', note: 'on it' }, 'bob')
      ).toMatchObject({
        status: 'in_progress',
        owner: 'bob',
        note: 'on it',
      });
    });

    it('assigns only pending tasks to members', () => {
      board.createTask({ title: 'Open' }, 'lead');
      board.claimTask('alice', 'task-1');
      expect(() => board.assignTask('task-1', 'bob', 'lead')).toThrow(
        'only pending tasks can be assigned'
      );
      expect(() => board.assignTask('task-1', 'bob', 'alice')).toThrow('Only the lead');
    });

    it('releases every unfinished task of a member that stopped', () => {
      board.createTask({ title: 'Working' }, 'lead');
      board.createTask({ title: 'Assigned', assignee: 'alice' }, 'lead');
      board.createTask({ title: 'Done' }, 'lead');
      board.claimTask('bob', 'task-3');
      board.updateTask('task-3', { status: 'completed' }, 'bob');
      board.claimTask('alice', 'task-2');
      board.assignTask('task-1', 'alice', 'lead');

      const released = board.releaseTasksOf('alice', 'alice stopped');

      expect(released.map((task) => task.id)).toEqual(['task-1', 'task-2']);
      expect(board.listTasks({ owner: 'alice' })).toEqual([]);
      expect(board.getTask('task-2')).toMatchObject({ status: 'pending', note: 'alice stopped' });
      expect(board.getTask('task-3')?.status).toBe('completed');
    });
  });

  describe('state', () => {
    it('is complete once it has tasks and every one is completed', () => {
      expect(board.isComplete()).toBe(false);
      board.createTask({ title: 'One' }, 'lead');
      board.claimTask('alice');
      expect(board.isComplete()).toBe(false);
      board.updateTask('task-1', { status: 'completed' }, 'alice');
      expect(board.isComplete()).toBe(true);
    });

    it('never hands out the stored list, so callers cannot change it in place', () => {
      board.createTask({ title: 'One', dependsOn: [] }, 'lead');
      const [task] = board.listTasks();
      task.status = 'completed';
      task.dependsOn.push('x');
      expect(board.getTask('task-1')).toMatchObject({ status: 'pending', dependsOn: [] });
    });

    it('refuses a blackboard section that is not a task list', () => {
      const { blackboard, board: other } = setup();
      blackboard.write(TEAM_SECTION, { tasks: 'oops' }, 'alice');
      expect(() => other.listTasks()).toThrow(TeamBoardError);
      expect(TeamTaskBoard.exists(blackboard)).toBe(false);
    });

    it('refuses a lead that is also a member', () => {
      const blackboard = new InMemoryBlackboard({ enabled: true, sections: {} });
      expect(() =>
        TeamTaskBoard.initialize(blackboard, undefined, { lead: 'alice', members: ['alice'] })
      ).toThrow('cannot also be a member');
    });
  });
});
