import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Agent } from '@cogitator-ai/core';
import { processWorkflowJob, serializeAgent } from '@cogitator-ai/worker';
import { createTestCogitator, getTestModel } from '../../helpers/setup';

const describeOllama = process.env.TEST_OLLAMA === 'true' ? describe : describe.skip;

describeOllama('Worker: agents travel whole', () => {
  it(
    'runs a JSON schema agent node and hands its structured answer to the next node',
    { timeout: 120_000 },
    async () => {
      const cogitator = createTestCogitator();
      const Triage = z.object({ category: z.enum(['bug', 'question']) });
      const classifier = new Agent({
        name: 'classifier',
        model: `ollama/${getTestModel()}`,
        instructions: 'Classify the support ticket as a bug or a question.',
        temperature: 0,
        stopSequences: ['<END>'],
        responseFormat: { type: 'json_schema', schema: Triage },
      });

      const result = await processWorkflowJob(
        {
          type: 'workflow',
          jobId: 'e2e-transport',
          runId: 'e2e-transport',
          input: { ticket: 'The app crashes with a null pointer when I press Save.' },
          workflowConfig: {
            id: 'triage',
            name: 'Triage',
            nodes: [
              {
                id: 'classify',
                type: 'agent',
                config: {
                  agentConfig: JSON.parse(JSON.stringify(serializeAgent(classifier))),
                  prompt: 'Ticket: {{ticket}}',
                  outputKey: 'triage',
                },
              },
              {
                id: 'label',
                type: 'transform',
                config: { transform: 'template', template: 'label:{{triage.category}}' },
              },
            ],
            edges: [{ from: 'classify', to: 'label' }],
          },
        },
        { cogitator }
      );

      const triage = Triage.parse(result.output.triage);
      expect(result.output.label).toBe(`label:${triage.category}`);
      await cogitator.close();
    }
  );
});
