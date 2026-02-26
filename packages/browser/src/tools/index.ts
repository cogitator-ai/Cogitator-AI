import type { Tool } from '@cogitator-ai/types';
import type { BrowserToolsOptions } from '@cogitator-ai/types';
import type { BrowserSession } from '../session';
import { createNavigationTools } from './navigation';
import { createInteractionTools } from './interaction';
import { createExtractionTools } from './extraction';
import { createVisionTools } from './vision';
import { createNetworkTools } from './network';

type ToolFactory = (session: BrowserSession) => Tool[];

const MODULE_FACTORIES: Record<string, ToolFactory> = {
  navigation: createNavigationTools as ToolFactory,
  interaction: createInteractionTools as ToolFactory,
  extraction: createExtractionTools as ToolFactory,
  vision: createVisionTools as ToolFactory,
  network: createNetworkTools as ToolFactory,
};

export function browserTools(session: BrowserSession, options?: BrowserToolsOptions): Tool[] {
  const modules = options?.modules ?? Object.keys(MODULE_FACTORIES);
  const tools: Tool[] = [];

  for (const mod of modules) {
    const factory = MODULE_FACTORIES[mod];
    if (factory) {
      tools.push(...factory(session));
    }
  }

  return tools;
}

export { createNavigationTools } from './navigation';
export { createInteractionTools } from './interaction';
export { createExtractionTools } from './extraction';
export { createVisionTools } from './vision';
export { createNetworkTools } from './network';

export {
  createNavigateTool,
  createGoBackTool,
  createGoForwardTool,
  createReloadTool,
  createWaitForNavigationTool,
  createGetCurrentUrlTool,
  createWaitForSelectorTool,
} from './navigation';

export {
  createClickTool,
  createTypeTool,
  createSelectOptionTool,
  createHoverTool,
  createScrollTool,
  createPressKeyTool,
  createDragAndDropTool,
  createFillFormTool,
  createUploadFileTool,
} from './interaction';

export {
  createGetTextTool,
  createGetHtmlTool,
  createGetAttributeTool,
  createGetLinksTool,
  createQuerySelectorAllTool,
  createExtractTableTool,
  createExtractStructuredTool,
} from './extraction';

export {
  createScreenshotTool,
  createScreenshotElementTool,
  createFindByDescriptionTool,
  createClickByDescriptionTool,
} from './vision';

export {
  createInterceptRequestTool,
  createWaitForResponseTool,
  createBlockResourcesTool,
  createCaptureHarTool,
  createGetApiCallsTool,
} from './network';
