import { z } from 'zod';

const AccountSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  aadObjectId: z.string().optional(),
});

const ConversationSchema = z.object({
  id: z.string().min(1),
  conversationType: z.string().optional(),
  tenantId: z.string().optional(),
});

const ChannelDataSchema = z.object({
  tenant: z.object({ id: z.string() }).optional(),
  team: z.object({ id: z.string() }).optional(),
});

const MentionSchema = z.object({
  type: z.literal('mention'),
  text: z.string().optional(),
  mentioned: z.object({ id: z.string() }),
});

const AttachmentSchema = z.object({
  contentType: z.string(),
  contentUrl: z.string().optional(),
  name: z.string().optional(),
  content: z.unknown().optional(),
});

const ActivitySchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  channelId: z.string(),
  serviceUrl: z.string().min(1),
  from: AccountSchema,
  recipient: AccountSchema.optional(),
  conversation: ConversationSchema,
  text: z.string().optional(),
  replyToId: z.string().optional(),
  value: z.unknown().optional(),
  entities: z.array(z.unknown()).optional(),
  attachments: z.array(z.unknown()).optional(),
  channelData: z.unknown().optional(),
});

/** An activity Bot Framework posts to the bot, reduced to what the channel reads. */
export type TeamsActivity = z.infer<typeof ActivitySchema>;

/** An attachment of an activity. */
export type TeamsAttachment = z.infer<typeof AttachmentSchema>;

/** The kind of a Teams conversation: a personal chat, a group chat or a thread of a team channel. */
export type TeamsConversationType = 'personal' | 'groupChat' | 'channel';

/** Reads an activity, or throws when the JSON is not one. */
export function parseActivity(json: unknown): TeamsActivity {
  return ActivitySchema.parse(json);
}

const THREAD_MARKER = ';messageid=';

/**
 * A conversation id split into the conversation and the thread inside it: a channel thread is
 * `<channel id>;messageid=<root message id>`, other conversations have no thread.
 */
export function splitConversation(id: string): { channelId: string; topicId?: string } {
  const at = id.indexOf(THREAD_MARKER);
  if (at < 0) return { channelId: id };
  const topicId = id.slice(at + THREAD_MARKER.length);
  return { channelId: id.slice(0, at), ...(topicId && { topicId }) };
}

/** The conversation id of a chat and the thread inside it, as {@link splitConversation} reads it. */
export function joinConversation(channelId: string, topicId?: string): string {
  if (!topicId || channelId.includes(THREAD_MARKER)) return channelId;
  return `${channelId}${THREAD_MARKER}${topicId}`;
}

/** The kind of a conversation: as the activity says, or guessed from the shape of its id. */
export function conversationTypeOf(id: string, declared?: string): TeamsConversationType {
  if (declared === 'personal' || declared === 'groupChat' || declared === 'channel') {
    return declared;
  }
  if (id.startsWith('a:')) return 'personal';
  return id.includes('@thread.tacv2') || id.includes('@thread.skype') ? 'channel' : 'groupChat';
}

/**
 * The tenant an activity comes from, or `undefined` when it names none, or two that differ in
 * `channelData.tenant.id` and `conversation.tenantId`, which no activity of Teams does.
 */
export function tenantOf(activity: TeamsActivity): string | undefined {
  if (tenantsDisagree(activity)) return undefined;
  const data = ChannelDataSchema.safeParse(activity.channelData);
  return (data.success ? data.data.tenant?.id : undefined) ?? activity.conversation.tenantId;
}

/** Whether an activity names two tenants that differ. */
export function tenantsDisagree(activity: TeamsActivity): boolean {
  const data = ChannelDataSchema.safeParse(activity.channelData);
  const fromData = data.success ? data.data.tenant?.id : undefined;
  const fromConversation = activity.conversation.tenantId;
  return (
    !!fromData && !!fromConversation && fromData.toLowerCase() !== fromConversation.toLowerCase()
  );
}

/** The team a channel activity comes from. */
export function teamOf(activity: TeamsActivity): string | undefined {
  const data = ChannelDataSchema.safeParse(activity.channelData);
  return data.success ? data.data.team?.id : undefined;
}

/** The mentions of the bot in an activity: its `mention` entities that name the recipient. */
function botMentions(activity: TeamsActivity): string[] {
  const botId = activity.recipient?.id;
  if (!botId) return [];
  const texts: string[] = [];
  for (const entity of activity.entities ?? []) {
    const mention = MentionSchema.safeParse(entity);
    if (mention.success && mention.data.mentioned.id === botId) {
      texts.push(mention.data.text ?? '');
    }
  }
  return texts;
}

/** Whether the activity mentions the bot. */
export function mentionsBot(activity: TeamsActivity): boolean {
  return botMentions(activity).length > 0;
}

/**
 * The text of a message without the bot's mentions (`<at>Bot</at>`), trimmed. Mentions of other
 * people stay. Linear in the length of the text.
 */
export function textWithoutMention(activity: TeamsActivity): string {
  let text = activity.text ?? '';
  for (const mention of botMentions(activity)) {
    if (mention) text = text.split(mention).join('');
  }
  return text.trim();
}

/** The attachments of an activity that can be read. */
export function attachmentsOf(activity: TeamsActivity): TeamsAttachment[] {
  const attachments: TeamsAttachment[] = [];
  for (const entry of activity.attachments ?? []) {
    const parsed = AttachmentSchema.safeParse(entry);
    if (parsed.success) attachments.push(parsed.data);
  }
  return attachments;
}

/** A file a user sent in a personal chat, with a download URL that needs no token. */
export const FILE_DOWNLOAD_INFO = 'application/vnd.microsoft.teams.file.download.info';

const DownloadInfoSchema = z.object({
  downloadUrl: z.string(),
  fileType: z.string().optional(),
});

/** The download URL and file type of a {@link FILE_DOWNLOAD_INFO} attachment. */
export function downloadInfoOf(
  attachment: TeamsAttachment
): z.infer<typeof DownloadInfoSchema> | undefined {
  if (attachment.contentType !== FILE_DOWNLOAD_INFO) return undefined;
  const parsed = DownloadInfoSchema.safeParse(attachment.content);
  return parsed.success ? parsed.data : undefined;
}

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  aac: 'audio/aac',
  flac: 'audio/flac',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** What kind of attachment a MIME type is, so images reach vision and audio speech to text. */
export function attachmentTypeOf(mimeType: string): 'image' | 'audio' | 'video' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

/** The MIME type of a file type (an extension, as Teams names it). */
export function mimeTypeOf(fileType: string | undefined): string {
  return MIME_TYPES[fileType?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

const FileConsentSchema = z.object({
  type: z.literal('fileUpload').optional(),
  action: z.enum(['accept', 'decline']),
  context: z.object({ uploadId: z.string() }).optional(),
  uploadInfo: z
    .object({
      name: z.string(),
      uploadUrl: z.string(),
      contentUrl: z.string(),
      uniqueId: z.string(),
      fileType: z.string().optional(),
    })
    .optional(),
});

/** The answer to a file consent card: accepted with where to upload, or declined. */
export type FileConsentAnswer = z.infer<typeof FileConsentSchema>;

/** Reads the value of a `fileConsent/invoke` activity. */
export function fileConsentOf(value: unknown): FileConsentAnswer | undefined {
  const parsed = FileConsentSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
