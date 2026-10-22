import type { z } from 'zod';

/** Parses options with a schema, throwing one readable error that names what is wrong */
export function parseOptions<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  label: string
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
  );
  throw new Error(`${label}: ${issues.join(', ')}`);
}
