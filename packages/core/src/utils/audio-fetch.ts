import type { AudioFormat, AudioInput } from '@cogitator-ai/types';

export interface FetchedAudio {
  buffer: Buffer;
  format: AudioFormat;
  filename: string;
}

const AUDIO_MIME_TYPES: Record<string, AudioFormat> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

const VALID_EXTENSIONS: AudioFormat[] = [
  'mp3',
  'mp4',
  'mpeg',
  'mpga',
  'm4a',
  'wav',
  'webm',
  'ogg',
  'flac',
];

const MAX_FILE_SIZE = 25 * 1024 * 1024;

function detectAudioFormat(contentType: string | null, url: string): AudioFormat {
  if (contentType) {
    const normalized = contentType.toLowerCase().split(';')[0].trim();
    const format = AUDIO_MIME_TYPES[normalized];
    if (format) return format;
  }

  const urlPath = url.split('?')[0];
  const ext = urlPath.split('.').pop()?.toLowerCase();
  if (ext && VALID_EXTENSIONS.includes(ext as AudioFormat)) {
    return ext as AudioFormat;
  }

  return 'mp3';
}

export async function fetchAudioAsBuffer(
  url: string,
  options?: { timeout?: number }
): Promise<FetchedAudio> {
  const timeout = options?.timeout ?? 60000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'audio/*' },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch audio: HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type');
    const format = detectAudioFormat(contentType, url);
    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error(
        `Audio file exceeds 25MB limit (got ${(buffer.length / 1024 / 1024).toFixed(1)}MB)`
      );
    }

    return { buffer, format, filename: `audio.${format}` };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function audioInputToBuffer(
  input: AudioInput
): Promise<{ buffer: Buffer; filename: string; format: AudioFormat }> {
  if (typeof input === 'string') {
    if (input.startsWith('data:audio/')) {
      const match = /^data:audio\/([^;]+);base64,(.+)$/.exec(input);
      if (match) {
        const format = (match[1] === 'mpeg' ? 'mp3' : match[1]) as AudioFormat;
        const buffer = Buffer.from(match[2], 'base64');
        if (buffer.length > MAX_FILE_SIZE) {
          throw new Error(`Audio file exceeds 25MB limit`);
        }
        return { buffer, format, filename: `audio.${format}` };
      }
    }
    return fetchAudioAsBuffer(input);
  }

  const buffer = Buffer.from(input.data, 'base64');
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`Audio file exceeds 25MB limit`);
  }
  return { buffer, format: input.format, filename: `audio.${input.format}` };
}

export function isValidAudioFormat(format: string): format is AudioFormat {
  return VALID_EXTENSIONS.includes(format as AudioFormat);
}

export function getAudioMimeType(format: AudioFormat): string {
  const mimeTypes: Record<AudioFormat, string> = {
    mp3: 'audio/mpeg',
    mp4: 'audio/mp4',
    mpeg: 'audio/mpeg',
    mpga: 'audio/mpeg',
    m4a: 'audio/m4a',
    wav: 'audio/wav',
    webm: 'audio/webm',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
  };
  return mimeTypes[format] || 'audio/mpeg';
}
