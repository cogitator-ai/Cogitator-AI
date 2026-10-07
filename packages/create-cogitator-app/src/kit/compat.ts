import { providerInfo } from './providers.js';
import { hasFeature, type FeatureId, type ProjectSpec } from './spec.js';

/** A combination the generated project could not work with, and how to fix it. */
export interface CompatIssue {
  message: string;
  fix: string;
}

const A2A_SERVERS = new Set(['express', 'fastify', 'hono', 'koa']);

/** Features that need agents to run inside a long-lived process with its own entry point. */
const SCRIPT_OR_SERVER_ONLY: FeatureId[] = ['voice'];

/**
 * Every reason `spec` describes a project that would not work, empty when it is
 * consistent. Checked before any file is written, so an impossible project is
 * refused instead of generated half-broken.
 */
export function compatibilityIssues(spec: ProjectSpec): CompatIssue[] {
  const issues: CompatIssue[] = [];
  const provider = providerInfo(spec.provider);

  if (spec.app === 'server' && !spec.server) {
    issues.push({
      message: 'A server app needs a server framework',
      fix: 'pass --server hono, express, fastify, koa or tetsu',
    });
  }
  if (spec.app !== 'server' && spec.server) {
    issues.push({
      message: `--server ${spec.server} only applies to the server app`,
      fix: 'pass --app server, or leave out --server',
    });
  }

  if (spec.app === 'channels' && spec.channels.length === 0) {
    issues.push({
      message: 'A messaging bot needs at least one channel',
      fix: 'pass --channels webchat, telegram, discord or slack',
    });
  }
  if (spec.app !== 'channels' && spec.channels.length > 0) {
    issues.push({
      message: '--channels only applies to the messaging bot app',
      fix: 'pass --app channels, or leave out --channels',
    });
  }

  if (spec.server === 'tetsu' && spec.packageManager !== 'bun') {
    issues.push({
      message: 'Tetsu servers run on Bun',
      fix: 'pass --pm bun, or pick another --server',
    });
  }

  if (spec.server === 'tetsu' && (spec.memory === 'sqlite' || hasFeature(spec, 'harness'))) {
    issues.push({
      message:
        'better-sqlite3, which SQLite memory and the assistant harness use, does not run on Bun',
      fix: 'use --memory memory, redis, postgres or mongodb with Tetsu, or another --server',
    });
  }

  if (hasFeature(spec, 'durable') && !hasFeature(spec, 'workflows')) {
    issues.push({
      message: 'Durable workflows build on the workflows feature',
      fix: 'add workflows to --features',
    });
  }

  if (hasFeature(spec, 'rag') && !provider.embeddingModel) {
    issues.push({
      message: `RAG needs embeddings, and ${provider.label} has no embedding API`,
      fix: 'use --provider openai, google or ollama for a RAG project',
    });
  }
  if (spec.vectorStore !== 'memory' && !hasFeature(spec, 'rag')) {
    issues.push({
      message: `--vector-store ${spec.vectorStore} only applies to RAG`,
      fix: 'add rag to --features, or leave out --vector-store',
    });
  }

  if (hasFeature(spec, 'voice')) {
    if (!provider.realtime) {
      issues.push({
        message: `Realtime voice needs a realtime API, and ${provider.label} has none`,
        fix: 'use --provider openai or google for a voice project',
      });
    }
  }
  for (const feature of SCRIPT_OR_SERVER_ONLY) {
    if (hasFeature(spec, feature) && spec.app !== 'script' && spec.app !== 'server') {
      issues.push({
        message: `The ${feature} feature runs its own WebSocket server`,
        fix: 'use --app script or --app server for it',
      });
    }
  }

  if (hasFeature(spec, 'a2a')) {
    const servable =
      spec.app === 'next' || (spec.app === 'server' && A2A_SERVERS.has(spec.server ?? ''));
    if (!servable) {
      issues.push({
        message: 'A2A serves agents over HTTP from Express, Fastify, Hono, Koa or Next.js',
        fix: 'use --app server with --server hono, express, fastify or koa, or --app next',
      });
    }
  }

  if (spec.app === 'next' && spec.server) {
    issues.push({ message: 'Next.js is its own server', fix: 'leave out --server' });
  }

  if (spec.deploy === 'fly' && spec.memory === 'mongodb') {
    issues.push({
      message: 'Fly.io has no managed MongoDB the deploy can provision',
      fix: 'use --memory postgres, redis or sqlite with --deploy fly',
    });
  }

  return issues;
}

export class IncompatibleSpecError extends Error {
  readonly issues: CompatIssue[];

  constructor(issues: CompatIssue[]) {
    super(
      [
        'The chosen options do not fit together:',
        ...issues.map((i) => `- ${i.message}: ${i.fix}`),
      ].join('\n')
    );
    this.name = 'IncompatibleSpecError';
    this.issues = issues;
  }
}

export function assertCompatible(spec: ProjectSpec): void {
  const issues = compatibilityIssues(spec);
  if (issues.length > 0) throw new IncompatibleSpecError(issues);
}
