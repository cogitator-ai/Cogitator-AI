import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { githubApi } from '../tools/github';

const mockFetch = vi.fn();

describe('github_api tool', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    vi.stubEnv('GITHUB_TOKEN', 'test-github-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const ctx = { agentId: 'test', runId: 'run1', signal: new AbortController().signal };

  const createJsonResponse = (data: unknown) => ({
    ok: true,
    json: async () => data,
  });

  describe('authentication', () => {
    it('returns error when GITHUB_TOKEN not set', async () => {
      vi.stubEnv('GITHUB_TOKEN', '');

      const result = await githubApi.execute(
        { action: 'get_repo', owner: 'test', repo: 'repo' },
        ctx
      );

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('GITHUB_TOKEN');
    });

    it('includes auth header in requests', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          name: 'repo',
          full_name: 'test/repo',
          description: 'Test',
          html_url: 'https://github.com/test/repo',
          default_branch: 'main',
          stargazers_count: 100,
          forks_count: 10,
          open_issues_count: 5,
          language: 'TypeScript',
          topics: [],
        })
      );

      await githubApi.execute({ action: 'get_repo', owner: 'test', repo: 'repo' }, ctx);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-github-token',
            'X-GitHub-Api-Version': '2022-11-28',
          }),
        })
      );
    });
  });

  describe('get_repo', () => {
    it('fetches repository info', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          id: 123,
          name: 'cogitator',
          full_name: 'eL1fe/cogitator',
          description: 'AI Agent Runtime',
          html_url: 'https://github.com/eL1fe/cogitator',
          default_branch: 'main',
          stargazers_count: 1000,
          forks_count: 50,
          open_issues_count: 10,
          language: 'TypeScript',
          topics: ['ai', 'agents', 'typescript'],
        })
      );

      const result = await githubApi.execute(
        { action: 'get_repo', owner: 'eL1fe', repo: 'cogitator' },
        ctx
      );

      expect(result).toMatchObject({
        name: 'cogitator',
        fullName: 'eL1fe/cogitator',
        description: 'AI Agent Runtime',
        url: 'https://github.com/eL1fe/cogitator',
        defaultBranch: 'main',
        stars: 1000,
        forks: 50,
        openIssues: 10,
        language: 'TypeScript',
        topics: ['ai', 'agents', 'typescript'],
      });
    });
  });

  describe('list_issues', () => {
    it('lists open issues', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse([
          {
            number: 1,
            title: 'Bug report',
            state: 'open',
            html_url: 'https://github.com/test/repo/issues/1',
            user: { login: 'user1' },
            labels: [{ name: 'bug' }],
            created_at: '2024-01-01T00:00:00Z',
          },
          {
            number: 2,
            title: 'Feature request',
            state: 'open',
            html_url: 'https://github.com/test/repo/issues/2',
            user: { login: 'user2' },
            labels: [{ name: 'enhancement' }],
            created_at: '2024-01-02T00:00:00Z',
          },
        ])
      );

      const result = await githubApi.execute(
        { action: 'list_issues', owner: 'test', repo: 'repo' },
        ctx
      );

      expect(result).toHaveLength(2);
      expect((result as unknown[])[0]).toMatchObject({
        number: 1,
        title: 'Bug report',
        state: 'open',
        author: 'user1',
        labels: ['bug'],
      });
    });

    it('filters out pull requests', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse([
          {
            number: 1,
            title: 'Issue',
            state: 'open',
            html_url: '',
            user: { login: 'a' },
            labels: [],
            created_at: '',
          },
          {
            number: 2,
            title: 'PR',
            state: 'open',
            html_url: '',
            user: { login: 'b' },
            labels: [],
            created_at: '',
            pull_request: {},
          },
        ])
      );

      const result = await githubApi.execute(
        { action: 'list_issues', owner: 'test', repo: 'repo' },
        ctx
      );

      expect(result).toHaveLength(1);
      expect((result as Array<{ title: string }>)[0].title).toBe('Issue');
    });

    it('passes pagination params', async () => {
      mockFetch.mockResolvedValueOnce(createJsonResponse([]));

      await githubApi.execute(
        { action: 'list_issues', owner: 'test', repo: 'repo', perPage: 50, page: 2 },
        ctx
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('per_page=50'),
        expect.any(Object)
      );
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('page=2'), expect.any(Object));
    });
  });

  describe('get_issue', () => {
    it('fetches single issue', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          number: 42,
          title: 'Important Issue',
          state: 'open',
          html_url: 'https://github.com/test/repo/issues/42',
          body: 'Issue description here',
          user: { login: 'author' },
          labels: [{ name: 'bug' }, { name: 'priority' }],
          assignees: [{ login: 'dev1' }, { login: 'dev2' }],
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-15T00:00:00Z',
        })
      );

      const result = await githubApi.execute(
        { action: 'get_issue', owner: 'test', repo: 'repo', number: 42 },
        ctx
      );

      expect(result).toMatchObject({
        number: 42,
        title: 'Important Issue',
        body: 'Issue description here',
        author: 'author',
        labels: ['bug', 'priority'],
        assignees: ['dev1', 'dev2'],
      });
    });

    it('returns error when number not provided', async () => {
      const result = await githubApi.execute(
        { action: 'get_issue', owner: 'test', repo: 'repo' },
        ctx
      );

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Issue number required');
    });
  });

  describe('create_issue', () => {
    it('creates a new issue', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          number: 100,
          title: 'New Issue',
          html_url: 'https://github.com/test/repo/issues/100',
        })
      );

      const result = await githubApi.execute(
        {
          action: 'create_issue',
          owner: 'test',
          repo: 'repo',
          title: 'New Issue',
          body: 'Issue body',
          labels: ['bug'],
        },
        ctx
      );

      expect(result).toMatchObject({
        number: 100,
        title: 'New Issue',
        created: true,
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toMatchObject({
        title: 'New Issue',
        body: 'Issue body',
        labels: ['bug'],
      });
    });

    it('returns error when title not provided', async () => {
      const result = await githubApi.execute(
        { action: 'create_issue', owner: 'test', repo: 'repo' },
        ctx
      );

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Issue title required');
    });
  });

  describe('list_prs', () => {
    it('lists pull requests', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse([
          {
            number: 10,
            title: 'Feature PR',
            state: 'open',
            html_url: 'https://github.com/test/repo/pull/10',
            user: { login: 'contributor' },
            head: { ref: 'feature-branch' },
            base: { ref: 'main' },
            created_at: '2024-01-01T00:00:00Z',
          },
        ])
      );

      const result = await githubApi.execute(
        { action: 'list_prs', owner: 'test', repo: 'repo' },
        ctx
      );

      expect(result).toHaveLength(1);
      expect((result as unknown[])[0]).toMatchObject({
        number: 10,
        title: 'Feature PR',
        author: 'contributor',
        head: 'feature-branch',
        base: 'main',
      });
    });
  });

  describe('get_pr', () => {
    it('fetches single PR', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          number: 15,
          title: 'Big Feature',
          state: 'open',
          html_url: 'https://github.com/test/repo/pull/15',
          body: 'PR description',
          user: { login: 'dev' },
          head: { ref: 'feature' },
          base: { ref: 'main' },
          merged: false,
          mergeable: true,
          labels: [{ name: 'ready' }],
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-10T00:00:00Z',
        })
      );

      const result = await githubApi.execute(
        { action: 'get_pr', owner: 'test', repo: 'repo', number: 15 },
        ctx
      );

      expect(result).toMatchObject({
        number: 15,
        title: 'Big Feature',
        merged: false,
        mergeable: true,
        head: 'feature',
        base: 'main',
      });
    });
  });

  describe('create_pr', () => {
    it('creates a new PR', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          number: 20,
          title: 'New PR',
          html_url: 'https://github.com/test/repo/pull/20',
        })
      );

      const result = await githubApi.execute(
        {
          action: 'create_pr',
          owner: 'test',
          repo: 'repo',
          title: 'New PR',
          body: 'PR body',
          head: 'feature-branch',
          base: 'main',
        },
        ctx
      );

      expect(result).toMatchObject({
        number: 20,
        title: 'New PR',
        created: true,
      });
    });

    it('returns error when required params missing', async () => {
      const result = await githubApi.execute(
        { action: 'create_pr', owner: 'test', repo: 'repo', title: 'PR' },
        ctx
      );

      expect(result).toHaveProperty('error');
    });
  });

  describe('get_file', () => {
    it('fetches file content', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          name: 'README.md',
          path: 'README.md',
          sha: 'abc123',
          size: 1000,
          html_url: 'https://github.com/test/repo/blob/main/README.md',
          content: Buffer.from('# Hello World').toString('base64'),
          encoding: 'base64',
        })
      );

      const result = await githubApi.execute(
        { action: 'get_file', owner: 'test', repo: 'repo', path: 'README.md' },
        ctx
      );

      expect(result).toMatchObject({
        name: 'README.md',
        path: 'README.md',
        content: '# Hello World',
      });
    });

    it('passes ref parameter', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          name: 'file.ts',
          path: 'file.ts',
          sha: 'def456',
          size: 500,
          html_url: '',
          content: Buffer.from('code').toString('base64'),
          encoding: 'base64',
        })
      );

      await githubApi.execute(
        { action: 'get_file', owner: 'test', repo: 'repo', path: 'file.ts', ref: 'develop' },
        ctx
      );

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('ref=develop'),
        expect.any(Object)
      );
    });
  });

  describe('list_commits', () => {
    it('lists recent commits', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse([
          {
            sha: 'abc123def456',
            commit: {
              message: 'Initial commit\n\nDetailed description',
              author: { name: 'Dev', date: '2024-01-01T00:00:00Z' },
            },
            html_url: 'https://github.com/test/repo/commit/abc123def456',
          },
        ])
      );

      const result = await githubApi.execute(
        { action: 'list_commits', owner: 'test', repo: 'repo' },
        ctx
      );

      expect(result).toHaveLength(1);
      expect((result as unknown[])[0]).toMatchObject({
        sha: 'abc123d',
        fullSha: 'abc123def456',
        message: 'Initial commit',
        author: 'Dev',
      });
    });
  });

  describe('search_code', () => {
    it('searches code in repository', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          total_count: 2,
          items: [
            {
              path: 'src/index.ts',
              html_url: 'https://github.com/test/repo/blob/main/src/index.ts',
            },
            {
              path: 'src/utils.ts',
              html_url: 'https://github.com/test/repo/blob/main/src/utils.ts',
            },
          ],
        })
      );

      const result = await githubApi.execute(
        { action: 'search_code', owner: 'test', repo: 'repo', query: 'function' },
        ctx
      );

      expect(result).toMatchObject({
        totalCount: 2,
        results: [{ path: 'src/index.ts' }, { path: 'src/utils.ts' }],
      });
    });
  });

  describe('search_issues', () => {
    it('searches issues in repository', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          total_count: 1,
          items: [
            {
              number: 5,
              title: 'Bug in search',
              html_url: 'https://github.com/test/repo/issues/5',
            },
          ],
        })
      );

      const result = await githubApi.execute(
        { action: 'search_issues', owner: 'test', repo: 'repo', query: 'bug' },
        ctx
      );

      expect(result).toMatchObject({
        totalCount: 1,
        results: [{ number: 5, title: 'Bug in search' }],
      });
    });
  });

  describe('error handling', () => {
    it('handles API errors gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      });

      const result = await githubApi.execute(
        { action: 'get_repo', owner: 'test', repo: 'nonexistent' },
        ctx
      );

      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('GitHub API error 404');
    });
  });

  describe('URL encoding', () => {
    it('encodes owner and repo with special characters', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          name: 'repo',
          full_name: 'test user/my repo',
          description: '',
          html_url: '',
          default_branch: 'main',
          stargazers_count: 0,
          forks_count: 0,
          open_issues_count: 0,
          language: null,
          topics: [],
        })
      );

      await githubApi.execute({ action: 'get_repo', owner: 'test user', repo: 'my repo' }, ctx);

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('test%20user');
      expect(calledUrl).toContain('my%20repo');
      expect(calledUrl).not.toContain('test user');
    });

    it('encodes file path segments with special characters', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          name: 'file name.ts',
          path: 'src/file name.ts',
          sha: 'abc',
          size: 100,
          html_url: '',
          content: Buffer.from('code').toString('base64'),
          encoding: 'base64',
        })
      );

      await githubApi.execute(
        { action: 'get_file', owner: 'owner', repo: 'repo', path: 'src/file name.ts' },
        ctx
      );

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('file%20name.ts');
    });

    it('encodes unicode characters in owner/repo', async () => {
      mockFetch.mockResolvedValueOnce(
        createJsonResponse({
          name: 'repo',
          full_name: 'user/repo',
          description: '',
          html_url: '',
          default_branch: 'main',
          stargazers_count: 0,
          forks_count: 0,
          open_issues_count: 0,
          language: null,
          topics: [],
        })
      );

      await githubApi.execute({ action: 'get_repo', owner: 'usér', repo: 'répö' }, ctx);

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain(encodeURIComponent('usér'));
      expect(calledUrl).toContain(encodeURIComponent('répö'));
    });
  });

  describe('request timeout', () => {
    it('uses AbortController with timeout for API requests', async () => {
      mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
        expect(init?.signal).toBeDefined();
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Promise.resolve(
          createJsonResponse({
            name: 'repo',
            full_name: 'test/repo',
            description: '',
            html_url: '',
            default_branch: 'main',
            stargazers_count: 0,
            forks_count: 0,
            open_issues_count: 0,
            language: null,
            topics: [],
          })
        );
      });

      await githubApi.execute({ action: 'get_repo', owner: 'test', repo: 'repo' }, ctx);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        })
      );
    });
  });

  describe('tool metadata', () => {
    it('has correct name and description', () => {
      expect(githubApi.name).toBe('github_api');
      expect(githubApi.description).toContain('GitHub API');
    });

    it('generates valid JSON schema', () => {
      const schema = githubApi.toJSON();
      expect(schema.name).toBe('github_api');
      expect(schema.parameters.properties).toHaveProperty('action');
      expect(schema.parameters.properties).toHaveProperty('owner');
      expect(schema.parameters.properties).toHaveProperty('repo');
    });
  });
});
