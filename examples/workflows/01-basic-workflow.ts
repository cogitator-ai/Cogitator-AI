import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, tool } from '@cogitator-ai/core';
import {
  WorkflowBuilder,
  WorkflowExecutor,
  agentNode,
  toolNode,
  functionNode,
} from '@cogitator-ai/workflows';
import { z } from 'zod';

interface CodeReviewState {
  [key: string]: unknown;
  code: string;
  language: string;
  analysis: string;
  issues: string[];
  fixes: string;
  report: string;
}

const analyzeCodeTool = tool({
  name: 'analyze_code',
  description: 'Analyze code for common issues like complexity, naming, and structure',
  parameters: z.object({
    code: z.string().describe('Source code to analyze'),
    language: z.string().describe('Programming language'),
  }),
  execute: async ({ code, language }) => {
    const lines = code.split('\n').length;
    const hasLongLines = code.split('\n').some((l) => l.length > 120);
    const hasNestedLoops = /for.*for|while.*while/.test(code);
    const hasTodo = /TODO|FIXME|HACK/i.test(code);
    const hasConsoleLog = /console\.(log|debug|info)/.test(code);

    const issues: string[] = [];
    if (hasLongLines) issues.push('Lines exceeding 120 characters');
    if (hasNestedLoops) issues.push('Nested loops detected — consider refactoring');
    if (hasTodo) issues.push('Unresolved TODO/FIXME comments');
    if (hasConsoleLog) issues.push('Console logging in production code');
    if (lines > 50) issues.push('Function is too long — consider splitting');

    return {
      language,
      lines,
      issues,
      complexity: hasNestedLoops ? 'high' : lines > 30 ? 'medium' : 'low',
    };
  },
});

async function main() {
  header('01 — Basic Workflow: Code Review Pipeline');
  const cog = createCogitator();

  const sampleCode = `
async function processOrders(orders, db) {
  const results = [];
  for (const order of orders) {
    console.log("Processing order:", order.id);
    // TODO: add validation
    for (const item of order.items) {
      const product = await db.query("SELECT * FROM products WHERE id = ?", [item.productId]);
      if (product.stock < item.quantity) {
        throw new Error("Insufficient stock for " + product.name);
      }
      await db.query("UPDATE products SET stock = stock - ? WHERE id = ?", [item.quantity, item.productId]);
      results.push({ orderId: order.id, productId: item.productId, status: "processed" });
    }
    await db.query("UPDATE orders SET status = 'completed' WHERE id = ?", [order.id]);
  }
  return results;
}`.trim();

  section('1. Building the workflow');

  const reviewer = new Agent({
    name: 'code-reviewer',
    model: DEFAULT_MODEL,
    instructions: `You are an expert code reviewer. Given a code analysis result and the original code,
identify the most critical issues and explain why they matter.
Focus on: security, performance, maintainability, and error handling.
Be specific — reference line numbers or patterns. Keep it concise.`,
    temperature: 0.3,
    maxIterations: 3,
  });

  const fixAdvisor = new Agent({
    name: 'fix-advisor',
    model: DEFAULT_MODEL,
    instructions: `You are a senior developer. Given identified code issues, suggest concrete fixes.
For each issue, provide a brief code snippet showing the improved version.
Prioritize fixes by impact. Be practical, not theoretical.`,
    temperature: 0.3,
    maxIterations: 3,
  });

  const reviewerNode = agentNode<CodeReviewState>(reviewer, {
    inputMapper: (state) =>
      `Review this ${state.language} code. Analysis found these issues: ${state.issues.join(', ')}.\n\nCode:\n${state.code}`,
    stateMapper: (result) => ({ analysis: result.output }),
  });

  const analyzerNode = toolNode<CodeReviewState, { code: string; language: string }>(
    analyzeCodeTool,
    {
      argsMapper: (state) => ({ code: state.code, language: state.language }),
      stateMapper: (result) => {
        const r = result as { issues: string[] };
        return { issues: r.issues };
      },
    }
  );

  const fixAdvisorNode = agentNode<CodeReviewState>(fixAdvisor, {
    inputMapper: (state) =>
      `These issues were found in ${state.language} code:\n${state.analysis}\n\nOriginal code:\n${state.code}`,
    stateMapper: (result) => ({ fixes: result.output }),
  });

  const reportNode = functionNode<CodeReviewState, string>(
    'generate-report',
    async (state) => {
      const lines = [
        `Code Review Report`,
        `${'='.repeat(40)}`,
        `Language: ${state.language}`,
        `Issues found: ${state.issues.length}`,
        ``,
        `Issues:`,
        ...state.issues.map((issue, i) => `  ${i + 1}. ${issue}`),
        ``,
        `Analysis:`,
        `  ${state.analysis.slice(0, 300)}${state.analysis.length > 300 ? '...' : ''}`,
        ``,
        `Suggested Fixes:`,
        `  ${state.fixes.slice(0, 300)}${state.fixes.length > 300 ? '...' : ''}`,
      ];
      return lines.join('\n');
    },
    {
      stateMapper: (output) => ({ report: output as string }),
    }
  );

  const workflow = new WorkflowBuilder<CodeReviewState>('code-review-pipeline')
    .initialState({
      code: '',
      language: '',
      analysis: '',
      issues: [],
      fixes: '',
      report: '',
    })
    .addNode(analyzerNode.name, analyzerNode.fn)
    .addNode(reviewerNode.name, reviewerNode.fn, { after: [analyzerNode.name] })
    .addConditional(
      'severity-check',
      (state) => (state.issues.length > 2 ? fixAdvisorNode.name : 'minor-only'),
      { after: [reviewerNode.name] }
    )
    .addNode(fixAdvisorNode.name, fixAdvisorNode.fn, { after: ['severity-check'] })
    .addNode(
      'minor-only',
      async () => ({
        state: { fixes: 'No significant fixes needed.' } as Partial<CodeReviewState>,
      }),
      { after: ['severity-check'] }
    )
    .addNode(reportNode.name, reportNode.fn, {
      after: [fixAdvisorNode.name, 'minor-only'],
    })
    .entryPoint(analyzerNode.name)
    .build();

  console.log(`  Workflow: ${workflow.name}`);
  console.log(`  Nodes:   ${workflow.nodes.size}`);
  console.log(`  Edges:   ${workflow.edges.length}`);
  console.log(`  Entry:   ${workflow.entryPoint}`);

  section('2. Executing the workflow');

  const executor = new WorkflowExecutor(cog);
  const result = await executor.execute(
    workflow,
    { code: sampleCode, language: 'TypeScript' },
    {
      onNodeStart: (node) => console.log(`  [start] ${node}`),
      onNodeComplete: (node, _output, duration) => console.log(`  [done]  ${node} (${duration}ms)`),
    }
  );

  section('3. Results');

  if (result.error) {
    console.log(`  Error: ${result.error.message}`);
  }

  console.log(`  Duration: ${result.duration}ms`);
  console.log(`  Issues found: ${result.state.issues.length}`);
  for (const issue of result.state.issues) {
    console.log(`    - ${issue}`);
  }

  section('4. Final report');

  console.log(result.state.report);

  await cog.close();
  console.log('\nDone.');
}

main();
