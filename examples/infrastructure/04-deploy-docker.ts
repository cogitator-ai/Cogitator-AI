import { header, section } from '../_shared/setup.js';
import { Deployer, ProjectAnalyzer } from '@cogitator-ai/deploy';
import { resolve } from 'node:path';

async function main() {
  header('04 — Deploy: Docker Deployment Planning');

  const projectDir = resolve(process.cwd());

  section('1. Analyze project');

  const analyzer = new ProjectAnalyzer();
  const analysis = analyzer.analyze(projectDir);

  console.log('Project analysis:');
  console.log(`  Server:     ${analysis.server ?? '(not detected)'}`);
  console.log(`  TypeScript: ${analysis.hasTypeScript}`);
  console.log(
    `  Services:   redis=${analysis.services.redis}, postgres=${analysis.services.postgres}`
  );
  console.log(
    `  Secrets:    ${analysis.secrets.length > 0 ? analysis.secrets.join(', ') : '(none detected)'}`
  );
  console.log(
    `  Warnings:   ${analysis.warnings.length > 0 ? analysis.warnings.join('; ') : '(none)'}`
  );

  section('2. Deploy config from analysis');

  console.log('Generated deploy config:');
  console.log(JSON.stringify(analysis.deployConfig, null, 2));

  section('3. Deployment planning');

  const deployer = new Deployer();

  const plan = await deployer.plan({
    projectDir,
    target: 'docker',
    noPush: true,
    configOverrides: {
      port: 3000,
      image: 'cogitator-example',
      services: { redis: true, postgres: false },
      health: { path: '/health', interval: '30s', timeout: '5s' },
      resources: { memory: '512Mi', cpu: 1 },
    },
  });

  console.log('Deploy plan:');
  console.log(`  Target:   docker`);
  console.log(`  Port:     ${plan.config.port}`);
  console.log(`  Image:    ${plan.config.image}`);
  console.log(
    `  Services: redis=${plan.config.services?.redis}, postgres=${plan.config.services?.postgres}`
  );

  console.log('\nPreflight checks:');
  for (const check of plan.preflight.checks) {
    const icon = check.passed ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${check.name}: ${check.message}`);
    if (check.fix) {
      console.log(`         Fix: ${check.fix}`);
    }
  }
  console.log(`\nPreflight ${plan.preflight.passed ? 'PASSED' : 'FAILED'}`);

  section('4. Dry-run deploy');

  const result = await deployer.deploy({
    projectDir,
    target: 'docker',
    dryRun: true,
    noPush: true,
    configOverrides: {
      port: 3000,
      image: 'cogitator-example',
      services: { redis: true },
      health: { path: '/health' },
    },
  });

  console.log('Dry-run result:');
  console.log(`  Success: ${result.success}`);
  console.log(`  URL:     ${result.url ?? '(none)'}`);
  if (result.error) {
    console.log(`  Error:   ${result.error}`);
  }

  section('5. Available providers');

  for (const target of ['docker', 'fly'] as const) {
    const provider = deployer.getProvider(target);
    console.log(`  ${provider.name}`);
  }

  console.log('\nDone.');
}

main();
