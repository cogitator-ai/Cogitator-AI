import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_TOOLS_PERMISSION,
  claudeCallerCommand,
  claudeCodeAdapter,
  claudeToolCallHook,
  claudeToolsHook,
  claudeToolsScope,
  claudeTrust,
  claudeWaitCommand,
  claudeWaitHook,
  hasClaudeToolsHook,
  hasClaudeWaitHook,
} from '../adapters/claude';
import {
  codexAdapter,
  codexReportNotice,
  codexThreadId,
  codexToolsServerArgs,
  codexTurnReport,
} from '../adapters/codex';
import { toolsServerEnv } from '../adapters/tools-server';
import { callerOfToolCall } from '../tools/caller';
import {
  CommandMissingError,
  MAX_ARGUMENT_BYTES,
  failureOf,
  fitsArgument,
  runCommand,
  sessionEnv,
  tooLongNotice,
} from '../adapters/exec';
import { renderLetter } from '../letters';
import type { BridgeJob } from '../types';
import { letterInput, tempDir } from './helpers';

let temp: { dir: string; remove: () => void };

beforeEach(() => {
  temp = tempDir();
});

afterEach(() => {
  temp.remove();
});

describe('the hook that wakes a Claude Code session', () => {
  it('runs in the background after every turn and wakes the session', () => {
    expect(claudeWaitHook()).toEqual({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command: 'cogitator bridge wait --hook claude-code --timeout 43140',
                timeout: 43200,
                async: true,
                asyncRewake: true,
              },
            ],
          },
        ],
      },
    });
  });

  it('ends its wait before the hook is ended, runs the command it is given and names the session', () => {
    expect(
      claudeWaitCommand({
        bridgeCommand: "/usr/bin/node '/opt/my tools/cli.js' bridge",
        timeoutS: 600,
        agentName: 'claude-2@demo',
      })
    ).toBe(
      "/usr/bin/node '/opt/my tools/cli.js' bridge wait --hook claude-code --timeout 540 --agent claude-2@demo"
    );
    expect(claudeWaitCommand({ timeoutS: 30 })).toContain('--timeout 1');
    expect(claudeWaitCommand({ timeoutS: 90.5 })).toMatch(/--timeout 30$/);
    expect(claudeWaitHook({ timeoutS: 90.5 }).hooks.Stop[0].hooks[0].timeout).toBe(91);
    expect(claudeWaitCommand({ bridgeHome: '/srv/my bridge' })).toBe(
      "cogitator bridge wait --hook claude-code --timeout 43140 --home '/srv/my bridge'"
    );
    expect(claudeWaitCommand({ agentName: "it's@demo" })).toContain("--agent 'it'\\''s@demo'");
    expect(claudeWaitCommand({ tools: true })).toMatch(/--timeout \d+ --tools$/);
  });

  it('is recognized in settings, whatever else they hold', () => {
    expect(hasClaudeWaitHook(claudeWaitHook({ bridgeCommand: 'node /x/cli.js bridge' }))).toBe(
      true
    );
    expect(
      hasClaudeWaitHook({
        permissions: { allow: ['Bash(ls)'] },
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'say done' }] },
            ...claudeWaitHook().hooks.Stop,
          ],
        },
      })
    ).toBe(true);
    expect(hasClaudeWaitHook({ hooks: { Stop: [{ hooks: [{ command: 'say done' }] }] } })).toBe(
      false
    );
    expect(
      hasClaudeWaitHook({
        hooks: { Stop: [{ hooks: [{ command: 'cogitator bridge wait', async: true }] }] },
      })
    ).toBe(false);
    expect(hasClaudeWaitHook(undefined)).toBe(false);
    expect(hasClaudeWaitHook({ hooks: 'none' })).toBe(false);
  });
});

describe('the hook that names the session of a bridge tool call', () => {
  it('runs before the tools of the bridge and of nothing else', () => {
    expect(claudeToolsHook()).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'mcp__bridge__.*',
            hooks: [
              {
                type: 'command',
                command: 'cogitator bridge caller --hook claude-code',
                timeout: 15,
              },
            ],
          },
        ],
      },
    });
    expect(CLAUDE_TOOLS_PERMISSION).toBe('mcp__bridge');
    expect(claudeCallerCommand({ bridgeCommand: '/usr/bin/node /opt/cli.js bridge' })).toBe(
      '/usr/bin/node /opt/cli.js bridge caller --hook claude-code'
    );
  });

  it('is found in settings that hold it, among other hooks', () => {
    const { PreToolUse } = claudeToolsHook({ bridgeCommand: 'node /x/cli.js bridge' }).hooks;

    expect(hasClaudeToolsHook({ hooks: { PreToolUse } })).toBe(true);
    expect(
      hasClaudeToolsHook({
        hooks: {
          PreToolUse: [
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] },
            ...PreToolUse,
          ],
        },
      })
    ).toBe(true);
    expect(hasClaudeToolsHook(claudeWaitHook())).toBe(false);
    expect(hasClaudeToolsHook({ hooks: { PreToolUse: [{ hooks: [{ command: 'lint' }] }] } })).toBe(
      false
    );
    expect(hasClaudeToolsHook(undefined)).toBe(false);
    expect(hasClaudeToolsHook('bridge caller')).toBe(false);
  });

  it('answers with the arguments of the call and the session that makes it', () => {
    const answer = claudeToolCallHook(
      JSON.stringify({
        session_id: 'session-after-clear',
        cwd: '/work/demo/api',
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__bridge__report',
        tool_input: { job: 7, result: 'Done' },
        tool_use_id: 'toolu_1',
      })
    );

    const output = JSON.parse(answer ?? '') as {
      hookSpecificOutput: { hookEventName: string; updatedInput: Record<string, unknown> };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput.updatedInput).toEqual({
      job: 7,
      result: 'Done',
      _bridge: { harness: 'claude-code', session: 'session-after-clear', cwd: '/work/demo/api' },
    });
    expect(
      callerOfToolCall(
        { args: output.hookSpecificOutput.updatedInput },
        { CLAUDE_CODE_SESSION_ID: 'session-before-clear' },
        '/work/demo'
      )
    ).toMatchObject({ sessionId: 'session-after-clear', cwd: '/work/demo/api' });
  });

  it('answers nothing to an input that is not that of a tool call', () => {
    expect(claudeToolCallHook('not json')).toBeUndefined();
    expect(claudeToolCallHook(JSON.stringify({ session_id: 's-1' }))).toBeUndefined();
    expect(claudeToolCallHook(JSON.stringify({ tool_input: { job: 1 } }))).toBeUndefined();
    expect(
      claudeToolCallHook(JSON.stringify({ session_id: 's-1', tool_input: 'text' }))
    ).toBeUndefined();
    expect(claudeCodeAdapter().toolCallHook?.({ env: {}, cwd: '/work' })).toBeUndefined();
  });

  it('is what the adapter answers a hook with', () => {
    const hookInput = JSON.stringify({ session_id: 's-1', tool_input: {} });

    expect(claudeCodeAdapter().toolCallHook?.({ env: {}, cwd: '/work', hookInput })).toBe(
      claudeToolCallHook(hookInput)
    );
  });
});

describe('where Claude Code has the tools of the bridge', () => {
  const server = { mcpServers: { bridge: { command: 'node' } } };

  it('finds them for this person in the project, for the project, and for every project', () => {
    const project = join(temp.dir, 'app');
    const inner = join(project, 'packages', 'api');
    mkdirSync(inner, { recursive: true });
    const config = join(temp.dir, 'claude.json');
    const write = (value: unknown) => writeFileSync(config, JSON.stringify(value));

    write({ projects: { [project]: { hasTrustDialogAccepted: true } } });
    expect(claudeToolsScope(inner, config)).toBeUndefined();

    write({ mcpServers: server.mcpServers });
    expect(claudeToolsScope(inner, config)).toBe('user');

    writeFileSync(join(project, '.mcp.json'), JSON.stringify(server));
    expect(claudeToolsScope(inner, config)).toBe('project');

    write({ projects: { [project]: server }, mcpServers: server.mcpServers });
    expect(claudeToolsScope(inner, config)).toBe('local');
    expect(claudeToolsScope(temp.dir, config)).toBe('user');
  });

  it('finds none when the record cannot be read, or names other servers', () => {
    const config = join(temp.dir, 'claude.json');

    expect(claudeToolsScope(temp.dir, join(temp.dir, 'absent.json'))).toBeUndefined();
    writeFileSync(config, '{broken');
    expect(claudeToolsScope(temp.dir, config)).toBeUndefined();
    writeFileSync(config, JSON.stringify({ mcpServers: { other: {} } }));
    expect(claudeToolsScope(temp.dir, config)).toBeUndefined();
  });
});

describe('the tools of a thread codex exec starts', () => {
  it('are given as overrides of the configuration, in TOML', () => {
    expect(
      codexToolsServerArgs(
        { command: '/usr/local/bin/node', args: ['/opt/my "cli"/index.js', 'bridge', 'mcp'] },
        toolsServerEnv({ harness: 'codex', agentName: 'codex-2@demo', sessionName: 'reviewer' })
      )
    ).toEqual([
      '-c',
      'mcp_servers.bridge.command="/usr/local/bin/node"',
      '-c',
      'mcp_servers.bridge.args=["/opt/my \\"cli\\"/index.js","bridge","mcp"]',
      '-c',
      'mcp_servers.bridge.env={COGITATOR_BRIDGE_HARNESS="codex",COGITATOR_BRIDGE_AGENT="codex-2@demo",COGITATOR_BRIDGE_SESSION_NAME="reviewer"}',
    ]);
    expect(codexToolsServerArgs({ command: 'node', args: [] })).toEqual([
      '-c',
      'mcp_servers.bridge.command="node"',
      '-c',
      'mcp_servers.bridge.args=[]',
    ]);
  });

  it('change what the thread is told about its report', () => {
    expect(codexReportNotice(3)).toContain('Your final answer of this turn is taken as the report');
    expect(codexReportNotice(3, true)).toBe(
      '[agent bridge] Report on job #3 with the report tool of the bridge. When the turn ends without a report, your final answer is taken as one.'
    );
  });
});

describe('whether Claude Code trusts a folder', () => {
  function config(projects: unknown): string {
    const path = join(temp.dir, 'claude.json');
    writeFileSync(path, JSON.stringify({ numStartups: 3, projects }));
    return path;
  }

  it('reads the record of the trust prompt, and takes the trust of a folder for what is inside', () => {
    const path = config({
      '/work/demo': { hasTrustDialogAccepted: true, allowedTools: [] },
      '/work/other': { hasTrustDialogAccepted: false },
    });

    expect(claudeTrust('/work/demo', path)).toBe('trusted');
    expect(claudeTrust('/work/demo/packages/core', path)).toBe('trusted');
    expect(claudeTrust('/work/other', path)).toBe('untrusted');
    expect(claudeTrust('/work', path)).toBe('untrusted');
    expect(claudeTrust('/elsewhere', path)).toBe('untrusted');
  });

  it('does not guess when the record cannot be read', () => {
    writeFileSync(join(temp.dir, 'broken.json'), '{ not json');

    expect(claudeTrust('/work/demo', join(temp.dir, 'missing.json'))).toBe('unknown');
    expect(claudeTrust('/work/demo', join(temp.dir, 'broken.json'))).toBe('unknown');
    expect(claudeTrust('/work/demo', config('nothing'))).toBe('unknown');
    expect(claudeTrust('/work/demo', config(undefined))).toBe('untrusted');
  });
});

describe('which session a process belongs to', () => {
  const claude = claudeCodeAdapter();
  const codex = codexAdapter({ logDir: '/unused' });

  it('takes a Claude Code session from what the harness wrote to its hook', () => {
    mkdirSync(join(temp.dir, '.git'));
    const nested = join(temp.dir, 'packages');
    mkdirSync(nested);

    expect(
      claude.identify?.({
        env: { CLAUDE_CODE_SESSION_ID: 'from-env' },
        cwd: '/somewhere/else',
        hookInput: JSON.stringify({
          session_id: 'from-hook',
          cwd: nested,
          hook_event_name: 'Stop',
        }),
      })
    ).toEqual({ harness: 'claude-code', sessionId: 'from-hook', cwd: nested, project: temp.dir });
  });

  it('falls back to the environment when the hook wrote nothing it can read', () => {
    const env = { CLAUDE_CODE_SESSION_ID: 'from-env' };

    expect(claude.identify?.({ env, cwd: temp.dir, hookInput: 'not json' })?.sessionId).toBe(
      'from-env'
    );
    expect(claude.identify?.({ env, cwd: temp.dir, hookInput: '{"cwd":"/x"}' })).toMatchObject({
      sessionId: 'from-env',
      cwd: temp.dir,
    });
    expect(claude.identify?.({ env, cwd: temp.dir })?.sessionId).toBe('from-env');
    expect(claude.identify?.({ env: {}, cwd: temp.dir })).toBeUndefined();
    expect(claude.identify?.({ env: { CODEX_THREAD_ID: 't' }, cwd: temp.dir })).toBeUndefined();
  });

  it('takes a Codex thread from its environment', () => {
    expect(codex.identify?.({ env: { CODEX_THREAD_ID: ' thread-1 ' }, cwd: temp.dir })).toEqual({
      harness: 'codex',
      sessionId: 'thread-1',
      cwd: temp.dir,
      project: temp.dir,
    });
    expect(
      codex.identify?.({ env: { CLAUDE_CODE_SESSION_ID: 's' }, cwd: temp.dir })
    ).toBeUndefined();
  });

  it('says what each adapter can do', () => {
    expect(claude).toMatchObject({
      harness: 'claude-code',
      delivery: 'hook',
      capabilities: { createSession: true, push: true, steer: false, nativeWindow: true },
    });
    expect(claude.deliver).toBeUndefined();
    expect(codex).toMatchObject({
      harness: 'codex',
      delivery: 'queue',
      capabilities: { createSession: true, push: true, steer: false, nativeWindow: true },
    });
    expect(codex.liveSessions).toBeUndefined();
  });
});

describe('the thread codex exec started', () => {
  it('is read from the first event that names one', () => {
    const output = [
      'Reading prompt from stdin...',
      '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"thread_id\\":\\"fake\\"}"}}',
    ].join('\n');

    expect(codexThreadId(output)).toBe('0199a213-81c0-7800-8aa1-bbab2a035a53');
  });

  it('is not there yet while the output has no whole event', () => {
    expect(codexThreadId('')).toBeUndefined();
    expect(codexThreadId('{"type":"thread.started","thread_id":"0199')).toBeUndefined();
    expect(
      codexThreadId('{"type":"turn.started"}\n{"thread_id":7}\n{"thread_id":"  "}')
    ).toBeUndefined();
    expect(codexThreadId('thread_id: abc')).toBeUndefined();
  });
});

describe('what a codex exec that ended leaves to report', () => {
  const message = (text: string): string =>
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
  const started = '{"type":"thread.started","thread_id":"0199a213"}\n{"type":"turn.started"}';

  it('is the last message of the thread, and done when it said nothing', () => {
    const output = [
      started,
      message('Looking at the folder'),
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls","aggregated_output":"b"}}',
      message('  Two files: README.md and b  '),
      '{"type":"turn.completed","usage":{"input_tokens":1}}',
    ].join('\n');

    expect(codexTurnReport(output, 0)).toEqual({
      body: 'Two files: README.md and b',
      failed: false,
    });
    expect(codexTurnReport(`${started}\n{"type":"turn.completed"}`, 0)).toEqual({
      body: 'Done',
      failed: false,
    });
    expect(codexTurnReport(`${started}\n${message('   ')}`, 0).body).toBe('Done');
  });

  it('is a failure with what codex said when it did not end well', () => {
    expect(codexTurnReport(`${started}\nError: usage limit reached\n`, 1)).toEqual({
      body: 'codex exec failed before the thread finished its turn: Error: usage limit reached',
      failed: true,
    });
    expect(codexTurnReport(started, null)).toEqual({
      body: 'codex exec failed before the thread finished its turn: it ended with a signal',
      failed: true,
    });
    expect(codexTurnReport(`${started}\n${message('Half way there')}`, 2)).toEqual({
      body:
        'codex exec failed before the thread finished its turn: it ended with exit code 2\n' +
        'Its last message: Half way there',
      failed: true,
    });
  });

  it('takes a turn codex calls failed for a failure, whatever the exit code', () => {
    const output = [
      started,
      '{"type":"error","message":"stream disconnected"}',
      '{"type":"turn.failed","error":{"message":"You have hit your usage limit"}}',
    ].join('\n');

    expect(codexTurnReport(output, 0)).toEqual({
      body: 'codex exec failed before the thread finished its turn: You have hit your usage limit',
      failed: true,
    });
    expect(codexTurnReport(`${started}\n{"type":"error","message":"reconnecting"}`, 0)).toEqual({
      body: 'Done',
      failed: false,
    });
  });
});

describe('running a command of a harness', () => {
  it('returns what it printed and how it ended', async () => {
    const result = await runCommand(
      process.execPath,
      [
        '-e',
        'process.stdin.on("data", (d) => process.stdout.write(`got ${d}`)); process.stderr.write("warned"); process.exitCode = 3',
      ],
      { input: 'hello' }
    );

    expect(result).toEqual({ code: 3, stdout: 'got hello', stderr: 'warned' });
  });

  it('says so when the command is not installed', async () => {
    const missing = runCommand('surely-no-such-harness', ['--version']);

    await expect(missing).rejects.toBeInstanceOf(CommandMissingError);
    await expect(missing).rejects.toThrow(
      'surely-no-such-harness is not installed, or not on PATH'
    );
  });

  it('does not wait for a process the command left behind with its pipes', async () => {
    const started = Date.now();
    const result = await runCommand(process.execPath, [
      '-e',
      `const { spawn } = require('node:child_process');
       spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'inherit', detached: true }).unref();
       process.stdout.write('started');`,
    ]);

    expect(result).toMatchObject({ code: 0, stdout: 'started' });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('says the folder is missing rather than the command', async () => {
    await expect(
      runCommand(process.execPath, ['--version'], { cwd: join(temp.dir, 'no-such-folder') })
    ).rejects.toThrow(`The folder ${join(temp.dir, 'no-such-folder')} does not exist`);
  });

  it('gives up on a command that does not end', async () => {
    await expect(
      runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 })
    ).rejects.toThrow(/did not answer in 0 s/);
  });

  it('runs in the folder and the environment it is given', async () => {
    const result = await runCommand(
      process.execPath,
      ['-e', 'process.stdout.write(`${process.cwd()}|${process.env.MARK}`)'],
      { cwd: temp.dir, env: { ...process.env, MARK: 'here' } }
    );

    expect(result.stdout.endsWith(`${temp.dir.split('/').pop()}|here`)).toBe(true);
  });

  it('describes a failure in the words of the command', () => {
    expect(
      failureOf({ code: 1, stdout: 'ignored', stderr: 'Error: no session\n  at x\n  at y\n  at z' })
    ).toBe('Error: no session   at x   at y');
    expect(failureOf({ code: 1, stdout: 'only stdout', stderr: '  ' })).toBe('only stdout');
    expect(failureOf({ code: 7, stdout: '', stderr: '' })).toBe('it ended with exit code 7');
    expect(failureOf({ code: null, stdout: '', stderr: '' })).toBe('it ended with a signal');
  });
});

describe('what a session the bridge starts is given', () => {
  it('gets the name the bridge knows it by, and no session id of the harness around the dispatcher', () => {
    const env = sessionEnv(
      {
        PATH: '/usr/bin',
        CLAUDE_CODE_SESSION_ID: 'the-orchestrator',
        CODEX_THREAD_ID: 'another',
        COGITATOR_BRIDGE_SESSION_NAME: 'old',
      },
      { harness: 'codex', agentName: 'codex-2@demo' }
    );

    expect(env).toEqual({
      PATH: '/usr/bin',
      COGITATOR_BRIDGE_HARNESS: 'codex',
      COGITATOR_BRIDGE_AGENT: 'codex-2@demo',
    });
    const fromInside = sessionEnv(
      {
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/1.sock',
        CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
        CLAUDE_PROJECT_DIR: '/work/other',
        CLAUDE_CONFIG_DIR: '/custom/claude',
        CLAUDE_CODE_USE_BEDROCK: '1',
        COGITATOR_BRIDGE_HOME: '/srv/bridge',
      },
      { harness: 'codex', agentName: 'codex@demo' }
    );
    expect(fromInside).toEqual({
      CLAUDE_CONFIG_DIR: '/custom/claude',
      CLAUDE_CODE_USE_BEDROCK: '1',
      COGITATOR_BRIDGE_HOME: '/srv/bridge',
      COGITATOR_BRIDGE_HARNESS: 'codex',
      COGITATOR_BRIDGE_AGENT: 'codex@demo',
    });
    expect(
      sessionEnv({}, { harness: 'codex', agentName: 'a', sessionName: 'reviewer' })
        .COGITATOR_BRIDGE_SESSION_NAME
    ).toBe('reviewer');
  });

  it('gets a notice in place of a letter too long for an argument', () => {
    const job = { number: 7, title: 'Port the parser' } as BridgeJob;
    const long = renderLetter(
      { ...letterInput({ job: 7, body: 'x'.repeat(MAX_ARGUMENT_BYTES + 1) }), seq: 1 },
      job
    );
    const short = renderLetter({ ...letterInput({ job: 7 }), seq: 1 }, job);

    expect(fitsArgument(short.text)).toBe(true);
    expect(fitsArgument(long.text)).toBe(false);
    expect(fitsArgument('я'.repeat(MAX_ARGUMENT_BYTES / 2))).toBe(true);
    expect(fitsArgument('я'.repeat(MAX_ARGUMENT_BYTES / 2 + 1))).toBe(false);
    expect(tooLongNotice(long).split('\n')).toEqual([
      '[agent bridge] job #7 "Port the parser" | task from claude@demo to codex@demo | letter ltr_1 | not typed by the user',
      'This letter is 120001 characters long, too long to hand over here. Read it from the bridge: cogitator bridge inbox --job 7',
    ]);
    expect(tooLongNotice(long, { bridgeCommand: '/usr/bin/node /opt/cli.js bridge' })).toContain(
      'Read it from the bridge: /usr/bin/node /opt/cli.js bridge inbox --job 7'
    );
    expect(tooLongNotice(long, { tools: true, bridgeHome: '/srv/my bridge' })).toContain(
      "Read it with the inbox tool of the bridge (job 7), or from a shell: cogitator bridge inbox --job 7 --home '/srv/my bridge'"
    );
  });
});
