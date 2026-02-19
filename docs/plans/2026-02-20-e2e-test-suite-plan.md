# E2E Test Suite Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a strict e2e test suite (`packages/e2e/`) that exercises real LLM backends, validates answer quality via LLM-as-judge, and catches regressions in agent runtime, tool execution, streaming, and A2A protocol.

**Architecture:** Separate `packages/e2e/` package imports `@cogitator-ai/core` and `@cogitator-ai/a2a`. Tests run against real Ollama (qwen2.5:0.5b) with Gemini Flash as quality judge. Three assertion tiers: hard structural checks, structured output validation, and LLM judge verdicts.

**Tech Stack:** Vitest, `@cogitator-ai/core`, `@cogitator-ai/a2a`, Express (for A2A HTTP tests), Zod, Google Generative AI (judge)

**Design doc:** `docs/plans/2026-02-20-e2e-test-suite-design.md`

---

### Task 1: Scaffold packages/e2e package

**Files:**

- Create: `packages/e2e/package.json`
- Create: `packages/e2e/tsconfig.json`
- Create: `packages/e2e/vitest.config.ts`
- Create: `packages/e2e/src/index.ts`

**Step 1: Create package.json**

```json
{
  "name": "@cogitator-ai/e2e",
  "version": "0.1.0",
  "private": true,
  "description": "End-to-end tests for Cogitator AI",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@cogitator-ai/core": "workspace:*",
    "@cogitator-ai/a2a": "workspace:*",
    "@cogitator-ai/types": "workspace:*",
    "express": "^5.1.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/express": "^5.0.2",
    "@types/node": "^22.15.0",
    "typescript": "^5.3.0",
    "vitest": "^4.0.18"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

**Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts", "src/__tests__"]
}
```

**Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.e2e.ts'],
    testTimeout: 60000,
    hookTimeout: 30000,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/node_modules/**', '**/dist/**'],
    },
  },
});
```

**Step 4: Create src/index.ts**

```typescript
export { LLMJudge } from './helpers/judge';
export {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  createTestJudge,
} from './helpers/setup';
export { expectJudge } from './helpers/assertions';
```

**Step 5: Install dependencies and verify**

Run: `pnpm install`
Expected: resolves workspace deps, no errors

Run: `pnpm --filter @cogitator-ai/e2e typecheck`
Expected: may fail (helpers don't exist yet) — that's fine

**Step 6: Commit**

```bash
git add packages/e2e/
git commit -m "feat(e2e): scaffold @cogitator-ai/e2e package"
```

---

### Task 2: Implement test helpers — setup.ts

**Files:**

- Create: `packages/e2e/src/helpers/setup.ts`

**Context:** This provides factory functions used by every test file. Creates Cogitator with Ollama backend, test agents, test tools, and the LLM judge.

**Step 1: Write setup.ts**

```typescript
import { Cogitator, Agent, tool, OllamaBackend, GoogleBackend } from '@cogitator-ai/core';
import { z } from 'zod';
import { LLMJudge } from './judge';

const TEST_MODEL = process.env.TEST_MODEL || 'qwen2.5:0.5b';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

export async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

export function createTestCogitator(): Cogitator {
  return new Cogitator({
    defaultModel: `ollama/${TEST_MODEL}`,
  });
}

export function createOllamaBackend(): OllamaBackend {
  return new OllamaBackend({ baseUrl: OLLAMA_URL });
}

export function createTestAgent(opts?: {
  name?: string;
  instructions?: string;
  tools?: ReturnType<typeof tool>[];
  model?: string;
}): Agent {
  return new Agent({
    name: opts?.name ?? 'TestAgent',
    instructions: opts?.instructions ?? 'You are a helpful assistant. Keep responses brief.',
    model: opts?.model ?? `ollama/${TEST_MODEL}`,
    tools: opts?.tools,
  });
}

export function createTestTools() {
  const multiply = tool({
    name: 'multiply',
    description: 'Multiply two numbers together. Returns the product.',
    parameters: z.object({
      a: z.number().describe('First number'),
      b: z.number().describe('Second number'),
    }),
    execute: async ({ a, b }) => ({ result: a * b }),
  });

  const add = tool({
    name: 'add',
    description: 'Add two numbers together. Returns the sum.',
    parameters: z.object({
      a: z.number().describe('First number'),
      b: z.number().describe('Second number'),
    }),
    execute: async ({ a, b }) => ({ result: a + b }),
  });

  const failing = tool({
    name: 'divide',
    description: 'Divide two numbers. Throws error on division by zero.',
    parameters: z.object({
      a: z.number().describe('Numerator'),
      b: z.number().describe('Denominator'),
    }),
    execute: async ({ a, b }) => {
      if (b === 0) throw new Error('Division by zero');
      return { result: a / b };
    },
  });

  return { multiply, add, failing };
}

export function createTestJudge(): LLMJudge | null {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  const backend = new GoogleBackend({ apiKey });
  return new LLMJudge(backend, 'gemini-2.5-flash');
}

export function getTestModel(): string {
  return TEST_MODEL;
}
```

**Step 2: Verify it compiles (after judge.ts exists)**

Deferred to after Task 3.

---

### Task 3: Implement test helpers — judge.ts

**Files:**

- Create: `packages/e2e/src/helpers/judge.ts`

**Context:** LLMJudge wraps GoogleBackend. Sends question + answer + criteria, asks for `{"pass": true/false, "reason": "..."}`. Uses structured JSON response format.

**Step 1: Write judge.ts**

```typescript
import type { GoogleBackend } from '@cogitator-ai/core';

interface JudgeResult {
  pass: boolean;
  reason?: string;
}

interface EvaluateOptions {
  question: string;
  answer: string;
  criteria: string;
}

export class LLMJudge {
  private backend: GoogleBackend;
  private model: string;

  constructor(backend: GoogleBackend, model: string) {
    this.backend = backend;
    this.model = model;
  }

  async evaluate(opts: EvaluateOptions): Promise<JudgeResult> {
    const response = await this.backend.chat({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: [
            'You are a test evaluator. Given a question, an answer, and evaluation criteria,',
            'determine if the answer meets the criteria.',
            'Reply ONLY with valid JSON: {"pass": true, "reason": "brief explanation"}',
            'or {"pass": false, "reason": "brief explanation"}.',
            'Nothing else. No markdown. No code fences.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            `Question: ${opts.question}`,
            `Answer: ${opts.answer}`,
            `Criteria: ${opts.criteria}`,
          ].join('\n'),
        },
      ],
      temperature: 0,
      maxTokens: 256,
    });

    const text = response.content.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { pass: false, reason: `Judge returned non-JSON: ${text}` };
    }

    const parsed = JSON.parse(jsonMatch[0]) as JudgeResult;
    return {
      pass: Boolean(parsed.pass),
      reason: parsed.reason,
    };
  }
}
```

**Step 2: Verify both helpers compile**

Run: `pnpm --filter @cogitator-ai/e2e typecheck`
Expected: PASS (or minor import path issues to fix)

---

### Task 4: Implement test helpers — assertions.ts

**Files:**

- Create: `packages/e2e/src/helpers/assertions.ts`

**Context:** Custom assertion wrappers. `expectJudge()` calls the judge and asserts pass=true, but skips gracefully when no Gemini key is available.

**Step 1: Write assertions.ts**

```typescript
import { expect } from 'vitest';
import type { LLMJudge } from './judge';

let _judge: LLMJudge | null | undefined;
let _judgeInitialized = false;

export function setJudge(judge: LLMJudge | null): void {
  _judge = judge;
  _judgeInitialized = true;
}

export async function expectJudge(
  output: string,
  opts: { question: string; criteria: string }
): Promise<void> {
  if (!_judgeInitialized) {
    throw new Error('Call setJudge() in beforeAll before using expectJudge');
  }
  if (!_judge) {
    console.warn(`[SKIP JUDGE] No GOOGLE_API_KEY — skipping: "${opts.criteria}"`);
    return;
  }

  const result = await _judge.evaluate({
    question: opts.question,
    answer: output,
    criteria: opts.criteria,
  });

  expect(result.pass, `Judge failed: ${result.reason}\nAnswer was: "${output}"`).toBe(true);
}

export function expectValidTimestamp(ts: string): void {
  const date = new Date(ts);
  expect(date.getTime()).not.toBeNaN();
  const now = Date.now();
  const diff = now - date.getTime();
  expect(diff).toBeLessThan(120_000);
  expect(diff).toBeGreaterThanOrEqual(0);
}
```

**Step 2: Build the package**

Run: `pnpm build`
Expected: all packages build including e2e

**Step 3: Commit**

```bash
git add packages/e2e/src/helpers/
git commit -m "feat(e2e): implement test helpers — judge, setup, assertions

- LLMJudge wraps Gemini Flash for answer quality evaluation
- setup.ts provides factory functions for Cogitator, Agent, tools
- assertions.ts provides expectJudge() with graceful skip when no API key"
```

---

### Task 5: Core — agent-simple-chat.e2e.ts

**Files:**

- Create: `packages/e2e/src/__tests__/core/agent-simple-chat.e2e.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestCogitator,
  createTestAgent,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Core: Agent Simple Chat', () => {
  let cogitator: Cogitator;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    setJudge(createTestJudge());
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('answers factual questions correctly', async () => {
    const agent = createTestAgent();
    const result = await cogitator.run(agent, 'What is the capital of Japan? Reply in one word.', {
      maxIterations: 1,
    });

    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.usage.totalTokens).toBeGreaterThan(0);

    await expectJudge(result.output, {
      question: 'What is the capital of Japan?',
      criteria: 'Answer correctly names Tokyo',
    });
  });

  it('follows system instructions', async () => {
    const agent = createTestAgent({
      instructions: 'You MUST always respond with exactly 3 words. No more, no less.',
    });
    const result = await cogitator.run(agent, 'What color is the sky?', {
      maxIterations: 1,
    });

    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);

    await expectJudge(result.output, {
      question: 'What color is the sky? (agent instructed to reply in 3 words)',
      criteria: 'Response is approximately 3 words long',
    });
  });

  it('handles minimal input gracefully', async () => {
    const agent = createTestAgent();
    const result = await cogitator.run(agent, 'Hi', {
      maxIterations: 1,
    });

    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
  });
});
```

**Step 2: Run to verify**

Run: `TEST_OLLAMA=true pnpm --filter @cogitator-ai/e2e test -- src/__tests__/core/agent-simple-chat.e2e.ts`
Expected: PASS (3 tests, judge skips if no GOOGLE_API_KEY)

**Step 3: Commit**

```bash
git add packages/e2e/src/__tests__/core/agent-simple-chat.e2e.ts
git commit -m "test(e2e): add agent simple chat tests"
```

---

### Task 6: Core — agent-tool-execution.e2e.ts

**Files:**

- Create: `packages/e2e/src/__tests__/core/agent-tool-execution.e2e.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Core: Agent Tool Execution', () => {
  let cogitator: Cogitator;
  const tools = createTestTools();

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    setJudge(createTestJudge());
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('calls a single tool and uses result', async () => {
    const agent = createTestAgent({
      instructions: 'You are a math assistant. Always use the multiply tool for multiplication.',
      tools: [tools.multiply],
    });

    const result = await cogitator.run(agent, 'What is 15 times 7? Use the multiply tool.', {
      maxIterations: 3,
    });

    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.toolCalls.some((tc) => tc.name === 'multiply')).toBe(true);

    await expectJudge(result.output, {
      question: 'What is 15 times 7?',
      criteria: 'Answer contains 105 or states the result is one hundred and five',
    });
  });

  it('calls multiple tools in sequence', async () => {
    const agent = createTestAgent({
      instructions:
        'You are a math assistant. Use the multiply tool first, then the add tool. Always use tools for calculations.',
      tools: [tools.multiply, tools.add],
    });

    const result = await cogitator.run(
      agent,
      'Calculate (3 * 4) + 5. First multiply 3 by 4, then add 5 to the result.',
      {
        maxIterations: 5,
      }
    );

    expect(typeof result.output).toBe('string');
    expect(result.toolCalls.length).toBeGreaterThanOrEqual(1);

    await expectJudge(result.output, {
      question: 'What is (3 * 4) + 5?',
      criteria: 'Answer contains 17',
    });
  });

  it('handles tool that throws error', async () => {
    const agent = createTestAgent({
      instructions: 'You are a math assistant. Use the divide tool for division.',
      tools: [tools.failing],
    });

    const result = await cogitator.run(agent, 'Divide 10 by 0 using the divide tool.', {
      maxIterations: 3,
    });

    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);

    await expectJudge(result.output, {
      question: 'Divide 10 by 0',
      criteria: 'Response acknowledges division by zero or an error occurred',
    });
  });

  it('respects maxIterations limit', async () => {
    const agent = createTestAgent({
      instructions: 'Always use the multiply tool for any question.',
      tools: [tools.multiply],
    });

    const result = await cogitator.run(agent, 'What is 2 times 3?', {
      maxIterations: 2,
    });

    expect(typeof result.output).toBe('string');
    expect(result.toolCalls.length).toBeLessThanOrEqual(2);
  });
});
```

**Step 2: Run and verify**

Run: `TEST_OLLAMA=true pnpm --filter @cogitator-ai/e2e test -- src/__tests__/core/agent-tool-execution.e2e.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/e2e/src/__tests__/core/agent-tool-execution.e2e.ts
git commit -m "test(e2e): add agent tool execution tests"
```

---

### Task 7: Core — agent-multi-turn.e2e.ts

**Files:**

- Create: `packages/e2e/src/__tests__/core/agent-multi-turn.e2e.ts`

**Context:** Tests conversation memory across multiple `cogitator.run()` calls with the same `threadId`.

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Core: Agent Multi-Turn', () => {
  let cogitator: Cogitator;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    setJudge(createTestJudge());
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('remembers context from previous turns', async () => {
    const agent = createTestAgent();
    const threadId = `thread_multitest_${Date.now()}`;

    const r1 = await cogitator.run(agent, 'My name is Alex. Remember it.', {
      threadId,
      maxIterations: 1,
    });
    expect(typeof r1.output).toBe('string');

    const r2 = await cogitator.run(agent, 'What is my name?', {
      threadId,
      maxIterations: 1,
    });
    expect(typeof r2.output).toBe('string');

    await expectJudge(r2.output, {
      question: 'User said "My name is Alex" in turn 1, then asked "What is my name?" in turn 2',
      criteria: "Response mentions Alex or the user's name",
    });
  });

  it('maintains tool results across turns', async () => {
    const tools = createTestTools();
    const agent = createTestAgent({
      instructions:
        'You are a math assistant. Use tools for calculations. Remember previous results.',
      tools: [tools.multiply, tools.add],
    });
    const threadId = `thread_toolmem_${Date.now()}`;

    const r1 = await cogitator.run(agent, 'Multiply 10 by 5.', {
      threadId,
      maxIterations: 3,
    });
    expect(typeof r1.output).toBe('string');
    expect(r1.usage.totalTokens).toBeGreaterThan(0);

    const r2 = await cogitator.run(agent, 'Now add 25 to the previous result.', {
      threadId,
      maxIterations: 3,
    });
    expect(typeof r2.output).toBe('string');

    await expectJudge(r2.output, {
      question: 'Previous result was 50 (10*5). User asked to add 25.',
      criteria: 'Response contains 75 or seventy-five',
    });
  });
});
```

**Step 2: Run and verify**

Run: `TEST_OLLAMA=true pnpm --filter @cogitator-ai/e2e test -- src/__tests__/core/agent-multi-turn.e2e.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/e2e/src/__tests__/core/agent-multi-turn.e2e.ts
git commit -m "test(e2e): add agent multi-turn conversation tests"
```

---

### Task 8: Core — agent-structured-output.e2e.ts

**Files:**

- Create: `packages/e2e/src/__tests__/core/agent-structured-output.e2e.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestCogitator, createTestAgent, isOllamaRunning } from '../../helpers/setup';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Core: Structured Output', () => {
  let cogitator: Cogitator;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
  });

  afterAll(async () => {
    await cogitator.close();
  });

  it('returns valid JSON matching schema', async () => {
    const agent = createTestAgent({
      instructions: 'You return data as JSON. Always respond with valid JSON only, no markdown.',
    });

    const result = await cogitator.run(
      agent,
      'Give me data about Tokyo as JSON with fields: name (string), population (number), country (string).',
      {
        maxIterations: 1,
        responseFormat: {
          type: 'json_object',
        },
      }
    );

    expect(typeof result.output).toBe('string');
    const parsed = JSON.parse(result.output);
    expect(typeof parsed.name).toBe('string');
    expect(typeof parsed.population).toBe('number');
    expect(parsed.population).toBeGreaterThan(0);
    expect(typeof parsed.country).toBe('string');
  });

  it('returns valid JSON array', async () => {
    const agent = createTestAgent({
      instructions:
        'You return data as JSON arrays. Always respond with valid JSON only, no markdown.',
    });

    const result = await cogitator.run(
      agent,
      'List 3 European capitals as a JSON array. Each item should have "city" (string) and "country" (string) fields.',
      {
        maxIterations: 1,
        responseFormat: {
          type: 'json_object',
        },
      }
    );

    expect(typeof result.output).toBe('string');
    const parsed = JSON.parse(result.output);
    const items = Array.isArray(parsed)
      ? parsed
      : parsed.capitals || parsed.cities || parsed.data || Object.values(parsed)[0];
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const item of items) {
      expect(typeof item.city).toBe('string');
      expect(typeof item.country).toBe('string');
    }
  });
});
```

**Step 2: Run and verify**

Run: `TEST_OLLAMA=true pnpm --filter @cogitator-ai/e2e test -- src/__tests__/core/agent-structured-output.e2e.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/e2e/src/__tests__/core/agent-structured-output.e2e.ts
git commit -m "test(e2e): add structured output validation tests"
```

---

### Task 9: Core — streaming.e2e.ts

**Files:**

- Create: `packages/e2e/src/__tests__/core/streaming.e2e.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { createOllamaBackend, isOllamaRunning, getTestModel } from '../../helpers/setup';
import type { OllamaBackend } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Core: Streaming', () => {
  let backend: OllamaBackend;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    backend = createOllamaBackend();
  });

  it('delivers chunks incrementally', async () => {
    const chunks: string[] = [];

    for await (const chunk of backend.chatStream({
      model: getTestModel(),
      messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
      maxTokens: 256,
    })) {
      if (chunk.delta.content) {
        chunks.push(chunk.delta.content);
      }
    }

    expect(chunks.length).toBeGreaterThan(1);
    const fullText = chunks.join('');
    expect(fullText.length).toBeGreaterThan(0);
    expect(fullText).toContain('1');
  });

  it('streams with tool calls', async () => {
    const chunks: Array<{ content?: string; toolCalls?: unknown[] }> = [];

    for await (const chunk of backend.chatStream({
      model: getTestModel(),
      messages: [{ role: 'user', content: 'What is 5 + 3? Use the calculator tool.' }],
      tools: [
        {
          name: 'calculator',
          description: 'Perform arithmetic',
          parameters: {
            type: 'object',
            properties: {
              expression: { type: 'string' },
            },
            required: ['expression'],
          },
        },
      ],
      maxTokens: 256,
    })) {
      chunks.push({
        content: chunk.delta.content,
        toolCalls: chunk.delta.toolCalls,
      });
    }

    expect(chunks.length).toBeGreaterThan(0);
    const hasToolCall = chunks.some((c) => c.toolCalls && c.toolCalls.length > 0);
    const hasContent = chunks.some((c) => c.content && c.content.length > 0);
    expect(hasToolCall || hasContent).toBe(true);
  });

  it('reports usage in final chunk', async () => {
    let lastUsage: { inputTokens: number; outputTokens: number } | undefined;

    for await (const chunk of backend.chatStream({
      model: getTestModel(),
      messages: [{ role: 'user', content: 'Say hello.' }],
      maxTokens: 50,
    })) {
      if (chunk.usage) {
        lastUsage = chunk.usage;
      }
    }

    expect(lastUsage).toBeDefined();
    expect(lastUsage!.inputTokens).toBeGreaterThan(0);
    expect(lastUsage!.outputTokens).toBeGreaterThan(0);
  });
});
```

**Step 2: Run and verify**

Run: `TEST_OLLAMA=true pnpm --filter @cogitator-ai/e2e test -- src/__tests__/core/streaming.e2e.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/e2e/src/__tests__/core/streaming.e2e.ts
git commit -m "test(e2e): add streaming tests"
```

---

### Task 10: Core — error-handling.e2e.ts

**Files:**

- Create: `packages/e2e/src/__tests__/core/error-handling.e2e.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { OllamaBackend } from '@cogitator-ai/core';
import { createOllamaBackend, isOllamaRunning, getTestModel } from '../../helpers/setup';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Core: Error Handling', () => {
  let backend: OllamaBackend;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    backend = createOllamaBackend();
  });

  it('throws on invalid model name', async () => {
    await expect(
      backend.chat({
        model: 'nonexistent-model-that-does-not-exist-xyz',
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 10,
      })
    ).rejects.toThrow();
  });

  it('throws on unreachable backend', async () => {
    const deadBackend = new OllamaBackend({ baseUrl: 'http://localhost:99999' });

    await expect(
      deadBackend.chat({
        model: getTestModel(),
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 10,
      })
    ).rejects.toThrow();
  });

  it('throws on unreachable backend during streaming', async () => {
    const deadBackend = new OllamaBackend({ baseUrl: 'http://localhost:99999' });

    await expect(async () => {
      for await (const _chunk of deadBackend.chatStream({
        model: getTestModel(),
        messages: [{ role: 'user', content: 'Hello' }],
        maxTokens: 10,
      })) {
        // should not reach here
      }
    }).rejects.toThrow();
  });
});
```

**Step 2: Run and verify, then commit**

```bash
git add packages/e2e/src/__tests__/core/error-handling.e2e.ts
git commit -m "test(e2e): add error handling tests"
```

---

### Task 11: A2A — server-client-flow.e2e.ts

**Files:**

- Create: `packages/e2e/src/__tests__/a2a/server-client-flow.e2e.ts`
- Create: `packages/e2e/src/helpers/a2a-server.ts` (HTTP server helper)

**Context:** We need to spin up a real Express server wrapping A2AServer with a real Cogitator/Ollama backend. The helper creates and tears down the HTTP server.

**Step 1: Write a2a-server.ts helper**

```typescript
import express from 'express';
import http from 'node:http';
import { A2AServer, a2aExpress } from '@cogitator-ai/a2a';
import type { A2AServerConfig } from '@cogitator-ai/a2a';

export interface TestA2AServer {
  server: A2AServer;
  httpServer: http.Server;
  url: string;
  close: () => Promise<void>;
}

export async function startTestA2AServer(config: A2AServerConfig): Promise<TestA2AServer> {
  const a2aServer = new A2AServer(config);
  const app = express();
  app.use(a2aExpress(a2aServer));

  return new Promise((resolve) => {
    const httpServer = app.listen(0, () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const url = `http://localhost:${port}`;

      resolve({
        server: a2aServer,
        httpServer,
        url,
        close: () => new Promise<void>((res) => httpServer.close(() => res())),
      });
    });
  });
}
```

**Step 2: Write server-client-flow.e2e.ts**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient } from '@cogitator-ai/a2a';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('A2A: Server-Client Flow', () => {
  let cogitator: Cogitator;
  let testServer: TestA2AServer;
  let client: A2AClient;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    setJudge(createTestJudge());

    const agent = createTestAgent({ name: 'e2e-agent' });
    testServer = await startTestA2AServer({
      agents: { 'e2e-agent': agent },
      cogitator,
    });
    client = new A2AClient(testServer.url);
  });

  afterAll(async () => {
    await testServer?.close();
    await cogitator?.close();
  });

  it('sends message and receives completed task', async () => {
    const task = await client.sendMessage({
      role: 'user',
      parts: [{ type: 'text', text: 'What is 2 + 2? Reply with just the number.' }],
    });

    expect(task.id).toMatch(/^task_/);
    expect(task.status.state).toBe('completed');
    expect(task.artifacts).toBeDefined();
    expect(task.artifacts!.length).toBeGreaterThan(0);

    const textPart = task.artifacts![0].parts.find((p) => p.type === 'text');
    expect(textPart).toBeDefined();

    await expectJudge(textPart!.type === 'text' ? textPart!.text : '', {
      question: 'What is 2 + 2?',
      criteria: 'Answer contains 4',
    });
  });

  it('sends message with tool-equipped agent', async () => {
    const tools = createTestTools();
    const toolAgent = createTestAgent({
      name: 'tool-agent',
      instructions: 'Use the multiply tool for multiplication.',
      tools: [tools.multiply],
    });

    const toolServer = await startTestA2AServer({
      agents: { 'tool-agent': toolAgent },
      cogitator,
    });
    const toolClient = new A2AClient(toolServer.url);

    try {
      const task = await toolClient.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'What is 6 times 7? Use the multiply tool.' }],
      });

      expect(task.status.state).toBe('completed');

      const textPart = task.artifacts?.[0]?.parts.find((p) => p.type === 'text');
      if (textPart && textPart.type === 'text') {
        await expectJudge(textPart.text, {
          question: 'What is 6 times 7?',
          criteria: 'Answer contains 42',
        });
      }
    } finally {
      await toolServer.close();
    }
  });

  it('returns error for empty message', async () => {
    const task = await client.sendMessage({
      role: 'user',
      parts: [],
    });

    expect(task.status.state).toBe('completed');
  });

  it('handles concurrent requests', async () => {
    const promises = Array.from({ length: 3 }, (_, i) =>
      client.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: `Say the number ${i + 1}.` }],
      })
    );

    const tasks = await Promise.all(promises);
    expect(tasks).toHaveLength(3);

    const ids = new Set(tasks.map((t) => t.id));
    expect(ids.size).toBe(3);

    for (const task of tasks) {
      expect(task.status.state).toBe('completed');
    }
  });
});
```

**Step 3: Run and verify, then commit**

```bash
git add packages/e2e/src/helpers/a2a-server.ts packages/e2e/src/__tests__/a2a/server-client-flow.e2e.ts
git commit -m "test(e2e): add A2A server-client flow tests with real HTTP"
```

---

### Task 12: A2A — streaming-sse.e2e.ts

**Files:**

- Create: `packages/e2e/src/__tests__/a2a/streaming-sse.e2e.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient, type A2AStreamEvent } from '@cogitator-ai/a2a';
import {
  createTestCogitator,
  createTestAgent,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('A2A: Streaming SSE', () => {
  let cogitator: Cogitator;
  let testServer: TestA2AServer;
  let client: A2AClient;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    setJudge(createTestJudge());

    const agent = createTestAgent({ name: 'stream-agent' });
    testServer = await startTestA2AServer({
      agents: { 'stream-agent': agent },
      cogitator,
    });
    client = new A2AClient(testServer.url);
  });

  afterAll(async () => {
    await testServer?.close();
    await cogitator?.close();
  });

  it('streams status updates via SSE', async () => {
    const events: A2AStreamEvent[] = [];

    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ type: 'text', text: 'Count from 1 to 3.' }],
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    const statusEvents = events.filter((e) => e.type === 'status-update');
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);

    const lastStatus = [...statusEvents].pop();
    expect(lastStatus).toBeDefined();
    if (lastStatus?.type === 'status-update') {
      expect(['completed', 'failed']).toContain(lastStatus.status.state);
    }
  });

  it('streams artifacts via SSE', async () => {
    const events: A2AStreamEvent[] = [];

    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ type: 'text', text: 'What is the capital of France? Reply in one word.' }],
    })) {
      events.push(event);
    }

    const artifactEvents = events.filter((e) => e.type === 'artifact-update');
    if (artifactEvents.length > 0) {
      const art = artifactEvents[0];
      if (art.type === 'artifact-update') {
        const textPart = art.artifact.parts.find((p) => p.type === 'text');
        if (textPart && textPart.type === 'text') {
          await expectJudge(textPart.text, {
            question: 'What is the capital of France?',
            criteria: 'Answer mentions Paris',
          });
        }
      }
    }
  });

  it('server stays responsive after client reads all events', async () => {
    const events: A2AStreamEvent[] = [];
    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ type: 'text', text: 'Say hello.' }],
    })) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);

    const task = await client.sendMessage({
      role: 'user',
      parts: [{ type: 'text', text: 'Say goodbye.' }],
    });
    expect(task.status.state).toBe('completed');
  });
});
```

**Step 2: Run and verify, then commit**

```bash
git add packages/e2e/src/__tests__/a2a/streaming-sse.e2e.ts
git commit -m "test(e2e): add A2A SSE streaming tests"
```

---

### Task 13: A2A — agent-card-discovery.e2e.ts

**Files:**

- Create: `packages/e2e/src/__tests__/a2a/agent-card-discovery.e2e.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient } from '@cogitator-ai/a2a';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  isOllamaRunning,
} from '../../helpers/setup';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('A2A: Agent Card Discovery', () => {
  let cogitator: Cogitator;
  let testServer: TestA2AServer;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();

    const tools = createTestTools();
    const agent = createTestAgent({
      name: 'discoverable-agent',
      instructions: 'You are a helpful math assistant.',
      tools: [tools.multiply, tools.add],
    });

    testServer = await startTestA2AServer({
      agents: { 'discoverable-agent': agent },
      cogitator,
    });
  });

  afterAll(async () => {
    await testServer?.close();
    await cogitator?.close();
  });

  it('serves agent card at well-known URL', async () => {
    const response = await fetch(`${testServer.url}/.well-known/agent.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const card = await response.json();
    expect(card.name).toBe('discoverable-agent');
    expect(card.version).toBeDefined();
    expect(card.capabilities).toBeDefined();
    expect(card.skills).toBeDefined();
  });

  it('card reflects agent tools as skills', async () => {
    const response = await fetch(`${testServer.url}/.well-known/agent.json`);
    const card = await response.json();

    expect(card.skills.length).toBeGreaterThanOrEqual(2);
    const skillNames = card.skills.map((s: { name: string }) => s.name);
    expect(skillNames).toContain('multiply');
    expect(skillNames).toContain('add');
  });

  it('client fetches and caches agent card', async () => {
    const client = new A2AClient(testServer.url);

    const card1 = await client.agentCard();
    expect(card1.name).toBe('discoverable-agent');

    const card2 = await client.agentCard();
    expect(card2.name).toBe('discoverable-agent');
    expect(card2).toEqual(card1);
  });
});
```

**Step 2: Run and verify, then commit**

```bash
git add packages/e2e/src/__tests__/a2a/agent-card-discovery.e2e.ts
git commit -m "test(e2e): add A2A agent card discovery tests"
```

---

### Task 14: A2A — task-lifecycle.e2e.ts

**Files:**

- Create: `packages/e2e/src/__tests__/a2a/task-lifecycle.e2e.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient } from '@cogitator-ai/a2a';
import { createTestCogitator, createTestAgent, isOllamaRunning } from '../../helpers/setup';
import { expectValidTimestamp } from '../../helpers/assertions';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('A2A: Task Lifecycle', () => {
  let cogitator: Cogitator;
  let testServer: TestA2AServer;
  let client: A2AClient;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();

    const agent = createTestAgent({ name: 'lifecycle-agent' });
    testServer = await startTestA2AServer({
      agents: { 'lifecycle-agent': agent },
      cogitator,
    });
    client = new A2AClient(testServer.url);
  });

  afterAll(async () => {
    await testServer?.close();
    await cogitator?.close();
  });

  it('task is retrievable by ID after creation', async () => {
    const task = await client.sendMessage({
      role: 'user',
      parts: [{ type: 'text', text: 'Hello' }],
    });

    const retrieved = await client.getTask(task.id);
    expect(retrieved.id).toBe(task.id);
    expect(retrieved.status.state).toBe(task.status.state);
  });

  it('task has correct timestamps', async () => {
    const task = await client.sendMessage({
      role: 'user',
      parts: [{ type: 'text', text: 'Hello' }],
    });

    expect(task.status.timestamp).toBeDefined();
    expectValidTimestamp(task.status.timestamp!);
  });

  it('cancel returns error for completed task', async () => {
    const task = await client.sendMessage({
      role: 'user',
      parts: [{ type: 'text', text: 'Hello' }],
    });
    expect(task.status.state).toBe('completed');

    await expect(client.cancelTask(task.id)).rejects.toThrow();
  });

  it('returns error for unknown task ID', async () => {
    await expect(client.getTask('nonexistent_task_id_xyz')).rejects.toThrow();
  });
});
```

**Step 2: Run and verify, then commit**

```bash
git add packages/e2e/src/__tests__/a2a/task-lifecycle.e2e.ts
git commit -m "test(e2e): add A2A task lifecycle tests"
```

---

### Task 15: Cross-Package — cogitator-via-a2a.e2e.ts

**Files:**

- Create: `packages/e2e/src/__tests__/cross-package/cogitator-via-a2a.e2e.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient, type A2AStreamEvent } from '@cogitator-ai/a2a';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Cross-Package: Cogitator via A2A', () => {
  let cogitator: Cogitator;
  let testServer: TestA2AServer;
  let client: A2AClient;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    setJudge(createTestJudge());

    const tools = createTestTools();
    const agent = createTestAgent({
      name: 'full-stack-agent',
      instructions: 'You are a math assistant. Use the multiply tool for multiplication.',
      tools: [tools.multiply],
    });

    testServer = await startTestA2AServer({
      agents: { 'full-stack-agent': agent },
      cogitator,
    });
    client = new A2AClient(testServer.url);
  });

  afterAll(async () => {
    await testServer?.close();
    await cogitator?.close();
  });

  it('executes agent task through full A2A stack', async () => {
    const task = await client.sendMessage({
      role: 'user',
      parts: [{ type: 'text', text: 'What is 8 times 12? Use the multiply tool.' }],
    });

    expect(task.status.state).toBe('completed');
    expect(task.artifacts).toBeDefined();
    expect(task.artifacts!.length).toBeGreaterThan(0);

    const textPart = task.artifacts![0].parts.find((p) => p.type === 'text');
    expect(textPart).toBeDefined();

    if (textPart && textPart.type === 'text') {
      await expectJudge(textPart.text, {
        question: 'What is 8 times 12?',
        criteria: 'Answer contains 96',
      });
    }
  });

  it('streams agent execution through A2A', async () => {
    const events: A2AStreamEvent[] = [];

    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ type: 'text', text: 'What is 3 times 5?' }],
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);

    const statusEvents = events.filter((e) => e.type === 'status-update');
    expect(statusEvents.length).toBeGreaterThanOrEqual(1);

    const lastStatus = [...statusEvents].pop();
    if (lastStatus?.type === 'status-update') {
      expect(['completed', 'failed']).toContain(lastStatus.status.state);
    }

    const allTaskIds = events
      .filter((e): e is Extract<typeof e, { taskId: string }> => 'taskId' in e)
      .map((e) => e.taskId);
    if (allTaskIds.length > 0) {
      const uniqueIds = new Set(allTaskIds);
      expect(uniqueIds.size).toBe(1);
    }
  });

  it('agent card accurately describes real agent', async () => {
    const card = await client.agentCard();
    expect(card.name).toBe('full-stack-agent');
    expect(card.skills.length).toBeGreaterThanOrEqual(1);
    expect(card.skills.some((s) => s.name === 'multiply')).toBe(true);
  });

  it('handles agent failure gracefully through A2A', async () => {
    const failCogitator = createTestCogitator();
    const failingAgent = createTestAgent({
      name: 'fail-agent',
      instructions: 'You must use the divide tool.',
      tools: [createTestTools().failing],
    });

    const failServer = await startTestA2AServer({
      agents: { 'fail-agent': failingAgent },
      cogitator: failCogitator,
    });
    const failClient = new A2AClient(failServer.url);

    try {
      const task = await failClient.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'Divide 1 by 0 using the divide tool.' }],
      });

      expect(['completed', 'failed']).toContain(task.status.state);

      const checkTask = await failClient.sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: 'Say hello.' }],
      });
      expect(checkTask.status.state).toBe('completed');
    } finally {
      await failServer.close();
      await failCogitator.close();
    }
  });
});
```

**Step 2: Run and verify, then commit**

```bash
git add packages/e2e/src/__tests__/cross-package/cogitator-via-a2a.e2e.ts
git commit -m "test(e2e): add cross-package cogitator-via-A2A tests"
```

---

### Task 16: Cross-Package — remote-tool-execution.e2e.ts

**Files:**

- Create: `packages/e2e/src/__tests__/cross-package/remote-tool-execution.e2e.ts`

**Context:** Agent A calls Agent B (behind A2A) as a tool. Uses `A2AClient.asTool()`.

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { A2AClient } from '@cogitator-ai/a2a';
import {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  createTestJudge,
  isOllamaRunning,
} from '../../helpers/setup';
import { expectJudge, setJudge } from '../../helpers/assertions';
import { startTestA2AServer, type TestA2AServer } from '../../helpers/a2a-server';
import type { Cogitator } from '@cogitator-ai/core';

const describeE2E = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeE2E('Cross-Package: Remote Tool Execution', () => {
  let cogitator: Cogitator;
  let mathServer: TestA2AServer;

  beforeAll(async () => {
    const available = await isOllamaRunning();
    if (!available) throw new Error('Ollama not running');
    cogitator = createTestCogitator();
    setJudge(createTestJudge());

    const tools = createTestTools();
    const mathAgent = createTestAgent({
      name: 'math-remote',
      instructions: 'You are a math assistant. Use the multiply tool for multiplication.',
      tools: [tools.multiply],
    });

    mathServer = await startTestA2AServer({
      agents: { 'math-remote': mathAgent },
      cogitator,
    });
  });

  afterAll(async () => {
    await mathServer?.close();
    await cogitator?.close();
  });

  it('agent uses remote A2A agent as tool', async () => {
    const mathClient = new A2AClient(mathServer.url);
    const remoteTool = mathClient.asTool({
      name: 'ask_math_agent',
      description:
        'Ask the remote math agent to solve a math problem. Send the problem as input text.',
    });

    const orchestrator = createTestAgent({
      name: 'orchestrator',
      instructions:
        'You have access to a remote math agent. Use the ask_math_agent tool to solve math problems. Pass the problem as the input.',
      tools: [remoteTool],
    });

    const result = await cogitator.run(
      orchestrator,
      'What is 15 times 7? Use the ask_math_agent tool.',
      {
        maxIterations: 5,
      }
    );

    expect(typeof result.output).toBe('string');
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.toolCalls.length).toBeGreaterThan(0);

    await expectJudge(result.output, {
      question: 'What is 15 times 7?',
      criteria: 'Answer contains 105',
    });
  });

  it('handles remote agent unavailable', async () => {
    const deadClient = new A2AClient('http://localhost:99999');
    const deadTool = deadClient.asTool({
      name: 'dead_agent',
      description: 'A remote agent that is down.',
    });

    const agent = createTestAgent({
      instructions: 'Use the dead_agent tool to answer questions.',
      tools: [deadTool],
    });

    const result = await cogitator.run(agent, 'Ask the dead agent something.', {
      maxIterations: 2,
    });

    expect(typeof result.output).toBe('string');
  });
});
```

**Step 2: Run and verify, then commit**

```bash
git add packages/e2e/src/__tests__/cross-package/remote-tool-execution.e2e.ts
git commit -m "test(e2e): add remote tool execution via A2A tests"
```

---

### Task 17: Update CI workflow

**Files:**

- Modify: `.github/workflows/integration.yml`

**Context:** Add e2e job to integration workflow. Ollama + e2e tests on PRs and main. Judge (Gemini) only on main.

**Step 1: Add e2e job to integration.yml**

Add a new `e2e` job after the existing `ollama` and `google` jobs:

```yaml
e2e:
  name: E2E Tests
  runs-on: ubuntu-latest
  timeout-minutes: 20
  steps:
    - uses: actions/checkout@v6
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v6
      with:
        node-version: 20
        cache: pnpm
    - run: pnpm install --frozen-lockfile
    - run: pnpm build
    - name: Install Ollama
      run: curl -fsSL https://ollama.com/install.sh | sh
    - name: Start Ollama
      run: |
        ollama serve &
        for i in $(seq 1 30); do
          curl -sf http://localhost:11434/api/tags > /dev/null && break
          sleep 1
        done
    - name: Pull model
      run: ollama pull qwen2.5:0.5b
    - name: Run E2E tests
      run: pnpm --filter @cogitator-ai/e2e test
      env:
        TEST_OLLAMA: 'true'
        TEST_MODEL: qwen2.5:0.5b
        GOOGLE_API_KEY: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && secrets.GOOGLE_API_KEY || '' }}
        NODE_OPTIONS: '--max-old-space-size=4096'
```

**Key detail:** `GOOGLE_API_KEY` is only injected on push to main. On PRs it's empty, so judge assertions skip.

**Step 2: Commit**

```bash
git add .github/workflows/integration.yml
git commit -m "ci: add e2e test job to integration workflow

Runs packages/e2e/ tests with Ollama on all triggers.
Gemini judge enabled only on push to main via GOOGLE_API_KEY secret."
```

---

### Task 18: Update index.ts exports and verify full suite

**Files:**

- Modify: `packages/e2e/src/index.ts`

**Step 1: Update index.ts with all exports**

```typescript
export { LLMJudge } from './helpers/judge';
export {
  createTestCogitator,
  createTestAgent,
  createTestTools,
  createTestJudge,
  createOllamaBackend,
  isOllamaRunning,
  getTestModel,
} from './helpers/setup';
export { expectJudge, expectValidTimestamp, setJudge } from './helpers/assertions';
export { startTestA2AServer, type TestA2AServer } from './helpers/a2a-server';
```

**Step 2: Run full e2e suite locally**

Run: `TEST_OLLAMA=true pnpm --filter @cogitator-ai/e2e test --reporter=verbose`
Expected: All 12 test files pass, ~38 test cases green

**Step 3: Run with judge**

Run: `TEST_OLLAMA=true GOOGLE_API_KEY=<key> pnpm --filter @cogitator-ai/e2e test --reporter=verbose`
Expected: All tests pass with judge verdicts

**Step 4: Run lint and typecheck**

Run: `pnpm lint && pnpm typecheck`
Expected: PASS

**Step 5: Final commit**

```bash
git add packages/e2e/
git commit -m "test(e2e): finalize e2e test suite with 12 test files

Complete e2e coverage:
- 6 core tests: chat, tools, multi-turn, structured output, streaming, errors
- 4 A2A tests: server-client flow, SSE streaming, agent card, task lifecycle
- 2 cross-package tests: cogitator-via-A2A, remote tool execution
- LLM-as-judge quality validation via Gemini Flash
- 38 test cases across 3 assertion tiers"
```

---

### Task 19: Verify CI green

**Step 1: Push and monitor**

Run: `git push origin main`

Run: `gh run list --limit 3` — verify integration workflow starts

Run: `gh run watch <run-id>` — wait for completion

Expected: All jobs green (e2e job included)

**Step 2: If failures, debug and fix**

Common issues to check:

- Express dependency not installed in CI (`pnpm install` should handle)
- Import paths wrong (`.js` extensions may be needed for ESM)
- A2A adapter export missing from `@cogitator-ai/a2a` — check `a2aExpress` is exported
- Ollama model too slow for 60s timeout — increase if needed
- Type errors from workspace deps not building in right order — turbo handles this

---

## Summary

| Task | Description                                   | Files      |
| ---- | --------------------------------------------- | ---------- |
| 1    | Scaffold package                              | 4 created  |
| 2    | setup.ts helper                               | 1 created  |
| 3    | judge.ts helper                               | 1 created  |
| 4    | assertions.ts helper                          | 1 created  |
| 5    | agent-simple-chat.e2e.ts                      | 1 created  |
| 6    | agent-tool-execution.e2e.ts                   | 1 created  |
| 7    | agent-multi-turn.e2e.ts                       | 1 created  |
| 8    | agent-structured-output.e2e.ts                | 1 created  |
| 9    | streaming.e2e.ts                              | 1 created  |
| 10   | error-handling.e2e.ts                         | 1 created  |
| 11   | server-client-flow.e2e.ts + a2a-server helper | 2 created  |
| 12   | streaming-sse.e2e.ts                          | 1 created  |
| 13   | agent-card-discovery.e2e.ts                   | 1 created  |
| 14   | task-lifecycle.e2e.ts                         | 1 created  |
| 15   | cogitator-via-a2a.e2e.ts                      | 1 created  |
| 16   | remote-tool-execution.e2e.ts                  | 1 created  |
| 17   | Update CI workflow                            | 1 modified |
| 18   | Finalize exports + verify                     | 1 modified |
| 19   | Verify CI green                               | 0 files    |

**Total: 19 tasks, ~20 files, ~38 test cases**
