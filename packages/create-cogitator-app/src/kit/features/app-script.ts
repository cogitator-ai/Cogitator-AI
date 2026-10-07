import { code } from '../code.js';
import { runScript } from '../package-manager.js';
import { hasFeature, primaryTarget, type ProjectSpec } from '../spec.js';
import { VERSIONS } from '../versions.js';
import type { FeatureModule } from './types.js';

/** The terminal chat over the assistant: one-shot from argv or stdin, a REPL otherwise. */
function agentEntry(spec: ProjectSpec): string {
  const harness = hasFeature(spec, 'harness');
  const persistent = spec.memory !== 'none';
  return code`
    import { createInterface${harness ? ', type Interface' : ''} } from 'node:readline/promises';
    import { styleText } from 'node:util';
    ${harness && "import type { ToolApprovalDecision, ToolApprovalRequest } from '@cogitator-ai/core';"}
    import { agents, cogitator } from './cogitator.js';
    import { loadEnv } from './env.js';
    ${harness && "import { facts } from './harness/facts.js';"}
    ${harness && "import { startScheduler } from './harness/scheduler.js';"}

    ${
      persistent
        ? code`
            /** One thread for the terminal, so the conversation carries over between runs. */
            const THREAD_ID = 'terminal';
          `
        : code`
            /** One thread per process: the project keeps no memory, so every start is a fresh conversation. */
            const THREAD_ID = \`terminal-\${process.pid}\`;
          `
    }

    async function readStdin(): Promise<string> {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks).toString('utf8').trim();
    }

    ${
      harness &&
      code`
        /** Asks in the terminal before a tool that changes something runs; without a terminal it is declined. */
        async function approve(request: ToolApprovalRequest, rl?: Interface): Promise<ToolApprovalDecision> {
          if (!rl) return { approved: false, reason: 'Nobody is at the terminal to approve it' };
          const answer = await rl.question(
            styleText('yellow', \`  \${request.toolName} wants to run with \${JSON.stringify(request.arguments)}. Allow? [y/N] \`)
          );
          return /^y(es)?$/i.test(answer.trim())
            ? { approved: true }
            : { approved: false, reason: 'Declined at the terminal' };
        }
      `
    }

    async function ask(input: string${harness ? ', rl?: Interface' : ''}): Promise<void> {
      let streamed = false;
      const result = await cogitator.run(agents.assistant, {
        input,
        threadId: THREAD_ID,
        stream: true,
        ${harness && 'context: { factsAboutTheUser: await facts.context() },'}
        onToken: (token) => {
          streamed = true;
          process.stdout.write(token);
        },
        onToolCall: (call) => {
          process.stderr.write(styleText('dim', \`\\n  > \${call.name} \${JSON.stringify(call.arguments)}\\n\`));
        },
        ${harness && 'onApproval: (request) => approve(request, rl),'}
      });

      if (!streamed) process.stdout.write(result.output);
      process.stdout.write('\\n');
      const { totalTokens, cost, duration } = result.usage;
      process.stderr.write(
        styleText('dim', \`  \${totalTokens} tokens, $\${cost.toFixed(4)}, \${(duration / 1000).toFixed(1)}s\\n\`)
      );
    }

    async function chat(): Promise<void> {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const closed = new Promise<null>((resolve) => rl.once('close', () => resolve(null)));
      rl.on('SIGINT', () => rl.close());
      ${
        harness &&
        code`
          let queue: Promise<void> = Promise.resolve();
          /** Runs one turn at a time, so a scheduled task never talks over the user. */
          const serially = (turn: () => Promise<void>) => {
            queue = queue.then(turn).catch((error: unknown) => {
              console.error(styleText('red', error instanceof Error ? error.message : String(error)));
            });
            return queue;
          };
          const scheduler = startScheduler((task) =>
            serially(async () => {
              console.log(styleText('magenta', '\\n[scheduled task]'));
              await ask(task, rl);
            })
          );
        `
      }

      console.log(
        styleText('bold', 'Chat with the assistant.') + styleText('dim', ' /exit or Ctrl+C to leave.')
      );
      try {
        for (;;) {
          const line = await Promise.race([rl.question(styleText('cyan', '> ')).catch(() => null), closed]);
          if (line === null) break;
          const input = line.trim();
          if (!input) continue;
          if (input === '/exit') break;
          ${
            harness
              ? 'await serially(() => ask(input, rl));'
              : code`
                  try {
                    await ask(input);
                  } catch (error) {
                    console.error(styleText('red', error instanceof Error ? error.message : String(error)));
                  }
                `
          }
        }
      } finally {
        ${harness && 'scheduler.stop();'}
        rl.close();
      }
    }

    async function main(): Promise<void> {
      loadEnv();
      const fromArgs = process.argv.slice(2).join(' ').trim();
      const input = fromArgs || (process.stdin.isTTY ? '' : await readStdin());
      if (input) await ask(input);
      else await chat();
    }

    main()
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      })
      .finally(async () => {
        ${harness && 'await facts.close();'}
        await cogitator.close();
      });
  `;
}

export const appScriptFeature: FeatureModule = {
  id: 'app:script',
  applies: (spec) => spec.app === 'script',
  apply(project) {
    const { spec } = project;
    const target = primaryTarget(spec);

    project
      .devDependency('tsx', VERSIONS.tsx)
      .script('dev', 'tsx watch --env-file-if-exists=.env src/index.ts')
      .script('build', 'tsc -p tsconfig.build.json')
      .script('start', 'node --env-file-if-exists=.env dist/index.js');
    if (target === 'agent') project.script('ask', 'tsx --env-file-if-exists=.env src/index.ts');
  },
  finalize(project) {
    const { spec } = project;
    const target = primaryTarget(spec);
    const pm = spec.packageManager;
    if (target === 'agent') project.file('src/index.ts', agentEntry(spec));
    project.section(
      'Running',
      target === 'agent'
        ? code`
            \`src/index.ts\` is a terminal chat with the assistant. \`${runScript(pm, 'dev')}\` opens it and restarts on change, \`${runScript(pm, 'ask', '"your question"')}\` answers once, and piped stdin works too. \`${runScript(pm, 'build')}\` then \`${runScript(pm, 'start')}\` runs the compiled build.
          `
        : code`
            \`src/index.ts\` runs the project's ${target}. \`${runScript(pm, 'dev')}\` runs it with reload on change, \`${runScript(pm, 'build')}\` then \`${runScript(pm, 'start')}\` runs the compiled build.
          `
    );
  },
};
