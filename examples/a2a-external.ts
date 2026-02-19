/**
 * A2A Protocol — External Agent Connection
 *
 * Demonstrates connecting to any A2A-compliant agent endpoint.
 * Shows discovery, direct messaging, and streaming.
 *
 * Run: npx tsx examples/a2a-external.ts <agent-url>
 * Example: npx tsx examples/a2a-external.ts http://localhost:3456
 */

import { A2AClient } from '@cogitator-ai/a2a';

async function main() {
  const agentUrl = process.argv[2];

  if (!agentUrl) {
    console.log('Usage: npx tsx examples/a2a-external.ts <agent-url>');
    console.log('Example: npx tsx examples/a2a-external.ts http://localhost:3456');
    process.exit(1);
  }

  const client = new A2AClient(agentUrl);

  console.log(`Connecting to ${agentUrl}...\n`);

  try {
    const card = await client.agentCard();
    console.log('Agent Card:');
    console.log(`  Name: ${card.name}`);
    console.log(`  Description: ${card.description ?? 'N/A'}`);
    console.log(`  Version: ${card.version}`);
    console.log(`  Streaming: ${card.capabilities.streaming}`);
    console.log('  Skills:');
    for (const skill of card.skills) {
      console.log(`    - ${skill.name}: ${skill.description ?? ''}`);
    }
  } catch (error) {
    console.error(`Failed to discover agent: ${error}`);
    process.exit(1);
  }

  console.log('\nSending message...\n');

  try {
    const task = await client.sendMessage({
      role: 'user',
      parts: [{ type: 'text', text: 'Hello! What can you help me with?' }],
    });

    console.log(`Task ID: ${task.id}`);
    console.log(`Status: ${task.status.state}`);

    if (task.status.state === 'completed') {
      for (const artifact of task.artifacts) {
        for (const part of artifact.parts) {
          if (part.type === 'text') {
            console.log(`\nAgent response:\n${part.text}`);
          }
        }
      }
    }
  } catch (error) {
    console.error(`Message failed: ${error}`);
  }

  console.log('\n--- Streaming ---\n');

  try {
    for await (const event of client.sendMessageStream({
      role: 'user',
      parts: [{ type: 'text', text: 'Give me 3 fun facts about space.' }],
    })) {
      if (event.type === 'status-update') {
        console.log(`[Status] ${event.status.state}`);
      } else if (event.type === 'artifact-update') {
        for (const part of event.artifact.parts) {
          if (part.type === 'text') {
            console.log(`[Artifact] ${part.text.substring(0, 100)}...`);
          }
        }
      }
    }
  } catch (error) {
    console.error(`Streaming failed: ${error}`);
  }

  console.log('\nDone!');
}

main().catch(console.error);
