import { TWILIO_SESSION_TOKEN_PARAMETER } from './twilio-security.js';

const MAX_PARAMETER_LENGTH = 500;

export interface TwilioStreamTwimlOptions {
  /** Public `wss://` URL of the media stream. Twilio allows no query string here */
  url: string;
  /** One-time token from `TwilioSessionTokens.issue`, passed as a `<Parameter>` */
  token?: string;
  /** More `<Parameter>`s, delivered in the `start` event's `customParameters` */
  parameters?: Record<string, string>;
  /** Name of the stream */
  name?: string;
  /** URL Twilio notifies when the stream starts, stops or fails */
  statusCallback?: string;
  statusCallbackMethod?: 'GET' | 'POST';
}

/** True for a character XML 1.0 does not allow: control characters other than tab and newlines */
function hasInvalidXmlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
    if (code === 0xfffe || code === 0xffff) return true;
  }
  return false;
}

/** Escapes text for an XML attribute */
export function escapeXml(value: string): string {
  if (hasInvalidXmlChar(value)) {
    throw new Error('TwiML values cannot contain control characters');
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function attribute(name: string, value: string | undefined): string {
  return value === undefined ? '' : ` ${name}="${escapeXml(value)}"`;
}

function assertStreamUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Stream url is not a URL: ${url}`);
  }
  if (parsed.protocol !== 'wss:') {
    throw new Error(`Stream url must use wss://, got ${parsed.protocol}`);
  }
  if (parsed.search || url.includes('?')) {
    throw new Error('Stream url cannot have a query string, pass values as parameters');
  }
}

/**
 * TwiML that connects a call to a bidirectional media stream:
 * `<Response><Connect><Stream url="wss://..."><Parameter .../></Stream></Connect></Response>`.
 * The session token and the parameters reach the stream in its `start` event. Each parameter's
 * name and value together may hold at most 500 characters.
 */
export function twilioStreamTwiml(options: TwilioStreamTwimlOptions): string {
  assertStreamUrl(options.url);
  const parameters: Array<[string, string]> = Object.entries(options.parameters ?? {});
  if (options.token !== undefined) {
    if (options.parameters && TWILIO_SESSION_TOKEN_PARAMETER in options.parameters) {
      throw new Error(`Parameter ${TWILIO_SESSION_TOKEN_PARAMETER} is reserved for the token`);
    }
    parameters.push([TWILIO_SESSION_TOKEN_PARAMETER, options.token]);
  }
  for (const [name, value] of parameters) {
    if (name.length === 0) throw new Error('Stream parameter names cannot be empty');
    if (name.length + value.length > MAX_PARAMETER_LENGTH) {
      throw new Error(
        `Stream parameter ${name} is too long: name and value hold at most ${MAX_PARAMETER_LENGTH} characters`
      );
    }
  }

  const stream =
    `<Stream${attribute('url', options.url)}${attribute('name', options.name)}` +
    `${attribute('statusCallback', options.statusCallback)}` +
    `${attribute('statusCallbackMethod', options.statusCallbackMethod)}>` +
    parameters
      .map(([name, value]) => `<Parameter${attribute('name', name)}${attribute('value', value)}/>`)
      .join('') +
    '</Stream>';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect>${stream}</Connect></Response>`;
}
