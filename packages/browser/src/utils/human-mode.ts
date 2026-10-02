import type { BrowserSession } from '../session';

export function usesHumanLikeMouse(session: BrowserSession): boolean {
  return session.stealthEnabled && session.stealthConfig?.humanLikeMouse === true;
}

export function usesHumanLikeTyping(session: BrowserSession): boolean {
  return session.stealthEnabled && session.stealthConfig?.humanLikeTyping === true;
}

export function humanTypingDelay(): number {
  return Math.floor(Math.random() * 101) + 50;
}
