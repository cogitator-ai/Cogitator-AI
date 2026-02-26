import type { BrowserContext } from 'playwright';
import type { StealthConfig } from '@cogitator-ai/types';
import { getEvasionScripts } from './evasions';
import { getRandomUserAgent } from './user-agents';

export async function applyStealthToContext(
  context: BrowserContext,
  config: StealthConfig
): Promise<void> {
  if (config.fingerprintRandomization !== false || config.blockWebDriver !== false) {
    for (const script of getEvasionScripts()) {
      await context.addInitScript(script);
    }
  }

  if (config.evasionScripts?.length) {
    for (const script of config.evasionScripts) {
      await context.addInitScript(script);
    }
  }
}

export function getStealthLaunchOptions(
  config: StealthConfig,
  browser?: 'chromium' | 'firefox' | 'webkit'
): Record<string, unknown> {
  return { userAgent: getRandomUserAgent(browser) };
}

export { getEvasionScripts } from './evasions';
export { humanLikeType, humanLikeClick, humanLikeScroll } from './human-like';
export { getRandomUserAgent, getAllUserAgents } from './user-agents';
