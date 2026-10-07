import { planProject, scaffold } from 'create-cogitator-app';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const spec = {
  name: 'my-agent',
  preset: 'basic',
  app: 'script',
  memory: 'sqlite',
  provider: 'ollama',
  model: 'qwen3.5:4b',
  packageManager: 'pnpm',
} as const;

const plan = planProject(spec);
console.log(`Planned ${plan.files.length} files, recreate with:\n  ${plan.command}`);

const directory = path.join(os.tmpdir(), `cogitator-scaffold-demo-${Date.now()}`);
console.log(`\nScaffolding to: ${directory}`);

const result = await scaffold(spec, {
  directory,
  install: false,
  git: false,
  log: {
    start: (message) => console.log(`  ... ${message}`),
    done: (message) => console.log(`  ok  ${message}`),
    fail: (message) => console.log(`  !!  ${message}`),
    warn: (message) => console.log(`  ??  ${message}`),
  },
});

console.log('\nGenerated files:');
for (const file of result.files) console.log(`  ${file}`);
console.log('\nDependencies:', Object.keys(result.plan.dependencies).join(', '));
console.log('Install:', result.install.status, '| git:', result.git.status);

fs.rmSync(directory, { recursive: true });
console.log('\nCleaned up temp directory.');
