import { z } from 'zod';

const waitUntilEnum = z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']);

export const navigateSchema = z.object({
  url: z
    .string()
    .min(1)
    .refine((value) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value), {
      message: 'URL must start with a scheme such as https:, about:, data:, or file:',
    })
    .describe('URL to navigate to'),
  waitUntil: waitUntilEnum.optional().describe('When to consider navigation succeeded'),
});
export type NavigateInput = z.infer<typeof navigateSchema>;

export const goBackSchema = z.object({});
export type GoBackInput = z.infer<typeof goBackSchema>;

export const goForwardSchema = z.object({});
export type GoForwardInput = z.infer<typeof goForwardSchema>;

export const reloadSchema = z.object({
  waitUntil: waitUntilEnum.optional().describe('When to consider reload succeeded'),
});
export type ReloadInput = z.infer<typeof reloadSchema>;

const timeoutSchema = z.number().int().min(0).describe('Timeout in milliseconds (0 disables it)');

export const waitForNavigationSchema = z.object({
  url: z.string().optional().describe('URL glob pattern to wait for'),
  timeout: timeoutSchema.optional(),
});
export type WaitForNavigationInput = z.infer<typeof waitForNavigationSchema>;

export const getCurrentUrlSchema = z.object({});
export type GetCurrentUrlInput = z.infer<typeof getCurrentUrlSchema>;

export const waitForSelectorSchema = z.object({
  selector: z.string().describe('CSS selector to wait for'),
  state: z
    .enum(['visible', 'hidden', 'attached', 'detached'])
    .optional()
    .describe('Element state to wait for'),
  timeout: timeoutSchema.optional(),
});
export type WaitForSelectorInput = z.infer<typeof waitForSelectorSchema>;

export const clickSchema = z.object({
  selector: z.string().describe('CSS selector of element to click'),
  button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button'),
  clickCount: z.number().int().min(1).optional().describe('Number of clicks (2 for double-click)'),
  position: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .optional()
    .describe('Position relative to element'),
});
export type ClickInput = z.infer<typeof clickSchema>;

export const typeSchema = z.object({
  selector: z.string().describe('CSS selector of input element'),
  text: z.string().describe('Text to type'),
  delay: z.number().min(0).optional().describe('Delay between keystrokes in ms'),
  clearFirst: z.boolean().optional().describe('Clear the field before typing'),
});
export type TypeInput = z.infer<typeof typeSchema>;

export const selectOptionSchema = z
  .object({
    selector: z.string().describe('CSS selector of select element'),
    value: z.string().optional().describe('Option value to select'),
    label: z.string().optional().describe('Option label to select'),
    index: z.number().int().min(0).optional().describe('Option index to select'),
  })
  .refine(
    (data) => data.value !== undefined || data.label !== undefined || data.index !== undefined,
    {
      message: 'At least one of value, label, or index is required',
    }
  );
export type SelectOptionInput = z.infer<typeof selectOptionSchema>;

export const hoverSchema = z.object({
  selector: z.string().describe('CSS selector of element to hover'),
  position: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe('Position relative to element'),
});
export type HoverInput = z.infer<typeof hoverSchema>;

export const scrollSchema = z.object({
  direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
  amount: z.number().min(0).optional().describe('Scroll amount in pixels (default 500)'),
  selector: z.string().optional().describe('CSS selector of scrollable element'),
});
export type ScrollInput = z.infer<typeof scrollSchema>;

export const pressKeySchema = z.object({
  key: z.string().describe('Key to press (e.g., "Enter", "Tab", "a")'),
  modifiers: z
    .array(z.enum(['Shift', 'Control', 'Alt', 'Meta']))
    .optional()
    .describe('Modifier keys to hold'),
});
export type PressKeyInput = z.infer<typeof pressKeySchema>;

export const dragAndDropSchema = z.object({
  source: z.string().describe('CSS selector of drag source'),
  target: z.string().describe('CSS selector of drop target'),
});
export type DragAndDropInput = z.infer<typeof dragAndDropSchema>;

export const fillFormSchema = z.object({
  fields: z
    .record(z.string(), z.union([z.string(), z.boolean(), z.array(z.string())]))
    .describe('Form fields to fill: { "Field Label": "value" }'),
});
export type FillFormInput = z.infer<typeof fillFormSchema>;

export const uploadFileSchema = z.object({
  selector: z.string().describe('CSS selector of file input'),
  filePaths: z.array(z.string().min(1)).min(1).describe('Paths to files to upload'),
});
export type UploadFileInput = z.infer<typeof uploadFileSchema>;

export const getTextSchema = z.object({
  selector: z.string().optional().describe('CSS selector to extract text from (defaults to body)'),
});
export type GetTextInput = z.infer<typeof getTextSchema>;

export const getHtmlSchema = z.object({
  selector: z.string().optional().describe('CSS selector (defaults to full page)'),
  outer: z.boolean().optional().describe('Include outer HTML of element'),
});
export type GetHtmlInput = z.infer<typeof getHtmlSchema>;

export const getAttributeSchema = z.object({
  selector: z.string().describe('CSS selector of element'),
  attribute: z.string().describe('Attribute name to get'),
});
export type GetAttributeInput = z.infer<typeof getAttributeSchema>;

export const getLinksSchema = z.object({
  selector: z.string().optional().describe('CSS selector to scope link search'),
  baseUrl: z.string().optional().describe('Base URL for resolving relative links'),
});
export type GetLinksInput = z.infer<typeof getLinksSchema>;

export const querySelectorAllSchema = z.object({
  selector: z.string().describe('CSS selector to query'),
  attributes: z.array(z.string()).optional().describe('Attributes to include per element'),
  limit: z.number().int().min(0).optional().describe('Max elements to return'),
});
export type QuerySelectorAllInput = z.infer<typeof querySelectorAllSchema>;

export const extractTableSchema = z.object({
  selector: z.string().optional().describe('CSS selector of table element'),
});
export type ExtractTableInput = z.infer<typeof extractTableSchema>;

export const extractStructuredSchema = z.object({
  instruction: z.string().describe('What data to extract from the page'),
  selector: z.string().optional().describe('CSS selector to scope extraction'),
});
export type ExtractStructuredInput = z.infer<typeof extractStructuredSchema>;

export const screenshotSchema = z.object({
  fullPage: z.boolean().optional().describe('Capture full scrollable page'),
  selector: z.string().optional().describe('CSS selector to screenshot specific element'),
  quality: z.number().min(0).max(100).optional().describe('Image quality 0-100 (JPEG only)'),
});
export type ScreenshotInput = z.infer<typeof screenshotSchema>;

export const screenshotElementSchema = z.object({
  selector: z.string().describe('CSS selector of element to screenshot'),
});
export type ScreenshotElementInput = z.infer<typeof screenshotElementSchema>;

export const findByDescriptionSchema = z.object({
  description: z.string().describe('Natural language description of element to find'),
});
export type FindByDescriptionInput = z.infer<typeof findByDescriptionSchema>;

export const clickByDescriptionSchema = z.object({
  description: z.string().describe('Natural language description of element to click'),
  index: z.number().int().min(0).optional().describe('Index of match to click if multiple found'),
});
export type ClickByDescriptionInput = z.infer<typeof clickByDescriptionSchema>;

export const interceptRequestSchema = z.object({
  urlPattern: z
    .string()
    .min(1)
    .describe('URL glob (e.g. "**/api/**") or regular expression literal (e.g. "/\\.png$/i")'),
  action: z.enum(['block', 'modify', 'continue']).describe('What to do with matching requests'),
  modify: z
    .object({
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
      url: z.string().optional(),
    })
    .optional()
    .describe('Modifications to apply (only for action=modify)'),
});
export type InterceptRequestInput = z.infer<typeof interceptRequestSchema>;

export const removeInterceptorSchema = z.object({
  interceptorId: z
    .string()
    .optional()
    .describe('Interceptor ID to remove; omit to remove all interceptors'),
});
export type RemoveInterceptorInput = z.infer<typeof removeInterceptorSchema>;

export const waitForResponseSchema = z.object({
  urlPattern: z
    .string()
    .min(1)
    .describe('URL substring or regular expression literal (e.g. "/api\\/v\\d+/") to wait for'),
  timeout: timeoutSchema.optional(),
});
export type WaitForResponseInput = z.infer<typeof waitForResponseSchema>;

export const blockResourcesSchema = z.object({
  types: z
    .array(z.enum(['image', 'stylesheet', 'font', 'media', 'script']))
    .min(1)
    .describe('Resource types to block'),
});
export type BlockResourcesInput = z.infer<typeof blockResourcesSchema>;

export const captureHarSchema = z.object({
  action: z.enum(['start', 'stop']).describe('Start or stop HAR capture'),
  path: z
    .string()
    .optional()
    .describe('File path inside the working directory to save a HAR 1.2 file (on stop)'),
});
export type CaptureHarInput = z.infer<typeof captureHarSchema>;

export const getApiCallsSchema = z.object({
  urlPattern: z
    .string()
    .optional()
    .describe('Filter API calls by URL substring or regular expression literal'),
  method: z.string().optional().describe('Filter by HTTP method'),
  clear: z
    .boolean()
    .optional()
    .describe('Remove the returned API calls from the record; calls the filters exclude are kept'),
});
export type GetApiCallsInput = z.infer<typeof getApiCallsSchema>;
