import { createCogitator, DEFAULT_MODEL, header, section } from '../_shared/setup.js';
import { Agent } from '@cogitator-ai/core';
import { swarm } from '@cogitator-ai/swarms';
import type { TeamEventMap } from '@cogitator-ai/types';

async function main() {
  header('05 - Agent Team');

  const cog = createCogitator();

  const editor = new Agent({
    name: 'editor',
    model: DEFAULT_MODEL,
    instructions: `You are the editor of a small newsroom. Plan the work as tasks on the shared task list:
one task per piece of work, with dependsOn where a task needs the result of another. Assign each task
to the member who fits it best. When the team is done, write the final piece from their results.`,
    temperature: 0.3,
    maxIterations: 10,
  });

  const researcher = new Agent({
    name: 'researcher',
    model: DEFAULT_MODEL,
    description: 'Finds facts and figures',
    instructions: `You research facts. Do your task in a few sentences with concrete facts, then complete it
with update_task and your findings as the result.`,
    temperature: 0.3,
    maxIterations: 5,
  });

  const writer = new Agent({
    name: 'writer',
    model: DEFAULT_MODEL,
    description: 'Writes clear, short prose',
    instructions: `You write. Build on the results of the tasks your task depends on, write the text, then
complete the task with update_task and the text as the result. Ask the researcher with send_message
when a fact is missing.`,
    temperature: 0.5,
    maxIterations: 5,
  });

  const checker = new Agent({
    name: 'checker',
    model: DEFAULT_MODEL,
    description: 'Checks facts in a draft',
    instructions: `You check the facts of a draft. List what is wrong or unsupported, or confirm it is right,
then complete your task with update_task and your verdict as the result.`,
    temperature: 0.2,
    maxIterations: 5,
  });

  const newsroom = swarm('newsroom')
    .strategy('team')
    .lead(editor)
    .members([researcher, writer, checker])
    .team({ maxTurnsPerMember: 4, maxLeadTurns: 4, maxConcurrentMembers: 2 })
    .build(cog);

  section('Live events');

  newsroom.on('team:task-created', (event) => {
    const { task } = event.data as TeamEventMap['team:task-created'];
    const waits = task.dependsOn.length > 0 ? `, after ${task.dependsOn.join(', ')}` : '';
    console.log(`  [task] ${task.id}: ${task.title}${waits}`);
  });
  newsroom.on('team:task-claimed', (event) => {
    const { task, member } = event.data as TeamEventMap['team:task-claimed'];
    console.log(`  [claim] ${member} works on ${task.id}`);
  });
  newsroom.on('team:task-completed', (event) => {
    const { task, unblocked } = event.data as TeamEventMap['team:task-completed'];
    const next = unblocked.length > 0 ? `, unblocks ${unblocked.join(', ')}` : '';
    console.log(`  [done] ${task.id} by ${task.owner}${next}`);
  });
  newsroom.on('team:message-sent', (event) => {
    const { from, to, content } = event.data as TeamEventMap['team:message-sent'];
    console.log(`  [message] ${from} -> ${to.join(', ')}: ${content.slice(0, 80)}`);
  });

  section('Running: a short article about tides');

  const result = await newsroom.run({
    input:
      'Write a short, accurate article (about 150 words) explaining why there are two tides a day.',
    saveHistory: false,
    timeout: 300_000,
  });

  section('Task list');

  for (const task of result.teamResult?.tasks ?? []) {
    console.log(`  ${task.id} [${task.status}] ${task.title} (${task.owner ?? 'unassigned'})`);
  }
  console.log(`  Stop reason: ${result.teamResult?.stopReason}`);
  console.log(
    `  Turns: lead ${result.teamResult?.leadTurns}, members ${result.teamResult?.memberTurns}`
  );

  section('Article');

  console.log(String(result.output));

  await cog.close();
  console.log('\nDone.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
