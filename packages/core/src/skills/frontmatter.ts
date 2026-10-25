import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { SkillDiagnostic, SkillManifest } from '@cogitator-ai/types';

/** The file that makes a folder a skill */
export const SKILL_FILE = 'SKILL.md';

/** Longest `name` the Agent Skills format allows */
export const MAX_SKILL_NAME_LENGTH = 64;

/** Longest `description` the Agent Skills format allows */
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

/** Longest `compatibility` the Agent Skills format allows */
export const MAX_SKILL_COMPATIBILITY_LENGTH = 500;

const nameSchema = z
  .string()
  .min(1, 'is empty')
  .max(MAX_SKILL_NAME_LENGTH, `is longer than ${MAX_SKILL_NAME_LENGTH} characters`)
  .regex(
    /^[\p{Ll}\p{Nd}]+(?:-[\p{Ll}\p{Nd}]+)*$/u,
    'may only hold lowercase letters, digits and single hyphens between them'
  );

const descriptionSchema = z.string().trim().min(1);

const compatibilitySchema = z
  .string()
  .min(1)
  .max(
    MAX_SKILL_COMPATIBILITY_LENGTH,
    `is longer than ${MAX_SKILL_COMPATIBILITY_LENGTH} characters`
  );

const frontmatterSchema = z.record(z.string(), z.unknown());

/** A `SKILL.md` split into its YAML frontmatter and its Markdown body. */
export interface SkillFileParts {
  frontmatter: string;
  body: string;
}

/**
 * `text` split into the YAML frontmatter between its first two `---` lines and the body after
 * them, or undefined when it does not start with a frontmatter block. One pass over the lines.
 */
export function splitSkillFile(text: string): SkillFileParts | undefined {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let position = 0;
  let frontmatterStart = -1;
  while (position <= source.length) {
    const newline = source.indexOf('\n', position);
    const end = newline === -1 ? source.length : newline;
    const next = newline === -1 ? source.length : newline + 1;
    const isFence = source.slice(position, end).trimEnd() === '---';
    if (frontmatterStart === -1) {
      if (!isFence) return undefined;
      frontmatterStart = next;
    } else if (isFence) {
      return { frontmatter: source.slice(frontmatterStart, position), body: source.slice(next) };
    }
    if (newline === -1) return undefined;
    position = next;
  }
  return undefined;
}

/** The fields of a Markdown file's YAML frontmatter and its body, see {@link readFrontmatter} */
export interface FrontmatterParts {
  fields: Record<string, unknown>;
  body: string;
  /** What the YAML parser warned about */
  warnings: string[];
}

/**
 * The YAML frontmatter of `text` read as a mapping of fields, with the body after it.
 * `{ error: 'missing' }` when the text does not start with a frontmatter block, the reason when
 * the block is not valid YAML or not a mapping
 */
export function readFrontmatter(text: string): FrontmatterParts | { error: string } {
  const parts = splitSkillFile(text);
  if (!parts) return { error: 'missing' };
  let parsed: unknown;
  const warnings: string[] = [];
  try {
    const document = parseDocument(parts.frontmatter, { prettyErrors: false });
    const [problem] = document.errors;
    if (problem) return { error: `The frontmatter is not valid YAML: ${problem.message}` };
    for (const warning of document.warnings)
      warnings.push(`The frontmatter YAML: ${warning.message}`);
    parsed = document.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return {
      error: `The frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const fields = frontmatterSchema.safeParse(parsed);
  if (!fields.success || parsed === null || Array.isArray(parsed)) {
    return { error: 'The frontmatter is not a YAML mapping of fields' };
  }
  return { fields: fields.data, body: parts.body, warnings };
}

/**
 * The entries of a tool list: separated by commas or white space outside parentheses, so a rule
 * such as `Bash(git status:*)` stays one entry
 */
export function splitToolList(list: string): string[] {
  const entries: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of list) {
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === ',' || /\s/.test(char))) {
      entries.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  entries.push(current);
  return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** Where a `SKILL.md` was found, for its manifest and diagnostics. */
export interface SkillFileOrigin {
  /** Name of the skill folder, which `name` should match */
  folderName: string;
  /** The skill folder, as `SkillManifest.location` names it */
  location: string;
  /** The `SKILL.md`, for diagnostics */
  path: string;
  source: SkillManifest['source'];
}

/** What reading a `SKILL.md` gave: its manifest unless it was skipped, and what was wrong with it. */
export interface ParsedSkillFile {
  manifest?: SkillManifest;
  diagnostics: SkillDiagnostic[];
}

/**
 * The manifest of a `SKILL.md` per the Agent Skills format, read leniently: a file without
 * frontmatter, with frontmatter that is not a YAML mapping, or without a `description` is
 * skipped with an error diagnostic. Anything else the format does not allow (a `name` that breaks
 * its rules or differs from the folder, a value of the wrong type or too long) is loaded anyway
 * with a warning, and a value of the wrong type is left out. Fields the format does not define
 * are ignored.
 */
export function parseSkillFile(text: string, origin: SkillFileOrigin): ParsedSkillFile {
  const diagnostics: SkillDiagnostic[] = [];
  const report = (level: SkillDiagnostic['level'], message: string) =>
    diagnostics.push({ level, message, path: origin.path });

  const read = readFrontmatter(text);
  if ('error' in read) {
    report(
      'error',
      read.error === 'missing'
        ? 'No YAML frontmatter: SKILL.md must start with a block between --- lines'
        : read.error
    );
    return { diagnostics };
  }
  for (const warning of read.warnings) report('warning', warning);
  const data = read.fields;

  const description = descriptionSchema.safeParse(data.description);
  if (!description.success) {
    report('error', 'No description: the frontmatter needs a non-empty description string');
    return { diagnostics };
  }
  if (description.data.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    report(
      'warning',
      `description is longer than ${MAX_SKILL_DESCRIPTION_LENGTH} characters (${description.data.length})`
    );
  }

  const name = nameOf(data.name, origin.folderName, report);

  const license = optionalString(data.license, 'license', report);

  let compatibility: string | undefined;
  if (data.compatibility !== undefined && data.compatibility !== null) {
    if (typeof data.compatibility !== 'string') {
      report('warning', 'compatibility is not a string, it is ignored');
    } else {
      const checked = compatibilitySchema.safeParse(data.compatibility);
      if (!checked.success) report('warning', `compatibility ${checked.error.issues[0]?.message}`);
      if (data.compatibility.length > 0) compatibility = data.compatibility;
    }
  }

  const metadata = metadataOf(data.metadata, report);
  const allowedTools = allowedToolsOf(data['allowed-tools'], report);

  return {
    manifest: {
      name,
      description: description.data,
      ...(license !== undefined && { license }),
      ...(compatibility !== undefined && { compatibility }),
      ...(metadata !== undefined && { metadata }),
      ...(allowedTools !== undefined && { allowedTools }),
      location: origin.location,
      source: origin.source,
    },
    diagnostics,
  };
}

type Report = (level: SkillDiagnostic['level'], message: string) => void;

function nameOf(value: unknown, folderName: string, report: Report): string {
  if (typeof value !== 'string' || value.length === 0) {
    report(
      'warning',
      `No name string in the frontmatter, the folder name "${folderName}" is used instead`
    );
    return folderName;
  }
  const checked = nameSchema.safeParse(value);
  if (!checked.success) {
    report('warning', `name "${value}" ${checked.error.issues[0]?.message}`);
  }
  if (value !== folderName) {
    report('warning', `name "${value}" does not match the folder name "${folderName}"`);
  }
  return value;
}

function optionalString(value: unknown, field: string, report: Report): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  report('warning', `${field} is not a string, it is ignored`);
  return undefined;
}

function metadataOf(value: unknown, report: Report): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  const map = frontmatterSchema.safeParse(value);
  if (!map.success || Array.isArray(value)) {
    report('warning', 'metadata is not a mapping of strings, it is ignored');
    return undefined;
  }
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(map.data)) {
    if (typeof entry === 'string') {
      metadata[key] = entry;
    } else if (typeof entry === 'number' || typeof entry === 'boolean') {
      report('warning', `metadata.${key} is not a string, it is read as "${String(entry)}"`);
      metadata[key] = String(entry);
    } else {
      report('warning', `metadata.${key} is not a string, it is ignored`);
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function allowedToolsOf(value: unknown, report: Report): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const entries =
    typeof value === 'string'
      ? splitToolList(value)
      : Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? value
        : undefined;
  if (!entries) {
    report('warning', 'allowed-tools is not a space-separated string, it is ignored');
    return undefined;
  }
  const tools = entries.flatMap((entry) => splitToolList(entry));
  return tools.length > 0 ? tools : undefined;
}
