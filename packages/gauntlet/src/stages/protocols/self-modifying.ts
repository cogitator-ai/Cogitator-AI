import { crc32 } from 'node:zlib';
import { Agent } from '@cogitator-ai/core';
import {
  SelfModifyingAgent,
  ToolGenerator,
  ToolSandbox,
  ToolValidator,
  type SandboxTestCase,
} from '@cogitator-ai/self-modifying';
import type {
  CapabilityGap,
  ChatResponse,
  GeneratedTool,
  LLMBackend,
  Tool,
  ToolSelfGenerationConfig,
} from '@cogitator-ai/types';
import type { StageContext, StageDefinition } from '../../runner/types.js';
import { CORE, SELF_MODIFYING, TYPES, assertCalled, calledTools, excerpt } from './shared.js';

/** The Luhn (mod 10) check digit of a digit string, the reference the generated tool must match. */
function luhnCheckDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10;
}

/** CRC-32 (IEEE) of a UTF-8 text as 8 lowercase hex digits, the reference for the agent stage. */
function crc32Hex(text: string): string {
  return crc32(text).toString(16).padStart(8, '0');
}

const LUHN_PARAMETERS = {
  type: 'object',
  properties: {
    digits: {
      type: 'string',
      description: 'The number without its check digit, decimal digits only',
    },
  },
  required: ['digits'],
};

const LUHN_GAP: CapabilityGap = {
  id: 'gauntlet_luhn',
  description:
    'Compute the Luhn (mod 10) check digit for a string of decimal digits. Input: { digits: string }. Return the check digit as a plain number from 0 to 9. Throw an Error when digits is empty or contains anything other than 0-9.',
  requiredCapability: 'Luhn check digit computation',
  suggestedToolName: 'luhn_check_digit',
  complexity: 'simple',
  confidence: 1,
};

/** A correct Luhn tool that rejects malformed input, as the generation prompt asks tools to. */
const HANDWRITTEN_LUHN = [
  'async function execute(params) {',
  "  if (typeof params.digits !== 'string' || !/^[0-9]+$/.test(params.digits)) {",
  "    throw new Error('digits must be a non-empty string of 0-9');",
  '  }',
  '  let sum = 0;',
  '  for (let i = 0; i < params.digits.length; i++) {',
  '    let digit = Number(params.digits[params.digits.length - 1 - i]);',
  '    if (i % 2 === 0) { digit *= 2; if (digit > 9) digit -= 9; }',
  '    sum += digit;',
  '  }',
  '  return (10 - (sum % 10)) % 10;',
  '}',
].join('\n');

function generationConfig(
  overrides: Partial<ToolSelfGenerationConfig> = {}
): ToolSelfGenerationConfig {
  return {
    enabled: true,
    autoGenerate: true,
    maxToolsPerSession: 1,
    minConfidenceForGeneration: 0.5,
    maxIterationsPerTool: 3,
    requireLLMValidation: true,
    sandboxConfig: {
      enabled: true,
      maxExecutionTime: 2_000,
      maxMemory: 32 * 1024 * 1024,
      allowedModules: [],
      isolationLevel: 'strict',
    },
    ...overrides,
  };
}

/** The gauntlet's backend and the model name it expects, for components that call it directly. */
function llmFor(ctx: StageContext, model = ctx.model) {
  return ctx.cogitator.route(model);
}

function handwritten(
  name: string,
  implementation: string,
  parameters: Record<string, unknown> = { type: 'object', properties: {} }
): GeneratedTool {
  return {
    id: `gauntlet_${name}`,
    name,
    description: `Gauntlet probe ${name}`,
    implementation,
    parameters,
    createdAt: new Date(),
    version: 1,
    status: 'pending_validation',
  };
}

/** A backend that answers every call with one fixed review, to test how a verdict is used. */
function reviewer(review: Record<string, unknown>): LLMBackend {
  const response: ChatResponse = {
    id: 'gauntlet-review',
    content: JSON.stringify(review),
    finishReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
  return {
    provider: 'gauntlet-stub',
    chat: async () => response,
    async *chatStream() {
      yield { id: response.id, delta: { content: response.content }, finishReason: 'stop' };
    },
  };
}

/**
 * The sandbox generated code runs in, probed with hand-written tools: plain code works, host
 * objects are absent, string code generation is off, and a busy loop is cut off. Also how the
 * validator grades a correct tool. No model needed.
 */
export const generatedToolSandboxStage: StageDefinition = {
  id: 'generated-tool-sandbox',
  title: 'Generated tool sandbox',
  description:
    'Code that would be generated at runtime runs in a worker vm without host objects or eval, static checks reject escapes, busy loops time out, and a correct tool validates.',
  packages: [SELF_MODIFYING, TYPES],
  timeoutMs: 60_000,
  async run(ctx) {
    const sandbox = new ToolSandbox({ maxExecutionTime: 1_000, maxMemory: 32 * 1024 * 1024 });

    await ctx.check('plain tool runs and test cases grade it', async (evidence) => {
      const add = handwritten(
        'add',
        "async function execute(params) { if (typeof params.a !== 'number' || typeof params.b !== 'number') { throw new Error('a and b must be numbers'); } return params.a + params.b; }"
      );
      const report = await sandbox.testWithCases(add, [
        { input: { a: 2, b: 40 }, expectedOutput: 42 },
        { input: { a: 'x' }, shouldThrow: true },
        { input: { a: 1, b: 1 }, expectedOutput: 3 },
      ]);
      evidence('passed', report.passed);
      evidence('failed', report.failed);
      evidence(
        'outputs',
        report.results.map((result) => result.output ?? result.error)
      );
      if (report.passed !== 2 || report.failed !== 1 || report.results[2]?.passed !== false) {
        throw new Error('The test report does not grade the cases correctly');
      }
    });

    await ctx.check('host objects are absent at runtime', async (evidence) => {
      const probe = handwritten(
        'probe',
        [
          'async function execute() {',
          '  const g = globalThis;',
          '  const ctor = execute.constructor;',
          "  let codegen = 'blocked';",
          "  try { ctor('return 1'); codegen = 'allowed'; } catch (e) { codegen = 'blocked'; }",
          '  return { process: typeof g.process, require: typeof g.require, fetch: typeof g.fetch, buffer: typeof g.Buffer, codegen };',
          '}',
        ].join('\n')
      );
      const result = await sandbox.execute(probe, {});
      evidence('result', result.success ? result.result : result.error);
      if (!result.success) throw new Error(`Probe failed: ${result.error}`);
      const seen = result.result as Record<string, string>;
      for (const name of ['process', 'require', 'fetch', 'buffer']) {
        if (seen[name] !== 'undefined') throw new Error(`${name} is reachable inside the sandbox`);
      }
      if (seen.codegen !== 'blocked') throw new Error('String code generation is allowed');
    });

    await ctx.check('static checks reject escape attempts', async (evidence) => {
      const attempts = {
        require:
          "async function execute() { return require('fs').readFileSync('/etc/passwd', 'utf8'); }",
        eval: "async function execute() { return eval('1 + 1'); }",
        concatenated:
          "async function execute() { const p = globalThis['pro' + 'cess']; return p.env; }",
        prototype: 'async function execute() { return ({}).__proto__; }',
      };
      const errors: Record<string, string> = {};
      for (const [name, code] of Object.entries(attempts)) {
        const result = await sandbox.execute(handwritten(name, code), {});
        errors[name] = result.success ? 'RAN' : excerpt(result.error ?? '', 80);
      }
      evidence('errors', errors);
      const ran = Object.entries(errors).filter(([, error]) => error === 'RAN');
      if (ran.length) {
        throw new Error(`Escape attempts ran: ${ran.map(([name]) => name).join(', ')}`);
      }
    });

    await ctx.check('busy loop is terminated', async (evidence) => {
      const started = Date.now();
      const result = await sandbox.execute(
        handwritten('spin', 'async function execute() { while (true) {} }'),
        {}
      );
      evidence('elapsedMs', Date.now() - started);
      evidence('error', result.error);
      if (result.success) throw new Error('An endless loop returned');
      if (!/timeout/i.test(result.error ?? '')) throw new Error('The failure is not a timeout');
      if (Date.now() - started > 15_000) throw new Error('The timeout fired far too late');
    });

    await ctx.check('validator accepts a correct tool', async (evidence) => {
      const luhn = handwritten('luhn_check_digit', HANDWRITTEN_LUHN, LUHN_PARAMETERS);
      const reference: SandboxTestCase[] = [
        { input: { digits: '7992739871' }, expectedOutput: 3 },
        { input: { digits: '12a4' }, shouldThrow: true },
      ];
      const graded = await sandbox.testWithCases(luhn, reference);
      evidence('referenceCasesPassed', `${graded.passed}/${reference.length}`);
      if (graded.failed > 0) throw new Error('The hand-written Luhn tool is wrong');

      const withoutReview = await new ToolValidator({
        config: generationConfig({ requireLLMValidation: false }),
      }).validate(luhn);
      evidence('defaultTests', {
        isValid: withoutReview.isValid,
        issues: withoutReview.logicIssues.map((issue) => excerpt(issue, 90)),
      });

      const approving = reviewer({
        isValid: true,
        recommendation: 'approve',
        overallScore: 0.95,
        securityIssues: ['No upper bound on the input length'],
        logicIssues: [],
        edgeCases: [],
        suggestions: ['Consider documenting the return type'],
      });
      const withReview = await new ToolValidator({
        llm: approving,
        model: 'stub',
        config: generationConfig({ requireLLMValidation: true }),
      }).validate(luhn, reference);
      evidence('approvingReview', {
        isValid: withReview.isValid,
        score: withReview.overallScore,
        securityIssues: withReview.securityIssues,
      });

      const problems: string[] = [];
      if (!withoutReview.isValid) {
        problems.push('the synthesized test cases reject a tool that throws on malformed input');
      }
      if (!withReview.isValid) {
        problems.push('a review that approves the tool still marks it invalid');
      }
      if (problems.length) throw new Error(`A correct tool is rejected: ${problems.join(' and ')}`);
    });
  },
};

/**
 * A tool is synthesized by the gauntlet model for a described gap, graded in the sandbox
 * against reference test cases, and then used by an ordinary Cogitator agent. The reference
 * cases are the oracle, so the LLM review is off: how the validator treats a review is checked
 * deterministically in `generated-tool-sandbox`.
 */
export const toolGenerationStage: StageDefinition = {
  id: 'tool-generation',
  title: 'Tool generation',
  description:
    'The model writes a Luhn check-digit tool, the sandbox grades it against reference cases, and a regular agent answers with it.',
  packages: [SELF_MODIFYING, CORE, TYPES],
  needs: ['handshake'],
  timeoutMs: 180_000,
  async run(ctx) {
    const { backend, model } = llmFor(ctx);
    const generator = new ToolGenerator({
      llm: backend,
      model,
      config: generationConfig({ requireLLMValidation: false }),
    });
    const cases: SandboxTestCase[] = [
      { input: { digits: '7992739871' }, expectedOutput: luhnCheckDigit('7992739871') },
      { input: { digits: '453914880343646' }, expectedOutput: luhnCheckDigit('453914880343646') },
      { input: { digits: '12a4' }, shouldThrow: true },
    ];

    const generated = await ctx.check(
      'model writes a tool that passes the sandbox tests',
      async (evidence) => {
        const result = await generator.generate(LUHN_GAP, [], cases, {
          parameters: LUHN_PARAMETERS,
        });
        evidence('model', model);
        evidence('success', result.success);
        evidence('iterations', result.iterations);
        evidence('name', result.tool?.name);
        evidence('score', result.validationResult?.overallScore);
        evidence(
          'tests',
          result.validationResult?.testResults.map((test) => test.passed)
        );
        if (result.validationResult && !result.success) {
          evidence(
            'issues',
            [...result.validationResult.securityIssues, ...result.validationResult.logicIssues]
              .slice(0, 4)
              .map((issue) => excerpt(issue, 120))
          );
        }
        if (!result.success || !result.tool) {
          throw new Error(result.error ?? 'No tool was generated');
        }
        if (result.tool.status !== 'validated') {
          throw new Error(`Tool status is ${result.tool.status}`);
        }
        return result.tool;
      }
    );

    await ctx.check('generated tool matches the reference on fresh input', async (evidence) => {
      const sandbox = new ToolSandbox({ maxExecutionTime: 2_000 });
      const inputs = ['37828224631000', '601111111111111', '0'];
      const outputs = await Promise.all(
        inputs.map((digits) => sandbox.execute(generated, { digits }))
      );
      evidence(
        'outputs',
        outputs.map((output) => (output.success ? output.result : output.error))
      );
      inputs.forEach((digits, index) => {
        const output = outputs[index];
        if (!output?.success || Number(output.result) !== luhnCheckDigit(digits)) {
          throw new Error(`Wrong check digit for ${digits}`);
        }
      });
    });

    await ctx.check('agent answers with the generated tool', async (evidence) => {
      const executable = generator.createExecutableTool(generated);
      let runs = 0;
      const counted: Tool = {
        ...executable,
        execute: (params, context) => {
          runs++;
          return executable.execute(params, context);
        },
      };
      const digits = '536194027781';
      const agent = new Agent({
        name: 'payments-clerk',
        model: ctx.model,
        instructions: `You never compute check digits yourself. Use ${generated.name} and reply with the digit only.`,
        tools: [counted],
        maxIterations: 4,
      });
      const run = await ctx.cogitator.run(agent, {
        input: `What is the Luhn check digit for ${digits}?`,
        signal: ctx.signal,
      });
      evidence('toolCalls', calledTools(run));
      evidence('sandboxRuns', runs);
      evidence('output', excerpt(run.output));
      assertCalled(run, generated.name);
      if (runs === 0) throw new Error('The generated tool never executed');
      if (!run.output.includes(String(luhnCheckDigit(digits)))) {
        throw new Error('The answer lacks the check digit');
      }
    });
  },
};

/**
 * `SelfModifyingAgent` notices it lacks a capability, generates and sandbox-tests a tool, uses it
 * in the same run, and reuses it from its store on the next run without generating again. It
 * runs on the fastest gauntlet model: the pipeline makes several serial calls per run.
 */
export const selfModifyingAgentStage: StageDefinition = {
  id: 'self-modifying-agent',
  title: 'Self-modifying agent',
  description:
    'An agent detects a missing capability, generates a tool at runtime, runs it to answer, and reuses it on the next run.',
  packages: [SELF_MODIFYING, CORE, TYPES],
  needs: ['handshake'],
  timeoutMs: 180_000,
  async run(ctx) {
    const model = ctx.models[1] ?? ctx.model;
    const { backend } = llmFor(ctx, model);
    const agent = new Agent({
      name: 'release-checksums',
      model,
      instructions:
        'You compute checksums for a release pipeline. You never compute checksums yourself: always call a tool and reply with its result only.',
      maxIterations: 4,
      temperature: 0.2,
    });
    const selfModifying = new SelfModifyingAgent({
      agent,
      llm: backend,
      config: {
        toolGeneration: generationConfig({ requireLLMValidation: false }),
        architectureEvolution: { enabled: false },
        constraints: { enabled: true, autoRollback: true },
      },
    });
    const events: string[] = [];
    const generation: Array<{ name: string; success: boolean; error?: string }> = [];
    selfModifying.on('run_started', () => events.push('run_started'));
    selfModifying.on('checkpoint_created', () => events.push('checkpoint_created'));
    selfModifying.on('tool_generation_started', (event) => {
      events.push('tool_generation_started');
      ctx.log(`gap found, generating ${event.data.gap.suggestedToolName}`);
    });
    selfModifying.on('tool_generation_completed', (event) => {
      events.push('tool_generation_completed');
      generation.push({
        name: event.data.name,
        success: event.data.success,
        ...(event.data.error && { error: excerpt(event.data.error, 160) }),
      });
      ctx.log(`generation of ${event.data.name} ${event.data.success ? 'succeeded' : 'failed'}`);
    });
    selfModifying.on('run_completed', () => events.push('run_completed'));

    const question = (text: string) =>
      `What is the CRC-32 checksum (IEEE 802.3, as 8 lowercase hex digits) of the exact text "${text}"?`;

    const first = await ctx.check(
      'agent generates a tool and answers with it',
      async (evidence) => {
        const text = 'cogitator-proving-ground';
        const result = await selfModifying.run(question(text));
        const stored = await selfModifying.getGeneratedTools();
        evidence('model', model);
        evidence('events', [...events]);
        evidence('generation', [...generation]);
        evidence(
          'generated',
          result.toolsGenerated.map((t) => t.name)
        );
        evidence(
          'usage',
          stored.map((t) => ({ name: t.name, uses: t.usageCount ?? 0 }))
        );
        evidence('output', excerpt(result.output));
        if (result.toolsGenerated.length === 0)
          throw new Error('No tool was generated for the gap');
        const uses = stored.reduce((sum, t) => sum + (t.usageCount ?? 0), 0);
        if (uses === 0) throw new Error('The generated tool was never executed during the run');
        if (!result.output.toLowerCase().includes(crc32Hex(text))) {
          throw new Error(`The answer lacks the checksum ${crc32Hex(text)}`);
        }
        return { uses };
      }
    );

    await ctx.check('next run reuses the stored tool', async (evidence) => {
      const text = 'vell-island';
      generation.length = 0;
      const result = await selfModifying.run(question(text));
      const stored = await selfModifying.getGeneratedTools();
      const uses = stored.reduce((sum, t) => sum + (t.usageCount ?? 0), 0);
      evidence(
        'generatedAgain',
        result.toolsGenerated.map((t) => t.name)
      );
      evidence(
        'storedTools',
        stored.map((t) => t.name)
      );
      evidence('usesBefore', first.uses);
      evidence('usesAfter', uses);
      evidence('output', excerpt(result.output));
      if (result.toolsGenerated.length > 0) {
        throw new Error('The agent generated a tool it already had');
      }
      if (uses <= first.uses) throw new Error('The stored tool was not used on the second run');
      if (!result.output.toLowerCase().includes(crc32Hex(text))) {
        throw new Error(`The answer lacks the checksum ${crc32Hex(text)}`);
      }
    });
  },
};
