# @cogitator-ai/dashboard

Public website for Cogitator, built with Next.js and [Fumadocs](https://fumadocs.dev).

The package is private and is not published to npm. It contains no admin UI, authentication or runtime API: to expose agents over HTTP, use a server adapter (`@cogitator-ai/express`, `fastify`, `hono`, `koa`, `next`); to monitor them in production, use the OpenTelemetry / Langfuse integrations from `@cogitator-ai/core`.

## Routes

| Route          | Source                                       | Description                    |
| -------------- | -------------------------------------------- | ------------------------------ |
| `/`            | `src/app/page.tsx`, `src/components/landing` | Landing page                   |
| `/docs`        | `content/docs/**/*.mdx`, `src/app/docs`      | Documentation (Fumadocs)       |
| `/cookbook`    | `src/app/cookbook`                           | Cookbook of end-to-end recipes |
| `/api/search`  | `src/app/api/search/route.ts`                | Full-text search over the docs |
| `/sitemap.xml` | `src/app/sitemap.ts`                         | Sitemap                        |

Old `/dashboard/*` and `/auth/*` links from the removed admin UI are permanently redirected to `/` by `src/proxy.ts`.

## Development

```bash
pnpm --filter @cogitator-ai/dashboard dev
```

The site runs at `http://localhost:3000`.

### Writing docs

Docs live in `content/docs/` as MDX files. Each section has a `meta.json` that sets the page order in the sidebar. `source.config.ts` configures the Fumadocs collection, and `src/lib/source.ts` loads it for the docs pages and the search route.

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
