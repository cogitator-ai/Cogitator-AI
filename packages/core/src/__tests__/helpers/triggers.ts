import { MockLLMBackend } from '@cogitator-ai/test-utils';
import type {
  ChatRequest,
  CogitatorConfig,
  RoutineDefinition,
  TriggerHttpRequest,
  TriggersConfig,
} from '@cogitator-ai/types';
import { Cogitator } from '../../cogitator';
import { Agent } from '../../agent';
import type { experimental_TriggerManager } from '../../triggers/manager';

const runtimes: Cogitator[] = [];

/** Closes the runtimes the tests made, for `afterEach` */
export async function closeRuntimes(): Promise<void> {
  for (const cog of runtimes.splice(0)) await cog.close();
}

/** Keeps a runtime a test made itself, for {@link closeRuntimes} */
export function keepRuntime(cog: Cogitator): Cogitator {
  runtimes.push(cog);
  return cog;
}

export function worker(): Agent {
  return new Agent({ name: 'worker', model: 'mock/m', instructions: 'You work.' });
}

/** A runtime on a mock backend with `experimental_triggers`, the agent `worker` among its agents */
export function runtime(
  triggers: Omit<TriggersConfig, 'agents'> & { agents?: TriggersConfig['agents'] },
  backend = new MockLLMBackend().setResponses([{ content: 'done' }]),
  config: Partial<CogitatorConfig> = {}
): { cog: Cogitator; manager: experimental_TriggerManager; backend: MockLLMBackend } {
  const cog = keepRuntime(
    new Cogitator({
      llm: { backends: { mock: backend }, retry: false },
      memory: { adapter: 'memory' },
      ...config,
      experimental_triggers: { agents: { worker: worker() }, pollInterval: 20, ...triggers },
    })
  );
  return { cog, manager: cog.experimental_triggers!, backend };
}

export function routine(extra: Partial<RoutineDefinition> = {}): RoutineDefinition {
  return {
    id: 'digest',
    prompt: 'Summarize what came in.',
    target: { agent: 'worker' },
    ...extra,
  };
}

export function request(body: unknown, headers: Record<string, string> = {}): TriggerHttpRequest {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, rawBody };
}

export function lastUserText(call: ChatRequest | undefined): string {
  const users = (call?.messages ?? []).filter((message) => message.role === 'user');
  const last = users[users.length - 1];
  return typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
}
