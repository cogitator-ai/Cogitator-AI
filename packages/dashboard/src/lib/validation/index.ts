import { NextResponse } from 'next/server';
import { type z, ZodError, type ZodSchema } from 'zod';
import type { AuthenticatedRequest, AuthenticatedRouteHandler } from '@/lib/auth/middleware';

export type ValidatedRouteHandler<T> = (
  request: AuthenticatedRequest & { validated: T },
  context?: { params?: Promise<Record<string, string>> }
) => NextResponse | Promise<NextResponse>;

export function withValidation<T extends ZodSchema>(
  schema: T,
  handler: ValidatedRouteHandler<z.infer<T>>
): AuthenticatedRouteHandler {
  return async (request, context) => {
    try {
      const body = await request.json();
      const validated = schema.parse(body);

      const validatedRequest = request as AuthenticatedRequest & { validated: z.infer<T> };
      validatedRequest.validated = validated;

      return handler(validatedRequest, context);
    } catch (error) {
      if (error instanceof ZodError) {
        return NextResponse.json(
          {
            error: 'Validation failed',
            details: error.issues.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
          },
          { status: 400 }
        );
      }

      if (error instanceof SyntaxError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }

      throw error;
    }
  };
}

export function withQueryValidation<T extends ZodSchema>(
  schema: T,
  handler: ValidatedRouteHandler<z.infer<T>>
): AuthenticatedRouteHandler {
  return async (request, context) => {
    try {
      const searchParams = request.nextUrl.searchParams;
      const params: Record<string, string> = {};
      searchParams.forEach((value, key) => {
        params[key] = value;
      });

      const validated = schema.parse(params);

      const validatedRequest = request as AuthenticatedRequest & { validated: z.infer<T> };
      validatedRequest.validated = validated;

      return handler(validatedRequest, context);
    } catch (error) {
      if (error instanceof ZodError) {
        return NextResponse.json(
          {
            error: 'Validation failed',
            details: error.issues.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
          },
          { status: 400 }
        );
      }

      throw error;
    }
  };
}

export * from './schemas/agents';
export * from './schemas/workflows';
export * from './schemas/swarms';
export * from './schemas/auth';
export * from './schemas/playground';
