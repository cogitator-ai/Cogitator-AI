import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findMissingDependencies,
  findSkillFile,
  getTemplate,
  isSafeSkillDirName,
  isValidSkillName,
  toSkill,
} from '../commands/skill.js';

const tool = { name: 'weather', description: 'd', execute: async () => 'ok' };

describe('skill names', () => {
  it('accepts kebab-case names for new skills', () => {
    expect(isValidSkillName('weather')).toBe(true);
    expect(isValidSkillName('weather-api2')).toBe(true);
  });

  it('rejects names that would break paths or identifiers', () => {
    for (const name of ['../etc', 'a/b', 'Weather', '1st', 'a--b', '-a', 'a-', '']) {
      expect(isValidSkillName(name)).toBe(false);
    }
  });

  it('only allows plain directory names for installed skills', () => {
    expect(isSafeSkillDirName('my_skill.v2')).toBe(true);
    expect(isSafeSkillDirName('..')).toBe(false);
    expect(isSafeSkillDirName('../x')).toBe(false);
    expect(isSafeSkillDirName('a/b')).toBe(false);
    expect(isSafeSkillDirName('.hidden')).toBe(false);
  });
});

describe('toSkill', () => {
  it('accepts a well-formed skill', () => {
    const { skill, issues } = toSkill({
      name: 'weather',
      version: '1.0.0',
      description: 'Weather',
      tools: [tool],
      env: ['WEATHER_API_KEY'],
    });
    expect(issues).toEqual([]);
    expect(skill?.tools).toHaveLength(1);
    expect(skill?.env).toEqual(['WEATHER_API_KEY']);
  });

  it('reports every structural problem', () => {
    const { skill, issues } = toSkill({ name: 5, tools: [{ name: 'x' }] });
    expect(skill).toBeNull();
    expect(issues).toEqual([
      'Missing or invalid "name" field',
      'Missing or invalid "version" field',
      'Missing or invalid "description" field',
      'tools[0] is not a valid tool (needs name + execute)',
    ]);
  });

  it('rejects non-object exports', () => {
    expect(toSkill('nope').issues).toEqual(['Export is not an object']);
  });
});

describe('getTemplate', () => {
  it.each(['basic', 'device', 'api'] as const)('produces valid identifiers for %s', (template) => {
    const files = getTemplate('weather-api', template);
    expect(files.skill).toContain('weatherApiTool');
    expect(files.tool).toContain('export const weatherApiTool');
    expect(files.tool).toContain("name: 'weather_api'");
    expect(files.skill).toContain('Use the weather_api tool');
  });

  it('declares the API key env var for the api template', () => {
    const files = getTemplate('weather-api', 'api');
    expect(files.skill).toContain("env: ['WEATHER_API_API_KEY']");
    expect(files.tool).toContain('process.env.WEATHER_API_API_KEY');
  });

  it('does not import unused modules in the device template', () => {
    expect(getTemplate('lights', 'device').tool).not.toContain('child_process');
  });
});

describe('skill files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cli-skill-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds skill.ts, skill.js or skill.mjs', () => {
    expect(findSkillFile(dir)).toBeNull();
    writeFileSync(join(dir, 'skill.mjs'), '');
    expect(findSkillFile(dir)).toBe(join(dir, 'skill.mjs'));
    writeFileSync(join(dir, 'skill.ts'), '');
    expect(findSkillFile(dir)).toBe(join(dir, 'skill.ts'));
  });

  it('resolves dependencies relative to the skill file', () => {
    const skillFile = join(__dirname, 'skill.test.ts');
    expect(findMissingDependencies(['vitest', 'definitely-missing-pkg-xyz'], skillFile)).toEqual([
      'definitely-missing-pkg-xyz',
    ]);
  });
});
