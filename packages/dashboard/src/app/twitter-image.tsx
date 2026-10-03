import { OG_IMAGE_ALT, OG_IMAGE_CONTENT_TYPE, OG_IMAGE_SIZE, renderOgImage } from '@/lib/og-image';

export const alt = OG_IMAGE_ALT;
export const size = OG_IMAGE_SIZE;
export const contentType = OG_IMAGE_CONTENT_TYPE;

export default function Image() {
  return renderOgImage();
}
