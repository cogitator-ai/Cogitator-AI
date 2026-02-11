import * as p from '@clack/prompts';
import pc from 'picocolors';
import { banner } from './utils/logger.js';
import { parseArgs, collectOptions } from './prompts.js';
import { scaffold } from './scaffold.js';
import { devCommand } from './utils/package-manager.js';

async function main() {
  banner();

  p.intro(pc.cyan("Let's build something with AI agents"));

  const args = parseArgs(process.argv.slice(2));
  const options = await collectOptions(args);

  await scaffold(options);

  const dev = devCommand(options.packageManager);

  p.outro(
    [
      pc.green('Done! ') + 'Next steps:',
      '',
      `  ${pc.cyan('cd')} ${options.name}`,
      `  ${pc.cyan(dev)}`,
      '',
      pc.dim('Docs: https://cogitator.dev/docs'),
    ].join('\n')
  );
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
