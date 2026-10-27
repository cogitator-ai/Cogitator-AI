/**
 * Skills of plugins: the `SKILL.md` folders of a plugin, and skills defined in code, named
 * `plugin:skill` as Claude Code names them, their text with the plugin's variables put in
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix } from 'node:path';
import type {
  PluginSkillSpec,
  SkillCatalog,
  SkillDiscoveryContext,
  SkillLoader,
  SkillManifest,
} from '@cogitator-ai/types';
import { SkillRegistry } from '../skills/skill-registry';
import { substitute, type PluginVariables } from './variables';

/** A skill's name in the Agent Skills format, the last part of `plugin:skill` */
export const PLUGIN_SKILL_NAME = /^[\p{Ll}\p{Nd}]+(?:-[\p{Ll}\p{Nd}]+)*$/u;

/**
 * The skills of a plugin's folders, renamed `plugin:name` (a skill at the plugin root takes the
 * name its frontmatter gives, else the plugin's), their body and files with `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and
 * the plugin's options that are not secrets put in. The folders are read once
 */
export class PluginFolderSkills implements SkillLoader {
  private readonly registry: SkillRegistry;
  private catalog?: Promise<SkillCatalog>;
  private found: string[] = [];
  private readonly folder: string;

  /**
   * `store` is a folder of the generation's own, where the files of its skills are kept as they
   * were when it loaded (without one they are kept in memory)
   */
  constructor(
    private readonly plugin: string,
    dirs: readonly string[],
    private readonly variables: PluginVariables,
    private readonly rootSkill = false,
    private readonly store?: string
  ) {
    this.folder = basename(dirs[0] ?? '');
    this.registry = new SkillRegistry({ dirs: [...dirs], workspace: false });
  }

  discover(_context?: SkillDiscoveryContext): Promise<SkillCatalog> {
    this.catalog ??= this.registry.discover({}).then(async (inner) => {
      const wrapped = await this.wrap(inner);
      this.found = wrapped.skills.map((skill) => skill.name);
      return wrapped;
    });
    return this.catalog;
  }

  /** The names of the skills found, once `discover` ran */
  names(): string[] {
    return [...this.found];
  }

  /**
   * The catalog of the skills found, renamed, each skill's body and listed files read once now:
   * the generation serves them as they were when it loaded, however the folder changes after
   */
  private async wrap(inner: SkillCatalog): Promise<SkillCatalog> {
    const byName = new Map<string, { manifest: SkillManifest; original: string }>();
    for (const skill of inner.skills) {
      const last = this.rootSkill && skill.name === this.folder ? this.plugin : skill.name;
      const name = `${this.plugin}:${last}`;
      if (!byName.has(name)) {
        byName.set(name, { manifest: { ...skill, name }, original: skill.name });
      }
    }
    const frozen = new Map<string, FrozenSkill>();
    let index = 0;
    for (const [name, { original }] of byName) {
      frozen.set(name, await this.freeze(inner, original, index++));
    }
    const skillOf = (name: string): FrozenSkill => {
      const found = frozen.get(name);
      if (!found) throw new Error(`There is no skill "${name}"`);
      return found;
    };
    const text = (value: string) => substitute(value, this.variables, 'placeholder');
    return {
      skills: [...byName.values()].map((entry) => entry.manifest),
      diagnostics: inner.diagnostics,
      get: (name) => byName.get(name)?.manifest,
      body: async (name) => text(skillOf(name).body),
      files: async (name) => [...skillOf(name).files.keys()],
      readFile: async (name, path) => {
        const file = skillOf(name).files.get(path);
        if (file === undefined) {
          throw new Error(`${path} is not a file of the skill ${name} as this version loaded it`);
        }
        if ('error' in file) throw new Error(file.error);
        return text('text' in file ? file.text : await readFile(file.path, 'utf8'));
      },
    };
  }

  /** The body and listed files of the skill `original`, read now (files to `store` when given) */
  private async freeze(inner: SkillCatalog, original: string, index: number): Promise<FrozenSkill> {
    const body = await inner.body(original);
    const files = new Map<string, FrozenFile>();
    for (const path of await inner.files(original)) {
      let content: string;
      try {
        content = await inner.readFile(original, path);
      } catch (error) {
        files.set(path, { error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (!this.store) {
        files.set(path, { text: content });
        continue;
      }
      const target = join(this.store, String(index), ...path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
      files.set(path, { path: target });
    }
    return { body, files };
  }
}

/** A file of a skill as a generation loaded it: in memory, in its store, or why it did not read */
type FrozenFile = { text: string } | { path: string } | { error: string };

/** A skill of a plugin folder as a generation loaded it */
interface FrozenSkill {
  body: string;
  files: Map<string, FrozenFile>;
}

/** Skills a plugin defined in code with `registerSkill`, held in memory */
export class PluginCodeSkills implements SkillLoader {
  private readonly skills = new Map<string, PluginSkillSpec & { fullName: string }>();

  constructor(private readonly plugin: string) {}

  /** Adds `skill`, returning what removes it again */
  add(skill: PluginSkillSpec): () => void {
    if (!PLUGIN_SKILL_NAME.test(skill.name)) {
      throw new TypeError(
        `Skill "${skill.name}" of plugin ${this.plugin}: a name may only hold lowercase letters, digits and single hyphens`
      );
    }
    if (skill.description.trim() === '') {
      throw new TypeError(`Skill "${skill.name}" of plugin ${this.plugin} needs a description`);
    }
    const fullName = `${this.plugin}:${skill.name}`;
    if (this.skills.has(fullName)) {
      throw new TypeError(`Plugin ${this.plugin} registered the skill "${skill.name}" twice`);
    }
    for (const path of Object.keys(skill.files ?? {})) {
      const normal = posix.normalize(path);
      if (posix.isAbsolute(normal) || normal.startsWith('..') || normal === 'SKILL.md') {
        throw new TypeError(
          `Skill "${skill.name}": the file "${path}" is not inside the skill folder`
        );
      }
    }
    const entry = { ...skill, fullName };
    this.skills.set(fullName, entry);
    return () => {
      if (this.skills.get(fullName) === entry) this.skills.delete(fullName);
    };
  }

  get size(): number {
    return this.skills.size;
  }

  names(): string[] {
    return [...this.skills.keys()];
  }

  async discover(_context?: SkillDiscoveryContext): Promise<SkillCatalog> {
    const entries = [...this.skills.values()];
    const manifests = new Map<string, SkillManifest>(
      entries.map((skill) => [
        skill.fullName,
        {
          name: skill.fullName,
          description: skill.description.trim(),
          ...(skill.allowedTools && { allowedTools: skill.allowedTools }),
          location: `plugin:${this.plugin}/${skill.name}`,
          source: 'host' as const,
        },
      ])
    );
    const spec = (name: string) => {
      const found = this.skills.get(name);
      if (!found) throw new Error(`There is no skill "${name}"`);
      return found;
    };
    return {
      skills: [...manifests.values()],
      diagnostics: [],
      get: (name) => manifests.get(name),
      body: async (name) => spec(name).instructions,
      files: async (name) => Object.keys(spec(name).files ?? {}).sort(),
      readFile: async (name, path) => {
        const files = spec(name).files ?? {};
        const normal = posix.normalize(path);
        if (!Object.hasOwn(files, normal)) {
          throw new Error(`${path} is not a file of the skill ${name}`);
        }
        return files[normal] ?? '';
      },
    };
  }
}
