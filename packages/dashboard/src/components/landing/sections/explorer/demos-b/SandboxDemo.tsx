'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { Box, Cpu } from 'lucide-react';
import { Badge, Vox } from '../../../ui';
import { Chip, DemoFrame, EASE, Reveal, SceneTabs, useDemoTimeline } from './shared';

const DURATIONS = [900, 1100, 1000, 1100, 2600, 900, 1000, 2800];
const SCENES = ['docker', 'wasm'] as const;
const SCENE_START = [0, 5];
const SCENE_END = [4, 7];

const UNTRUSTED = [
  'import statistics, urllib.request',
  'print(statistics.mean([412, 380, 455]))',
  'urllib.request.urlopen("http://exfil.io")',
];

function DockerScene({ step }: { step: number }) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 font-mono text-[10.5px] text-l-faint">
        <Box className="size-3 text-l-brass" />
        code written by the model
      </div>
      <pre className="overflow-hidden rounded-md border border-l-line bg-l-raised px-3 py-2 font-mono text-[11px] leading-[1.55] text-l-muted">
        {UNTRUSTED.map((line) => (
          <div key={line} className="truncate">
            {line}
          </div>
        ))}
      </pre>

      <Reveal show={step >= 1} className="flex flex-wrap gap-1.5">
        <Chip tone="brass">python:3.12-slim · fresh</Chip>
        <Chip>network none</Chip>
        <Chip>128MB</Chip>
        <Chip>0.5 cpu</Chip>
        <Chip>5s</Chip>
      </Reveal>

      <div className="space-y-1 font-mono text-[11px] leading-[1.5]">
        <Reveal show={step >= 2} className="flex gap-2">
          <span className="w-11 shrink-0 text-l-faint">stdout</span>
          <span className="text-l-text">415.6666666666667</span>
        </Reveal>
        <Reveal show={step >= 3} className="flex gap-2">
          <span className="w-11 shrink-0 text-l-faint">stderr</span>
          <span className="min-w-0 break-words text-l-danger/90">
            URLError: [Errno -3] Temporary failure in name resolution
          </span>
        </Reveal>
      </div>

      <Reveal
        show={step >= 4}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10.5px] text-l-faint"
      >
        <Vox tone="warn">egress denied</Vox>
        <span className="text-l-muted">exitCode 1</span>
        <span>640ms</span>
        <span>container destroyed</span>
      </Reveal>
    </div>
  );
}

function WasmScene({ step }: { step: number }) {
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 font-mono text-[10.5px] text-l-faint">
        <Cpu className="size-3 text-l-brass" />
        calculate · @cogitator-ai/wasm-tools
      </div>
      <div className="rounded-md border border-l-line bg-l-raised px-3 py-2 font-mono text-[11px] leading-[1.55] text-l-muted">
        {'{ "expression": "(412 + 380 + 455) / 3" }'}
      </div>

      <Reveal show={step >= 6} className="flex flex-wrap gap-1.5">
        <Chip tone="brass">extism · worker thread</Chip>
        <Chip>16 MB memory</Chip>
        <Chip>no allowed hosts</Chip>
        <Chip>5s</Chip>
      </Reveal>

      <Reveal show={step >= 7} className="space-y-1.5">
        <div className="flex gap-2 font-mono text-[11px] leading-[1.5]">
          <span className="w-11 shrink-0 text-l-faint">result</span>
          <span className="crt-glow min-w-0 break-words text-l-accent">
            {'{ "result": 415.6666666666667 }'}
          </span>
        </div>
        <div className="font-mono text-[10.5px] text-l-faint">
          no Docker daemon needed · plugins pooled per module
        </div>
        <Vox>result returned</Vox>
      </Reveal>
    </div>
  );
}

/** Untrusted code in a throwaway container with no network, then a pure-WASM tool. */
export function SandboxDemo() {
  const timeline = useDemoTimeline(DURATIONS);
  const { step, reduced, goTo } = timeline;
  const scene = step >= SCENE_START[1] ? 1 : 0;

  const status =
    scene === 0 ? (
      step >= 4 ? (
        <Badge tone="neutral">exit 1</Badge>
      ) : (
        <Badge tone="info">
          <span className="size-1.5 animate-pulse rounded-full bg-l-info" /> running
        </Badge>
      )
    ) : step >= 7 ? (
      <Badge tone="accent">ok</Badge>
    ) : (
      <Badge tone="info">
        <span className="size-1.5 animate-pulse rounded-full bg-l-info" /> running
      </Badge>
    );

  return (
    <DemoFrame
      timeline={timeline}
      label={scene === 0 ? 'sandbox.execute · docker' : 'wasm tool · extism'}
      aside={
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline-flex">{status}</span>
          <SceneTabs
            label="Sandbox backend"
            scenes={SCENES}
            active={scene}
            onSelect={(index) => goTo(reduced ? SCENE_END[index] : SCENE_START[index])}
          />
        </div>
      }
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={scene}
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -8 }}
          transition={{ duration: 0.3, ease: EASE }}
        >
          {scene === 0 ? <DockerScene step={step} /> : <WasmScene step={step} />}
        </motion.div>
      </AnimatePresence>
    </DemoFrame>
  );
}
