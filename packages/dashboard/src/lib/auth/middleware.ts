import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export interface User {
  id: string;
  email?: string;
  role: 'admin' | 'user' | 'readonly';
}

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
  if (process.env.NODE_ENV === 'production') {
    return process.env.COGITATOR_AUTH_ENABLED !== 'false';
  }
  return process.env.COGITATOR_AUTH_ENABLED === 'true';
}

function getDefaultUser(): User {
  return {
    id: 'dev-admin',
    email: 'dev@localhost',
    role: 'admin',
  };
}

async function createSupabaseClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Component - cookies are read-only
          }
        },
      },
    }
  );
}

export async function getAuthenticatedUser(_request: NextRequest): Promise<User | null> {
  if (!isAuthEnabled()) {
    return getDefaultUser();
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    console.warn('[Auth] Supabase not configured, using default user');
    return getDefaultUser();
  }

  try {
    const supabase = await createSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) return null;

    return {
      id: user.id,
      email: user.email,
      role: (user.user_metadata?.role as User['role']) || 'user',
    };
  } catch (error) {
    console.error('[Auth] Failed to get user:', error);
    return null;
  }
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
  roles: ('admin' | 'user' | 'readonly')[],
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
