import { z } from 'zod';

/** How to launch an ACP agent: a program, its arguments and the environment it adds */
export interface AcpLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Where the official ACP registry publishes its index */
export const ACP_REGISTRY_URL =
  'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

/**
 * Well-known ACP agents by a short name, launched with `npx` at their newest version: Claude Code
 * (`claude`), Codex (`codex`) and Gemini CLI (`gemini`), as the registry lists them. Each needs
 * its own login or API key
 */
export const ACP_AGENT_PRESETS: Readonly<Record<string, AcpLaunch & { name: string }>> = {
  claude: {
    name: 'Claude Code',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
  },
  codex: {
    name: 'Codex',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
  },
  gemini: {
    name: 'Gemini CLI',
    command: 'npx',
    args: ['-y', '@google/gemini-cli', '--acp'],
  },
};

const PackageDistributionSchema = z.object({
  package: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

/** An agent of the ACP registry, the fields a launch needs */
export const AcpRegistryAgentSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  distribution: z.looseObject({
    npx: PackageDistributionSchema.optional(),
    uvx: PackageDistributionSchema.optional(),
    binary: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type AcpRegistryAgent = z.infer<typeof AcpRegistryAgentSchema>;

const RegistrySchema = z.looseObject({ agents: z.array(z.unknown()) });

/**
 * How to launch an agent of the registry: with `npx` or `uvx` at the version it pins. Agents
 * that ship only binaries are refused: download one yourself and launch it by its command
 */
export function launchOfRegistryAgent(agent: AcpRegistryAgent): AcpLaunch {
  const { npx, uvx } = agent.distribution;
  const chosen = npx
    ? { command: 'npx', spec: npx, lead: ['-y'] }
    : uvx
      ? { command: 'uvx', spec: uvx, lead: [] }
      : undefined;
  if (!chosen) {
    throw new Error(
      `The ACP agent ${agent.id} ships only binaries: download one and launch it by its command`
    );
  }
  return {
    command: chosen.command,
    args: [...chosen.lead, chosen.spec.package, ...(chosen.spec.args ?? [])],
    ...(chosen.spec.env && { env: { ...chosen.spec.env } }),
  };
}

/** The agents of the ACP registry, read from `url` */
export async function fetchAcpRegistry(
  options: { url?: string; fetch?: typeof fetch; signal?: AbortSignal } = {}
): Promise<AcpRegistryAgent[]> {
  const read = options.fetch ?? fetch;
  const response = await read(options.url ?? ACP_REGISTRY_URL, {
    ...(options.signal && { signal: options.signal }),
  });
  if (!response.ok) throw new Error(`The ACP registry answered ${response.status}`);
  const registry = RegistrySchema.parse(await response.json());
  return registry.agents.flatMap((entry) => {
    const parsed = AcpRegistryAgentSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * How to launch an agent named by `spec`: a preset name (`claude`, `codex`, `gemini`),
 * `registry:<id>` for an agent of the ACP registry, or a command line (`my-agent --acp`)
 */
export async function resolveAcpAgent(
  spec: string,
  options: { url?: string; fetch?: typeof fetch; signal?: AbortSignal } = {}
): Promise<AcpLaunch & { name: string }> {
  const preset = ACP_AGENT_PRESETS[spec];
  if (preset) return { ...preset, args: [...preset.args] };
  if (spec.startsWith('registry:')) {
    const id = spec.slice('registry:'.length);
    const agents = await fetchAcpRegistry(options);
    const agent = agents.find((candidate) => candidate.id === id);
    if (!agent) throw new Error(`The ACP registry has no agent ${id}`);
    return { name: agent.name, ...launchOfRegistryAgent(agent) };
  }
  const words = splitCommand(spec);
  if (words.length === 0)
    throw new Error('Name an ACP agent: a preset, registry:<id> or a command');
  return { name: words[0]!, command: words[0]!, args: words.slice(1) };
}

/**
 * A command line split into words as a shell splits it, in one pass: single quotes keep what
 * they hold, double quotes too but for a backslash escaping the next character, and quoted and
 * bare parts next to each other make one word
 */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === '\\' && i + 1 < line.length) word += line[++i];
      else word += char;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      inWord = true;
      if (char === '"' || char === "'") quote = char;
      else word += char;
    }
  }
  if (inWord) words.push(word);
  return words;
}
