import type { Page, Locator } from 'playwright';

function escapeCssString(str: string): string {
  const escaped = str.replace(/["\\]/g, '\\$&');
  let result = '';
  for (const ch of escaped) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || code === 0x7f) {
      result += `\\${code.toString(16)} `;
    } else {
      result += ch;
    }
  }
  return result;
}

export async function smartSelect(page: Page, identifier: string): Promise<Locator | null> {
  try {
    const cssLocator = page.locator(identifier);
    if ((await cssLocator.count()) > 0) return cssLocator.first();
  } catch {}

  if (identifier.startsWith('//') || identifier.startsWith('(')) {
    try {
      const xpathLocator = page.locator(`xpath=${identifier}`);
      if ((await xpathLocator.count()) > 0) return xpathLocator.first();
    } catch {}
  }

  const textLocator = page.getByText(identifier, { exact: false });
  if ((await textLocator.count()) > 0) return textLocator.first();

  return null;
}

export async function findFormField(page: Page, label: string): Promise<Locator | null> {
  const escaped = escapeCssString(label);
  const strategies: Array<() => Locator> = [
    () => page.locator(`input[name="${escaped}"]`),
    () => page.locator(`input[placeholder="${escaped}"]`),
    () => page.locator(`input[aria-label="${escaped}"]`),
    () => page.locator(`textarea[name="${escaped}"]`),
    () => page.locator(`textarea[placeholder="${escaped}"]`),
    () => page.locator(`select[name="${escaped}"]`),
    () => page.locator(`label:text-is("${escaped}") input`),
    () => page.locator(`label:text-is("${escaped}") textarea`),
    () => page.locator(`label:text-is("${escaped}") select`),
    () => page.getByLabel(label),
  ];

  for (const getLocator of strategies) {
    const locator = getLocator();
    if ((await locator.count()) > 0) return locator.first();
  }

  return null;
}
