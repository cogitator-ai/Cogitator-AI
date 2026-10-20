import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * Where datasets, embeddings and run results are kept between runs: `MEMORY_BENCH_CACHE`, else
 * `~/.cache/cogitator/memory-bench`. Datasets are downloaded here, never committed: their
 * licenses (CC BY-SA, CC BY-NC) do not allow shipping them with the repository.
 */
export function cacheDir(): string {
  return process.env.MEMORY_BENCH_CACHE ?? join(homedir(), '.cache', 'cogitator', 'memory-bench');
}

/**
 * The local path of `url`, downloaded once into the cache as `name`. A partial download never
 * stays behind: the file is written next to its place and moved there when complete.
 */
export async function cachedDownload(
  url: string,
  name: string,
  log: (line: string) => void = () => undefined
): Promise<string> {
  const path = join(cacheDir(), 'datasets', name);
  if (existsSync(path)) return path;
  await mkdir(dirname(path), { recursive: true });
  log(`downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download of ${url} failed with HTTP ${response.status}`);
  }
  const partial = `${path}.partial`;
  try {
    await pipeline(response.body, createWriteStream(partial));
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return path;
}
