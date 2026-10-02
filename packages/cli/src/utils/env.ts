import { loadDotenvFile, parseDotenv } from '@cogitator-ai/config';

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/;

export { parseDotenv };

export function loadDotenvInto(path: string, env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(loadDotenvFile(path))) {
    if (env[key] === undefined) env[key] = value;
  }
}

export function formatEnvValue(value: string): string {
  if (value === '' || /^[A-Za-z0-9_./:@+,=-]+$/.test(value)) return value;
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

export function formatEnvLine(key: string, value: string): string {
  return `${key}=${formatEnvValue(value)}`;
}

export function mergeEnvContent(existing: string, entries: ReadonlyMap<string, string>): string {
  const written = new Set<string>();
  const lines = existing.length > 0 ? existing.replace(/\r?\n$/, '').split(/\r?\n/) : [];

  const merged = lines.map((line) => {
    const match = ENV_LINE.exec(line);
    const value = match ? entries.get(match[1]) : undefined;
    if (!match || value === undefined) return line;
    written.add(match[1]);
    return formatEnvLine(match[1], value);
  });

  for (const [key, value] of entries) {
    if (!written.has(key)) merged.push(formatEnvLine(key, value));
  }

  return merged.join('\n') + '\n';
}
