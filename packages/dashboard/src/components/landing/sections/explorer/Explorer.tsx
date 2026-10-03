'use client';

import {
  AnimatePresence,
  animate,
  motion,
  useInView,
  useMotionValue,
  useReducedMotion,
} from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { CodeBody, Section, SectionHeader, Window, cx } from '../../ui';
import type { ExplorerFeature } from './types';

const ADVANCE_MS = 7000;
const EASE = [0.16, 1, 0.3, 1] as const;
const DESKTOP_QUERY = '(min-width: 1024px)';
const PANEL_ID = 'feature-explorer-panel';

const subscribeNothing = () => () => {};

function subscribeDesktop(onChange: () => void): () => void {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/** Whether the list is laid out vertically (lg and up) rather than as scrolling chips. */
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false
  );
}

function tabId(feature: ExplorerFeature): string {
  return `feature-explorer-tab-${feature.id}`;
}

/**
 * The "everything in the box" explorer: a list of features on the left, the active one's
 * live demo and snippet on the right. Auto-advances while on screen, pauses on hover or
 * focus, and stops for good once the visitor picks a feature.
 */
export function Explorer({ features }: { features: ExplorerFeature[] }) {
  const [active, setActive] = useState(0);
  const [locked, setLocked] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const inView = useInView(rootRef, { amount: 0.25 });
  const prefersReduced = useReducedMotion() ?? false;
  const hydrated = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false
  );
  const reduced = hydrated && prefersReduced;
  const isDesktop = useIsDesktop();
  const progress = useMotionValue(0);

  const count = features.length;
  const running = inView && !hovered && !focused && !locked && !reduced && count > 1;

  useEffect(() => {
    if (!running) return;
    const controls = animate(progress, 1, {
      duration: ((1 - progress.get()) * ADVANCE_MS) / 1000,
      ease: 'linear',
      onComplete: () => {
        progress.set(0);
        setActive((current) => (current + 1) % count);
      },
    });
    return () => controls.stop();
  }, [active, count, progress, running]);

  useEffect(() => {
    const scroller = listRef.current;
    const tab = tabRefs.current[active];
    if (!scroller || !tab || scroller.scrollWidth <= scroller.clientWidth) return;
    scroller.scrollTo({
      left: tab.offsetLeft - (scroller.clientWidth - tab.offsetWidth) / 2,
      behavior: reduced ? 'auto' : 'smooth',
    });
  }, [active, reduced]);

  const select = useCallback(
    (index: number, moveFocus: boolean) => {
      progress.set(0);
      setLocked(true);
      setActive(index);
      if (moveFocus) tabRefs.current[index]?.focus();
    },
    [progress]
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = {
      ArrowDown: active + 1,
      ArrowRight: active + 1,
      ArrowUp: active - 1,
      ArrowLeft: active - 1,
      Home: 0,
      End: count - 1,
    };
    const target = keys[event.key];
    if (target === undefined) return;
    event.preventDefault();
    select((target + count) % count, true);
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
  };

  if (count === 0) return null;
  const feature = features[active];

  return (
    <Section id="features">
      <SectionHeader
        eyebrow="Everything in the box"
        title={
          <>
            Every package, <span className="text-l-muted">ready when you need it.</span>
          </>
        }
        description="Memory, RAG, protocols, channels, voice, browsers, evals and more ship as focused packages on the same runtime. Add the ones you need; each comes with docs and runnable examples."
      />

      <div
        ref={rootRef}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={onBlur}
        className="mt-12 sm:mt-16 lg:grid lg:grid-cols-[248px_minmax(0,1fr)] lg:gap-10"
      >
        <div className="min-w-0">
          <p className="mb-3 hidden font-mono text-[10.5px] uppercase tracking-[0.16em] text-l-brass/80 lg:block">
            {count} capabilities
          </p>
          <div
            ref={listRef}
            role="tablist"
            aria-label="Features"
            aria-orientation={isDesktop ? 'vertical' : 'horizontal'}
            onKeyDown={onKeyDown}
            className="relative -mx-5 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none] sm:-mx-8 sm:px-8 lg:mx-0 lg:flex-col lg:gap-0 lg:overflow-visible lg:px-0 lg:pb-0 [&::-webkit-scrollbar]:hidden"
          >
            {features.map((item, index) => {
              const selected = index === active;
              return (
                <button
                  key={item.id}
                  ref={(node) => {
                    tabRefs.current[index] = node;
                  }}
                  id={tabId(item)}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={PANEL_ID}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => select(index, false)}
                  className={cx(
                    'group relative shrink-0 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-l-accent/60',
                    'rounded-full border px-3.5 py-1.5 text-[13px]',
                    'lg:rounded-none lg:border-0 lg:py-2.5 lg:pl-4 lg:pr-2',
                    selected
                      ? 'border-l-accent/35 bg-white/[0.05] text-l-text lg:bg-transparent'
                      : 'border-l-line text-l-muted hover:text-l-text'
                  )}
                >
                  <span
                    aria-hidden
                    className={cx(
                      'absolute inset-y-0 left-0 hidden w-px transition-colors lg:block',
                      selected ? 'bg-l-accent' : 'bg-l-line group-hover:bg-l-line-strong'
                    )}
                  />
                  <span className="block whitespace-nowrap lg:text-[14px] lg:whitespace-normal">
                    {item.title}
                  </span>
                  <span
                    className={cx(
                      'mt-0.5 hidden truncate font-mono text-[10.5px] transition-colors lg:block',
                      selected ? 'text-l-brass' : 'text-l-faint'
                    )}
                  >
                    {item.pkg}
                  </span>
                  {selected && !locked && !reduced && (
                    <span
                      aria-hidden
                      className="absolute inset-x-3.5 bottom-0 h-px overflow-hidden bg-white/[0.06] lg:inset-x-4 lg:bottom-1"
                    >
                      <motion.span
                        className="block h-full origin-left bg-l-accent/70"
                        style={{ scaleX: progress }}
                      />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div
          id={PANEL_ID}
          role="tabpanel"
          aria-labelledby={tabId(feature)}
          className="mt-8 min-w-0 lg:mt-0"
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={feature.id}
              initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -4, transition: { duration: 0.15 } }}
              transition={{ duration: 0.4, ease: EASE }}
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
                <div className="min-w-0">
                  <p className="font-mono text-[11px] text-l-brass">{feature.pkg}</p>
                  <h3 className="mt-2 text-xl font-semibold tracking-[-0.02em] text-l-text sm:text-2xl">
                    {feature.title}
                  </h3>
                  <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-l-muted text-pretty">
                    {feature.summary}
                  </p>
                </div>
                <Link
                  href={feature.href}
                  className="group inline-flex shrink-0 items-center gap-1.5 self-start rounded-md border border-l-line px-3 py-1.5 text-[13px] text-l-text transition-colors hover:border-l-line-strong sm:mt-6"
                >
                  Docs
                  <ArrowRight className="size-3.5 text-l-muted transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>

              <Window
                title={`live · ${feature.pkg}`}
                crt
                className="mt-6"
                bodyClassName="relative h-[300px] overflow-hidden bg-l-bg/40"
              >
                {feature.demo}
              </Window>

              <Window title={`${feature.id}.ts`} className="mt-4">
                <CodeBody className="lg:min-h-[300px]">{feature.code}</CodeBody>
              </Window>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </Section>
  );
}
