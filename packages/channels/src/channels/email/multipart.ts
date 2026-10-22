/** One part of a `multipart/form-data` body, its content as received. */
export interface FormPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

/** The fields of a webhook form, by name: text decoded on demand, files as bytes. */
export interface FormFields {
  /** The field decoded as text, in `charset` (UTF-8 by default) */
  text(name: string, charset?: string): string | undefined;
  /** A field with its bytes, for files */
  part(name: string): FormPart | undefined;
  /** Every text field, decoded as UTF-8, for `ChannelMessage.raw` */
  entries(): Record<string, string>;
}

function decode(data: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder((charset ?? 'utf-8').trim().toLowerCase()).decode(data);
  } catch {
    return new TextDecoder('utf-8').decode(data);
  }
}

function headerParameter(header: string, name: string): string | undefined {
  const match = new RegExp(`;\\s*${name}\\*?=(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]+))`, 'i').exec(
    header
  );
  const value = match?.[1] ?? match?.[2];
  return value?.replace(/\\(.)/g, '$1');
}

/**
 * A `multipart/form-data` body split into its parts, keeping each part's bytes, so a field sent
 * in another character set than UTF-8 (as SendGrid's Inbound Parse does) can be decoded in its
 * own. Linear in the size of the body.
 */
export function parseMultipart(body: Buffer, boundary: string): FormPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: FormPart[] = [];
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const afterDelimiter = start + delimiter.length;
    if (body.subarray(afterDelimiter, afterDelimiter + 2).toString() === '--') break;
    const headersStart = body.indexOf('\r\n', afterDelimiter);
    if (headersStart === -1) break;
    const headersEnd = body.indexOf('\r\n\r\n', headersStart);
    if (headersEnd === -1) break;
    const next = body.indexOf(delimiter, headersEnd + 4);
    if (next === -1) break;
    const contentEnd = body[next - 2] === 0x0d && body[next - 1] === 0x0a ? next - 2 : next;
    const headers = body.subarray(headersStart + 2, headersEnd).toString('utf-8');
    const disposition = /^content-disposition:(.*)$/im.exec(headers)?.[1] ?? '';
    const name = headerParameter(disposition, 'name');
    if (name !== undefined) {
      const filename = headerParameter(disposition, 'filename');
      const contentType = /^content-type:\s*(.*)$/im.exec(headers)?.[1]?.trim();
      parts.push({
        name,
        ...(filename !== undefined && { filename }),
        ...(contentType && { contentType }),
        data: body.subarray(headersEnd + 4, contentEnd),
      });
    }
    start = next;
  }
  return parts;
}

/**
 * The fields of a form body: `multipart/form-data` split by its boundary, or
 * `application/x-www-form-urlencoded`. Throws when the content type is neither.
 */
export function readFormFields(raw: string | Uint8Array, contentType: string): FormFields {
  const body = typeof raw === 'string' ? Buffer.from(raw, 'utf-8') : Buffer.from(raw);
  if (/^application\/x-www-form-urlencoded/i.test(contentType)) {
    const params = new URLSearchParams(body.toString('utf-8'));
    return {
      text: (name) => params.get(name) ?? undefined,
      part: (name) => {
        const value = params.get(name);
        return value === null ? undefined : { name, data: Buffer.from(value, 'utf-8') };
      },
      entries: () => Object.fromEntries(params),
    };
  }
  const boundary = /^multipart\/form-data/i.test(contentType)
    ? headerParameter(contentType, 'boundary')
    : undefined;
  if (!boundary) throw new Error('Expected a form body');
  const byName = new Map<string, FormPart>();
  for (const part of parseMultipart(body, boundary)) {
    if (!byName.has(part.name)) byName.set(part.name, part);
  }
  return {
    text: (name, charset) => {
      const part = byName.get(name);
      return part && part.filename === undefined ? decode(part.data, charset) : undefined;
    },
    part: (name) => byName.get(name),
    entries: () =>
      Object.fromEntries(
        [...byName.values()]
          .filter((part) => part.filename === undefined)
          .map((part) => [part.name, decode(part.data, undefined)])
      ),
  };
}
