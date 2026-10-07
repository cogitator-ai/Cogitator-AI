import type { DeployVolume } from '@cogitator-ai/types';
import { posix } from 'node:path';
import { trimEdges, trimTrailing } from './utils/text.js';

/** The app directory in the image, where relative paths of the running app resolve. */
export const APP_DIR = '/app';

/** A Fly and Docker volume name for `volume`: lowercase letters, digits and underscores, 30 at most. */
export function volumeName(volume: DeployVolume): string {
  const words = trimEdges(
    (volume.name ?? volume.path).toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    '_'
  );
  return trimTrailing(words.slice(0, 30), '_') || 'data';
}

/** Where `volume` is mounted in the container. */
export function volumeMountPath(volume: DeployVolume): string {
  return posix.isAbsolute(volume.path) ? volume.path : posix.join(APP_DIR, volume.path);
}

/** Paths of volumes inside the project, kept out of the image so local data never ships. */
export function projectVolumePaths(volumes: readonly DeployVolume[] | undefined): string[] {
  return (volumes ?? [])
    .map((volume) => posix.normalize(volume.path))
    .filter((path) => !posix.isAbsolute(path) && !path.startsWith('..'))
    .map((path) => trimTrailing(path, '/'));
}
