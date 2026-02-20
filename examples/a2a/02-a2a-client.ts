import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { A2AClient } from '@cogitator-ai/a2a';
import { Agent } from '@cogitator-ai/core';

const SERVER_URL = 'http://localhost:3100';

async function main() {
  header('A2A Client');
  const client = new A2AClient(SERVER_URL);

  section('1. Discover remote agent');
  const card = await client.agentCard();
  console.log('Name:', card.name);
  console.log('Description:', card.description);
  console.log('Skills:', card.skills.length);
  console.log('Streaming:', card.capabilities.streaming);

  section('2. Send a message');
  const task = await client.sendMessage({
    role: 'user',
    parts: [
      {
        type: 'text',
        text: 'Rewrite this sentence to be more concise: "In my personal opinion, I think that the weather is very extremely cold today."',
      },
    ],
  });
  console.log('Task ID:', task.id);
  console.log('Status:', task.status.state);
  if (task.artifacts.length > 0) {
    const text = task.artifacts[0].parts.find((p) => p.type === 'text');
    if (text?.type === 'text') console.log('Response:', text.text);
  }

  section('3. Get task by ID');
  const fetched = await client.getTask(task.id);
  console.log('Fetched status:', fetched.status.state);
  console.log('History length:', fetched.history.length);

  section('4. List all tasks');
  const tasks = await client.listTasks();
  console.log(`Total tasks: ${tasks.length}`);
  for (const t of tasks) {
    console.log(`  ${t.id} — ${t.status.state}`);
  }

  section('5. Bridge as local tool');
  const remoteTool = client.asTool({
    name: 'writing_assistant',
    description: 'Remote writing assistant accessible via A2A protocol',
  });

  const orchestrator = new Agent({
    name: 'orchestrator',
    model: DEFAULT_MODEL,
    instructions:
      'You delegate writing tasks to the writing_assistant tool. Forward the user request as-is.',
    tools: [remoteTool],
    maxIterations: 3,
  });

  const cog = createCogitator();
  const result = await cog.run(orchestrator, {
    input: 'Fix the grammar: "Me and him goes to the store yesterday for buy some foods."',
  });
  console.log('Orchestrator output:', result.output);
  console.log('Tool calls:', result.toolCalls.map((tc) => tc.name).join(', '));

  await cog.close();
  console.log('\nDone.');
}

main();
