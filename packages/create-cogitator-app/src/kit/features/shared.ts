import { code } from '../code.js';
import type { ProjectBuilder } from '../project.js';

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

/** The import lines of the startup steps features registered, for an entry point. */
export function startupImports(project: ProjectBuilder): string | false {
  return project.startup.imports.length > 0 && project.startup.imports.join('\n');
}

/** The startup steps features registered, run before the entry point starts serving. */
export function startupStatements(project: ProjectBuilder): string | false {
  return project.startup.statements.length > 0 && project.startup.statements.join('\n');
}
