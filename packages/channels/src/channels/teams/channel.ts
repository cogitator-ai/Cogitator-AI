import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import { z } from 'zod';
import type {
  Attachment,
  Channel,
  ChannelAction,
  ChannelButton,
  ChannelMessage,
  SendOptions,
} from '@cogitator-ai/types';
import { chunkMessage } from '../../formatters/markdown';
import {
  attachmentsOf,
  conversationTypeOf,
  downloadInfoOf,
  fileConsentOf,
  joinConversation,
  mentionsBot,
  mimeTypeOf,
  parseActivity,
  splitConversation,
  teamOf,
  tenantOf,
  textWithoutMention,
  type FileConsentAnswer,
  type TeamsActivity,
  type TeamsConversationType,
} from './activity';
import { TeamsAuthError, TeamsTokenVerifier, type VerifiedTeamsToken } from './auth';
import {
  ADAPTIVE_CARD,
  FILE_CONSENT_CARD,
  FILE_INFO_CARD,
  buttonsCard,
  executeDataOf,
  submitDataOf,
  type AdaptiveCard,
} from './cards';
import { TeamsClient, type TeamsRetryOptions } from './client';
import { BOT_FRAMEWORK_TENANT, TeamsCredentials, type TeamsTokenProvider } from './token';

/** The largest message Teams is advised to take, in bytes of the activity JSON. */
export const TEAMS_MAX_MESSAGE_BYTES = 80 * 1024;
/**
 * The longest text sent as one message, in characters: JSON takes at most six bytes for one
 * character (`\u0001`), so this many stay under {@link TEAMS_MAX_MESSAGE_BYTES} whatever they are.
 */
export const TEAMS_MESSAGE_CHARS = Math.floor(TEAMS_MAX_MESSAGE_BYTES / 6);
/** The port of the channel's own server by default, the port Bot Framework samples use. */
export const TEAMS_DEFAULT_PORT = 3978;
/** The path of the channel's own server by default, the messaging endpoint of Azure Bot Service. */
export const TEAMS_DEFAULT_PATH = '/api/messages';
/** The Bot Connector of the commercial cloud, for conversations no activity came from yet. */
export const TEAMS_GLOBAL_SERVICE_URL = 'https://smba.trafficmanager.net/teams/';
/** The largest webhook body the channel's own server takes by default, in bytes. */
export const TEAMS_DEFAULT_MAX_BODY = 1024 * 1024;
/** The shortest time between two requests to one conversation, under Teams' 7 messages a second. */
export const TEAMS_CONVERSATION_INTERVAL = Math.ceil(1000 / 7);

const MAX_TRACKED = 1000;
const MAX_CONVERSATIONS = 10_000;
const MAX_PENDING_UPLOADS = 100;
/** How long a file waits for its consent card to be answered, in ms. */
const UPLOAD_TTL = 60 * 60 * 1000;
/** The size of one upload request, a multiple of 320 KiB as OneDrive upload sessions want. */
const UPLOAD_FRAGMENT = 32 * 320 * 1024;
/** The largest file a user sends that is handed to the agent, in bytes. */
const MAX_INBOUND_FILE = 20 * 1024 * 1024;
/**
 * How long a webhook request waits for the gateway to take its message, in ms. A gateway that
 * queues takes it at once, one that answers before it returns is answered `202` after this long.
 */
const HANDOVER_TIMEOUT = 3000;
/** How long an `Action.Execute` press waits for its answer, under the time Teams waits, in ms. */
const INVOKE_TIMEOUT = 4000;
/** What a button press is answered with when nothing else is said and its card is not known. */
const ACTION_RECEIVED = 'Done';
const ACTIVITY_MESSAGE = 'application/vnd.microsoft.activity.message';

/**
 * The kind of the app registration, as Azure Bot Service names it. New bots are single-tenant
 * or use a user-assigned managed identity: multi-tenant bots cannot be created since July 2025.
 */
export type TeamsAppType = 'SingleTenant' | 'MultiTenant' | 'UserAssignedMSI';

export interface TeamsWebhookConfig {
  /**
   * Run an HTTP server of the channel's own on this port. Without it, mount `handleWebhook` or
   * `webhookListener()` in a server of yours.
   */
  port?: number;
  /** The path of the channel's own server (default `/api/messages`) */
  path?: string;
  host?: string;
  /** The largest body taken, in bytes (default 1 MB), larger ones get `413` */
  maxBody?: number;
  /**
   * Plain HTTP routes served on the same port, by path, such as the webhook of another channel:
   * `{ '/github/webhook': github.webhookListener() }`. Other paths answer `404`.
   */
  routes?: Record<string, RequestListener>;
}

export interface TeamsChannelConfig {
  /** The Microsoft App ID of the bot's app registration */
  appId: string;
  /** A client secret of the app registration, which outbound tokens are requested with */
  appPassword?: string;
  /** The tenant of the app registration: required for a single-tenant bot */
  tenantId?: string;
  /** Default `SingleTenant` */
  appType?: TeamsAppType;
  /**
   * A function that returns a Bot Connector token, in place of `appPassword`: required for
   * `UserAssignedMSI`, such as a token of the managed identity from `@azure/identity`.
   */
  tokenProvider?: TeamsTokenProvider;
  /** The server Bot Framework posts activities to. Without `port` mount `handleWebhook` */
  webhook?: TeamsWebhookConfig;
  /**
   * The tenants whose users the bot answers, or `'*'` for every tenant the app is installed in.
   * Default: the bot's own `tenantId`, so an app installed elsewhere answers nobody there.
   */
  tenants?: string[] | '*';
  /** Answer only these users, by Entra object id (`aadObjectId`) or Teams user id */
  users?: string[];
  /**
   * Which messages of group chats and channels the bot answers: `mention` (default) only those
   * that @mention it, `all` every message it receives. Teams delivers messages without a mention
   * only when the app has the resource-specific consent `ChannelMessage.Read.Group` or
   * `ChatMessage.Read.Chat`. Personal chats are always answered.
   */
  trigger?: 'mention' | 'all';
  /**
   * The Bot Connector of conversations no activity came from since the start, such as a reminder
   * after a restart (default the commercial cloud, {@link TEAMS_GLOBAL_SERVICE_URL}).
   */
  serviceUrl?: string;
  /**
   * The hosts a service URL may have, such as `smba.trafficmanager.net`. Activities naming
   * another are refused. Default: any service URL a verified token was issued for.
   */
  serviceUrlHosts?: string[];
  /** How requests Teams throttles or fails for a moment are tried again */
  retry?: TeamsRetryOptions;
  /** The OpenID metadata of inbound tokens (default Bot Framework's), for tests */
  openIdMetadataUrl?: string;
  /** Where outbound tokens come from (default `https://login.microsoftonline.com`), for tests and national clouds */
  loginUrl?: string;
  fetch?: typeof fetch;
}

/** A webhook request, as any HTTP server hands it over. */
export interface TeamsWebhookRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  /** The body as received */
  rawBody?: string | Uint8Array;
}

export interface TeamsWebhookResponse {
  status: number;
  body: string;
  /** `application/json` for the answer to an invoke, `text/plain` otherwise */
  contentType: string;
}

interface ConversationEntry {
  serviceUrl: string;
  type: TeamsConversationType;
}

interface SentEntry {
  conversationId: string;
  text: string;
  textFormat: string;
  card?: AdaptiveCard;
}

interface UpdateState {
  conversationId: string;
  next: SentEntry;
  /** Whether `next` changed since the last update went out */
  dirty: boolean;
  running?: Promise<void>;
}

interface PendingUpload {
  conversationId: string;
  buffer: Buffer;
  filename: string;
  caption?: string;
  textFormat: string;
  createdAt: number;
}

interface PendingAnswer {
  resolve: (options: { text?: string; alert?: boolean }) => void;
}

/** What became of an inbound message: handed to the gateway, skipped, or refused by a stopping gateway. */
type Acceptance = 'taken' | 'skipped' | 'refused';

const ResourceSchema = z.object({ id: z.string().optional() });

function textResponse(status: number, body: string): TeamsWebhookResponse {
  return { status, body, contentType: 'text/plain' };
}

function jsonResponse(status: number, value: unknown): TeamsWebhookResponse {
  return { status, body: JSON.stringify(value), contentType: 'application/json' };
}

function header(headers: TeamsWebhookRequest['headers'], name: string): string | undefined {
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === wanted);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value[0] : value;
}

function bodyText(raw: string | Uint8Array): string {
  return typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf-8');
}

function textFormatOf(format: SendOptions['format']): string {
  if (format === 'plain') return 'plain';
  if (format === 'html') return 'xml';
  return 'extendedmarkdown';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolves with `fallback` when `promise` takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function forgetOldest(collection: Set<string> | Map<string, unknown>, max = MAX_TRACKED): void {
  while (collection.size > max) {
    const oldest = collection.keys().next().value;
    if (oldest === undefined) return;
    collection.delete(oldest);
  }
}

function remember<V>(map: Map<string, V>, key: string, value: V, max = MAX_TRACKED): void {
  map.delete(key);
  map.set(key, value);
  forgetOldest(map, max);
}

function activitiesPath(conversationId: string, activityId?: string): string {
  const base = `/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
  return activityId === undefined ? base : `${base}/${encodeURIComponent(activityId)}`;
}

/** Splits text into the messages Teams takes: at most {@link TEAMS_MESSAGE_CHARS} characters each. */
export function splitTeamsText(text: string): string[] {
  return chunkMessage(text, TEAMS_MESSAGE_CHARS).filter((part) => part.trim());
}

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new BodyTooLarge('Webhook body too large'));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * A Microsoft Teams channel on the Bot Framework protocol, with no SDK: Bot Framework posts
 * activities to a webhook, each checked against its signed JWT, and answers go back through the
 * Bot Connector REST API with a client credentials token of the app registration.
 *
 * Each chat is a conversation: `channelId` is the Teams conversation id of a personal or group
 * chat, or of a team channel, whose threads are topics (`topicId` is the thread's root message
 * id), so each channel thread is a conversation of its own. In group chats and channels the bot
 * answers @mentions, without the mention in the text. Buttons are Adaptive Cards, answers are
 * Markdown and can be edited, so they stream.
 */
export class TeamsChannel implements Channel {
  readonly type = 'teams';
  readonly editable = true;
  readonly nativeMarkdown = true;
  readonly maxMessageChars = TEAMS_MESSAGE_CHARS;
  private readonly config: TeamsChannelConfig;
  private readonly tenantId?: string;
  private readonly verifier: TeamsTokenVerifier;
  private readonly credentials: TeamsCredentials;
  private readonly client: TeamsClient;
  private readonly fetchImpl: typeof fetch;
  private handler: ((msg: ChannelMessage) => Promise<void>) | null = null;
  private actionHandler: ((action: ChannelAction) => Promise<void>) | null = null;
  /** Activities taken, by `conversation|id`, so one sent again is handled once */
  private readonly delivered = new Set<string>();
  /** Messages handed to the gateway whose handler has not resolved yet, by delivery key */
  private readonly inFlight = new Set<string>();
  /** Messages of `inFlight` the gateway handed back while they were being taken */
  private readonly refused = new Set<string>();
  /** The delivery key of each message handed over, by message id */
  private readonly deliveryKeys = new Map<string, string>();
  private readonly conversations = new Map<string, ConversationEntry>();
  private readonly sent = new Map<string, SentEntry>();
  private readonly updates = new Map<string, UpdateState>();
  private readonly slots = new Map<string, number>();
  private readonly answers = new Map<string, PendingAnswer>();
  /** The conversation of each button press, to answer it with a message once its request is over */
  private readonly actionConversations = new Map<string, string>();
  private readonly uploads = new Map<string, PendingUpload>();
  private server?: Server;
  private running = false;
  private stopped = false;

  constructor(config: TeamsChannelConfig) {
    if (!config.appId)
      throw new Error('[teams] appId is required: the Microsoft App ID of the bot');
    const appType = config.appType ?? 'SingleTenant';
    if (appType !== 'MultiTenant' && !config.tenantId) {
      throw new Error(
        `[teams] tenantId is required for a ${appType} bot: the tenant of its app registration`
      );
    }
    if (appType === 'UserAssignedMSI' && !config.tokenProvider) {
      throw new Error(
        '[teams] tokenProvider is required for a UserAssignedMSI bot: a function that returns a token of the managed identity'
      );
    }
    if (!config.appPassword && !config.tokenProvider) {
      throw new Error('[teams] appPassword (a client secret) or tokenProvider is required');
    }
    this.config = config;
    if (config.tenantId) this.tenantId = config.tenantId;
    this.fetchImpl = config.fetch ?? fetch;
    this.verifier = new TeamsTokenVerifier({
      appId: config.appId,
      ...(config.openIdMetadataUrl && { metadataUrl: config.openIdMetadataUrl }),
      ...(config.fetch && { fetch: config.fetch }),
    });
    this.credentials = new TeamsCredentials({
      appId: config.appId,
      ...(config.appPassword && { appPassword: config.appPassword }),
      tenant: appType === 'MultiTenant' ? BOT_FRAMEWORK_TENANT : (config.tenantId ?? ''),
      ...(config.tokenProvider && { provider: config.tokenProvider }),
      ...(config.loginUrl && { loginUrl: config.loginUrl }),
      ...(config.fetch && { fetch: config.fetch }),
    });
    this.client = new TeamsClient({
      credentials: this.credentials,
      ...(config.retry && { retry: config.retry }),
      ...(config.fetch && { fetch: config.fetch }),
    });
  }

  onMessage(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.handler = handler;
  }

  onAction(handler: (action: ChannelAction) => Promise<void>): void {
    this.actionHandler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.config.tenants === '*') {
      console.warn(
        '[teams] tenants is "*": the bot answers users of every tenant its app is installed in'
      );
    } else if (this.allowedTenants().length === 0) {
      console.warn('[teams] No tenants set: the bot answers nobody. Set tenants or tenantId');
    }
    this.running = true;
    this.stopped = false;
    const webhook = this.config.webhook;
    if (webhook?.port !== undefined) {
      try {
        await this.listen(webhook.port, webhook.path ?? TEAMS_DEFAULT_PATH, webhook.host);
      } catch (error) {
        this.running = false;
        throw error;
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    for (const answer of this.answers.values()) answer.resolve({});
    this.answers.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /**
   * Takes back a message the gateway does not answer because it stops. One it refuses while it
   * is being handed over gets its webhook request answered `503`. One it dropped after its
   * request was answered cannot come again, since Bot Framework does not send an activity twice
   * once it was taken, so it is logged.
   */
  async redeliver(msg: ChannelMessage): Promise<void> {
    const key = this.deliveryKeys.get(msg.id);
    if (key && this.inFlight.has(key)) {
      this.refused.add(key);
      return;
    }
    if (key) this.delivered.delete(key);
    console.warn(`[teams] The message ${msg.id} in ${msg.channelId} was dropped unanswered`);
  }

  /**
   * Answers a request Bot Framework posts: checks its token, answers at once and hands the
   * activity to the agent after. A button press of an Adaptive Card (`Action.Execute`) is
   * answered with the press's answer in the response, within a few seconds. Mount it in any HTTP
   * server with the raw body. It works before `start()` too and answers `503` once stopped.
   */
  async handleWebhook(request: TeamsWebhookRequest): Promise<TeamsWebhookResponse> {
    if (this.stopped) return textResponse(503, 'The channel is stopped');
    if (request.method !== 'POST') return textResponse(405, 'Method not allowed');
    const authorization = header(request.headers, 'authorization') ?? '';
    if (authorization.slice(0, 7).toLowerCase() !== 'bearer ') {
      return textResponse(401, 'Unauthorized');
    }
    let verified: VerifiedTeamsToken;
    try {
      verified = await this.verifier.verify(authorization.slice(7).trim());
    } catch (error) {
      if (!(error instanceof TeamsAuthError)) throw error;
      if (error.status === 503) console.error(error.message, error.cause);
      return textResponse(error.status, error.status === 503 ? 'Unavailable' : 'Unauthorized');
    }
    let activity: TeamsActivity;
    try {
      activity = parseActivity(JSON.parse(bodyText(request.rawBody ?? '')));
    } catch {
      return textResponse(400, 'Invalid activity');
    }
    if (verified.serviceUrl !== activity.serviceUrl) {
      return textResponse(401, 'Unauthorized');
    }
    if (!verified.endorsements.includes(activity.channelId)) {
      return textResponse(403, 'Forbidden');
    }
    if (!this.allowsServiceUrl(activity.serviceUrl)) return textResponse(403, 'Forbidden');
    if (activity.channelId !== 'msteams') return textResponse(202, 'Ignored');
    this.rememberConversation(activity);
    if (activity.from.id === activity.recipient?.id) {
      return textResponse(202, 'Ignored');
    }
    const key = activity.id ? `${activity.conversation.id}|${activity.id}` : undefined;
    if (key !== undefined) {
      if (this.delivered.has(key)) return textResponse(200, 'Already received');
      this.delivered.add(key);
      forgetOldest(this.delivered);
    }
    if (activity.type === 'invoke') return this.invoke(activity);
    if (activity.type !== 'message') return textResponse(202, 'Accepted');
    const pressed = submitDataOf(activity.value);
    if (pressed !== undefined) {
      if (this.admits(activity)) {
        void this.press(activity, pressed).catch((error: unknown) =>
          console.error('[teams] Button press failed:', error)
        );
      }
      return textResponse(202, 'Accepted');
    }
    return this.handOver(activity, key);
  }

  /**
   * A Node request listener that answers Bot Framework's requests on any path it is mounted at.
   * Bodies over `webhook.maxBody` (1 MB by default) are refused with `413`.
   */
  webhookListener(): RequestListener {
    const limit = this.config.webhook?.maxBody ?? TEAMS_DEFAULT_MAX_BODY;
    return (req, res) => {
      readBody(req, limit)
        .then((rawBody) =>
          this.handleWebhook({ method: req.method ?? 'GET', headers: req.headers, rawBody })
        )
        .then((response) =>
          res
            .writeHead(response.status, { 'content-type': response.contentType })
            .end(response.body)
        )
        .catch((error: unknown) => {
          if (error instanceof BodyTooLarge) {
            res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
            res.end('Payload too large');
            return;
          }
          console.error('[teams] Webhook request failed:', error);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
    };
  }

  /**
   * Sends `text` to the conversation `channelId`, in the channel thread of `topicId`, as several
   * messages when it is longer than one holds. With `replyTo` the first one replies to that
   * message, and `buttons` go under the last as an Adaptive Card. Resolves with the id of the
   * first message.
   */
  async sendText(channelId: string, text: string, options?: SendOptions): Promise<string> {
    const conversationId = joinConversation(channelId, options?.topicId);
    const parts = splitTeamsText(text);
    if (parts.length === 0) throw new Error('[teams] Nothing to send');
    const textFormat = textFormatOf(options?.format);
    const card = options?.buttons?.length ? buttonsCard(options.buttons) : undefined;
    const ids: string[] = [];
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1;
      ids.push(
        await this.post(
          conversationId,
          { text: part, textFormat, ...(last && card && { card }) },
          index === 0 ? options?.replyTo : undefined
        )
      );
    }
    return ids[0] ?? '';
  }

  /**
   * Replaces the text of a message the bot sent, keeping its buttons. Updates of one message go
   * out one at a time, and those made while one is under way are folded into the next, the latest
   * text winning, so a streamed answer never queues more than Teams takes.
   */
  async editText(
    channelId: string,
    messageId: string,
    text: string,
    options?: SendOptions
  ): Promise<void> {
    if (text.length > TEAMS_MESSAGE_CHARS) {
      throw new Error(`[teams] A message holds at most ${TEAMS_MESSAGE_CHARS} characters`);
    }
    const known = this.sent.get(messageId);
    const textFormat = textFormatOf(options?.format);
    const card = options?.buttons?.length ? buttonsCard(options.buttons) : known?.card;
    return this.update(
      known?.conversationId ?? joinConversation(channelId, options?.topicId),
      messageId,
      (current) => ({ ...current, text, textFormat, ...(card ? { card } : {}) })
    );
  }

  /** Replaces the buttons of a message the bot sent, or removes them with `null`. */
  async editButtons(
    channelId: string,
    messageId: string,
    buttons: ChannelButton[][] | null
  ): Promise<void> {
    const known = this.sent.get(messageId) ?? this.updates.get(messageId)?.next;
    if (!known) {
      throw new Error(
        `[teams] The text of message ${messageId} in ${channelId} is not known, so its buttons cannot be changed`
      );
    }
    const card = buttons?.length ? buttonsCard(buttons) : undefined;
    return this.update(known.conversationId, messageId, (current) => {
      const kept: SentEntry = {
        conversationId: current.conversationId,
        text: current.text,
        textFormat: current.textFormat,
      };
      return card ? { ...kept, card } : kept;
    });
  }

  /** Deletes a message the bot sent. */
  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const conversationId = this.sent.get(messageId)?.conversationId ?? channelId;
    await this.pace(conversationId);
    await this.client.request(
      'DELETE',
      this.serviceUrlOf(conversationId),
      activitiesPath(conversationId, messageId)
    );
    this.sent.delete(messageId);
  }

  async sendTyping(channelId: string, options?: Pick<SendOptions, 'topicId'>): Promise<void> {
    const conversationId = joinConversation(channelId, options?.topicId);
    await this.pace(conversationId);
    await this.client.request(
      'POST',
      this.serviceUrlOf(conversationId),
      activitiesPath(conversationId),
      { type: 'typing' }
    );
  }

  /**
   * Sends a file. A `buffer` goes out in personal chats only: Teams asks the user to accept it
   * with a file consent card and the file is uploaded to their OneDrive once they do, which needs
   * `supportsFiles` in the app manifest. Bots cannot upload files to group chats and channels
   * without Microsoft Graph, so there a file needs a public `url`: an image is shown inline,
   * another file is sent as a link. Resolves with the id of the message sent.
   */
  async sendFile(channelId: string, file: Attachment, options?: SendOptions): Promise<string> {
    const conversationId = joinConversation(channelId, options?.topicId);
    const filename = file.filename ?? (file.type === 'image' ? 'image' : 'file');
    const textFormat = textFormatOf(options?.format);
    if (file.buffer) {
      if (this.typeOf(conversationId) !== 'personal') {
        throw new Error(
          '[teams] Teams takes uploads from bots in personal chats only: in group chats and channels send a file with a public url'
        );
      }
      const uploadId = randomUUID();
      const buffer = Buffer.from(file.buffer);
      this.expireUploads();
      remember(
        this.uploads,
        uploadId,
        {
          conversationId,
          buffer,
          filename,
          ...(file.caption && { caption: file.caption }),
          textFormat,
          createdAt: Date.now(),
        },
        MAX_PENDING_UPLOADS
      );
      return this.post(conversationId, {
        text: '',
        textFormat,
        attachments: [
          {
            contentType: FILE_CONSENT_CARD,
            name: filename,
            content: {
              description: file.caption ?? filename,
              sizeInBytes: buffer.length,
              acceptContext: { uploadId },
              declineContext: { uploadId },
            },
          },
        ],
      });
    }
    if (!file.url || !/^https?:\/\//i.test(file.url)) {
      throw new Error('[teams] A file needs a buffer (personal chats) or a public http(s) url');
    }
    if (file.type === 'image') {
      return this.post(
        conversationId,
        {
          text: file.caption ?? '',
          textFormat,
          attachments: [{ contentType: file.mimeType, contentUrl: file.url, name: filename }],
        },
        options?.replyTo
      );
    }
    const link = `[${filename.replace(/[[\]]/g, '')}](<${file.url}>)`;
    return this.sendText(channelId, file.caption ? `${file.caption}\n\n${link}` : link, options);
  }

  /**
   * Answers a button press. An `Action.Execute` press still waiting for its answer gets it in
   * the response, shown to the user who pressed. Otherwise a `text` is sent to the conversation
   * as a message, since Teams has no other way to answer a press.
   */
  async answerAction(
    actionId: string,
    options?: { text?: string; alert?: boolean }
  ): Promise<void> {
    const pending = this.answers.get(actionId);
    if (pending) {
      this.answers.delete(actionId);
      pending.resolve(options ?? {});
      return;
    }
    const conversationId = this.actionConversations.get(actionId);
    this.actionConversations.delete(actionId);
    if (!options?.text || !conversationId) return;
    await this.post(conversationId, { text: options.text, textFormat: 'plain' });
  }

  private allowedTenants(): string[] {
    if (this.config.tenants === '*') return [];
    return this.config.tenants ?? (this.tenantId ? [this.tenantId] : []);
  }

  /** Whether the sender of an activity may talk to the bot: by their tenant and the user list. */
  private admits(activity: TeamsActivity): boolean {
    if (this.config.tenants !== '*') {
      const tenant = tenantOf(activity)?.toLowerCase();
      if (!tenant || !this.allowedTenants().some((allowed) => allowed.toLowerCase() === tenant)) {
        return false;
      }
    }
    const users = this.config.users;
    if (users?.length) {
      const { aadObjectId, id } = activity.from;
      return users.some((user) => user === aadObjectId || user === id);
    }
    return true;
  }

  private allowsServiceUrl(serviceUrl: string): boolean {
    let url: URL;
    try {
      url = new URL(serviceUrl);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const hosts = this.config.serviceUrlHosts;
    if (!hosts?.length) return true;
    const host = url.hostname.toLowerCase();
    return hosts.some((allowed) => allowed.toLowerCase() === host);
  }

  /** Remembers the Bot Connector and kind of the conversation of a verified activity. */
  private rememberConversation(activity: TeamsActivity): void {
    const { id, conversationType } = activity.conversation;
    const entry = {
      serviceUrl: activity.serviceUrl,
      type: conversationTypeOf(id, conversationType),
    };
    remember(this.conversations, id, entry, MAX_CONVERSATIONS);
    const { channelId } = splitConversation(id);
    if (channelId !== id) remember(this.conversations, channelId, entry, MAX_CONVERSATIONS);
  }

  private serviceUrlOf(conversationId: string): string {
    return (
      this.conversations.get(conversationId)?.serviceUrl ??
      this.conversations.get(splitConversation(conversationId).channelId)?.serviceUrl ??
      this.config.serviceUrl ??
      TEAMS_GLOBAL_SERVICE_URL
    );
  }

  private typeOf(conversationId: string): TeamsConversationType {
    return this.conversations.get(conversationId)?.type ?? conversationTypeOf(conversationId);
  }

  /** Waits for the next free slot of a conversation, so it gets at most 7 requests a second. */
  private async pace(conversationId: string): Promise<void> {
    const key = splitConversation(conversationId).channelId;
    const now = Date.now();
    const slot = Math.max(now, this.slots.get(key) ?? 0);
    remember(this.slots, key, slot + TEAMS_CONVERSATION_INTERVAL);
    if (slot > now) await sleep(slot - now);
  }

  /** Where a message of an activity goes: the chat, and the channel thread it is in. */
  private placeOf(activity: TeamsActivity): {
    channelId: string;
    topicId?: string;
    groupId?: string;
  } {
    const conversation = activity.conversation;
    const type = conversationTypeOf(conversation.id, conversation.conversationType);
    const { channelId, topicId } = splitConversation(conversation.id);
    if (type === 'personal') return { channelId };
    if (type === 'groupChat') return { channelId, ...(topicId && { topicId }), groupId: channelId };
    const root = topicId ?? activity.replyToId ?? activity.id;
    return {
      channelId,
      ...(root && { topicId: root }),
      groupId: teamOf(activity) ?? channelId,
    };
  }

  /**
   * Hands a message to the gateway and answers its request once the gateway took it, or after
   * a few seconds. One the gateway refuses because it stops is answered `503`.
   */
  private async handOver(
    activity: TeamsActivity,
    key: string | undefined
  ): Promise<TeamsWebhookResponse> {
    const accepted = this.receive(activity, key).catch((error: unknown): Acceptance => {
      console.error('[teams] Message failed:', error);
      return 'taken';
    });
    const pending = Symbol('pending');
    const handedOver = await within<Acceptance | typeof pending>(
      accepted,
      HANDOVER_TIMEOUT,
      pending
    );
    if (handedOver === 'refused') {
      if (key !== undefined) this.delivered.delete(key);
      return textResponse(503, 'Not taken now, send it again later');
    }
    return textResponse(202, 'Accepted');
  }

  private async receive(activity: TeamsActivity, key: string | undefined): Promise<Acceptance> {
    if (!this.handler || !this.admits(activity)) return 'skipped';
    const conversation = activity.conversation;
    const type = conversationTypeOf(conversation.id, conversation.conversationType);
    if (type !== 'personal' && this.config.trigger !== 'all' && !mentionsBot(activity)) {
      return 'skipped';
    }
    const text = textWithoutMention(activity);
    const attachments = await this.inboundAttachments(activity);
    if (!text && attachments.length === 0) return 'skipped';
    const place = this.placeOf(activity);
    const id = activity.id ?? randomUUID();
    const message: ChannelMessage = {
      id,
      channelType: this.type,
      channelId: place.channelId,
      userId: activity.from.aadObjectId ?? activity.from.id,
      ...(activity.from.name && { userName: activity.from.name }),
      ...(place.groupId && { groupId: place.groupId }),
      text,
      ...(attachments.length > 0 && { attachments }),
      ...(activity.replyToId && { replyTo: activity.replyToId }),
      ...(place.topicId && { topicId: place.topicId }),
      raw: activity,
    };
    const flightKey = key ?? `${conversation.id}|${id}`;
    remember(this.deliveryKeys, id, flightKey);
    this.inFlight.add(flightKey);
    try {
      await this.handler(message);
    } catch (error) {
      console.error('[teams] Message handler error:', error);
    } finally {
      this.inFlight.delete(flightKey);
    }
    return this.refused.delete(flightKey) ? 'refused' : 'taken';
  }

  /**
   * The files of a message the agent can read: files sent in a personal chat, by their download
   * URL, and inline images, downloaded with the bot's token from the Bot Connector the activity
   * came through (and from nowhere else, so the token never leaves it).
   */
  private async inboundAttachments(activity: TeamsActivity): Promise<Attachment[]> {
    const attachments: Attachment[] = [];
    const serviceHost = new URL(activity.serviceUrl).host;
    for (const attachment of attachmentsOf(activity)) {
      const info = downloadInfoOf(attachment);
      if (info && /^https:\/\//i.test(info.downloadUrl)) {
        const mimeType = mimeTypeOf(info.fileType);
        attachments.push({
          type: mimeType.startsWith('image/') ? 'image' : 'file',
          url: info.downloadUrl,
          mimeType,
          ...(attachment.name && { filename: attachment.name }),
        });
        continue;
      }
      if (!attachment.contentType.startsWith('image/') || !attachment.contentUrl) continue;
      let url: URL;
      try {
        url = new URL(attachment.contentUrl);
      } catch {
        continue;
      }
      if (url.host !== serviceHost) continue;
      const buffer = await this.download(url.href).catch((error: unknown) => {
        console.warn('[teams] Could not download an image of a message:', error);
        return undefined;
      });
      if (!buffer) continue;
      attachments.push({
        type: 'image',
        buffer,
        mimeType: attachment.contentType,
        ...(attachment.name && { filename: attachment.name }),
      });
    }
    return attachments;
  }

  private async download(url: string): Promise<Buffer | undefined> {
    const token = await this.credentials.token();
    const response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_INBOUND_FILE) return undefined;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength > MAX_INBOUND_FILE ? undefined : buffer;
  }

  /** The action of a button press, from an `Action.Submit` message or an `Action.Execute` invoke. */
  private actionOf(activity: TeamsActivity, data: string): ChannelAction {
    const place = this.placeOf(activity);
    const id = activity.id ?? randomUUID();
    remember(this.actionConversations, id, joinConversation(place.channelId, place.topicId));
    return {
      id,
      channelType: this.type,
      channelId: place.channelId,
      userId: activity.from.aadObjectId ?? activity.from.id,
      ...(activity.from.name && { userName: activity.from.name }),
      ...(activity.replyToId && { messageId: activity.replyToId }),
      ...(place.topicId && { topicId: place.topicId }),
      data,
      raw: activity,
    };
  }

  private async press(activity: TeamsActivity, data: string): Promise<void> {
    if (!this.actionHandler) return;
    await this.actionHandler(this.actionOf(activity, data));
  }

  private async invoke(activity: TeamsActivity): Promise<TeamsWebhookResponse> {
    if (activity.name === 'adaptiveCard/action') return this.execute(activity);
    if (activity.name === 'fileConsent/invoke') {
      const answer = fileConsentOf(activity.value);
      if (answer && this.admits(activity)) this.consented(activity, answer);
      return jsonResponse(200, {});
    }
    return textResponse(501, 'Not implemented');
  }

  /**
   * Answers an `Action.Execute` press within the time Teams waits: with the text the press is
   * answered with, or else the message's card as it is now.
   */
  private async execute(activity: TeamsActivity): Promise<TeamsWebhookResponse> {
    const data = executeDataOf(activity.value);
    if (data === undefined || !this.admits(activity)) {
      return jsonResponse(200, {
        statusCode: data === undefined ? 400 : 403,
        type: 'application/vnd.microsoft.error',
        value: {
          code: data === undefined ? 'BadRequest' : 'Forbidden',
          message: data === undefined ? 'Unknown action' : 'Not allowed',
        },
      });
    }
    const action = this.actionOf(activity, data);
    let answered: { text?: string } = {};
    if (this.actionHandler) {
      const answer = new Promise<{ text?: string }>((resolve) => {
        this.answers.set(action.id, { resolve });
      });
      const handled = this.actionHandler(action).then(
        () => ({}),
        (error: unknown) => {
          console.error('[teams] Button press failed:', error);
          return {};
        }
      );
      answered = await within(Promise.race([answer, handled]), INVOKE_TIMEOUT, {});
      this.answers.delete(action.id);
    }
    if (answered.text) {
      return jsonResponse(200, { statusCode: 200, type: ACTIVITY_MESSAGE, value: answered.text });
    }
    const messageId = activity.replyToId;
    const card = messageId
      ? (this.updates.get(messageId)?.next.card ?? this.sent.get(messageId)?.card)
      : undefined;
    if (card) return jsonResponse(200, { statusCode: 200, type: ADAPTIVE_CARD, value: card });
    return jsonResponse(200, { statusCode: 200, type: ACTIVITY_MESSAGE, value: ACTION_RECEIVED });
  }

  /** Uploads a file the user accepted, in the conversation the consent card was sent to. */
  private consented(activity: TeamsActivity, answer: FileConsentAnswer): void {
    const uploadId = answer.context?.uploadId;
    const upload = uploadId ? this.uploads.get(uploadId) : undefined;
    if (!uploadId || upload?.conversationId !== activity.conversation.id) return;
    this.uploads.delete(uploadId);
    if (answer.action !== 'accept' || !answer.uploadInfo) return;
    const info = answer.uploadInfo;
    void this.upload(upload, info).catch((error: unknown) =>
      console.error(`[teams] Uploading ${upload.filename} failed:`, error)
    );
  }

  private async upload(
    upload: PendingUpload,
    info: NonNullable<FileConsentAnswer['uploadInfo']>
  ): Promise<void> {
    if (!/^https:\/\//i.test(info.uploadUrl)) throw new Error('The upload URL is not https');
    const size = upload.buffer.length;
    for (let start = 0; start < size || start === 0; start += UPLOAD_FRAGMENT) {
      const end = Math.min(start + UPLOAD_FRAGMENT, size);
      const response = await this.fetchImpl(info.uploadUrl, {
        method: 'PUT',
        headers: {
          'content-length': String(end - start),
          'content-range': `bytes ${start}-${Math.max(end - 1, 0)}/${size}`,
        },
        body: new Uint8Array(upload.buffer.subarray(start, end)),
      });
      if (!response.ok) throw new Error(`The upload answered ${response.status}`);
      if (size === 0) break;
    }
    await this.post(upload.conversationId, {
      text: upload.caption ?? '',
      textFormat: upload.textFormat,
      attachments: [
        {
          contentType: FILE_INFO_CARD,
          contentUrl: info.contentUrl,
          name: info.name,
          content: { uniqueId: info.uniqueId, fileType: info.fileType ?? '' },
        },
      ],
    });
  }

  private expireUploads(): void {
    const oldest = Date.now() - UPLOAD_TTL;
    for (const [id, upload] of this.uploads) {
      if (upload.createdAt >= oldest) break;
      this.uploads.delete(id);
    }
  }

  /** Posts a message activity, as a reply to `replyTo` when given, and remembers what it holds. */
  private async post(
    conversationId: string,
    content: {
      text: string;
      textFormat: string;
      card?: AdaptiveCard;
      attachments?: Record<string, unknown>[];
    },
    replyTo?: string
  ): Promise<string> {
    await this.pace(conversationId);
    const attachments = content.card
      ? [{ contentType: ADAPTIVE_CARD, content: content.card }]
      : content.attachments;
    const activity = {
      type: 'message',
      ...(content.text && { text: content.text, textFormat: content.textFormat }),
      ...(attachments && { attachments }),
      ...(replyTo && { replyToId: replyTo }),
    };
    const response = await this.client.request(
      'POST',
      this.serviceUrlOf(conversationId),
      activitiesPath(conversationId, replyTo),
      activity
    );
    const parsed = ResourceSchema.safeParse(response);
    const id = parsed.success ? (parsed.data.id ?? '') : '';
    if (id && !content.attachments) {
      remember(this.sent, id, {
        conversationId,
        text: content.text,
        textFormat: content.textFormat,
        ...(content.card && { card: content.card }),
      });
    }
    return id;
  }

  /**
   * Updates a message the bot sent (`PUT`), one update of it at a time: changes made while one
   * is under way are folded into the next, which sends the latest state.
   */
  private update(
    conversationId: string,
    messageId: string,
    change: (current: SentEntry) => SentEntry
  ): Promise<void> {
    let state = this.updates.get(messageId);
    if (!state) {
      const base = this.sent.get(messageId) ?? {
        conversationId,
        text: '',
        textFormat: 'extendedmarkdown',
      };
      state = { conversationId, next: base, dirty: false };
      remember(this.updates, messageId, state);
    }
    state.next = change(state.next);
    state.dirty = true;
    state.running ??= this.drainUpdates(messageId, state);
    return state.running;
  }

  private async drainUpdates(messageId: string, state: UpdateState): Promise<void> {
    try {
      while (state.dirty) {
        await this.pace(state.conversationId);
        state.dirty = false;
        const entry = state.next;
        await this.client.request(
          'PUT',
          this.serviceUrlOf(state.conversationId),
          activitiesPath(state.conversationId, messageId),
          {
            type: 'message',
            id: messageId,
            text: entry.text,
            textFormat: entry.textFormat,
            ...(entry.card && {
              attachments: [{ contentType: ADAPTIVE_CARD, content: entry.card }],
            }),
          }
        );
        remember(this.sent, messageId, entry);
      }
    } finally {
      state.running = undefined;
      if (this.updates.get(messageId) === state) this.updates.delete(messageId);
    }
  }

  private listen(port: number, path: string, host?: string): Promise<void> {
    const listener = this.webhookListener();
    const routes = this.config.webhook?.routes ?? {};
    const server = createServer((req, res) => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request');
        return;
      }
      if (pathname === path) {
        listener(req, res);
        return;
      }
      const route = Object.hasOwn(routes, pathname) ? routes[pathname] : undefined;
      if (route) {
        route(req, res);
        return;
      }
      res.writeHead(404).end();
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      const failed = (error: Error) => {
        this.server = undefined;
        reject(error);
      };
      server.once('error', failed);
      server.listen(port, host, () => {
        server.off('error', failed);
        resolve();
      });
    });
  }
}

/** A Microsoft Teams channel on the Bot Framework protocol. */
export function teamsChannel(config: TeamsChannelConfig): TeamsChannel {
  return new TeamsChannel(config);
}
