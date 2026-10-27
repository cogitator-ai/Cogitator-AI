import type { PluginDefinition } from '@cogitator-ai/types';
import { pluginNameProblem } from './manifest';

/**
 * Defines a plugin in code: its manifest fields and `activate`, which registers what it adds
 * through its `PluginContext`. Give it to `experimental_plugins.plugins`, or export it as the
 * default of the module a plugin folder's `.cogitator-plugin/plugin.json` names as `main` (it then
 * runs in a process of its own)
 *
 * @example
 * ```ts
 * export default experimental_definePlugin({
 *   name: 'weather',
 *   version: '1.0.0',
 *   activate(context) {
 *     context.registerTool({
 *       name: 'weather_now',
 *       description: 'The weather in a city now',
 *       parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
 *       execute: async ({ city }) => `Sunny in ${String(city)}`,
 *     });
 *   },
 * });
 * ```
 */
export function experimental_definePlugin<T extends PluginDefinition>(definition: T): T {
  const problem = pluginNameProblem(definition.name);
  if (problem) throw new TypeError(`The plugin name "${definition.name}" ${problem}`);
  return definition;
}
