'use client';

import { FileCode2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Vox, cx } from '../../../ui';
import { Chip, DemoFrame, Reveal, Typed, useDemoTimeline } from './shared';

const DURATIONS = [2000, 600, 700, 1800, 800, 900, 1100, 1500, 3200];
const DEPLOYED_STEP = 7;
const DONE_STEP = 8;

const SCAFFOLD = 'npx create-cogitator-app support-bot -t api-server -p anthropic -y';
const DEPLOY = 'cd support-bot && cogitator deploy --target fly --region fra';

function Line({
  show,
  children,
  className,
}: {
  show: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Reveal show={show} className={cx('break-words', className)}>
      {children}
    </Reveal>
  );
}

function Prompt({ text, play }: { text: string; play: boolean }) {
  return (
    <div className="break-words text-l-text">
      <span className="crt-glow text-l-accent">$ </span>
      <Typed text={text} play={play} speed={26} />
    </div>
  );
}

/** From an empty folder to a running agent on Fly.io: scaffold, plan, preflight, deploy. */
export function ShipDemo() {
  const timeline = useDemoTimeline(DURATIONS);
  const { step } = timeline;

  return (
    <DemoFrame
      timeline={timeline}
      label="~/projects · zsh"
      aside={
        step >= DEPLOYED_STEP ? (
          <Badge tone="accent">deployed</Badge>
        ) : step >= 3 ? (
          <Badge tone="brass">fly · fra</Badge>
        ) : (
          <Badge tone="neutral">scaffold</Badge>
        )
      }
      footer={
        <>
          <FileCode2 className="size-3 text-l-brass" />
          {step >= 6 ? (
            <>
              <Chip tone="brass">.cogitator/Dockerfile</Chip>
              <Chip tone="brass">.cogitator/fly.toml</Chip>
              <Chip tone="brass">.dockerignore</Chip>
            </>
          ) : (
            <span>no Dockerfile written by hand</span>
          )}
        </>
      }
      bodyClassName="flex flex-col justify-end [&>*]:shrink-0"
    >
      <div className="space-y-0.5 font-mono text-[11px] leading-[1.6]">
        <Prompt text={SCAFFOLD} play={step === 0} />
        <Line show={step >= 1} className="text-l-muted">
          <span className="text-l-brass">◇</span> Generated project files
        </Line>
        <Line show={step >= 2} className="text-l-muted">
          <span className="text-l-brass">◇</span> Installed dependencies
        </Line>

        <Line show={step >= 3}>
          <Prompt text={DEPLOY} play={step === 3} />
        </Line>
        <Line show={step >= 4} className="text-l-muted">
          <span className="text-l-info">ℹ</span> Deploy plan for{' '}
          <span className="text-l-text">fly</span>
          <span className="text-l-faint"> · server express · app support-bot</span>
        </Line>
        <Line show={step >= 5} className="text-l-faint">
          {'  '}Required secrets: <span className="text-l-warn">○</span> ANTHROPIC_API_KEY
        </Line>
        <Line show={step >= 6} className="text-l-muted">
          {'  '}
          <span className="text-l-accent">✓</span> flyctl is available{'  '}
          <span className="text-l-accent">✓</span> Logged in as you@acme.dev{'  '}
          <span className="text-l-accent">✓</span> ANTHROPIC_API_KEY is set
        </Line>
        <Line show={step >= DEPLOYED_STEP} className="text-l-text">
          <span className="text-l-accent">✓</span> Deployed successfully
        </Line>
        <Line show={step >= DEPLOYED_STEP} className="text-l-muted">
          <span className="text-l-accent">✓</span> URL:{' '}
          <span className="text-l-text underline decoration-l-line-strong underline-offset-2">
            {'https://support-bot.fly.dev'}
          </span>
        </Line>
        <Line show={step >= DONE_STEP} className="text-l-faint">
          {'  A2A: https://support-bot.fly.dev/.well-known/agent.json'}
        </Line>
        <Line show={step >= DONE_STEP} className="pt-1">
          <Vox>agent deployed</Vox>
        </Line>
      </div>
    </DemoFrame>
  );
}
