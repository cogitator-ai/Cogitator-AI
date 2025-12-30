/**
 * Built-in tools for Cogitator
 */

// Existing tools
export { calculator } from './calculator.js';
export { datetime } from './datetime.js';

// Utility tools
export { uuid } from './uuid.js';
export { randomNumber, randomString } from './random.js';
export { hash } from './hash.js';
export { base64Encode, base64Decode } from './base64.js';
export { sleep } from './sleep.js';

// JSON tools
export { jsonParse, jsonStringify } from './json.js';

// Regex tools
export { regexMatch, regexReplace } from './regex.js';

// Filesystem tools
export { fileRead, fileWrite, fileList, fileExists, fileDelete } from './filesystem.js';

// HTTP tools
export { httpRequest } from './http.js';

// Shell tools
export { exec } from './exec.js';

// Re-export all tools as a collection
import { calculator } from './calculator.js';
import { datetime } from './datetime.js';
import { uuid } from './uuid.js';
import { randomNumber, randomString } from './random.js';
import { hash } from './hash.js';
import { base64Encode, base64Decode } from './base64.js';
import { sleep } from './sleep.js';
import { jsonParse, jsonStringify } from './json.js';
import { regexMatch, regexReplace } from './regex.js';
import { fileRead, fileWrite, fileList, fileExists, fileDelete } from './filesystem.js';
import { httpRequest } from './http.js';
import { exec } from './exec.js';

export const builtinTools = [
  // Math & Time
  calculator,
  datetime,
  // Utilities
  uuid,
  randomNumber,
  randomString,
  hash,
  base64Encode,
  base64Decode,
  sleep,
  // JSON
  jsonParse,
  jsonStringify,
  // Regex
  regexMatch,
  regexReplace,
  // Filesystem
  fileRead,
  fileWrite,
  fileList,
  fileExists,
  fileDelete,
  // HTTP
  httpRequest,
  // Shell
  exec,
] as const;
