'use client';

import { AnimatePresence, m } from 'framer-motion';
import { FileText } from 'lucide-react';
import { cx } from '../../../ui';
import { DemoBar, EASE, Pill, Streamed, useDemoTimeline } from './shared';

const STAGES = ['load', 'chunk', 'embed', 'retrieve', 'rerank', 'answer'] as const;
const DURATIONS = [900, 1100, 1200, 1300, 1500, 3800] as const;

const FILES = [
  { name: 'leave-policy.md', chunks: 14 },
  { name: 'benefits.md', chunks: 17 },
  { name: 'onboarding.md', chunks: 10 },
];

/** Chunk ids (file index, chunk index) that similarity search returns, best first. */
const RETRIEVED = [
  { id: 'benefits.md#6', file: 1, chunk: 6, similarity: 0.82, rerank: 0.41 },
  { id: 'leave-policy.md#2', file: 0, chunk: 2, similarity: 0.8, rerank: 0.94 },
  { id: 'onboarding.md#3', file: 2, chunk: 3, similarity: 0.77, rerank: 0.63 },
  { id: 'leave-policy.md#3', file: 0, chunk: 3, similarity: 0.75, rerank: 0.88 },
];

const RERANKED = [...RETRIEVED].sort((a, b) => b.rerank - a.rerank);
const TOP_N = 3;

const ANSWER =
  'New hires get 20 days of paid vacation a year, accrued monthly from the start date. Up to 5 unused days carry over into the next year.';

function isRetrieved(file: number, chunk: number, step: number): boolean {
  const pool = step >= 4 ? RERANKED.slice(0, TOP_N) : RETRIEVED;
  return step >= 3 && pool.some((hit) => hit.file === file && hit.chunk === chunk);
}

/** A handbook going through the RAG pipeline: chunked, embedded, retrieved, reranked, cited. */
export function RagDemo() {
  const { ref, step } = useDemoTimeline(DURATIONS);
  const rows = step >= 4 ? RERANKED : RETRIEVED;

  return (
    <div ref={ref} className="flex h-full flex-col">
      <DemoBar
        label="RAGPipeline · ./handbook"
        right={
          <span className="font-mono text-[11px] text-l-muted">
            {step >= 1 ? '3 docs · 41 chunks' : '3 docs'}
          </span>
        }
      />

      <div className="flex flex-wrap gap-1 border-b border-l-line px-4 py-2">
        {STAGES.map((stage, index) => (
          <Pill key={stage} active={index === step} done={index < step}>
            {stage}
          </Pill>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 gap-4 px-4 py-3 md:grid-cols-[0.85fr_1.15fr]">
        <div className="hidden min-w-0 flex-col justify-center gap-3 md:flex">
          {FILES.map((file, fileIndex) => (
            <div key={file.name}>
              <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-l-muted">
                <FileText className="size-3 text-l-brass/80" />
                {file.name}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-[3px]">
                {Array.from({ length: file.chunks }, (_, chunk) => {
                  const hit = isRetrieved(fileIndex, chunk, step);
                  return (
                    <m.span
                      key={chunk}
                      className={cx(
                        'h-3 w-[14px] rounded-[2px] border transition-colors duration-500',
                        hit
                          ? 'border-l-accent/70 bg-l-accent/30'
                          : step >= 2
                            ? 'border-l-info/25 bg-l-info/15'
                            : 'border-l-line-strong bg-white/[0.03]'
                      )}
                      initial={false}
                      animate={{
                        opacity: step >= 1 ? 1 : 0,
                        scale: step >= 1 ? 1 : 0.6,
                      }}
                      transition={{
                        duration: 0.35,
                        ease: EASE,
                        delay: step === 1 ? (fileIndex * 6 + chunk) * 0.012 : 0,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="relative min-w-0">
          <AnimatePresence mode="wait" initial={false}>
            {step < 3 ? (
              <m.div
                key="ingest"
                className="space-y-2 font-mono text-[11.5px]"
                exit={{ opacity: 0, transition: { duration: 0.15 } }}
              >
                <p className="text-l-muted">
                  <span className="text-l-faint">$</span> pipeline.ingest(&apos;./handbook&apos;)
                </p>
                <p className="text-l-faint">MarkdownLoader → 3 documents</p>
                {step >= 1 && (
                  <p className="text-l-faint">recursive · 512 / 50 overlap → 41 chunks</p>
                )}
                {step >= 2 && <p className="text-l-info">embedBatch → 41 vectors stored</p>}
              </m.div>
            ) : step < 5 ? (
              <m.div
                key="retrieve"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.15 } }}
                transition={{ duration: 0.35, ease: EASE }}
              >
                <p className="mb-2.5 truncate text-[12.5px] text-l-text">
                  How many vacation days do new hires get?
                </p>
                <ul className="space-y-1">
                  {rows.map((hit, index) => {
                    const dropped = step >= 4 && index >= TOP_N;
                    return (
                      <m.li
                        key={hit.id}
                        layout
                        transition={{ duration: 0.5, ease: EASE }}
                        className={cx(
                          'flex items-center justify-between gap-3 rounded-md border px-2 py-1 font-mono text-[11px] transition-opacity',
                          dropped ? 'border-transparent opacity-35' : 'border-l-line bg-l-raised'
                        )}
                      >
                        <span className="truncate text-l-muted">{hit.id}</span>
                        <span className={step >= 4 ? 'text-l-accent' : 'text-l-info'}>
                          {(step >= 4 ? hit.rerank : hit.similarity).toFixed(2)}
                        </span>
                      </m.li>
                    );
                  })}
                </ul>
                <p className="mt-2 font-mono text-[10.5px] text-l-faint">
                  {step >= 4 ? 'CohereReranker · topN 3' : 'similarity · topK 12'}
                </p>
              </m.div>
            ) : (
              <m.div
                key="answer"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.15 } }}
                transition={{ duration: 0.35, ease: EASE }}
                className="text-[12.5px] leading-relaxed"
              >
                <p className="mb-2 font-mono text-[10.5px] text-l-faint">hr-assistant</p>
                <p className="text-l-text">
                  <Streamed text={ANSWER} play={step === 5} />
                </p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {['leave-policy.md#2', 'leave-policy.md#3'].map((source) => (
                    <span
                      key={source}
                      className="rounded border border-l-line-strong px-1.5 font-mono text-[10.5px] leading-5 text-l-muted"
                    >
                      {source}
                    </span>
                  ))}
                </div>
              </m.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
