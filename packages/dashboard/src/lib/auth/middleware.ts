import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, extractTokenFromHeader, type TokenPayload, type User } from './jwt';
import { cookies } from 'next/headers';

export interface AuthenticatedRequest extends NextRequest {
  user?: User;
}

export type RouteHandler = (
  request: NextRequest,
  context?: { params?: Promise<Record<string, string>> }
) => Promise<NextResponse> | NextResponse;

export type AuthenticatedRouteHandler = (
  request: AuthenticatedRequest,
  context?: { params?: Promise<Record<string, string>> }
) => Promise<NextResponse> | NextResponse;

function isAuthEnabled(): boolean {
  return process.env.COGITATOR_AUTH_ENABLED === 'true';
}

function getDefaultUser(): User {
  return {
    id: 'default-admin',
    role: 'admin',
  };
}

export async function getAuthenticatedUser(request: NextRequest): Promise<User | null> {
  if (!isAuthEnabled()) {
    return getDefaultUser();
  }

  const authHeader = request.headers.get('Authorization');
  let token = extractTokenFromHeader(authHeader);

  if (!token) {
    const cookieStore = await cookies();
    token = cookieStore.get('cogitator_token')?.value || null;
  }

  if (!token) return null;

  const payload = await verifyToken(token);
  if (!payload || payload.type !== 'access') return null;

  return {
    id: payload.sub,
    email: payload.email,
    role: payload.role,
  };
}

export function withAuth(handler: AuthenticatedRouteHandler): RouteHandler {
  return async (request: NextRequest, context) => {
    const user = await getAuthenticatedUser(request);

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', code: 'AUTH_REQUIRED' },
        { status: 401 }
      );
    }

    (request as AuthenticatedRequest).user = user;
    return handler(request as AuthenticatedRequest, context);
  };
}

export function withRole(
  roles: Array<'admin' | 'user' | 'readonly'>,
  handler: AuthenticatedRouteHandler
): RouteHandler {
  return async (request: NextRequest, context) => {
    const user = await getAuthenticatedUser(request);

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized', code: 'AUTH_REQUIRED' },
        { status: 401 }
      );
    }

    if (!roles.includes(user.role)) {
      return NextResponse.json(
        { error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' },
        { status: 403 }
      );
    }

    (request as AuthenticatedRequest).user = user;
    return handler(request as AuthenticatedRequest, context);
  };
}

export function canRead(user: User): boolean {
  return ['admin', 'user', 'readonly'].includes(user.role);
}

export function canWrite(user: User): boolean {
  return ['admin', 'user'].includes(user.role);
}

export function canAdmin(user: User): boolean {
  return user.role === 'admin';
}
