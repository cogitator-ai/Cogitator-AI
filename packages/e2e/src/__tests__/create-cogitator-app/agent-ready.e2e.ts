import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCPClient } from '@cogitator-ai/mcp';
import { scaffold } from 'create-cogitator-app';
import {
  cogitatorDependencies,
  installArgs,
  mustExec,
  packWorkspace,
  useTarballs,
} from '../../helpers/scaffold-harness';

const root = mkdtempSync(join(tmpdir(), 'cca-agent-ready-'));
const dir = join(root, 'agent-ready');
let client: MCPClient | undefined;

beforeAll(async () => {
  await scaffold(
    {
      name: 'agent-ready',
      preset: 'workflow',
      app: 'script',
      memory: 'none',
      features: ['workflows'],
      provider: 'openai',
      model: 'gpt-6.1-sol',
      packageManager: 'pnpm',
      codingAgents: ['claude', 'cursor', 'codex'],
    },
    { directory: dir, install: false, git: false }
  );
  useTarballs(dir, 'pnpm', await packWorkspace(cogitatorDependencies(dir)));
  await mustExec('pnpm', installArgs('pnpm'), { cwd: dir });

  const config = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8')) as {
    mcpServers: { cogitator: { command: string; args: string[] } };
  };
  client = await MCPClient.connect({
    transport: 'stdio',
    command: config.mcpServers.cogitator.command,
    args: config.mcpServers.cogitator.args,
    cwd: join(dir, 'src'),
    timeout: 60_000,
  });
}, 600_000);

afterAll(async () => {
  await client?.close();
  rmSync(root, { recursive: true, force: true });
});

function mcp(): MCPClient {
  if (!client) throw new Error('the MCP server did not start');
  return client;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

describe('agent-ready project', () => {
  it('installs the docs of its Cogitator version with @cogitator-ai/core', () => {
    const docs = join(dir, 'node_modules/@cogitator-ai/core/docs');
    const version = (
      JSON.parse(
        readFileSync(join(dir, 'node_modules/@cogitator-ai/core/package.json'), 'utf-8')
      ) as {
        version: string;
      }
    ).version;
    expect(readFileSync(join(docs, 'index.md'), 'utf-8')).toContain(
      `# Cogitator ${version} documentation`
    );
    expect(existsSync(join(docs, 'core/agents.md'))).toBe(true);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).toContain(
      'node_modules/@cogitator-ai/core/docs/'
    );
  });

  it('starts the cogitator MCP server from .mcp.json with the four tools', async () => {
    const tools = await mcp().listToolDefinitions();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'check_project',
      'inspect_project',
      'read_doc',
      'search_docs',
    ]);
  });

  it('answers doc searches from the installed docs', async () => {
    const hits = text(
      await mcp().callTool('search_docs', { query: 'tool approval requiresApproval' })
    );
    expect(hits).toMatch(/read_doc "tools\/approvals\.md/);
    const page = text(await mcp().callTool('read_doc', { path: 'core/agents.md' }));
    expect(page).toMatch(/^# Agents/);
  });

  it('describes the registry of the project, found from a subdirectory', async () => {
    const project = JSON.parse(text(await mcp().callTool('inspect_project', {}))) as {
      scaffold: { spec: { codingAgents: string[] } };
      agents: Array<{ key: string; tools: Array<{ name: string }> }>;
      workflows: Array<{ key: string; nodes: string[] }>;
    };
    expect(project.scaffold.spec.codingAgents).toEqual(['claude', 'cursor', 'codex']);
    const assistant = project.agents.find((agent) => agent.key === 'assistant');
    expect(assistant?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['fetch_url', 'calculator', 'current_time'])
    );
    expect(project.workflows.map((workflow) => workflow.key)).toEqual(['report']);
  });

  it('runs cogitator doctor offline', async () => {
    const report = JSON.parse(text(await mcp().callTool('check_project', {}))) as {
      checks: Array<{ label: string }>;
    };
    expect(report.checks.length).toBeGreaterThan(0);
  });
});
