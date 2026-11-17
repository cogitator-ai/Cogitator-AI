/**
 * Loads the runtime before the tests of a file run. A server loads `@cogitator-ai/core` with its
 * first tool call, and through Vitest that load takes seconds on a busy machine, which would
 * count against the timeout of the first test that calls a tool.
 */
import '@cogitator-ai/core';
