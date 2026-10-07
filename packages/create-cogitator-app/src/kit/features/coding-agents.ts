import { code } from '../code.js';
import { execCommand, runScript } from '../package-manager.js';
import type { ProjectBuilder } from '../project.js';
import { hasFeature, type CodingAgent, type PackageManager } from '../spec.js';
import type { FeatureModule } from './types.js';

const CLI_BIN = 'node_modules/@cogitator-ai/cli/dist/index.js';

/** The command that starts `cogitator mcp` from the project directory. */
export function mcpLaunch(pm: PackageManager): { command: string; args: string[] } {
  switch (pm) {
    case 'npm':
      return { command: 'npx', args: ['--no', 'cogitator', 'mcp'] };
    case 'pnpm':
      return { command: 'pnpm', args: ['exec', 'cogitator', 'mcp'] };
    case 'yarn':
      return { command: 'yarn', args: ['cogitator', 'mcp'] };
    case 'bun':
      return { command: 'bunx', args: ['cogitator', 'mcp'] };
  }
}

/**
 * Cursor does not say which directory it starts a server in, so its command
 * names the project explicitly through `${workspaceFolder}`.
 */
function cursorLaunch(pm: PackageManager): { command: string; args: string[] } {
  const project = ['--project', '${workspaceFolder}'];
  if (pm === 'yarn') {
    return {
      command: 'yarn',
      args: ['--cwd', '${workspaceFolder}', 'cogitator', 'mcp', ...project],
    };
  }
  return { command: 'node', args: [`\${workspaceFolder}/${CLI_BIN}`, 'mcp', ...project] };
}

function mcpJson(launch: { command: string; args: string[] }): string {
  return (
    JSON.stringify({ mcpServers: { cogitator: { type: 'stdio', ...launch } } }, null, 2) + '\n'
  );
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexConfig(pm: PackageManager): string {
  const { command, args } = mcpLaunch(pm);
  return [
    '# Codex reads this file for trusted projects: the Cogitator docs and project tools over MCP.',
    '[mcp_servers.cogitator]',
    `command = ${tomlString(command)}`,
    `args = [${args.map(tomlString).join(', ')}]`,
    '',
  ].join('\n');
}

/** Where each coding agent looks for the MCP config and the skills of a project. */
const LOCATIONS: Record<CodingAgent, { mcp: string; skill: string; label: string }> = {
  claude: { mcp: '.mcp.json', skill: '.claude/skills/cogitator/SKILL.md', label: 'Claude Code' },
  cursor: { mcp: '.cursor/mcp.json', skill: '.cursor/skills/cogitator/SKILL.md', label: 'Cursor' },
  codex: { mcp: '.codex/config.toml', skill: '.agents/skills/cogitator/SKILL.md', label: 'Codex' },
};

function skill(project: ProjectBuilder): string {
  const { spec } = project;
  const pm = spec.packageManager;
  const kinds = (kind: 'workflows' | 'swarms') =>
    project.registry.some((entry) => entry.kind === kind);
  const recipes = [
    code`
      ### Add a tool

      Write it in \`src/tools/<name>.ts\` with \`tool()\` from \`@cogitator-ai/core\` and a Zod schema for its arguments, add it to the list in \`src/tools/index.ts\`, and test it in \`tests/tools.test.ts\` by calling \`execute\` directly. Mark a tool that changes something outside the process with \`sideEffects\`, and one a person has to allow with \`requiresApproval\`.
    `,
    code`
      ### Add an agent

      Create \`src/agents/<name>.ts\` exporting a \`new Agent({ name, instructions, tools })\`, then register it in \`agents\` of \`src/cogitator.ts\`. Leave out \`model\` to use \`llm.defaultModel\` from \`cogitator.yml\`.
    `,
    kinds('workflows') &&
      code`
        ### Change a workflow

        Workflows live in \`src/workflows/\` and are built with \`WorkflowBuilder\`. Register a new one in \`workflows\` of \`src/cogitator.ts\`.
      `,
    kinds('swarms') &&
      code`
        ### Change a swarm

        Swarms are \`SwarmConfig\` objects in \`src/swarms/\`, registered in \`swarms\` of \`src/cogitator.ts\`.
      `,
    code`
      ### Grow the project

      \`${execCommand(pm, 'cogitator add')} <feature>\` adds what create-cogitator-app can generate (rag, mcp, workflows, swarms, evals, otel and more, \`--memory\`, \`--deploy\`) with the same code a new project would get. Run it with \`--dry-run\` first: it merges into files you changed, and refuses with a diff when it cannot.
    `,
  ].filter((recipe): recipe is string => typeof recipe === 'string');

  return code`
    ---
    name: cogitator
    description: Build and change this Cogitator agent project (agents, tools, ${kinds('workflows') ? 'workflows, ' : ''}${kinds('swarms') ? 'swarms, ' : ''}memory, tests). Use it whenever a task touches Cogitator code or cogitator.yml.
    ---

    # Working on a Cogitator project

    Cogitator moves faster than model training data. Before writing Cogitator code, look the API up in the docs of the installed version: the \`cogitator\` MCP server has \`search_docs\` and \`read_doc\`, and the same pages are in \`node_modules/@cogitator-ai/core/docs/\` (start at \`index.md\`). \`inspect_project\` lists the agents, tools${kinds('workflows') ? ', workflows' : ''}${kinds('swarms') ? ', swarms' : ''} the project registers, and \`check_project\` runs \`cogitator doctor\`.

    Read \`AGENTS.md\` for how this project is put together. Everything it runs is registered in \`src/cogitator.ts\`.

    ${recipes.join('\n\n')}

    ### Before you call it done

    1. \`${runScript(pm, 'test')}\`: tests run offline, \`mockCogitator\` from \`tests/helpers.ts\` scripts the model's replies, including tool calls.
    2. \`${runScript(pm, 'typecheck')}\` and \`${runScript(pm, 'lint')}\`.
    ${hasFeature(spec, 'evals') && `3. \`${runScript(pm, 'eval')}\` when you changed instructions or tools: it scores the assistant on \`evals/\` with the real model.`}
  `;
}

/** MCP config and a skill for the coding agents the project is set up for (`--agent`). */
export const codingAgentsFeature: FeatureModule = {
  id: 'coding-agents',
  applies: (spec) => spec.codingAgents.length > 0,
  apply(project) {
    const { spec } = project;
    const pm = spec.packageManager;
    for (const agent of spec.codingAgents) {
      const location = LOCATIONS[agent];
      if (agent === 'claude') project.file(location.mcp, mcpJson(mcpLaunch(pm)));
      if (agent === 'cursor') project.file(location.mcp, mcpJson(cursorLaunch(pm)));
      if (agent === 'codex') project.file(location.mcp, codexConfig(pm));
    }

    const configured = spec.codingAgents.map((agent) => LOCATIONS[agent]);
    project.section(
      'Coding agents',
      code`
        The \`cogitator\` MCP server (\`cogitator mcp\`) gives coding agents \`search_docs\` and \`read_doc\` over the docs of the installed Cogitator, \`inspect_project\` for the registry and \`check_project\` for \`cogitator doctor\`. It is configured for ${configured.map((location) => `${location.label} in \`${location.mcp}\``).join(', ')}, next to the \`cogitator\` skill${configured.length > 1 ? 's' : ''} in ${configured.map((location) => `\`${location.skill}\``).join(', ')}.
      `
    );
  },
  /** The skill names the workflows and swarms, which the app and orchestration modules register. */
  finalize(project) {
    const content = skill(project);
    for (const agent of project.spec.codingAgents) project.file(LOCATIONS[agent].skill, content);
  },
};
