import { code } from '../code.js';

/** `src/lifecycle.ts`: graceful shutdown on SIGINT and SIGTERM for long-running processes. */
export const LIFECYCLE_TS = code`
  /**
   * Runs \`close\` once on SIGINT or SIGTERM, then exits. A shutdown that hangs,
   * for example on a stream that never ends, is cut off after \`timeoutMs\`.
   */
  export function onShutdown(close: () => Promise<void>, timeoutMs = 10_000): void {
    let closing = false;
    const stop = (signal: NodeJS.Signals) => {
      if (closing) return;
      closing = true;
      console.log(\`\${signal} received, shutting down\`);
      setTimeout(() => {
        console.error('Shutdown took too long, exiting');
        process.exit(1);
      }, timeoutMs).unref();
      close().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error(error);
          process.exit(1);
        }
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
`;
