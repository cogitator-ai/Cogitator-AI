'use client';

import { useEffect } from 'react';
import { GITHUB_URL, LLMS_TXT_URL } from '@/lib/site';
import { LOGO_COLORS } from '@/lib/logo';

/** The mark in half-block characters: each row is [brain part, gear part]. */
const MARK: [string, string][] = [
  ['             ▄▄▄', ''],
  ['          ▄██████', ' ██'],
  ['       ▄▄████████', ' ██▄     ▄▄'],
  ['      ███████████', ' █████▄█████'],
  ['     ▄███▀▀██████', ' ██████████▀'],
  ['   ▄█████  ██████', ' ▀████████▄'],
  ['   ███████▄ ▀▀███', '    ▀██████▄'],
  ['  ▄█████████▄▄ ▀█', '     ▀█████████'],
  ['  ████████████  █', '      █████████'],
  ['   ███▀▀▀████████', '     ███████▀▀▀'],
  ['   ███▄▄▄  ██████', '  ▄▄███████'],
  ['   ▀██████  █████', ' █████████▄'],
  ['     ▀████▄▄█████', ' ███████████'],
  ['      ▀██████████', ' ███▀▀ ▀▀██▀'],
  ['        ▀▀███████', ' ██'],
  ['           ▀████▀', ' ▀▀'],
];

const CAPTION = [
  '+++ COGITATOR ONLINE +++',
  'the machine spirit is listening',
  '',
  `docs for your agent: ${LLMS_TXT_URL}`,
  `source: ${GITHUB_URL}`,
];

const MONO = 'font-family:monospace;font-size:12px;line-height:1.15';

let greeted = false;

/** A one-time greeting for whoever opens the browser console: the logo, then a short vox line. */
export function ConsoleGreeting() {
  useEffect(() => {
    if (greeted) return;
    greeted = true;
    const lines = MARK.map(([brain, gear]) => `%c${brain}%c${gear}`).join('\n');
    const styles = MARK.flatMap(() => [
      `${MONO};color:${LOGO_COLORS.phosphor}`,
      `${MONO};color:${LOGO_COLORS.brass}`,
    ]);
    console.info(`\n${lines}\n`, ...styles);
    console.info(`%c${CAPTION.join('\n')}`, `${MONO};color:${LOGO_COLORS.phosphor}`);
  }, []);
  return null;
}
