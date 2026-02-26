import { z } from 'zod';
import { tool } from '../tool';

const githubParams = z.object({
  action: z
    .enum([
      'get_repo',
      'list_issues',
      'get_issue',
      'create_issue',
      'update_issue',
      'list_prs',
      'get_pr',
      'create_pr',
      'get_file',
      'list_commits',
      'search_code',
      'search_issues',
    ])
    .describe('GitHub API action to perform'),
  owner: z.string().describe('Repository owner (user or organization)'),
  repo: z.string().describe('Repository name'),
  number: z.number().int().optional().describe('Issue or PR number (for get/update operations)'),
  title: z.string().optional().describe('Title for new issue/PR'),
  body: z.string().optional().describe('Body/description for new issue/PR'),
  state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by state (default: open)'),
  labels: z.array(z.string()).optional().describe('Labels for issue'),
  assignees: z.array(z.string()).optional().describe('Assignees for issue'),
  path: z.string().optional().describe('File path (for get_file)'),
  ref: z.string().optional().describe('Git ref/branch (default: main)'),
  base: z.string().optional().describe('Base branch for PR'),
  head: z.string().optional().describe('Head branch for PR'),
  query: z.string().optional().describe('Search query'),
  perPage: z.number().int().min(1).max(100).optional().describe('Results per page (default: 30)'),
  page: z.number().int().min(1).optional().describe('Page number (default: 1)'),
});

type GitHubAction = z.infer<typeof githubParams>['action'];

const GITHUB_API = 'https://api.github.com';

function encodePath(filePath: string): string {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

async function githubFetch(
  endpoint: string,
  token: string,
  options: RequestInit = {}
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(`${GITHUB_API}${endpoint}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${error}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

interface RepoInfo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  topics: string[];
}

interface IssueInfo {
  number: number;
  title: string;
  state: string;
  html_url: string;
  body: string | null;
  user: { login: string };
  labels: Array<{ name: string }>;
  assignees: Array<{ login: string }>;
  created_at: string;
  updated_at: string;
}

interface PRInfo extends IssueInfo {
  head: { ref: string };
  base: { ref: string };
  merged: boolean;
  mergeable: boolean | null;
}

interface FileContent {
  name: string;
  path: string;
  sha: string;
  size: number;
  html_url: string;
  content: string;
  encoding: string;
}

interface CommitInfo {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string };
  };
  html_url: string;
}

interface SearchResult {
  total_count: number;
  items: Array<{
    html_url: string;
    path?: string;
    repository?: { full_name: string };
    title?: string;
    number?: number;
  }>;
}

async function executeAction(
  action: GitHubAction,
  params: z.infer<typeof githubParams>,
  token: string
): Promise<unknown> {
  const {
    owner,
    repo,
    number,
    title,
    body,
    state,
    labels,
    assignees,
    path,
    ref,
    base,
    head,
    query,
    perPage = 30,
    page = 1,
  } = params;

  const enc = {
    owner: encodeURIComponent(owner),
    repo: encodeURIComponent(repo),
  };

  const queryParams = new URLSearchParams();
  if (state) queryParams.set('state', state);
  if (perPage) queryParams.set('per_page', perPage.toString());
  if (page) queryParams.set('page', page.toString());

  const qs = queryParams.toString();
  const queryString = qs ? `?${qs}` : '';

  switch (action) {
    case 'get_repo': {
      const data = (await githubFetch(`/repos/${enc.owner}/${enc.repo}`, token)) as RepoInfo;
      return {
        name: data.name,
        fullName: data.full_name,
        description: data.description,
        url: data.html_url,
        defaultBranch: data.default_branch,
        stars: data.stargazers_count,
        forks: data.forks_count,
        openIssues: data.open_issues_count,
        language: data.language,
        topics: data.topics,
      };
    }

    case 'list_issues': {
      const data = (await githubFetch(
        `/repos/${enc.owner}/${enc.repo}/issues${queryString}`,
        token
      )) as IssueInfo[];
      return data
        .filter((i) => !('pull_request' in i))
        .map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          url: i.html_url,
          author: i.user.login,
          labels: i.labels.map((l) => l.name),
          createdAt: i.created_at,
        }));
    }

    case 'get_issue': {
      if (!number) throw new Error('Issue number required');
      const data = (await githubFetch(
        `/repos/${enc.owner}/${enc.repo}/issues/${number}`,
        token
      )) as IssueInfo;
      return {
        number: data.number,
        title: data.title,
        state: data.state,
        url: data.html_url,
        body: data.body,
        author: data.user.login,
        labels: data.labels.map((l) => l.name),
        assignees: data.assignees.map((a) => a.login),
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      };
    }

    case 'create_issue': {
      if (!title) throw new Error('Issue title required');
      const payload: Record<string, unknown> = { title, body };
      if (labels) payload.labels = labels;
      if (assignees) payload.assignees = assignees;

      const data = (await githubFetch(`/repos/${enc.owner}/${enc.repo}/issues`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })) as IssueInfo;

      return {
        number: data.number,
        title: data.title,
        url: data.html_url,
        created: true,
      };
    }

    case 'update_issue': {
      if (!number) throw new Error('Issue number required');
      const payload: Record<string, unknown> = {};
      if (title) payload.title = title;
      if (body !== undefined) payload.body = body;
      if (state && state !== 'all') payload.state = state;
      if (labels) payload.labels = labels;
      if (assignees) payload.assignees = assignees;

      const data = (await githubFetch(`/repos/${enc.owner}/${enc.repo}/issues/${number}`, token, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })) as IssueInfo;

      return {
        number: data.number,
        title: data.title,
        state: data.state,
        url: data.html_url,
        updated: true,
      };
    }

    case 'list_prs': {
      const data = (await githubFetch(
        `/repos/${enc.owner}/${enc.repo}/pulls${queryString}`,
        token
      )) as PRInfo[];
      return data.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        url: pr.html_url,
        author: pr.user.login,
        head: pr.head.ref,
        base: pr.base.ref,
        createdAt: pr.created_at,
      }));
    }

    case 'get_pr': {
      if (!number) throw new Error('PR number required');
      const data = (await githubFetch(
        `/repos/${enc.owner}/${enc.repo}/pulls/${number}`,
        token
      )) as PRInfo;
      return {
        number: data.number,
        title: data.title,
        state: data.state,
        url: data.html_url,
        body: data.body,
        author: data.user.login,
        head: data.head.ref,
        base: data.base.ref,
        merged: data.merged,
        mergeable: data.mergeable,
        labels: data.labels.map((l) => l.name),
        createdAt: data.created_at,
        updatedAt: data.updated_at,
      };
    }

    case 'create_pr': {
      if (!title) throw new Error('PR title required');
      if (!head) throw new Error('Head branch required');
      if (!base) throw new Error('Base branch required');

      const data = (await githubFetch(`/repos/${enc.owner}/${enc.repo}/pulls`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, head, base }),
      })) as PRInfo;

      return {
        number: data.number,
        title: data.title,
        url: data.html_url,
        created: true,
      };
    }

    case 'get_file': {
      if (!path) throw new Error('File path required');
      const refParam = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const data = (await githubFetch(
        `/repos/${enc.owner}/${enc.repo}/contents/${encodePath(path)}${refParam}`,
        token
      )) as FileContent;

      const content =
        data.encoding === 'base64'
          ? Buffer.from(data.content, 'base64').toString('utf-8')
          : data.content;

      return {
        name: data.name,
        path: data.path,
        sha: data.sha,
        size: data.size,
        url: data.html_url,
        content,
      };
    }

    case 'list_commits': {
      if (ref) queryParams.set('sha', ref);
      const commitQs = queryParams.toString();
      const commitQueryString = commitQs ? `?${commitQs}` : '';
      const data = (await githubFetch(
        `/repos/${enc.owner}/${enc.repo}/commits${commitQueryString}`,
        token
      )) as CommitInfo[];
      return data.map((c) => ({
        sha: c.sha.slice(0, 7),
        fullSha: c.sha,
        message: c.commit.message.split('\n')[0],
        author: c.commit.author.name,
        date: c.commit.author.date,
        url: c.html_url,
      }));
    }

    case 'search_code': {
      if (!query) throw new Error('Search query required');
      const searchQuery = `${query} repo:${owner}/${repo}`;
      const data = (await githubFetch(
        `/search/code?q=${encodeURIComponent(searchQuery)}&per_page=${perPage}&page=${page}`,
        token
      )) as SearchResult;
      return {
        totalCount: data.total_count,
        results: data.items.map((i) => ({
          path: i.path,
          url: i.html_url,
        })),
      };
    }

    case 'search_issues': {
      if (!query) throw new Error('Search query required');
      const searchQuery = `${query} repo:${owner}/${repo}`;
      const data = (await githubFetch(
        `/search/issues?q=${encodeURIComponent(searchQuery)}&per_page=${perPage}&page=${page}`,
        token
      )) as SearchResult;
      return {
        totalCount: data.total_count,
        results: data.items.map((i) => ({
          number: i.number,
          title: i.title,
          url: i.html_url,
        })),
      };
    }
  }
}

export const githubApi = tool({
  name: 'github_api',
  description:
    'Interact with GitHub API. Get repo info, list/create/update issues and PRs, read files, list commits, search code. Requires GITHUB_TOKEN environment variable.',
  parameters: githubParams,
  category: 'development',
  tags: ['github', 'git', 'issues', 'pr', 'code', 'repository'],
  sideEffects: ['network'],
  execute: async (params) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return { error: 'GITHUB_TOKEN environment variable not set' };
    }

    try {
      return await executeAction(params.action, params, token);
    } catch (err) {
      return { error: (err as Error).message, action: params.action };
    }
  },
});
