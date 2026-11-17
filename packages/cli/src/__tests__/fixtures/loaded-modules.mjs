/**
 * Preloaded into a process with `--import`: writes the URL of every module the process loads
 * to the file COGITATOR_TEST_LOADED_MODULES names, one per line.
 */
import { register } from 'node:module';

register('./loaded-modules-hooks.mjs', import.meta.url);
