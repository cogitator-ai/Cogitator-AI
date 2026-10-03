import * as p from '@clack/prompts';
import { readFileSync } from 'node:fs';
import pc from 'picocolors';
import { banner } from './utils/logger.js';
import { parseArgs, collectOptions } from './prompts.js';
import { scaffold } from './scaffold.js';
import { devCommand } from './utils/package-manager.js';
import { DOCS_URL } from './utils/links.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

async function main() {
  banner(pkg.version);

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
      pc.dim(`Docs: ${DOCS_URL}`),
    ].join('\n')
  );
}

main().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
