import type { InboxItem, InboxItemInput } from '@cogitator-ai/types';
import type { PersonLetter, PersonRoute } from './person.js';

/** As much of an inbox as the route uses. `experimental_Inbox` of `@cogitator-ai/core` fits. */
export interface PersonInbox {
  add(item: InboxItemInput): Promise<InboxItem>;
  claimAnswer(id: string): Promise<InboxItem | null>;
  archive(id: string): Promise<InboxItem | null>;
}

/** The id of the inbox item of a letter that waits for the person. */
export function inboxItemId(letterId: string): string {
  return `inbox_bridge_${letterId}`;
}

function itemOf({ letter, job }: PersonLetter): InboxItemInput {
  const call = letter.kind === 'permission' && letter.ask !== undefined;
  return {
    id: inboxItemId(letter.id),
    kind: call ? 'approval' : 'question',
    title: `${letter.from} ${call ? 'asks leave' : 'asks'} on job #${job.number}: ${job.title}`,
    summary: letter.body,
    body: letter.body,
    actions: call
      ? [
          { id: 'allow', label: 'Allow', kind: 'approve' },
          { id: 'deny', label: 'Refuse', kind: 'reject' },
        ]
      : [{ id: 'reply', label: 'Reply', kind: 'reply' }],
    metadata: {
      bridge: {
        job: job.number,
        letter: letter.id,
        from: letter.from,
        project: job.project,
        ...(letter.ask && { ask: letter.ask }),
      },
    },
  };
}

/**
 * Puts every letter that waits for the person into an inbox, so whatever shows the inbox or
 * listens to it (a sink, Studio, a webhook) shows the letter: a permission request as an
 * approval, a question as a question. The item says which letter of the bridge it stands for
 * in `metadata.bridge`. A reminder puts the item back as unread, which tells the sinks again.
 * Once the letter waits no more, the item is marked answered and archived.
 *
 * The inbox only shows: the answer itself goes to the bridge, with `cogitator bridge allow`,
 * `deny` and `reply` or through a route that takes answers, such as `channelRoute`.
 *
 * @example
 * ```ts
 * import { experimental_FileInboxStore, experimental_Inbox } from '@cogitator-ai/core';
 *
 * const inbox = new experimental_Inbox({ store: new experimental_FileInboxStore(path) });
 * const host = await hostBridge({ person: inboxRoute(inbox) });
 * ```
 */
export function inboxRoute(inbox: PersonInbox): PersonRoute {
  return {
    async ask(request) {
      await inbox.add(itemOf(request));
    },
    async settle({ letter }) {
      const id = inboxItemId(letter.id);
      await inbox.claimAnswer(id);
      await inbox.archive(id);
    },
  };
}
