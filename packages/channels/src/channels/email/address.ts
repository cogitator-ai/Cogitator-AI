/** A mailbox of an address header: the address and the display name, if any. */
export interface EmailMailbox {
  address: string;
  name?: string;
}

/** Headers of a message by lower-case name, in their order, duplicates kept. */
export type EmailHeaders = readonly (readonly [name: string, value: string])[];

const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** An address in the form the channel keys senders by: trimmed and in lower case. */
export function normalizeAddress(address: string): string {
  return address.trim().replace(/^<|>$/g, '').toLowerCase();
}

/** Whether `text` is a plain address, `local@domain.tld`. */
export function isAddress(text: string): boolean {
  return ADDRESS.test(text);
}

/** The domain of an address, in lower case. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Header text with its RFC 2047 encoded words (`=?utf-8?B?...?=`, `=?utf-8?Q?...?=`) decoded. */
export function decodeMimeWords(text: string): string {
  return text
    .replace(/(=\?[^?\s]+\?[bq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bq]\?)/gi, '$1')
    .replace(
      /=\?([^?\s*]+)(?:\*[^?\s]*)?\?([bq])\?([^?\s]*)\?=/gi,
      (word, charset: string, encoding: string, data: string) => {
        if (encoding.toLowerCase() === 'b') {
          return decodeBytes(Buffer.from(data, 'base64'), charset);
        }
        const bytes: number[] = [];
        const text = data.replace(/_/g, ' ');
        for (let i = 0; i < text.length; i++) {
          if (text[i] === '=' && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
            bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
            i += 2;
          } else bytes.push(text.charCodeAt(i) & 0xff);
        }
        return bytes.length ? decodeBytes(Uint8Array.from(bytes), charset) : word;
      }
    );
}

/**
 * The first mailbox of an address header such as `From`: `"Ann Lee" <ann@example.com>`,
 * `Ann <ann@example.com>` or `ann@example.com`, with encoded words in the name decoded.
 */
export function parseMailbox(value: string | undefined): EmailMailbox | undefined {
  if (!value) return undefined;
  const text = value.replace(/\r?\n[ \t]+/g, ' ').trim();
  const angled = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(text);
  if (angled) {
    const name = decodeMimeWords(
      angled[1]
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .replace(/\\(.)/g, '$1')
    ).trim();
    const address = normalizeAddress(angled[2]);
    if (!isAddress(address)) return undefined;
    return name ? { address, name } : { address };
  }
  const bare = /([^\s<>(),;:"]+@[^\s<>(),;:"]+)/.exec(text);
  if (!bare) return undefined;
  const address = normalizeAddress(bare[1]);
  if (!isAddress(address)) return undefined;
  const comment = /\(([^)]+)\)/.exec(text)?.[1]?.trim();
  return comment ? { address, name: decodeMimeWords(comment) } : { address };
}

/** The message ids (`<id@host>`) of a `Message-ID`, `In-Reply-To` or `References` header. */
export function messageIdsOf(value: string | undefined): string[] {
  if (!value) return [];
  const ids = value.match(/<[^<>\s]+>/g);
  if (ids) return ids;
  const bare = value.trim();
  return bare && !/\s/.test(bare) ? [`<${bare.replace(/^<|>$/g, '')}>`] : [];
}

/** The first message id of a header, if it has one. */
export function messageIdOf(value: string | undefined): string | undefined {
  return messageIdsOf(value)[0];
}

/** A header block (`Name: value` lines, folded lines continuing with whitespace) as headers. */
export function parseHeaderBlock(block: string): EmailHeaders {
  const headers: [string, string][] = [];
  for (const line of block.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line) break;
    if (/^[ \t]/.test(line) && headers.length > 0) {
      const last = headers[headers.length - 1];
      last[1] = `${last[1]} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
  }
  return headers;
}

/** The first value of a header, by its name in any letter case. */
export function headerOf(headers: EmailHeaders, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return headers.find(([key]) => key === wanted)?.[1];
}

/** Every value of a header, top to bottom, by its name in any letter case. */
export function headersOf(headers: EmailHeaders, name: string): string[] {
  const wanted = name.toLowerCase();
  return headers.filter(([key]) => key === wanted).map(([, value]) => value);
}

/**
 * Whether `domain` is aligned with the author's domain `fromDomain` in the relaxed DMARC sense:
 * the same domain, or one a subdomain of the other.
 */
export function alignedDomains(domain: string, fromDomain: string): boolean {
  const a = domain.toLowerCase().replace(/\.$/, '');
  const b = fromDomain.toLowerCase().replace(/\.$/, '');
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Whether an allow list lets `address` in. Entries are addresses (`ann@example.com`), domains
 * (`example.com` or `@example.com`, without subdomains), subdomain wildcards (`*.example.com`)
 * or `*` for everyone, in any letter case.
 */
export function allowsSender(list: readonly string[], address: string): boolean {
  const sender = normalizeAddress(address);
  const domain = domainOf(sender);
  return list.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === '*') return true;
    if (entry.startsWith('*.')) return domain.endsWith(entry.slice(1));
    if (entry.includes('@') && !entry.startsWith('@')) return entry === sender;
    return entry.replace(/^@/, '') === domain;
  });
}
