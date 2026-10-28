import type { AvailableCommand } from '@agentclientprotocol/sdk';
import { skillLoadersOf, type Agent, type Cogitator } from '@cogitator-ai/core';
import type { SkillManifest, Workspace } from '@cogitator-ai/types';

/** What the `/` menu of an editor offers: the runtime's commands and the agent's skills */
export interface SessionCommands {
  commands: AvailableCommand[];
  /** The names of the skills among them, which a prompt starting with `/<name>` asks for */
  skills: ReadonlySet<string>;
}

/** The `SKILL.md` skills of an agent, as a run in `workspace` finds them */
export async function skillsOf(
  agent: Agent,
  workspace: Workspace | undefined
): Promise<SkillManifest[]> {
  const found = new Map<string, SkillManifest>();
  for (const loader of skillLoadersOf(agent.config.skills)) {
    try {
      const catalog = await loader.discover(workspace ? { workspace } : {});
      for (const skill of catalog.skills) if (!found.has(skill.name)) found.set(skill.name, skill);
    } catch {
      continue;
    }
  }
  return [...found.values()];
}

/**
 * The commands a session offers: the runtime's commands for the project at `root` (Markdown
 * commands of `commands/` folders and those in code), then the agent's skills, a skill with the
 * name of a command left out
 */
export async function sessionCommands(
  cogitator: Cogitator,
  agent: Agent,
  root: string,
  workspace: Workspace | undefined
): Promise<SessionCommands> {
  const catalog = await cogitator.listCommands({ root }).catch(() => undefined);
  const commands: AvailableCommand[] = (catalog?.commands ?? []).map((command) => ({
    name: command.name,
    description: command.description ?? `Run the ${command.name} command`,
    ...(command.argumentHint !== undefined && { input: { hint: command.argumentHint } }),
  }));
  const taken = new Set(commands.map((command) => command.name));
  const skills = new Set<string>();
  for (const skill of await skillsOf(agent, workspace)) {
    if (taken.has(skill.name)) continue;
    skills.add(skill.name);
    commands.push({
      name: skill.name,
      description: skill.description,
      input: { hint: 'what to do with the skill' },
    });
  }
  return { commands, skills };
}

/**
 * The text of a prompt that asks for a skill with `/<skill> <what>`, as a request the agent
 * follows with `use_skill`. Any other text as it is: the runtime expands commands itself
 */
export function expandSkill(text: string, skills: ReadonlySet<string>): string {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match || !skills.has(match[1])) return text;
  const rest = match[2]?.trim();
  return rest
    ? `Use the ${match[1]} skill (load it with use_skill) to do this: ${rest}`
    : `Use the ${match[1]} skill (load it with use_skill).`;
}
