import type {
  ABTest,
  ABTestOutcome,
  ABTestStore,
  InstructionSource,
  InstructionVersion,
  InstructionVersionStore,
  PromptsConfig,
  RunPrompt,
  RunResult,
} from '@cogitator-ai/types';
import type { Agent } from '../agent';
import { ABTestingFramework } from '../learning/ab-testing';
import { RollbackManager, type RollbackResult } from '../learning/rollback-manager';
import { InMemoryABTestStore, InMemoryInstructionVersionStore } from '../learning/prompt-stores';
import { CogitatorError, ErrorCode } from '@cogitator-ai/types';
import { getLogger } from '../logger';

/** An agent, or the key its instructions are versioned under. */
export type PromptTarget = Agent | string;

export interface StartABTestOptions {
  name: string;
  /** The instructions to test against the current ones */
  treatment: string;
  description?: string;
  /** Share of threads that get the treatment (default 0.5) */
  treatmentAllocation?: number;
  minSampleSize?: number;
  /** Milliseconds after which the test completes even without a clear winner */
  maxDuration?: number;
  confidenceLevel?: number;
}

/** The instructions a run uses, and what to record its outcome against. */
export interface PromptResolution {
  instructions: string;
  prompt: RunPrompt;
}

/**
 * Versioned instructions and A/B tests for agents: deploy a new version,
 * roll back, see each version's metrics, and test new instructions against
 * the current ones on live traffic.
 *
 * Versions are kept per agent `id` when it was set explicitly, else per
 * `name`, so they outlive the process.
 */
export class PromptRegistry {
  private readonly versions: InstructionVersionStore;
  private readonly rollback: RollbackManager;
  private readonly abTesting: ABTestingFramework;

  constructor(private readonly config: PromptsConfig = {}) {
    this.versions = config.versions ?? new InMemoryInstructionVersionStore();
    const abTests: ABTestStore = config.abTests ?? new InMemoryABTestStore();
    this.rollback = new RollbackManager({ store: this.versions });
    this.abTesting = new ABTestingFramework({ store: abTests });
  }

  /** Deploy `instructions` as the agent's new current version. */
  deploy(
    target: PromptTarget,
    instructions: string,
    source: InstructionSource = 'manual'
  ): Promise<InstructionVersion> {
    return this.rollback.deployVersion(promptKey(target), instructions, source);
  }

  /** The version runs of the agent use now, if any was deployed. */
  current(target: PromptTarget): Promise<InstructionVersion | null> {
    return this.rollback.getCurrentVersion(promptKey(target));
  }

  /** Versions of the agent, newest first. */
  history(target: PromptTarget, limit?: number): Promise<InstructionVersion[]> {
    return this.rollback.getVersionHistory(promptKey(target), limit);
  }

  /** Make an earlier version current again (as a new version), or the previous one. */
  rollbackTo(target: PromptTarget, versionId?: string): Promise<RollbackResult> {
    const key = promptKey(target);
    return versionId
      ? this.rollback.rollbackTo(key, versionId)
      : this.rollback.rollbackToPrevious(key);
  }

  /**
   * Test `treatment` against the current instructions: each thread gets one
   * of them until the test completes.
   */
  async startABTest(target: PromptTarget, options: StartABTestOptions): Promise<ABTest> {
    const key = promptKey(target);
    const control =
      (await this.current(key))?.instructions ??
      (typeof target === 'string' ? undefined : target.instructions);
    if (control === undefined) {
      throw new CogitatorError({
        message: `No current instructions for "${key}" to test against`,
        code: ErrorCode.VALIDATION_ERROR,
      });
    }
    const test = await this.abTesting.createTest({
      agentId: key,
      name: options.name,
      ...(options.description && { description: options.description }),
      controlInstructions: control,
      treatmentInstructions: options.treatment,
      ...(options.treatmentAllocation !== undefined && {
        treatmentAllocation: options.treatmentAllocation,
      }),
      ...(options.minSampleSize !== undefined && { minSampleSize: options.minSampleSize }),
      ...(options.maxDuration !== undefined && { maxDuration: options.maxDuration }),
      ...(options.confidenceLevel !== undefined && { confidenceLevel: options.confidenceLevel }),
    });
    return this.abTesting.startTest(test.id);
  }

  /** The running A/B test of the agent, if any. */
  activeABTest(target: PromptTarget): Promise<ABTest | null> {
    return this.abTesting.getActiveTest(promptKey(target));
  }

  /** Complete a test now; deploys the winner when `autoDeployWinner` is on. */
  async completeABTest(testId: string): Promise<ABTestOutcome> {
    const { test, outcome } = await this.abTesting.completeTest(testId);
    await this.deployWinner(test, outcome);
    return outcome;
  }

  /**
   * The instructions a run of `agent` in `threadId` uses: the running A/B
   * test's variant for that thread, else the current version, else the
   * agent's own.
   */
  async resolve(agent: Agent, threadId: string): Promise<PromptResolution> {
    const key = promptKey(agent);
    const test = await this.abTesting.getActiveTest(key);
    if (test) {
      const variant = stickyVariant(test, threadId);
      return {
        instructions: this.abTesting.getInstructionsForVariant(test, variant),
        prompt: { key, abTest: { id: test.id, variant } },
      };
    }
    const version = await this.rollback.getCurrentVersion(key);
    return version
      ? {
          instructions: version.instructions,
          prompt: { key, versionId: version.id, version: version.version },
        }
      : { instructions: agent.instructions, prompt: { key } };
  }

  /** Record how a run went against the version or A/B variant it used. */
  async record(
    prompt: RunPrompt,
    outcome: { result?: RunResult; durationMs: number }
  ): Promise<void> {
    const { result, durationMs } = outcome;
    const score = result ? await (this.config.score?.(result) ?? 1) : 0;
    const cost = result?.usage.cost ?? 0;

    if (prompt.abTest) {
      await this.abTesting.recordResult(
        prompt.abTest.id,
        prompt.abTest.variant,
        score,
        durationMs,
        cost
      );
      const finished = await this.abTesting.checkAndCompleteIfReady(prompt.abTest.id);
      if (finished) {
        const test = await this.abTesting.getTest(prompt.abTest.id);
        if (test) await this.deployWinner(test, finished);
      }
    }
    if (prompt.versionId) {
      await this.rollback.recordMetrics(prompt.key, score, durationMs, cost, result !== undefined);
    }
  }

  private async deployWinner(test: ABTest, outcome: ABTestOutcome): Promise<void> {
    if (!this.config.autoDeployWinner || outcome.winner !== 'treatment') return;
    await this.rollback.deployVersion(test.agentId, test.treatmentInstructions, 'ab_test', test.id);
    getLogger().info('Deployed the winning instructions of an A/B test', {
      agent: test.agentId,
      test: test.id,
    });
  }
}

/** The key an agent's instructions are versioned under. */
export function promptKey(target: PromptTarget): string {
  return typeof target === 'string' ? target : (target.config.id ?? target.name);
}

/** The same variant for every run of a thread, spread by the test's allocation. */
function stickyVariant(test: ABTest, threadId: string): 'control' | 'treatment' {
  let hash = 2166136261;
  for (const char of `${test.id}:${threadId}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296 < test.treatmentAllocation ? 'treatment' : 'control';
}
