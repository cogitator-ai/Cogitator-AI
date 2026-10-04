---
'@cogitator-ai/core': minor
---

`web_search` gets filters that work on every provider: `topic` (`general` or `news`), `recency` (`day`, `week`, `month`, `year`) or a `dateRange`, `includeDomains` and `excludeDomains`, `country`, `language` and `page`. Each maps to the provider's own parameters (Tavily's request fields, the news endpoints and query parameters of Brave and Serper), with `site:` operators where a provider has no domain parameter. A filter a provider cannot apply comes back as an error instead of being dropped. Tavily also takes `includeRawContent` and the `fast` and `ultra-fast` search depths. Results carry `publishedAt` in ISO 8601 when the provider reports a date, `source` for Serper news and `content` for raw page content. `createWebSearchTool({ provider, apiKeys })` builds the tool with a default provider and keys passed in code.
