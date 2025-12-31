/**
 * Dev Team Swarm Example
 *
 * This example demonstrates a multi-agent swarm with a tech lead
 * supervising specialized developer agents.
 */

import { Cogitator, Agent, Swarm, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const cog = new Cogitator({
  llm: {
    defaultProvider: 'openai',
    providers: {
      openai: { apiKey: process.env.OPENAI_API_KEY! },
    },
  },
});

const writeCode = tool({
  name: 'write_code',
  description: 'Write code to a file',
  parameters: z.object({
    path: z.string(),
    content: z.string(),
    language: z.string(),
  }),
  execute: async ({ path, content, language }) => {
    console.log(`[Tool] Writing ${language} code to ${path}`);
    return { success: true, path, lines: content.split('\n').length };
  },
});

const runTests = tool({
  name: 'run_tests',
  description: 'Run the test suite',
  parameters: z.object({
    testPath: z.string().optional(),
  }),
  execute: async ({ testPath }) => {
    console.log(`[Tool] Running tests: ${testPath || 'all'}`);
    return { passed: 15, failed: 0, skipped: 2 };
  },
});

const reviewCode = tool({
  name: 'review_code',
  description: 'Review code for issues',
  parameters: z.object({
    path: z.string(),
  }),
  execute: async ({ path }) => {
    console.log(`[Tool] Reviewing ${path}`);
    return {
      issues: [],
      suggestions: ['Consider adding input validation'],
      approved: true,
    };
  },
});

const techLead = new Agent({
  name: 'tech-lead',
  model: 'gpt-4o',
  instructions: `You are a senior tech lead managing a development team.

    Your team consists of:
    - frontend-dev: React/TypeScript specialist
    - backend-dev: Node.js/API specialist
    - qa-engineer: Testing specialist

    When given a task:
    1. Break it into subtasks for each team member
    2. Delegate tasks appropriately
    3. Coordinate the work
    4. Ensure quality standards are met
    5. Provide final summary

    Delegate tasks using: delegate_task(worker_name, task_description)
    Check progress using: check_status(worker_name)`,
  temperature: 0.3,
});

const frontendDev = new Agent({
  name: 'frontend-dev',
  model: 'claude-3-5-sonnet',
  instructions: `You are a frontend developer specializing in:
    - React and TypeScript
    - UI/UX implementation
    - State management
    - Responsive design

    Write clean, well-typed code. Use modern React patterns (hooks, functional components).
    Always consider accessibility and performance.`,
  tools: [writeCode],
  temperature: 0.2,
});

const backendDev = new Agent({
  name: 'backend-dev',
  model: 'claude-3-5-sonnet',
  instructions: `You are a backend developer specializing in:
    - Node.js and TypeScript
    - REST API design
    - Database operations
    - Authentication/Authorization

    Write clean, secure, and efficient code. Follow REST best practices.
    Always validate inputs and handle errors properly.`,
  tools: [writeCode],
  temperature: 0.2,
});

const qaEngineer = new Agent({
  name: 'qa-engineer',
  model: 'gpt-4o',
  instructions: `You are a QA engineer specializing in:
    - Writing test cases
    - Integration testing
    - E2E testing
    - Code review for quality

    Ensure comprehensive test coverage. Focus on edge cases and error scenarios.
    Review code for potential bugs and security issues.`,
  tools: [writeCode, runTests, reviewCode],
  temperature: 0.2,
});

const devTeam = new Swarm({
  name: 'dev-team',
  strategy: 'hierarchical',

  supervisor: techLead,
  workers: [frontendDev, backendDev, qaEngineer],

  coordination: {
    visibility: 'full',
    workerCommunication: false,
    maxParallelTasks: 2,
  },

  resources: {
    maxConcurrency: 3,
    tokenBudget: 50_000,
    timeout: 300_000,
  },

  observability: {
    tracing: true,
    messageLogging: true,
  },
});

async function main() {
  console.log('Starting dev team swarm example...\n');
  console.log('Team Members:');
  console.log('  - tech-lead (supervisor)');
  console.log('  - frontend-dev');
  console.log('  - backend-dev');
  console.log('  - qa-engineer');
  console.log('\n');

  const task = `Build a user authentication feature with the following requirements:

    1. Frontend:
       - Login form component with email/password
       - Registration form component
       - Password reset flow
       - Form validation with error messages

    2. Backend:
       - POST /api/auth/login endpoint
       - POST /api/auth/register endpoint
       - POST /api/auth/forgot-password endpoint
       - JWT token generation and validation

    3. Testing:
       - Unit tests for all components
       - API integration tests
       - E2E login flow test`;

  console.log('Task:');
  console.log('=====');
  console.log(task);
  console.log('\n');

  const result = await cog.run(devTeam, { input: task });

  console.log('\nResults:');
  console.log('========\n');
  console.log(result.output);

  console.log('\nExecution Summary:');
  console.log('------------------');
  console.log(`Total tokens: ${result.usage.totalTokens}`);
  console.log(`Cost: $${result.usage.cost.toFixed(4)}`);
  console.log(`Duration: ${result.usage.duration}ms`);

  console.log('\nAgent Activity:');
  result.trace.spans
    .filter((s) => s.name.startsWith('agent.'))
    .forEach((span) => {
      console.log(`  ${span.attributes.agentName}: ${span.duration}ms`);
    });

  await cog.close();
}

main().catch(console.error);
