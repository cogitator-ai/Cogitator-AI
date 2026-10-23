import { describe, expect, it } from 'vitest';
import { parseSkillFile, splitSkillFile } from '../skills/frontmatter';

const origin = {
  folderName: 'pdf-processing',
  location: '/skills/pdf-processing',
  path: '/skills/pdf-processing/SKILL.md',
  source: 'host' as const,
};

function skill(frontmatter: string, body = '# PDF\n\nSteps.'): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

describe('splitSkillFile', () => {
  it('splits the frontmatter from the body', () => {
    expect(splitSkillFile('---\nname: a\n---\n# Body\n')).toEqual({
      frontmatter: 'name: a\n',
      body: '# Body\n',
    });
  });

  it('accepts a byte order mark, CRLF line ends and spaces after the fences', () => {
    expect(splitSkillFile('﻿---  \r\nname: a\r\n--- \r\nBody')).toEqual({
      frontmatter: 'name: a\r\n',
      body: 'Body',
    });
  });

  it('finds no frontmatter in a file that does not start with one or never closes it', () => {
    expect(splitSkillFile('# Title\n---\nname: a\n---\n')).toBeUndefined();
    expect(splitSkillFile('---\nname: a\n')).toBeUndefined();
    expect(splitSkillFile('')).toBeUndefined();
  });

  it('keeps later --- lines in the body', () => {
    expect(splitSkillFile('---\na: 1\n---\nintro\n---\nmore')?.body).toBe('intro\n---\nmore');
  });

  it('reads a long frontmatter that never closes as none', () => {
    expect(splitSkillFile(`---\n${'k: v\n'.repeat(50_000)}`)).toBeUndefined();
  });
});

describe('parseSkillFile', () => {
  it('reads every field of a valid skill', () => {
    const parsed = parseSkillFile(
      skill(
        [
          'name: pdf-processing',
          'description: Extract PDF text and fill forms. Use when handling PDFs.',
          'license: Apache-2.0',
          'compatibility: Requires poppler-utils',
          'metadata:',
          '  author: example-org',
          '  version: "1.0"',
          'allowed-tools: Bash(git:*) Bash(jq:*)  Read',
        ].join('\n')
      ),
      origin
    );

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.manifest).toEqual({
      name: 'pdf-processing',
      description: 'Extract PDF text and fill forms. Use when handling PDFs.',
      license: 'Apache-2.0',
      compatibility: 'Requires poppler-utils',
      metadata: { author: 'example-org', version: '1.0' },
      allowedTools: ['Bash(git:*)', 'Bash(jq:*)', 'Read'],
      location: '/skills/pdf-processing',
      source: 'host',
    });
  });

  it('skips a skill without a description', () => {
    const parsed = parseSkillFile(skill('name: pdf-processing'), origin);
    expect(parsed.manifest).toBeUndefined();
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({ level: 'error', message: expect.stringContaining('description') }),
    ]);
    expect(parseSkillFile(skill('name: pdf-processing\ndescription: "  "'), origin).manifest).toBe(
      undefined
    );
  });

  it('skips a file without frontmatter, with invalid YAML or a frontmatter that is no mapping', () => {
    for (const text of ['# Just markdown', skill('name: [unclosed'), skill('- a\n- b')]) {
      const parsed = parseSkillFile(text, origin);
      expect(parsed.manifest).toBeUndefined();
      expect(parsed.diagnostics[0]?.level).toBe('error');
    }
  });

  it('loads a skill whose name breaks the rules, with a warning for each rule', () => {
    for (const name of ['PDF-Processing', '-pdf', 'pdf--processing', 'a'.repeat(65)]) {
      const parsed = parseSkillFile(skill(`name: ${name}\ndescription: PDFs.`), {
        ...origin,
        folderName: name,
      });
      expect(parsed.manifest?.name).toBe(name);
      expect(parsed.diagnostics).toEqual([expect.objectContaining({ level: 'warning' })]);
    }
  });

  it('warns when the name does not match the folder', () => {
    const parsed = parseSkillFile(skill('name: pdf\ndescription: PDFs.'), origin);
    expect(parsed.manifest?.name).toBe('pdf');
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({
        level: 'warning',
        message: 'name "pdf" does not match the folder name "pdf-processing"',
      }),
    ]);
  });

  it('takes the folder name for a skill without a name', () => {
    const parsed = parseSkillFile(skill('description: PDFs.'), origin);
    expect(parsed.manifest?.name).toBe('pdf-processing');
    expect(parsed.diagnostics[0]?.level).toBe('warning');
  });

  it('reads metadata as strings, leaving out what is not a scalar', () => {
    const parsed = parseSkillFile(
      skill(
        'name: pdf-processing\ndescription: PDFs.\nmetadata:\n  version: 1.5\n  beta: true\n  tags: [a, b]\n  owner: me'
      ),
      origin
    );
    expect(parsed.manifest?.metadata).toEqual({ version: '1.5', beta: 'true', owner: 'me' });
    expect(parsed.diagnostics.map((d) => d.message)).toEqual([
      'metadata.version is not a string, it is read as "1.5"',
      'metadata.beta is not a string, it is read as "true"',
      'metadata.tags is not a string, it is ignored',
    ]);
  });

  it('ignores metadata that is not a mapping', () => {
    const parsed = parseSkillFile(
      skill('name: pdf-processing\ndescription: PDFs.\nmetadata: [a]'),
      origin
    );
    expect(parsed.manifest?.metadata).toBeUndefined();
    expect(parsed.diagnostics[0]?.message).toContain('metadata is not a mapping');
  });

  it('takes allowed-tools as a list too, and ignores any other type', () => {
    const listed = parseSkillFile(
      skill('name: pdf-processing\ndescription: PDFs.\nallowed-tools:\n  - Read\n  - Bash'),
      origin
    );
    expect(listed.manifest?.allowedTools).toEqual(['Read', 'Bash']);
    expect(listed.diagnostics).toEqual([]);

    const wrong = parseSkillFile(
      skill('name: pdf-processing\ndescription: PDFs.\nallowed-tools: 3'),
      origin
    );
    expect(wrong.manifest?.allowedTools).toBeUndefined();
    expect(wrong.diagnostics[0]?.message).toContain('allowed-tools');
  });

  it('warns about a description or compatibility past their limits and keeps them', () => {
    const parsed = parseSkillFile(
      skill(
        `name: pdf-processing\ndescription: ${'d'.repeat(1025)}\ncompatibility: ${'c'.repeat(501)}`
      ),
      origin
    );
    expect(parsed.manifest?.description).toHaveLength(1025);
    expect(parsed.manifest?.compatibility).toHaveLength(501);
    expect(parsed.diagnostics.map((d) => d.level)).toEqual(['warning', 'warning']);
  });

  it('ignores a license of the wrong type and fields the format does not define', () => {
    const parsed = parseSkillFile(
      skill('name: pdf-processing\ndescription: PDFs.\nlicense: 2\nmodel: some-model'),
      origin
    );
    expect(parsed.manifest).toEqual({
      name: 'pdf-processing',
      description: 'PDFs.',
      location: '/skills/pdf-processing',
      source: 'host',
    });
    expect(parsed.diagnostics.map((d) => d.message)).toEqual([
      'license is not a string, it is ignored',
    ]);
  });
});
