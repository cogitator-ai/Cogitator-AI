import { renderIconTile } from '@/lib/og-image';

export const size = { width: 180, height: 180 };

export const contentType = 'image/png';

/** Home-screen icon for iOS. */
export default function AppleIcon() {
  return renderIconTile(size.width);
}
