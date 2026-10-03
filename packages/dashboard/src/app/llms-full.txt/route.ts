import { buildLlmsFull, PLAIN_TEXT_HEADERS } from '@/lib/llms';

export const revalidate = false;

export async function GET() {
  return new Response(await buildLlmsFull(), { headers: PLAIN_TEXT_HEADERS });
}
