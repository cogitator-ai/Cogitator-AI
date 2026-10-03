import { describe, it, expect, vi, afterEach } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import { banner } from '../utils/logger.js';

describe('banner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function render(version: string): string[] {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    banner(version);
    return stripVTControlCharacters(String(log.mock.calls[0][0]))
      .split('\n')
      .filter((line) => line.trim().length > 0);
  }

  it('shows the version it is given', () => {
    expect(render('0.2.0')[1]).toContain('create-cogitator-app  v0.2.0');
  });

  it('keeps the box closed around long versions', () => {
    const lines = render('10.12.3-beta.1');
    const widths = new Set(lines.map((line) => line.length));
    expect(widths.size).toBe(1);
    expect(lines[1]).toContain('v10.12.3-beta.1');
  });
});
