import pc from 'picocolors';

export function banner() {
  const art = [
    '',
    `  ${pc.cyan('╔═══════════════════════════════════════╗')}`,
    `  ${pc.cyan('║')}  ${pc.bold(pc.white('create-cogitator-app'))}  ${pc.dim('v0.1.0')}       ${pc.cyan('║')}`,
    `  ${pc.cyan('║')}  ${pc.dim('Build AI agents in minutes')}          ${pc.cyan('║')}`,
    `  ${pc.cyan('╚═══════════════════════════════════════╝')}`,
    '',
  ];
  console.log(art.join('\n'));
}
