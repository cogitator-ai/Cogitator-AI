const MIME_EXTENSIONS: ReadonlyArray<[RegExp, string]> = [
  [/ogg|opus/, 'ogg'],
  [/wav|wave/, 'wav'],
  [/mpeg|mp3/, 'mp3'],
  [/mp4|m4a|aac/, 'm4a'],
  [/webm/, 'webm'],
  [/flac/, 'flac'],
];

export function audioExtension(mimeType: string): string {
  const normalized = baseMimeType(mimeType);
  for (const [pattern, ext] of MIME_EXTENSIONS) {
    if (pattern.test(normalized)) return ext;
  }
  return 'ogg';
}

export function baseMimeType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
}
