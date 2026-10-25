/**
 * Team strategy - a lead and members share a task list and mailboxes
 */

import { AgentRunPausedError } from '@cogitator-ai/core';
import type {
  RunResult,
  SwarmEventType,
  StrategyResult,
  SwarmAgent,
  SwarmCoordinatorInterface,
  SwarmRunOptions,
  TeamConfig,
  TeamMemberState,
  TeamResult,
  TeamRole,
  TeamStopReason,
  TeamTask,
  TeamTaskInput,
  TeamTurnReason,
} from '@cogitator-ai/types';
import { BaseStrategy } from './base.js';
import { DEFAULT_MAX_TASKS, TeamTaskBoard } from '../team/board.js';
import { renderTeamMessages, TeamMailbox } from '../team/mailbox.js';

/** Defaults of the bounds of a team run */
export const TEAM_DEFAULTS = {
  selfClaim: true,
  maxConcurrentMembers: 4,
  maxLeadTurns: 6,
  maxTurnsPerMember: 8,
  maxTasks: DEFAULT_MAX_TASKS,
  synthesize: true,
} as const;

/** Events after which a member may have a reason to take a turn */
const WAKE_EVENTS: readonly SwarmEventType[] = [
  'team:task-created',
  'team:task-assigned',
  'team:task-updated',
  'team:task-completed',
  'team:message-sent',
];

const OUTPUT_PREVIEW = 500;
const RESULT_PREVIEW = 300;

interface ResolvedTeamConfig {
  tasks: TeamTaskInput[];
  selfClaim: boolean;
  maxConcurrentMembers: number;
  maxLeadTurns: number;
  maxTurnsPerMember: number;
  maxTasks: number;
  synthesize: boolean;
}

export interface TeamStrategyOptions {
  /** Default of `maxConcurrentMembers`: the swarm's `resources.maxConcurrency` */
  maxConcurrency?: number;
  /**
   * A member whose turn fails is marked failed and its tasks go back to the list, instead of
   * failing the run: the swarm's `errorHandling` asks for partial results or skips failed agents
   */
  tolerateFailures?: boolean;
}

interface Turn {
  agent: string;
  role: TeamRole;
  reason: TeamTurnReason;
  taskId?: string;
  /** The member worked on the task in an earlier turn already */
  continued?: boolean;
}

interface RunState {
  input: string;
  context?: Record<string, unknown>;
  board: TeamTaskBoard;
  mailbox: TeamMailbox;
  lead: SwarmAgent;
  members: SwarmAgent[];
  states: Map<string, TeamMemberState>;
  agentResults: Map<string, RunResult>;
  leadTurns: number;
  memberTurns: number;
  leadStarted: boolean;
  lastLeadResult?: RunResult;
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

/**
 * A lead plans the work as tasks on a shared list and members work through them. The lead takes
 * the first turn; a member takes a turn when it has a task (assigned to it, or with self-claim the
 * next unassigned one that is not blocked, claimed for it before the turn) or messages in its
 * mailbox, up to `maxConcurrentMembers` at a time. The lead takes a turn when messages reach it,
 * or when nobody can go on with the tasks left. Once every task is completed, or nobody has a
 * reason or a turn left, the lead writes the final answer from the results.
 */
export class TeamStrategy extends BaseStrategy {
  private readonly config: ResolvedTeamConfig;
  private readonly tolerateFailures: boolean;

  constructor(
    coordinator: SwarmCoordinatorInterface,
    config: TeamConfig = {},
    options: TeamStrategyOptions = {}
  ) {
    super(coordinator);
    this.config = {
      tasks: config.tasks ?? [],
      selfClaim: config.selfClaim ?? TEAM_DEFAULTS.selfClaim,
      maxConcurrentMembers: Math.max(
        1,
        positive(
          config.maxConcurrentMembers,
          options.maxConcurrency ?? TEAM_DEFAULTS.maxConcurrentMembers
        )
      ),
      maxLeadTurns: Math.max(1, positive(config.maxLeadTurns, TEAM_DEFAULTS.maxLeadTurns)),
      maxTurnsPerMember: positive(config.maxTurnsPerMember, TEAM_DEFAULTS.maxTurnsPerMember),
      maxTasks: positive(config.maxTasks, TEAM_DEFAULTS.maxTasks),
      synthesize: config.synthesize ?? TEAM_DEFAULTS.synthesize,
    };
    this.tolerateFailures = options.tolerateFailures ?? false;
  }

  async execute(options: SwarmRunOptions): Promise<StrategyResult> {
    const lead = this.coordinator.getAgentsByRole('supervisor')[0];
    if (!lead) throw new Error('Team strategy requires a lead: set it as the supervisor');
    const members = this.coordinator.getAgentsByRole('worker');
    if (members.length === 0) {
      throw new Error('Team strategy requires at least one member: set them as the workers');
    }

    const leadName = lead.agent.name;
    const memberNames = members.map((member) => member.agent.name);
    const mailbox = new TeamMailbox(this.coordinator.messageBus, this.coordinator.events, {
      lead: leadName,
      members: memberNames,
    });
    for (const agent of mailbox.agents) mailbox.take(agent);

    const board = TeamTaskBoard.initialize(this.coordinator.blackboard, this.coordinator.events, {
      lead: leadName,
      members: memberNames,
      selfClaim: this.config.selfClaim,
      maxTasks: this.config.maxTasks,
    });

    const run: RunState = {
      input: options.input,
      context: options.context,
      board,
      mailbox,
      lead,
      members,
      states: new Map([
        [leadName, { name: leadName, role: 'lead', status: 'idle', turns: 0 }],
        ...memberNames.map((name): [string, TeamMemberState] => [
          name,
          { name, role: 'member', status: 'idle', turns: 0 },
        ]),
      ]),
      agentResults: new Map(),
      leadTurns: 0,
      memberTurns: 0,
      leadStarted: false,
    };

    this.coordinator.events.emit('team:start', { lead: leadName, members: memberNames }, leadName);
    for (const task of this.config.tasks) board.createTask(task, 'system');

    await this.work(run);

    const stopReason = this.stopReason(run);
    let output: string;
    if (stopReason === 'no-tasks') {
      output = run.lastLeadResult?.output ?? '';
    } else if (this.config.synthesize) {
      const synthesis = await this.takeTurn(run, {
        agent: leadName,
        role: 'lead',
        reason: 'synthesis',
      });
      output = synthesis?.output ?? '';
    } else {
      output = renderResults(board.listTasks());
    }

    const teamResult: TeamResult = {
      tasks: board.listTasks(),
      members: [...run.states.values()].map((state) => ({ ...state })),
      stopReason,
      leadTurns: run.leadTurns,
      memberTurns: run.memberTurns,
    };
    const tasks = teamResult.tasks;
    this.coordinator.events.emit(
      'team:complete',
      {
        stopReason,
        tasks: {
          total: tasks.length,
          completed: tasks.filter((task) => task.status === 'completed').length,
          inProgress: tasks.filter((task) => task.status === 'in_progress').length,
          pending: tasks.filter((task) => task.status === 'pending').length,
        },
        leadTurns: run.leadTurns,
        memberTurns: run.memberTurns,
      },
      leadName
    );

    return {
      output,
      ...(run.lastLeadResult?.structured !== undefined && {
        structured: run.lastLeadResult.structured,
      }),
      agentResults: run.agentResults,
      teamResult,
    };
  }

  /**
   * The scheduling loop: start every turn that has a reason, wait for a turn to end or for a task
   * or a message to give someone a reason, look again. Each turn spends one of a finite number of
   * turns, so the loop always ends.
   */
  private async work(run: RunState): Promise<void> {
    const running = new Map<string, Promise<void>>();
    let failure: { error: unknown } | undefined;
    let stallMark: string | undefined;
    let wake = (): void => undefined;
    const unsubscribe = WAKE_EVENTS.map((type) => this.coordinator.events.on(type, () => wake()));

    const start = (turn: Turn) => {
      const promise = this.takeTurn(run, turn)
        .then(() => undefined)
        .catch((error: unknown) => {
          failure ??= { error };
        })
        .finally(() => running.delete(turn.agent));
      running.set(turn.agent, promise);
    };

    try {
      for (;;) {
        if (!failure && !run.board.isComplete()) {
          for (const turn of this.nextTurns(run, running)) start(turn);
        }

        if (running.size === 0) {
          if (failure || run.board.isComplete()) break;
          const mark = `${run.board.version}:${this.coordinator.messageBus.getAllMessages().length}`;
          const canStall =
            run.leadStarted &&
            run.board.listTasks().length > 0 &&
            run.leadTurns < this.config.maxLeadTurns &&
            mark !== stallMark;
          if (!canStall) break;
          stallMark = mark;
          start({ agent: run.lead.agent.name, role: 'lead', reason: 'stalled' });
          continue;
        }

        await new Promise<void>((resolve) => {
          wake = resolve;
          void Promise.race(running.values()).then(resolve);
        });
        wake = () => undefined;
      }
    } finally {
      for (const off of unsubscribe) off();
    }

    if (failure) throw failure.error;
  }

  /** Turns to start now, in a fixed order: the lead, then the members as configured */
  private nextTurns(run: RunState, running: ReadonlyMap<string, Promise<void>>): Turn[] {
    const turns: Turn[] = [];
    const leadName = run.lead.agent.name;

    if (!running.has(leadName)) {
      if (!run.leadStarted) {
        run.leadStarted = true;
        turns.push({ agent: leadName, role: 'lead', reason: 'start' });
      } else if (run.leadTurns < this.config.maxLeadTurns && run.mailbox.hasUnread(leadName)) {
        turns.push({ agent: leadName, role: 'lead', reason: 'message' });
      }
    }

    const leadBusy = running.has(leadName) || turns.length > 0;
    let capacity =
      this.config.maxConcurrentMembers -
      [...running.keys()].filter((name) => name !== leadName).length;

    for (const member of run.members) {
      if (capacity <= 0) break;
      const name = member.agent.name;
      const state = run.states.get(name);
      if (!state || running.has(name) || state.status === 'stopped' || state.status === 'failed') {
        continue;
      }
      if (state.turns >= this.config.maxTurnsPerMember) continue;
      const turn = this.memberTurn(run, name, !leadBusy);
      if (turn) {
        turns.push(turn);
        capacity--;
      }
    }

    return turns;
  }

  /**
   * Why a member would take a turn now: the task it works on, a task it can claim (claimed for
   * it here, so two members never get the same one), or messages in its mailbox. Unassigned
   * tasks wait while the lead is in a turn, which may still assign them.
   */
  private memberTurn(run: RunState, member: string, selfClaim: boolean): Turn | undefined {
    const working = run.board.listTasks({ owner: member, status: 'in_progress' })[0];
    if (working) return { agent: member, role: 'member', reason: 'task', taskId: working.id };

    const claimable = run.board
      .claimableBy(member)
      .find((task) => selfClaim || task.owner === member);
    if (claimable) {
      const claimed = run.board.claimTask(member, claimable.id);
      return { agent: member, role: 'member', reason: 'task', taskId: claimed.id };
    }

    if (run.mailbox.hasUnread(member)) return { agent: member, role: 'member', reason: 'message' };
    return undefined;
  }

  /** Run one turn: the result, or undefined for a member whose failure the run tolerates */
  private async takeTurn(run: RunState, turn: Turn): Promise<RunResult | undefined> {
    const state = run.states.get(turn.agent);
    if (!state) throw new Error(`${turn.agent} is not in the team`);
    state.turns++;
    state.status = 'working';
    if (turn.taskId !== undefined) {
      turn.continued = state.currentTask === turn.taskId;
      state.currentTask = turn.taskId;
    }
    if (turn.role === 'lead') run.leadTurns++;
    else run.memberTurns++;

    this.coordinator.events.emit(
      'team:member-started',
      {
        member: turn.agent,
        role: turn.role,
        turn: state.turns,
        reason: turn.reason,
        ...(turn.taskId !== undefined && { taskId: turn.taskId }),
      },
      turn.agent
    );

    const input =
      turn.role === 'lead' ? this.leadInput(run, turn.reason) : this.memberInput(run, turn);
    const context = {
      ...run.context,
      team: {
        role: turn.role,
        lead: run.lead.agent.name,
        members: run.members.map((member) => member.agent.name),
        turn: state.turns,
        reason: turn.reason,
      },
    };

    try {
      const result = await this.coordinator.runAgent(turn.agent, input, context);
      run.agentResults.set(turn.agent, result);
      if (turn.role === 'lead') run.lastLeadResult = result;

      const exhausted = turn.role === 'member' && state.turns >= this.config.maxTurnsPerMember;
      if (exhausted) {
        run.board.releaseTasksOf(
          turn.agent,
          `${turn.agent} used all its ${this.config.maxTurnsPerMember} turns`
        );
      }
      state.status = exhausted ? 'stopped' : 'idle';
      this.refreshCurrentTask(run, state);
      this.emitFinished(turn, state, { output: result.output.slice(0, OUTPUT_PREVIEW) });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.status = 'failed';
      state.error = message;
      const recoverable =
        turn.role === 'member' && this.tolerateFailures && !(error instanceof AgentRunPausedError);
      if (recoverable) run.board.releaseTasksOf(turn.agent, `${turn.agent} failed: ${message}`);
      this.refreshCurrentTask(run, state);
      this.emitFinished(turn, state, { error: message });
      if (!recoverable) throw error;
      return undefined;
    }
  }

  private refreshCurrentTask(run: RunState, state: TeamMemberState): void {
    const working = run.board.listTasks({ owner: state.name, status: 'in_progress' })[0];
    if (working) state.currentTask = working.id;
    else delete state.currentTask;
  }

  private emitFinished(
    turn: Turn,
    state: TeamMemberState,
    outcome: { output?: string; error?: string }
  ): void {
    this.coordinator.events.emit(
      'team:member-finished',
      {
        member: turn.agent,
        role: turn.role,
        turn: state.turns,
        reason: turn.reason,
        status: state.status,
        ...outcome,
      },
      turn.agent
    );
  }

  private stopReason(run: RunState): TeamStopReason {
    const tasks = run.board.listTasks();
    if (tasks.length === 0) return 'no-tasks';
    if (run.board.isComplete()) return 'completed';
    const outOfTurns =
      run.leadTurns >= this.config.maxLeadTurns ||
      [...run.states.values()].some((state) => state.status === 'stopped');
    return outOfTurns ? 'turn-limit' : 'stalled';
  }

  private leadInput(run: RunState, reason: TeamTurnReason): string {
    const inbox = renderTeamMessages(run.mailbox.take(run.lead.agent.name));
    const board = renderBoard(run.board.listTasks(), run.board);

    switch (reason) {
      case 'start':
        return [
          run.input,
          '',
          this.leadBriefing(run),
          ...(run.board.listTasks().length > 0 ? ['', board] : []),
          ...(inbox ? ['', inbox] : []),
        ].join('\n');

      case 'message':
        return [
          `Your team is working on: ${run.input}`,
          '',
          inbox,
          '',
          board,
          '',
          'Answer what needs an answer with send_message, and change the task list if the plan has to change. Keep this turn short: the members go on when it ends.',
        ].join('\n');

      case 'stalled':
        return [
          `Your team is working on: ${run.input}`,
          '',
          `The team cannot go on: ${this.stallReasons(run).join(' ')}`,
          '',
          board,
          ...(inbox ? ['', inbox] : []),
          '',
          'Assign the tasks that wait, release or complete the ones that cannot be done, or end your turn to finish with what the team has.',
        ].join('\n');

      default:
        return [
          `The team finished working on: ${run.input}`,
          '',
          renderResults(run.board.listTasks()),
          ...(inbox ? ['', inbox] : []),
          '',
          'Write the final answer to the request from these results. Do not create tasks: the team does not work any more.',
        ].join('\n');
    }
  }

  private leadBriefing(run: RunState): string {
    const roster = run.members
      .map((member) => {
        const config = member.agent.config;
        const about = config.description ?? config.instructions.slice(0, 200);
        const expertise = member.metadata.expertise?.length
          ? ` (expertise: ${member.metadata.expertise.join(', ')})`
          : '';
        return `- ${member.agent.name}: ${about}${expertise}`;
      })
      .join('\n');
    const claiming = this.config.selfClaim
      ? 'Assign a task with assign_task (or the assignee of create_task), or leave it unassigned: an idle member takes the next unassigned task that is not blocked.'
      : 'Assign every task with assign_task (or the assignee of create_task): members only work on the tasks you assign.';

    return [
      'You lead a team. Its members:',
      roster,
      '',
      'Plan the work as tasks on the shared task list with create_task, each small enough for one member. A task waits until the tasks in its dependsOn are completed.',
      claiming,
      'A member starts on a task as soon as it is assigned to it, unassigned tasks wait until your turn ends. Members report through their task results and send_message, and you get a turn again when they message you. Once every task is completed you write the final answer from their results.',
      'If the request needs no team, answer it now without creating tasks.',
    ].join('\n');
  }

  private stallReasons(run: RunState): string[] {
    const stopped = new Set(
      [...run.states.values()]
        .filter((state) => state.status === 'stopped' || state.status === 'failed')
        .map((state) => state.name)
    );
    return run.board
      .listTasks()
      .filter((task) => task.status !== 'completed')
      .map((task) => {
        const blockers = run.board.blockers(task.id);
        if (task.status === 'in_progress') return `${task.id} is in progress by ${task.owner}.`;
        if (blockers.length > 0) return `${task.id} waits for ${blockers.join(', ')}.`;
        if (task.owner && stopped.has(task.owner)) {
          return `${task.id} is assigned to ${task.owner}, who cannot work any more.`;
        }
        if (task.owner) return `${task.id} is assigned to ${task.owner}, who has no turns left.`;
        return this.config.selfClaim
          ? `${task.id} is unassigned and no member can take it.`
          : `${task.id} is unassigned, and members only work on the tasks you assign.`;
      });
  }

  private memberInput(run: RunState, turn: Turn): string {
    const lines: string[] = [
      `You are ${turn.agent}, a member of a team led by ${run.lead.agent.name}. The team works on: ${run.input}`,
      '',
    ];

    const task = turn.taskId !== undefined ? run.board.getTask(turn.taskId) : undefined;
    if (task) {
      lines.push(`Your task is ${task.id}: ${task.title}`);
      if (turn.continued) {
        lines.push('You worked on it in an earlier turn and have not completed it yet.');
      }
      if (task.description) lines.push(task.description);
      if (task.note) lines.push(`Note: ${task.note}`);
      const done = task.dependsOn
        .map((id) => run.board.getTask(id))
        .filter((dependency): dependency is TeamTask => dependency?.status === 'completed');
      if (done.length > 0) {
        lines.push('', 'Results of the tasks it builds on:');
        for (const dependency of done) {
          lines.push(
            `- ${dependency.id} (${dependency.title}, by ${dependency.owner ?? dependency.createdBy}): ${dependency.result ?? 'no result given'}`
          );
        }
      }
      lines.push(
        '',
        `When it is done, call update_task with taskId "${task.id}", status "completed" and your result. If you cannot finish it, call update_task with status "pending" and a note. Then claim_task takes the next task, or end your turn.`
      );
    } else {
      lines.push('You have no task right now: read the messages below and answer what needs it.');
    }

    const inbox = renderTeamMessages(run.mailbox.take(turn.agent));
    if (inbox) lines.push('', inbox);
    lines.push(
      '',
      `Use send_message to ask a teammate or the lead (${run.lead.agent.name}), and list_tasks to see the whole task list.`
    );
    return lines.join('\n');
  }
}

const MARKS: Record<TeamTask['status'], string> = {
  pending: '[ ]',
  in_progress: '[>]',
  completed: '[x]',
};

/** The task list as an agent reads it: a line per task with its status mark, owner and blockers */
export function renderBoard(tasks: readonly TeamTask[], board?: TeamTaskBoard): string {
  if (tasks.length === 0) return 'Task list: empty.';
  const done = tasks.filter((task) => task.status === 'completed').length;
  return [
    `Task list (${done} of ${tasks.length} completed):`,
    ...tasks.map((task) => {
      const owner = task.owner
        ? ` (${task.owner})`
        : task.status === 'pending'
          ? ' (unassigned)'
          : '';
      const blockers = task.status === 'pending' && board ? board.blockers(task.id) : [];
      const waits = blockers.length > 0 ? `, waits for ${blockers.join(', ')}` : '';
      const result =
        task.status === 'completed' && task.result
          ? ` - ${preview(task.result, RESULT_PREVIEW)}`
          : '';
      return `${MARKS[task.status]} ${task.id}: ${task.title}${owner}${waits}${result}`;
    }),
  ].join('\n');
}

/** Every task with its full result, the material of the final answer */
export function renderResults(tasks: readonly TeamTask[]): string {
  if (tasks.length === 0) return 'The team had no tasks.';
  return tasks
    .map((task) => {
      const by = task.owner ? `, by ${task.owner}` : '';
      const status =
        task.status === 'completed'
          ? 'completed'
          : task.status === 'in_progress'
            ? 'in progress'
            : 'not done';
      const body = task.result ?? task.note ?? 'no result';
      return `## ${task.id}: ${task.title} (${status}${by})\n${body}`;
    })
    .join('\n\n');
}

function preview(text: string, length: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length)}...` : flat;
}
