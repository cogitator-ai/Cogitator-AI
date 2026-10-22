export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * The message of an error answer: `{ error: { message } }` as every Cogitator adapter answers,
 * or the flat `{ error: message }` of older servers
 */
function extractErrorDetail(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const { error } = parsed;
      if (typeof error === 'string' && error) return error;
      if (typeof error === 'object' && error !== null && 'message' in error) {
        const { message } = error;
        if (typeof message === 'string' && message) return message;
      }
    }
  } catch {}
  return text;
}

export async function toHttpError(response: Response): Promise<HttpError> {
  const text = await response.text().catch(() => '');
  const detail = extractErrorDetail(text.trim()) || response.statusText || 'Unknown error';
  return new HttpError(response.status, `Request failed: ${response.status} - ${detail}`);
}
