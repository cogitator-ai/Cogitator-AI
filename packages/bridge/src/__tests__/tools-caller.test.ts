import { describe, expect, it } from 'vitest';
import { BridgeError } from '../errors';
import { TOOL_CALL_HINT_KEY, callerOfToolCall, withoutToolCallHint } from '../tools/caller';
import {
  BRIDGE_NOTES_END,
  BRIDGE_NOTES_START,
  bridgeNotes,
  hasBridgeNotes,
  withBridgeNotes,
  withoutBridgeNotes,
} from '../tools/guidance';

const CWD = '/work/demo';

describe('callerOfToolCall', () => {
  it('reads the session of Claude Code from the environment of the server', () => {
    const caller = callerOfToolCall({ args: { job: 1 } }, { CLAUDE_CODE_SESSION_ID: 's-1' }, CWD);

    expect(caller).toEqual({
      harness: 'claude-code',
      sessionId: 's-1',
      cwd: CWD,
      project: CWD,
    });
  });

  it('believes the hint of a hook over the environment, which is stale after /clear', () => {
    const caller = callerOfToolCall(
      {
        args: {
          job: 1,
          [TOOL_CALL_HINT_KEY]: { harness: 'claude-code', session: 's-2', cwd: '/work/demo/api' },
        },
      },
      { CLAUDE_CODE_SESSION_ID: 's-1' },
      CWD
    );

    expect(caller).toMatchObject({
      harness: 'claude-code',
      sessionId: 's-2',
      cwd: '/work/demo/api',
    });
  });

  it('reads the thread of Codex from what it sends with every call', () => {
    const caller = callerOfToolCall(
      {
        meta: {
          threadId: 't-1',
          'x-codex-turn-metadata': { thread_id: 't-1', turn_id: 'turn-3' },
        },
        client: 'codex-mcp-client',
      },
      {},
      CWD
    );

    expect(caller).toEqual({ harness: 'codex', sessionId: 't-1', cwd: CWD, project: CWD });
  });

  it('takes a bare thread id only from a client that says it is Codex', () => {
    expect(
      callerOfToolCall({ meta: { threadId: 't-1' }, client: 'codex-mcp-client' }, {}, CWD)
    ).toMatchObject({ harness: 'codex', sessionId: 't-1' });
    expect(
      callerOfToolCall({ meta: { threadId: 't-1' }, client: 'cursor' }, {}, CWD)
    ).toBeUndefined();
    expect(callerOfToolCall({ meta: { threadId: 't-1' } }, {}, CWD)).toBeUndefined();
  });

  it('knows no caller when nothing names a session', () => {
    expect(callerOfToolCall({ args: {}, meta: { progressToken: 1 } }, {}, CWD)).toBeUndefined();
  });

  it('ignores a hint that is not one', () => {
    const env = { CLAUDE_CODE_SESSION_ID: 's-1' };
    for (const hint of [
      'claude-code',
      { harness: 'claude-code' },
      { harness: 'claude-code', session: '' },
      { harness: 'claude code', session: 's-2' },
      { harness: 'claude-code', session: 's-2\nmore' },
      { harness: 'claude-code', session: 's-2', cwd: 'relative/folder' },
    ]) {
      expect(callerOfToolCall({ args: { [TOOL_CALL_HINT_KEY]: hint } }, env, CWD)).toMatchObject({
        sessionId: 's-1',
      });
    }
  });

  it('hands a session the bridge started the name it was given', () => {
    const env = {
      COGITATOR_BRIDGE_HARNESS: 'codex',
      COGITATOR_BRIDGE_AGENT: 'codex-2@demo',
      COGITATOR_BRIDGE_SESSION_NAME: 'reviewer',
    };

    expect(
      callerOfToolCall({ meta: { 'x-codex-turn-metadata': { thread_id: 't-9' } } }, env, CWD)
    ).toMatchObject({ sessionId: 't-9', agentName: 'codex-2@demo', sessionName: 'reviewer' });
  });

  it('keeps the name of a started session from a call of another harness', () => {
    const env = { COGITATOR_BRIDGE_HARNESS: 'claude', COGITATOR_BRIDGE_AGENT: 'claude-2@demo' };

    const caller = callerOfToolCall(
      { meta: { 'x-codex-turn-metadata': { thread_id: 't-9' } } },
      env,
      CWD
    );

    expect(caller).toMatchObject({ harness: 'codex', sessionId: 't-9' });
    expect(caller).not.toHaveProperty('agentName');
  });

  it('refuses to guess between two sessions the environment names', () => {
    const env = { CLAUDE_CODE_SESSION_ID: 's-1', CODEX_THREAD_ID: 't-1' };

    expect(() => callerOfToolCall({}, env, CWD)).toThrow(BridgeError);
    expect(
      callerOfToolCall({ meta: { 'x-codex-turn-metadata': { thread_id: 't-1' } } }, env, CWD)
    ).toMatchObject({ harness: 'codex', sessionId: 't-1' });
  });
});

describe('withoutToolCallHint', () => {
  it('gives the arguments as the model wrote them', () => {
    const args = { job: 1, [TOOL_CALL_HINT_KEY]: { harness: 'claude-code', session: 's-1' } };

    expect(withoutToolCallHint(args)).toEqual({ job: 1 });
    expect(args).toHaveProperty(TOOL_CALL_HINT_KEY);
  });

  it('returns arguments without a hint as they are', () => {
    const args = { job: 1 };

    expect(withoutToolCallHint(args)).toBe(args);
  });
});

describe('the notes of the bridge in an instructions file', () => {
  const notes = bridgeNotes();

  it('say who decides about a job of another agent', () => {
    expect(notes.startsWith(BRIDGE_NOTES_START)).toBe(true);
    expect(notes.endsWith(BRIDGE_NOTES_END)).toBe(true);
    expect(notes).toContain("needs the user's go");
    expect(bridgeNotes({ takeJobs: true })).toContain('without asking the user first');
    expect(bridgeNotes({ takeJobs: true })).not.toContain("needs the user's go");
  });

  it('go into an empty file', () => {
    expect(withBridgeNotes('', notes)).toBe(`${notes}\n`);
    expect(withBridgeNotes('\n\n', notes)).toBe(`${notes}\n`);
  });

  it('go to the end of a file, a blank line after what was there', () => {
    expect(withBridgeNotes('# Project\n\nRules.\n', notes)).toBe(
      `# Project\n\nRules.\n\n${notes}\n`
    );
    expect(withBridgeNotes('# Project', notes)).toBe(`# Project\n\n${notes}\n`);
  });

  it('replace the notes a file had, where they were', () => {
    const before = `# Project\n\n${bridgeNotes({ takeJobs: true })}\n\n## More\n`;

    const after = withBridgeNotes(before, notes);

    expect(after).toBe(`# Project\n\n${notes}\n\n## More\n`);
    expect(withBridgeNotes(after, notes)).toBe(after);
  });

  it('come out again and leave the file as it was', () => {
    for (const original of ['# Project\n\nRules.\n', '# Project', '']) {
      const removed = withoutBridgeNotes(withBridgeNotes(original, notes));
      expect(removed).toBe(original === '' ? '' : `${original.replace(/\n*$/, '')}\n`);
    }
    expect(withoutBridgeNotes(`# Project\n\n${notes}\n\n## More\n`)).toBe('# Project\n\n## More\n');
    expect(withoutBridgeNotes(`${notes}\n\n## More\n`)).toBe('## More\n');
  });

  it('come out with the blank lines around them, however many, and leave one', () => {
    const blankLines = '\n'.repeat(50_000);
    const before = `# Project\n${blankLines}${notes}\n${blankLines}## More\n`;

    expect(withoutBridgeNotes(before)).toBe('# Project\n\n## More\n');
  });

  it('are found only when they are whole', () => {
    expect(hasBridgeNotes(`# Project\n\n${notes}\n`)).toBe(true);
    expect(hasBridgeNotes('# Project\n')).toBe(false);
    expect(hasBridgeNotes(`# Project\n${BRIDGE_NOTES_START}\nhalf`)).toBe(false);
    expect(withoutBridgeNotes('# Project\n')).toBeUndefined();
  });
});
