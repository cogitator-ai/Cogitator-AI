import { z } from 'zod';

const UserSchema = z.object({
  login: z.string(),
  id: z.number(),
  type: z.string().optional(),
});

const RepositorySchema = z.object({ full_name: z.string() });

const IssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullish(),
});

const CommentSchema = z.object({
  id: z.number(),
  body: z.string().nullish(),
});

const ReviewCommentSchema = CommentSchema.extend({
  in_reply_to_id: z.number().nullish(),
});

const ReviewSchema = z.object({
  id: z.number(),
  body: z.string().nullish(),
});

const base = {
  action: z.string(),
  repository: RepositorySchema,
  sender: UserSchema,
};

const IssuesEventSchema = z.object({ ...base, issue: IssueSchema });
const IssueCommentEventSchema = z.object({ ...base, issue: IssueSchema, comment: CommentSchema });
const PullRequestEventSchema = z.object({ ...base, pull_request: IssueSchema });
const ReviewCommentEventSchema = z.object({
  ...base,
  pull_request: IssueSchema,
  comment: ReviewCommentSchema,
});
const ReviewEventSchema = z.object({ ...base, pull_request: IssueSchema, review: ReviewSchema });

/** The account an event came from. */
export type GitHubSender = z.infer<typeof UserSchema>;

/** The webhook events the channel answers, with the action of each it takes. */
export const GITHUB_EVENTS = {
  issues: 'opened',
  issue_comment: 'created',
  pull_request: 'opened',
  pull_request_review_comment: 'created',
  pull_request_review: 'submitted',
} as const;

export type GitHubEventName = keyof typeof GITHUB_EVENTS;

export function isGitHubEventName(name: string): name is GitHubEventName {
  return Object.hasOwn(GITHUB_EVENTS, name);
}

/** A webhook event the channel answers, reduced to what a message needs. */
export interface GitHubInbound {
  /** The repository, `owner/repo`. */
  repository: string;
  /** The number of the issue or pull request. */
  number: number;
  /**
   * The message id: `issue:<number>` for an opened issue or pull request,
   * `comment:<id>` for a comment on one, `review_comment:<id>` for a comment
   * on a line of a pull request, `review:<id>` for a review.
   */
  id: string;
  text: string;
  sender: GitHubSender;
  /** The review thread a review comment is in: the id of its first comment. */
  topicId?: string;
  /** The comment a review comment replies to. */
  replyTo?: string;
}

function issueText(issue: { title: string; body?: string | null | undefined }): string {
  const body = issue.body?.trim();
  return body ? `${issue.title}\n\n${body}` : issue.title;
}

/**
 * The event a webhook delivery carries, or `undefined` for events and actions
 * the channel does not answer and payloads that are not what GitHub sends.
 */
export function githubInboundOf(name: string, payload: unknown): GitHubInbound | undefined {
  if (!isGitHubEventName(name)) return undefined;
  const action =
    typeof payload === 'object' && payload !== null && 'action' in payload
      ? payload.action
      : undefined;
  if (action !== GITHUB_EVENTS[name]) return undefined;
  switch (name) {
    case 'issues': {
      const parsed = IssuesEventSchema.safeParse(payload);
      if (!parsed.success) return undefined;
      const { issue, repository, sender } = parsed.data;
      return {
        repository: repository.full_name,
        number: issue.number,
        id: `issue:${issue.number}`,
        text: issueText(issue),
        sender,
      };
    }
    case 'pull_request': {
      const parsed = PullRequestEventSchema.safeParse(payload);
      if (!parsed.success) return undefined;
      const { pull_request: pull, repository, sender } = parsed.data;
      return {
        repository: repository.full_name,
        number: pull.number,
        id: `issue:${pull.number}`,
        text: issueText(pull),
        sender,
      };
    }
    case 'issue_comment': {
      const parsed = IssueCommentEventSchema.safeParse(payload);
      if (!parsed.success) return undefined;
      const { issue, comment, repository, sender } = parsed.data;
      return {
        repository: repository.full_name,
        number: issue.number,
        id: `comment:${comment.id}`,
        text: comment.body ?? '',
        sender,
      };
    }
    case 'pull_request_review_comment': {
      const parsed = ReviewCommentEventSchema.safeParse(payload);
      if (!parsed.success) return undefined;
      const { pull_request: pull, comment, repository, sender } = parsed.data;
      const root = comment.in_reply_to_id ?? comment.id;
      return {
        repository: repository.full_name,
        number: pull.number,
        id: `review_comment:${comment.id}`,
        text: comment.body ?? '',
        sender,
        topicId: String(root),
        ...(comment.in_reply_to_id != null && {
          replyTo: `review_comment:${comment.in_reply_to_id}`,
        }),
      };
    }
    case 'pull_request_review': {
      const parsed = ReviewEventSchema.safeParse(payload);
      if (!parsed.success) return undefined;
      const { pull_request: pull, review, repository, sender } = parsed.data;
      return {
        repository: repository.full_name,
        number: pull.number,
        id: `review:${review.id}`,
        text: review.body ?? '',
        sender,
      };
    }
  }
}
