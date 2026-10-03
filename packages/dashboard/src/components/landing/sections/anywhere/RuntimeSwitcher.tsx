'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowUpRight } from 'lucide-react';
import Link from 'next/link';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { CodeBody, Window, cx } from '../../ui';
import { StreamReplay } from './StreamReplay';
import type { RouteItem, RouteMethod, RuntimeTab } from './types';

const METHOD_TONE: Record<RouteMethod, string> = {
  GET: 'text-l-info',
  POST: 'text-l-accent/80',
  DELETE: 'text-l-danger',
  WS: 'text-l-violet',
  HOOK: 'text-l-brass',
  FN: 'text-l-brass',
};

const EASE = [0.16, 1, 0.3, 1] as const;

function RouteRow({ route }: { route: RouteItem }) {
  return (
    <li className="flex min-w-0 gap-3 py-2.5">
      <span
        className={cx(
          'w-11 shrink-0 pt-px font-mono text-[10.5px] font-medium',
          METHOD_TONE[route.method]
        )}
      >
        {route.method}
      </span>
      <div className="min-w-0">
        <div className="truncate font-mono text-[12px] text-l-text" title={route.path}>
          {route.path}
        </div>
        <div className="mt-0.5 text-[12px] leading-snug text-l-faint">
          {route.label}
          {route.optIn && (
            <span className="ml-1.5 whitespace-nowrap font-mono text-[10.5px] text-l-brass/80">
              + {route.optIn}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

/** Tab bar of runtimes; each tab shows its integration snippet, a replayed stream and its routes. */
export function RuntimeSwitcher({ tabs }: { tabs: RuntimeTab[] }) {
  const [active, setActive] = useState(0);
  const [fileIndex, setFileIndex] = useState(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const reduced = useReducedMotion() ?? false;
  const baseId = useId();
  const tab = tabs[active] ?? tabs[0];
  if (!tab) return null;
  const file = tab.files[fileIndex] ?? tab.files[0];

  const select = (index: number) => {
    setActive(index);
    setFileIndex(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = tabs.length;
    const targets: Record<string, number> = {
      ArrowRight: (active + 1) % count,
      ArrowLeft: (active - 1 + count) % count,
      Home: 0,
      End: count - 1,
    };
    const next = targets[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(next);
    tabRefs.current[next]?.focus();
  };

  const panelId = `${baseId}-panel`;

  return (
    <div>
      <div className="-mx-5 overflow-x-auto px-5 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
        <div
          role="tablist"
          aria-label="Runtimes and frameworks"
          onKeyDown={onKeyDown}
          className="flex w-max gap-1 sm:w-auto sm:flex-wrap"
        >
          {tabs.map((item, index) => {
            const selected = index === active;
            return (
              <button
                key={item.id}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${item.id}`}
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                onClick={() => select(index)}
                className={cx(
                  'inline-flex items-center gap-2 whitespace-nowrap rounded-lg border px-3 py-2 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-l-accent/60',
                  selected
                    ? 'border-l-line-strong bg-white/[0.05] text-l-text'
                    : 'border-transparent text-l-muted hover:text-l-text'
                )}
              >
                <span className={selected ? 'text-l-text' : 'text-l-faint'}>{item.icon}</span>
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${tab.id}`}
        className="mt-5"
      >
        <Window
          title={
            <span className="flex items-center gap-1">
              {tab.files.map((item, index) => (
                <button
                  key={item.name}
                  type="button"
                  onClick={() => setFileIndex(index)}
                  aria-pressed={item === file}
                  className={cx(
                    'rounded px-1.5 py-0.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-l-accent/60',
                    item === file
                      ? 'bg-white/[0.06] text-l-text'
                      : 'text-l-faint hover:text-l-muted'
                  )}
                >
                  {item.name}
                </button>
              ))}
            </span>
          }
          aside={
            <span className="hidden shrink-0 font-mono text-[11px] text-l-brass/80 sm:inline">
              {tab.install}
            </span>
          }
          bodyClassName="grid lg:grid-cols-[1.12fr_1fr]"
        >
          <div className="min-w-0 border-b border-l-line lg:min-h-[470px] lg:border-b-0 lg:border-r">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={`${tab.id}:${file?.name}`}
                initial={reduced ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduced ? undefined : { opacity: 0, transition: { duration: 0.12 } }}
                transition={{ duration: 0.3, ease: EASE }}
              >
                <CodeBody>{file?.code}</CodeBody>
              </motion.div>
            </AnimatePresence>
          </div>
          <StreamReplay key={tab.id} script={tab.stream} runtime={tab.runtime} />
        </Window>

        <div className="mt-6">
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-l-brass">
              What you get
            </span>
            <span className="h-px flex-1 bg-l-brass/15" aria-hidden />
          </div>
          <ul className="mt-2 grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
            {tab.routes.map((route) => (
              <RouteRow key={`${route.method} ${route.path}`} route={route} />
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-xs text-l-muted">
            <span>{tab.example}</span>
            <Link
              href={tab.docsHref}
              className="inline-flex items-center gap-1 text-l-muted transition-colors hover:text-l-text"
            >
              {tab.label} guide
              <ArrowUpRight className="size-3" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
