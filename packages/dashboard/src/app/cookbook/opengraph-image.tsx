import { OG_IMAGE_CONTENT_TYPE, OG_IMAGE_SIZE } from '@/lib/og-image';
import { COOKBOOK_OG_ALT, renderCookbookOgImage } from './social-card';

export const alt = COOKBOOK_OG_ALT;
export const size = OG_IMAGE_SIZE;
export const contentType = OG_IMAGE_CONTENT_TYPE;

export default function Image() {
  return renderCookbookOgImage();
}
