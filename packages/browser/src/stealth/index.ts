import type { BrowserContext } from 'playwright';
import type { StealthConfig } from '@cogitator-ai/types';
import { getEvasionScripts } from './evasions';
import { getRandomUserAgent } from './user-agents';

export interface StealthContextOptions {
  userAgent?: string;
  locale?: string;
}

export async function applyStealthToContext(
  context: BrowserContext,
  config: StealthConfig,
  options: StealthContextOptions = {}
): Promise<void> {
  const scripts = getEvasionScripts({
    blockWebDriver: config.blockWebDriver,
    fingerprintRandomization: config.fingerprintRandomization,
    userAgent: options.userAgent,
    locale: options.locale,
  });

  for (const script of scripts) {
    await context.addInitScript(script);
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
  if (config.fingerprintRandomization === false) {
    return {};
  }
  return { userAgent: getRandomUserAgent(browser) };
}

export { getEvasionScripts } from './evasions';
export type { EvasionScriptsOptions } from './evasions';
export { humanLikeType, humanLikeClick, humanLikeHover, humanLikeScroll } from './human-like';
export type { HumanLikeClickOptions, HumanLikeHoverOptions } from './human-like';
export { getRandomUserAgent, getAllUserAgents } from './user-agents';
