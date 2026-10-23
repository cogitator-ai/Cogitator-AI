import { z } from 'zod';
import type { Message, SkillCatalog, SkillManifest, Tool } from '@cogitator-ai/types';
import { tool } from '../tool';
import { toolContent } from '../tool-content';
import { getTextContent } from '../cogitator/span-factory';

/** Name of the built-in tool that activates a skill */
export const USE_SKILL = 'use_skill';

/** Name of the built-in tool that reads a file of a skill */
export const READ_SKILL_FILE = 'read_skill_file';

/** Most characters of skill descriptions `<available_skills>` holds before it lists names only */
export const MAX_SKILL_CATALOG_CHARS = 12_000;

/** Most characters of skill names listed without descriptions past {@link MAX_SKILL_CATALOG_CHARS} */
const MAX_SKILL_NAME_LIST_CHARS = 4_000;

const MAX_LISTED_DESCRIPTION = 1024;

/**
 * Most characters of skill instructions a run keeps in the conversation for good: clearing tool
 * outputs leaves the newest `use_skill` results up to this many alone, and compaction puts back at
 * most this many. Older instructions past it are cleared or dropped, and `use_skill` returns them
 * again when the model asks
 */
export const MAX_PINNED_SKILL_CHARS = 40_000;

/**
 * The section of the system prompt that lists `skills` for the model, name and description each:
 * an `<available_skills>` block with how to activate one. Descriptions fill at most
 * {@link MAX_SKILL_CATALOG_CHARS} characters, the skills past them are listed by name, and past
 * that only counted: `use_skill` still takes every name.
 */
export function availableSkillsSection(skills: readonly SkillManifest[]): string {
  const lines: string[] = [];
  let described = 0;
  let named = 0;
  let unlisted = 0;
  for (const skill of skills) {
    const description = cut(skill.description, MAX_LISTED_DESCRIPTION);
    const full = `<skill name="${escapeXml(skill.name)}">${escapeXml(description)}</skill>`;
    if (described + full.length <= MAX_SKILL_CATALOG_CHARS && named === 0) {
      described += full.length;
      lines.push(full);
      continue;
    }
    const bare = `<skill name="${escapeXml(skill.name)}"/>`;
    if (named + bare.length <= MAX_SKILL_NAME_LIST_CHARS) {
      named += bare.length;
      lines.push(bare);
      continue;
    }
    unlisted++;
  }
  if (unlisted > 0) {
    lines.push(`<!-- ${unlisted} more skills, not listed: use_skill takes their names too -->`);
  }
  return [
    '<available_skills>',
    ...lines,
    '</available_skills>',
    `Skills hold instructions and files for particular tasks. When a task matches a skill's description, call ${USE_SKILL} with that skill before you start, then follow what it returns.`,
  ].join('\n');
}

/**
 * What tells a skill from another of the same name (of another agent, or found elsewhere): where
 * its folder is
 */
export function skillKey(skill: Pick<SkillManifest, 'source' | 'location'>): string {
  return `${skill.source}:${skill.location}`;
}

/** The opening tag `use_skill` starts the instructions of `skill` with. */
function skillContentTag(skill: SkillManifest): string {
  return `<skill_content name="${escapeXml(skill.name)}" source="${skill.source}" location="${escapeXml(skill.location)}">`;
}

/**
 * Keys ({@link skillKey}) of the skills whose instructions `messages` hold: results of
 * `use_skill` that returned them, and system messages that carried them through compaction.
 */
export function activeSkillsIn(messages: readonly Message[]): Set<string> {
  const active = new Set<string>();
  for (const message of messages) {
    if (!mayHoldSkill(message)) continue;
    const content = skillContentOf(getTextContent(message.content));
    if (content) active.add(content.key);
  }
  return active;
}

/**
 * Whether `message` may carry the instructions of a skill: a `use_skill` result (or a tool result
 * of unknown name), or a system message that kept them through compaction.
 */
export function mayHoldSkill(message: Message): boolean {
  return (
    message.role === 'system' ||
    (message.role === 'tool' && (message.name === undefined || message.name === USE_SKILL))
  );
}

/** The skill whose instructions `text` holds, when it starts with them: its name and key. */
export function skillContentOf(text: string): { name: string; key: string } | undefined {
  const prefix = '<skill_content name="';
  if (!text.startsWith(prefix)) return undefined;
  const nameEnd = text.indexOf('" source="', prefix.length);
  if (nameEnd === -1) return undefined;
  const sourceStart = nameEnd + '" source="'.length;
  const sourceEnd = text.indexOf('" location="', sourceStart);
  if (sourceEnd === -1) return undefined;
  const locationStart = sourceEnd + '" location="'.length;
  const locationEnd = text.indexOf('">', locationStart);
  if (locationEnd === -1) return undefined;
  const source = text.slice(sourceStart, sourceEnd);
  if (source !== 'host' && source !== 'workspace') return undefined;
  return {
    name: unescapeXml(text.slice(prefix.length, nameEnd)),
    key: skillKey({ source, location: unescapeXml(text.slice(locationStart, locationEnd)) }),
  };
}

export interface SkillToolsOptions {
  catalog: SkillCatalog;
  /**
   * Whether the run's `read_file` reads the workspace the catalog's workspace skills are in: the
   * model is then told to read their files with it
   */
  workspaceReadFile: boolean;
  /** The run's conversation so far, to tell an active skill */
  conversation: () => readonly Message[];
}

/**
 * The tools that give the model the skills of `catalog`: `use_skill`, which returns a skill's
 * instructions, its folder and its files, and `read_skill_file` when some skill's files are only
 * reachable through it (a skill on the host, or one in a workspace the run's `read_file` does not
 * read). Empty when the catalog has no skills.
 */
export function skillTools(options: SkillToolsOptions): Tool[] {
  const { catalog, workspaceReadFile, conversation } = options;
  const names = catalog.skills.map((skill) => skill.name);
  const [first, ...rest] = names;
  if (first === undefined) return [];
  const viaReadFile = (skill: SkillManifest) => skill.source === 'workspace' && workspaceReadFile;
  const needsReader = catalog.skills.some((skill) => !viaReadFile(skill));

  const useSkill = tool({
    name: USE_SKILL,
    description:
      'Activate a skill from <available_skills>: returns its instructions, its folder and its files. Call it before working on a task the skill covers, once per skill.',
    parameters: z.object({
      skill: z.enum([first, ...rest]).describe('Name of the skill, as <available_skills> lists it'),
    }),
    execute: async ({ skill: name }) => {
      const skill = catalog.get(name);
      if (!skill) throw new Error(`There is no skill "${name}"`);
      if (activeSkillsIn(conversation()).has(skillKey(skill))) {
        return toolContent({
          type: 'text',
          text: `The skill "${name}" is already active: its instructions are earlier in this conversation. Follow them.`,
        });
      }
      const [body, files] = await Promise.all([catalog.body(name), catalog.files(name)]);
      return toolContent({
        type: 'text',
        text: skillContent(skill, body, files, viaReadFile(skill)),
      });
    },
  });
  if (!needsReader) return [useSkill];

  const readSkillFile = tool({
    name: READ_SKILL_FILE,
    description:
      'Read a text file of an active skill: a script, reference or asset its instructions point to.',
    parameters: z.object({
      skill: z.enum([first, ...rest]).describe('Name of the skill'),
      path: z.string().min(1).describe('Path of the file relative to the skill folder'),
    }),
    execute: async ({ skill: name, path }) =>
      toolContent({ type: 'text', text: await catalog.readFile(name, path) }),
  });
  return [useSkill, readSkillFile];
}

function skillContent(
  skill: SkillManifest,
  body: string,
  files: readonly string[],
  viaReadFile: boolean
): string {
  const parts = [`${skillContentTag(skill)}\n${body}\n</skill_content>`];
  const folder =
    skill.source === 'workspace'
      ? `${skill.location} (in the workspace, relative to its root)`
      : skill.location;
  parts.push(
    `Skill folder: ${folder}. Paths in the instructions are relative to it.${
      skill.allowedTools ? `\nTools the skill expects: ${skill.allowedTools.join(' ')}` : ''
    }`
  );
  if (files.length > 0) {
    const listing = viaReadFile
      ? files.map((file) => `- ${skill.location}/${file}`)
      : files.map((file) => `- ${file}`);
    const how = viaReadFile
      ? 'read them with read_file, by these paths'
      : `read them with ${READ_SKILL_FILE} ({"skill": ${JSON.stringify(skill.name)}, "path": "<path>"})`;
    parts.push(`Files of the skill, ${how}:\n${listing.join('\n')}`);
  }
  return parts.join('\n\n');
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function unescapeXml(text: string): string {
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
}
