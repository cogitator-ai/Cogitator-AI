import Link from 'next/link';
import { ArrowRight, Bot } from 'lucide-react';
import corePackage from '../../../../core/package.json';
import { DOCS_HOME, LLMS_TXT_URL } from '@/lib/site';
import { CopyCommand } from './CopyCommand';
import { HeroRun } from './HeroRun';
import { highlightCode } from './highlight';
import { CogitatorFrame } from './CogitatorFrame';
import { CodeBody } from './ui';

const AGENT_CODE = `
const refund = tool({
  name: 'refund_order',
  description: 'Refund part or all of an order.',
  parameters: z.object({ order: z.string(), amount: z.number() }),
  requiresApproval: ({ amount }) => amount > 100,
  execute: ({ order, amount }) => payments.refund(order, amount),
});

const support = new Agent({
  name: 'support',
  model: 'anthropic/claude-sonnet-5-5',
  instructions: 'Refund orders when the customer asks.',
  tools: [refund],
});

const run = await cog.run(support, { input, threadId });

if (run.status === 'paused') {
  await cog.resume(support, threadId, {
    defaultDecision: { approved: true },
  });
}
`;

const HERO_PSALM =
  '+++ INVOCATION 14-APPROVALS +++ 01100011 01101111 01100111 01101001 01110100 01100001 01110100 01101111 01110010 +++ 0x7C3A 9F41 E2B0 +++ 01110011 01110000 01101001 01110010 01101001 01110100 +++';

export async function Hero() {
  const code = await highlightCode(AGENT_CODE);

  return (
    <section className="relative overflow-hidden px-5 pb-20 pt-36 sm:px-8 sm:pt-44">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[720px] bg-[radial-gradient(60%_50%_at_50%_0%,rgba(0,255,136,0.10),transparent_70%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[720px] bg-[linear-gradient(to_right,rgb(255_255_255/0.035)_1px,transparent_1px),linear-gradient(to_bottom,rgb(255_255_255/0.035)_1px,transparent_1px)] bg-[size:64px_64px] [mask-image:radial-gradient(55%_60%_at_50%_0%,black,transparent)]"
      />

      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 top-[520px] h-[620px] w-[520px] bg-[radial-gradient(closest-side,rgba(255,179,71,0.10),transparent)] blur-2xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 top-[560px] h-[620px] w-[520px] bg-[radial-gradient(closest-side,rgba(255,179,71,0.09),transparent)] blur-2xl"
      />
      <div className="relative mx-auto max-w-6xl">
        <div className="mx-auto max-w-3xl text-center">
          <a
            href="https://www.npmjs.com/package/@cogitator-ai/core"
            target="_blank"
            rel="noopener noreferrer"
            className="cog-plaque inline-flex items-center gap-2 !px-3 !py-1 font-[family-name:var(--font-screen)] text-[11px] uppercase tracking-[0.08em] sm:gap-2.5 sm:!px-4 sm:text-[12px] sm:tracking-[0.14em] text-[#e2c58c] transition-colors hover:text-[#f3dcaa]"
          >
            <span className="text-[#a8d9c7] [text-shadow:0_0_6px_rgb(127_212_181/0.35)]">
              v{corePackage.version}
            </span>
            <span className="text-l-brass/60">·</span>
            Open source · MIT · TypeScript
          </a>

          <h1 className="imperial mt-8 text-[2.3rem] font-semibold leading-[1.1] text-l-text text-balance sm:text-[3.6rem]">
            Agents that survive
            <br />
            <span className="text-l-muted">production.</span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-l-muted text-pretty sm:text-lg">
            A self-hosted TypeScript runtime for AI agents: tools that wait for a human, workflows
            that outlive the process, swarms, memory and RAG — on any model, in your own
            infrastructure.
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <CopyCommand command="npx create-cogitator-app" />
            <Link href={DOCS_HOME} className="brass-ghost group text-[13px]">
              Read the docs
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>

          <a
            href={LLMS_TXT_URL}
            className="mt-6 inline-flex items-center gap-2 text-sm text-l-muted transition-colors hover:text-l-text"
          >
            <Bot className="size-3.5" />
            Agent-friendly docs at <span className="font-mono text-l-muted">/llms.txt</span>
          </a>
        </div>

        <div className="relative mt-16 sm:mt-20">
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-10 -top-10 bottom-0 bg-[radial-gradient(50%_60%_at_50%_30%,rgba(0,255,136,0.07),transparent_70%)] blur-2xl"
          />
          <CogitatorFrame
            title="+++ support-agent · ticket 7731 +++"
            className="relative"
            psalm={HERO_PSALM}
          >
            <div className="grid lg:grid-cols-[1.08fr_1fr]">
              <CodeBody className="border-b border-l-accent/10 lg:border-b-0 lg:border-r">
                {code}
              </CodeBody>
              <div className="min-h-[420px]">
                <HeroRun />
              </div>
            </div>
          </CogitatorFrame>
          <p className="mx-auto mt-5 max-w-3xl text-center text-sm leading-relaxed text-l-muted">
            A run pauses before a sensitive tool and resumes when a human approves — even after a
            restart, with a durable checkpoint store · examples/core/14-approvals.ts
          </p>
        </div>
      </div>
    </section>
  );
}
