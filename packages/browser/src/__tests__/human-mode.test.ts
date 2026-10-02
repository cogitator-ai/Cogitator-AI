import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StealthConfig } from '@cogitator-ai/types';
import type { BrowserSession } from '../session';

vi.mock('../stealth/human-like', () => ({
  humanLikeClick: vi.fn().mockResolvedValue(undefined),
  humanLikeHover: vi.fn().mockResolvedValue(undefined),
  humanLikeScroll: vi.fn().mockResolvedValue(undefined),
}));

import { humanLikeClick, humanLikeHover, humanLikeScroll } from '../stealth/human-like';
import {
  createClickTool,
  createHoverTool,
  createScrollTool,
  createTypeTool,
} from '../tools/interaction';
import { createClickByDescriptionTool } from '../tools/vision';
import { usesHumanLikeMouse, usesHumanLikeTyping, humanTypingDelay } from '../utils/human-mode';

function createSession(stealth: StealthConfig | null) {
  const target = { click: vi.fn().mockResolvedValue(undefined) };
  const page = {
    click: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue({ evaluate: vi.fn().mockResolvedValue(undefined) }),
    getByRole: vi.fn().mockReturnValue({
      count: vi.fn().mockResolvedValue(1),
      nth: vi.fn().mockReturnValue(target),
    }),
  };
  const session = {
    page,
    stealthEnabled: stealth !== null,
    stealthConfig: stealth,
  } as unknown as BrowserSession;
  return { session, page, target };
}

const ctx = { agentId: 'a', runId: 'r', signal: new AbortController().signal };
const HUMAN: StealthConfig = { humanLikeMouse: true, humanLikeTyping: true };

describe('human-mode helpers', () => {
  it('detects human-like mouse and typing only when stealth enables them', () => {
    expect(usesHumanLikeMouse(createSession(null).session)).toBe(false);
    expect(usesHumanLikeMouse(createSession({ humanLikeMouse: false }).session)).toBe(false);
    expect(usesHumanLikeMouse(createSession(HUMAN).session)).toBe(true);
    expect(usesHumanLikeTyping(createSession({ humanLikeTyping: false }).session)).toBe(false);
    expect(usesHumanLikeTyping(createSession(HUMAN).session)).toBe(true);
  });

  it('typing delay stays within 50-150ms', () => {
    for (let i = 0; i < 100; i++) {
      const delay = humanTypingDelay();
      expect(delay).toBeGreaterThanOrEqual(50);
      expect(delay).toBeLessThanOrEqual(150);
    }
  });
});

describe('tools with stealth.humanLikeMouse', () => {
  beforeEach(() => {
    vi.mocked(humanLikeClick).mockClear();
    vi.mocked(humanLikeHover).mockClear();
    vi.mocked(humanLikeScroll).mockClear();
  });

  it('browser_click moves the mouse like a human and forwards click options', async () => {
    const { session, page } = createSession(HUMAN);
    await createClickTool(session).execute(
      { selector: '#buy', button: 'left', clickCount: 2, position: { x: 1, y: 2 } },
      ctx
    );

    expect(humanLikeClick).toHaveBeenCalledWith(page, '#buy', {
      button: 'left',
      clickCount: 2,
      position: { x: 1, y: 2 },
    });
    expect(page.click).not.toHaveBeenCalled();
  });

  it('browser_click uses a direct click when humanLikeMouse is disabled', async () => {
    const { session, page } = createSession({ humanLikeMouse: false });
    await createClickTool(session).execute({ selector: '#buy' }, ctx);

    expect(humanLikeClick).not.toHaveBeenCalled();
    expect(page.click).toHaveBeenCalledWith('#buy', expect.any(Object));
  });

  it('browser_hover moves along a curve', async () => {
    const { session, page } = createSession(HUMAN);
    await createHoverTool(session).execute({ selector: '#menu' }, ctx);

    expect(humanLikeHover).toHaveBeenCalledWith(page, '#menu', { position: undefined });
    expect(page.hover).not.toHaveBeenCalled();
  });

  it('browser_scroll hovers the target element then wheels in steps', async () => {
    const { session, page } = createSession(HUMAN);
    await createScrollTool(session).execute(
      { direction: 'left', amount: 300, selector: '#carousel' },
      ctx
    );

    expect(humanLikeHover).toHaveBeenCalledWith(page, '#carousel');
    expect(humanLikeScroll).toHaveBeenCalledWith(page, 'left', 300);
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('browser_click_by_description clicks the matched locator like a human', async () => {
    const { session, page, target } = createSession(HUMAN);
    const result = await createClickByDescriptionTool(session).execute(
      { description: 'Submit' },
      ctx
    );

    expect(result.clicked).toBe(true);
    expect(humanLikeClick).toHaveBeenCalledWith(page, target);
    expect(target.click).not.toHaveBeenCalled();
  });
});

describe('browser_type with stealth.humanLikeTyping', () => {
  it('replaces the existing value before typing keystrokes, matching fill() semantics', async () => {
    const { session, page } = createSession(HUMAN);
    await createTypeTool(session).execute({ selector: '#q', text: 'cats' }, ctx);

    expect(page.fill).toHaveBeenCalledWith('#q', '');
    expect(page.type).toHaveBeenCalledWith('#q', 'cats', { delay: expect.any(Number) });
    expect(page.fill.mock.invocationCallOrder[0]).toBeLessThan(
      page.type.mock.invocationCallOrder[0]
    );
  });

  it('appends with an explicit delay unless clearFirst is set', async () => {
    const { session, page } = createSession(null);
    await createTypeTool(session).execute({ selector: '#q', text: 'a', delay: 20 }, ctx);
    expect(page.fill).not.toHaveBeenCalled();

    await createTypeTool(session).execute(
      { selector: '#q', text: 'b', delay: 20, clearFirst: true },
      ctx
    );
    expect(page.fill).toHaveBeenCalledWith('#q', '');
  });
});
