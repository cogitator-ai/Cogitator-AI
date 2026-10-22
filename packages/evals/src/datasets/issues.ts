import type { z } from 'zod';

/** What a case breaks of the case schema, one `field: problem` per issue */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(case)'}: ${issue.message}`)
    .join('; ');
}
