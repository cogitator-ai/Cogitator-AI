# @cogitator-ai/dashboard

Public website for Cogitator, built with Next.js and [Fumadocs](https://fumadocs.dev).

The package is private and is not published to npm. It contains no admin UI, authentication or runtime API: to expose agents over HTTP, use a server adapter (`@cogitator-ai/express`, `fastify`, `hono`, `koa`, `next`); to monitor them in production, use the OpenTelemetry / Langfuse integrations from `@cogitator-ai/core`.

## Routes

| Route              | Source                                       | Description                    |
| ------------------ | -------------------------------------------- | ------------------------------ |
| `/`                | `src/app/page.tsx`, `src/components/landing` | Landing page                   |
| `/docs`            | `content/docs/**/*.mdx`, `src/app/docs`      | Documentation (Fumadocs)       |
| `/cookbook`        | `src/app/cookbook`                           | Cookbook of end-to-end recipes |
| `/api/search`      | `src/app/api/search/route.ts`                | Full-text search over the docs |
| `/sitemap.xml`     | `src/app/sitemap.ts`                         | Sitemap                        |
| `/llms.txt`        | `src/app/llms.txt`, `src/lib/llms.ts`        | Docs index for LLMs            |
| `/llms-full.txt`   | `src/app/llms-full.txt`, `src/lib/llms.ts`   | All docs as one text file      |
| `/llms.mdx/docs/…` | `src/app/llms.mdx/docs`                      | A docs page as Markdown        |

`src/proxy.ts` permanently redirects old `/dashboard/*` and `/auth/*` links from the removed admin UI to `/`, and serves a docs page as Markdown when the request prefers it (`Accept` negotiation); `/docs/<page>.md` and `/docs/<page>.mdx` are rewritten to the Markdown route in `next.config.mjs`.

Site-wide constants (URLs, name, description, community link) live in `src/lib/site.ts`; the counts shown on the landing page (providers, memory backends, …) live in `src/lib/stats.ts`, each list noting the source it mirrors.

## Development

```bash
pnpm install                                # from the repo root
pnpm --filter @cogitator-ai/dashboard dev   # next dev --turbopack
pnpm --filter @cogitator-ai/dashboard lint
```

The site runs at `http://localhost:3000`.

### Writing docs

Docs live in `content/docs/` as MDX files: one directory per section (`getting-started`, `cli`, `core`, `tools`, `browser`, `memory`, `rag`, `voice`, `evals`, `workflows`, `swarms`, `channels`, `server-adapters`, `integrations`, `advanced`, `deployment`, `testing`, `api-reference`) plus `index.mdx` and `architecture.mdx`. Each section has a `meta.json` that sets the page order in the sidebar, and `content/docs/meta.json` sets the section order and separators. A new section needs its directory, a `meta.json` and an entry in the root `meta.json`. A page at `content/docs/<section>/<page>.mdx` is served at `/docs/<section>/<page>` (`index.mdx` at `/docs/<section>`).

`source.config.ts` configures the Fumadocs collection, and `src/lib/source.ts` loads it for the docs pages and the search route.

### Landing page and cookbook

- The landing page is assembled in `src/app/page.tsx` from the components in `src/components/landing/` (`Hero` with its `TerminalDemo`, `FeaturesGrid` of `FeatureCard`s, `BackgroundGrid`, `Footer`). Feature lists, counters and code snippets shown there live in those components — update them when a feature or its API changes.
- The cookbook is a single page, `src/app/cookbook/page.tsx`: the `sections` array lists the recipes (`id`, `title`, `difficulty`, `time`), and `RecipeContent` holds each recipe's text and code by `id`. Keep their snippets in sync with the package APIs.

## Production

```bash
pnpm --filter @cogitator-ai/dashboard build
pnpm --filter @cogitator-ai/dashboard start
```

The build uses Next.js `standalone` output. `Dockerfile.dashboard` in the repo root builds a container image that serves it on port 3005, and `vercel.json` holds the monorepo build settings for Vercel.

### Environment variables

| Variable               | Description                                               | Default                 |
| ---------------------- | --------------------------------------------------------- | ----------------------- |
| `NEXT_PUBLIC_SITE_URL` | Public URL of the site, used for metadata and the sitemap | `https://cogitator.app` |

See [.env.production.example](.env.production.example).

## License

MIT
