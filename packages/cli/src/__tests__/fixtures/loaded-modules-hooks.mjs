import { appendFileSync } from 'node:fs';

const file = process.env.COGITATOR_TEST_LOADED_MODULES;

/** @type {import('node:module').LoadHook} */
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (file) appendFileSync(file, `${url}\n`);
  return loaded;
}
