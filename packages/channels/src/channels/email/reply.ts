/** The longest line read as an attribution: longer ones are text, whatever they say. */
const MAX_ATTRIBUTION = 500;

/**
 * Lines that introduce a quoted message, as mail clients write them in several languages: how
 * they start and the word that names the writing. Checked as two linear tests, not one pattern.
 */
const ATTRIBUTIONS: readonly (readonly [RegExp, RegExp])[] = [
  [/^On\b/i, /\bwrote:$/i],
  [/^Le\b/i, /\ba écrit\s?:$/i],
  [/^Am\b/i, /\bschrieb\b/i],
  [/^El\b/i, /\bescribió:$/i],
  [/^Em\b/i, /\bescreveu:$/i],
  [/^Op\b/i, /\bschreef\b/i],
  [/^Il\b/i, /\bha scritto:$/i],
];

function isAttribution(line: string): boolean {
  if (line.length > MAX_ATTRIBUTION || !line.endsWith(':')) return false;
  return ATTRIBUTIONS.some(([start, word]) => start.test(line) && word.test(line));
}

const ADDRESS_TOKEN = /^<?[^\s@<>]+@[^\s@<>.]+(?:\.[^\s@<>.]+)+>?,?$/;
const WROTE = /^(пишет|написал\(а\)|написала?|wrote)$/i;

/**
 * A line that ends with an address and a colon, as Gmail and Yandex write in Russian
 * (`пн, 19 окт. 2026 г. в 10:00, Иван <ivan@example.ru>:`), read token by token.
 */
function isAddressAttribution(line: string): boolean {
  if (line.length > MAX_ATTRIBUTION || !line.endsWith(':')) return false;
  const words = line.slice(0, -1).trim().split(/\s+/);
  let last = words.pop() ?? '';
  if (WROTE.test(last)) last = words.pop() ?? '';
  return ADDRESS_TOKEN.test(last);
}

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

/** What the lines below each line hold, found in one pass from the end. */
interface Below {
  /** The first line with text at or after each line, `lines.length` when none is */
  nextContent: number[];
  /** Whether the lines from each line on are only blank lines and `>` quotes, one at least */
  onlyQuotes: boolean[];
}

function linesBelow(lines: readonly string[]): Below {
  const nextContent = new Array<number>(lines.length + 1);
  const onlyQuotes = new Array<boolean>(lines.length + 1);
  nextContent[lines.length] = lines.length;
  onlyQuotes[lines.length] = false;
  let clean = true;
  let quoted = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const blank = !lines[i].trim();
    nextContent[i] = blank ? nextContent[i + 1] : i;
    if (!blank) {
      if (isQuoted(lines[i])) quoted = true;
      else clean = false;
    }
    onlyQuotes[i] = clean && quoted;
  }
  return { nextContent, onlyQuotes };
}

/** Where a quoted message starts, if it starts at line `i`: its attribution or separator. */
function quoteStartsAt(lines: readonly string[], i: number, below: Below): boolean {
  const line = lines[i].trim();
  if (!line) return false;
  if (FORWARD_HEADER.test(line)) return true;
  const wrapped = i + 1 < lines.length && line.length <= MAX_ATTRIBUTION;
  const joined = wrapped ? `${line} ${lines[i + 1].trim()}` : line;
  const single = isAttribution(line);
  if (single || (wrapped && isAttribution(joined))) {
    const next = below.nextContent[single ? i + 1 : i + 2] ?? lines.length;
    return next >= lines.length || isQuoted(lines[next]) || OUTLOOK_FROM.test(lines[next]);
  }
  if (isAddressAttribution(line)) {
    const next = below.nextContent[i + 1];
    return next < lines.length && below.onlyQuotes[next];
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
  const below = linesBelow(lines);
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '-- ' || lines[i] === '--') {
      end = i;
      break;
    }
    if (quoteStartsAt(lines, i, below)) {
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
