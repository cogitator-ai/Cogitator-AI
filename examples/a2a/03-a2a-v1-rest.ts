import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import {
  A2AClient,
  A2AServer,
  artifactText,
  type V1AgentCard,
  type V1ListTasksResponse,
  type V1Task,
} from '@cogitator-ai/a2a';
import { a2aExpress } from '@cogitator-ai/a2a/express';
import { Agent } from '@cogitator-ai/core';
import express from 'express';

const PORT = 3101;
const BASE_URL = `http://localhost:${PORT}`;

const translator = new Agent({
  name: 'translator',
  description: 'Translates short texts into French.',
  model: DEFAULT_MODEL,
  instructions: 'Translate the text you get into French. Answer with the translation only.',
  temperature: 0.2,
  maxIterations: 2,
});

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const a2aServer = new A2AServer({
  agents: { translator },
  cogitator: createCogitator(),
  cardSigning: { alg: 'ES256', privateKey, kid: 'example-key', publishJwks: true },
});

async function main() {
  const app = express();
  app.use(a2aExpress(a2aServer));
  const httpServer = app.listen(PORT);

  try {
    header('A2A 1.0 over HTTP+JSON');

    section('1. The A2A 1.0 Agent Card');
    const card = (await (
      await fetch(`${BASE_URL}/.well-known/agent-card.json`, { headers: { 'A2A-Version': '1.0' } })
    ).json()) as V1AgentCard;
    console.log('Interfaces:', JSON.stringify(card.supportedInterfaces, null, 2));

    section('2. SendMessage on the REST binding, with the agent as tenant');
    const sent = await fetch(`${BASE_URL}/a2a/rest/translator/message:send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/a2a+json', 'A2A-Version': '1.0' },
      body: JSON.stringify({
        message: {
          messageId: randomUUID(),
          role: 'ROLE_USER',
          parts: [{ text: 'The library opens at nine.' }],
        },
      }),
    });
    const { task } = (await sent.json()) as { task: V1Task };
    console.log('State:', task.status.state);
    const text = task.artifacts?.[0]?.parts.map((part) => ('text' in part ? part.text : ''));
    console.log('Translation:', text?.join(''));

    section('3. ListTasks with a cursor');
    const listed = await fetch(`${BASE_URL}/a2a/rest/translator/tasks?pageSize=5`, {
      headers: { 'A2A-Version': '1.0' },
    });
    const page = (await listed.json()) as V1ListTasksResponse;
    console.log('Tasks on this page:', page.tasks.length, 'of', page.totalSize);
    console.log('Next page token:', JSON.stringify(page.nextPageToken));

    section('4. A2AClient over HTTP+JSON');
    const client = new A2AClient(BASE_URL, { transport: 'HTTP+JSON' });
    console.log('Endpoint:', await client.endpoint());
    console.log(
      'Signed card verifies:',
      await client.verifyAgentCard({ keys: { 'example-key': publicKey } })
    );
    const result = await client.sendMessage({
      role: 'user',
      parts: [{ kind: 'text', text: 'Good morning, see you tomorrow.' }],
    });
    if (result.kind === 'task') {
      console.log('Translation:', result.artifacts?.map(artifactText).join(''));
    }

    section('5. Streaming');
    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ kind: 'text', text: 'The train is late again.' }],
    })) {
      if (event.kind === 'artifact-update') process.stdout.write(artifactText(event.artifact));
      if (event.kind === 'status-update' && event.final) console.log(`\n(${event.status.state})`);
    }
  } finally {
    httpServer.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
