import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchImageAsBase64, isDataUrl, parseDataUrl, resolveImage } from '../utils/image-fetch';

describe('image-fetch utils', () => {
  describe('isDataUrl', () => {
    it('returns true for data URLs', () => {
      expect(isDataUrl('data:image/png;base64,abc123')).toBe(true);
      expect(isDataUrl('data:image/jpeg;base64,xyz')).toBe(true);
    });

    it('returns false for regular URLs', () => {
      expect(isDataUrl('https://example.com/image.png')).toBe(false);
      expect(isDataUrl('http://example.com/image.jpg')).toBe(false);
      expect(isDataUrl('/path/to/image.png')).toBe(false);
    });
  });

  describe('parseDataUrl', () => {
    it('parses valid data URL', () => {
      const result = parseDataUrl('data:image/png;base64,iVBORw0KGgo=');
      expect(result).toEqual({
        data: 'iVBORw0KGgo=',
        mediaType: 'image/png',
      });
    });

    it('parses jpeg data URL', () => {
      const result = parseDataUrl('data:image/jpeg;base64,/9j/4AAQ=');
      expect(result).toEqual({
        data: '/9j/4AAQ=',
        mediaType: 'image/jpeg',
      });
    });

    it('normalizes unknown media types to jpeg', () => {
      const result = parseDataUrl('data:image/bmp;base64,abc123');
      expect(result).toEqual({
        data: 'abc123',
        mediaType: 'image/jpeg',
      });
    });

    it('returns null for invalid data URL', () => {
      expect(parseDataUrl('not-a-data-url')).toBe(null);
      expect(parseDataUrl('data:text/plain;base64,abc')).toEqual({
        data: 'abc',
        mediaType: 'image/jpeg',
      });
    });

    it('returns null for malformed data URL', () => {
      expect(parseDataUrl('data:image/png,abc')).toBe(null);
    });
  });

  describe('fetchImageAsBase64', () => {
    const mockFetch = vi.fn();
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = mockFetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
      mockFetch.mockReset();
    });

    it('fetches image and converts to base64', async () => {
      const imageData = new Uint8Array([137, 80, 78, 71]);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: () => Promise.resolve(imageData.buffer),
      });

      const result = await fetchImageAsBase64('https://example.com/image.png');

      expect(result.mediaType).toBe('image/png');
      expect(result.data).toBe(Buffer.from(imageData).toString('base64'));
      expect(mockFetch).toHaveBeenCalledWith('https://example.com/image.png', expect.any(Object));
    });

    it('defaults to jpeg when content-type is missing', async () => {
      const imageData = new Uint8Array([255, 216, 255]);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        arrayBuffer: () => Promise.resolve(imageData.buffer),
      });

      const result = await fetchImageAsBase64('https://example.com/image');
      expect(result.mediaType).toBe('image/jpeg');
    });

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(fetchImageAsBase64('https://example.com/notfound.png')).rejects.toThrow(
        'Failed to fetch image: HTTP 404'
      );
    });

    it('respects timeout option', async () => {
      mockFetch.mockImplementation((_url, options) => {
        expect(options.signal).toBeDefined();
        return Promise.resolve({
          ok: true,
          headers: new Headers({ 'content-type': 'image/jpeg' }),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        });
      });

      await fetchImageAsBase64('https://example.com/image.jpg', { timeout: 5000 });
    });
  });

  describe('resolveImage', () => {
    const mockFetch = vi.fn();
    const originalFetch = global.fetch;

    beforeEach(() => {
      global.fetch = mockFetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
      mockFetch.mockReset();
    });

    it('handles base64 object input', async () => {
      const result = await resolveImage({
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
      });

      expect(result).toEqual({
        data: 'iVBORw0KGgo=',
        mediaType: 'image/png',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('handles data URL string', async () => {
      const result = await resolveImage('data:image/gif;base64,R0lGODlh');

      expect(result).toEqual({
        data: 'R0lGODlh',
        mediaType: 'image/gif',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetches HTTP URL', async () => {
      const imageData = new Uint8Array([137, 80, 78, 71]);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: () => Promise.resolve(imageData.buffer),
      });

      const result = await resolveImage('https://example.com/image.png');

      expect(result.mediaType).toBe('image/png');
      expect(mockFetch).toHaveBeenCalled();
    });

    it('throws on invalid data URL', async () => {
      await expect(resolveImage('data:invalid')).rejects.toThrow('Invalid data URL format');
    });
  });
});
