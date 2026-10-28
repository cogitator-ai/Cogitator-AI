import { z } from 'zod';

/** The version of the app-server protocol this package speaks */
export const APP_SERVER_PROTOCOL_VERSION = 1;

/** Data of the sender's own on any params or result, which the other side passes over */
export const MetaSchema = z
  .record(z.string(), z.unknown())
  .describe('Data of the sender of its own, the other side passes it over');

/** An object of the protocol: `shape` and an optional `_meta`, unknown keys dropped */
export function protocolObject<const T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...shape, _meta: MetaSchema.optional() });
}

export const PermissionModeSchema = z
  .enum(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'])
  .describe('How the tool calls of a turn are allowed, see PermissionMode in @cogitator-ai/types');

export const TextInputSchema = protocolObject({
  type: z.literal('text'),
  text: z.string(),
}).describe('Text the user wrote');

export const ImageUrlInputSchema = protocolObject({
  type: z.literal('image'),
  url: z.string().min(1).describe('An http(s) or data: URL of the image'),
}).describe('An image the model can fetch');

export const ImageDataInputSchema = protocolObject({
  type: z.literal('image'),
  data: z.string().min(1).describe('The image, base64 encoded'),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
}).describe('An image sent inline');

export const UserInputSchema = z
  .union([TextInputSchema, ImageUrlInputSchema, ImageDataInputSchema])
  .describe('One part of what the user sends: text or an image');

export const DeliverySchema = z
  .enum(['steer', 'followUp', 'inject'])
  .describe(
    '`steer` after the tool calls of the current step, `followUp` when the agent would stop, `inject` as context for the next model call'
  );

export const QueuedMessageSchema = protocolObject({
  delivery: DeliverySchema,
  input: z.array(UserInputSchema),
}).describe('A message sent to a turn that it had not taken when it ended');
