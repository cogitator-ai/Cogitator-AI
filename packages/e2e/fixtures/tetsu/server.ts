import { createApp, group } from '@tetsujs/core';
import { cogitatorController } from '@cogitator-ai/tetsu';
import {
  createCalculatorAgent,
  createChatAgent,
  createFailingWorkflow,
  createOfflineCogitator,
  createPipelineWorkflow,
  resolveTestLLM,
} from '../../src/helpers/server-adapter-fixtures';

const TOKEN = 'e2e-token';

const llm = await resolveTestLLM();
const cogitator = llm ? llm.createCogitator() : createOfflineCogitator();
const model = llm?.model ?? 'ollama/unused';

const app = createApp({
  routes: group('/api', {
    children: [
      cogitatorController({
        cogitator,
        agents: { chat: createChatAgent(model), calculator: createCalculatorAgent(model) },
        workflows: { pipeline: createPipelineWorkflow(), failing: createFailingWorkflow() },
        auth: (ctx) => {
          const header = ctx.req.headers.get('authorization');
          const query = new URL(ctx.req.url).searchParams.get('token');
          return header === `Bearer ${TOKEN}` || query === TOKEN ? { userId: 'e2e' } : undefined;
        },
        authorizeThread: (auth, threadId) => threadId.startsWith(`${auth?.userId}-`),
        websocket: true,
      }),
    ],
  }),
  reportError: () => undefined,
});

const server = Bun.serve({ ...app, port: 0, hostname: '127.0.0.1' });

const stop = async () => {
  await server.stop(true);
  await cogitator.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

console.log(JSON.stringify({ port: server.port, provider: llm?.provider ?? null, model }));
