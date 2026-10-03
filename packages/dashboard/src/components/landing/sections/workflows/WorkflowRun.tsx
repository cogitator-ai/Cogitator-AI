'use client';

import { AnimatePresence, LazyMotion, domMax, m, useReducedMotion } from 'framer-motion';
import { useOnScreen } from '../../playback';
import { Check, Pause, RotateCcw, Unplug } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Badge, Vox, Window, cx } from '../../ui';
import { paced } from '../../pace';

type NodeId = 'research' | 'draft' | 'fact-check' | 'review' | 'publish';
type NodeKind = 'agent' | 'human' | 'fn';
type NodeState = 'idle' | 'running' | 'done' | 'restored' | 'lost' | 'waiting' | 'approved';
type RunStatus = 'running' | 'interrupted' | 'resumed' | 'waiting' | 'completed';
type Tone = 'muted' | 'accent' | 'danger' | 'info' | 'warn';

interface Point {
  x: number;
  y: number;
}

interface Step {
  duration: number;
  status: RunStatus;
  nodes: Partial<Record<NodeId, NodeState>>;
  flow: string[];
  checkpoints: number;
}

interface LogEntry {
  at: number;
  time: string;
  text: string;
  tone: Tone;
}

const EASE = [0.16, 1, 0.3, 1] as const;
const NODE_W = 128;
const NODE_H = 44;
const VIEW_W = 360;
const VIEW_H = 336;
const RUN_ID = 'wf_k3Fq9ZbT2mXa';

const NODES: Record<NodeId, Point & { kind: NodeKind; took?: string }> = {
  research: { x: 116, y: 14, kind: 'agent', took: '3.2s' },
  draft: { x: 28, y: 102, kind: 'agent', took: '4.1s' },
  'fact-check': { x: 204, y: 102, kind: 'agent', took: '2.9s' },
  review: { x: 116, y: 190, kind: 'human' },
  publish: { x: 116, y: 278, kind: 'fn', took: '0.6s' },
};

const NODE_ORDER: NodeId[] = ['research', 'draft', 'fact-check', 'review', 'publish'];

const EDGES: { id: string; from: NodeId; to: NodeId; points: Point[] }[] = [
  {
    id: 'research>draft',
    from: 'research',
    to: 'draft',
    points: [
      { x: 180, y: 58 },
      { x: 180, y: 80 },
      { x: 92, y: 80 },
      { x: 92, y: 102 },
    ],
  },
  {
    id: 'research>fact-check',
    from: 'research',
    to: 'fact-check',
    points: [
      { x: 180, y: 58 },
      { x: 180, y: 80 },
      { x: 268, y: 80 },
      { x: 268, y: 102 },
    ],
  },
  {
    id: 'draft>review',
    from: 'draft',
    to: 'review',
    points: [
      { x: 92, y: 146 },
      { x: 92, y: 168 },
      { x: 180, y: 168 },
      { x: 180, y: 190 },
    ],
  },
  {
    id: 'fact-check>review',
    from: 'fact-check',
    to: 'review',
    points: [
      { x: 268, y: 146 },
      { x: 268, y: 168 },
      { x: 180, y: 168 },
      { x: 180, y: 190 },
    ],
  },
  {
    id: 'review>publish',
    from: 'review',
    to: 'publish',
    points: [
      { x: 180, y: 234 },
      { x: 180, y: 278 },
    ],
  },
];

/**
 * One run of the publish-post pipeline with per-node checkpoints: the worker dies while
 * fact-check is in flight, `resume()` skips the checkpointed nodes, and the human review
 * holds the run until it is approved.
 */
const STEPS: Step[] = [
  { duration: 1500, status: 'running', nodes: { research: 'running' }, flow: [], checkpoints: 0 },
  {
    duration: 1700,
    status: 'running',
    nodes: { research: 'done', draft: 'running', 'fact-check': 'running' },
    flow: ['research>draft', 'research>fact-check'],
    checkpoints: 1,
  },
  {
    duration: 1100,
    status: 'running',
    nodes: { research: 'done', draft: 'done', 'fact-check': 'running' },
    flow: [],
    checkpoints: 2,
  },
  {
    duration: 1800,
    status: 'interrupted',
    nodes: { research: 'done', draft: 'done', 'fact-check': 'lost' },
    flow: [],
    checkpoints: 2,
  },
  {
    duration: 1700,
    status: 'resumed',
    nodes: { research: 'restored', draft: 'restored', 'fact-check': 'running' },
    flow: [],
    checkpoints: 2,
  },
  {
    duration: 2800,
    status: 'waiting',
    nodes: { research: 'restored', draft: 'restored', 'fact-check': 'done', review: 'waiting' },
    flow: ['draft>review', 'fact-check>review'],
    checkpoints: 3,
  },
  {
    duration: 1300,
    status: 'running',
    nodes: {
      research: 'restored',
      draft: 'restored',
      'fact-check': 'done',
      review: 'approved',
      publish: 'running',
    },
    flow: ['review>publish'],
    checkpoints: 4,
  },
  {
    duration: 3600,
    status: 'completed',
    nodes: {
      research: 'restored',
      draft: 'restored',
      'fact-check': 'done',
      review: 'approved',
      publish: 'done',
    },
    flow: [],
    checkpoints: 5,
  },
];

const FINAL_STEP = STEPS.length - 1;
const CRASH_STEP = 3;

const LOG: LogEntry[] = [
  { at: 0, time: '14:02:07', text: 'execute · publish-post', tone: 'muted' },
  { at: 1, time: '14:02:10', text: 'research ✓ 3.2s · ckpt_R7mN2xQe4LpW', tone: 'muted' },
  { at: 2, time: '14:02:14', text: 'draft ✓ 4.1s · ckpt_9TbVw3KdYs1H', tone: 'muted' },
  { at: 3, time: '14:02:15', text: 'worker exited · fact-check in flight', tone: 'danger' },
  { at: 4, time: '14:02:41', text: 'resume · ckpt_9TbVw3KdYs1H', tone: 'info' },
  { at: 5, time: '14:02:44', text: 'fact-check ✓ 2.9s · review waiting', tone: 'warn' },
  { at: 6, time: '16:15:30', text: 'review approved · 2h 13m later', tone: 'accent' },
  { at: 7, time: '16:15:31', text: 'publish ✓ 0.6s · completed', tone: 'accent' },
];

const LOG_ROWS = 4;

const toneText: Record<Tone, string> = {
  muted: 'text-l-muted',
  accent: 'text-l-accent crt-glow',
  danger: 'text-l-danger',
  info: 'text-l-info',
  warn: 'text-l-warn',
};

const statusBadge: Record<RunStatus, ReactNode> = {
  running: (
    <Badge tone="info">
      <span className="size-1.5 motion-safe:animate-pulse rounded-full bg-l-info" /> running
    </Badge>
  ),
  interrupted: (
    <Badge tone="danger">
      <Unplug className="size-2.5" /> worker exited
    </Badge>
  ),
  resumed: (
    <Badge tone="info">
      <RotateCcw className="size-2.5" /> resumed
    </Badge>
  ),
  waiting: (
    <Badge tone="warn">
      <Pause className="size-2.5" /> awaiting approval
    </Badge>
  ),
  completed: (
    <Badge tone="accent">
      <Check className="size-2.5" /> completed
    </Badge>
  ),
};

const nodeBox: Record<NodeState, string> = {
  idle: 'fill-l-surface stroke-l-brass/25',
  running: 'fill-l-info/[0.06] stroke-l-info/60',
  done: 'fill-l-raised stroke-l-accent/35',
  restored: 'fill-l-raised stroke-l-brass/50',
  lost: 'fill-l-danger/[0.08] stroke-l-danger/70',
  waiting: 'fill-l-warn/[0.07] stroke-l-warn/70',
  approved: 'fill-l-raised stroke-l-accent/35',
};

const nodeMetaTone: Record<NodeState, string> = {
  idle: 'fill-l-faint',
  running: 'fill-l-info',
  done: 'fill-l-muted',
  restored: 'fill-l-muted',
  lost: 'fill-l-danger',
  waiting: 'fill-l-warn',
  approved: 'fill-l-accent',
};

const FINISHED: NodeState[] = ['done', 'restored', 'approved'];

function nodeMeta(id: NodeId, state: NodeState): string {
  switch (state) {
    case 'idle':
      return 'queued';
    case 'running':
      return 'running';
    case 'done':
      return NODES[id].took ?? 'done';
    case 'restored':
      return 'restored';
    case 'lost':
      return 'lost';
    case 'waiting':
      return 'waiting';
    case 'approved':
      return 'approved';
  }
}

function roundedPath(points: Point[], radius = 8): string {
  const [first, ...rest] = points;
  let d = `M ${first.x} ${first.y}`;
  for (let i = 0; i < rest.length - 1; i++) {
    const prev = points[i];
    const corner = rest[i];
    const next = rest[i + 1];
    const inLength = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    const startX = corner.x - ((corner.x - prev.x) / inLength) * r;
    const startY = corner.y - ((corner.y - prev.y) / inLength) * r;
    const endX = corner.x + ((next.x - corner.x) / outLength) * r;
    const endY = corner.y + ((next.y - corner.y) / outLength) * r;
    d += ` L ${startX} ${startY} Q ${corner.x} ${corner.y} ${endX} ${endY}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

/** Keyframe times proportional to distance travelled, so the token moves at constant speed. */
function travelTimes(points: Point[]): number[] {
  const times = [0];
  let travelled = 0;
  for (let i = 1; i < points.length; i++) {
    travelled += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    times.push(travelled);
  }
  return times.map((distance) => distance / travelled);
}

const STEP_MS = STEPS.map((item) => item.duration);

function useRunTimeline(active: boolean, reduced: boolean): number {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (reduced) {
      setStep(FINAL_STEP);
      return;
    }
    if (!active) return;
    const timer = setTimeout(
      () => setStep((current) => (current >= FINAL_STEP ? 0 : current + 1)),
      paced(STEP_MS, step)
    );
    return () => clearTimeout(timer);
  }, [active, reduced, step]);

  return step;
}

function Edge({
  points,
  state,
  runKey,
}: {
  points: Point[];
  state: 'idle' | 'flow' | 'done';
  runKey: string;
}) {
  const d = roundedPath(points);
  const times = travelTimes(points);

  return (
    <g>
      <path
        d={d}
        fill="none"
        strokeWidth={1}
        className={cx(
          'transition-[stroke] duration-500',
          state === 'done' ? 'stroke-l-accent/35' : 'stroke-l-brass/20'
        )}
      />
      {state === 'flow' && (
        <g key={runKey}>
          <m.path
            d={d}
            fill="none"
            strokeWidth={1}
            className="stroke-l-accent/60"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.75, ease: 'linear' }}
          />
          <m.circle
            r={3}
            className="fill-l-accent"
            initial={{ cx: points[0].x, cy: points[0].y, opacity: 0 }}
            animate={{
              cx: points.map((p) => p.x),
              cy: points.map((p) => p.y),
              opacity: [0, 1, 1, 0],
            }}
            transition={{
              duration: 0.75,
              times,
              ease: 'linear',
              opacity: { duration: 0.9, times: [0, 0.1, 0.8, 1] },
            }}
          />
        </g>
      )}
    </g>
  );
}

function StatusMark({ state, x, y }: { state: NodeState; x: number; y: number }) {
  if (FINISHED.includes(state)) {
    return (
      <path
        d={`M ${x - 3.5} ${y} l 2.5 2.5 l 4.5 -5`}
        fill="none"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={state === 'restored' ? 'stroke-l-brass' : 'stroke-l-accent'}
      />
    );
  }
  if (state === 'lost') {
    return (
      <path
        d={`M ${x - 3} ${y - 3} l 6 6 M ${x + 3} ${y - 3} l -6 6`}
        fill="none"
        strokeWidth={1.4}
        strokeLinecap="round"
        className="stroke-l-danger"
      />
    );
  }
  if (state === 'running' || state === 'waiting') {
    return (
      <m.circle
        cx={x}
        cy={y}
        r={3}
        className={state === 'running' ? 'fill-l-info' : 'fill-l-warn'}
        animate={{ opacity: [1, 0.3, 1] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
      />
    );
  }
  return <circle cx={x} cy={y} r={2.5} className="fill-l-faint/60" />;
}

function GraphNode({ id, state }: { id: NodeId; state: NodeState }) {
  const node = NODES[id];
  return (
    <g>
      <rect
        x={node.x + 0.5}
        y={node.y + 0.5}
        width={NODE_W - 1}
        height={NODE_H - 1}
        rx={9}
        strokeWidth={1}
        className={cx('transition-[fill,stroke] duration-500', nodeBox[state])}
      />
      <text x={node.x + 14} y={node.y + 19} fontSize={12} className="fill-l-text font-mono">
        {id}
      </text>
      <text
        x={node.x + 14}
        y={node.y + 34}
        fontSize={10}
        className={cx('font-mono transition-[fill] duration-500', nodeMetaTone[state])}
      >
        {nodeMeta(id, state)}
      </text>
      <text
        x={node.x + NODE_W - 12}
        y={node.y + 34}
        fontSize={10}
        textAnchor="end"
        className="fill-l-faint font-mono"
      >
        {node.kind}
      </text>
      <StatusMark state={state} x={node.x + NODE_W - 16} y={node.y + 16} />
      {FINISHED.includes(state) && (
        <rect
          x={node.x - 3}
          y={node.y + NODE_H / 2 - 3}
          width={6}
          height={6}
          strokeWidth={1}
          transform={`rotate(45 ${node.x} ${node.y + NODE_H / 2})`}
          className="fill-l-bg stroke-l-brass"
        >
          <title>checkpointed</title>
        </rect>
      )}
    </g>
  );
}

function ApprovalChip({ state }: { state: NodeState }) {
  const visible = state === 'waiting' || state === 'approved';
  const approved = state === 'approved';
  const review = NODES.review;
  const x = review.x + NODE_W + 14;
  const y = review.y + 9;

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <m.g
          initial={{ opacity: 0, x: -4 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
          transition={{ duration: 0.4, ease: EASE }}
        >
          <path
            d={`M ${review.x + NODE_W} ${review.y + NODE_H / 2} h 14`}
            strokeWidth={1}
            strokeDasharray="2 3"
            className={approved ? 'stroke-l-accent/40' : 'stroke-l-warn/50'}
          />
          <rect
            x={x}
            y={y}
            width={76}
            height={26}
            rx={6}
            strokeWidth={1}
            className={cx(
              'transition-[fill,stroke] duration-500',
              approved
                ? 'fill-l-accent/15 stroke-l-accent/60'
                : 'fill-l-warn/[0.08] stroke-l-warn/50'
            )}
          />
          <text
            x={x + 38}
            y={y + 17}
            fontSize={11}
            textAnchor="middle"
            className={cx('font-medium', approved ? 'fill-l-accent' : 'fill-l-warn')}
          >
            {approved ? 'Approved' : 'Approve?'}
          </text>
        </m.g>
      )}
    </AnimatePresence>
  );
}

/** Replay of a checkpointed publish-post run that survives a worker restart. */
export function WorkflowRun() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useOnScreen(ref, { margin: '-80px' });
  const reduced = useReducedMotion() ?? false;
  const step = useRunTimeline(inView, reduced);
  const current = STEPS[step];
  const offline = step === CRASH_STEP;

  const stateOf = (id: NodeId): NodeState => current.nodes[id] ?? 'idle';
  const log = LOG.filter((entry) => entry.at <= step).slice(-LOG_ROWS);

  return (
    <LazyMotion features={domMax}>
      <Window
        title={`run · ${RUN_ID}`}
        crt
        className="flex min-w-0 flex-col"
        bodyClassName="flex flex-1 flex-col"
      >
        <div ref={ref} className="relative flex flex-1 flex-col">
          <div className="absolute right-3 top-3 z-20">{statusBadge[current.status]}</div>
          <m.div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-10 bg-l-danger"
            initial={false}
            animate={{ opacity: offline ? [0, 0.14, 0.04] : 0 }}
            transition={{ duration: offline ? 0.9 : 0.4, ease: EASE }}
          />

          <m.div
            className="flex flex-1 items-center px-4 pb-2 pt-5 sm:px-6"
            animate={{ opacity: offline ? 0.45 : 1 }}
            transition={{ duration: 0.4, ease: EASE }}
          >
            <svg
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              className="mx-auto block w-full max-w-[400px]"
              role="img"
              aria-label="Workflow graph: research, then draft and fact-check in parallel, then a human review, then publish."
            >
              {EDGES.map((edge) => {
                const flowing = current.flow.includes(edge.id);
                const finished =
                  FINISHED.includes(stateOf(edge.from)) && stateOf(edge.to) !== 'idle';
                return (
                  <Edge
                    key={edge.id}
                    points={edge.points}
                    state={flowing ? 'flow' : finished ? 'done' : 'idle'}
                    runKey={`${step}-${edge.id}`}
                  />
                );
              })}
              {NODE_ORDER.map((id) => (
                <GraphNode key={id} id={id} state={stateOf(id)} />
              ))}
              <ApprovalChip state={stateOf('review')} />
            </svg>
          </m.div>

          <div className="relative z-20 flex h-6 items-center justify-center px-4">
            <AnimatePresence mode="wait" initial={false}>
              {step === CRASH_STEP && (
                <m.div
                  key="lost"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0, 1, 0.4, 1] }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  transition={{ duration: 0.6 }}
                >
                  <Vox tone="warn">worker lost</Vox>
                </m.div>
              )}
              {step === CRASH_STEP + 1 && (
                <m.div
                  key="restored"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  transition={{ duration: 0.4, ease: EASE }}
                >
                  <Vox tone="accent">checkpoint restored</Vox>
                </m.div>
              )}
            </AnimatePresence>
          </div>

          <ol
            className="mx-4 mb-4 flex h-[92px] flex-col justify-end overflow-hidden [&>*]:shrink-0 rounded-lg border border-l-line bg-l-bg/50 px-3 py-2 font-mono text-[10.5px] leading-[19px] sm:mx-6"
            aria-label="Run events"
          >
            <AnimatePresence initial={false} mode="popLayout">
              {log.map((entry, index) => (
                <m.li
                  key={entry.at}
                  layout={!reduced}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: index === log.length - 1 ? 1 : 0.6, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  transition={{ duration: 0.35, ease: EASE }}
                  className="flex min-w-0 gap-3"
                >
                  <span className="shrink-0 text-l-faint">{entry.time}</span>
                  <span className={cx('truncate', toneText[entry.tone])}>{entry.text}</span>
                  {index === log.length - 1 && current.status !== 'completed' && (
                    <span aria-hidden className="crt-cursor shrink-0" />
                  )}
                </m.li>
              ))}
            </AnimatePresence>
          </ol>

          <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-l-brass/15 px-4 py-2.5 font-mono text-[10.5px] text-l-faint sm:px-6">
            <span className="text-l-brass/80">PostgresCheckpointStore</span>
            <span className="text-l-brass/60">
              {current.checkpoints} checkpoint{current.checkpoints === 1 ? '' : 's'}
            </span>
            <span className="ml-auto">per-node</span>
          </div>
        </div>
      </Window>
    </LazyMotion>
  );
}
