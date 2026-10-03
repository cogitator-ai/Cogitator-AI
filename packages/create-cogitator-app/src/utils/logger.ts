import pc from 'picocolors';

const MIN_INNER_WIDTH = 39;

interface BannerLine {
  text: string;
  width: number;
}

export function banner(version: string) {
  const title = 'create-cogitator-app';
  const tagline = 'Build AI agents in minutes';
  const versionLabel = `v${version}`;
  const lines: BannerLine[] = [
    {
      text: `${pc.bold(pc.white(title))}  ${pc.dim(versionLabel)}`,
      width: title.length + 2 + versionLabel.length,
    },
    { text: pc.dim(tagline), width: tagline.length },
  ];
  const inner = Math.max(MIN_INNER_WIDTH, ...lines.map((line) => line.width + 4));

  const art = [
    '',
    `  ${pc.cyan(`╔${'═'.repeat(inner)}╗`)}`,
    ...lines.map(
      (line) =>
        `  ${pc.cyan('║')}  ${line.text}${' '.repeat(inner - 2 - line.width)}${pc.cyan('║')}`
    ),
    `  ${pc.cyan(`╚${'═'.repeat(inner)}╝`)}`,
    '',
  ];
  console.log(art.join('\n'));
}
