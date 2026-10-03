'use client';

import { m } from 'framer-motion';
import { Badge, Vox } from '../../../ui';
import { DemoFrame, EASE, useDemoTimeline } from './shared';

const DURATIONS = [800, 1100, 1100, 1200, 1100, 1100, 3000];

interface TreeNode {
  id: string;
  parent?: string;
  x: number;
  y: number;
  w: number;
  label: string;
  score?: number;
  /** Step at which the node appears, and at which its score is known. */
  born: number;
  scored: number;
  pruned?: boolean;
  best?: boolean;
}

const NODES: TreeNode[] = [
  {
    id: 'root',
    x: 180,
    y: 20,
    w: 156,
    label: 'goal: cache a 10M-user feed',
    born: 0,
    scored: 0,
    best: true,
  },
  {
    id: 'a',
    parent: 'root',
    x: 62,
    y: 86,
    w: 108,
    label: 'Redis per user',
    score: 0.82,
    born: 1,
    scored: 2,
    best: true,
  },
  {
    id: 'b',
    parent: 'root',
    x: 180,
    y: 86,
    w: 108,
    label: 'edge CDN',
    score: 0.64,
    born: 1,
    scored: 2,
  },
  {
    id: 'c',
    parent: 'root',
    x: 298,
    y: 86,
    w: 108,
    label: 'scale the DB',
    score: 0.21,
    born: 1,
    scored: 2,
    pruned: true,
  },
  {
    id: 'a1',
    parent: 'a',
    x: 45,
    y: 152,
    w: 82,
    label: 'write fan-out',
    score: 0.91,
    born: 4,
    scored: 5,
    best: true,
  },
  {
    id: 'a2',
    parent: 'a',
    x: 132,
    y: 152,
    w: 82,
    label: 'TTL + jitter',
    score: 0.58,
    born: 4,
    scored: 5,
  },
  {
    id: 'b1',
    parent: 'b',
    x: 219,
    y: 152,
    w: 82,
    label: 'user-keyed',
    score: 0.49,
    born: 4,
    scored: 5,
  },
  {
    id: 'b2',
    parent: 'b',
    x: 306,
    y: 152,
    w: 82,
    label: 'SWR headers',
    score: 0.44,
    born: 4,
    scored: 5,
  },
];

const BY_ID = new Map(NODES.map((node) => [node.id, node]));
const NODE_H = 32;
const BEST_STEP = 6;
const PRUNE_STEP = 3;

function edgePath(from: TreeNode, to: TreeNode): string {
  const y1 = from.y + NODE_H / 2;
  const y2 = to.y - NODE_H / 2;
  const mid = (y1 + y2) / 2;
  return `M ${from.x} ${y1} C ${from.x} ${mid}, ${to.x} ${mid}, ${to.x} ${y2}`;
}

function nodeTone(node: TreeNode, step: number) {
  if (node.pruned && step >= PRUNE_STEP) {
    return { box: 'fill-transparent stroke-l-danger/40', text: 'fill-l-faint', dash: '3 3' };
  }
  if (node.best && step >= BEST_STEP) {
    return { box: 'fill-l-accent/[0.08] stroke-l-accent/60', text: 'fill-l-text', dash: undefined };
  }
  return { box: 'fill-l-raised stroke-l-brass/35', text: 'fill-l-muted', dash: undefined };
}

/** Tree-of-Thought: three approaches, one pruned below the threshold, the best path kept. */
export function ThoughtTreeDemo() {
  const timeline = useDemoTimeline(DURATIONS);
  const { step } = timeline;

  return (
    <DemoFrame
      timeline={timeline}
      label="ThoughtTreeExecutor · beam"
      aside={
        step >= BEST_STEP ? (
          <Badge tone="accent">0.91 ≥ 0.85 · stop</Badge>
        ) : (
          <Badge tone="info">
            <span className="size-1.5 motion-safe:animate-pulse rounded-full bg-l-info" /> depth{' '}
            {step >= 4 ? 2 : step >= 1 ? 1 : 0}
          </Badge>
        )
      }
      footer={
        <>
          <span>branchFactor 3 · beamWidth 2 · threshold 0.3</span>
          {step >= BEST_STEP ? (
            <Vox className="ml-auto">best path chosen</Vox>
          ) : (
            <span className="ml-auto">nodes {step >= 4 ? 8 : step >= 1 ? 4 : 1}</span>
          )}
        </>
      }
      bodyClassName="flex items-center justify-center"
    >
      <svg
        viewBox="0 0 360 172"
        className="h-full max-h-[210px] w-full"
        role="img"
        aria-label="A tree of candidate approaches: three branches, one pruned, the best path highlighted"
      >
        {NODES.filter((node) => node.parent).map((node) => {
          const parent = BY_ID.get(node.parent ?? '');
          if (!parent) return null;
          const visible = step >= node.born;
          const best = node.best && step >= BEST_STEP;
          const pruned = node.pruned && step >= PRUNE_STEP;
          return (
            <m.path
              key={`edge-${node.id}`}
              d={edgePath(parent, node)}
              fill="none"
              className={
                best ? 'stroke-l-accent/70' : pruned ? 'stroke-l-danger/30' : 'stroke-l-brass/30'
              }
              strokeWidth={best ? 1.5 : 1}
              strokeDasharray={pruned ? '3 3' : undefined}
              initial={false}
              animate={{ pathLength: visible ? 1 : 0, opacity: visible ? 1 : 0 }}
              transition={{ duration: 0.5, ease: EASE }}
            />
          );
        })}

        {NODES.map((node) => {
          const visible = step >= node.born;
          const tone = nodeTone(node, step);
          const scoreKnown = node.score !== undefined && step >= node.scored;
          return (
            <m.g
              key={node.id}
              initial={false}
              animate={{ opacity: visible ? (node.pruned && step >= PRUNE_STEP ? 0.55 : 1) : 0 }}
              transition={{ duration: 0.4, ease: EASE }}
            >
              <rect
                x={node.x - node.w / 2}
                y={node.y - NODE_H / 2}
                width={node.w}
                height={NODE_H}
                rx={6}
                strokeWidth={1}
                strokeDasharray={tone.dash}
                className={`${tone.box} transition-colors duration-500`}
              />
              <text
                x={node.x}
                y={node.score === undefined ? node.y + 3.5 : node.y - 2}
                textAnchor="middle"
                className={`${tone.text} font-sans text-[10px]`}
              >
                {node.label}
              </text>
              {node.score !== undefined && (
                <text
                  x={node.x}
                  y={node.y + 10}
                  textAnchor="middle"
                  className={`font-mono text-[9px] ${
                    node.pruned && step >= PRUNE_STEP
                      ? 'fill-l-danger'
                      : node.best && step >= BEST_STEP
                        ? 'fill-l-accent'
                        : 'fill-l-faint'
                  }`}
                >
                  {scoreKnown
                    ? node.pruned && step >= PRUNE_STEP
                      ? `${node.score.toFixed(2)} < 0.3 · pruned`
                      : node.score.toFixed(2)
                    : '…'}
                </text>
              )}
            </m.g>
          );
        })}
      </svg>
    </DemoFrame>
  );
}
