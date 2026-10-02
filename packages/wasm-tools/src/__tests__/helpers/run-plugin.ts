import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Script, createContext } from 'node:vm';

const pluginsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins');
const bundles = new Map<string, Script>();

export interface PluginRun<T> {
  code: number;
  output: T;
}

function bundle(name: string): Script {
  const cached = bundles.get(name);
  if (cached) return cached;
  const result = buildSync({
    entryPoints: [join(pluginsDir, `${name}.ts`)],
    bundle: true,
    format: 'cjs',
    target: 'es2020',
    write: false,
    logLevel: 'silent',
  });
  const script = new Script(result.outputFiles[0].text, { filename: `${name}.plugin.js` });
  bundles.set(name, script);
  return script;
}

export function runPlugin<T = Record<string, unknown>>(
  name: string,
  fn: string,
  input: unknown
): PluginRun<T> {
  let raw = '';
  const module = { exports: {} as Record<string, () => number> };
  const context = createContext({
    module,
    exports: module.exports,
    Host: {
      inputString: () => (typeof input === 'string' ? input : JSON.stringify(input)),
      outputString: (value: string) => {
        raw = value;
      },
    },
  });
  bundle(name).runInContext(context);
  const exported = module.exports[fn];
  if (typeof exported !== 'function') {
    throw new Error(`Plugin ${name} does not export ${fn}`);
  }
  const code = exported();
  return { code, output: JSON.parse(raw) as T };
}

export function pluginCall<T = Record<string, unknown>>(name: string, fn: string) {
  return (input: unknown): T => runPlugin<T>(name, fn, input).output;
}
