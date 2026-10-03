import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { highlightCode } from '../highlight';
import { CodeBody, Section, SectionHeader, Window, cx } from '../ui';
import { WorkflowRun } from './workflows/WorkflowRun';

const PIPELINE_CODE = `
const checkpoints = new PostgresCheckpointStore({ client: pool });
const executor = new WorkflowExecutor(cog, checkpoints);

const draft = agentNode<Post>(writer, {
  stateMapper: (run) => ({ draft: run.output }),
});
const review = humanWorkflowNode<Post>(
  approvalNode('review', { title: 'Publish this post?' }),
  { stateMapper: (answer) => ({ approved: answer.approved }) }
);
const publish = functionNode<Post>('publish', async (post) =>
  post.approved ? cms.publish(post.draft) : null
);

const pipeline = new WorkflowBuilder<Post>('publish-post')
  .addNode('research', agentNode(researcher))
  .addNode('draft', draft, { after: ['research'] })
  .addNode('fact-check', agentNode(checker), { after: ['research'] })
  .addNode('review', review, { after: ['draft', 'fact-check'] })
  .addNode('publish', publish, { after: ['review'] })
  .build();

const durable = {
  checkpoint: true,
  checkpointStrategy: 'per-node',
  approvalStore: new PostgresApprovalStore({ client: pool }),
} as const;

await executor.execute(pipeline, { topic }, durable);

const [last] = await checkpoints.list('publish-post');
await executor.resume(pipeline, last.id, durable);
`;

const PROOF_POINTS = [
  {
    label: 'config.compensation',
    text: 'A failed step undoes the finished ones in reverse order — with retries, circuit breakers and a dead-letter queue.',
    href: '/docs/workflows/sagas',
    link: 'Sagas',
  },
  {
    label: 'cronTrigger · webhookTrigger',
    text: 'Start runs on a cron schedule in any time zone, from a rate-limited webhook, or on an internal event.',
    href: '/docs/workflows/scheduling',
    link: 'Scheduling',
  },
  {
    label: 'mapReduceWorkflowNode',
    text: 'Fan a list out across agents, reduce the results, and nest whole workflows as subworkflow steps.',
    href: '/docs/workflows/patterns',
    link: 'Patterns',
  },
] as const;

export async function WorkflowsSection() {
  const code = await highlightCode(PIPELINE_CODE);

  return (
    <Section id="workflows">
      <SectionHeader
        eyebrow="Durable workflows"
        title={
          <>
            Workflows that outlive <span className="text-l-muted">the process.</span>
          </>
        }
        description="Wire agents, tools and human sign-offs into a DAG. Each finished node is checkpointed to Postgres or Redis, so a crash, a deploy or an approval that takes all afternoon picks up where it stopped — not from the top."
      />

      <div className="mt-14 grid gap-4 lg:grid-cols-[1.08fr_1fr]">
        <Window title="publish-post.ts" className="min-w-0">
          <CodeBody>{code}</CodeBody>
        </Window>
        <WorkflowRun />
      </div>

      <p className="mt-5 text-sm leading-relaxed text-l-muted">
        checkpointStrategy: &apos;per-node&apos; — on resume, finished nodes are skipped and only
        the nodes that were in flight run again · @cogitator-ai/workflows
      </p>

      <ul className="mt-14 grid border-t border-l-line sm:grid-cols-3">
        {PROOF_POINTS.map((point, index) => (
          <li
            key={point.label}
            className={cx(index > 0 && 'border-t border-l-line sm:border-l sm:border-t-0')}
          >
            <Link
              href={point.href}
              className={cx(
                'group flex h-full flex-col gap-2.5 py-6 focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-l-accent/60',
                index === 0 ? 'sm:pr-6' : 'sm:px-6'
              )}
            >
              <span className="font-mono text-[11px] text-l-text">{point.label}</span>
              <span className="text-sm leading-relaxed text-l-muted text-pretty">{point.text}</span>
              <span className="mt-auto inline-flex items-center gap-1 pt-1 font-mono text-xs text-l-muted transition-colors group-hover:text-l-text">
                {point.link}
                <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
