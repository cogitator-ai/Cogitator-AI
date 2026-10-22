/** Lines that introduce a quoted message, as mail clients write them in several languages. */
const ATTRIBUTIONS = [
  /^On\b.{0,300}\bwrote:$/i,
  /^Le\b.{0,300}\ba écrit\s?:$/i,
  /^Am\b.{0,300}\bschrieb\b.{0,200}:$/i,
  /^El\b.{0,300}\bescribió:$/i,
  /^Em\b.{0,300}\bescreveu:$/i,
  /^Op\b.{0,300}\bschreef\b.{0,200}:$/i,
  /^Il\b.{0,300}\bha scritto:$/i,
];

/** A line that ends with an address and a colon, as Gmail and Yandex write in Russian. */
const ADDRESS_ATTRIBUTION =
  /(<[^<>\s]+@[^<>\s]+>|\S+@\S+\.\S+)\s*(пишет|написал\(а\)|написала?|wrote)?\s*:$/i;

const FORWARD_HEADER =
  /^(-{2,}\s*(Original Message|Ursprüngliche Nachricht|Исходное сообщение|Message d'origine)\s*-{2,}|_{10,})$/i;
const OUTLOOK_FROM = /^\*?(From|De|Von|От|Van|Da):\*?\s/i;
const OUTLOOK_FIELD =
  /^\*?(Sent|Date|To|Subject|Cc|Envoyé|Gesendet|Отправлено|Дата|Кому|Тема|Verzonden|Inviato|Enviado|Objet|Betreff|À|An|Aan|A|Para):\*?\s/i;
const MOBILE_SIGNATURE =
  /^(Sent from my \S+|Sent from (Mail|Outlook|Yahoo Mail) for \S+|Get Outlook for \S+|Отправлено с \S+)/i;

function isQuoted(line: string): boolean {
  return /^\s*>/.test(line);
}

/** Whether the lines from `start` on are only blank lines and `>` quotes, one at least. */
function onlyQuotesFrom(lines: readonly string[], start: number): boolean {
  let quoted = false;
  for (let i = start; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (!isQuoted(lines[i])) return false;
    quoted = true;
  }
  return quoted;
}

function nextContentLine(lines: readonly string[], start: number): number {
  let i = start;
  while (i < lines.length && !lines[i].trim()) i++;
  return i;
}

/** Where a quoted message starts, if it starts at line `i`: its attribution or separator. */
function quoteStartsAt(lines: readonly string[], i: number): boolean {
  const line = lines[i].trim();
  if (!line) return false;
  if (FORWARD_HEADER.test(line)) return true;
  const joined = i + 1 < lines.length ? `${line} ${lines[i + 1].trim()}` : line;
  if (ATTRIBUTIONS.some((pattern) => pattern.test(line) || pattern.test(joined))) {
    const after = ATTRIBUTIONS.some((pattern) => pattern.test(line)) ? i + 1 : i + 2;
    const next = nextContentLine(lines, after);
    return next >= lines.length || isQuoted(lines[next]) || OUTLOOK_FROM.test(lines[next]);
  }
  if (ADDRESS_ATTRIBUTION.test(line)) {
    const next = nextContentLine(lines, i + 1);
    return next < lines.length && onlyQuotesFrom(lines, next);
  }
  if (OUTLOOK_FROM.test(line)) {
    let fields = 0;
    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      if (OUTLOOK_FIELD.test(lines[j].trim())) fields++;
    }
    return fields >= 2;
  }
  return false;
}

/**
 * The new text of a reply, without what it quotes: the history after an attribution line
 * (`On ... wrote:` and its translations, `-----Original Message-----`, an Outlook `From:` and
 * `Sent:` block), a trailing block of `>` quotes, the signature after a `-- ` line and a
 * `Sent from my ...` line. Quotes the writer answers between are kept, as they say what each
 * answer is about. Returns the text unchanged when stripping would leave nothing.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^-- ?$/.test(lines[i])) {
      end = i;
      break;
    }
    if (quoteStartsAt(lines, i)) {
      end = i;
      break;
    }
  }
  let kept = lines.slice(0, end);
  while (kept.length > 0 && (!kept[kept.length - 1].trim() || isQuoted(kept[kept.length - 1]))) {
    kept.pop();
  }
  const last = kept.length - 1;
  if (last >= 0 && MOBILE_SIGNATURE.test(kept[last].trim())) kept = kept.slice(0, last);
  const stripped = kept.join('\n').trim();
  return stripped || text.trim();
}
