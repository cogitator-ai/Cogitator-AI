import type { StageDefinition } from '../runner/types.js';
import { a2aStage } from './protocols/a2a.js';
import { mcpAgentsStage, mcpToolsStage } from './protocols/mcp.js';
import { sandboxDockerStage, sandboxWasmStage } from './protocols/sandbox.js';
import {
  generatedToolSandboxStage,
  selfModifyingAgentStage,
  toolGenerationStage,
} from './protocols/self-modifying.js';
import { wasmToolsStage } from './protocols/wasm-tools.js';

/** Tools, protocols and sandboxes: MCP, A2A, WASM tools, Docker and WASM sandboxes, self-modification. */
export const protocolStages: StageDefinition[] = [
  mcpToolsStage,
  mcpAgentsStage,
  a2aStage,
  wasmToolsStage,
  sandboxWasmStage,
  sandboxDockerStage,
  generatedToolSandboxStage,
  toolGenerationStage,
  selfModifyingAgentStage,
];
