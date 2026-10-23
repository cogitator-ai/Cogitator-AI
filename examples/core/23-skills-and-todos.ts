import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { header, section } from '../_shared/setup.js';
import {
  Agent,
  Cogitator,
  SkillRegistry,
  availableSkillsSection,
  rankTools,
  renderTodos,
  tool,
} from '@cogitator-ai/core';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:0.5b';
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'skills');

async function ollamaIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

const publishNotes = tool({
  name: 'publishReleaseNotes',
  description: 'Publish the release notes of a version to the changelog site',
  parameters: z.object({
    version: z.string().describe('The version being released'),
    notes: z.string().describe('The release notes, in Markdown'),
  }),
  deferred: true,
  execute: async ({ version }) => ({
    published: true,
    url: `https://example.com/changelog/${version}`,
  }),
});

const otherTools = ['billing_refund', 'inventory_count', 'hr_vacation_days'].map((name) =>
  tool({
    name,
    description: `The ${name.replace('_', ' ')} tool`,
    parameters: z.object({}),
    deferred: true,
    execute: async () => 'done',
  })
);

async function main() {
  header('23 - Skills from SKILL.md, write_todos and tool_search');

  section('Finding the skills of a folder');
  const registry = new SkillRegistry({ dirs: [SKILLS_DIR] });
  const catalog = await registry.discover();
  for (const skill of catalog.skills) {
    console.log(`  ${skill.name}: ${skill.description}`);
    console.log(
      `    metadata ${JSON.stringify(skill.metadata)}, files ${(await catalog.files(skill.name)).join(', ')}`
    );
  }
  console.log(`  diagnostics: ${catalog.diagnostics.length}`);
  console.log('\n  What the system prompt gets:');
  console.log(availableSkillsSection(catalog.skills).replace(/^/gm, '    '));

  section('Ranking deferred tools for a search');
  for (const query of ['publish release notes', 'refund a customer']) {
    const found = rankTools([publishNotes, ...otherTools], query, 2).map((t) => t.name);
    console.log(`  "${query}" -> ${found.join(', ')}`);
  }

  if (!(await ollamaIsUp())) {
    console.error(`\n  Ollama is not answering at ${OLLAMA_URL}, skipping the agent part.`);
    console.error(`  Start it with \`ollama serve\` and pull the model: ollama pull ${MODEL}\n`);
    return;
  }

  const cog = new Cogitator({
    llm: { providers: { ollama: { baseUrl: OLLAMA_URL } } },
    memory: { adapter: 'memory' },
  });
  const agent = new Agent({
    name: 'release-manager',
    model: `ollama/${MODEL}`,
    instructions: 'You prepare releases. Activate the matching skill before you work on a task.',
    tools: [publishNotes, ...otherTools],
    skills: [registry],
    todos: true,
    maxIterations: 3,
  });
  const log = {
    onToolCall: (call: { name: string; arguments: unknown }) =>
      console.log(`  ${call.name} ${JSON.stringify(call.arguments)}`),
  };

  section('The agent activates a skill');
  const activated = await cog.run(agent, {
    input: 'Activate the release-notes skill with use_skill, then write release notes for 2.1.0.',
    threadId: 'release-2.1.0',
    toolChoice: { type: 'function', function: { name: 'use_skill' } },
    ...log,
  });
  const used = activated.toolCalls.some((call) => call.name === 'use_skill');
  console.log(
    used
      ? `  answer: ${activated.output.trim().slice(0, 300)}`
      : `  ${MODEL} did not activate the skill this time, run the example again`
  );

  section('The agent plans with write_todos');
  const planned = await cog.run(agent, {
    input:
      'Call write_todos with {"todos": [{"id": "notes", "content": "Write the release notes", "status": "in_progress"}, {"id": "publish", "content": "Publish them", "status": "pending"}]}.',
    threadId: 'release-2.1.0',
    toolChoice: { type: 'function', function: { name: 'write_todos' } },
    ...log,
  });
  console.log(
    planned.todos
      ? renderTodos(planned.todos).replace(/^/gm, '  ')
      : `  ${MODEL} wrote no list this time, run the example again`
  );

  section('The agent finds a deferred tool');
  const searched = await cog.run(agent, {
    input: 'Call tool_search with {"query": "publish release notes"}.',
    threadId: 'release-2.1.0',
    toolChoice: { type: 'function', function: { name: 'tool_search' } },
    ...log,
  });
  const loaded = searched.toolCalls.some((call) => call.name === 'tool_search');
  console.log(
    loaded
      ? '  the tools it found are sent from the next turn on'
      : `  ${MODEL} did not search this time, run the example again`
  );

  const memory = await cog.getMemory();
  const thread = await memory?.getThread('release-2.1.0');
  console.log(
    `  todos kept in the thread: ${JSON.stringify(thread?.success ? thread.data?.metadata.todos : undefined)}`
  );

  await cog.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
