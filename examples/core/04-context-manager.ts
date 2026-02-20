import { header, section } from '../_shared/setup.js';
import { ContextManager } from '@cogitator-ai/core';
import type { Message } from '@cogitator-ai/types';

function generateConversation(turns: number, avgLength = 200): Message[] {
  const topics = [
    'machine learning algorithms and neural network architectures',
    'distributed systems design and microservice patterns',
    'quantum computing principles and qubit manipulation',
    'natural language processing and transformer models',
    'database optimization and query planning strategies',
    'cryptographic protocols and zero-knowledge proofs',
    'compiler design and abstract syntax tree transformations',
    'operating system kernel internals and memory management',
  ];

  const messages: Message[] = [
    {
      role: 'system',
      content: 'You are a senior software engineer with deep expertise in CS fundamentals.',
    },
  ];

  for (let i = 0; i < turns; i++) {
    const topic = topics[i % topics.length];
    const padding = 'x'.repeat(avgLength);

    messages.push({
      role: 'user',
      content: `Turn ${i + 1}: Tell me about ${topic}. ${padding}`,
    });
    messages.push({
      role: 'assistant',
      content: `Turn ${i + 1}: Here's what I know about ${topic}. ${padding} In summary, this is a deep topic with many nuances worth exploring further.`,
    });
  }

  return messages;
}

function printState(label: string, state: ReturnType<ContextManager['checkState']>) {
  console.log(`  ${label}:`);
  console.log(
    `    Tokens:       ${state.currentTokens.toLocaleString()} / ${state.maxTokens.toLocaleString()}`
  );
  console.log(`    Available:    ${state.availableTokens.toLocaleString()}`);
  console.log(`    Utilization:  ${state.utilizationPercent.toFixed(1)}%`);
  console.log(`    Needs compression: ${state.needsCompression}`);
}

const MODEL = 'openai:gpt-4';

async function main() {
  header('04 — Context Manager');

  section('1. Checking context state');
  const manager = new ContextManager({
    strategy: 'truncate',
    compressionThreshold: 0.8,
    outputReserve: 0.15,
  });

  const small = generateConversation(5, 50);
  const large = generateConversation(100, 300);

  printState('Small conversation (5 turns)', manager.checkState(small, MODEL));
  console.log();
  printState('Large conversation (100 turns)', manager.checkState(large, MODEL));

  section('2. Truncate strategy');
  const truncateManager = new ContextManager({
    strategy: 'truncate',
    compressionThreshold: 0.3,
    outputReserve: 0.15,
  });

  const conversation = generateConversation(80, 200);
  const beforeState = truncateManager.checkState(conversation, MODEL);

  console.log(`  Before compression:`);
  console.log(`    Messages: ${conversation.length}`);
  console.log(`    Tokens:   ${beforeState.currentTokens.toLocaleString()}`);

  const truncateResult = await truncateManager.compress(conversation, MODEL);

  const afterState = truncateManager.checkState(truncateResult.messages, MODEL);
  console.log(`\n  After truncation:`);
  console.log(`    Messages: ${truncateResult.messages.length}`);
  console.log(`    Tokens:   ${afterState.currentTokens.toLocaleString()}`);
  console.log(`    Removed:  ${conversation.length - truncateResult.messages.length} messages`);
  console.log(
    `    Savings:  ${((1 - truncateResult.compressedTokens / truncateResult.originalTokens) * 100).toFixed(1)}%`
  );

  const systemKept = truncateResult.messages.filter((m) => m.role === 'system');
  console.log(`    System messages preserved: ${systemKept.length}`);

  const lastOriginal = conversation[conversation.length - 1];
  const lastCompressed = truncateResult.messages[truncateResult.messages.length - 1];
  console.log(
    `    Most recent message preserved: ${lastOriginal.content === lastCompressed.content}`
  );

  section('3. Sliding-window strategy');
  const slidingManager = new ContextManager({
    strategy: 'sliding-window',
    compressionThreshold: 0.3,
    outputReserve: 0.15,
    windowSize: 10,
    windowOverlap: 2,
  });

  const longConversation = generateConversation(80, 200);
  const slidingBefore = slidingManager.checkState(longConversation, MODEL);

  console.log(`  Before compression:`);
  console.log(`    Messages: ${longConversation.length}`);
  console.log(`    Tokens:   ${slidingBefore.currentTokens.toLocaleString()}`);

  const slidingResult = await slidingManager.compress(longConversation, MODEL);

  console.log(`\n  After sliding-window:`);
  console.log(`    Messages: ${slidingResult.messages.length}`);
  console.log(`    Tokens:   ${slidingResult.compressedTokens.toLocaleString()}`);
  console.log(`    Summarized: ${slidingResult.summarized ?? 0} older messages`);
  console.log(
    `    Savings: ${((1 - slidingResult.compressedTokens / slidingResult.originalTokens) * 100).toFixed(1)}%`
  );

  const summaryMsg = slidingResult.messages.find(
    (m) => m.role === 'system' && String(m.content).includes('[Previous conversation')
  );
  if (summaryMsg) {
    const preview = String(summaryMsg.content).slice(0, 120);
    console.log(`\n  Summary message preview:`);
    console.log(`    "${preview}..."`);
  }

  section('4. Comparing strategies on the same input');
  const testConversation = generateConversation(80, 200);
  const strategies = ['truncate', 'sliding-window'] as const;

  console.log(`  Input: ${testConversation.length} messages\n`);

  for (const strategy of strategies) {
    const mgr = new ContextManager({
      strategy,
      compressionThreshold: 0.3,
      outputReserve: 0.15,
      windowSize: 10,
    });

    const result = await mgr.compress(testConversation, MODEL);
    const savings = ((1 - result.compressedTokens / result.originalTokens) * 100).toFixed(1);

    console.log(`  ${strategy}:`);
    console.log(`    Messages: ${testConversation.length} → ${result.messages.length}`);
    console.log(
      `    Tokens:   ${result.originalTokens.toLocaleString()} → ${result.compressedTokens.toLocaleString()}`
    );
    console.log(`    Savings:  ${savings}%`);
    console.log();
  }

  section('5. Model context limits');
  const models = [
    'openai:gpt-4',
    'openai:gpt-4o',
    'anthropic:claude-3-opus',
    'google:gemini-pro',
    'ollama:llama3',
  ];

  for (const model of models) {
    const limit = manager.getModelContextLimit(model);
    console.log(`  ${model.padEnd(28)} ${limit.toLocaleString()} tokens`);
  }

  console.log('\nDone.');
}

main();
