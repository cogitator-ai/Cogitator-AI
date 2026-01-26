import { createAgentHandler } from '@cogitator-ai/next';
import { cogitator, researchAgent } from '@/lib/cogitator';

export const POST = createAgentHandler(cogitator, researchAgent, {
  beforeRun: async (_req, input) => {
    console.log(`[Agent] Research query: ${input.input}`);
  },
  afterRun: async (result) => {
    console.log(`[Agent] Research completed. Tools used: ${result.trace?.spans.length ?? 0}`);
  },
});
