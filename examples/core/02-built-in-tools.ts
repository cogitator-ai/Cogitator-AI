import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent, calculator, datetime, fileRead, fileList, regexMatch } from '@cogitator-ai/core';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP_DIR = join(import.meta.dirname, '.tmp-02');

function setupTestFiles() {
  mkdirSync(TMP_DIR, { recursive: true });

  writeFileSync(
    join(TMP_DIR, 'sales-q4.csv'),
    [
      'date,product,quantity,price',
      '2025-10-01,Widget A,150,29.99',
      '2025-10-15,Widget B,80,49.99',
      '2025-11-01,Widget A,200,29.99',
      '2025-11-20,Widget C,45,99.99',
      '2025-12-05,Widget B,120,49.99',
      '2025-12-18,Widget A,300,29.99',
    ].join('\n')
  );

  writeFileSync(
    join(TMP_DIR, 'config.json'),
    JSON.stringify({ version: '2.1.0', region: 'us-east-1', debug: false }, null, 2)
  );
}

function cleanup() {
  rmSync(TMP_DIR, { recursive: true, force: true });
}

async function main() {
  header('02 — Built-in Tools');
  setupTestFiles();

  const cog = createCogitator();

  const agent = new Agent({
    name: 'analyst',
    model: DEFAULT_MODEL,
    instructions: `You are a data analyst assistant with access to filesystem, calculator, datetime, and regex tools.
When asked to analyze files, read them first, then use calculator for math and regex for pattern extraction.
Be precise with numbers. Show your work briefly.`,
    tools: [calculator, datetime, fileRead, fileList, regexMatch],
    temperature: 0.2,
    maxIterations: 15,
  });

  section('1. File listing + reading');
  const result1 = await cog.run(agent, {
    input: `List the files in ${TMP_DIR}, then read the sales-q4.csv file and summarize what's in it.`,
  });
  console.log('Output:', result1.output);
  console.log('Tools used:', result1.toolCalls.map((tc) => tc.name).join(', '));

  section('2. Calculations on file data');
  const result2 = await cog.run(agent, {
    input: `Read ${join(TMP_DIR, 'sales-q4.csv')} and calculate:
1. Total revenue for Widget A (quantity * price for each row, then sum)
2. Average quantity sold per transaction across all products
Round results to 2 decimal places.`,
  });
  console.log('Output:', result2.output);

  section('3. Regex pattern matching');
  const result3 = await cog.run(agent, {
    input: `Read ${join(TMP_DIR, 'sales-q4.csv')} and use regex to find all dates from November (2025-11-xx). How many November transactions were there?`,
  });
  console.log('Output:', result3.output);

  section('4. Current time');
  const result4 = await cog.run(agent, {
    input:
      'What is the current date and time? Also show it in the Europe/London and Asia/Tokyo timezones.',
  });
  console.log('Output:', result4.output);

  section('Summary');
  const allCalls = [result1, result2, result3, result4].flatMap((r) => r.toolCalls);
  const toolUsage = allCalls.reduce<Record<string, number>>((acc, tc) => {
    acc[tc.name] = (acc[tc.name] ?? 0) + 1;
    return acc;
  }, {});
  console.log('Tool usage across all runs:');
  for (const [name, count] of Object.entries(toolUsage).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}: ${count} calls`);
  }

  cleanup();
  await cog.close();
  console.log('\nDone.');
}

main();
