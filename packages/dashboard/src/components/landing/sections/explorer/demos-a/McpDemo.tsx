'use client';

import { motion } from 'framer-motion';
import { ArrowRight, Check, Wrench } from 'lucide-react';
import { siClaude, siGithub, type SimpleIcon } from 'simple-icons';
import type { ReactNode } from 'react';
import { Badge, cx, Vox } from '../../../ui';
import { DemoBar, EASE, Reveal, Streamed, useDemoTimeline } from './shared';

const DURATIONS = [800, 1100, 1000, 1000, 1000, 900, 900, 3600] as const;

const GITHUB_TOOLS = ['list_issues', 'get_issue', 'update_issue', 'add_issue_comment'];

/** Which GitHub tool the triage agent is calling at each step. */
const CALL_AT_STEP: Record<number, string> = {
  4: 'get_issue',
  5: 'update_issue',
  6: 'add_issue_comment',
};

function BrandIcon({ icon, className }: { icon: SimpleIcon; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cx('fill-current', className)}>
      <path d={icon.path} />
    </svg>
  );
}

function Panel({
  icon,
  title,
  caption,
  children,
  bodyClassName,
}: {
  icon: SimpleIcon;
  title: string;
  caption: string;
  children: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-l-line bg-l-bg/50">
      <div className="flex items-center gap-2 border-b border-l-line px-3 py-2">
        <BrandIcon icon={icon} className="size-3.5 shrink-0 text-l-brass" />
        <span className="truncate text-[12px] text-l-text">{title}</span>
        <span className="ml-auto hidden shrink-0 font-mono text-[10px] text-l-faint sm:inline">
          {caption}
        </span>
      </div>
      <div className={cx('min-h-0 flex-1 overflow-hidden p-3', bodyClassName)}>{children}</div>
    </div>
  );
}

/** One agent that consumes an MCP server's tools and is itself served to Claude Desktop. */
export function McpDemo() {
  const { ref, step } = useDemoTimeline(DURATIONS);
  const calling = CALL_AT_STEP[step];
  const called = (tool: string) =>
    Object.entries(CALL_AT_STEP).some(([at, name]) => name === tool && Number(at) < step);

  return (
    <div ref={ref} className="flex h-full flex-col">
      <DemoBar
        label="agent: triage"
        right={
          step >= 7 ? (
            <Badge tone="accent">
              <Check className="size-2.5" /> completed
            </Badge>
          ) : step >= 4 ? (
            <Badge tone="info">
              <span className="size-1.5 animate-pulse rounded-full bg-l-info" /> running
            </Badge>
          ) : (
            <span className="font-mono text-[10.5px] text-l-faint">idle</span>
          )
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-2.5 p-3 sm:gap-3 sm:p-4">
        <Panel
          icon={siGithub}
          title="server-github"
          caption="MCPClient · stdio"
          bodyClassName="space-y-1.5"
        >
          <p className="mb-2 font-mono text-[10.5px] text-l-faint">
            {step >= 1 ? 'getTools() → agent' : 'connecting…'}
          </p>
          {GITHUB_TOOLS.map((tool, index) => (
            <Reveal key={tool} show={step >= 1}>
              <motion.div
                initial={false}
                animate={{ x: calling === tool ? 4 : 0 }}
                transition={{ duration: 0.3, ease: EASE, delay: step === 1 ? index * 0.06 : 0 }}
                className={cx(
                  'flex items-center gap-1.5 truncate rounded-md border px-2 py-1 font-mono text-[10.5px] transition-colors duration-300 sm:text-[11px]',
                  calling === tool
                    ? 'border-l-accent/40 bg-l-accent/[0.07] text-l-accent'
                    : called(tool)
                      ? 'border-l-line text-l-muted'
                      : 'border-l-line text-l-faint'
                )}
              >
                <Wrench className="size-3 shrink-0" />
                <span className="truncate">{tool}</span>
                {called(tool) && <Check className="ml-auto size-3 shrink-0 text-l-accent/80" />}
              </motion.div>
            </Reveal>
          ))}
        </Panel>

        <Panel
          icon={siClaude}
          title="Claude Desktop"
          caption="serveAgents · stdio"
          bodyClassName="flex flex-col justify-end gap-1.5 [&>*]:shrink-0"
        >
          <Reveal show={step >= 2}>
            <p className="mb-2 truncate font-mono text-[10.5px] text-l-faint">
              cogitator-agents · tool: <span className="text-l-muted">triage</span>
            </p>
          </Reveal>
          <Reveal show={step >= 3}>
            <div className="ml-auto w-fit max-w-full rounded-lg rounded-tr-sm bg-white/[0.06] px-2.5 py-1.5 text-[11.5px] text-l-text sm:text-[12px]">
              Triage acme/api#418
            </div>
          </Reveal>
          <Reveal show={step >= 4}>
            <div className="rounded-md border border-l-line bg-l-raised px-2 py-1.5 font-mono text-[10.5px] sm:text-[11px]">
              <div className="flex items-center gap-1.5 text-l-text">
                <ArrowRight className="size-3 shrink-0 text-l-violet" />
                triage
              </div>
              <div className="mt-0.5 truncate text-l-faint">
                {step >= 7
                  ? "{ status: 'completed', threadId }"
                  : "{ task: 'Triage acme/api#418' }"}
              </div>
            </div>
          </Reveal>
          <Reveal show={step >= 7}>
            <p className="text-[11.5px] leading-relaxed text-l-muted sm:text-[12px]">
              <Streamed
                text="Labeled it bug + p2 and drafted a reply asking for the stack trace."
                play={step === 7}
              />
            </p>
          </Reveal>
        </Panel>
      </div>

      <div className="flex items-center gap-2 border-t border-l-line px-4 py-2.5 font-mono text-[10.5px] text-l-faint">
        <span className="truncate">tools in from MCP · agent out as an MCP tool</span>
        <span className="ml-auto shrink-0">
          {step >= 7 ? <Vox>transmission complete</Vox> : calling ? `→ ${calling}` : ''}
        </span>
      </div>
    </div>
  );
}
