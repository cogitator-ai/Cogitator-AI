interface CsvParseInput {
  data: string;
  operation: 'parse';
  delimiter?: string;
  quote?: string;
  headers?: boolean;
}

interface CsvStringifyInput {
  data: (string | number | boolean | null)[][];
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
  hasHeaders: boolean
): { rows: string[][]; headers?: string[] } {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

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
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    }

    if (char === quote) {
      inQuotes = true;
      i++;
      continue;
    }

    if (char === delimiter) {
      currentRow.push(currentField);
      currentField = '';
      i++;
      continue;
    }

    if (char === '\r' && nextChar === '\n') {
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = '';
      i += 2;
      continue;
    }

    if (char === '\n' || char === '\r') {
      currentRow.push(currentField);
      rows.push(currentRow);
      currentRow = [];
      currentField = '';
      i++;
      continue;
    }

    currentField += char;
    i++;
  }

  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  const filteredRows = rows.filter((row) => row.length > 0 && !(row.length === 1 && row[0] === ''));

  if (hasHeaders && filteredRows.length > 0) {
    const headers = filteredRows[0];
    return { rows: filteredRows.slice(1), headers };
  }

  return { rows: filteredRows };
}

function stringifyCsv(
  data: (string | number | boolean | null)[][],
  delimiter: string,
  quote: string,
  headers?: string[]
): string {
  const rows: string[] = [];

  const escapeField = (field: string | number | boolean | null): string => {
    if (field === null || field === undefined) return '';

    const str = String(field);
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

    let result: string[][] | string;
    let rowCount: number;
    let columnCount: number;
    let headers: string[] | undefined;

    if (input.operation === 'parse') {
      const hasHeaders = input.headers ?? false;
      const parsed = parseCsv(input.data, delimiter, quote, hasHeaders);
      result = parsed.rows;
      headers = parsed.headers;
      rowCount = parsed.rows.length;
      columnCount = parsed.rows[0]?.length ?? 0;
    } else {
      headers = input.headers;
      result = stringifyCsv(input.data, delimiter, quote, headers);
      rowCount = input.data.length;
      columnCount = input.data[0]?.length ?? 0;
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
