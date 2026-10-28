import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream } from '@agentclientprotocol/sdk';

let sessions = 0;
const cancels = new Map();

const app = agent({ name: 'fake-acp-agent' })
  .onRequest('initialize', () => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: false },
    authMethods: [{ id: 'fake', name: 'Fake login' }],
    agentInfo: { name: 'fake-acp-agent', version: '1.0.0' },
  }))
  .onRequest('authenticate', () => ({}))
  .onRequest('session/new', () => ({ sessionId: `fake_${++sessions}` }))
  .onNotification('session/cancel', ({ params }) => cancels.get(params.sessionId)?.())
  .onRequest('session/prompt', async ({ params, client }) => {
    const { sessionId } = params;
    const send = (update) => client.notify('session/update', { sessionId, update });
    const text = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('');
    for (const step of text.split(';').map((part) => part.trim())) {
      const [verb, ...rest] = step.split(' ');
      const arg = rest.join(' ');
      if (verb === 'speak') {
        await send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: arg } });
      } else if (verb === 'command') {
        const toolCallId = `call_${Date.now()}`;
        await send({
          sessionUpdate: 'tool_call',
          toolCallId,
          title: arg,
          kind: 'execute',
          rawInput: { command: arg },
        });
        const answer = await client.request('session/request_permission', {
          sessionId,
          toolCall: { toolCallId, title: arg, kind: 'execute', rawInput: { command: arg } },
          options: [
            { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        });
        if (answer.outcome.outcome !== 'selected' || answer.outcome.optionId !== 'yes') {
          await send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' });
          await send({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ' refused' },
          });
          continue;
        }
        const terminal = await client.createTerminal({
          sessionId,
          command: '/bin/sh',
          args: ['-c', arg],
        });
        await terminal.waitForExit();
        const output = await terminal.currentOutput();
        await terminal.release();
        await send({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'completed',
          rawOutput: output.output.trim(),
        });
        await send({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ` ran:${output.output.trim()}` },
        });
      } else if (verb === 'write') {
        await client.request('fs/write_text_file', {
          sessionId,
          path: arg,
          content: 'from the fake agent\n',
        });
        await send({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' wrote' },
        });
      } else if (verb === 'wait') {
        await new Promise((done) => cancels.set(sessionId, done));
        return { stopReason: 'cancelled' };
      }
    }
    return { stopReason: 'end_turn' };
  });

const connection = app.connect(
  ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
);
await connection.closed;
