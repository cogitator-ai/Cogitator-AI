import { describe, expect, it } from 'vitest';
import {
  handoffSections,
  JUNK_ANSWERS,
  MENTIONS,
  runCompactionLossSuite,
  StubChapterModel,
  type Mention,
} from '../compaction-loss.js';

const failed = (checks: Awaited<ReturnType<typeof runCompactionLossSuite>>) =>
  checks.filter((check) => !check.passed).map((check) => `${check.strategy}: ${check.name}`);

const without = (trigger: string): Mention[] =>
  MENTIONS.filter((mention) => mention.trigger !== trigger);

describe('compaction loss suite', () => {
  it('passes under a tail of entries and a tail of tokens', async () => {
    const checks = await runCompactionLossSuite();
    expect(new Set(checks.map((check) => check.strategy))).toEqual(new Set(['entries', 'tokens']));
    expect(checks.length).toBeGreaterThanOrEqual(16);
    expect(failed(checks)).toEqual([]);
  });

  it('fails when the model never names an open item', async () => {
    const checks = await runCompactionLossSuite(
      undefined,
      without('write the release notes for v2')
    );
    expect(failed(checks)).toEqual(
      expect.arrayContaining([
        'entries: open items: every planted open control item is in the handoff',
        'entries: open items: every planted open control item is an open atom of the levels',
      ])
    );
    const detail = checks.find((check) => !check.passed)?.detail ?? '';
    expect(detail).toContain('Write the release notes for v2');
  });

  it('fails when the task closed with evidence is never closed', async () => {
    const checks = await runCompactionLossSuite(undefined, without('The login redirect is fixed'));
    expect(failed(checks)).toContain(
      'tokens: done: an item closed with evidence that holds shows as done, not open'
    );
  });

  it('fails the unsupported close when the claim was never made, instead of passing empty', async () => {
    const checks = await runCompactionLossSuite(undefined, without('get to the API docs'));
    const check = checks.find(
      (item) => item.strategy === 'entries' && item.name.startsWith('unsupported close')
    );
    expect(check?.passed).toBe(false);
    expect(check?.detail).toBe('the stub never made the unsupported claim');
  });

  it('fails the marks when a grounded atom comes with a quote that does not hold', async () => {
    const misquoted = MENTIONS.map((mention) =>
      mention.trigger === 'Never push directly to main'
        ? { ...mention, quote: 'never ever push to main' }
        : mention
    );
    const checks = await runCompactionLossSuite(undefined, misquoted);
    const marks = checks.find(
      (item) => item.strategy === 'entries' && item.name.startsWith('unverified')
    );
    expect(marks?.passed).toBe(false);
    expect(marks?.detail).toContain('Never push directly to main');
  });
});

describe('StubChapterModel', () => {
  const transcript = (lines: string[]) => [{ role: 'user' as const, content: lines.join('\n') }];

  it('answers junk every fourth call and names an item only the first time it reads it', async () => {
    const model = new StubChapterModel();
    const window = transcript([
      '[0] user: Never push directly to main, always open a pull request.',
    ]);
    const first = await model.summarize(window);
    expect(first).toContain('"constraint"');
    expect(first).toContain('"message":0');
    expect(JUNK_ANSWERS).toContain(await model.summarize(window));
    expect(await model.summarize(window)).toContain('[]');
    expect(model.junk).toBe(1);
    expect(model.said.has('Never push directly to main')).toBe(true);
  });

  it('gives a misquote or a message out of the window where it is told to', async () => {
    const model = new StubChapterModel();
    const answer = await model.summarize(
      transcript([
        '[0] user: The team ships releases on Fridays.',
        '[1] user: The API has to stay backwards compatible for old clients.',
      ])
    );
    expect(answer).toContain('"quote":"the team always ships on Friday"');
    expect(answer).toContain('"message":999');
  });
});

describe('handoffSections', () => {
  it('reads the bullets of each section', () => {
    const sections = handoffSections(
      '[Conversation summary]\n## Open tasks\n- One\n- Two (unverified)\n\n## Done\n- Three'
    );
    expect(sections.get('Open tasks')).toEqual(['One', 'Two (unverified)']);
    expect(sections.get('Done')).toEqual(['Three']);
  });
});
