import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  return NextResponse.redirect(new URL('/', request.url), 308);
}

export const config = {
  matcher: ['/dashboard', '/dashboard/:path*', '/auth', '/auth/:path*'],
};
