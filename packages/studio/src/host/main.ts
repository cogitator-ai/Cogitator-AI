import type { HostMessage, HostRequest } from '../protocol.js';
import { StudioHost } from './runner.js';

/**
 * The runtime host: a child process of `cogitator dev` that loads the project
 * with tsx and runs it for the studio. It is started again whenever the
 * project changes, so the studio always runs the current code.
 */
const [projectDir, studioDir] = process.argv.slice(2);

function send(message: HostMessage): Promise<void> {
  return new Promise((resolve) => {
    if (!process.send) return resolve();
    process.send(message, () => resolve());
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[studio host] unhandled rejection:', reason);
});
process.on('disconnect', () => process.exit(0));

if (!projectDir || !studioDir) {
  console.error('usage: host <projectDir> <studioDir>');
  process.exit(2);
}

try {
  const host = await StudioHost.create(projectDir, studioDir, (event) => {
    void send({ type: 'event', event });
  });
  process.on('message', (request: HostRequest) => {
    host.handle(request).then(
      (data) => send({ type: 'response', requestId: request.requestId, ok: true, data }),
      (error: unknown) =>
        send({
          type: 'response',
          requestId: request.requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
    );
  });
  process.once('SIGTERM', () => {
    void host.close().finally(() => process.exit(0));
  });
  await send({ type: 'ready', registry: host.registry(), memory: host.memory });
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(detail);
  await send({
    type: 'load-failed',
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
}
