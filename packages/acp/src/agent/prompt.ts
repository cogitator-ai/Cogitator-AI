import { fileURLToPath } from 'node:url';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { UserInput } from '@cogitator-ai/app-server';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

function imageType(mimeType: string | null | undefined): ImageType | undefined {
  return IMAGE_TYPES.find((type) => type === mimeType);
}

/** A `file://` URI as a path, any other URI as it is */
export function uriPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

/**
 * What an ACP prompt says, as the input parts of a turn: text as text, images inline or by URL,
 * an embedded resource as its text in a `<resource>` block (an image resource as the image), and
 * a link to a resource as a line naming it, which the agent reads with its own tools
 */
export function toUserInput(prompt: readonly ContentBlock[]): UserInput[] {
  const input: UserInput[] = [];
  for (const block of prompt) {
    switch (block.type) {
      case 'text':
        if (block.text !== '') input.push({ type: 'text', text: block.text });
        break;
      case 'image': {
        const mimeType = imageType(block.mimeType);
        if (mimeType && block.data !== '')
          input.push({ type: 'image', data: block.data, mimeType });
        else if (block.uri && /^https?:\/\//.test(block.uri)) {
          input.push({ type: 'image', url: block.uri });
        }
        break;
      }
      case 'resource': {
        const resource = block.resource;
        if ('text' in resource) {
          input.push({
            type: 'text',
            text: `<resource uri="${resource.uri}">\n${resource.text}\n</resource>`,
          });
        } else {
          const mimeType = imageType(resource.mimeType);
          if (mimeType) input.push({ type: 'image', data: resource.blob, mimeType });
          else
            input.push({
              type: 'text',
              text: `Attached binary resource: ${uriPath(resource.uri)}`,
            });
        }
        break;
      }
      case 'resource_link':
        input.push({
          type: 'text',
          text: `Referenced ${block.mimeType?.startsWith('image/') ? 'image' : 'file'}: ${uriPath(block.uri)}`,
        });
        break;
      case 'audio':
        break;
    }
  }
  return input;
}

/** The text of the input parts, joined as a run reads them */
export function inputText(input: readonly UserInput[]): string {
  return input
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n\n')
    .trim();
}

/** `text` without the `<resource>` blocks embedded resources became, found in one pass */
export function withoutResources(text: string): string {
  const open = '<resource';
  const close = '</resource>';
  let kept = '';
  let at = 0;
  for (;;) {
    const start = text.indexOf(open, at);
    if (start === -1) break;
    const end = text.indexOf(close, start + open.length);
    if (end === -1) break;
    kept += text.slice(at, start);
    at = end + close.length;
  }
  return kept + text.slice(at);
}

/** A short title for a session, from what its first prompt says */
export function titleOf(text: string, max = 80): string | undefined {
  const line = withoutResources(text)
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '');
  if (!line) return undefined;
  return line.length <= max ? line : `${line.slice(0, max - 3).trimEnd()}...`;
}
