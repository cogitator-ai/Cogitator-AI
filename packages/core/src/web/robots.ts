import type { RobotsChecker } from '@cogitator-ai/types';

interface Rule {
  allow: boolean;
  pattern: string;
}

/** The rules of a robots.txt that apply to one user agent, or a blanket answer. */
export type RobotsRules = Rule[] | 'allow-all' | 'disallow-all';

interface Group {
  agents: string[];
  rules: Rule[];
}

/** How long a site's robots.txt is trusted before it is read again. */
const DEFAULT_CACHE_MS = 60 * 60 * 1000;

/** Groups of a robots.txt: consecutive user-agent lines share the rules that follow them. */
function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const hash = rawLine.indexOf('#');
    const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      lastWasAgent = false;
      if (key === 'disallow' && value === '') continue;
      current.rules.push({ allow: key === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

/**
 * The rules a robots.txt sets for a product token: the groups that name the token (case-
 * insensitively), or the `*` groups when none does, as RFC 9309 says.
 */
export function robotsRulesFor(text: string, token: string): Rule[] {
  const groups = parseGroups(text);
  const name = token.toLowerCase();
  const own = groups.filter((group) => group.agents.includes(name));
  const chosen = own.length > 0 ? own : groups.filter((group) => group.agents.includes('*'));
  return chosen.flatMap((group) => group.rules);
}

/**
 * Whether a robots.txt pattern matches a path, without regular expressions: robots.txt comes
 * from other sites, and a pattern like `/a*a*a*a*b` must not be able to stall the matcher. The
 * pattern is cut at every `*`: the first piece must start the path, the others are found in
 * order from left to right (the earliest place is always the best for later pieces), and with a
 * trailing `$` the last piece must end the path.
 */
function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const pieces = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  const first = pieces[0] ?? '';
  if (!path.startsWith(first)) return false;
  if (pieces.length === 1) return !anchored || path.length === first.length;

  let cursor = first.length;
  const last = pieces[pieces.length - 1] ?? '';
  for (let i = 1; i < pieces.length - 1; i++) {
    const piece = pieces[i] ?? '';
    const at = path.indexOf(piece, cursor);
    if (at < 0) return false;
    cursor = at + piece.length;
  }
  if (anchored) return path.length - last.length >= cursor && path.endsWith(last);
  return path.includes(last, cursor);
}

/**
 * Whether a path with its query may be fetched under the rules: the longest matching pattern
 * wins, and on a tie allow beats disallow (RFC 9309). `*` matches any run of characters and a
 * trailing `$` anchors the end.
 */
export function robotsAllowsPath(rules: RobotsRules, pathWithQuery: string): boolean {
  if (rules === 'allow-all') return true;
  if (rules === 'disallow-all') return false;
  let best: Rule | undefined;
  for (const rule of rules) {
    if (!patternMatches(rule.pattern, pathWithQuery)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best?.allow ?? true;
}

export interface RobotsPolicyOptions {
  /** The User-Agent header sent when reading robots.txt, e.g. "MyBot/1.0 (+https://example.com)" */
  userAgent: string;
  /** The product token matched against `User-agent` lines. Defaults to the User-Agent's first word */
  token?: string;
  /** How long a site's rules are cached, default one hour */
  cacheMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Reads and caches robots.txt per site, following RFC 9309: a site that answers 4xx for its
 * robots.txt may be read in full, and a site whose robots.txt cannot be read (5xx or a network
 * failure) is not read at all until the cache expires.
 *
 * @example
 * const robots = new RobotsPolicy({ userAgent: 'MyBot/1.0 (+https://example.com/bot)' });
 * if (await robots.allows('https://example.com/news/1')) { ... }
 */
export class RobotsPolicy implements RobotsChecker {
  private readonly cache = new Map<string, { rules: RobotsRules; until: number }>();
  private readonly token: string;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: RobotsPolicyOptions) {
    this.token = options.token ?? options.userAgent.split(/[\s/]/)[0] ?? options.userAgent;
    this.doFetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async allows(target: string): Promise<boolean> {
    const url = new URL(target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
    const rules = await this.rulesFor(url.origin);
    return robotsAllowsPath(rules, `${url.pathname}${url.search}`);
  }

  private async rulesFor(origin: string): Promise<RobotsRules> {
    const cached = this.cache.get(origin);
    if (cached && cached.until > this.now()) return cached.rules;

    let rules: RobotsRules;
    try {
      const response = await this.doFetch(`${origin}/robots.txt`, {
        headers: { 'user-agent': this.options.userAgent },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
      if (response.ok) rules = robotsRulesFor(await response.text(), this.token);
      else if (response.status >= 400 && response.status < 500) rules = 'allow-all';
      else rules = 'disallow-all';
    } catch {
      rules = 'disallow-all';
    }
    this.cache.set(origin, {
      rules,
      until: this.now() + (this.options.cacheMs ?? DEFAULT_CACHE_MS),
    });
    return rules;
  }
}
