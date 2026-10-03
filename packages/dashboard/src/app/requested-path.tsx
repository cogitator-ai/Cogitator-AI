'use client';

import { usePathname } from 'next/navigation';

/** The path that was requested, for the 404 page's vox log. */
export function RequestedPath() {
  return usePathname();
}
