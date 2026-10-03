import { renderNotFoundOgImage } from '@/lib/og-image';

export const dynamic = 'force-static';

/** Social card linked from the 404 page's metadata. */
export function GET() {
  return renderNotFoundOgImage();
}
