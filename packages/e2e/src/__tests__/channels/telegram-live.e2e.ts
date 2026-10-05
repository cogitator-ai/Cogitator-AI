import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import { TelegramChannel } from '@cogitator-ai/channels';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_TEST_CHAT_ID;

/**
 * Talks to the real Telegram Bot API. Needs a bot token and the id of a private chat with the
 * bot (TELEGRAM_BOT_TOKEN, TELEGRAM_TEST_CHAT_ID). Every message it sends is deleted at the end.
 */
const describeLive = token && chatId ? describe : describe.skip;

/** A solid square PNG of the given size and color, encoded by hand. */
function png(size: number, [r, g, b]: [number, number, number]): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(size).fill([r, g, b]).flat())]);
  const pixels = deflateSync(Buffer.concat(Array<Buffer>(size).fill(row)));
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', pixels),
      chunk('IEND', Buffer.alloc(0)),
    ])
  );
}

const PNG = png(120, [46, 111, 158]);

describeLive('Telegram channel on the live Bot API', () => {
  const channel = new TelegramChannel({ token: token ?? '' });
  const sent: string[] = [];

  beforeAll(async () => {
    await channel.start();
  });

  afterAll(async () => {
    for (const id of sent) {
      await channel.deleteMessage(chatId!, id).catch(() => {});
    }
    await channel.deleteCommandMenu({ scope: { type: 'chat', chatId: chatId! } }).catch(() => {});
    await channel.stop();
  });

  it('sends standard Markdown as a rich message and edits it', async () => {
    const id = await channel.sendText(
      chatId!,
      [
        '## Rich message check',
        '',
        '| Feature | Status |',
        '|:--|--:|',
        '| Tables | **yes** |',
        '',
        '```ts',
        'const answer = 42;',
        '```',
        '',
        '- [x] task list',
      ].join('\n'),
      { format: 'markdown', silent: true }
    );
    expect(id).toMatch(/^\d+$/);
    sent.push(id);

    await expect(
      channel.editText(chatId!, id, '## Rich message check\n\nEdited.', { format: 'markdown' })
    ).resolves.toBeUndefined();
  });

  it('sends HTML and classic text with a link preview turned off', async () => {
    sent.push(
      await channel.sendText(chatId!, '<b>HTML</b> check, https://cogitator.app', {
        format: 'html',
        linkPreview: false,
        silent: true,
      })
    );
  });

  it('sends colored buttons and replaces them with a disabled one', async () => {
    const id = await channel.sendText(chatId!, 'Buttons check', {
      silent: true,
      buttons: [
        [
          { text: 'Approve', data: 'e2e:approve', style: 'success' },
          { text: 'Deny', data: 'e2e:deny', style: 'danger' },
        ],
        [
          { text: 'Docs', url: 'https://cogitator.app' },
          { text: 'Copy', copyText: 'cogitator' },
        ],
      ],
    });
    sent.push(id);
    await channel.editButtons(chatId!, id, [[{ text: 'Done', disabled: true, style: 'primary' }]]);
    await channel.editButtons(chatId!, id, null);
  });

  it('streams rich drafts with a stop button', async () => {
    const draftId = Math.floor(Math.random() * 1_000_000) + 1;
    await channel.sendDraft(chatId!, draftId, '', { format: 'markdown', canStop: true });
    await channel.sendDraft(chatId!, draftId, '**Thinking** about the answer', {
      format: 'markdown',
      canStop: true,
    });
    sent.push(
      await channel.sendText(chatId!, '**Final** answer', { format: 'markdown', silent: true })
    );
  });

  it('sends a photo with a caption and an album', async () => {
    const photo = await channel.sendFile(
      chatId!,
      {
        type: 'image',
        mimeType: 'image/png',
        buffer: PNG,
        filename: 'dot.png',
        caption: '**Card**',
      },
      { format: 'markdown', silent: true }
    );
    sent.push(photo);
    const album = await channel.sendFiles(
      chatId!,
      [
        { type: 'image', mimeType: 'image/png', buffer: PNG, filename: 'a.png', caption: 'one' },
        { type: 'image', mimeType: 'image/png', buffer: PNG, filename: 'b.png' },
      ],
      { silent: true }
    );
    expect(album).toHaveLength(2);
    sent.push(...album);
  });

  it('sets a command menu for this chat only', async () => {
    await channel.setCommands([{ command: 'status', description: 'Live test command' }], {
      chatId: chatId!,
    });
  });
});
