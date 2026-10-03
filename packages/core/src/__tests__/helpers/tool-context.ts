import type { ToolContext } from '@cogitator-ai/types';

export function createToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agentId: 'test-agent',
    runId: 'test-run',
    signal: new AbortController().signal,
    ...overrides,
  };
}
