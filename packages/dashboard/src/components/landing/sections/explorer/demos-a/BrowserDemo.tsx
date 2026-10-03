'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { Lock, MousePointer2, RotateCw, Search } from 'lucide-react';
import { cx, Vox } from '../../../ui';
import { EASE, Streamed, useDemoTimeline } from './shared';

const DURATIONS = [1300, 1600, 1100, 1300, 1700, 3200] as const;

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

/** Cursor target per step, in % of the page viewport. */
const CURSOR = [
  { left: 82, top: 82 },
  { left: 42, top: 47 },
  { left: 80, top: 47 },
  { left: 19, top: 58 },
  { left: 66, top: 52 },
  { left: 66, top: 52 },
];

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

function HomePage({ typing }: { typing: boolean }) {
  return (
    <div className="absolute inset-0">
      <p className="absolute left-0 right-0 top-[18%] text-center text-[13px] font-semibold tracking-tight text-l-text/90">
        Lumen Supply
      </p>
      <div className="absolute left-[12%] right-[28%] top-[38%] flex h-[19%] items-center gap-1.5 rounded-md border border-white/15 bg-white/[0.03] px-2 text-[11px]">
        <Search className="size-3 shrink-0 text-l-faint" />
        <span className="truncate text-l-text">
          {typing ? (
            <Streamed text={QUERY} play speed={1} />
          ) : (
            <span className="text-l-faint">Search lamps, desks…</span>
          )}
        </span>
      </div>
      <div className="absolute left-[74%] right-[12%] top-[38%] flex h-[19%] items-center justify-center rounded-md bg-white/85 text-[11px] font-medium text-l-bg">
        Search
      </div>
    </div>
  );
}

function ResultsPage() {
  return (
    <div className="absolute inset-0 grid grid-cols-3 gap-[4%] px-[5%] pb-[10%] pt-[22%]">
      <p className="absolute left-[5%] top-[7%] font-mono text-[10px] text-l-faint">
        3 results for “{QUERY}”
      </p>
      {RESULTS.map((result, index) => (
        <div
          key={result.name}
          className={cx(
            'flex flex-col rounded-md border p-1.5',
            index === 0 ? 'border-white/20' : 'border-white/10'
          )}
        >
          <div className="flex-1 rounded bg-[linear-gradient(135deg,rgb(255_255_255/0.08),rgb(255_255_255/0.02))]" />
          <p className="mt-1 truncate text-[10.5px] text-l-text">{result.name}</p>
          <p className="font-mono text-[10px] text-l-muted">{result.price}</p>
        </div>
      ))}
    </div>
  );
}

function ProductPage({ extracting }: { extracting: boolean }) {
  return (
    <div className="absolute inset-0 flex gap-[5%] px-[5%] py-[8%]">
      <div className="w-[38%] rounded-md bg-[radial-gradient(60%_60%_at_50%_40%,rgb(201_164_92/0.25),rgb(255_255_255/0.03))]" />
      <div
        className={cx(
          'relative flex-1 rounded-md border p-2 transition-colors duration-500',
          extracting ? 'border-l-accent/60 bg-l-accent/[0.04]' : 'border-transparent'
        )}
      >
        <p className="text-[12.5px] font-semibold text-l-text">Halcyon desk lamp</p>
        <p className="mt-1 font-mono text-[12px] text-l-text">$89.00</p>
        <p className="mt-1 text-[10.5px] text-l-accent/90">In stock · 12 left</p>
        <div className="mt-2.5 w-fit rounded-md bg-white/85 px-2 py-1 text-[10.5px] font-medium text-l-bg">
          Add to cart
        </div>
        {extracting && (
          <motion.span
            aria-hidden
            className="absolute inset-x-0 h-px bg-l-accent/70 shadow-[0_0_8px_rgb(0_255_136/0.6)]"
            initial={{ top: '0%' }}
            animate={{ top: '100%' }}
            transition={{ duration: 1.2, ease: 'linear', repeat: Infinity }}
          />
        )}
      </div>
    </div>
  );
}

/** A browser agent driving a page: navigate, type, click, extract. */
export function BrowserDemo() {
  const { ref, step } = useDemoTimeline(DURATIONS);
  const page = pageAt(step);
  const cursor = CURSOR[step];
  const clicking = step === 2 || step === 3;

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

      <div className="relative min-h-0 flex-1 overflow-hidden bg-l-bg/40">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={page}
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            {page === 'home' && <HomePage typing={step >= 1} />}
            {page === 'results' && <ResultsPage />}
            {page === 'product' && <ProductPage extracting={step === 4} />}
          </motion.div>
        </AnimatePresence>

        <motion.div
          aria-hidden
          className="pointer-events-none absolute z-10"
          initial={false}
          animate={{ left: `${cursor.left}%`, top: `${cursor.top}%` }}
          transition={{ duration: 0.7, ease: EASE }}
        >
          {clicking && (
            <motion.span
              key={step}
              className="absolute -left-2 -top-2 size-4 rounded-full border border-l-accent/70"
              initial={{ scale: 0.3, opacity: 0 }}
              animate={{ scale: [0.3, 1.6], opacity: [0, 1, 0] }}
              transition={{ delay: 0.7, duration: 0.5 }}
            />
          )}
          <MousePointer2 className="size-4 fill-l-text text-l-bg" />
        </motion.div>
      </div>

      <div className="flex h-11 shrink-0 items-center gap-3 border-t border-l-line px-4 font-mono text-[10.5px]">
        {step < CALLS.length ? (
          <motion.span
            key={step}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="truncate text-l-muted"
          >
            <span className="text-l-violet">{CALLS[step].split(' ')[0]}</span>
            {CALLS[step].slice(CALLS[step].indexOf(' '))}
          </motion.span>
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
