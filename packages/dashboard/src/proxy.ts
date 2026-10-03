import { NextResponse, type NextRequest } from 'next/server';
import { isMarkdownPreferred, rewritePath } from 'fumadocs-core/negotiation';

const LEGACY_PREFIXES = ['/dashboard', '/auth'];

const { rewrite: rewriteDocsToMarkdown } = rewritePath('/docs{/*path}', '/llms.mdx/docs{/*path}');

function isLegacyPath(pathname: string): boolean {
  return LEGACY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isLegacyPath(pathname)) {
    return NextResponse.redirect(new URL('/', request.url), 308);
  }

  if (isMarkdownPreferred(request)) {
    const markdownPath = rewriteDocsToMarkdown(pathname);
    if (markdownPath) return NextResponse.rewrite(new URL(markdownPath, request.nextUrl));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard', '/dashboard/:path*', '/auth', '/auth/:path*', '/docs', '/docs/:path*'],
};
