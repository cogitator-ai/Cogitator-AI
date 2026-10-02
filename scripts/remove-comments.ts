#!/usr/bin/env npx tsx

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, extname } from 'path';

function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];

  function walk(currentPath: string) {
    const entries = readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist' && entry.name !== '.next') {
          walk(fullPath);
        }
      } else if (extensions.includes(extname(entry.name))) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

const PRESERVED_DIRECTIVES = ['eslint-disable', '@ts-expect-error', '@ts-ignore', '@ts-nocheck'];

const KEYWORDS_BEFORE_EXPRESSION = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

type Previous = { kind: 'none' | 'punct' | 'value' } | { kind: 'word'; word: string };

function isIdentifierChar(char: string): boolean {
  return /[a-zA-Z0-9_$]/.test(char);
}

/**
 * Removes `//` comments from TypeScript source while leaving strings, template
 * literals (including nested `${}` expressions), regex literals and block
 * comments untouched. Tooling directives such as `eslint-disable` are kept.
 */
function removeLineComments(content: string): string {
  let out = '';
  let i = 0;
  let previous: Previous = { kind: 'none' };
  let braceDepth = 0;
  const templateBraceStack: number[] = [];

  const regexAllowed = (): boolean => {
    if (previous.kind === 'none' || previous.kind === 'punct') return true;
    if (previous.kind === 'word') return KEYWORDS_BEFORE_EXPRESSION.has(previous.word);
    return false;
  };

  const lastNonSpaceOnLine = (): string => {
    for (let j = out.length - 1; j >= 0; j--) {
      const c = out[j];
      if (c === '\n') return '';
      if (c !== ' ' && c !== '\t') return c;
    }
    return '';
  };

  const emitCodeNewline = () => {
    let end = out.length;
    while (end > 0 && (out[end - 1] === ' ' || out[end - 1] === '\t' || out[end - 1] === '\r')) {
      end--;
    }
    if (end !== out.length) out = out.slice(0, end);
    if (!out.endsWith('\n\n')) out += '\n';
  };

  const readTemplateChunk = (opening: '`' | '}') => {
    out += opening;
    i++;
    while (i < content.length) {
      const c = content[i];
      if (c === '\\') {
        out += content.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '`') {
        out += c;
        i++;
        previous = { kind: 'value' };
        return;
      }
      if (c === '$' && content[i + 1] === '{') {
        out += '${';
        i += 2;
        templateBraceStack.push(braceDepth);
        braceDepth = 0;
        previous = { kind: 'punct' };
        return;
      }
      out += c;
      i++;
    }
  };

  while (i < content.length) {
    const char = content[i];
    const next = content[i + 1];

    if (char === '\n') {
      emitCodeNewline();
      i++;
      continue;
    }

    if (char === ' ' || char === '\t' || char === '\r') {
      out += char;
      i++;
      continue;
    }

    if (char === '"' || char === "'") {
      out += char;
      i++;
      while (i < content.length && content[i] !== char && content[i] !== '\n') {
        if (content[i] === '\\') {
          out += content.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += content[i];
        i++;
      }
      if (content[i] === char) {
        out += char;
        i++;
      }
      previous = { kind: 'value' };
      continue;
    }

    if (char === '`') {
      readTemplateChunk('`');
      continue;
    }

    if (char === '/' && next === '*') {
      const end = content.indexOf('*/', i + 2);
      const stop = end === -1 ? content.length : end + 2;
      out += content.slice(i, stop);
      i = stop;
      continue;
    }

    if (char === '/' && next === '/') {
      const lineEnd = content.indexOf('\n', i);
      const stop = lineEnd === -1 ? content.length : lineEnd;
      const comment = content.slice(i, stop);
      const body = comment.slice(2).trim();
      if (lastNonSpaceOnLine() === '>' || PRESERVED_DIRECTIVES.some((d) => body.startsWith(d))) {
        out += comment;
      }
      i = stop;
      continue;
    }

    if (char === '/' && regexAllowed()) {
      out += char;
      i++;
      let inClass = false;
      while (i < content.length && content[i] !== '\n') {
        const c = content[i];
        if (c === '\\') {
          out += content.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += c;
        i++;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
      }
      previous = { kind: 'value' };
      continue;
    }

    if (char === '}' && braceDepth === 0 && templateBraceStack.length > 0) {
      braceDepth = templateBraceStack.pop() ?? 0;
      readTemplateChunk('}');
      continue;
    }

    if (isIdentifierChar(char)) {
      let word = '';
      while (i < content.length && isIdentifierChar(content[i])) {
        word += content[i];
        i++;
      }
      out += word;
      previous = { kind: 'word', word };
      continue;
    }

    if (char === '{') braceDepth++;
    if (char === '}') braceDepth--;
    out += char;
    i++;
    previous = char === ')' || char === ']' ? { kind: 'value' } : { kind: 'punct' };
  }

  return out.trimEnd() + '\n';
}

function processFile(filePath: string): boolean {
  const original = readFileSync(filePath, 'utf-8');
  if (!original.trim()) return false;
  const processed = removeLineComments(original);

  if (original !== processed) {
    if (VERBOSE) {
      console.log(`Modified: ${filePath}`);
    }
    if (!DRY_RUN) {
      writeFileSync(filePath, processed);
    }
    return true;
  }
  return false;
}

function main() {
  console.log(`Removing single-line comments...${DRY_RUN ? ' (dry run)' : ''}`);

  const packagesDir = join(process.cwd(), 'packages');
  const files = findFiles(packagesDir, ['.ts', '.tsx']);

  let modifiedCount = 0;
  let totalCount = 0;

  for (const file of files) {
    if (file.includes('/src/')) {
      totalCount++;
      if (processFile(file)) {
        modifiedCount++;
      }
    }
  }

  console.log(`\nProcessed ${totalCount} files, modified ${modifiedCount}`);
  if (DRY_RUN) {
    console.log('Run without --dry-run to apply changes');
  }
}

main();
