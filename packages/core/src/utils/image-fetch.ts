import type { ImageBase64ContentPart } from '@cogitator-ai/types';

export type ImageMediaType = ImageBase64ContentPart['image_base64']['media_type'];

export interface FetchedImage {
  data: string;
  mediaType: ImageMediaType;
}

const SUPPORTED_MEDIA_TYPES = new Set<ImageMediaType>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

function normalizeMediaType(contentType: string | null): ImageMediaType {
  if (!contentType) return 'image/jpeg';

  const mediaType = contentType.split(';')[0].trim().toLowerCase();

  if (SUPPORTED_MEDIA_TYPES.has(mediaType as ImageMediaType)) {
    return mediaType as ImageMediaType;
  }

  if (mediaType === 'image/jpg') return 'image/jpeg';

  return 'image/jpeg';
}

export async function fetchImageAsBase64(
  url: string,
  options?: { timeout?: number }
): Promise<FetchedImage> {
  const timeout = options?.timeout ?? 30000;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'image/*',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch image: HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type');
    const mediaType = normalizeMediaType(contentType);

    const buffer = await response.arrayBuffer();
    const data = Buffer.from(buffer).toString('base64');

    return { data, mediaType };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function isDataUrl(url: string): boolean {
  return url.startsWith('data:');
}

export function parseDataUrl(dataUrl: string): FetchedImage | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;

  const [, contentType, data] = match;
  const mediaType = normalizeMediaType(contentType);

  return { data, mediaType };
}

export async function resolveImage(
  imageSource: string | { data: string; mimeType: string }
): Promise<FetchedImage> {
  if (typeof imageSource !== 'string') {
    return {
      data: imageSource.data,
      mediaType: normalizeMediaType(imageSource.mimeType),
    };
  }

  if (isDataUrl(imageSource)) {
    const parsed = parseDataUrl(imageSource);
    if (parsed) return parsed;
    throw new Error('Invalid data URL format');
  }

  return fetchImageAsBase64(imageSource);
}
