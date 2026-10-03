/** Public origin of the site, used for metadata, the sitemap and agent-facing text files. */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://cogitator.app';

export const SITE_NAME = 'Cogitator';

export const SITE_TAGLINE = 'AI agents that survive production';

export const SITE_DESCRIPTION =
  'Self-hosted, production-grade AI agent runtime for TypeScript: multi-provider LLMs, tools with approvals, memory and RAG, DAG workflows, multi-agent swarms, sandboxed execution, MCP and A2A.';

export const GITHUB_URL = 'https://github.com/cogitator-ai/Cogitator-AI';

export const GITHUB_EXAMPLES_URL = `${GITHUB_URL}/tree/main/examples`;

export const DOCS_SOURCE_URL = `${GITHUB_URL}/blob/main/packages/dashboard/content/docs`;

/** Where the community talks. Swap the URL and name here to move every link on the site at once. */
export const COMMUNITY = {
  name: 'Discussions',
  url: `${GITHUB_URL}/discussions`,
} as const;

export const DOCS_HOME = '/docs';

export const GET_STARTED_URL = '/docs/getting-started/quick-start';

export const COOKBOOK_URL = '/cookbook';

export const LLMS_TXT_URL = '/llms.txt';

export const LLMS_FULL_TXT_URL = '/llms-full.txt';
