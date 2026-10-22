---
'@cogitator-ai/channels': minor
'@cogitator-ai/types': minor
'@cogitator-ai/cli': minor
'create-cogitator-app': minor
---

Channels: an email channel, so an agent answers mail in the thread it came in.

- `emailChannel({ address, smtp, imap, allowFrom })` reads unread mail of a mailbox over IMAP with `imapflow` and `postal-mime`: IDLE reports new mail at once and a poll catches the rest, mail is flagged `\Seen` only once the Gateway queued it, so a restart reads only new mail, and a dropped connection is opened again with a wait that doubles from 1 s up to 60 s. Mail is fetched in batches, parsed a few at once and handed over in order.
- Inbound webhooks of Mailgun, Postmark and SendGrid work instead of IMAP or with it, on a server of the channel's own (bodies up to 10 MB) or through `handleWebhook({ method, query, headers, rawBody })`. Mailgun requests must carry a valid HMAC of timestamp and token (or of the body in JSON mode), at most 5 minutes old, and a replayed signature is not handled again. Postmark and SendGrid do not sign, so their URL carries basic auth or a `token`, compared in constant time.
- Answers go out over SMTP with `nodemailer`, or any transport with `sendMail`, as HTML rendered from the Markdown with a plain text alternative, with a `Re:` subject and `In-Reply-To` and `References` set, so mail clients keep the thread. A reminder with only a topic answers the thread's latest mail. Files are sent as attachments. Sent mail cannot be edited (`editable: false`), and an answer is one mail however long.
- A message's `channelId` and `userId` are the sender's address in lower case, `topicId` is the thread's first `Message-ID`, and `replyTo` is `In-Reply-To`, so each email thread is a conversation of its own. The agent reads the plain text part, or the HTML as text, without the quoted history (`On ... wrote:` in several languages, Outlook headers, a trailing `>` block) and the signature, with the subject on a thread's first mail, and attachments up to 10 MB.
- The bot never answers itself, its `aliases` or mail with the `X-Cogitator` header it puts on everything it sends, and skips auto-replies, bounces and bulk or list mail. Each `Message-ID` is handled once.
- Email is spoofable, so the bot answers only `allowFrom` (addresses, domains, `*.domain` or `*`, nobody by default with a warning), and drops mail whose DKIM, SPF or DMARC results fail for the `From` domain, from Mailgun's and SendGrid's reports, Postmark's spam tests or the topmost `Authentication-Results` of an IMAP mailbox (`trustedAuthservIds` names the servers to trust). `senderAuth: 'required'` also drops mail without results.
- `htmlToText` and `markdownToHtml` are exported, and `ChannelType` includes `'email'`.
- In `cogitator.yml`, `channels.email` takes the address, `allowFrom`, owners (always answered), `imap`, `smtp` and a `webhook` provider, checked as addresses and domains, with the secrets and, where the file leaves them out, hosts and ports from `EMAIL_*` variables. `cogitator init`, `cogitator wizard` and create-cogitator-app (`--channels email`) set up a bot that reads a mailbox over IMAP.
