import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import {
  WorkflowBuilder,
  WorkflowExecutor,
  agentNode,
  functionNode,
  executeMapReduce,
  collect,
} from '@cogitator-ai/workflows';

interface DocumentAnalysisState {
  [key: string]: unknown;
  documents: Document[];
  analyses: DocumentAnalysis[];
  summary: string;
}

interface Document {
  id: string;
  title: string;
  content: string;
  category: string;
}

interface DocumentAnalysis {
  documentId: string;
  title: string;
  category: string;
  keyFindings: string;
  sentiment: string;
  wordCount: number;
}

const sampleDocuments: Document[] = [
  {
    id: 'doc-1',
    title: 'Q4 Revenue Report',
    content: `Revenue grew 23% year-over-year reaching $4.2B. Cloud services led growth at 35%
while hardware declined 5%. Operating margins expanded to 28% from 24% last year.
Customer acquisition costs decreased 12% through improved marketing efficiency.
Enterprise segment showed strongest performance with 40% growth.`,
    category: 'finance',
  },
  {
    id: 'doc-2',
    title: 'Engineering Team Retrospective',
    content: `Sprint velocity improved 15% after adopting trunk-based development.
Deployment frequency increased from weekly to daily. Incident response time reduced
from 45min to 12min average. Technical debt ratio decreased from 32% to 18%.
Team satisfaction survey showed 87% positive sentiment, up from 72%.`,
    category: 'engineering',
  },
  {
    id: 'doc-3',
    title: 'Customer Satisfaction Survey Results',
    content: `NPS score rose to 72 from 65 last quarter. Main pain points: onboarding complexity
(mentioned by 34% of respondents) and API documentation gaps (28%). Feature requests
centered on better analytics dashboards (45%) and SSO integration (38%).
Churn rate decreased to 2.1% from 3.4%. Support ticket volume down 20%.`,
    category: 'customer',
  },
  {
    id: 'doc-4',
    title: 'Security Audit Findings',
    content: `Found 3 critical, 12 high, and 45 medium severity vulnerabilities.
Critical: SQL injection in legacy API endpoint, exposed admin credentials in config,
unpatched OpenSSL version. All critical issues patched within 48 hours.
Recommended: implement SAST in CI pipeline, rotate all service credentials quarterly,
enable WAF for all public endpoints. Compliance score improved to 94%.`,
    category: 'security',
  },
  {
    id: 'doc-5',
    title: 'Product Roadmap Update',
    content: `Three major features planned for next quarter: real-time collaboration (est. 6 weeks),
AI-powered search (est. 4 weeks), and mobile app v2 (est. 8 weeks).
Dependencies: collaboration requires WebSocket infrastructure upgrade.
Risk: mobile timeline depends on new hire starting March 1.
Budget allocated: $1.2M for Q1 development initiatives.`,
    category: 'product',
  },
];

async function main() {
  header('03 — Map-Reduce: Parallel Document Analysis');
  const cog = createCogitator();

  section('1. Preparing documents');

  for (const doc of sampleDocuments) {
    console.log(`  [${doc.category}] ${doc.title} (${doc.content.split(' ').length} words)`);
  }

  section('2. Map phase — analyzing documents in parallel');

  const analyzer = new Agent({
    name: 'document-analyzer',
    model: DEFAULT_MODEL,
    instructions: `You are a document analyst. Given a document, extract:
1. Key findings (2-3 bullet points, very concise)
2. Overall sentiment (positive/negative/neutral/mixed)

Respond in this exact format:
FINDINGS: <bullet1> | <bullet2> | <bullet3>
SENTIMENT: <sentiment>

Be extremely concise. No extra commentary.`,
    temperature: 0.2,
    maxIterations: 3,
  });

  const analyzeNode = functionNode<DocumentAnalysisState, DocumentAnalysis[]>(
    'parallel-analyze',
    async (state) => {
      const result = await executeMapReduce<
        DocumentAnalysisState,
        DocumentAnalysis,
        DocumentAnalysis[]
      >(state, {
        name: 'doc-analysis',
        map: {
          items: (s) => s.documents,
          mapper: async (item) => {
            const doc = item as Document;
            const agentResult = await cog.run(analyzer, {
              input: `Analyze this ${doc.category} document titled "${doc.title}":\n\n${doc.content}`,
            });

            const output = agentResult.output;
            const findingsMatch = output.match(/FINDINGS:\s*(.+)/i);
            const sentimentMatch = output.match(/SENTIMENT:\s*(\w+)/i);

            return {
              documentId: doc.id,
              title: doc.title,
              category: doc.category,
              keyFindings: findingsMatch?.[1]?.trim() ?? output.slice(0, 150),
              sentiment: sentimentMatch?.[1]?.toLowerCase() ?? 'unknown',
              wordCount: doc.content.split(/\s+/).length,
            };
          },
          concurrency: 3,
          continueOnError: true,
          onProgress: (progress) => {
            console.log(`  [map] ${progress.completed}/${progress.total} documents analyzed`);
          },
        },
        reduce: {
          ...collect<DocumentAnalysis>(),
        },
      });

      console.log(
        `  Map-reduce completed: ${result.stats.successful}/${result.stats.total} succeeded`
      );
      console.log(`  Total duration: ${result.stats.duration}ms`);
      console.log(`  Avg per document: ${Math.round(result.stats.avgItemDuration)}ms`);

      return result.reduced;
    },
    {
      stateMapper: (output) => ({ analyses: output as DocumentAnalysis[] }),
    }
  );

  section('3. Reduce phase — summarizing findings');

  const summarizer = new Agent({
    name: 'executive-summarizer',
    model: DEFAULT_MODEL,
    instructions: `You are an executive assistant preparing a briefing.
Given analysis results from multiple documents, create a concise executive summary.
Group findings by category. Highlight cross-cutting themes.
Use bullet points. Keep it under 200 words.`,
    temperature: 0.3,
    maxIterations: 3,
  });

  const summarizerNode = agentNode<DocumentAnalysisState>(summarizer, {
    inputMapper: (state) => {
      const lines = state.analyses.map(
        (a) =>
          `[${a.category.toUpperCase()}] ${a.title}\n  Findings: ${a.keyFindings}\n  Sentiment: ${a.sentiment}`
      );
      return `Summarize these document analyses into an executive briefing:\n\n${lines.join('\n\n')}`;
    },
    stateMapper: (result) => ({ summary: result.output }),
  });

  section('4. Building and executing the workflow');

  const workflow = new WorkflowBuilder<DocumentAnalysisState>('document-analysis')
    .initialState({
      documents: [],
      analyses: [],
      summary: '',
    })
    .addNode(analyzeNode.name, analyzeNode.fn)
    .addNode(summarizerNode.name, summarizerNode.fn, { after: [analyzeNode.name] })
    .entryPoint(analyzeNode.name)
    .build();

  console.log(`  Workflow: ${workflow.name}`);
  console.log(`  Nodes:   ${workflow.nodes.size}`);

  const executor = new WorkflowExecutor(cog);
  const result = await executor.execute(
    workflow,
    { documents: sampleDocuments },
    {
      onNodeStart: (node) => console.log(`  [start] ${node}`),
      onNodeComplete: (node, _output, duration) => console.log(`  [done]  ${node} (${duration}ms)`),
    }
  );

  section('5. Individual document analyses');

  for (const analysis of result.state.analyses) {
    console.log(`  [${analysis.category}] ${analysis.title}`);
    console.log(`    Sentiment: ${analysis.sentiment}`);
    console.log(`    Words:     ${analysis.wordCount}`);
    console.log(
      `    Findings:  ${analysis.keyFindings.slice(0, 120)}${analysis.keyFindings.length > 120 ? '...' : ''}`
    );
    console.log();
  }

  section('6. Executive summary');

  const summaryLines = result.state.summary.split('\n');
  for (const line of summaryLines) {
    console.log(`  ${line}`);
  }

  section('7. Stats');

  console.log(`  Total duration:    ${result.duration}ms`);
  console.log(`  Documents:         ${result.state.analyses.length}`);
  console.log(`  Workflow error:    ${result.error?.message ?? 'none'}`);

  const sentiments = result.state.analyses.reduce<Record<string, number>>((acc, a) => {
    acc[a.sentiment] = (acc[a.sentiment] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `  Sentiment spread:  ${Object.entries(sentiments)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')}`
  );

  const categories = [...new Set(result.state.analyses.map((a) => a.category))];
  console.log(`  Categories:        ${categories.join(', ')}`);

  await cog.close();
  console.log('\nDone.');
}

main();
