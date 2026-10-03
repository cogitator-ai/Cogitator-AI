'use client';

import { AnimatePresence, m } from 'framer-motion';
import { Lock, MousePointer2, RotateCw, Search } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { cx, Vox } from '../../../ui';
import { EASE, Streamed, useDemoTimeline } from './shared';

const DURATIONS = [1300, 1700, 1200, 1500, 1800, 3200] as const;

const SHOP_URL = 'https://shop.example.com';
const QUERY = 'Halcyon desk lamp';

const CALLS = [
  `browser_navigate { url: "${SHOP_URL}" }`,
  `browser_type { selector: "input[name=q]", text: "${QUERY}" }`,
  'browser_click { selector: "button[type=submit]" }',
  'browser_click { selector: ".result:first-child a" }',
  'browser_extract_structured { instruction: "price and stock", selector: ".product" }',
];

const ANSWER = 'Halcyon desk lamp: $89.00, in stock (12 left).';

type Target = 'search' | 'submit' | 'result' | 'details';

/** What the cursor goes for at each step; `null` parks it in the corner. */
const TARGETS: (Target | null)[] = [null, 'search', 'submit', 'result', 'details', 'details'];

/** Steps whose action is a click, so the cursor presses once it arrives. */
const CLICKS = new Set([2, 3]);

const RESULTS = [
  { name: 'Halcyon desk lamp', price: '$89.00' },
  { name: 'Halcyon floor lamp', price: '$149.00' },
  { name: 'Arc task light', price: '$64.00' },
];

type Page = 'home' | 'results' | 'product';

function pageAt(step: number): Page {
  if (step >= 4) return 'product';
  if (step === 3) return 'results';
  return 'home';
}

type Register = (target: Target) => (element: HTMLElement | null) => void;

function HomePage({ step, register }: { step: number; register: Register }) {
  const typing = step >= 1;
  const pressed = step === 2;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6">
      <p className="text-[14px] font-semibold tracking-tight text-l-text/90">Lumen Supply</p>
      <div className="flex w-full max-w-[380px] gap-2">
        <div
          ref={register('search')}
          className={cx(
            'flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2.5 text-[11.5px] transition-colors duration-300',
            step === 1 ? 'border-l-accent/50 bg-l-accent/[0.04]' : 'border-white/15 bg-white/[0.03]'
          )}
        >
          <Search className="size-3 shrink-0 text-l-faint" />
          <span className="truncate text-l-text">
            {typing ? (
              <Streamed text={QUERY} play={step === 1} speed={1} />
            ) : (
              <span className="text-l-faint">Search lamps, desks…</span>
            )}
          </span>
        </div>
        <m.div
          ref={register('submit')}
          animate={pressed ? { scale: [1, 1, 0.92, 1] } : { scale: 1 }}
          transition={{ duration: 1, times: [0, 0.6, 0.75, 1] }}
          className="flex h-8 shrink-0 items-center rounded-md bg-l-phosphor/85 px-3.5 text-[11.5px] font-medium text-l-bg"
        >
          Search
        </m.div>
      </div>
    </div>
  );
}

function ResultsPage({ step, register }: { step: number; register: Register }) {
  return (
    <div className="flex h-full flex-col gap-2.5 px-4 py-3">
      <p className="font-mono text-[10.5px] text-l-muted">3 results for “{QUERY}”</p>
      <div className="grid min-h-0 flex-1 grid-cols-3 gap-2.5">
        {RESULTS.map((result, index) => (
          <div
            key={result.name}
            ref={index === 0 ? register('result') : undefined}
            className={cx(
              'flex min-h-0 flex-col rounded-md border p-1.5 transition-colors duration-300',
              index === 0 && step === 3
                ? 'border-l-accent/50 bg-l-accent/[0.05]'
                : 'border-white/10'
            )}
          >
            <div className="min-h-0 flex-1 rounded bg-[radial-gradient(70%_70%_at_50%_40%,rgb(201_164_92/0.22),rgb(255_255_255/0.03))]" />
            <p className="mt-1.5 truncate text-[11px] text-l-text">{result.name}</p>
            <p className="font-mono text-[10.5px] text-l-muted">{result.price}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductPage({ extracting, register }: { extracting: boolean; register: Register }) {
  return (
    <div className="flex h-full gap-4 px-4 py-3">
      <div className="w-[38%] rounded-md bg-[radial-gradient(60%_60%_at_50%_40%,rgb(201_164_92/0.28),rgb(255_255_255/0.03))]" />
      <div
        ref={register('details')}
        className={cx(
          'relative flex-1 overflow-hidden rounded-md border p-3 transition-colors duration-500',
          extracting ? 'border-l-accent/50 bg-l-accent/[0.04]' : 'border-white/10'
        )}
      >
        <p className="text-[13px] font-semibold text-l-text">Halcyon desk lamp</p>
        <p className="mt-1 font-mono text-[12.5px] text-l-text">$89.00</p>
        <p className="mt-1 text-[11px] text-l-accent">In stock · 12 left</p>
        <div className="mt-3 w-fit rounded-md bg-l-phosphor/85 px-2.5 py-1 text-[11px] font-medium text-l-bg">
          Add to cart
        </div>
        {extracting && (
          <m.span
            aria-hidden
            className="absolute inset-x-0 h-px bg-l-accent/70 shadow-[0_0_8px_rgb(127_212_181/0.6)]"
            initial={{ top: '0%' }}
            animate={{ top: '100%' }}
            transition={{ duration: 1.4, ease: 'linear', repeat: Infinity }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Keeps track of the page elements the cursor aims at and returns the active target's centre,
 * measured against `viewport`, so the cursor lands on it at any size.
 */
function useCursorTarget(target: Target | null) {
  const viewport = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<Target, HTMLElement>());
  const [revision, setRevision] = useState(0);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);

  const callbacks = useRef(new Map<Target, (element: HTMLElement | null) => void>());

  const register = useCallback<Register>((name) => {
    const cached = callbacks.current.get(name);
    if (cached) return cached;
    const callback = (element: HTMLElement | null) => {
      if (element) elements.current.set(name, element);
      else elements.current.delete(name);
      setRevision((value) => value + 1);
    };
    callbacks.current.set(name, callback);
    return callback;
  }, []);

  useLayoutEffect(() => {
    const box = viewport.current;
    if (!box) return;
    const measure = () => {
      const rect = box.getBoundingClientRect();
      const element = target ? elements.current.get(target) : undefined;
      if (!element) {
        setPoint({ x: rect.width - 28, y: rect.height - 26 });
        return;
      }
      const goal = element.getBoundingClientRect();
      setPoint({
        x: goal.left - rect.left + goal.width * 0.5,
        y: goal.top - rect.top + goal.height * 0.55,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [target, revision]);

  return { viewport, register, point };
}

/** A browser agent driving a page: navigate, type, click, extract. */
export function BrowserDemo() {
  const { ref, step } = useDemoTimeline(DURATIONS);
  const page = pageAt(step);
  const { viewport, register, point } = useCursorTarget(TARGETS[step]);
  const clicking = CLICKS.has(step);

  return (
    <div ref={ref} className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-l-line px-3">
        <RotateCw className={cx('size-3 shrink-0 text-l-faint', step === 0 && 'animate-spin')} />
        <div className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-white/[0.05] px-2 font-mono text-[10.5px]">
          <Lock className="size-2.5 shrink-0 text-l-brass" />
          <span className="truncate text-l-muted">
            {step === 0 ? (
              <Streamed text={SHOP_URL.replace('https://', '')} play speed={1} />
            ) : (
              `shop.example.com${page === 'results' ? '/search?q=halcyon' : page === 'product' ? '/p/halcyon-desk-lamp' : ''}`
            )}
          </span>
        </div>
        <span className="hidden font-mono text-[10px] text-l-faint sm:inline">stealth</span>
      </div>

      <div ref={viewport} className="relative min-h-0 flex-1 overflow-hidden bg-l-bg/40">
        <AnimatePresence mode="wait" initial={false}>
          <m.div
            key={page}
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            {page === 'home' && <HomePage step={step} register={register} />}
            {page === 'results' && <ResultsPage step={step} register={register} />}
            {page === 'product' && <ProductPage extracting={step === 4} register={register} />}
          </m.div>
        </AnimatePresence>

        {point && (
          <m.div
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 z-10"
            initial={false}
            animate={{ x: point.x, y: point.y }}
            transition={{ duration: 0.8, ease: EASE }}
          >
            {clicking && (
              <m.span
                key={step}
                className="absolute -left-2 -top-2 size-4 rounded-full border border-l-accent/80"
                initial={{ scale: 0.3, opacity: 0 }}
                animate={{ scale: [0.3, 1.8], opacity: [0, 1, 0] }}
                transition={{ delay: 0.85, duration: 0.55 }}
              />
            )}
            <MousePointer2 className="size-4 fill-l-text text-l-bg" />
          </m.div>
        )}
      </div>

      <div className="flex h-11 shrink-0 items-center gap-3 border-t border-l-line px-4 font-mono text-[10.5px]">
        {step < CALLS.length ? (
          <m.span
            key={step}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="truncate text-l-muted"
          >
            <span className="text-l-violet">{CALLS[step].split(' ')[0]}</span>
            {CALLS[step].slice(CALLS[step].indexOf(' '))}
          </m.span>
        ) : (
          <>
            <span className="min-w-0 truncate text-[12px] text-l-text">
              <Streamed text={ANSWER} play={step === CALLS.length} />
            </span>
            <Vox className="ml-auto hidden sm:inline">data extracted</Vox>
          </>
        )}
      </div>
    </div>
  );
}
