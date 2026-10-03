'use client';

import { Suspense, use, type ComponentType } from 'react';
import type { FeatureId } from './types';

type DemoLoader = () => Promise<ComponentType>;

/** Each demo is its own chunk: the explorer loads the one on screen and the one after it. */
const LOADERS: Record<FeatureId, DemoLoader> = {
  memory: () => import('./demos-a/MemoryDemo').then((module) => module.MemoryDemo),
  rag: () => import('./demos-a/RagDemo').then((module) => module.RagDemo),
  mcp: () => import('./demos-a/McpDemo').then((module) => module.McpDemo),
  a2a: () => import('./demos-a/A2aDemo').then((module) => module.A2aDemo),
  channels: () => import('./demos-a/ChannelsDemo').then((module) => module.ChannelsDemo),
  voice: () => import('./demos-a/VoiceDemo').then((module) => module.VoiceDemo),
  browser: () => import('./demos-a/BrowserDemo').then((module) => module.BrowserDemo),
  evals: () => import('./demos-a/EvalsDemo').then((module) => module.EvalsDemo),
  sandbox: () => import('./demos-b/SandboxDemo').then((module) => module.SandboxDemo),
  safety: () => import('./demos-b/SafetyDemo').then((module) => module.SafetyDemo),
  observability: () => import('./demos-b/TraceDemo').then((module) => module.TraceDemo),
  handoffs: () => import('./demos-b/HandoffDemo').then((module) => module.HandoffDemo),
  reasoning: () => import('./demos-b/ThoughtTreeDemo').then((module) => module.ThoughtTreeDemo),
  'time-travel': () => import('./demos-b/TimeTravelDemo').then((module) => module.TimeTravelDemo),
  'prompt-versions': () =>
    import('./demos-b/PromptVersionsDemo').then((module) => module.PromptVersionsDemo),
  'neuro-symbolic': () => import('./demos-b/LogicDemo').then((module) => module.LogicDemo),
  ship: () => import('./demos-b/ShipDemo').then((module) => module.ShipDemo),
};

const pending = new Map<FeatureId, Promise<ComponentType>>();
const loaded = new Map<FeatureId, ComponentType>();

/** Stands in for a demo whose chunk failed to load; the next visit to the feature retries. */
function NoDemo() {
  return null;
}

/** Starts loading a demo's chunk (once) and resolves to its component. */
export function preloadDemo(id: FeatureId): Promise<ComponentType> {
  let loading = pending.get(id);
  if (!loading) {
    loading = LOADERS[id]().then(
      (component) => {
        loaded.set(id, component);
        return component;
      },
      () => {
        pending.delete(id);
        return NoDemo;
      }
    );
    pending.set(id, loading);
  }
  return loading;
}

if (typeof window === 'undefined') {
  for (const id of Object.keys(LOADERS) as FeatureId[]) void preloadDemo(id);
}

function LoadedDemo({ id }: { id: FeatureId }) {
  const Demo = loaded.get(id) ?? use(preloadDemo(id));
  return <Demo />;
}

/**
 * The live demo for a feature; the window around it keeps its size while the chunk loads.
 * The server renders it without a Suspense boundary (React would move a large one to the end
 * of the HTML); that is safe because the explorer is an island and is never hydrated.
 */
export function LiveDemo({ id }: { id: FeatureId }) {
  if (typeof window === 'undefined') return <LoadedDemo id={id} />;
  return (
    <Suspense fallback={null}>
      <LoadedDemo id={id} />
    </Suspense>
  );
}
