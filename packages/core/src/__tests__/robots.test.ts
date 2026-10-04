import { describe, expect, it } from 'vitest';
import { RobotsPolicy, robotsAllowsPath, robotsRulesFor } from '../web/robots';

const ROBOTS = `# example
User-agent: *
Disallow: /private/
Allow: /private/press/
Disallow: /*.pdf$

User-agent: NewsBot
User-agent: OtherBot
Disallow: /archive
Allow: /archive/today

User-agent: Blocked
Disallow: /
`;

describe('robotsRulesFor and robotsAllowsPath', () => {
  it('apply the * group to agents the file does not name', () => {
    const rules = robotsRulesFor(ROBOTS, 'AnyBot');
    expect(robotsAllowsPath(rules, '/news/1')).toBe(true);
    expect(robotsAllowsPath(rules, '/private/x')).toBe(false);
    expect(robotsAllowsPath(rules, '/private/press/release')).toBe(true);
    expect(robotsAllowsPath(rules, '/report.pdf')).toBe(false);
    expect(robotsAllowsPath(rules, '/report.pdf?page=2')).toBe(true);
  });

  it('use only the groups that name the token, case-insensitively, sharing grouped agents', () => {
    const rules = robotsRulesFor(ROBOTS, 'newsbot');
    expect(robotsAllowsPath(rules, '/private/x')).toBe(true);
    expect(robotsAllowsPath(rules, '/archive/2020')).toBe(false);
    expect(robotsAllowsPath(rules, '/archive/today')).toBe(true);
    expect(robotsAllowsPath(robotsRulesFor(ROBOTS, 'OtherBot'), '/archive')).toBe(false);
    expect(robotsAllowsPath(robotsRulesFor(ROBOTS, 'Blocked'), '/')).toBe(false);
  });

  it('let allow win a tie and treat an empty disallow as allow all', () => {
    expect(
      robotsAllowsPath(
        [
          { allow: false, pattern: '/a' },
          { allow: true, pattern: '/a' },
        ],
        '/a'
      )
    ).toBe(true);
    expect(robotsAllowsPath(robotsRulesFor('User-agent: *\nDisallow:\n', 'x'), '/anything')).toBe(
      true
    );
  });
});

function fakeFetch(answers: Record<string, Response | Error>): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const doFetch: typeof fetch = (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const answer = answers[url];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer?.clone() ?? new Response('', { status: 404 }));
  };
  return { fetch: doFetch, calls };
}

describe('RobotsPolicy', () => {
  it('reads a site once, takes its token from the User-Agent and caches the rules', async () => {
    const { fetch, calls } = fakeFetch({
      'https://a.test/robots.txt': new Response(ROBOTS, { status: 200 }),
    });
    const policy = new RobotsPolicy({ userAgent: 'NewsBot/1.0 (+https://bot.test)', fetch });

    expect(await policy.allows('https://a.test/private/x')).toBe(true);
    expect(await policy.allows('https://a.test/archive/old')).toBe(false);
    expect(calls).toEqual(['https://a.test/robots.txt']);
  });

  it('reads everything on a 4xx and nothing on a 5xx or a network failure, until the cache expires', async () => {
    let now = 0;
    const { fetch } = fakeFetch({
      'https://gone.test/robots.txt': new Response('', { status: 404 }),
      'https://down.test/robots.txt': new Response('', { status: 503 }),
      'https://dead.test/robots.txt': new Error('ECONNRESET'),
    });
    const policy = new RobotsPolicy({ userAgent: 'Bot', fetch, cacheMs: 1000, now: () => now });

    expect(await policy.allows('https://gone.test/a')).toBe(true);
    expect(await policy.allows('https://down.test/a')).toBe(false);
    expect(await policy.allows('https://dead.test/a')).toBe(false);
    now = 2000;
    expect(await policy.allows('https://down.test/a')).toBe(false);
  });

  it('does not judge schemes other than http and https', async () => {
    const policy = new RobotsPolicy({ userAgent: 'Bot', fetch: fakeFetch({}).fetch });
    expect(await policy.allows('file:///etc/hosts')).toBe(true);
  });
});
