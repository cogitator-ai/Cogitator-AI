import { renderIconTile } from '@/lib/og-image';

export const contentType = 'image/png';

/** PNG sizes of the mark: a 48px favicon (Google's minimum) plus the 192/512 PWA icons. */
export const ICON_SIZES = [48, 192, 512] as const;

export function generateImageMetadata() {
  return ICON_SIZES.map((iconSize) => ({
    id: String(iconSize),
    size: { width: iconSize, height: iconSize },
    contentType,
  }));
}

export default async function Icon({ id }: { id: Promise<string> }) {
  const iconSize = Number(await id);
  if (!ICON_SIZES.some((known) => known === iconSize)) {
    throw new Error(`Unknown icon size: ${iconSize}`);
  }
  return renderIconTile(iconSize);
}
