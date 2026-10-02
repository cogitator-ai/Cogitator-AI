import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPESCRIPT_EXTENSION = /\.[cm]?tsx?$/i;

let typeScriptLoaderRegistered = false;

export function isTypeScriptFile(filePath: string): boolean {
  return TYPESCRIPT_EXTENSION.test(filePath);
}

export async function registerTypeScriptLoader(projectDir: string): Promise<boolean> {
  if (typeScriptLoaderRegistered) return true;

  for (const base of [join(projectDir, 'package.json'), import.meta.url]) {
    let entry: string;
    try {
      entry = createRequire(base).resolve('tsx');
    } catch {
      continue;
    }
    await import(pathToFileURL(entry).href);
    typeScriptLoaderRegistered = true;
    return true;
  }

  return false;
}

export async function importUserModule(
  filePath: string,
  projectDir: string = dirname(filePath)
): Promise<Record<string, unknown>> {
  if (isTypeScriptFile(filePath) && !(await registerTypeScriptLoader(projectDir))) {
    throw new Error(
      `Loading ${basename(filePath)} requires tsx. Install it in your project: pnpm add -D tsx`
    );
  }

  const mod: unknown = await import(pathToFileURL(filePath).href);
  if (typeof mod !== 'object' || mod === null) {
    throw new Error(`${basename(filePath)} did not evaluate to an ES module namespace`);
  }
  return Object.fromEntries(Object.entries(mod));
}

export async function importOptionalPackage(
  name: string,
  projectDir: string
): Promise<Record<string, unknown> | null> {
  for (const base of [join(projectDir, 'package.json'), import.meta.url]) {
    let entry: string;
    try {
      entry = createRequire(base).resolve(name);
    } catch {
      continue;
    }
    const mod: unknown = await import(pathToFileURL(entry).href);
    if (typeof mod === 'object' && mod !== null) {
      return Object.fromEntries(Object.entries(mod));
    }
  }
  return null;
}
