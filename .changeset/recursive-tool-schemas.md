---
'@cogitator-ai/types': minor
'@cogitator-ai/core': minor
'@cogitator-ai/wasm-tools': patch
---

Tool parameter schemas reach every provider self-contained. A recursive Zod schema (`z.lazy()`) used to arrive with a `$ref` to a definition the request no longer carried. Now the definitions recursive refs point to travel in `parameters.$defs` (`ToolSchema.parameters` is typed as `ToolParametersSchema`, a JSON Schema object with optional `$defs`), refs to other definitions are inlined, and Google gets recursive schemas as `parametersJsonSchema`. `ToolRegistry.getSchemas()` sends each tool's own `toJSON()`, so tools that carry a JSON Schema (MCP, AI SDK) keep it, and `registerMany` warns when two different tools in one list share a name. The new `toToolParameters()` applies the same rules to any JSON Schema. WASM tools keep their definitions too.
