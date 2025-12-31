#!/usr/bin/env npx tsx

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
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

function canPrecedeRegex(char: string): boolean {
  if (!char) return true;
  if (/[a-zA-Z0-9_$)\]]/.test(char)) return false;
  return true;
}

function getPrevNonSpaceChar(line: string, pos: number): string {
  for (let j = pos - 1; j >= 0; j--) {
    if (line[j] !== ' ' && line[j] !== '\t') {
      return line[j];
    }
  }
  return '';
}

function removeLineComments(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inMultilineComment = false;
  let inTemplateString = false;

  for (const line of lines) {
    let newLine = '';
    let i = 0;
    let inString = false;
    let stringDelimiter = '';
    let inRegex = false;

    while (i < line.length) {
      const char = line[i];
      const nextChar = line[i + 1];
      const prevChar = i > 0 ? line[i - 1] : '';

      if (inTemplateString) {
        newLine += char;
        if (char === '`' && prevChar !== '\\') {
          inTemplateString = false;
        }
        i++;
        continue;
      }

      if (!inMultilineComment && !inString && char === '`') {
        inTemplateString = true;
        newLine += char;
        i++;
        continue;
      }

      if (!inMultilineComment && !inString && (char === '"' || char === "'")) {
        inString = true;
        stringDelimiter = char;
        newLine += char;
        i++;
        continue;
      }

      if (inString) {
        newLine += char;
        if (char === stringDelimiter && prevChar !== '\\') {
          inString = false;
        }
        i++;
        continue;
      }

      if (inRegex) {
        newLine += char;
        if (char === '/' && prevChar !== '\\') {
          inRegex = false;
        }
        i++;
        continue;
      }

      if (!inMultilineComment && char === '/' && nextChar !== '*' && nextChar !== '/') {
        const prevNonSpace = getPrevNonSpaceChar(newLine, newLine.length);
        if (canPrecedeRegex(prevNonSpace)) {
          inRegex = true;
          newLine += char;
          i++;
          continue;
        }
      }

      if (!inMultilineComment && char === '/' && nextChar === '*') {
        inMultilineComment = true;
        newLine += '/*';
        i += 2;
        continue;
      }

      if (inMultilineComment && char === '*' && nextChar === '/') {
        inMultilineComment = false;
        newLine += '*/';
        i += 2;
        continue;
      }

      if (inMultilineComment) {
        newLine += char;
        i++;
        continue;
      }

      if (char === '/' && nextChar === '/') {
        const prevNonSpace = getPrevNonSpaceChar(newLine, newLine.length);
        if (prevNonSpace === '>') {
          newLine += char;
          i++;
          continue;
        }
        break;
      }

      newLine += char;
      i++;
    }

    const trimmed = newLine.trimEnd();
    result.push(trimmed);
  }

  let finalResult = result.join('\n');
  finalResult = finalResult
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n');
  finalResult = finalResult.replace(/\n{3,}/g, '\n\n');
  finalResult = finalResult.trimEnd() + '\n';

  return finalResult;
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
