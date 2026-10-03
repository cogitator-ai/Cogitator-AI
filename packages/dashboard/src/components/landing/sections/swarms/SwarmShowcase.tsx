'use client';

import { AnimatePresence, LazyMotion, domMax, m, useReducedMotion } from 'framer-motion';
import { useOnScreen } from '../../playback';
import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { CodeBody, Vox, Window, cx } from '../../ui';
import {
  SCENES,
  sceneStateAt,
  type Mark,
  type MarkSide,
  type NodeStatus,
  type Pulse,
  type StrategyId,
  type StrategyScene,
  type Tone,
  type TopologyNode,
} from './scenes';
import { PACE, paced } from '../../pace';

const EASE = [0.16, 1, 0.3, 1] as const;
const LOG_LINES = 3;

const toneText: Record<Tone, string> = {
  accent: 'text-l-accent',
  info: 'text-l-info',
  warn: 'text-l-warn',
  danger: 'text-l-danger',
  violet: 'text-l-violet',
  muted: 'text-l-muted',
};

const toneDot: Record<Tone, string> = {
  accent: 'bg-l-accent shadow-[0_0_0_3px_rgb(0_255_136/0.15)]',
  info: 'bg-l-info shadow-[0_0_0_3px_rgb(122_162_255/0.15)]',
  warn: 'bg-l-warn shadow-[0_0_0_3px_rgb(245_181_68/0.15)]',
  danger: 'bg-l-danger shadow-[0_0_0_3px_rgb(255_107_107/0.15)]',
  violet: 'bg-l-violet shadow-[0_0_0_3px_rgb(179_140_255/0.15)]',
  muted: 'bg-l-muted shadow-[0_0_0_3px_rgb(139_143_152/0.12)]',
};

const toneMark: Record<Tone, string> = {
  accent: 'border-l-accent/25 bg-l-accent/[0.06] text-l-accent',
  info: 'border-l-info/25 bg-l-info/[0.06] text-l-info',
  warn: 'border-l-warn/25 bg-l-warn/[0.06] text-l-warn',
  danger: 'border-l-danger/25 bg-l-danger/[0.06] text-l-danger',
  violet: 'border-l-violet/25 bg-l-violet/[0.06] text-l-violet',
  muted: 'border-l-line-strong bg-l-bg text-l-muted',
};

const markPosition: Record<MarkSide, string> = {
  top: 'bottom-full left-1/2 mb-1.5 -translate-x-1/2',
  bottom: 'top-full left-1/2 mt-1.5 -translate-x-1/2',
  left: 'right-full top-1/2 mr-2 -translate-y-1/2',
  right: 'left-full top-1/2 ml-2 -translate-y-1/2',
};

type NodeState = NodeStatus | 'running';

const nodeFrame: Record<NodeState, string> = {
  idle: 'border-l-line bg-l-raised',
  running: 'border-l-info/40 bg-l-raised',
  done: 'border-l-line-strong bg-l-raised',
  won: 'border-l-accent/40 bg-[color-mix(in_srgb,var(--color-l-accent)_6%,var(--color-l-raised))]',
  out: 'border-l-line bg-l-raised opacity-45',
};

const nodeDot: Record<NodeState, string> = {
  idle: 'bg-white/15',
  running: 'bg-l-info motion-safe:animate-pulse',
  done: 'bg-l-accent/50',
  won: 'bg-l-accent',
  out: 'bg-l-danger/70',
};

function keyTarget(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

interface Position {
  index: number;
  beat: number;
}

/**
 * Strategy switcher for the swarms section: a replay of each strategy's message pattern next to
 * its config. It walks through all seven while in view; picking a tab continues from there.
 */
export function SwarmShowcase({ snippets }: { snippets: Record<StrategyId, ReactNode> }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const inView = useOnScreen(rootRef, { margin: '-120px' });
  const reduced = useReducedMotion() ?? false;
  const [position, setPosition] = useState<Position>({ index: 0, beat: 0 });

  const scene = SCENES[position.index];
  const lastBeat = scene.beats.length - 1;
  const beat = reduced ? lastBeat : position.beat;
  const playing = inView && !reduced;

  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(
      () => {
        setPosition(({ index, beat: current }) => {
          if (current < lastBeat) return { index, beat: current + 1 };
          return { index: (index + 1) % SCENES.length, beat: 0 };
        });
      },
      paced(
        scene.beats.map((item) => item.ms),
        position.beat
      )
    );
    return () => clearTimeout(timer);
  }, [playing, scene, lastBeat, position.beat]);

  useEffect(() => {
    const container = tabsRef.current;
    const tab = container?.querySelector<HTMLElement>(`[data-strategy="${scene.id}"]`);
    if (!container || !tab) return;
    const left = tab.offsetLeft - (container.clientWidth - tab.offsetWidth) / 2;
    container.scrollTo({ left, behavior: reduced ? 'auto' : 'smooth' });
  }, [scene.id, reduced]);

  const select = (index: number) => {
    setPosition({ index, beat: 0 });
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const target = keyTarget(event.key, position.index, SCENES.length);
    if (target === null) return;
    event.preventDefault();
    select(target);
    tabsRef.current
      ?.querySelector<HTMLButtonElement>(`[data-strategy="${SCENES[target].id}"]`)
      ?.focus();
  };

  return (
    <LazyMotion features={domMax}>
      <div ref={rootRef} className="mt-12 sm:mt-14">
        <div
          ref={tabsRef}
          role="tablist"
          aria-label="Swarm strategies"
          className="plate-tabs flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {SCENES.map((item, index) => {
            const selected = index === position.index;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`swarm-tab-${item.id}`}
                data-strategy={item.id}
                aria-selected={selected}
                aria-controls="swarm-panel"
                tabIndex={selected ? 0 : -1}
                onClick={() => select(index)}
                onKeyDown={onTabKeyDown}
                className={cx(
                  'plate-tab relative flex-none overflow-hidden whitespace-nowrap sm:flex-1 rounded-lg px-3 py-2 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-l-accent/60'
                )}
              >
                {item.id}
                {selected && !reduced && (
                  <m.span
                    key={item.id}
                    aria-hidden
                    className="absolute inset-x-2 bottom-0 h-px origin-left bg-l-accent/70"
                    initial={{ scaleX: 0 }}
                    animate={{ scaleX: (position.beat + 1) / item.beats.length }}
                    transition={{
                      duration:
                        paced(
                          item.beats.map((b) => b.ms),
                          position.beat
                        ) / 1000,
                      ease: 'linear',
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>

        <div id="swarm-panel" role="tabpanel" aria-labelledby={`swarm-tab-${scene.id}`}>
          <Window
            title={scene.file}
            className="mt-3"
            aside={
              <Link
                href={`/docs/swarms/strategies#${scene.id}`}
                className="inline-flex items-center gap-1 font-mono text-[11px] text-l-faint transition-colors hover:text-l-text"
              >
                docs
                <ArrowUpRight className="size-3" />
              </Link>
            }
            bodyClassName="grid lg:h-[468px] lg:grid-cols-[1.08fr_1fr]"
          >
            <div className="crt flex min-w-0 flex-col border-b border-l-line bg-l-bg/40 lg:border-b-0 lg:border-r">
              <AnimatePresence mode="wait" initial={false}>
                <m.p
                  key={scene.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: 0.12 } }}
                  transition={{ duration: 0.35, ease: EASE }}
                  className="min-h-[4.25rem] border-b border-l-line px-4 py-3 text-[13px] leading-relaxed text-l-muted text-pretty sm:px-5"
                >
                  {scene.description}
                </m.p>
              </AnimatePresence>

              <Stage key={scene.id} scene={scene} beat={beat} animate={!reduced} />

              <EventLog scene={scene} beat={beat} />
            </div>

            <div className="relative h-[468px] min-w-0 lg:h-auto">
              <AnimatePresence mode="wait" initial={false}>
                <m.div
                  key={scene.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="absolute inset-0 overflow-auto"
                >
                  <CodeBody className="!overflow-visible">{snippets[scene.id]}</CodeBody>
                </m.div>
              </AnimatePresence>
            </div>
          </Window>
        </div>

        <p className="mx-auto mt-5 max-w-3xl text-center text-sm leading-relaxed text-l-muted">
          Replays of what each strategy runs · the event names are the ones swarm.on() receives ·
          examples/swarms
        </p>
      </div>
    </LazyMotion>
  );
}

function Stage({ scene, beat, animate }: { scene: StrategyScene; beat: number; animate: boolean }) {
  const state = useMemo(() => sceneStateAt(scene, beat), [scene, beat]);
  const current = scene.beats[beat];
  const nodes = useMemo(() => new Map(scene.nodes.map((node) => [node.id, node])), [scene]);
  const running = new Set(animate ? (current.running ?? []) : []);
  const pulses = animate ? (current.pulses ?? []) : [];
  const liveEdges = new Set(
    pulses.flatMap((pulse) => [`${pulse.from}>${pulse.to}`, `${pulse.to}>${pulse.from}`])
  );
  const hubIds = new Set(scene.nodes.filter((node) => node.kind === 'hub').map((node) => node.id));

  return (
    <div
      className="relative z-0 h-[280px] min-h-0 flex-1 overflow-hidden sm:h-[300px] lg:h-auto"
      aria-hidden
    >
      <div className="absolute inset-0 bg-[radial-gradient(rgb(255_255_255/0.05)_1px,transparent_1px)] bg-[size:18px_18px] [mask-image:radial-gradient(70%_70%_at_50%_50%,black,transparent)]" />
      <AnimatePresence mode="wait">
        {state.vox && (
          <m.div
            key={state.vox.text}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.3 }}
            className="absolute left-4 top-3 z-30 sm:left-5"
          >
            <Vox tone={state.vox.tone}>{state.vox.text}</Vox>
          </m.div>
        )}
      </AnimatePresence>
      <svg className="absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        {scene.edges.map(([from, to]) => {
          const a = nodes.get(from);
          const b = nodes.get(to);
          if (!a || !b) return null;
          const live = liveEdges.has(`${from}>${to}`);
          return (
            <line
              key={`${from}-${to}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              vectorEffect="non-scaling-stroke"
              strokeWidth={1}
              strokeDasharray={hubIds.has(from) || hubIds.has(to) ? '3 4' : undefined}
              className={cx(
                'transition-[stroke] duration-500',
                live ? 'stroke-white/30' : 'stroke-white/[0.09]'
              )}
            />
          );
        })}
      </svg>

      {pulses.map((pulse, index) => {
        const from = nodes.get(pulse.from);
        const to = nodes.get(pulse.to);
        if (!from || !to) return null;
        return (
          <PulseDot
            key={`${beat}-${index}`}
            pulse={pulse}
            from={from}
            to={to}
            travel={Math.min(1.6, ((current.ms * PACE) / 1000) * 0.75)}
          />
        );
      })}

      {scene.nodes.map((node) => (
        <NodeCard
          key={node.id}
          node={node}
          state={running.has(node.id) ? 'running' : (state.status[node.id] ?? 'idle')}
          mark={state.marks[node.id]}
        />
      ))}
    </div>
  );
}

function PulseDot({
  pulse,
  from,
  to,
  travel,
}: {
  pulse: Pulse;
  from: TopologyNode;
  to: TopologyNode;
  travel: number;
}) {
  const tone = pulse.tone ?? 'info';
  const delay = pulse.delay ?? 0;
  return (
    <m.div
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-1/2"
      initial={{ left: `${from.x}%`, top: `${from.y}%`, opacity: 0 }}
      animate={{ left: `${to.x}%`, top: `${to.y}%`, opacity: [0, 1, 1, 0] }}
      transition={{
        left: { duration: travel, delay, ease: [0.45, 0, 0.25, 1] },
        top: { duration: travel, delay, ease: [0.45, 0, 0.25, 1] },
        opacity: { duration: travel, delay, times: [0, 0.12, 0.82, 1] },
      }}
    >
      <span className={cx('block size-2 rounded-full', toneDot[tone])} />
      {pulse.label && (
        <span
          className={cx(
            'absolute left-3.5 top-1/2 -translate-y-1/2 whitespace-nowrap rounded border border-l-line bg-l-bg/90 px-1.5 py-px font-mono text-[10px] leading-4',
            toneText[tone]
          )}
        >
          {pulse.label}
        </span>
      )}
    </m.div>
  );
}

function NodeCard({ node, state, mark }: { node: TopologyNode; state: NodeState; mark?: Mark }) {
  const hub = node.kind === 'hub';
  return (
    <div
      className="absolute z-20 -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${node.x}%`, top: `${node.y}%` }}
    >
      <div
        className={cx(
          'relative rounded-lg border px-2.5 py-1.5 whitespace-nowrap transition-[border-color,background-color,opacity] duration-500',
          hub ? 'border-dashed border-l-brass/35 bg-l-bg' : nodeFrame[state],
          hub && state === 'won' && 'border-l-accent/40'
        )}
      >
        <div className="flex items-center gap-1.5">
          {!hub && (
            <span
              className={cx('size-1.5 shrink-0 rounded-full transition-colors', nodeDot[state])}
            />
          )}
          <span
            className={cx(
              'text-[12px] leading-4',
              hub ? 'font-mono text-l-brass' : 'font-medium text-l-text',
              state === 'out' && 'line-through decoration-l-danger/60'
            )}
          >
            {node.label}
          </span>
          {node.tag && (
            <span className="hidden font-mono text-[9.5px] leading-4 text-l-brass/75 sm:inline">
              {node.tag}
            </span>
          )}
        </div>
        {node.sub && (
          <div className="mt-0.5 max-w-[92px] truncate font-mono text-[10px] leading-3.5 text-l-faint sm:max-w-none">
            {node.sub}
          </div>
        )}
      </div>

      <AnimatePresence>
        {mark && (
          <m.span
            key={mark.text}
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.3, ease: EASE }}
            className={cx(
              'absolute whitespace-nowrap rounded-full border px-1.5 py-px font-mono text-[10px] leading-4',
              markPosition[node.markSide ?? 'bottom'],
              toneMark[mark.tone]
            )}
          >
            {mark.text}
          </m.span>
        )}
      </AnimatePresence>
    </div>
  );
}

function EventLog({ scene, beat }: { scene: StrategyScene; beat: number }) {
  const { log } = useMemo(() => sceneStateAt(scene, beat), [scene, beat]);
  const start = Math.max(0, log.length - LOG_LINES);
  const visible = log.slice(start);

  return (
    <div className="h-[4.75rem] overflow-hidden border-t border-l-line px-4 py-2.5 font-mono text-[11px] leading-[18px] sm:px-5">
      <AnimatePresence initial={false} mode="popLayout">
        {visible.map((line, offset) => {
          const index = start + offset;
          const newest = index === log.length - 1;
          return (
            <m.div
              key={`${scene.id}-${index}`}
              layout="position"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: newest ? 1 : 0.55, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              transition={{ duration: 0.3, ease: EASE }}
              className="flex min-w-0 gap-2"
            >
              <span
                className={cx(
                  'shrink-0',
                  toneText[line.tone ?? 'muted'],
                  newest && line.tone === 'accent' && 'crt-glow'
                )}
              >
                {line.name}
              </span>
              {line.detail && <span className="truncate text-l-faint">{line.detail}</span>}
              {newest && <span aria-hidden className="crt-cursor shrink-0 self-center h-[0.9em]" />}
            </m.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
