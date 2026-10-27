import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globMatches } from '../plugin-evals/glob';
import { dialectProblem, expectViolation, loadMocks, renderMock } from '../plugin-evals/mocks';
import { readMarkdown } from '../plugin-evals/schema';
import { caseGrants, claudeNameOf, grantCovers, parseGrant } from '../plugin-evals/tools';
import { parseTranscript, traceLines } from '../plugin-evals/transcript';
import type { PluginEvalMockTool } from '../plugin-evals/types';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mocksDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-evals-mocks-'));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function mock(fields: Partial<PluginEvalMockTool>): PluginEvalMockTool {
  return { server: 's', tool: 't', body: '', error: false, expect: {}, dir: '/nowhere', ...fields };
}

describe('expect patterns', () => {
  it('accepts the dialect: literals, escapes, classes, quantifiers and anchors', () => {
    for (const source of ['^[a-z]+-\\d{2,4}$', 'abc', '.*', '\\w+@\\w+\\.com', '[^\\]]?x*']) {
      expect(dialectProblem(source)).toBeUndefined();
    }
  });

  it('refuses groups, alternation, backreferences, lazy quantifiers and stray anchors', () => {
    expect(dialectProblem('(ab)+')).toMatch(/group/);
    expect(dialectProblem('a|b')).toMatch(/alternation/);
    expect(dialectProblem('a\\1')).toMatch(/backreference/);
    expect(dialectProblem('a+?')).toMatch(/lazy/);
    expect(dialectProblem('a^b')).toMatch(/anchor/);
    expect(dialectProblem('*a')).toMatch(/nothing to repeat/);
    expect(dialectProblem('[ab')).toMatch(/unclosed/);
  });
});

describe('mocked tools', () => {
  it('checks types, patterns, literals and lists of the input', () => {
    const guarded = mock({
      expect: {
        title: { kind: 'type', type: 'string' },
        'meta.id': { kind: 'pattern', source: '^\\d+$', flags: '' },
        kind: { kind: 'literal', value: 'bug' },
        priority: { kind: 'oneOf', values: ['low', 'high'] },
      },
    });
    const valid = { title: 'x', meta: { id: '42' }, kind: 'bug', priority: 'low' };
    expect(expectViolation(guarded, valid)).toBeUndefined();
    expect(expectViolation(guarded, { ...valid, title: 3 })).toBe('title is not a string');
    expect(expectViolation(guarded, { ...valid, meta: { id: 'x' } })).toBe(
      'meta.id does not match /^\\d+$/'
    );
    expect(expectViolation(guarded, { ...valid, kind: 'task' })).toBe('kind is not "bug"');
    expect(expectViolation(guarded, { title: 'x' })).toBe('meta.id is missing');
  });

  it('fills input fields and fixture files into the answer', () => {
    const dir = mocksDir({ 'fixtures/42.json': '{"id":42}' });
    const answer = renderMock(
      mock({ dir, body: 'Issue {{input.title}} {{input.meta}} {{file:fixtures/{input.id}.json}}' }),
      { title: 'Broken', meta: { a: 1 }, id: 42 }
    );
    expect(answer).toBe('Issue Broken {"a":1} {"id":42}');
    expect(() => renderMock(mock({ dir, body: '{{file:../secret}}' }), {})).toThrow(
      'outside the mock directory'
    );
  });

  it('merges a case mock over the suite mock of the same tool and reads _tools.json', () => {
    const suite = mocksDir({
      'tracker/create.md': 'suite create',
      'tracker/list.md': 'suite list',
      'tracker/_tools.json':
        '[{"name":"list","description":"List issues","inputSchema":{"type":"object","properties":{}}}]',
    });
    const caseDir = mocksDir({ 'mocks/tracker/create.md': '---\nerror: true\n---\ncase create' });
    const { mocks } = loadMocks(suite, caseDir);
    expect(mocks.tracker?.map((m) => [m.tool, m.body, m.error])).toEqual([
      ['create', 'case create', true],
      ['list', 'suite list', false],
    ]);
    expect(mocks.tracker?.[1]?.description).toBe('List issues');
  });

  it('refuses agent mocks and invalid expect patterns with the file in the error', () => {
    const agent = mocksDir({
      'mocks/tracker/ask.md': '---\ntype: agent\n---\nAnswer as a tracker.',
    });
    expect(() => loadMocks(undefined, agent)).toThrow(
      /ask\.md: type: agent mocks are not supported/
    );
    const server = mocksDir({ 'mocks/tracker/_server.md': '---\ntools: [a]\n---\nx' });
    expect(() => loadMocks(undefined, server)).toThrow(/_server\.md agent mocks are not supported/);
    const pattern = mocksDir({
      'mocks/tracker/create.md': '---\nexpect:\n  title: /^(a|b)$/\n---\nx',
    });
    expect(() => loadMocks(undefined, pattern)).toThrow(/expect\.title has the pattern .*group/);
  });
});

describe('tool grants', () => {
  it('reads rules with and without a specifier', () => {
    expect(parseGrant('Write')).toEqual({ rule: 'Write', tool: 'Write' });
    expect(parseGrant('Bash(npm test *)')).toEqual({
      rule: 'Bash(npm test *)',
      tool: 'Bash',
      specifier: 'npm test *',
    });
    expect(parseGrant('Bash(*)')).toEqual({ rule: 'Bash(*)', tool: 'Bash' });
    expect(parseGrant('not a rule')).toHaveProperty('error');
  });

  it('grants the read-only tools a case lists and reports the rest', () => {
    const granted = caseGrants(
      ['Read', 'Skill', 'Write', 'Bash', 'NotebookRead'],
      [{ rule: 'Bash(npm test *)', tool: 'Bash', specifier: 'npm test *' }]
    );
    expect(granted).toEqual({
      grants: [
        { rule: 'Bash(npm test *)', tool: 'Bash', specifier: 'npm test *' },
        { rule: 'Read', tool: 'Read' },
        { rule: 'Skill', tool: 'Skill' },
        { rule: 'NotebookRead', tool: 'NotebookRead' },
      ],
      notGranted: ['Write'],
      noCounterpart: ['NotebookRead'],
    });
  });

  it('maps Claude Code names to Cogitator tools and back', () => {
    expect(grantCovers('Read', 'read_file')).toBe(true);
    expect(grantCovers('Skill', 'read_skill_file')).toBe(true);
    expect(grantCovers('Read', 'write_file')).toBe(false);
    expect(grantCovers('mcp__plugin_p_s__*', 'mcp__plugin_p_s__create')).toBe(true);
    expect(claudeNameOf('run_command')).toBe('Bash');
    expect(claudeNameOf('my_tool')).toBe('my_tool');
  });
});

describe('globs', () => {
  it('matches within and across path segments, classes and alternatives', () => {
    expect(globMatches('*.txt', 'card.txt')).toBe(true);
    expect(globMatches('*.txt', 'out/card.txt')).toBe(false);
    expect(globMatches('**/*.txt', 'out/deep/card.txt')).toBe(true);
    expect(globMatches('**/*.txt', 'card.txt')).toBe(true);
    expect(globMatches('{card,note}-[0-9].md', 'note-3.md')).toBe(true);
    expect(globMatches('gre?ts', 'greets')).toBe(true);
  });
});

describe('transcripts', () => {
  it('reads Claude Code session lines and writes them back as trace lines', () => {
    const text = [
      JSON.stringify({ type: 'summary', summary: 'skipped' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Read it' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'hidden' },
            { type: 'text', text: 'Reading.' },
            { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: '/a' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: 'body' }] },
          ],
        },
      }),
    ].join('\n');
    const entries = parseTranscript(text);
    expect(entries).toEqual([
      { role: 'user', text: 'Read it' },
      {
        role: 'assistant',
        text: 'Reading.',
        toolCalls: [{ id: 'u1', name: 'Read', input: { file_path: '/a' } }],
      },
      { role: 'tool', toolUseId: 'u1', name: 'Read', content: 'body', isError: false },
    ]);
    if ('error' in entries) throw new Error(entries.error);
    expect(parseTranscript(traceLines(entries).join('\n'))).toEqual(entries);
    expect(parseTranscript('{oops')).toEqual({ error: 'line 1 is not JSON' });
  });
});

describe('markdown files', () => {
  it('splits frontmatter from the body and treats a file without it as all body', () => {
    expect(readMarkdown('---\ntype: llm\n---\n\nPASS if x.\n')).toEqual({
      fields: { type: 'llm' },
      body: '\nPASS if x.\n',
    });
    expect(readMarkdown('Just a prompt')).toEqual({ fields: {}, body: 'Just a prompt' });
    expect(readMarkdown('---\n- a\n---\n')).toEqual({
      error: 'the frontmatter is not a YAML mapping',
    });
  });
});
