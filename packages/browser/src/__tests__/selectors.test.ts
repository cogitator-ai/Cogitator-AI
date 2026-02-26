import { describe, it, expect, vi } from 'vitest';
import { smartSelect, findFormField } from '../utils/selectors';

function createMockPage() {
  const locators = new Map<string, { count: number }>();

  const page = {
    locator: vi.fn().mockImplementation((sel: string) => ({
      count: vi.fn().mockResolvedValue(locators.get(sel)?.count ?? 0),
      first: vi.fn().mockReturnValue({ selector: sel }),
    })),
    getByText: vi.fn().mockReturnValue({
      count: vi.fn().mockResolvedValue(0),
      first: vi.fn().mockReturnValue({ selector: 'text' }),
    }),
    getByLabel: vi.fn().mockReturnValue({
      count: vi.fn().mockResolvedValue(0),
      first: vi.fn().mockReturnValue({ selector: 'label' }),
    }),
    _setLocatorCount(sel: string, count: number) {
      locators.set(sel, { count });
    },
  };

  return page;
}

describe('smartSelect', () => {
  it('finds element by CSS selector', async () => {
    const page = createMockPage();
    page._setLocatorCount('#main', 1);

    const result = await smartSelect(page as never, '#main');

    expect(result).toBeTruthy();
    expect(page.locator).toHaveBeenCalledWith('#main');
  });

  it('falls through to XPath when CSS fails', async () => {
    const page = createMockPage();
    page._setLocatorCount('xpath=//div[@id="test"]', 1);

    const result = await smartSelect(page as never, '//div[@id="test"]');

    expect(result).toBeTruthy();
    expect(page.locator).toHaveBeenCalledWith('xpath=//div[@id="test"]');
  });

  it('handles XPath expressions starting with (', async () => {
    const page = createMockPage();
    page._setLocatorCount('xpath=(//button)[1]', 1);

    const result = await smartSelect(page as never, '(//button)[1]');

    expect(result).toBeTruthy();
    expect(page.locator).toHaveBeenCalledWith('xpath=(//button)[1]');
  });

  it('falls through to text match when CSS and XPath fail', async () => {
    const page = createMockPage();
    page.getByText.mockReturnValue({
      count: vi.fn().mockResolvedValue(1),
      first: vi.fn().mockReturnValue({ selector: 'text-match' }),
    });

    const result = await smartSelect(page as never, 'Submit Order');

    expect(result).toBeTruthy();
    expect(page.getByText).toHaveBeenCalledWith('Submit Order', { exact: false });
  });

  it('returns null when nothing matches', async () => {
    const page = createMockPage();

    const result = await smartSelect(page as never, 'nonexistent');

    expect(result).toBeNull();
  });

  it('returns first element when multiple CSS matches', async () => {
    const page = createMockPage();
    page._setLocatorCount('.item', 5);

    const result = await smartSelect(page as never, '.item');

    expect(result).toBeTruthy();
  });

  it('does not try XPath for non-XPath identifiers', async () => {
    const page = createMockPage();

    await smartSelect(page as never, 'button.submit');

    const xpathCalls = page.locator.mock.calls.filter(
      (c: string[]) => typeof c[0] === 'string' && c[0].startsWith('xpath=')
    );
    expect(xpathCalls).toHaveLength(0);
  });
});

describe('findFormField', () => {
  it('finds input by name', async () => {
    const page = createMockPage();
    page._setLocatorCount('input[name="email"]', 1);

    const result = await findFormField(page as never, 'email');

    expect(result).toBeTruthy();
    expect(page.locator).toHaveBeenCalledWith('input[name="email"]');
  });

  it('falls back to placeholder', async () => {
    const page = createMockPage();
    page._setLocatorCount('input[placeholder="Email"]', 1);

    const result = await findFormField(page as never, 'Email');

    expect(result).toBeTruthy();
    expect(page.locator).toHaveBeenCalledWith('input[placeholder="Email"]');
  });

  it('falls back to aria-label', async () => {
    const page = createMockPage();
    page._setLocatorCount('input[aria-label="Search"]', 1);

    const result = await findFormField(page as never, 'Search');

    expect(result).toBeTruthy();
  });

  it('falls back to textarea name', async () => {
    const page = createMockPage();
    page._setLocatorCount('textarea[name="bio"]', 1);

    const result = await findFormField(page as never, 'bio');

    expect(result).toBeTruthy();
    expect(page.locator).toHaveBeenCalledWith('textarea[name="bio"]');
  });

  it('falls back to textarea placeholder', async () => {
    const page = createMockPage();
    page._setLocatorCount('textarea[placeholder="Tell us about yourself"]', 1);

    const result = await findFormField(page as never, 'Tell us about yourself');

    expect(result).toBeTruthy();
  });

  it('falls back to select name', async () => {
    const page = createMockPage();
    page._setLocatorCount('select[name="country"]', 1);

    const result = await findFormField(page as never, 'country');

    expect(result).toBeTruthy();
    expect(page.locator).toHaveBeenCalledWith('select[name="country"]');
  });

  it('falls back to label text with input', async () => {
    const page = createMockPage();
    page._setLocatorCount('label:has-text("Username") input', 1);

    const result = await findFormField(page as never, 'Username');

    expect(result).toBeTruthy();
  });

  it('falls back to label text with textarea', async () => {
    const page = createMockPage();
    page._setLocatorCount('label:has-text("Message") textarea', 1);

    const result = await findFormField(page as never, 'Message');

    expect(result).toBeTruthy();
  });

  it('falls back to label text with select', async () => {
    const page = createMockPage();
    page._setLocatorCount('label:has-text("Role") select', 1);

    const result = await findFormField(page as never, 'Role');

    expect(result).toBeTruthy();
  });

  it('falls back to getByLabel as last resort', async () => {
    const page = createMockPage();
    page.getByLabel.mockReturnValue({
      count: vi.fn().mockResolvedValue(1),
      first: vi.fn().mockReturnValue({ selector: 'label-match' }),
    });

    const result = await findFormField(page as never, 'Password');

    expect(result).toBeTruthy();
    expect(page.getByLabel).toHaveBeenCalledWith('Password');
  });

  it('returns null when no strategy matches', async () => {
    const page = createMockPage();

    const result = await findFormField(page as never, 'nonexistent');

    expect(result).toBeNull();
  });

  it('stops at first matching strategy', async () => {
    const page = createMockPage();
    page._setLocatorCount('input[name="user"]', 1);
    page._setLocatorCount('input[placeholder="user"]', 1);

    await findFormField(page as never, 'user');

    const placeholderCalls = page.locator.mock.calls.filter(
      (c: string[]) => c[0] === 'input[placeholder="user"]'
    );
    expect(placeholderCalls).toHaveLength(0);
  });

  it('escapes quotes in label for CSS selectors', async () => {
    const page = createMockPage();
    page._setLocatorCount('input[name="field\\"with\\"quotes"]', 1);

    const result = await findFormField(page as never, 'field"with"quotes');

    expect(result).toBeTruthy();
    expect(page.locator).toHaveBeenCalledWith('input[name="field\\"with\\"quotes"]');
  });

  it('escapes backslashes in label for CSS selectors', async () => {
    const page = createMockPage();
    page._setLocatorCount('input[name="path\\\\to\\\\field"]', 1);

    const result = await findFormField(page as never, 'path\\to\\field');

    expect(result).toBeTruthy();
    expect(page.locator).toHaveBeenCalledWith('input[name="path\\\\to\\\\field"]');
  });
});
