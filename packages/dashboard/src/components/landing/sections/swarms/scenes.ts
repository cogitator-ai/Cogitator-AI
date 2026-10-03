export type StrategyId =
  'hierarchical' | 'round-robin' | 'consensus' | 'auction' | 'pipeline' | 'debate' | 'negotiation';

export type Tone = 'accent' | 'info' | 'warn' | 'danger' | 'violet' | 'muted';

export type NodeStatus = 'idle' | 'done' | 'won' | 'out';

export type MarkSide = 'top' | 'bottom' | 'left' | 'right';

export interface TopologyNode {
  id: string;
  label: string;
  /** Model id for agents, a short subtitle for hubs */
  sub?: string;
  /** Swarm role or other short tag shown next to the name */
  tag?: string;
  /** Position in percent of the stage */
  x: number;
  y: number;
  kind?: 'agent' | 'hub';
  markSide?: MarkSide;
}

export interface Pulse {
  from: string;
  to: string;
  label?: string;
  tone?: Tone;
  /** Seconds to wait before the pulse leaves */
  delay?: number;
}

export interface Mark {
  text: string;
  tone: Tone;
}

export interface LogLine {
  /** A real swarm event name, a tool call or `output` */
  name: string;
  detail?: string;
  tone?: Tone;
}

export interface Beat {
  ms: number;
  pulses?: Pulse[];
  /** Agents running during this beat */
  running?: string[];
  /** Status changes that persist into later beats */
  status?: Record<string, NodeStatus>;
  /** Annotations that persist into later beats; `null` clears one */
  marks?: Record<string, Mark | null>;
  log?: LogLine[];
  /** A vox status line that persists into later beats; `null` clears it */
  vox?: VoxLine | null;
}

export interface VoxLine {
  text: string;
  tone: 'accent' | 'warn' | 'brass' | 'muted';
}

export interface StrategyScene {
  id: StrategyId;
  file: string;
  description: string;
  nodes: TopologyNode[];
  edges: [string, string][];
  beats: Beat[];
}

const rrAssigned = (agent: string, index: number): LogLine => ({
  name: 'round-robin:assigned',
  detail: `{ agent: '${agent}', index: ${index} }`,
});

/**
 * One scene per strategy. Each replays what the strategy in `@cogitator-ai/swarms` does with the
 * config shown next to it, using the events it emits and the tools it gives its agents.
 */
export const SCENES: StrategyScene[] = [
  {
    id: 'hierarchical',
    file: 'feature-team.ts',
    description:
      'A supervisor splits the task and hands pieces to workers with the delegate_task tool. Results flow back up to it.',
    nodes: [
      { id: 'lead', label: 'lead', tag: 'supervisor', sub: 'claude-opus-5-5', x: 50, y: 20 },
      { id: 'frontend', label: 'frontend', tag: 'worker', sub: 'gemini-3.5-flash', x: 17, y: 76 },
      { id: 'backend', label: 'backend', tag: 'worker', sub: 'claude-sonnet-5-5', x: 50, y: 76 },
      { id: 'devops', label: 'devops', tag: 'worker', sub: 'llama3.2', x: 83, y: 76 },
    ],
    edges: [
      ['lead', 'frontend'],
      ['lead', 'backend'],
      ['lead', 'devops'],
    ],
    beats: [
      {
        ms: 700,
        running: ['lead'],
        log: [{ name: 'agent:start', detail: 'lead' }],
      },
      {
        ms: 1000,
        running: ['lead'],
        pulses: [
          { from: 'lead', to: 'frontend', label: 'delegate_task', tone: 'info' },
          { from: 'lead', to: 'backend', tone: 'info', delay: 0.12 },
        ],
        log: [
          { name: 'delegate_task', detail: "{ worker: 'frontend' }", tone: 'violet' },
          { name: 'delegate_task', detail: "{ worker: 'backend' }", tone: 'violet' },
        ],
      },
      {
        ms: 900,
        running: ['lead', 'frontend', 'backend'],
        log: [{ name: 'agent:start', detail: 'frontend, backend' }],
      },
      {
        ms: 900,
        running: ['lead'],
        status: { frontend: 'done', backend: 'done' },
        pulses: [
          { from: 'frontend', to: 'lead', label: 'output', tone: 'accent' },
          { from: 'backend', to: 'lead', tone: 'accent', delay: 0.15 },
        ],
        log: [{ name: 'agent:complete', detail: 'frontend, backend' }],
      },
      {
        ms: 1000,
        running: ['lead', 'devops'],
        pulses: [{ from: 'lead', to: 'devops', label: 'delegate_task', tone: 'info' }],
        log: [{ name: 'delegate_task', detail: "{ worker: 'devops' }", tone: 'violet' }],
      },
      {
        ms: 800,
        running: ['lead'],
        status: { devops: 'done' },
        pulses: [{ from: 'devops', to: 'lead', label: 'output', tone: 'accent' }],
        log: [{ name: 'agent:complete', detail: 'devops' }],
      },
      {
        ms: 1500,
        status: { lead: 'won' },
        marks: { lead: { text: 'final answer', tone: 'accent' } },
        vox: { text: 'transmission complete', tone: 'accent' },
        log: [{ name: 'swarm:complete', detail: '4 agents', tone: 'accent' }],
      },
    ],
  },
  {
    id: 'round-robin',
    file: 'support-desk.ts',
    description:
      'Each run goes to the next agent in the rotation. With sticky routing, a returning key lands on the agent that served it first.',
    nodes: [
      { id: 'in', label: 'desk.run()', sub: 'incoming runs', x: 50, y: 18, kind: 'hub' },
      { id: 'ada', label: 'ada', sub: 'claude-sonnet-5-5', x: 17, y: 74 },
      { id: 'ben', label: 'ben', sub: 'gpt-5.5', x: 50, y: 74 },
      { id: 'cy', label: 'cy', sub: 'gemini-3.5-flash', x: 83, y: 74 },
    ],
    edges: [
      ['in', 'ada'],
      ['in', 'ben'],
      ['in', 'cy'],
    ],
    beats: [
      {
        ms: 1000,
        running: ['ada'],
        pulses: [{ from: 'in', to: 'ada', label: 'acme', tone: 'info' }],
        marks: { ada: { text: 'acme', tone: 'info' } },
        log: [rrAssigned('ada', 0)],
      },
      {
        ms: 1000,
        running: ['ben'],
        status: { ada: 'done' },
        pulses: [{ from: 'in', to: 'ben', label: 'globex', tone: 'info' }],
        marks: { ben: { text: 'globex', tone: 'info' } },
        log: [rrAssigned('ben', 1)],
      },
      {
        ms: 1200,
        running: ['ada'],
        status: { ben: 'done', ada: 'idle' },
        pulses: [{ from: 'in', to: 'ada', label: 'acme', tone: 'warn' }],
        marks: { ada: { text: 'acme · sticky', tone: 'warn' } },
        vox: { text: 'sticky route held', tone: 'brass' },
        log: [{ ...rrAssigned('ada', 0), tone: 'warn' }],
      },
      {
        ms: 1000,
        running: ['cy'],
        status: { ada: 'done' },
        pulses: [{ from: 'in', to: 'cy', label: 'initech', tone: 'info' }],
        marks: { cy: { text: 'initech', tone: 'info' } },
        vox: null,
        log: [rrAssigned('cy', 2)],
      },
      {
        ms: 1600,
        status: { cy: 'done' },
        log: [{ name: 'rotation', detail: 'next new key → ada', tone: 'muted' }],
      },
    ],
  },
  {
    id: 'consensus',
    file: 'release-review.ts',
    description:
      'Every agent votes each round. Weighted votes are tallied on the blackboard until one answer clears the threshold.',
    nodes: [
      {
        id: 'security',
        label: 'security',
        tag: 'weight 2',
        sub: 'claude-opus-5-5',
        x: 18,
        y: 22,
        markSide: 'bottom',
      },
      { id: 'perf', label: 'perf', sub: 'gpt-5.5', x: 82, y: 22, markSide: 'bottom' },
      { id: 'product', label: 'product', sub: 'gemini-3.5-flash', x: 50, y: 84, markSide: 'right' },
      {
        id: 'board',
        label: 'blackboard',
        sub: 'votes',
        x: 50,
        y: 46,
        kind: 'hub',
        markSide: 'right',
      },
    ],
    edges: [
      ['security', 'board'],
      ['perf', 'board'],
      ['product', 'board'],
    ],
    beats: [
      { ms: 600, log: [{ name: 'consensus:round', detail: '{ round: 1, total: 3 }' }] },
      {
        ms: 700,
        running: ['security'],
        pulses: [{ from: 'security', to: 'board', label: 'hold', tone: 'warn' }],
        marks: { security: { text: 'hold', tone: 'warn' } },
        log: [{ name: 'consensus:turn', detail: 'security · VOTE: hold', tone: 'warn' }],
      },
      {
        ms: 650,
        running: ['perf'],
        pulses: [{ from: 'perf', to: 'board', label: 'ship', tone: 'accent' }],
        marks: { perf: { text: 'ship', tone: 'accent' } },
        log: [{ name: 'consensus:turn', detail: 'perf · VOTE: ship' }],
      },
      {
        ms: 650,
        running: ['product'],
        pulses: [{ from: 'product', to: 'board', label: 'ship', tone: 'accent' }],
        marks: { product: { text: 'ship', tone: 'accent' } },
        log: [{ name: 'consensus:turn', detail: 'product · VOTE: ship' }],
      },
      {
        ms: 900,
        marks: { board: { text: 'ship 2 · hold 2 — tie', tone: 'warn' } },
        vox: { text: 'no consensus · round 2', tone: 'warn' },
        log: [{ name: 'no consensus', detail: 'weighted tie, next round', tone: 'warn' }],
      },
      {
        ms: 650,
        marks: { security: null, perf: null, product: null, board: null },
        vox: null,
        log: [{ name: 'consensus:round', detail: '{ round: 2, total: 3 }' }],
      },
      {
        ms: 700,
        running: ['security', 'perf', 'product'],
        pulses: [
          { from: 'security', to: 'board', label: 'ship', tone: 'accent' },
          { from: 'perf', to: 'board', tone: 'accent', delay: 0.18 },
          { from: 'product', to: 'board', tone: 'accent', delay: 0.36 },
        ],
        marks: {
          security: { text: 'ship', tone: 'accent' },
          perf: { text: 'ship', tone: 'accent' },
          product: { text: 'ship', tone: 'accent' },
        },
        log: [
          { name: 'consensus:turn', detail: 'security · VOTE: ship' },
          { name: 'consensus:turn', detail: 'perf · VOTE: ship' },
          { name: 'consensus:turn', detail: 'product · VOTE: ship' },
        ],
      },
      {
        ms: 1500,
        status: { security: 'done', perf: 'done', product: 'done', board: 'won' },
        vox: { text: 'consensus reached', tone: 'accent' },
        marks: { board: { text: 'ship 4/4 ≥ 0.66', tone: 'accent' } },
        log: [
          {
            name: 'consensus:reached',
            detail: "{ round: 2, decision: 'ship' }",
            tone: 'accent',
          },
        ],
      },
    ],
  },
  {
    id: 'auction',
    file: 'task-market.ts',
    description:
      'Agents rate their own fit for the task, bids under minBid are dropped, and the highest bidder does the work.',
    nodes: [
      { id: 'hub', label: 'auction', sub: 'blackboard', x: 50, y: 20, kind: 'hub' },
      {
        id: 'sql-expert',
        label: 'sql-expert',
        tag: 'sql, postgres',
        sub: 'claude-sonnet-5-5',
        x: 17,
        y: 74,
      },
      { id: 'analyst', label: 'analyst', sub: 'gpt-5.5', x: 50, y: 74 },
      { id: 'generalist', label: 'generalist', sub: 'llama3.2', x: 83, y: 74 },
    ],
    edges: [
      ['hub', 'sql-expert'],
      ['hub', 'analyst'],
      ['hub', 'generalist'],
    ],
    beats: [
      {
        ms: 900,
        running: ['sql-expert', 'analyst', 'generalist'],
        pulses: [
          { from: 'hub', to: 'sql-expert', tone: 'muted' },
          { from: 'hub', to: 'analyst', label: 'bid prompt', tone: 'muted' },
          { from: 'hub', to: 'generalist', tone: 'muted' },
        ],
        log: [{ name: 'auction:start', detail: '{ participants: 3 }' }],
      },
      {
        ms: 1100,
        pulses: [
          { from: 'sql-expert', to: 'hub', label: '0.91', tone: 'accent' },
          { from: 'analyst', to: 'hub', label: '0.64', tone: 'info', delay: 0.1 },
          { from: 'generalist', to: 'hub', label: '0.22', tone: 'muted', delay: 0.2 },
        ],
        marks: {
          'sql-expert': { text: 'SCORE: 0.91', tone: 'accent' },
          analyst: { text: 'SCORE: 0.64', tone: 'info' },
          generalist: { text: 'SCORE: 0.22', tone: 'muted' },
        },
        log: [
          { name: 'auction:bid', detail: 'sql-expert 0.91' },
          { name: 'auction:bid', detail: 'analyst 0.64' },
          { name: 'auction:bid', detail: 'generalist 0.22' },
        ],
      },
      {
        ms: 900,
        status: { generalist: 'out' },
        marks: { generalist: { text: '0.22 < minBid', tone: 'danger' } },
        log: [{ name: 'minBid 0.3', detail: 'generalist dropped', tone: 'danger' }],
      },
      {
        ms: 900,
        status: { 'sql-expert': 'won' },
        vox: { text: 'contract awarded', tone: 'brass' },
        log: [
          {
            name: 'auction:winner',
            detail: "{ winner: 'sql-expert', score: 0.91 }",
            tone: 'accent',
          },
        ],
      },
      {
        ms: 1000,
        running: ['sql-expert'],
        pulses: [{ from: 'hub', to: 'sql-expert', label: 'task', tone: 'accent' }],
        log: [{ name: 'agent:start', detail: 'sql-expert' }],
      },
      {
        ms: 1400,
        pulses: [{ from: 'sql-expert', to: 'hub', label: 'output', tone: 'accent' }],
        vox: { text: 'task complete', tone: 'accent' },
        log: [{ name: 'auction:complete', detail: "{ winner: 'sql-expert' }", tone: 'accent' }],
      },
    ],
  },
  {
    id: 'pipeline',
    file: 'content.ts',
    description:
      'Stages run in order and pass their output forward. A gate stage can send the work back to the stage before it.',
    nodes: [
      { id: 'research', label: 'research', sub: 'gemini-3.5-flash', x: 17, y: 30 },
      { id: 'draft', label: 'draft', sub: 'claude-sonnet-5-5', x: 50, y: 30 },
      {
        id: 'review',
        label: 'review',
        tag: 'gate',
        sub: 'claude-opus-5-5',
        x: 83,
        y: 30,
        markSide: 'bottom',
      },
      { id: 'out', label: 'output', sub: 'pipelineOutputs', x: 83, y: 82, kind: 'hub' },
    ],
    edges: [
      ['research', 'draft'],
      ['draft', 'review'],
      ['review', 'out'],
    ],
    beats: [
      {
        ms: 800,
        running: ['research'],
        log: [{ name: 'pipeline:stage', detail: "{ index: 0, name: 'research' }" }],
      },
      {
        ms: 850,
        running: ['draft'],
        status: { research: 'done' },
        pulses: [{ from: 'research', to: 'draft', label: 'brief', tone: 'info' }],
        log: [{ name: 'pipeline:stage', detail: "{ index: 1, name: 'draft' }" }],
      },
      {
        ms: 850,
        running: ['review'],
        status: { draft: 'done' },
        pulses: [{ from: 'draft', to: 'review', label: 'draft v1', tone: 'info' }],
        log: [{ name: 'pipeline:stage', detail: "{ index: 2, name: 'review' }" }],
      },
      {
        ms: 1100,
        running: ['draft'],
        status: { draft: 'idle' },
        pulses: [{ from: 'review', to: 'draft', label: 'retry-previous', tone: 'danger' }],
        marks: { review: { text: 'gate failed', tone: 'danger' } },
        vox: { text: 'gate failed · retrying draft', tone: 'warn' },
        log: [{ name: 'pipeline:gate:fail', detail: "{ stage: 'review' }", tone: 'danger' }],
      },
      {
        ms: 850,
        running: ['review'],
        status: { draft: 'done' },
        pulses: [{ from: 'draft', to: 'review', label: 'draft v2', tone: 'info' }],
        marks: { review: null },
        vox: null,
        log: [{ name: 'pipeline:stage', detail: "{ index: 2, name: 'review' }" }],
      },
      {
        ms: 800,
        status: { review: 'won' },
        marks: { review: { text: 'APPROVED', tone: 'accent' } },
        vox: { text: 'gate sanctioned', tone: 'accent' },
        log: [{ name: 'pipeline:gate:pass', detail: "{ stage: 'review' }", tone: 'accent' }],
      },
      {
        ms: 1300,
        status: { out: 'won' },
        pulses: [{ from: 'review', to: 'out', label: 'article', tone: 'accent' }],
        log: [{ name: 'swarm:complete', detail: '3 stages, 1 retry', tone: 'accent' }],
      },
    ],
  },
  {
    id: 'debate',
    file: 'build-vs-buy.ts',
    description:
      'An advocate and a critic argue for a fixed number of rounds, each seeing the other’s points. A moderator turns the transcript into a verdict.',
    nodes: [
      {
        id: 'advocate',
        label: 'advocate',
        tag: 'advocate',
        sub: 'claude-sonnet-5-5',
        x: 17,
        y: 26,
      },
      { id: 'critic', label: 'critic', tag: 'critic', sub: 'gpt-5.5', x: 83, y: 26 },
      {
        id: 'moderator',
        label: 'moderator',
        tag: 'moderator',
        sub: 'claude-opus-5-5',
        x: 50,
        y: 80,
        markSide: 'right',
      },
    ],
    edges: [
      ['advocate', 'critic'],
      ['advocate', 'moderator'],
      ['critic', 'moderator'],
    ],
    beats: [1, 2, 3]
      .flatMap((round): Beat[] => [
        {
          ms: 650,
          running: ['advocate'],
          pulses: [{ from: 'advocate', to: 'critic', label: 'for', tone: 'info' }],
          log: [
            { name: 'debate:round', detail: `{ round: ${round}, total: 3 }` },
            { name: 'debate:turn', detail: 'advocate' },
          ],
        },
        {
          ms: 650,
          running: ['critic'],
          pulses: [{ from: 'critic', to: 'advocate', label: 'against', tone: 'warn' }],
          log: [{ name: 'debate:turn', detail: 'critic' }],
        },
      ])
      .concat([
        {
          ms: 1000,
          running: ['moderator'],
          status: { advocate: 'done', critic: 'done' },
          pulses: [
            { from: 'advocate', to: 'moderator', label: 'transcript', tone: 'violet' },
            { from: 'critic', to: 'moderator', tone: 'violet', delay: 0.1 },
          ],
          log: [{ name: 'agent:start', detail: 'moderator · 6 turns' }],
        },
        {
          ms: 1300,
          status: { moderator: 'won' },
          marks: { moderator: { text: 'verdict', tone: 'accent' } },
          vox: { text: 'verdict rendered', tone: 'accent' },
          log: [{ name: 'swarm:complete', detail: 'output from moderator', tone: 'accent' }],
        },
      ]),
  },
  {
    id: 'negotiation',
    file: 'license-deal.ts',
    description:
      'Agents trade structured offers through negotiation tools while convergence is tracked, until one side accepts or the deadlock rule decides.',
    nodes: [
      { id: 'buyer', label: 'buyer', sub: 'gpt-5.5', x: 17, y: 30 },
      { id: 'seller', label: 'seller', sub: 'claude-sonnet-5-5', x: 83, y: 30 },
      {
        id: 'board',
        label: 'blackboard',
        sub: 'offers',
        x: 50,
        y: 80,
        kind: 'hub',
        markSide: 'right',
      },
    ],
    edges: [
      ['buyer', 'seller'],
      ['buyer', 'board'],
      ['seller', 'board'],
    ],
    beats: [
      {
        ms: 800,
        running: ['buyer', 'seller'],
        pulses: [
          { from: 'buyer', to: 'board', label: 'declare_interests', tone: 'muted' },
          { from: 'seller', to: 'board', tone: 'muted', delay: 0.3 },
        ],
        log: [{ name: 'negotiation:phase-change', detail: "{ phase: 'initialization' }" }],
      },
      {
        ms: 800,
        running: ['buyer'],
        pulses: [{ from: 'buyer', to: 'seller', label: 'make_offer $30k', tone: 'info' }],
        marks: { buyer: { text: '$30k', tone: 'info' } },
        log: [
          { name: 'negotiation:round', detail: '{ round: 1, maxRounds: 6 }' },
          { name: 'negotiation:offer-made', detail: 'buyer → seller · $30k' },
        ],
      },
      {
        ms: 850,
        running: ['seller'],
        pulses: [{ from: 'seller', to: 'buyer', label: 'counter_offer $65k', tone: 'warn' }],
        marks: {
          seller: { text: '$65k', tone: 'warn' },
          board: { text: 'convergence 18%', tone: 'muted' },
        },
        log: [
          { name: 'negotiation:offer-made', detail: 'seller → buyer · $65k' },
          { name: 'negotiation:convergence-update', detail: '{ round: 1 } · 18%' },
        ],
      },
      {
        ms: 800,
        running: ['buyer'],
        pulses: [{ from: 'buyer', to: 'seller', label: 'make_offer $38k', tone: 'info' }],
        marks: { buyer: { text: '$38k', tone: 'info' } },
        log: [
          { name: 'negotiation:round', detail: '{ round: 2, maxRounds: 6 }' },
          { name: 'negotiation:offer-made', detail: 'buyer → seller · $38k' },
        ],
      },
      {
        ms: 850,
        running: ['seller'],
        pulses: [{ from: 'seller', to: 'buyer', label: 'counter_offer $52k', tone: 'warn' }],
        marks: {
          seller: { text: '$52k', tone: 'warn' },
          board: { text: 'convergence 64%', tone: 'info' },
        },
        log: [
          { name: 'negotiation:offer-made', detail: 'seller → buyer · $52k' },
          { name: 'negotiation:convergence-update', detail: '{ round: 2 } · 64%' },
        ],
      },
      {
        ms: 800,
        running: ['buyer'],
        pulses: [{ from: 'buyer', to: 'seller', label: 'make_offer $46k', tone: 'info' }],
        marks: { buyer: { text: '$46k', tone: 'info' } },
        log: [
          { name: 'negotiation:round', detail: '{ round: 3, maxRounds: 6 }' },
          { name: 'negotiation:offer-made', detail: 'buyer → seller · $46k' },
        ],
      },
      {
        ms: 1500,
        status: { buyer: 'won', seller: 'won', board: 'won' },
        vox: { text: 'agreement reached', tone: 'accent' },
        pulses: [{ from: 'seller', to: 'buyer', label: 'accept_offer', tone: 'accent' }],
        marks: {
          seller: { text: '$46k', tone: 'accent' },
          buyer: { text: '$46k', tone: 'accent' },
          board: { text: 'agreement', tone: 'accent' },
        },
        log: [
          { name: 'negotiation:offer-accepted', detail: 'seller' },
          { name: 'negotiation:agreement-reached', detail: '$46k / year', tone: 'accent' },
        ],
      },
    ],
  },
];

export interface SceneState {
  status: Record<string, NodeStatus>;
  marks: Record<string, Mark>;
  log: LogLine[];
  vox?: VoxLine;
}

/** Fold the persistent parts of every beat up to `beat` into one state. */
export function sceneStateAt(scene: StrategyScene, beat: number): SceneState {
  const status: Record<string, NodeStatus> = {};
  const marks: Record<string, Mark> = {};
  const log: LogLine[] = [];
  let vox: VoxLine | undefined;
  for (const current of scene.beats.slice(0, beat + 1)) {
    Object.assign(status, current.status);
    for (const [id, mark] of Object.entries(current.marks ?? {})) {
      if (mark) marks[id] = mark;
      else delete marks[id];
    }
    log.push(...(current.log ?? []));
    if (current.vox !== undefined) vox = current.vox ?? undefined;
  }
  return { status, marks, log, vox };
}
