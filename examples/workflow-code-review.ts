/**
 * Code Review Workflow Example
 *
 * This example demonstrates a multi-step workflow for automated code review
 * with human-in-the-loop approval.
 */

import { Cogitator, Agent, Workflow, step, tool } from '@cogitator/core';
import { z } from 'zod';

const cog = new Cogitator({
  llm: {
    defaultProvider: 'openai',
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  },
});

// Tools
const fetchPRDiff = tool({
  name: 'fetch_pr_diff',
  description: 'Fetch the diff for a pull request',
  parameters: z.object({
    prNumber: z.number(),
    repo: z.string(),
  }),
  execute: async ({ prNumber, repo }) => {
    console.log(`[Tool] Fetching PR #${prNumber} from ${repo}`);
    // Mock PR diff
    return {
      prNumber,
      repo,
      title: 'Add user authentication feature',
      author: 'developer',
      files: [
        { path: 'src/auth/login.ts', additions: 50, deletions: 10 },
        { path: 'src/auth/register.ts', additions: 80, deletions: 0 },
        { path: 'tests/auth.test.ts', additions: 120, deletions: 0 },
      ],
      diff: `
+export async function login(email: string, password: string) {
+  const user = await db.users.findByEmail(email);
+  if (!user) throw new Error('User not found');
+  const valid = await bcrypt.compare(password, user.passwordHash);
+  if (!valid) throw new Error('Invalid password');
+  return generateToken(user);
+}
      `.trim(),
    };
  },
});

const postComment = tool({
  name: 'post_comment',
  description: 'Post a comment on the pull request',
  parameters: z.object({
    prNumber: z.number(),
    repo: z.string(),
    body: z.string(),
  }),
  execute: async ({ prNumber, repo, body }) => {
    console.log(`[Tool] Posting comment on PR #${prNumber}`);
    console.log(`  "${body.substring(0, 100)}..."`);
    return { commentId: 'comment_123', posted: true };
  },
});

const runCI = tool({
  name: 'run_ci',
  description: 'Trigger CI pipeline for the PR',
  parameters: z.object({
    prNumber: z.number(),
  }),
  execute: async ({ prNumber }) => {
    console.log(`[Tool] Running CI for PR #${prNumber}`);
    return {
      pipelineId: 'ci_456',
      status: 'passed',
      tests: { passed: 42, failed: 0 },
      coverage: 87.5,
      linting: 'passed',
      security: 'passed',
    };
  },
});

const mergePR = tool({
  name: 'merge_pr',
  description: 'Merge the pull request',
  parameters: z.object({
    prNumber: z.number(),
    repo: z.string(),
    mergeMethod: z.enum(['merge', 'squash', 'rebase']).default('squash'),
  }),
  execute: async ({ prNumber, repo, mergeMethod }) => {
    console.log(`[Tool] Merging PR #${prNumber} with ${mergeMethod}`);
    return { merged: true, sha: 'abc123def456' };
  },
});

// Agents
const codeAnalyzer = new Agent({
  name: 'code-analyzer',
  model: 'gpt-4o',
  instructions: `You are a code analyzer. Analyze code changes for:
    - Code quality and best practices
    - Potential bugs and issues
    - Performance concerns
    - Security vulnerabilities

    Provide detailed, actionable feedback.`,
  tools: [fetchPRDiff],
  responseFormat: {
    type: 'json_schema',
    schema: z.object({
      summary: z.string(),
      quality: z.number().min(1).max(10),
      issues: z.array(z.object({
        severity: z.enum(['critical', 'major', 'minor', 'suggestion']),
        file: z.string(),
        line: z.number().optional(),
        description: z.string(),
        suggestion: z.string().optional(),
      })),
      approved: z.boolean(),
    }),
  },
  temperature: 0.1,
});

const securityScanner = new Agent({
  name: 'security-scanner',
  model: 'gpt-4o',
  instructions: `You are a security expert. Scan code for:
    - SQL injection vulnerabilities
    - XSS vulnerabilities
    - Authentication/authorization issues
    - Sensitive data exposure
    - Dependency vulnerabilities

    Be thorough and flag any potential security concerns.`,
  responseFormat: {
    type: 'json_schema',
    schema: z.object({
      vulnerabilities: z.array(z.object({
        type: z.string(),
        severity: z.enum(['critical', 'high', 'medium', 'low']),
        location: z.string(),
        description: z.string(),
        remediation: z.string(),
      })),
      passed: z.boolean(),
    }),
  },
  temperature: 0,
});

const reviewSummarizer = new Agent({
  name: 'review-summarizer',
  model: 'gpt-4o',
  instructions: `You are a technical writer. Create a comprehensive review summary
    that includes all findings from code analysis, security scan, and CI results.
    Format it as a clear, professional PR comment.`,
  tools: [postComment],
  temperature: 0.3,
});

const mergeAgent = new Agent({
  name: 'merge-agent',
  model: 'gpt-4o-mini',
  instructions: `You are responsible for merging approved PRs.
    Only merge if all checks have passed and approval was given.`,
  tools: [mergePR],
  temperature: 0,
});

// Create the workflow
const codeReviewWorkflow = new Workflow({
  name: 'code-review',
  description: 'Automated code review workflow with human approval',

  steps: [
    // Step 1: Fetch and analyze PR
    step('analyze', {
      agent: codeAnalyzer,
      input: (ctx) => `Analyze PR #${ctx.input.prNumber} in ${ctx.input.repo}`,
      timeout: 60_000,
    }),

    // Step 2: Security scan (parallel with Step 1 if no dependencies)
    step('security-scan', {
      agent: securityScanner,
      input: (ctx) => `
        Scan this code for security vulnerabilities:
        ${JSON.stringify(ctx.steps.analyze.output)}
      `,
      dependsOn: ['analyze'],
      timeout: 60_000,
    }),

    // Step 3: Run CI
    step('run-ci', {
      type: 'tool',
      tool: runCI,
      input: (ctx) => ({ prNumber: ctx.input.prNumber }),
      dependsOn: ['analyze'],
    }),

    // Step 4: Check if auto-approve possible
    step('check-auto-approve', {
      type: 'function',
      execute: async (ctx) => {
        const analysis = ctx.steps.analyze.output;
        const security = ctx.steps['security-scan'].output;
        const ci = ctx.steps['run-ci'].output;

        const canAutoApprove =
          analysis.quality >= 8 &&
          analysis.issues.filter((i: any) => i.severity === 'critical').length === 0 &&
          security.passed &&
          ci.status === 'passed';

        return {
          canAutoApprove,
          reason: canAutoApprove
            ? 'All checks passed with high quality'
            : 'Manual review required',
        };
      },
      dependsOn: ['analyze', 'security-scan', 'run-ci'],
    }),

    // Step 5: Human approval (only if can't auto-approve)
    step('human-approval', {
      type: 'human',
      prompt: (ctx) => `
        ## Code Review Summary

        **Quality Score:** ${ctx.steps.analyze.output.quality}/10
        **Security:** ${ctx.steps['security-scan'].output.passed ? '✅ Passed' : '❌ Issues Found'}
        **CI:** ${ctx.steps['run-ci'].output.status}

        ### Issues Found:
        ${ctx.steps.analyze.output.issues.map((i: any) =>
          `- [${i.severity}] ${i.description}`
        ).join('\n')}

        ### Security Findings:
        ${ctx.steps['security-scan'].output.vulnerabilities.map((v: any) =>
          `- [${v.severity}] ${v.type}: ${v.description}`
        ).join('\n') || 'None'}

        **Do you approve this PR for merge?**
      `,
      options: ['approve', 'request-changes', 'reject'],
      timeout: 24 * 60 * 60 * 1000, // 24 hours
      dependsOn: ['check-auto-approve'],
      condition: (ctx) => !ctx.steps['check-auto-approve'].output.canAutoApprove,
    }),

    // Step 6: Post review comment
    step('post-review', {
      agent: reviewSummarizer,
      input: (ctx) => `
        Create a PR review comment summarizing:
        - Code analysis: ${JSON.stringify(ctx.steps.analyze.output)}
        - Security scan: ${JSON.stringify(ctx.steps['security-scan'].output)}
        - CI results: ${JSON.stringify(ctx.steps['run-ci'].output)}
        - Approval: ${ctx.steps['human-approval']?.output || ctx.steps['check-auto-approve'].output}

        Post to PR #${ctx.input.prNumber} in ${ctx.input.repo}
      `,
      dependsOn: ['analyze', 'security-scan', 'run-ci', 'human-approval', 'check-auto-approve'],
      dependencyMode: 'completed',
    }),

    // Step 7: Merge if approved
    step('merge', {
      agent: mergeAgent,
      input: (ctx) => {
        const approved =
          ctx.steps['check-auto-approve'].output.canAutoApprove ||
          ctx.steps['human-approval']?.output === 'approve';

        return `${approved ? 'Merge' : 'Do not merge'} PR #${ctx.input.prNumber} in ${ctx.input.repo}`;
      },
      dependsOn: ['post-review'],
      condition: (ctx) =>
        ctx.steps['check-auto-approve'].output.canAutoApprove ||
        ctx.steps['human-approval']?.output === 'approve',
    }),
  ],

  persistence: {
    store: 'postgres',
    checkpointInterval: 'after-each-step',
  },

  onError: async (error, ctx) => {
    console.error(`Workflow error at step ${ctx.meta.currentStep}:`, error);
    return { action: 'abort', reason: error.message };
  },
});

async function main() {
  console.log('Starting code review workflow example...\n');

  // Mock human approval for demo
  cog.on('human-approval-required', (event: any) => {
    console.log('\n[Human Approval Required]');
    console.log(event.prompt);
    // Auto-approve for demo
    setTimeout(() => event.respond('approve'), 1000);
  });

  const result = await cog.workflow(codeReviewWorkflow).run({
    repo: 'myorg/myrepo',
    prNumber: 123,
  });

  console.log('\nWorkflow Complete!');
  console.log('==================\n');

  console.log('Step Results:');
  Object.entries(result.steps).forEach(([name, step]: [string, any]) => {
    console.log(`  ${name}: ${step.status} (${step.duration}ms)`);
  });

  console.log(`\nTotal duration: ${result.usage.duration}ms`);
  console.log(`Total cost: $${result.usage.cost.toFixed(4)}`);

  await cog.close();
}

main().catch(console.error);
