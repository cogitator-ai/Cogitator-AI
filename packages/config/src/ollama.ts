/** Port Ollama listens on unless told otherwise. */
export const OLLAMA_DEFAULT_PORT = 11434;

const WILDCARD_HOSTS = new Set(['', '0.0.0.0', '::', '[::]']);

function splitHostPort(authority: string): { host: string; port?: string } {
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close === -1) return { host: authority };
    const rest = authority.slice(close + 1);
    return {
      host: authority.slice(0, close + 1),
      port: rest.startsWith(':') ? rest.slice(1) : undefined,
    };
  }
  const colon = authority.lastIndexOf(':');
  if (colon === -1 || authority.indexOf(':') !== colon) {
    return colon === -1 ? { host: authority } : { host: `[${authority}]` };
  }
  return { host: authority.slice(0, colon), port: authority.slice(colon + 1) };
}

/**
 * The URL a client reaches Ollama at, read from an `OLLAMA_HOST`-style value
 * the way Ollama itself reads it: `gpu-box`, `gpu-box:8080`, `:11434`,
 * `0.0.0.0` or a full URL. Without a scheme the port defaults to 11434, with
 * `http://` or `https://` it is the scheme's own. Wildcard bind addresses
 * (`0.0.0.0`, `::`), which `ollama serve` is often told to listen on, become
 * `localhost`. A trailing slash is dropped.
 */
export function resolveOllamaHost(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : 'http';
  const rest = schemeMatch ? raw.slice(schemeMatch[0].length) : raw;

  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash).replace(/\/+$/, '');

  const split = splitHostPort(authority);
  const host = WILDCARD_HOSTS.has(split.host) ? 'localhost' : split.host;
  const validPort = split.port && /^\d{1,5}$/.test(split.port) ? split.port : undefined;
  const port = validPort ?? (schemeMatch ? undefined : String(OLLAMA_DEFAULT_PORT));

  return `${scheme}://${host}${port ? `:${port}` : ''}${path}`;
}
