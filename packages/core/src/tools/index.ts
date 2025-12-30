/**
 * Built-in tools for Cogitator
 */

export { calculator } from './calculator';
export { datetime } from './datetime';

export { uuid } from './uuid';
export { randomNumber, randomString } from './random';
export { hash } from './hash';
export { base64Encode, base64Decode } from './base64';
export { sleep } from './sleep';

export { jsonParse, jsonStringify } from './json';

export { regexMatch, regexReplace } from './regex';

export { fileRead, fileWrite, fileList, fileExists, fileDelete } from './filesystem';

export { httpRequest } from './http';

export { exec } from './exec';

import { calculator } from './calculator';
import { datetime } from './datetime';
import { uuid } from './uuid';
import { randomNumber, randomString } from './random';
import { hash } from './hash';
import { base64Encode, base64Decode } from './base64';
import { sleep } from './sleep';
import { jsonParse, jsonStringify } from './json';
import { regexMatch, regexReplace } from './regex';
import { fileRead, fileWrite, fileList, fileExists, fileDelete } from './filesystem';
import { httpRequest } from './http';
import { exec } from './exec';

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
