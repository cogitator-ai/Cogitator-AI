import {
  agent as createAgentApp,
  type AgentApp,
  type AgentContext,
} from '@agentclientprotocol/sdk';

/** What the fake agent did and was told, for assertions */
export interface FakeAgentLog {
  sessions: string[];
  prompts: Array<{ sessionId: string; text: string }>;
  permissions: Array<{ toolCallId: string; outcome: string }>;
  cancels: string[];
  modes: string[];
  errors: string[];
}

/**
 * A scripted ACP agent built with the SDK: on each prompt it speaks, thinks, sends a plan, asks
 * permission for a command and runs it in a terminal of the client, reads and writes a file
 * through the client, as the prompt asks (`speak`, `command`, `write <path>`, `read <path>`,
 * `wait`), then answers
 */
export function fakeAcpAgent(options: { sessionStarts?: Promise<void> } = {}): {
  app: AgentApp;
  log: FakeAgentLog;
} {
  const log: FakeAgentLog = {
    sessions: [],
    prompts: [],
    permissions: [],
    cancels: [],
    modes: [],
    errors: [],
  };
  const cancelled = new Map<string, () => void>();
  let next = 0;
  const update = (
    client: AgentContext,
    sessionId: string,
    value: Parameters<AgentContext['notify']>[1]
  ) => client.notify('session/update', { sessionId, update: value } as never);
  const app = createAgentApp({ name: 'fake-agent' })
    .onRequest('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
      authMethods: [{ id: 'fake', name: 'Fake login' }],
      agentInfo: { name: 'fake-agent', version: '1.0.0' },
    }))
    .onRequest('authenticate', () => ({}))
    .onRequest('session/new', async () => {
      await options.sessionStarts;
      const sessionId = `fake_${++next}`;
      log.sessions.push(sessionId);
      return {
        sessionId,
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
          ],
        },
      };
    })
    .onRequest('session/load', () => ({}))
    .onRequest('session/set_mode', ({ params }) => {
      log.modes.push(params.modeId);
      return {};
    })
    .onNotification('session/cancel', ({ params }) => {
      log.cancels.push(params.sessionId);
      cancelled.get(params.sessionId)?.();
    })
    .onRequest('session/prompt', async ({ params, client }) => {
      const sessionId = params.sessionId;
      const text = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('');
      log.prompts.push({ sessionId, text });
      const steps = text.split(';').map((step) => step.trim());
      const send = (value: Record<string, unknown>) => update(client, sessionId, value as never);
      for (const step of steps) {
        const [verb, ...rest] = step.split(' ');
        const arg = rest.join(' ');
        if (verb === 'speak') {
          await send({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'hmm' },
          });
          await send({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: arg },
          });
        } else if (verb === 'plan') {
          await send({
            sessionUpdate: 'plan',
            entries: [{ content: arg, priority: 'high', status: 'in_progress' }],
          });
        } else if (verb === 'bash') {
          try {
            const terminal = await client.createTerminal({
              sessionId,
              command: '/bin/bash',
              args: ['-c', arg],
            });
            await terminal.waitForExit();
            const output = await terminal.currentOutput();
            await terminal.release();
            await send({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `out:${output.output.trim()}` },
            });
          } catch (error) {
            log.errors.push(error instanceof Error ? error.message : String(error));
          }
        } else if (verb === 'exitplan' || verb === 'tool') {
          const id = `call_${++next}`;
          const switching = verb === 'exitplan';
          const answer = await client.request('session/request_permission', {
            sessionId,
            toolCall: {
              toolCallId: id,
              title: switching ? 'Ready to code?' : 'Something',
              kind: switching ? 'switch_mode' : 'other',
            },
            options: switching
              ? [
                  { optionId: 'acceptEdits', name: 'Yes, accept edits', kind: 'allow_always' },
                  { optionId: 'default', name: 'Yes', kind: 'allow_once' },
                  { optionId: 'plan', name: 'No, keep planning', kind: 'reject_once' },
                ]
              : [
                  { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
                ],
          });
          log.permissions.push({
            toolCallId: id,
            outcome: answer.outcome.outcome === 'selected' ? answer.outcome.optionId : 'cancelled',
          });
        } else if (verb === 'command') {
          const id = `call_${++next}`;
          const words = arg.split(' ');
          const extras = words.filter((word) => word.startsWith('@'));
          const command = words.filter((word) => !word.startsWith('@')).join(' ');
          const env = extras
            .filter((word) => word.startsWith('@env='))
            .map((word) => {
              const [name, value] = word.slice(5).split(':');
              return { name: name ?? '', value: value ?? '' };
            });
          const cwd = extras.find((word) => word.startsWith('@cwd='))?.slice(5);
          await send({
            sessionUpdate: 'tool_call',
            toolCallId: id,
            title: `\`${command}\``,
            kind: 'execute',
            status: 'pending',
            rawInput: { command },
          });
          const answer = await client.request('session/request_permission', {
            sessionId,
            toolCall: {
              toolCallId: id,
              title: `\`${command}\``,
              kind: 'execute',
              rawInput: { command },
            },
            options: [
              { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
              { optionId: 'always', name: 'Always', kind: 'allow_always' },
              { optionId: 'no', name: 'Reject', kind: 'reject_once' },
            ],
          });
          const outcome =
            answer.outcome.outcome === 'selected' ? answer.outcome.optionId : 'cancelled';
          log.permissions.push({ toolCallId: id, outcome });
          if (outcome !== 'yes' && outcome !== 'always') {
            await send({
              sessionUpdate: 'tool_call_update',
              toolCallId: id,
              status: 'failed',
              content: [{ type: 'content', content: { type: 'text', text: 'rejected' } }],
            });
            continue;
          }
          let terminal: Awaited<ReturnType<AgentContext['createTerminal']>>;
          try {
            terminal = await client.createTerminal({
              sessionId,
              command: '/bin/sh',
              args: ['-c', command],
              ...(env.length > 0 && { env }),
              ...(cwd !== undefined && { cwd }),
            });
          } catch (error) {
            log.errors.push(error instanceof Error ? error.message : String(error));
            await send({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed' });
            continue;
          }
          const exit = await terminal.waitForExit();
          const output = await terminal.currentOutput();
          await terminal.release();
          await send({
            sessionUpdate: 'tool_call_update',
            toolCallId: id,
            status: 'completed',
            rawOutput: { output: output.output.trim(), exitCode: exit.exitCode },
          });
        } else if (verb === 'write') {
          try {
            await client.request('fs/write_text_file', {
              sessionId,
              path: arg,
              content: 'written by agent\n',
            });
            await send({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: ' wrote' },
            });
          } catch (error) {
            log.errors.push(error instanceof Error ? error.message : String(error));
          }
        } else if (verb === 'read') {
          try {
            const read = await client.request('fs/read_text_file', {
              sessionId,
              path: arg,
              line: 1,
              limit: 1,
            });
            await send({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: ` read:${read.content}` },
            });
          } catch (error) {
            log.errors.push(error instanceof Error ? error.message : String(error));
          }
        } else if (verb === 'wait') {
          await send({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'waiting' },
          });
          await new Promise<void>((done) => cancelled.set(sessionId, done));
          return { stopReason: 'cancelled' };
        }
      }
      return { stopReason: 'end_turn' };
    });
  return { app, log };
}
