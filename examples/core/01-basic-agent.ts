import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, tool } from '@cogitator-ai/core';
import { z } from 'zod';

const dictionary: Record<string, string> = {
  ephemeral: 'Lasting for a very short time. From Greek ephemeros — lasting only a day.',
  serendipity:
    'The occurrence of events by chance in a happy way. Coined by Horace Walpole in 1754.',
  ubiquitous: 'Present, appearing, or found everywhere. From Latin ubique — everywhere.',
  sonder:
    'The realization that each passerby has a life as vivid and complex as your own. Coined by John Koenig.',
  petrichor:
    'The pleasant earthy smell after rain. From Greek petra (stone) + ichor (fluid of the gods).',
};

const lookupWord = tool({
  name: 'lookup_word',
  description: 'Look up the definition of a word in the dictionary',
  parameters: z.object({
    word: z.string().describe('The word to look up'),
  }),
  execute: async ({ word }) => {
    const key = word.toLowerCase().trim();
    const definition = dictionary[key];
    if (!definition) {
      return { found: false, word: key, suggestion: 'Try: ' + Object.keys(dictionary).join(', ') };
    }
    return { found: true, word: key, definition };
  },
});

const formatTimestamp = tool({
  name: 'format_timestamp',
  description: 'Convert a Unix timestamp (seconds) to a human-readable date string',
  parameters: z.object({
    timestamp: z.number().describe('Unix timestamp in seconds'),
    timezone: z.string().optional().describe('IANA timezone, e.g. "America/New_York"'),
  }),
  execute: async ({ timestamp, timezone }) => {
    const date = new Date(timestamp * 1000);
    const options: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
      ...(timezone ? { timeZone: timezone } : {}),
    };
    return {
      formatted: date.toLocaleString('en-US', options),
      iso: date.toISOString(),
      timestamp,
    };
  },
});

async function main() {
  header('01 — Basic Agent with Custom Tools');
  const cog = createCogitator();

  const agent = new Agent({
    name: 'lexicon',
    model: DEFAULT_MODEL,
    instructions:
      'You are a helpful language assistant. Use your tools to look up words and format dates. Be concise.',
    tools: [lookupWord, formatTimestamp],
    temperature: 0.3,
    maxIterations: 5,
  });

  section('1. Simple tool call');
  const result1 = await cog.run(agent, {
    input: 'What does "petrichor" mean?',
  });
  console.log('Output:', result1.output);
  console.log('Tool calls:', result1.toolCalls.length);

  section('2. Multiple tool calls in one turn');
  const result2 = await cog.run(agent, {
    input:
      'Define "ephemeral" and "serendipity", then tell me what date the timestamp 1700000000 corresponds to.',
  });
  console.log('Output:', result2.output);
  console.log('Tool calls:', result2.toolCalls.map((tc) => tc.name).join(', '));

  section('3. Streaming response');
  process.stdout.write('Streaming: ');
  const result3 = await cog.run(agent, {
    input: 'What does "sonder" mean? Explain in one sentence.',
    stream: true,
    onToken: (token) => process.stdout.write(token),
  });
  console.log('\n');

  section('4. Usage stats');
  console.log('Input tokens: ', result3.usage.inputTokens);
  console.log('Output tokens:', result3.usage.outputTokens);
  console.log('Total tokens: ', result3.usage.totalTokens);
  console.log('Duration:     ', result3.usage.duration, 'ms');

  section('5. Tool call details');
  for (const tc of result3.toolCalls) {
    console.log(`  ${tc.name}(${JSON.stringify(tc.arguments)})`);
  }

  await cog.close();
  console.log('\nDone.');
}

main();
