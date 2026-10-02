interface CsvParseInput {
  data: string;
  operation: 'parse';
  delimiter?: string;
  quote?: string;
  headers?: boolean | string[];
}

interface CsvStringifyInput {
  data: unknown[][];
  operation: 'stringify';
  delimiter?: string;
  quote?: string;
  headers?: string[];
}

type CsvInput = CsvParseInput | CsvStringifyInput;

interface CsvOutput {
  result: string[][] | string;
  rowCount: number;
  columnCount: number;
  headers?: string[];
  error?: string;
}

function parseCsv(
  data: string,
  delimiter: string,
  quote: string,
  headers: boolean | string[]
): { rows: string[][]; headers?: string[] } {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let fieldStarted = false;
  let i = data.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (i < data.length) {
    const char = data[i];
    const nextChar = data[i + 1];

    if (inQuotes) {
      if (char === quote) {
        if (nextChar === quote) {
          currentField += quote;
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          if (i < data.length && data[i] !== delimiter && data[i] !== '\n' && data[i] !== '\r') {
            throw new Error(`Unexpected character after closing quote at position ${i}`);
          }
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    }

    if (char === quote && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      i++;
      continue;
    }

    if (char === delimiter) {
      currentRow.push(currentField);
      currentField = '';
      fieldStarted = false;
      i++;
      continue;
    }

    if (char === '\n' || char === '\r') {
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = '';
      fieldStarted = false;
      i += char === '\r' && nextChar === '\n' ? 2 : 1;
      continue;
    }

    currentField += char;
    fieldStarted = true;
    i++;
  }

  if (inQuotes) {
    throw new Error('Unterminated quoted field');
  }

  if (fieldStarted || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  const filteredRows = rows.filter((row) => row.length > 0 && !(row.length === 1 && row[0] === ''));

  if (Array.isArray(headers)) {
    return { rows: filteredRows, headers };
  }

  if (headers && filteredRows.length > 0) {
    return { rows: filteredRows.slice(1), headers: filteredRows[0] };
  }

  return { rows: filteredRows };
}

function stringifyCsv(
  data: unknown[][],
  delimiter: string,
  quote: string,
  headers?: string[]
): string {
  const rows: string[] = [];

  const escapeField = (field: unknown): string => {
    if (field === null || field === undefined) return '';

    const str = typeof field === 'object' ? JSON.stringify(field) : String(field);
    const needsQuotes =
      str.includes(delimiter) || str.includes(quote) || str.includes('\n') || str.includes('\r');

    if (needsQuotes) {
      const escapedQuote = quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escaped = str.replace(new RegExp(escapedQuote, 'g'), quote + quote);
      return quote + escaped + quote;
    }

    return str;
  };

  if (headers && headers.length > 0) {
    rows.push(headers.map(escapeField).join(delimiter));
  }

  for (const row of data) {
    rows.push(row.map(escapeField).join(delimiter));
  }

  return rows.join('\n');
}

export function csv(): number {
  try {
    const inputStr = Host.inputString();
    const input: CsvInput = JSON.parse(inputStr);

    const delimiter = input.delimiter ?? ',';
    const quote = input.quote ?? '"';

    if (delimiter.length !== 1) {
      throw new Error(`Delimiter must be a single character, got "${delimiter}"`);
    }
    if (quote.length !== 1) {
      throw new Error(`Quote must be a single character, got "${quote}"`);
    }

    let result: string[][] | string;
    let rowCount: number;
    let columnCount: number;
    let headers: string[] | undefined;

    if (delimiter === quote) {
      throw new Error('Delimiter and quote must be different characters');
    }
    if (delimiter === '\n' || delimiter === '\r' || quote === '\n' || quote === '\r') {
      throw new Error('Delimiter and quote cannot be line breaks');
    }

    if (input.operation === 'parse') {
      if (typeof input.data !== 'string') {
        throw new Error('data must be a CSV string for the parse operation');
      }
      const parsed = parseCsv(input.data, delimiter, quote, input.headers ?? false);
      result = parsed.rows;
      headers = parsed.headers;
      rowCount = parsed.rows.length;
      columnCount = parsed.rows[0]?.length ?? 0;
    } else if (input.operation === 'stringify') {
      if (!Array.isArray(input.data) || !input.data.every((row) => Array.isArray(row))) {
        throw new Error('data must be an array of rows (arrays) for the stringify operation');
      }
      if (input.headers !== undefined && !Array.isArray(input.headers)) {
        throw new Error('headers must be an array of column names for the stringify operation');
      }
      headers = input.headers;
      result = stringifyCsv(input.data, delimiter, quote, headers);
      rowCount = input.data.length;
      columnCount = input.data[0]?.length ?? 0;
    } else {
      throw new Error(`Unknown operation: ${String((input as { operation: unknown }).operation)}`);
    }

    const output: CsvOutput = {
      result,
      rowCount,
      columnCount,
      headers,
    };

    Host.outputString(JSON.stringify(output));
    return 0;
  } catch (error) {
    const output: CsvOutput = {
      result: [],
      rowCount: 0,
      columnCount: 0,
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
