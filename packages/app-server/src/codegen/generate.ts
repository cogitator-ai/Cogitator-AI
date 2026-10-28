import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateTypeScriptClient } from './typescript.js';

/** Where the generated client lives in the package, checked by the drift test */
export const GENERATED_CLIENT_PATH = fileURLToPath(
  new URL('../client/generated.ts', import.meta.url)
);

writeFileSync(GENERATED_CLIENT_PATH, generateTypeScriptClient());
console.log(`Wrote ${GENERATED_CLIENT_PATH}`);
