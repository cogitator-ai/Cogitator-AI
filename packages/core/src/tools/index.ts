/**
 * Built-in tools for Cogitator
 */

export { calculator } from './calculator.js';
export { datetime } from './datetime.js';

export { uuid } from './uuid.js';
export { randomNumber, randomString } from './random.js';
export { hash } from './hash.js';
export { base64Encode, base64Decode } from './base64.js';
export { sleep } from './sleep.js';

export { jsonParse, jsonStringify } from './json.js';

export { regexMatch, regexReplace } from './regex.js';

export { fileRead, fileWrite, fileList, fileExists, fileDelete } from './filesystem.js';

export { httpRequest } from './http.js';

export { exec } from './exec.js';

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
  calculator,
  datetime,
  uuid,
  randomNumber,
  randomString,
  hash,
  base64Encode,
  base64Decode,
  sleep,
  jsonParse,
  jsonStringify,
  regexMatch,
  regexReplace,
  fileRead,
  fileWrite,
  fileList,
  fileExists,
  fileDelete,
  httpRequest,
  exec,
] as const;
