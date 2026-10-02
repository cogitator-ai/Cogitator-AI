import type { Locator, Page } from 'playwright';
import type { MouseButton, ScrollDirection } from '@cogitator-ai/types';

export interface HumanLikeClickOptions {
  from?: { x: number; y: number };
  button?: MouseButton;
  clickCount?: number;
  position?: { x: number; y: number };
}

export interface HumanLikeHoverOptions {
  from?: { x: number; y: number };
  position?: { x: number; y: number };
}

interface Point {
  x: number;
  y: number;
}

const mousePositions = new WeakMap<Page, Point>();

function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bezierPoint(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function defaultMouseOrigin(page: Page): Point {
  const known = mousePositions.get(page);
  if (known) return known;
  const viewport = typeof page.viewportSize === 'function' ? page.viewportSize() : null;
  if (viewport) {
    return {
      x: Math.max(0, Math.round(viewport.width * (0.25 + Math.random() * 0.5))),
      y: Math.max(0, Math.round(viewport.height * (0.25 + Math.random() * 0.5))),
    };
  }
  return { x: randomDelay(0, 100), y: randomDelay(0, 100) };
}

function toLocator(page: Page, target: string | Locator): Locator {
  return typeof target === 'string' ? page.locator(target).first() : target;
}

async function resolveTargetPoint(locator: Locator, position?: Point): Promise<Point | null> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) return null;
  if (position) {
    return { x: box.x + position.x, y: box.y + position.y };
  }
  const jitterX = Math.min(3, box.width / 4);
  const jitterY = Math.min(3, box.height / 4);
  return {
    x: box.x + box.width / 2 + (Math.random() * 2 - 1) * jitterX,
    y: box.y + box.height / 2 + (Math.random() * 2 - 1) * jitterY,
  };
}

async function moveMouseAlongCurve(page: Page, from: Point, to: Point): Promise<void> {
  const steps = randomDelay(15, 25);
  const cp1x = from.x + (to.x - from.x) * 0.3 + randomDelay(-50, 50);
  const cp1y = from.y + (to.y - from.y) * 0.1 + randomDelay(-50, 50);
  const cp2x = from.x + (to.x - from.x) * 0.7 + randomDelay(-30, 30);
  const cp2y = from.y + (to.y - from.y) * 0.9 + randomDelay(-30, 30);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = bezierPoint(t, from.x, cp1x, cp2x, to.x);
    const y = bezierPoint(t, from.y, cp1y, cp2y, to.y);
    await page.mouse.move(x, y);
    await sleep(randomDelay(5, 15));
  }
  mousePositions.set(page, { x: to.x, y: to.y });
}

export async function humanLikeType(page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector);
  for (const char of text) {
    await page.keyboard.type(char);
    await sleep(randomDelay(50, 150));
  }
}

export async function humanLikeClick(
  page: Page,
  target: string | Locator,
  options: HumanLikeClickOptions = {}
): Promise<void> {
  const locator = toLocator(page, target);
  const point = await resolveTargetPoint(locator, options.position);
  if (!point) {
    await locator.click({
      button: options.button,
      clickCount: options.clickCount,
      position: options.position,
    });
    return;
  }

  await moveMouseAlongCurve(page, options.from ?? defaultMouseOrigin(page), point);
  await sleep(randomDelay(30, 90));
  await page.mouse.click(point.x, point.y, {
    button: options.button,
    clickCount: options.clickCount,
    delay: randomDelay(40, 110),
  });
}

export async function humanLikeHover(
  page: Page,
  target: string | Locator,
  options: HumanLikeHoverOptions = {}
): Promise<void> {
  const locator = toLocator(page, target);
  const point = await resolveTargetPoint(locator, options.position);
  if (!point) {
    await locator.hover({ position: options.position });
    return;
  }
  await moveMouseAlongCurve(page, options.from ?? defaultMouseOrigin(page), point);
}

export async function humanLikeScroll(
  page: Page,
  direction: ScrollDirection,
  amount: number
): Promise<void> {
  const steps = randomDelay(3, 8);
  const stepAmount = amount / steps;
  const sign = direction === 'down' || direction === 'right' ? 1 : -1;
  const horizontal = direction === 'left' || direction === 'right';
  const jitter = Math.max(1, Math.min(10, Math.floor(Math.abs(stepAmount) * 0.3)));

  for (let i = 0; i < steps; i++) {
    const delta = sign * stepAmount + randomDelay(-jitter, jitter);
    await page.mouse.wheel(horizontal ? delta : 0, horizontal ? 0 : delta);
    await sleep(randomDelay(30, 80));
  }
}
