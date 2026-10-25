/**
 * The shared task list of a team swarm, kept on the swarm's blackboard
 */

import type {
  Blackboard,
  SwarmEventEmitter,
  TeamEventMap,
  TeamEventType,
  TeamTask,
  TeamTaskInput,
  TeamTaskStatus,
} from '@cogitator-ai/types';

/** The blackboard section the task list of a team lives in */
export const TEAM_SECTION = 'team';

/** Default limit of `team.maxTasks` */
export const DEFAULT_MAX_TASKS = 50;

const TASK_ID = /^[\w.-]{1,64}$/;
const MAX_TITLE = 300;
const MAX_TEXT = 20_000;

/** What the blackboard section of a team holds */
export interface TeamBoardState {
  lead: string;
  members: string[];
  selfClaim: boolean;
  maxTasks: number;
  nextId: number;
  tasks: TeamTask[];
}

export interface TeamBoardOptions {
  lead: string;
  members: string[];
  /** Members may take unassigned tasks (default: true) */
  selfClaim?: boolean;
  /** Tasks the list holds (default: 50) */
  maxTasks?: number;
  /** Tasks on the list from the start, created by `system` */
  tasks?: readonly TeamTaskInput[];
}

/** What a change of a task may set */
export interface TeamTaskUpdate {
  status?: TeamTaskStatus;
  result?: string;
  note?: string;
}

export interface TeamTaskFilter {
  status?: TeamTaskStatus;
  owner?: string;
}

/** A change the task list refuses, with the reason an agent can act on */
export class TeamBoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamBoardError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isTask(value: unknown): value is TeamTask {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    (value.status === 'pending' ||
      value.status === 'in_progress' ||
      value.status === 'completed') &&
    isStringArray(value.dependsOn)
  );
}

function isBoardState(value: unknown): value is TeamBoardState {
  return (
    isRecord(value) &&
    typeof value.lead === 'string' &&
    isStringArray(value.members) &&
    typeof value.selfClaim === 'boolean' &&
    typeof value.maxTasks === 'number' &&
    typeof value.nextId === 'number' &&
    Array.isArray(value.tasks) &&
    value.tasks.every(isTask)
  );
}

function copyTask(task: TeamTask): TeamTask {
  return { ...task, dependsOn: [...task.dependsOn] };
}

/**
 * The task list a team shares. Every change reads the list from the blackboard, checks it and
 * writes the new list in one synchronous step, so two members never claim the same task, and
 * each change is reported on the swarm's events. The list keeps the rules of `write_todos`: a
 * task is pending, in progress or completed, and a member works on one task at a time.
 */
export class TeamTaskBoard {
  constructor(
    private readonly blackboard: Blackboard,
    private readonly events?: SwarmEventEmitter
  ) {}

  /**
   * Put a fresh task list for a team on the blackboard, with `options.tasks` on it, and return
   * the board over it
   */
  static initialize(
    blackboard: Blackboard,
    events: SwarmEventEmitter | undefined,
    options: TeamBoardOptions
  ): TeamTaskBoard {
    if (options.members.includes(options.lead)) {
      throw new TeamBoardError(`The lead ${options.lead} cannot also be a member of the team`);
    }
    const state: TeamBoardState = {
      lead: options.lead,
      members: [...options.members],
      selfClaim: options.selfClaim ?? true,
      maxTasks: Math.max(0, Math.floor(options.maxTasks ?? DEFAULT_MAX_TASKS)),
      nextId: 1,
      tasks: [],
    };
    blackboard.write(TEAM_SECTION, state, 'system');
    const board = new TeamTaskBoard(blackboard, events);
    for (const task of options.tasks ?? []) board.createTask(task, 'system');
    return board;
  }

  /** Whether the blackboard holds the task list of a team */
  static exists(blackboard: Blackboard): boolean {
    return blackboard.has(TEAM_SECTION) && isBoardState(blackboard.read(TEAM_SECTION));
  }

  get lead(): string {
    return this.state().lead;
  }

  get members(): string[] {
    return [...this.state().members];
  }

  get selfClaim(): boolean {
    return this.state().selfClaim;
  }

  /** Bumped on every change of the list */
  get version(): number {
    return this.blackboard.getSection(TEAM_SECTION)?.version ?? 0;
  }

  /** The tasks in the order they were created, filtered by status or owner */
  listTasks(filter: TeamTaskFilter = {}): TeamTask[] {
    return this.state()
      .tasks.filter((task) => filter.status === undefined || task.status === filter.status)
      .filter((task) => filter.owner === undefined || task.owner === filter.owner)
      .map(copyTask);
  }

  getTask(taskId: string): TeamTask | undefined {
    const task = this.state().tasks.find((candidate) => candidate.id === taskId);
    return task && copyTask(task);
  }

  /** Whether the list has tasks and every one of them is completed */
  isComplete(): boolean {
    const tasks = this.state().tasks;
    return tasks.length > 0 && tasks.every((task) => task.status === 'completed');
  }

  /** Dependencies of the task that are not completed yet */
  blockers(taskId: string): string[] {
    const state = this.state();
    const task = this.requireTask(state, taskId);
    return this.unfinishedDependencies(state, task);
  }

  /**
   * The tasks `member` could claim now, the ones assigned to it first: pending, not blocked, and
   * assigned to it or (with self-claim) to nobody. Empty while it works on a task.
   */
  claimableBy(member: string): TeamTask[] {
    const state = this.state();
    if (!state.members.includes(member)) return [];
    if (state.tasks.some((task) => task.owner === member && task.status === 'in_progress')) {
      return [];
    }
    const open = state.tasks.filter(
      (task) => task.status === 'pending' && this.unfinishedDependencies(state, task).length === 0
    );
    const assigned = open.filter((task) => task.owner === member);
    const unowned = state.selfClaim ? open.filter((task) => task.owner === undefined) : [];
    return [...assigned, ...unowned].map(copyTask);
  }

  /** Put a task on the list. Only the lead (and `system`) create tasks. */
  createTask(input: TeamTaskInput, by: string): TeamTask {
    const state = this.state();
    if (by !== state.lead && by !== 'system') {
      throw new TeamBoardError(`Only the lead ${state.lead} creates tasks`);
    }
    if (state.tasks.length >= state.maxTasks) {
      throw new TeamBoardError(`The task list is full: it holds at most ${state.maxTasks} tasks`);
    }
    const title = input.title.trim();
    if (!title) throw new TeamBoardError('A task needs a title');
    if (title.length > MAX_TITLE) {
      throw new TeamBoardError(`A task title has at most ${MAX_TITLE} characters`);
    }
    const id = input.id?.trim() || this.freeId(state);
    if (!TASK_ID.test(id)) {
      throw new TeamBoardError(
        `The task id "${id}" is not valid: use letters, digits, ".", "_" or "-", at most 64`
      );
    }
    if (state.tasks.some((task) => task.id === id)) {
      throw new TeamBoardError(`There is a task ${id} already`);
    }
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    for (const dependency of dependsOn) {
      if (!state.tasks.some((task) => task.id === dependency)) {
        throw new TeamBoardError(`The task ${dependency} it depends on is not on the list`);
      }
    }
    if (input.assignee !== undefined) this.requireMember(state, input.assignee);

    const now = Date.now();
    const task: TeamTask = {
      id,
      title,
      ...(input.description?.trim() && { description: limit(input.description.trim()) }),
      status: 'pending',
      ...(input.assignee !== undefined && { owner: input.assignee }),
      dependsOn,
      createdBy: by,
      createdAt: now,
      updatedAt: now,
    };
    this.save({ ...state, nextId: state.nextId + 1, tasks: [...state.tasks, task] }, by);
    this.emit('team:task-created', { task: copyTask(task), by }, by);
    if (task.owner !== undefined) {
      this.emit('team:task-assigned', { task: copyTask(task), assignee: task.owner, by }, by);
    }
    return copyTask(task);
  }

  /** Give a pending task to a member. Only the lead assigns. */
  assignTask(taskId: string, assignee: string, by: string): TeamTask {
    const state = this.state();
    if (by !== state.lead && by !== 'system') {
      throw new TeamBoardError(`Only the lead ${state.lead} assigns tasks`);
    }
    this.requireMember(state, assignee);
    const task = this.requireTask(state, taskId);
    if (task.status !== 'pending') {
      throw new TeamBoardError(
        `The task ${taskId} is ${statusText(task.status)}${task.owner ? ` by ${task.owner}` : ''}: only pending tasks can be assigned`
      );
    }
    const previousOwner = task.owner;
    const assigned: TeamTask = { ...task, owner: assignee, updatedAt: Date.now() };
    this.save(replaceTask(state, assigned), by);
    this.emit(
      'team:task-assigned',
      {
        task: copyTask(assigned),
        assignee,
        by,
        ...(previousOwner !== undefined && previousOwner !== assignee && { previousOwner }),
      },
      by
    );
    return copyTask(assigned);
  }

  /**
   * Start a task as `member`: the given one, or the first it could claim (`claimableBy`). The
   * task must be pending, not blocked, and assigned to the member or (with self-claim) to nobody,
   * and the member must not be working on another task. Claiming the task it works on already
   * changes nothing.
   */
  claimTask(member: string, taskId?: string): TeamTask {
    const state = this.state();
    this.requireMember(state, member);
    const working = state.tasks.find(
      (task) => task.owner === member && task.status === 'in_progress'
    );
    if (working && working.id === taskId) return copyTask(working);
    if (working) {
      throw new TeamBoardError(
        `You are working on ${working.id} already: complete it or release it before you claim another task`
      );
    }

    let task: TeamTask;
    if (taskId === undefined) {
      const next = this.claimableBy(member)[0];
      if (!next) throw new TeamBoardError('There is no task you can claim now');
      task = this.requireTask(state, next.id);
    } else {
      task = this.requireTask(state, taskId);
      if (task.status !== 'pending') {
        throw new TeamBoardError(
          `The task ${taskId} is ${statusText(task.status)}${task.owner ? ` by ${task.owner}` : ''}`
        );
      }
      if (task.owner !== undefined && task.owner !== member) {
        throw new TeamBoardError(`The task ${taskId} is assigned to ${task.owner}`);
      }
      if (task.owner === undefined && !state.selfClaim) {
        throw new TeamBoardError(
          `The task ${taskId} is not assigned to you, and members only work on the tasks the lead assigns`
        );
      }
      const blockers = this.unfinishedDependencies(state, task);
      if (blockers.length > 0) {
        throw new TeamBoardError(
          `The task ${taskId} waits for ${blockers.join(', ')} to be completed`
        );
      }
    }

    const claimed: TeamTask = {
      ...task,
      status: 'in_progress',
      owner: member,
      updatedAt: Date.now(),
    };
    this.save(replaceTask(state, claimed), member);
    this.emit('team:task-claimed', { task: copyTask(claimed), member }, member);
    return copyTask(claimed);
  }

  /**
   * Change a task: its owner or the lead complete it with its result, release it back to the
   * list (`pending`), or leave a note. A member starts a task with `status: 'in_progress'` the
   * way `claimTask` does. The lead may also complete a pending task that is no longer needed.
   * Completed tasks are final.
   */
  updateTask(taskId: string, update: TeamTaskUpdate, by: string): TeamTask {
    const state = this.state();
    const task = this.requireTask(state, taskId);
    const isLead = by === state.lead || by === 'system';
    const to = update.status ?? task.status;

    if (task.status === 'completed') {
      throw new TeamBoardError(`The task ${taskId} is completed: completed tasks are final`);
    }
    if (to === 'in_progress' && task.status === 'pending') {
      if (isLead) {
        throw new TeamBoardError(
          `Only a member starts a task: assign ${taskId} with assign_task instead`
        );
      }
      const claimed = this.claimTask(by, taskId);
      return update.note === undefined
        ? claimed
        : this.updateTask(taskId, { note: update.note }, by);
    }
    if (!isLead && task.owner !== by) {
      throw new TeamBoardError(
        task.owner
          ? `The task ${taskId} belongs to ${task.owner}`
          : `The task ${taskId} is not yours: claim it first`
      );
    }
    if (!isLead && to === 'completed' && task.status !== 'in_progress') {
      throw new TeamBoardError(`Claim the task ${taskId} before you complete it`);
    }

    const changed: TeamTask = {
      ...task,
      status: to,
      ...(update.result !== undefined && { result: limit(update.result) }),
      ...(update.note !== undefined && { note: limit(update.note) }),
      updatedAt: Date.now(),
    };
    if (to === 'pending' && task.status === 'in_progress') delete changed.owner;

    const next = replaceTask(state, changed);
    this.save(next, by);

    if (to === 'completed') {
      const unblocked = next.tasks
        .filter(
          (candidate) =>
            candidate.status === 'pending' &&
            candidate.dependsOn.includes(taskId) &&
            this.unfinishedDependencies(next, candidate).length === 0
        )
        .map((candidate) => candidate.id);
      this.emit('team:task-completed', { task: copyTask(changed), by, unblocked }, by);
    } else {
      this.emit(
        'team:task-updated',
        { task: copyTask(changed), by, from: task.status, to: changed.status },
        by
      );
    }
    return copyTask(changed);
  }

  /**
   * Put the tasks of a member back on the list for others: its task in progress goes back to
   * pending, and the tasks assigned to it lose their owner. Used when a member stops or fails.
   */
  releaseTasksOf(member: string, note: string): TeamTask[] {
    const state = this.state();
    const owned = state.tasks.filter(
      (task) => task.owner === member && task.status !== 'completed'
    );
    if (owned.length === 0) return [];
    const now = Date.now();
    const released = owned.map((task): TeamTask => {
      const copy: TeamTask = { ...task, status: 'pending', note: limit(note), updatedAt: now };
      delete copy.owner;
      return copy;
    });
    const next = released.reduce(replaceTask, state);
    this.save(next, 'system');
    for (let i = 0; i < owned.length; i++) {
      this.emit(
        'team:task-updated',
        { task: copyTask(released[i]), by: 'system', from: owned[i].status, to: 'pending' },
        'system'
      );
    }
    return released.map(copyTask);
  }

  private state(): TeamBoardState {
    if (!this.blackboard.has(TEAM_SECTION)) {
      throw new TeamBoardError('There is no team task list: the swarm does not run a team');
    }
    const state = this.blackboard.read<unknown>(TEAM_SECTION);
    if (!isBoardState(state)) {
      throw new TeamBoardError(`The "${TEAM_SECTION}" blackboard section is not a team task list`);
    }
    return state;
  }

  private save(state: TeamBoardState, by: string): void {
    this.blackboard.write(TEAM_SECTION, state, by);
  }

  private emit<T extends TeamEventType>(type: T, data: TeamEventMap[T], agentName: string): void {
    this.events?.emit(type, data, agentName);
  }

  private freeId(state: TeamBoardState): string {
    let n = state.nextId;
    while (state.tasks.some((task) => task.id === `task-${n}`)) n++;
    return `task-${n}`;
  }

  private requireTask(state: TeamBoardState, taskId: string): TeamTask {
    const task = state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new TeamBoardError(`There is no task ${taskId}`);
    return task;
  }

  private requireMember(state: TeamBoardState, name: string): void {
    if (!state.members.includes(name)) {
      throw new TeamBoardError(
        `${name} is not a member of the team, the members are: ${state.members.join(', ')}`
      );
    }
  }

  private unfinishedDependencies(state: TeamBoardState, task: TeamTask): string[] {
    return task.dependsOn.filter(
      (dependency) =>
        state.tasks.find((candidate) => candidate.id === dependency)?.status !== 'completed'
    );
  }
}

function replaceTask(state: TeamBoardState, task: TeamTask): TeamBoardState {
  return {
    ...state,
    tasks: state.tasks.map((candidate) => (candidate.id === task.id ? task : candidate)),
  };
}

function statusText(status: TeamTaskStatus): string {
  return status === 'in_progress' ? 'in progress' : status;
}

function limit(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...` : text;
}
