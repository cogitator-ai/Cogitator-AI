/** A request body that every adapter refuses the same way, before any run starts */
export interface BodyRefusal {
  status: 400 | 413 | 415;
  code: 'INVALID_INPUT' | 'PAYLOAD_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE';
  message: string;
}

/** The outcome of reading a JSON request body: its value (`undefined` for no body), or a refusal */
export type JsonBodyResult = { ok: true; value: unknown } | { ok: false; refusal: BodyRefusal };

/** The largest JSON body the adapters read unless configured otherwise: 1 MiB */
export const DEFAULT_JSON_BODY_LIMIT = 1024 * 1024;

/**
 * The refusal of a body that is not JSON.
 *
 * Browsers send `text/plain`, `application/x-www-form-urlencoded` and `multipart/form-data`
 * across origins without a CORS preflight, so a server that read such a body as JSON would
 * let any web page start an agent run on it, with the visitor's cookies or on a server that
 * trusts its network. JSON endpoints read only JSON media types.
 */
export const UNSUPPORTED_MEDIA_TYPE: BodyRefusal = {
  status: 415,
  code: 'UNSUPPORTED_MEDIA_TYPE',
  message: 'Request body must be JSON (Content-Type: application/json)',
};

export const INVALID_JSON: BodyRefusal = {
  status: 400,
  code: 'INVALID_INPUT',
  message: 'Invalid JSON body',
};

export const PAYLOAD_TOO_LARGE: BodyRefusal = {
  status: 413,
  code: 'PAYLOAD_TOO_LARGE',
  message: 'Payload too large',
};

const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** True for `application/json` and `application/<anything>+json`, with any parameters */
export function isJsonMediaType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const essence = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return essence === 'application/json' || /^application\/[\w.+-]+\+json$/.test(essence);
}

/** Reads a header of a Node request or a Fetch `Headers`, as one string */
type HeaderSource = Headers | Readonly<Record<string, string | string[] | undefined>>;

function header(headers: HeaderSource, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * The refusal a request gets before its body is read, when it carries a body that is not JSON
 * (see {@link UNSUPPORTED_MEDIA_TYPE}). A request without a body passes: routes whose body is
 * optional run without one, and the others refuse the missing fields.
 */
export function refuseNonJsonBody(method: string, headers: HeaderSource): BodyRefusal | undefined {
  if (!BODY_METHODS.has(method.toUpperCase())) return undefined;
  const length = header(headers, 'content-length');
  const chunked = header(headers, 'transfer-encoding') !== undefined;
  const hasBody = chunked || (length !== undefined && Number(length) > 0);
  if (!hasBody || isJsonMediaType(header(headers, 'content-type'))) return undefined;
  return UNSUPPORTED_MEDIA_TYPE;
}

/** Parses the text of a request body under the JSON body policy */
export function parseJsonBody(
  contentType: string | null | undefined,
  text: string
): JsonBodyResult {
  if (!text.trim()) return { ok: true, value: undefined };
  if (!isJsonMediaType(contentType)) return { ok: false, refusal: UNSUPPORTED_MEDIA_TYPE };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, refusal: INVALID_JSON };
  }
}

/**
 * Reads the JSON body of a Fetch API `Request`, stopping at `limit` bytes: no body gives
 * `undefined`, a body that is not JSON `415`, one over the limit `413` and broken JSON `400`.
 */
export async function readJsonRequestBody(
  request: Request,
  limit: number = DEFAULT_JSON_BODY_LIMIT
): Promise<JsonBodyResult> {
  const contentType = request.headers.get('content-type');
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit)
    return { ok: false, refusal: PAYLOAD_TOO_LARGE };
  if (!request.body) return { ok: true, value: undefined };
  if (Number.isFinite(declared) && declared > 0 && !isJsonMediaType(contentType)) {
    await request.body.cancel().catch(() => undefined);
    return { ok: false, refusal: UNSUPPORTED_MEDIA_TYPE };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, refusal: PAYLOAD_TOO_LARGE };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, refusal: { ...INVALID_JSON, message: 'Failed to read request body' } };
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return parseJsonBody(contentType, new TextDecoder().decode(bytes));
}
