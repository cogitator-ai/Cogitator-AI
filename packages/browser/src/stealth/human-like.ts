import type { Page } from 'playwright';

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

export async function humanLikeType(page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector);
  for (const char of text) {
    await page.keyboard.type(char);
    await sleep(randomDelay(50, 150));
  }
}

export async function humanLikeClick(page: Page, selector: string): Promise<void> {
  const element = page.locator(selector);
  const box = await element.boundingBox();
  if (!box) {
    await element.click();
    return;
  }

  const targetX = box.x + box.width / 2 + randomDelay(-3, 3);
  const targetY = box.y + box.height / 2 + randomDelay(-3, 3);

  const startX = randomDelay(0, 100);
  const startY = randomDelay(0, 100);
  const steps = randomDelay(15, 25);
  const cp1x = startX + (targetX - startX) * 0.3 + randomDelay(-50, 50);
  const cp1y = startY + (targetY - startY) * 0.1 + randomDelay(-50, 50);
  const cp2x = startX + (targetX - startX) * 0.7 + randomDelay(-30, 30);
  const cp2y = startY + (targetY - startY) * 0.9 + randomDelay(-30, 30);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = bezierPoint(t, startX, cp1x, cp2x, targetX);
    const y = bezierPoint(t, startY, cp1y, cp2y, targetY);
    await page.mouse.move(x, y);
    await sleep(randomDelay(5, 15));
  }

  await page.mouse.click(targetX, targetY);
}

export async function humanLikeScroll(
  page: Page,
  direction: 'up' | 'down',
  amount: number
): Promise<void> {
  const steps = randomDelay(3, 8);
  const stepAmount = amount / steps;
  const dy = direction === 'down' ? stepAmount : -stepAmount;

  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy + randomDelay(-10, 10));
    await sleep(randomDelay(30, 80));
  }
}
