interface SlugInput {
  text: string;
  separator?: string;
  lowercase?: boolean;
  maxLength?: number;
}

interface SlugOutput {
  slug: string;
  original: string;
  error?: string;
}

const CHAR_MAP: Record<string, string> = {
  à: 'a',
  á: 'a',
  â: 'a',
  ã: 'a',
  ä: 'a',
  å: 'a',
  æ: 'ae',
  ç: 'c',
  è: 'e',
  é: 'e',
  ê: 'e',
  ë: 'e',
  ì: 'i',
  í: 'i',
  î: 'i',
  ï: 'i',
  ð: 'd',
  ñ: 'n',
  ò: 'o',
  ó: 'o',
  ô: 'o',
  õ: 'o',
  ö: 'o',
  ø: 'o',
  ù: 'u',
  ú: 'u',
  û: 'u',
  ü: 'u',
  ý: 'y',
  ÿ: 'y',
  þ: 'th',
  ß: 'ss',
  ą: 'a',
  ć: 'c',
  ę: 'e',
  ł: 'l',
  ń: 'n',
  ś: 's',
  ź: 'z',
  ż: 'z',
  č: 'c',
  ď: 'd',
  ě: 'e',
  ň: 'n',
  ř: 'r',
  š: 's',
  ť: 't',
  ů: 'u',
  ž: 'z',
  ā: 'a',
  ē: 'e',
  ģ: 'g',
  ī: 'i',
  ķ: 'k',
  ļ: 'l',
  ņ: 'n',
  ū: 'u',
  ő: 'o',
  ű: 'u',
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'yo',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  α: 'a',
  β: 'b',
  γ: 'g',
  δ: 'd',
  ε: 'e',
  ζ: 'z',
  η: 'h',
  θ: 'th',
  ι: 'i',
  κ: 'k',
  λ: 'l',
  μ: 'm',
  ν: 'n',
  ξ: 'x',
  ο: 'o',
  π: 'p',
  ρ: 'r',
  σ: 's',
  τ: 't',
  υ: 'y',
  φ: 'ph',
  χ: 'ch',
  ψ: 'ps',
  ω: 'o',
};

function transliterate(str: string): string {
  let result = '';
  for (const char of str) {
    const lower = char.toLowerCase();
    if (CHAR_MAP[lower]) {
      const mapped = CHAR_MAP[lower];
      result += char === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
    } else {
      result += char;
    }
  }
  return result.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function generateSlug(
  text: string,
  separator: string,
  lowercase: boolean,
  maxLength?: number
): string {
  let slug = transliterate(text);

  if (lowercase) {
    slug = slug.toLowerCase();
  }

  const sep = escapeRegex(separator);
  slug = slug
    .replace(/['\u2019`]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, separator)
    .replace(new RegExp(`(?:${sep})+`, 'g'), separator)
    .replace(new RegExp(`^(?:${sep})+|(?:${sep})+$`, 'g'), '');

  if (maxLength !== undefined && maxLength > 0 && slug.length > maxLength) {
    slug = slug.substring(0, maxLength);
    const lastSep = slug.lastIndexOf(separator);
    if (lastSep > maxLength * 0.5) {
      slug = slug.substring(0, lastSep);
    }
    slug = slug.replace(new RegExp(`(?:${sep})+$`), '');
  }

  return slug;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function slug(): number {
  try {
    const inputStr = Host.inputString();
    const input: SlugInput = JSON.parse(inputStr);

    const separator = input.separator ?? '-';
    if (separator.length === 0) {
      throw new Error('Separator must not be empty');
    }
    const lowercase = input.lowercase ?? true;
    if (typeof input.text !== 'string') {
      throw new Error('text must be a string');
    }
    if (
      input.maxLength !== undefined &&
      (!Number.isInteger(input.maxLength) || input.maxLength < 1)
    ) {
      throw new Error('maxLength must be a positive integer');
    }

    const result = generateSlug(input.text, separator, lowercase, input.maxLength);

    const output: SlugOutput = {
      slug: result,
      original: input.text,
    };

    Host.outputString(JSON.stringify(output));
    return 0;
  } catch (error) {
    const output: SlugOutput = {
      slug: '',
      original: '',
      error: error instanceof Error ? error.message : String(error),
    };
    Host.outputString(JSON.stringify(output));
    return 1;
  }
}

declare const Host: {
  inputString(): string;
  outputString(s: string): void;
};
