import { buildLlmsIndex, PLAIN_TEXT_HEADERS } from '@/lib/llms';

export const revalidate = false;

export function GET() {
  return new Response(buildLlmsIndex(), { headers: PLAIN_TEXT_HEADERS });
}
