export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function extractErrorDetail(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const { error } = parsed;
      if (typeof error === 'string' && error) return error;
    }
  } catch {}
  return text;
}

export async function toHttpError(response: Response): Promise<HttpError> {
  const text = await response.text().catch(() => '');
  const detail = extractErrorDetail(text.trim()) || response.statusText || 'Unknown error';
  return new HttpError(response.status, `Request failed: ${response.status} - ${detail}`);
}
