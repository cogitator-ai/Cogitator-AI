import Link from 'next/link';
import { ArrowUpRight, Braces } from 'lucide-react';
import type { SimpleIcon } from 'simple-icons';
import { CopyCommand } from '../CopyCommand';
import { highlightCode } from '../highlight';
import { RuntimeSwitcherIsland } from '../islands';
import { Section, SectionHeader } from '../ui';
import { RUNTIME_TABS } from './anywhere/data';
import type { RuntimeTab } from './anywhere/types';

const TEMPLATES = [
  'basic',
  'assistant',
  'api-server',
  'hono',
  'nextjs',
  'channels',
  'rag',
  'mcp',
  'workflow',
  'a2a',
  'evals',
];

function BrandIcon({ icon }: { icon: SimpleIcon | null }) {
  if (!icon) return <Braces className="size-3.5" aria-hidden />;
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 fill-current" aria-hidden>
      <path d={icon.path} />
    </svg>
  );
}

export async function RunsAnywhereSection() {
  const tabs: RuntimeTab[] = await Promise.all(
    RUNTIME_TABS.map(async ({ icon, files, ...tab }) => ({
      ...tab,
      icon: <BrandIcon icon={icon} />,
      files: await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          code: await highlightCode(file.code, file.lang),
        }))
      ),
    }))
  );

  return (
    <Section id="runs-anywhere">
      <SectionHeader
        eyebrow="Runs anywhere"
        title={
          <>
            Drop it into the stack <span className="text-l-muted">you already run.</span>
          </>
        }
        description="One adapter call turns your agents into an HTTP API with SSE streaming, memory threads, approvals and a WebSocket — on Express, Fastify, Hono, Koa, Next.js, Tetsu on Bun, Deno or Cloudflare Workers. Or keep your client: speak OpenAI's Chat Completions and Responses APIs, or hand an agent to the Vercel AI SDK as a model."
      />

      <div className="mt-12 sm:mt-14">
        <RuntimeSwitcherIsland tabs={tabs} />
      </div>

      <div className="mt-10 grid gap-6 border-t border-l-line pt-8 md:grid-cols-[auto_1fr] md:items-center md:gap-10">
        <CopyCommand
          command="npx create-cogitator-app my-api -t api-server"
          className="w-full max-w-full overflow-x-auto md:w-auto"
        />
        <div className="min-w-0">
          <p className="text-sm text-l-muted text-pretty">
            Starting from scratch? The scaffolder writes a ready-to-run project from one of 16
            presets, with tests, a production Dockerfile and Cogitator Studio, and installs it.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-[11px]">
            <span className="uppercase tracking-[0.14em] text-l-brass">presets</span>
            {TEMPLATES.map((template) => (
              <span key={template} className="text-l-faint">
                {template}
              </span>
            ))}
            <Link
              href="/docs/getting-started/scaffolding"
              className="inline-flex items-center gap-1 text-l-muted transition-colors hover:text-l-text"
            >
              scaffolding guide
              <ArrowUpRight className="size-3" />
            </Link>
          </div>
        </div>
      </div>
    </Section>
  );
}
