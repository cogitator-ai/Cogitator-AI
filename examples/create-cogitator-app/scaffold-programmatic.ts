import { scaffold } from 'create-cogitator-app';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const outputDir = path.join(os.tmpdir(), `cogitator-scaffold-demo-${Date.now()}`);

console.log(`Scaffolding demo project to: ${outputDir}`);

await scaffold({
  name: 'my-agent',
  path: outputDir,
  template: 'basic',
  provider: 'ollama',
  packageManager: 'pnpm',
  docker: false,
  git: false,
});

const files = fs.readdirSync(outputDir, { recursive: true }) as string[];
console.log('\nGenerated files:');
for (const file of files.sort()) {
  console.log(`  ${file}`);
}

const pkgJson = JSON.parse(fs.readFileSync(path.join(outputDir, 'package.json'), 'utf-8'));
console.log('\npackage.json name:', pkgJson.name);
console.log('Dependencies:', Object.keys(pkgJson.dependencies).join(', '));

fs.rmSync(outputDir, { recursive: true });
console.log('\nCleaned up temp directory.');
