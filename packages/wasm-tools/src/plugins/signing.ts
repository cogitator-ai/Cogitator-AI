interface SigningInput {
  operation: 'generateKeypair' | 'sign' | 'verify';
  algorithm: 'ed25519';
  message?: string;
  privateKey?: string;
  publicKey?: string;
  signature?: string;
  encoding?: 'hex' | 'base64';
}

interface SigningOutput {
  publicKey?: string;
  privateKey?: string;
  signature?: string;
  valid?: boolean;
  algorithm: string;
  error?: string;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Hex string must have even length');
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex characters');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const len = clean.length;
  const outLen = Math.floor((len * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  const out = new Uint8Array(outLen);
  const lookup: Record<string, number> = {};
  for (let i = 0; i < B64.length; i++) lookup[B64[i]] = i;

  let j = 0;
  for (let i = 0; i < len; i += 4) {
    const a = lookup[clean[i]] ?? 0;
    const b = lookup[clean[i + 1]] ?? 0;
    const c = lookup[clean[i + 2]] ?? 0;
    const d = lookup[clean[i + 3]] ?? 0;
    out[j++] = (a << 2) | (b >> 4);
    if (j < outLen) out[j++] = ((b & 15) << 4) | (c >> 2);
    if (j < outLen) out[j++] = ((c & 3) << 6) | d;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let r = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i],
      b2 = bytes[i + 1] ?? 0,
      b3 = bytes[i + 2] ?? 0;
    r += B64[b1 >> 2];
    r += B64[((b1 & 3) << 4) | (b2 >> 4)];
    r += i + 1 < bytes.length ? B64[((b2 & 15) << 2) | (b3 >> 6)] : '=';
    r += i + 2 < bytes.length ? B64[b3 & 63] : '=';
  }
  return r;
}

function decodeKey(key: string, encoding: string): Uint8Array {
  return encoding === 'base64' ? base64ToBytes(key) : hexToBytes(key);
}

function encodeKey(bytes: Uint8Array, encoding: string): string {
  return encoding === 'base64' ? bytesToBase64(bytes) : bytesToHex(bytes);
}

function sha512(message: Uint8Array): Uint8Array {
  const K = [
    0x428a2f98n,
    0xd728ae22n,
    0x71374491n,
    0x23ef65cdn,
    0xb5c0fbcfn,
    0xec4d3b2fn,
    0xe9b5dba5n,
    0x8189dbbcn,
    0x3956c25bn,
    0xf348b538n,
    0x59f111f1n,
    0xb605d019n,
    0x923f82a4n,
    0xaf194f9bn,
    0xab1c5ed5n,
    0xda6d8118n,
    0xd807aa98n,
    0xa3030242n,
    0x12835b01n,
    0x45706fben,
    0x243185ben,
    0x4ee4b28cn,
    0x550c7dc3n,
    0xd5ffb4e2n,
    0x72be5d74n,
    0xf27b896fn,
    0x80deb1fen,
    0x3b1696b1n,
    0x9bdc06a7n,
    0x25c71235n,
    0xc19bf174n,
    0xcf692694n,
    0xe49b69c1n,
    0x9ef14ad2n,
    0xefbe4786n,
    0x384f25e3n,
    0x0fc19dc6n,
    0x8b8cd5b5n,
    0x240ca1ccn,
    0x77ac9c65n,
    0x2de92c6fn,
    0x592b0275n,
    0x4a7484aan,
    0x6ea6e483n,
    0x5cb0a9dcn,
    0xbd41fbd4n,
    0x76f988dan,
    0x831153b5n,
    0x983e5152n,
    0xee66dfabn,
    0xa831c66dn,
    0x2db43210n,
    0xb00327c8n,
    0x98fb213fn,
    0xbf597fc7n,
    0xbeef0ee4n,
    0xc6e00bf3n,
    0x3da88fc2n,
    0xd5a79147n,
    0x930aa725n,
    0x06ca6351n,
    0xe003826fn,
    0x14292967n,
    0x0a0e6e70n,
    0x27b70a85n,
    0x46d22ffcn,
    0x2e1b2138n,
    0x5c26c926n,
    0x4d2c6dfcn,
    0x5ac42aedn,
    0x53380d13n,
    0x9d95b3dfn,
    0x650a7354n,
    0x8baf63den,
    0x766a0abbn,
    0x3c77b2a8n,
    0x81c2c92en,
    0x47edaee6n,
    0x92722c85n,
    0x1482353bn,
    0xa2bfe8a1n,
    0x4cf10364n,
    0xa81a664bn,
    0xbc423001n,
    0xc24b8b70n,
    0xd0f89791n,
    0xc76c51a3n,
    0x0654be30n,
    0xd192e819n,
    0xd6ef5218n,
    0xd6990624n,
    0x5565a910n,
    0xf40e3585n,
    0x5771202an,
    0x106aa070n,
    0x32bbd1b8n,
    0x19a4c116n,
    0xb8d2d0c8n,
    0x1e376c08n,
    0x5141ab53n,
    0x2748774cn,
    0xdf8eeb99n,
    0x34b0bcb5n,
    0xe19b48a8n,
    0x391c0cb3n,
    0xc5c95a63n,
    0x4ed8aa4an,
    0xe3418acbn,
    0x5b9cca4fn,
    0x7763e373n,
    0x682e6ff3n,
    0xd6b2b8a3n,
    0x748f82een,
    0x5defb2fcn,
    0x78a5636fn,
    0x43172f60n,
    0x84c87814n,
    0xa1f0ab72n,
    0x8cc70208n,
    0x1a6439ecn,
    0x90befffan,
    0x23631e28n,
    0xa4506cebn,
    0xde82bde9n,
    0xbef9a3f7n,
    0xb2c67915n,
    0xc67178f2n,
    0xe372532bn,
    0xca273ecen,
    0xea26619cn,
    0xd186b8c7n,
    0x21c0c207n,
    0xeada7dd6n,
    0xcde0eb1en,
    0xf57d4f7fn,
    0xee6ed178n,
    0x06f067aan,
    0x72176fban,
    0x0a637dc5n,
    0xa2c898a6n,
    0x113f9804n,
    0xbef90daen,
    0x1b710b35n,
    0x131c471bn,
    0x28db77f5n,
    0x23047d84n,
    0x32caab7bn,
    0x40c72493n,
    0x3c9ebe0an,
    0x15c9bebcn,
    0x431d67c4n,
    0x9c100d4cn,
    0x4cc5d4ben,
    0xcb3e42b6n,
    0x597f299cn,
    0xfc657e2an,
    0x5fcb6fabn,
    0x3ad6faecn,
    0x6c44198cn,
    0x4a475817n,
  ];

  const H = [
    0x6a09e667f3bcc908n,
    0xbb67ae8584caa73bn,
    0x3c6ef372fe94f82bn,
    0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n,
    0x9b05688c2b3e6c1fn,
    0x1f83d9abfb41bd6bn,
    0x5be0cd19137e2179n,
  ];

  const msg = new Uint8Array(message);
  const bitLen = BigInt(msg.length * 8);
  const padLen = (128 - ((msg.length + 17) % 128)) % 128;
  const padded = new Uint8Array(msg.length + 1 + padLen + 16);
  padded.set(msg);
  padded[msg.length] = 0x80;

  for (let i = 0; i < 8; i++) {
    padded[padded.length - 1 - i] = Number((bitLen >> BigInt(i * 8)) & 0xffn);
  }

  const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & 0xffffffffffffffffn;

  for (let chunk = 0; chunk < padded.length; chunk += 128) {
    const w = new Array<bigint>(80);

    for (let i = 0; i < 16; i++) {
      w[i] = 0n;
      for (let j = 0; j < 8; j++) {
        w[i] = (w[i] << 8n) | BigInt(padded[chunk + i * 8 + j]);
      }
    }

    for (let i = 16; i < 80; i++) {
      const s0 = rotr(w[i - 15], 1n) ^ rotr(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
      const s1 = rotr(w[i - 2], 19n) ^ rotr(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & 0xffffffffffffffffn;
    }

    let [a, b, c, d, e, f, g, h] = H;

    for (let i = 0; i < 80; i++) {
      const S1 = rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n);
      const ch = (e & f) ^ (~e & g);
      const ki = (K[i * 2] << 32n) | K[i * 2 + 1];
      const temp1 = (h + S1 + ch + ki + w[i]) & 0xffffffffffffffffn;
      const S0 = rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) & 0xffffffffffffffffn;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) & 0xffffffffffffffffn;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & 0xffffffffffffffffn;
    }

    H[0] = (H[0] + a) & 0xffffffffffffffffn;
    H[1] = (H[1] + b) & 0xffffffffffffffffn;
    H[2] = (H[2] + c) & 0xffffffffffffffffn;
    H[3] = (H[3] + d) & 0xffffffffffffffffn;
    H[4] = (H[4] + e) & 0xffffffffffffffffn;
    H[5] = (H[5] + f) & 0xffffffffffffffffn;
    H[6] = (H[6] + g) & 0xffffffffffffffffn;
    H[7] = (H[7] + h) & 0xffffffffffffffffn;
  }

  const result = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      result[i * 8 + j] = Number((H[i] >> BigInt((7 - j) * 8)) & 0xffn);
    }
  }
  return result;
}

const ED25519_P = 2n ** 255n - 19n;
const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
const ED25519_D = (-121665n * modInv(121666n, ED25519_P)) % ED25519_P;

function mod(a: bigint, m: bigint): bigint {
  return ((a % m) + m) % m;
}

function modInv(a: bigint, m: bigint): bigint {
  let [old_r, r] = [a, m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return mod(old_s, m);
}

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  base = mod(base, m);
  while (exp > 0n) {
    if (exp & 1n) result = mod(result * base, m);
    exp >>= 1n;
    base = mod(base * base, m);
  }
  return result;
}

type Point = { x: bigint; y: bigint; z: bigint; t: bigint };

function pointAdd(p1: Point, p2: Point): Point {
  const a = (mod(p1.y - p1.x, ED25519_P) * mod(p2.y - p2.x, ED25519_P)) % ED25519_P;
  const b = (mod(p1.y + p1.x, ED25519_P) * mod(p2.y + p2.x, ED25519_P)) % ED25519_P;
  const c = (2n * p1.t * p2.t * ED25519_D) % ED25519_P;
  const d = (2n * p1.z * p2.z) % ED25519_P;
  const e = mod(b - a, ED25519_P);
  const f = mod(d - c, ED25519_P);
  const g = mod(d + c, ED25519_P);
  const h = mod(b + a, ED25519_P);
  return {
    x: mod(e * f, ED25519_P),
    y: mod(g * h, ED25519_P),
    z: mod(f * g, ED25519_P),
    t: mod(e * h, ED25519_P),
  };
}

function pointDouble(p: Point): Point {
  const a = mod(p.x * p.x, ED25519_P);
  const b = mod(p.y * p.y, ED25519_P);
  const c = 2n * mod(p.z * p.z, ED25519_P);
  const h = mod(a + b, ED25519_P);
  const e = mod(h - mod((p.x + p.y) * (p.x + p.y), ED25519_P), ED25519_P);
  const g = mod(a - b, ED25519_P);
  const f = mod(c + g, ED25519_P);
  return {
    x: mod(e * f, ED25519_P),
    y: mod(g * h, ED25519_P),
    z: mod(f * g, ED25519_P),
    t: mod(e * h, ED25519_P),
  };
}

function scalarMult(k: bigint, p: Point): Point {
  let result: Point = { x: 0n, y: 1n, z: 1n, t: 0n };
  let temp = p;
  while (k > 0n) {
    if (k & 1n) result = pointAdd(result, temp);
    temp = pointDouble(temp);
    k >>= 1n;
  }
  return result;
}

function pointToBytes(p: Point): Uint8Array {
  const zi = modInv(p.z, ED25519_P);
  const x = mod(p.x * zi, ED25519_P);
  const y = mod(p.y * zi, ED25519_P);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number((y >> BigInt(i * 8)) & 0xffn);
  }
  bytes[31] |= Number((x & 1n) << 7n);
  return bytes;
}

function bytesToPoint(bytes: Uint8Array): Point {
  let y = 0n;
  for (let i = 0; i < 32; i++) {
    y |= BigInt(bytes[i] & (i === 31 ? 0x7f : 0xff)) << BigInt(i * 8);
  }
  const xSign = (bytes[31] >> 7) & 1;

  const y2 = mod(y * y, ED25519_P);
  const x2 = mod((y2 - 1n) * modInv(ED25519_D * y2 + 1n, ED25519_P), ED25519_P);
  let x = modPow(x2, (ED25519_P + 3n) / 8n, ED25519_P);

  if (mod(x * x - x2, ED25519_P) !== 0n) {
    x = mod(x * modPow(2n, (ED25519_P - 1n) / 4n, ED25519_P), ED25519_P);
  }

  if (Number(x & 1n) !== xSign) {
    x = mod(-x, ED25519_P);
  }

  return { x, y, z: 1n, t: mod(x * y, ED25519_P) };
}

const ED25519_G: Point = (() => {
  const gy = (4n * modInv(5n, ED25519_P)) % ED25519_P;
  const gx2 = mod((gy * gy - 1n) * modInv(ED25519_D * gy * gy + 1n, ED25519_P), ED25519_P);
  let gx = modPow(gx2, (ED25519_P + 3n) / 8n, ED25519_P);
  if (mod(gx * gx - gx2, ED25519_P) !== 0n) {
    gx = mod(gx * modPow(2n, (ED25519_P - 1n) / 4n, ED25519_P), ED25519_P);
  }
  if (gx & 1n) gx = mod(-gx, ED25519_P);
  return { x: gx, y: gy, z: 1n, t: mod(gx * gy, ED25519_P) };
})();

function ed25519GenerateKeypair(seed: Uint8Array): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
} {
  const h = sha512(seed);
  h[0] &= 248;
  h[31] &= 127;
  h[31] |= 64;

  let scalar = 0n;
  for (let i = 0; i < 32; i++) {
    scalar |= BigInt(h[i]) << BigInt(i * 8);
  }

  const pubPoint = scalarMult(scalar, ED25519_G);
  const publicKey = pointToBytes(pubPoint);

  return { privateKey: seed, publicKey };
}

function ed25519Sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  const h = sha512(privateKey);
  h[0] &= 248;
  h[31] &= 127;
  h[31] |= 64;

  let scalar = 0n;
  for (let i = 0; i < 32; i++) {
    scalar |= BigInt(h[i]) << BigInt(i * 8);
  }

  const pubPoint = scalarMult(scalar, ED25519_G);
  const publicKey = pointToBytes(pubPoint);

  const prefix = h.slice(32);
  const rHash = sha512(new Uint8Array([...prefix, ...message]));
  let r = 0n;
  for (let i = 0; i < 64; i++) {
    r |= BigInt(rHash[i]) << BigInt(i * 8);
  }
  r = mod(r, ED25519_L);

  const R = scalarMult(r, ED25519_G);
  const Rbytes = pointToBytes(R);

  const kHash = sha512(new Uint8Array([...Rbytes, ...publicKey, ...message]));
  let k = 0n;
  for (let i = 0; i < 64; i++) {
    k |= BigInt(kHash[i]) << BigInt(i * 8);
  }
  k = mod(k, ED25519_L);

  const s = mod(r + k * scalar, ED25519_L);

  const signature = new Uint8Array(64);
  signature.set(Rbytes);
  for (let i = 0; i < 32; i++) {
    signature[32 + i] = Number((s >> BigInt(i * 8)) & 0xffn);
  }

  return signature;
}

function ed25519Verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;

  try {
    const Rbytes = signature.slice(0, 32);
    const R = bytesToPoint(Rbytes);
    const A = bytesToPoint(publicKey);

    let s = 0n;
    for (let i = 0; i < 32; i++) {
      s |= BigInt(signature[32 + i]) << BigInt(i * 8);
    }

    if (s >= ED25519_L) return false;

    const kHash = sha512(new Uint8Array([...Rbytes, ...publicKey, ...message]));
    let k = 0n;
    for (let i = 0; i < 64; i++) {
      k |= BigInt(kHash[i]) << BigInt(i * 8);
    }
    k = mod(k, ED25519_L);

    const sB = scalarMult(s, ED25519_G);
    const kA = scalarMult(k, A);
    const RkA = pointAdd(R, kA);

    const left = pointToBytes(sB);
    const right = pointToBytes(RkA);

    for (let i = 0; i < 32; i++) {
      if (left[i] !== right[i]) return false;
    }

    return true;
  } catch {
    return false;
  }
}

function getRandomBytes(len: number): Uint8Array {
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

export function signing(): number {
  try {
    const inputStr = Host.inputString();
    const input: SigningInput = JSON.parse(inputStr);

    const encoding = input.encoding ?? 'hex';
    const algorithm = input.algorithm;

    if (algorithm !== 'ed25519') {
      throw new Error('Only ed25519 is currently supported');
    }

    let output: SigningOutput;

    switch (input.operation) {
      case 'generateKeypair': {
        const seed = getRandomBytes(32);
        const { privateKey, publicKey } = ed25519GenerateKeypair(seed);
        output = {
          privateKey: encodeKey(privateKey, encoding),
          publicKey: encodeKey(publicKey, encoding),
          algorithm,
        };
        break;
      }

      case 'sign': {
        if (!input.privateKey) throw new Error('privateKey required for signing');
        if (!input.message) throw new Error('message required for signing');

        const privateKey = decodeKey(input.privateKey, encoding);
        const message = new TextEncoder().encode(input.message);
        const signature = ed25519Sign(message, privateKey);

        output = {
          signature: encodeKey(signature, encoding),
          algorithm,
        };
        break;
      }

      case 'verify': {
        if (!input.publicKey) throw new Error('publicKey required for verification');
        if (!input.signature) throw new Error('signature required for verification');
        if (!input.message) throw new Error('message required for verification');

        const publicKey = decodeKey(input.publicKey, encoding);
        const signature = decodeKey(input.signature, encoding);
        const message = new TextEncoder().encode(input.message);
        const valid = ed25519Verify(message, signature, publicKey);

        output = {
          valid,
          algorithm,
        };
        break;
      }

      default:
        throw new Error(`Unknown operation: ${input.operation}`);
    }

    Host.outputString(JSON.stringify(output));
    return 0;
  } catch (error) {
    const output: SigningOutput = {
      algorithm: 'unknown',
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

class TextEncoder {
  encode(str: string): Uint8Array {
    const bytes: number[] = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
        const c2 = str.charCodeAt(++i);
        c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        bytes.push(
          0xf0 | (c >> 18),
          0x80 | ((c >> 12) & 0x3f),
          0x80 | ((c >> 6) & 0x3f),
          0x80 | (c & 0x3f)
        );
      } else {
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return new Uint8Array(bytes);
  }
}
