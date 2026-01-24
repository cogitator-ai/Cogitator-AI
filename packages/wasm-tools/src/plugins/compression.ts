interface CompressionInput {
  data: string;
  operation: 'compress' | 'decompress';
  inputEncoding?: 'base64' | 'utf8';
  outputEncoding?: 'base64' | 'utf8';
  level?: number;
}

interface CompressionOutput {
  result: string;
  originalSize: number;
  resultSize: number;
  ratio?: number;
  error?: string;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Encode(bytes: Uint8Array): string {
  let result = '';
  const len = bytes.length;

  for (let i = 0; i < len; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < len ? bytes[i + 1] : 0;
    const b3 = i + 2 < len ? bytes[i + 2] : 0;

    result += BASE64_CHARS[b1 >> 2];
    result += BASE64_CHARS[((b1 & 3) << 4) | (b2 >> 4)];
    result += i + 1 < len ? BASE64_CHARS[((b2 & 15) << 2) | (b3 >> 6)] : '=';
    result += i + 2 < len ? BASE64_CHARS[b3 & 63] : '=';
  }

  return result;
}

function base64Decode(str: string): Uint8Array {
  const cleanStr = str.replace(/[^A-Za-z0-9+/]/g, '');
  const len = cleanStr.length;
  const outputLen =
    Math.floor((len * 3) / 4) - (str.endsWith('==') ? 2 : str.endsWith('=') ? 1 : 0);
  const bytes = new Uint8Array(outputLen);

  const lookup: Record<string, number> = {};
  for (let i = 0; i < BASE64_CHARS.length; i++) {
    lookup[BASE64_CHARS[i]] = i;
  }

  let byteIdx = 0;
  for (let i = 0; i < len; i += 4) {
    const b1 = lookup[cleanStr[i]] || 0;
    const b2 = lookup[cleanStr[i + 1]] || 0;
    const b3 = lookup[cleanStr[i + 2]] || 0;
    const b4 = lookup[cleanStr[i + 3]] || 0;

    bytes[byteIdx++] = (b1 << 2) | (b2 >> 4);
    if (byteIdx < outputLen) bytes[byteIdx++] = ((b2 & 15) << 4) | (b3 >> 2);
    if (byteIdx < outputLen) bytes[byteIdx++] = ((b3 & 3) << 6) | b4;
  }

  return bytes;
}

function utf8Encode(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6));
      bytes.push(0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
      const c2 = str.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      bytes.push(0xf0 | (c >> 18));
      bytes.push(0x80 | ((c >> 12) & 0x3f));
      bytes.push(0x80 | ((c >> 6) & 0x3f));
      bytes.push(0x80 | (c & 0x3f));
    } else {
      bytes.push(0xe0 | (c >> 12));
      bytes.push(0x80 | ((c >> 6) & 0x3f));
      bytes.push(0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

function utf8Decode(bytes: Uint8Array): string {
  let result = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b < 0x80) {
      result += String.fromCharCode(b);
    } else if (b < 0xe0) {
      result += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (b < 0xf0) {
      result += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
      );
    } else {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i++] & 0x3f) << 12) |
        ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f);
      result += String.fromCodePoint(cp);
    }
  }
  return result;
}

function deflateRaw(data: Uint8Array, level: number = 6): Uint8Array {
  const output: number[] = [];
  const len = data.length;

  if (level === 0 || len < 10) {
    let pos = 0;
    while (pos < len) {
      const blockLen = Math.min(65535, len - pos);
      const isLast = pos + blockLen >= len;

      output.push(isLast ? 1 : 0);
      output.push(blockLen & 0xff);
      output.push((blockLen >> 8) & 0xff);
      output.push(~blockLen & 0xff);
      output.push((~blockLen >> 8) & 0xff);

      for (let i = 0; i < blockLen; i++) {
        output.push(data[pos + i]);
      }
      pos += blockLen;
    }
    return new Uint8Array(output);
  }

  const windowSize = 32768;
  const hashTable: Map<number, number[]> = new Map();

  const getHash = (pos: number): number => {
    if (pos + 2 >= len) return 0;
    return ((data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2]) >>> 0;
  };

  const findMatch = (pos: number): { distance: number; length: number } | null => {
    if (pos + 2 >= len) return null;

    const hash = getHash(pos);
    const candidates = hashTable.get(hash) || [];

    let bestDist = 0;
    let bestLen = 0;

    for (let i = candidates.length - 1; i >= 0 && i >= candidates.length - 16; i--) {
      const candPos = candidates[i];
      const dist = pos - candPos;

      if (dist > windowSize || dist <= 0) continue;

      let matchLen = 0;
      while (
        matchLen < 258 &&
        pos + matchLen < len &&
        data[candPos + matchLen] === data[pos + matchLen]
      ) {
        matchLen++;
      }

      if (matchLen >= 3 && matchLen > bestLen) {
        bestDist = dist;
        bestLen = matchLen;
      }
    }

    if (bestLen >= 3) {
      return { distance: bestDist, length: bestLen };
    }
    return null;
  };

  const literals: number[] = [];
  const distances: number[] = [];
  const lengths: number[] = [];

  let pos = 0;
  while (pos < len) {
    const match = level > 3 ? findMatch(pos) : null;

    const hash = getHash(pos);
    if (!hashTable.has(hash)) {
      hashTable.set(hash, []);
    }
    hashTable.get(hash)!.push(pos);

    if (hashTable.get(hash)!.length > 64) {
      hashTable.get(hash)!.shift();
    }

    if (match && match.length >= 3) {
      literals.push(256 + match.length - 3);
      distances.push(match.distance);
      lengths.push(match.length);

      for (let i = 1; i < match.length; i++) {
        const h = getHash(pos + i);
        if (!hashTable.has(h)) hashTable.set(h, []);
        hashTable.get(h)!.push(pos + i);
      }
      pos += match.length;
    } else {
      literals.push(data[pos]);
      distances.push(0);
      lengths.push(0);
      pos++;
    }
  }

  literals.push(256);

  let bitBuf = 0;
  let bitCount = 0;

  const writeBits = (value: number, bits: number) => {
    bitBuf |= value << bitCount;
    bitCount += bits;
    while (bitCount >= 8) {
      output.push(bitBuf & 0xff);
      bitBuf >>= 8;
      bitCount -= 8;
    }
  };

  writeBits(1, 1);
  writeBits(1, 2);

  for (let i = 0; i < literals.length; i++) {
    const lit = literals[i];
    const dist = distances[i];

    if (lit < 144) {
      writeBits(reverseBits(0x30 + lit, 8), 8);
    } else if (lit < 256) {
      writeBits(reverseBits(0x190 + lit - 144, 9), 9);
    } else if (lit === 256) {
      writeBits(reverseBits(0, 7), 7);
    } else {
      const lengthCode = lit - 256;
      if (lengthCode < 8) {
        writeBits(reverseBits(1 + lengthCode, 7), 7);
      } else {
        writeBits(reverseBits(0xc0 + lengthCode - 8, 8), 8);
      }

      if (dist > 0) {
        let distCode = 0;
        let distBits = 0;
        let distBase = 1;

        if (dist <= 4) {
          distCode = dist - 1;
        } else {
          let d = dist - 1;
          let extra = 0;
          while (d >= 2 << extra) {
            extra++;
          }
          distCode = 2 + extra * 2 + (d >= 3 << (extra - 1) ? 1 : 0);
          distBits = extra > 0 ? extra - 1 : 0;
          distBase = (1 << (distBits + 1)) + 1;
        }

        writeBits(reverseBits(distCode, 5), 5);
        if (distBits > 0) {
          writeBits(dist - distBase, distBits);
        }
      }
    }
  }

  if (bitCount > 0) {
    output.push(bitBuf & 0xff);
  }

  return new Uint8Array(output);
}

function reverseBits(value: number, bits: number): number {
  let result = 0;
  for (let i = 0; i < bits; i++) {
    result = (result << 1) | ((value >> i) & 1);
  }
  return result;
}

function inflateRaw(data: Uint8Array): Uint8Array {
  const output: number[] = [];
  let pos = 0;
  let bitBuf = 0;
  let bitCount = 0;

  const readBits = (n: number): number => {
    while (bitCount < n) {
      if (pos >= data.length) throw new Error('Unexpected end of data');
      bitBuf |= data[pos++] << bitCount;
      bitCount += 8;
    }
    const result = bitBuf & ((1 << n) - 1);
    bitBuf >>= n;
    bitCount -= n;
    return result;
  };

  const LITLEN_BASE = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
  ];
  const LITLEN_EXTRA = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
  ];
  const DIST_BASE = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
    3073, 4097, 6145, 8193, 12289, 16385, 24577,
  ];
  const DIST_EXTRA = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
  ];

  let bfinal = 0;

  while (!bfinal) {
    bfinal = readBits(1);
    const btype = readBits(2);

    if (btype === 0) {
      bitBuf = 0;
      bitCount = 0;

      const len = data[pos] | (data[pos + 1] << 8);
      pos += 4;

      for (let i = 0; i < len; i++) {
        output.push(data[pos++]);
      }
    } else if (btype === 1 || btype === 2) {
      let litlenCodes: number[];
      let distCodes: number[];

      if (btype === 1) {
        litlenCodes = [];
        for (let i = 0; i <= 143; i++) litlenCodes[i] = 8;
        for (let i = 144; i <= 255; i++) litlenCodes[i] = 9;
        for (let i = 256; i <= 279; i++) litlenCodes[i] = 7;
        for (let i = 280; i <= 287; i++) litlenCodes[i] = 8;

        distCodes = new Array(32).fill(5);
      } else {
        const hlit = readBits(5) + 257;
        const hdist = readBits(5) + 1;
        const hclen = readBits(4) + 4;

        const clenOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        const clenLens = new Array(19).fill(0);

        for (let i = 0; i < hclen; i++) {
          clenLens[clenOrder[i]] = readBits(3);
        }

        const clenTree = buildHuffmanTree(clenLens);

        const allLens: number[] = [];
        while (allLens.length < hlit + hdist) {
          const sym = decodeSymbol(clenTree, readBits.bind(null, 1));

          if (sym < 16) {
            allLens.push(sym);
          } else if (sym === 16) {
            const repeat = readBits(2) + 3;
            const last = allLens[allLens.length - 1] || 0;
            for (let i = 0; i < repeat; i++) allLens.push(last);
          } else if (sym === 17) {
            const repeat = readBits(3) + 3;
            for (let i = 0; i < repeat; i++) allLens.push(0);
          } else if (sym === 18) {
            const repeat = readBits(7) + 11;
            for (let i = 0; i < repeat; i++) allLens.push(0);
          }
        }

        litlenCodes = allLens.slice(0, hlit);
        distCodes = allLens.slice(hlit);
      }

      const litlenTree = buildHuffmanTree(litlenCodes);
      const distTree = buildHuffmanTree(distCodes);

      while (true) {
        const sym = decodeSymbol(litlenTree, () => readBits(1));

        if (sym < 256) {
          output.push(sym);
        } else if (sym === 256) {
          break;
        } else {
          const lenIdx = sym - 257;
          const length = LITLEN_BASE[lenIdx] + readBits(LITLEN_EXTRA[lenIdx]);

          const distSym = decodeSymbol(distTree, () => readBits(1));
          const distance = DIST_BASE[distSym] + readBits(DIST_EXTRA[distSym]);

          const start = output.length - distance;
          for (let i = 0; i < length; i++) {
            output.push(output[start + i]);
          }
        }
      }
    } else {
      throw new Error('Invalid block type');
    }
  }

  return new Uint8Array(output);
}

interface HuffmanNode {
  symbol?: number;
  left?: HuffmanNode;
  right?: HuffmanNode;
}

function buildHuffmanTree(codeLens: number[]): HuffmanNode {
  const maxLen = Math.max(...codeLens, 1);
  const blCount = new Array(maxLen + 1).fill(0);

  for (const len of codeLens) {
    if (len > 0) blCount[len]++;
  }

  const nextCode = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  const root: HuffmanNode = {};

  for (let sym = 0; sym < codeLens.length; sym++) {
    const len = codeLens[sym];
    if (len === 0) continue;

    const codeVal = nextCode[len]++;
    let node = root;

    for (let i = len - 1; i >= 0; i--) {
      const bit = (codeVal >> i) & 1;
      if (bit === 0) {
        if (!node.left) node.left = {};
        node = node.left;
      } else {
        if (!node.right) node.right = {};
        node = node.right;
      }
    }

    node.symbol = sym;
  }

  return root;
}

function decodeSymbol(tree: HuffmanNode, readBit: () => number): number {
  let node = tree;

  while (node.symbol === undefined) {
    const bit = readBit();
    node = bit === 0 ? node.left! : node.right!;
    if (!node) throw new Error('Invalid huffman code');
  }

  return node.symbol;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;

  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function gzipCompress(data: Uint8Array, level: number): Uint8Array {
  const deflated = deflateRaw(data, level);
  const crc = crc32(data);

  const output = new Uint8Array(10 + deflated.length + 8);

  output[0] = 0x1f;
  output[1] = 0x8b;
  output[2] = 8;
  output[3] = 0;
  output[4] = output[5] = output[6] = output[7] = 0;
  output[8] = level >= 9 ? 2 : level <= 1 ? 4 : 0;
  output[9] = 255;

  output.set(deflated, 10);

  const pos = 10 + deflated.length;
  output[pos] = crc & 0xff;
  output[pos + 1] = (crc >> 8) & 0xff;
  output[pos + 2] = (crc >> 16) & 0xff;
  output[pos + 3] = (crc >> 24) & 0xff;
  output[pos + 4] = data.length & 0xff;
  output[pos + 5] = (data.length >> 8) & 0xff;
  output[pos + 6] = (data.length >> 16) & 0xff;
  output[pos + 7] = (data.length >> 24) & 0xff;

  return output;
}

function gzipDecompress(data: Uint8Array): Uint8Array {
  if (data[0] !== 0x1f || data[1] !== 0x8b) {
    throw new Error('Invalid gzip header');
  }

  if (data[2] !== 8) {
    throw new Error('Unsupported compression method');
  }

  const flags = data[3];
  let pos = 10;

  if (flags & 4) {
    const xlen = data[pos] | (data[pos + 1] << 8);
    pos += 2 + xlen;
  }

  if (flags & 8) {
    while (data[pos++] !== 0);
  }

  if (flags & 16) {
    while (data[pos++] !== 0);
  }

  if (flags & 2) {
    pos += 2;
  }

  const deflatedData = data.slice(pos, data.length - 8);
  return inflateRaw(deflatedData);
}

export function compression(): number {
  try {
    const inputStr = Host.inputString();
    const input: CompressionInput = JSON.parse(inputStr);

    const inputEncoding = input.inputEncoding ?? 'utf8';
    const outputEncoding = input.outputEncoding ?? 'base64';
    const level = input.level ?? 6;

    let inputBytes: Uint8Array;
    if (inputEncoding === 'base64') {
      inputBytes = base64Decode(input.data);
    } else {
      inputBytes = utf8Encode(input.data);
    }

    let resultBytes: Uint8Array;

    if (input.operation === 'compress') {
      resultBytes = gzipCompress(inputBytes, level);
    } else {
      resultBytes = gzipDecompress(inputBytes);
    }

    let result: string;
    if (outputEncoding === 'base64') {
      result = base64Encode(resultBytes);
    } else {
      result = utf8Decode(resultBytes);
    }

    const ratio =
      input.operation === 'compress'
        ? resultBytes.length / inputBytes.length
        : inputBytes.length / resultBytes.length;

    const output: CompressionOutput = {
      result,
      originalSize: inputBytes.length,
      resultSize: resultBytes.length,
      ratio: Math.round(ratio * 100) / 100,
    };

    Host.outputString(JSON.stringify(output));
    return 0;
  } catch (error) {
    const output: CompressionOutput = {
      result: '',
      originalSize: 0,
      resultSize: 0,
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
