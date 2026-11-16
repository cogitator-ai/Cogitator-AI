import { claudeCodeAdapter, claudeToolCallHook } from '../../adapters/claude';
import { bridgePaths } from '../../paths';
import { mailText, waitForMail } from '../../waiter';

/**
 * What `cogitator bridge wait --hook claude-code` does, for the tests of this package, which
 * have no command line: wait for the mail of the session the hook belongs to, write it to
 * stderr and exit with code 2. As `bridge caller` it answers the hook that runs before a call of
 * a bridge tool.
 */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[1] === 'caller') {
    const input: Buffer[] = [];
    for await (const chunk of process.stdin) input.push(chunk as Buffer);
    const answer = claudeToolCallHook(Buffer.concat(input).toString('utf8'));
    if (answer !== undefined) process.stdout.write(answer);
    return 0;
  }
  const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at === -1 ? undefined : args[at + 1];
  };
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const caller = claudeCodeAdapter().identify?.({
    env: process.env,
    cwd: process.cwd(),
    hookInput: Buffer.concat(chunks).toString('utf8'),
  });
  if (!caller) return 1;
  const agentName = flag('--agent');
  const waited = await waitForMail({
    socketPath: bridgePaths({ home: flag('--home'), env: process.env }).socket,
    caller: { ...caller, ...(agentName && { agentName }) },
    timeoutMs: Number(flag('--timeout') ?? '600') * 1000,
    retryMs: 50,
  });
  if (waited.reason !== 'letters') return 0;
  process.stderr.write(`${mailText(waited.letters)}\n`);
  await waited.confirm().catch(() => undefined);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
);
