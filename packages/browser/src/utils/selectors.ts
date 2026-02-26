import type { Page, Locator } from 'playwright';

export async function smartSelect(page: Page, identifier: string): Promise<Locator | null> {
  const cssLocator = page.locator(identifier);
  if ((await cssLocator.count()) > 0) return cssLocator.first();

  if (identifier.startsWith('//') || identifier.startsWith('(')) {
    const xpathLocator = page.locator(`xpath=${identifier}`);
    if ((await xpathLocator.count()) > 0) return xpathLocator.first();
  }

  const textLocator = page.getByText(identifier, { exact: false });
  if ((await textLocator.count()) > 0) return textLocator.first();

  return null;
}

export async function findFormField(page: Page, label: string): Promise<Locator | null> {
  const strategies: Array<() => Locator> = [
    () => page.locator(`input[name="${label}"]`),
    () => page.locator(`input[placeholder="${label}"]`),
    () => page.locator(`input[aria-label="${label}"]`),
    () => page.locator(`textarea[name="${label}"]`),
    () => page.locator(`textarea[placeholder="${label}"]`),
    () => page.locator(`select[name="${label}"]`),
    () => page.locator(`label:has-text("${label}") input`),
    () => page.locator(`label:has-text("${label}") textarea`),
    () => page.locator(`label:has-text("${label}") select`),
    () => page.getByLabel(label),
  ];

  for (const getLocator of strategies) {
    const locator = getLocator();
    if ((await locator.count()) > 0) return locator.first();
  }

  return null;
}
