import { z } from 'zod';

import type { ToolDefinition } from '../../domain/tool.js';

/**
 * The five read-only Slack tools (Phase 17, ADR-056).
 *
 * Everything here is pure: the schemas a client sees, and the normalizers
 * that turn untrusted Slack JSON into a closed output shape. No fetch, no
 * clock, no credential — the connector composes these with the client.
 *
 * Normalization is defensive on purpose, with Slack-specific rules from the
 * official docs: unknown response fields are ignored (never a hard failure),
 * cursors are opaque strings passed back verbatim, and `ts` values are
 * **ids, not numbers** — a Slack timestamp is `epoch.microseconds`, and its
 * fractional digits are identity (the thread parent's `ts` is the address of
 * a thread). They are carried as exact strings and never float-parsed, so
 * precision can never be rounded away. What leaves this module is always the
 * closed shape below — a client never sees a raw Slack response object.
 *
 * Slack content is data, never instructions. Message text is surfaced
 * verbatim as data; file references inside messages are text at most and are
 * never dereferenced by the gateway.
 */

// -- Input schemas ----------------------------------------------------------

/**
 * Slack conversation ids: a letter marking the kind (`C` channel, `G` private
 * group or mpim, `D` direct message) followed by alphanumeric id characters.
 * Nothing else is a legal conversation id, so the pattern refuses free text
 * on the way in.
 */
const CHANNEL_ID_PATTERN = '^[CGD][A-Za-z0-9]+$';

const channelProperty = (description: string) =>
  ({ type: 'string', minLength: 9, maxLength: 30, pattern: CHANNEL_ID_PATTERN, description } as const);

/**
 * The same pattern as a runtime guard: the connector re-checks ids before
 * placing them in a query string, so a caller that bypasses the router's
 * schema validation cannot steer the request anywhere else.
 */
export function isChannelId(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(CHANNEL_ID_PATTERN).test(value);
}

/**
 * Message timestamps: `epoch.microseconds`, the string form being the id
 * Slack itself uses for threads (`ts` of a parent addresses its replies).
 */
const TS_PATTERN = '^[0-9]{10,13}(\\.[0-9]{1,6})?$';

const tsProperty = {
  type: 'string',
  minLength: 10,
  maxLength: 20,
  pattern: TS_PATTERN,
  description:
    'Timestamp id of the thread parent message, exactly as a previous response reported it in `ts` (e.g. "1758931200.000123"). Pass it back verbatim; it is an id, not a number.',
} as const;

export function isTs(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(TS_PATTERN).test(value);
}

/** User ids: `U` for users, `W` for enterprise-grid workspace users. */
const USER_ID_PATTERN = '^[UW][A-Za-z0-9]+$';

const userProperty = {
  type: 'string',
  minLength: 9,
  maxLength: 30,
  pattern: USER_ID_PATTERN,
  description: 'User id (starts with U or W).',
} as const;

export function isUserId(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(USER_ID_PATTERN).test(value);
}

/**
 * Cursors are opaque by contract (official pagination docs): validate
 * bounds, never the format, and pass the value back verbatim.
 */
const cursorProperty = {
  type: 'string',
  minLength: 1,
  maxLength: 300,
  description: 'Cursor from a previous response (`nextCursor`). Opaque: pass it back unchanged.',
} as const;

/**
 * A deliberate gateway bound below Slack's documented maxima (999 for
 * conversations.list, 1000 for history/replies): pages stay modest even
 * though the provider would tolerate more.
 */
const limitProperty = {
  type: 'integer',
  minimum: 1,
  maximum: 200,
  description: 'Items per page. Capped at 200 (below Slack’s own maxima).',
} as const;

const listConversationsInput = {
  type: 'object',
  properties: {
    types: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      items: { type: 'string', enum: ['public_channel', 'private_channel', 'mpim', 'im'] },
      description:
        'Conversation kinds to include. Omit for Slack’s default (public channels only). Private channels and DMs appear only where the bot is a member.',
    },
    limit: limitProperty,
    cursor: cursorProperty,
  },
  additionalProperties: false,
} as const;

const conversationInfoInput = {
  type: 'object',
  properties: { channel: channelProperty('Conversation id (from list_conversations).') },
  required: ['channel'],
  additionalProperties: false,
} as const;

const conversationHistoryInput = {
  type: 'object',
  properties: {
    channel: channelProperty('Conversation id (from list_conversations).'),
    limit: limitProperty,
    cursor: cursorProperty,
  },
  required: ['channel'],
  additionalProperties: false,
} as const;

const threadRepliesInput = {
  type: 'object',
  properties: {
    channel: channelProperty('Conversation id the thread lives in.'),
    ts: tsProperty,
    limit: limitProperty,
    cursor: cursorProperty,
  },
  required: ['channel', 'ts'],
  additionalProperties: false,
} as const;

const userInfoInput = {
  type: 'object',
  properties: { user: userProperty },
  required: ['user'],
  additionalProperties: false,
} as const;

/** Read-only is a protocol fact, not a promise in prose: MCP annotations. */
const READ_ONLY = { readOnlyHint: true } as const;

/** The five tools, as the catalog will namespace them. */
export function slackToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'list_conversations',
      description:
        'List conversations this workspace connection can see, one page at a time: pass nextCursor back as cursor to continue. The bot sees private channels and DMs only where it is a member.',
      inputSchema: listConversationsInput,
      annotations: READ_ONLY,
    },
    {
      name: 'get_conversation_info',
      description:
        'Get one conversation: kind (channel, private group, DM, mpim), name, topic, purpose, member count. Use its id with get_conversation_history to read messages.',
      inputSchema: conversationInfoInput,
      annotations: READ_ONLY,
    },
    {
      name: 'get_conversation_history',
      description:
        'Read a conversation’s messages, newest first, one page at a time: pass nextCursor back as cursor to continue. A message with replyCount > 0 has a thread: read it with get_thread_replies.',
      inputSchema: conversationHistoryInput,
      annotations: READ_ONLY,
    },
    {
      name: 'get_thread_replies',
      description:
        'Read one thread’s replies, oldest first, one page at a time: pass nextCursor back as cursor to continue. `ts` is the parent message’s timestamp id, passed back verbatim.',
      inputSchema: threadRepliesInput,
      annotations: READ_ONLY,
    },
    {
      name: 'get_user_info',
      description: 'Get one user: name, display name, and whether they are a bot. No email — the gateway requests no scope that could see one.',
      inputSchema: userInfoInput,
      annotations: READ_ONLY,
    },
  ];
}

// -- Output normalization ----------------------------------------------------

const conversationSchema = z
  .object({
    id: z.string().min(1),
    /** DMs and nameless objects carry no name; `null` says so honestly. */
    name: z.string().nullable(),
    /** Slack's own kind flags, with `unknown` recording a future kind. */
    kind: z.enum(['channel', 'group', 'im', 'mpim', 'unknown']),
    isPrivate: z.boolean(),
    isArchived: z.boolean(),
    creator: z.string().nullable(),
    /** ISO 8601, converted from Slack's epoch-seconds `created`. */
    createdTime: z.string().nullable(),
    numMembers: z.number().nullable(),
    topic: z.string().nullable(),
    purpose: z.string().nullable(),
  })
  .strict();
export type Conversation = z.infer<typeof conversationSchema>;

const messageSchema = z
  .object({
    /** Verbatim: a Slack `ts` is an id (epoch.microseconds), never parsed. */
    ts: z.string().min(1),
    threadTs: z.string().nullable(),
    /** Author id; `null` when only a bot id is present. */
    user: z.string().nullable(),
    botId: z.string().nullable(),
    text: z.string().nullable(),
    /** Recorded, never interpreted: unknown future subtypes stay visible. */
    subtype: z.string().nullable(),
    /** Present on thread parents in history responses. */
    replyCount: z.number().nullable(),
    latestReply: z.string().nullable(),
    isEdited: z.boolean(),
  })
  .strict();
export type Message = z.infer<typeof messageSchema>;

const userInfoSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().nullable(),
    realName: z.string().nullable(),
    displayName: z.string().nullable(),
    isBot: z.boolean(),
    isDeleted: z.boolean(),
    teamId: z.string().nullable(),
  })
  .strict();
export type UserInfo = z.infer<typeof userInfoSchema>;

/** A cursor-paginated Slack list envelope, defensively read. */
export interface ListEnvelope {
  items: unknown[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function num(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true;
}

/**
 * Slack's `created` is epoch seconds; the conversation's creation time is
 * metadata, not an id, so it becomes readable ISO 8601. Message `ts` values
 * follow the opposite rule — see the module comment.
 */
function isoFromEpochSeconds(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? new Date(value * 1_000).toISOString()
    : null;
}

function conversationKind(source: Record<string, unknown>): Conversation['kind'] {
  if (bool(source, 'is_im')) return 'im';
  if (bool(source, 'is_mpim')) return 'mpim';
  if (bool(source, 'is_group')) return 'group';
  if (bool(source, 'is_channel')) return 'channel';
  return 'unknown';
}

/**
 * Identity fields carry no fallback: a Slack object without an id is a shape
 * failure and the entry is dropped — same policy as the GitHub and Notion
 * normalizers. The candidate is then enforced through the declared
 * `.strict()` schema, so a future edit that renames a field is a dropped
 * entry, never a silent shape change on the wire.
 */
export function normalizeConversation(source: unknown): Conversation | undefined {
  if (!isRecord(source)) return undefined;
  const id = str(source, 'id');
  if (id === null) return undefined;
  const candidate = {
    id,
    name: str(source, 'name'),
    kind: conversationKind(source),
    isPrivate: bool(source, 'is_private'),
    isArchived: bool(source, 'is_archived'),
    creator: str(source, 'creator'),
    createdTime: isoFromEpochSeconds(source.created),
    numMembers: num(source, 'num_members'),
    topic: isRecord(source.topic) ? str(source.topic, 'value') : null,
    purpose: isRecord(source.purpose) ? str(source.purpose, 'value') : null,
  };
  return conversationSchema.safeParse(candidate).success ? (candidate as Conversation) : undefined;
}

export function normalizeMessage(source: unknown): Message | undefined {
  if (!isRecord(source)) return undefined;
  const ts = str(source, 'ts');
  if (ts === null) return undefined;
  const candidate = {
    ts,
    threadTs: str(source, 'thread_ts'),
    user: str(source, 'user'),
    botId: str(source, 'bot_id'),
    text: str(source, 'text'),
    subtype: str(source, 'subtype'),
    replyCount: num(source, 'reply_count'),
    latestReply: str(source, 'latest_reply'),
    isEdited: isRecord(source.edited),
  };
  return messageSchema.safeParse(candidate).success ? (candidate as Message) : undefined;
}

export function normalizeUserInfo(source: unknown): UserInfo | undefined {
  if (!isRecord(source)) return undefined;
  const id = str(source, 'id');
  if (id === null) return undefined;
  const profile = isRecord(source.profile) ? source.profile : {};
  const candidate = {
    id,
    name: str(source, 'name'),
    realName: str(source, 'real_name'),
    // `display_name_normalized` is the operator-facing form; the raw
    // `display_name` is the local-time fallback. Email needs a scope the
    // gateway never requests, and is never read here even if present.
    displayName: str(profile, 'display_name_normalized') ?? str(profile, 'display_name'),
    isBot: bool(source, 'is_bot'),
    isDeleted: bool(source, 'deleted'),
    teamId: str(source, 'team_id'),
  };
  return userInfoSchema.safeParse(candidate).success ? (candidate as UserInfo) : undefined;
}

/**
 * Reads a cursor-paginated envelope. `conversations.list` speaks
 * `channels` + `response_metadata.next_cursor` (and returns an **empty
 * string** cursor at the end — read as "no cursor"); `conversations.history`
 * and `conversations.replies` add `has_more`. A present cursor means more,
 * so both dialects reduce to one rule.
 */
export function slackListEnvelope(value: unknown, itemsKey: 'channels' | 'messages'): ListEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  const metadata = isRecord(value.response_metadata) ? value.response_metadata : {};
  const rawCursor = str(metadata, 'next_cursor');
  const nextCursor = rawCursor === null || rawCursor === '' ? null : rawCursor;
  return {
    items: Array.isArray(value[itemsKey]) ? value[itemsKey] : [],
    nextCursor,
    hasMore: bool(value, 'has_more') || nextCursor !== null,
  };
}
