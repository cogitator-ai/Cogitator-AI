import { NextResponse } from 'next/server';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth/middleware';

export const GET = withAuth(async (request: AuthenticatedRequest) => {
  const user = request.user!;
  return NextResponse.json({ user });
});
