import type { Section } from './types';

export const workflows: Section = {
  id: 'workflows',
  title: 'Workflows',
  icon: '🔄',
  description:
    'DAG workflows with tool, agent and function nodes, conditional branches, human approvals and map-reduce.',
  recipes: [
    {
      id: 'basic-workflow',
      title: 'Code Review Workflow',
      difficulty: 'medium',
      time: '15 min',
      problem:
        'A review should always run the same steps — static checks, an LLM review, fixes only when there are enough issues, then a report.',
      points: [
        'Wrap a tool, agents and a function as nodes with `toolNode`, `agentNode` and `functionNode`',
        'Branch with `addConditional()` and join both branches',
        'Run it with `WorkflowExecutor` and per-node callbacks',
      ],
      file: 'basic-workflow.ts',
      code: `import { Agent, Cogitator, tool } from '@cogitator-ai/core';
import { WorkflowBuilder, WorkflowExecutor, agentNode, functionNode, toolNode } from '@cogitator-ai/workflows';
import { z } from 'zod';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

interface ReviewState {
  [key: string]: unknown;
  code: string;
  issues: string[];
  analysis: string;
  fixes: string;
  report: string;
}

const analyzeCode = tool({
  name: 'analyze_code',
  description: 'Find common issues in source code',
  parameters: z.object({ code: z.string() }),
  execute: async ({ code }) => {
    const issues: string[] = [];
    if (/for.*\\n.*for/.test(code)) issues.push('Nested loops');
    if (/TODO|FIXME/.test(code)) issues.push('Unresolved TODO');
    if (/console\\.log/.test(code)) issues.push('Console logging in production code');
    return { issues };
  },
});

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });
const model = 'google/gemini-3.5-flash-lite';

const reviewer = new Agent({
  name: 'code-reviewer',
  model,
  instructions: 'You are a code reviewer. Explain why the found issues matter. Be concise.',
  temperature: 0.3,
});

const fixAdvisor = new Agent({
  name: 'fix-advisor',
  model,
  instructions: 'Suggest a concrete fix with a short code snippet for each issue.',
  temperature: 0.3,
});

const analyze = toolNode<ReviewState, { code: string }>(analyzeCode, {
  argsMapper: (state) => ({ code: state.code }),
  stateMapper: (result) => ({ issues: (result as { issues: string[] }).issues }),
});

const review = agentNode<ReviewState>(reviewer, {
  inputMapper: (state) => \`Issues: \${state.issues.join(', ')}\\n\\nCode:\\n\${state.code}\`,
  stateMapper: (result) => ({ analysis: result.output }),
});

const advise = agentNode<ReviewState>(fixAdvisor, {
  inputMapper: (state) => \`\${state.analysis}\\n\\nCode:\\n\${state.code}\`,
  stateMapper: (result) => ({ fixes: result.output }),
});

const report = functionNode<ReviewState, string>(
  'report',
  async (state) => \`Issues: \${state.issues.length}\\n\\n\${state.analysis}\\n\\nFixes:\\n\${state.fixes}\`,
  { stateMapper: (output) => ({ report: output as string }) }
);

const workflow = new WorkflowBuilder<ReviewState>('code-review')
  .initialState({ code: '', issues: [], analysis: '', fixes: '', report: '' })
  .addNode(analyze.name, analyze.fn)
  .addNode(review.name, review.fn, { after: [analyze.name] })
  .addConditional('severity', (state) => (state.issues.length > 1 ? advise.name : 'minor'), {
    after: [review.name],
  })
  .addNode(advise.name, advise.fn, { after: ['severity'] })
  .addNode('minor', async () => ({ state: { fixes: 'No significant fixes needed.' } }), {
    after: ['severity'],
  })
  .addNode(report.name, report.fn, { after: [advise.name, 'minor'] })
  .entryPoint(analyze.name)
  .build();

const code = \`function process(orders) {
  for (const order of orders) {
    // TODO: validate
    for (const item of order.items) console.log(item);
  }
}\`;

const result = await new WorkflowExecutor(cog).execute(workflow, { code }, {
  onNodeComplete: (node, _output, duration) => console.log(\`done: \${node} (\${duration}ms)\`),
});

console.log(result.state.report);

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/workflows zod',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx basic-workflow.ts',
      repoRun: 'npx tsx examples/workflows/01-basic-workflow.ts',
      example: 'workflows/01-basic-workflow.ts',
      docs: [
        {
          href: '/docs/workflows/builder',
          label: 'Workflow Builder',
        },
      ],
    },
    {
      id: 'human-in-loop',
      title: 'Human-in-the-Loop',
      difficulty: 'medium',
      time: '15 min',
      problem: 'Nothing gets published until an editor approves the draft the agent wrote.',
      points: [
        'Add an approval step with `humanWorkflowNode(approvalNode(...))`',
        'Answer it from outside the run through the `ApprovalStore` — like an API handler or UI would',
        'Branch on the decision',
      ],
      file: 'human-in-loop.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import {
  InMemoryApprovalStore,
  WorkflowBuilder,
  WorkflowExecutor,
  agentNode,
  approvalNode,
  humanWorkflowNode,
} from '@cogitator-ai/workflows';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

interface PublishingState {
  [key: string]: unknown;
  topic: string;
  draft: string;
  approved: boolean;
  status: string;
}

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });
const approvalStore = new InMemoryApprovalStore();

const writer = new Agent({
  name: 'content-writer',
  model: 'google/gemini-3.5-flash-lite',
  instructions: 'You are a technical writer. Write a blog post under 150 words with a title.',
  temperature: 0.7,
});

const write = agentNode<PublishingState>(writer, {
  inputMapper: (state) => \`Write a short blog post about: \${state.topic}\`,
  stateMapper: (result) => ({ draft: result.output }),
});

const review = humanWorkflowNode(
  approvalNode<PublishingState>('editorial-review', {
    title: 'Editorial review',
    description: (state) => \`Publish this draft?\\n\\n\${state.draft}\`,
    assignee: 'editor@company.com',
    timeout: 60 * 60 * 1000,
    timeoutAction: 'reject',
  }),
  { stateMapper: (result) => ({ approved: result.approved }) }
);

const workflow = new WorkflowBuilder<PublishingState>('content-publishing')
  .initialState({ topic: '', draft: '', approved: false, status: 'draft' })
  .addNode(write.name, write.fn)
  .addNode(review.name, review.fn, { after: [write.name] })
  .addConditional('decide', (state) => (state.approved ? 'publish' : 'archive'), {
    after: [review.name],
  })
  .addNode('publish', async () => ({ state: { status: 'published' } }), { after: ['decide'] })
  .addNode('archive', async () => ({ state: { status: 'rejected' } }), { after: ['decide'] })
  .entryPoint(write.name)
  .build();

const run = new WorkflowExecutor(cog).execute(
  workflow,
  { topic: 'Building type-safe AI agents with TypeScript' },
  { approvalStore }
);

async function nextPendingRequest() {
  for (;;) {
    const [request] = await approvalStore.getPendingRequests();
    if (request) return request;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const request = await nextPendingRequest();
console.log(\`\${request.title} for \${request.assignee}:\\n\${request.description}\`);

await approvalStore.submitResponse({
  requestId: request.id,
  decision: true,
  respondedBy: 'editor@company.com',
  respondedAt: Date.now(),
  comment: 'Ship it',
});

const result = await run;
console.log('Status:', result.state.status);

approvalStore.dispose();
await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/workflows',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx human-in-loop.ts',
      repoRun: 'npx tsx examples/workflows/02-human-in-loop.ts',
      notes: [
        {
          type: 'info',
          text: 'The repo example drives `executeHumanNode` by hand to simulate the reviewer; this recipe uses the `humanWorkflowNode` wrapper. Use a durable store (e.g. `RedisApprovalStore`) when the answer comes from another process.',
        },
      ],
      example: 'workflows/02-human-in-loop.ts',
      docs: [
        {
          href: '/docs/workflows/nodes',
          label: 'Workflow Nodes',
        },
      ],
    },
    {
      id: 'map-reduce',
      title: 'Map-Reduce',
      difficulty: 'medium',
      time: '15 min',
      problem: 'Analyze many documents in parallel, then summarize all the results in one step.',
      points: [
        'Fan out with `executeMapReduce` (concurrency, progress, `continueOnError`)',
        'Collect the results and feed them to a summarizer node',
      ],
      file: 'map-reduce.ts',
      code: `import { Agent, Cogitator } from '@cogitator-ai/core';
import {
  WorkflowBuilder,
  WorkflowExecutor,
  agentNode,
  collect,
  executeMapReduce,
  functionNode,
} from '@cogitator-ai/workflows';

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error('Set GOOGLE_API_KEY');

interface Doc {
  id: string;
  title: string;
  content: string;
}

interface DocAnalysis {
  title: string;
  findings: string;
  sentiment: string;
}

interface AnalysisState {
  [key: string]: unknown;
  documents: Doc[];
  analyses: DocAnalysis[];
  summary: string;
}

const documents: Doc[] = [
  { id: 'doc-1', title: 'Q4 Revenue Report', content: 'Revenue grew 23% to $4.2B. Cloud led at 35%; hardware fell 5%.' },
  { id: 'doc-2', title: 'Engineering Retro', content: 'Deploys went from weekly to daily. Incident response time fell from 45 to 12 minutes.' },
  { id: 'doc-3', title: 'Security Audit', content: '3 critical vulnerabilities found and patched within 48 hours. Compliance score is 94%.' },
];

const cog = new Cogitator({ llm: { providers: { google: { apiKey } } } });
const model = 'google/gemini-3.5-flash-lite';

const analyzer = new Agent({
  name: 'document-analyzer',
  model,
  instructions: 'Reply exactly as:\\nFINDINGS: <one line>\\nSENTIMENT: <positive|negative|neutral|mixed>',
  temperature: 0.2,
});

const summarizer = new Agent({
  name: 'executive-summarizer',
  model,
  instructions: 'Write an executive summary of the analyses in under 120 words, as bullet points.',
  temperature: 0.3,
});

const analyzeAll = functionNode<AnalysisState, DocAnalysis[]>(
  'analyze-all',
  async (state) => {
    const mapped = await executeMapReduce<AnalysisState, DocAnalysis, DocAnalysis[]>(state, {
      name: 'doc-analysis',
      map: {
        items: (s) => s.documents,
        mapper: async (item) => {
          const doc = item as Doc;
          const { output } = await cog.run(analyzer, { input: \`\${doc.title}\\n\\n\${doc.content}\` });
          return {
            title: doc.title,
            findings: output.match(/FINDINGS:\\s*(.+)/i)?.[1]?.trim() ?? output,
            sentiment: output.match(/SENTIMENT:\\s*(\\w+)/i)?.[1]?.toLowerCase() ?? 'unknown',
          };
        },
        concurrency: 3,
        continueOnError: true,
        onProgress: (progress) => console.log(\`mapped \${progress.completed}/\${progress.total}\`),
      },
      reduce: { ...collect<DocAnalysis>() },
    });
    return mapped.reduced;
  },
  { stateMapper: (output) => ({ analyses: output as DocAnalysis[] }) }
);

const summarize = agentNode<AnalysisState>(summarizer, {
  inputMapper: (state) =>
    state.analyses.map((a) => \`\${a.title}: \${a.findings} (\${a.sentiment})\`).join('\\n'),
  stateMapper: (result) => ({ summary: result.output }),
});

const workflow = new WorkflowBuilder<AnalysisState>('document-analysis')
  .initialState({ documents: [], analyses: [], summary: '' })
  .addNode(analyzeAll.name, analyzeAll.fn)
  .addNode(summarize.name, summarize.fn, { after: [analyzeAll.name] })
  .entryPoint(analyzeAll.name)
  .build();

const result = await new WorkflowExecutor(cog).execute(workflow, { documents });
for (const analysis of result.state.analyses) {
  console.log(\`[\${analysis.sentiment}] \${analysis.title}: \${analysis.findings}\`);
}
console.log('\\n' + result.state.summary);

await cog.close();`,
      install: 'pnpm add @cogitator-ai/core @cogitator-ai/workflows',
      env: ['GOOGLE_API_KEY'],
      run: 'GOOGLE_API_KEY=your-key npx tsx map-reduce.ts',
      repoRun: 'npx tsx examples/workflows/03-map-reduce.ts',
      example: 'workflows/03-map-reduce.ts',
      docs: [
        {
          href: '/docs/workflows/patterns',
          label: 'Workflow Patterns',
        },
      ],
    },
  ],
};
