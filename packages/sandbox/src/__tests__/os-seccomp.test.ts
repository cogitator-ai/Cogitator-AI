import { describe, expect, it } from 'vitest';
import { bubblewrapVersion, nestingCandidates, supportsDisableUserns } from '../os/probe';
import {
  CLONE_NAMESPACE_FLAGS,
  SECCOMP_ARCHES,
  seccompArch,
  seccompBytes,
  seccompFilter,
  seccompProgram,
  type SeccompArch,
} from '../os/seccomp';

const ALLOW = 0x7fff0000;
const EPERM = 0x00050001;
const ENOSYS = 0x00050026;

interface Call {
  nr: number;
  arch: number;
  args?: number[];
}

/** Runs a classic BPF program from its bytes over `struct seccomp_data`, as the kernel would */
function evaluate(bytes: Uint8Array, call: Call): number {
  const data = new DataView(new ArrayBuffer(64));
  data.setUint32(0, call.nr, true);
  data.setUint32(4, call.arch, true);
  (call.args ?? []).forEach((value, index) => data.setUint32(16 + index * 8, value >>> 0, true));
  const program = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let accumulator = 0;
  for (let pc = 0; pc * 8 < bytes.byteLength; pc++) {
    const code = program.getUint16(pc * 8, true);
    const jt = program.getUint8(pc * 8 + 2);
    const jf = program.getUint8(pc * 8 + 3);
    const k = program.getUint32(pc * 8 + 4, true);
    switch (code) {
      case 0x20:
        accumulator = data.getUint32(k, true);
        break;
      case 0x15:
        pc += accumulator === k ? jt : jf;
        break;
      case 0x35:
        pc += accumulator >= k ? jt : jf;
        break;
      case 0x45:
        pc += (accumulator & k) !== 0 ? jt : jf;
        break;
      case 0x54:
        accumulator = (accumulator & k) >>> 0;
        break;
      case 0x06:
        return k;
      default:
        throw new Error(`unknown BPF code ${code}`);
    }
  }
  throw new Error('the program fell off its end');
}

const NUMBERS: Record<SeccompArch, Record<string, number>> = {
  x64: { read: 0, unshare: 272, setns: 308, mount: 165, umount2: 166, pivot_root: 155 },
  arm64: { read: 63, unshare: 97, setns: 268, mount: 40, umount2: 39, pivot_root: 41 },
};

describe.each(['x64', 'arm64'] as const)('the seccomp filter on %s', (arch) => {
  const table = SECCOMP_ARCHES[arch];
  const strict = seccompFilter({ arch, allowUnixSockets: false });
  const run = (nr: number, args: number[] = [], bytes = strict) =>
    evaluate(bytes, { nr, arch: table.audit, args });

  it('refuses the calls that make or join namespaces and mount', () => {
    for (const name of ['unshare', 'setns', 'mount', 'umount2', 'pivot_root']) {
      expect(run(NUMBERS[arch][name]), name).toBe(EPERM);
    }
    for (const nr of [425, 426, 427, 428, 429, 430, 431, 432, 433, 442]) {
      expect(run(nr), String(nr)).toBe(EPERM);
    }
  });

  it('refuses clone with a namespace flag, and lets threads and processes start', () => {
    expect(run(table.clone, [0x10000000])).toBe(EPERM);
    expect(run(table.clone, [0x00020000 | 0x11])).toBe(EPERM);
    expect(run(table.clone, [0x40000000])).toBe(EPERM);
    expect(run(table.clone, [0x003d0f00])).toBe(ALLOW);
    expect(run(table.clone, [0x01200011])).toBe(ALLOW);
    expect(run(table.clone3)).toBe(ENOSYS);
  });

  it('refuses Unix sockets unless allowed, and lets other sockets through', () => {
    expect(run(table.socket, [1, 1, 0])).toBe(EPERM);
    expect(run(table.socket, [2, 1, 0])).toBe(ALLOW);
    expect(run(table.socket, [10, 2, 0])).toBe(ALLOW);
    const open = seccompFilter({ arch, allowUnixSockets: true });
    expect(run(table.socket, [1, 1, 0], open)).toBe(ALLOW);
    expect(run(NUMBERS[arch].unshare, [], open)).toBe(EPERM);
  });

  it('refuses datagram Unix socket pairs unless allowed, keeping stream pairs for pipes', () => {
    const SOCK_NONBLOCK_CLOEXEC = 0o4000 | 0o2000000;
    expect(run(table.socketpair, [1, 2, 0])).toBe(EPERM);
    expect(run(table.socketpair, [1, 2 | SOCK_NONBLOCK_CLOEXEC, 0])).toBe(EPERM);
    expect(run(table.socketpair, [1, 3, 0])).toBe(EPERM);
    expect(run(table.socketpair, [1, 1, 0])).toBe(ALLOW);
    expect(run(table.socketpair, [1, 1 | SOCK_NONBLOCK_CLOEXEC, 0])).toBe(ALLOW);
    expect(run(table.socketpair, [1, 5, 0])).toBe(ALLOW);
    expect(run(table.socketpair, [30, 2, 0])).toBe(ALLOW);
    const open = seccompFilter({ arch, allowUnixSockets: true });
    expect(run(table.socketpair, [1, 2, 0], open)).toBe(ALLOW);
  });

  it('allows ordinary calls and refuses calls of another architecture', () => {
    expect(run(NUMBERS[arch].read)).toBe(ALLOW);
    expect(evaluate(strict, { nr: 0, arch: 0x40000003 })).toBe(EPERM);
    const other = arch === 'x64' ? SECCOMP_ARCHES.arm64.audit : SECCOMP_ARCHES.x64.audit;
    expect(evaluate(strict, { nr: NUMBERS[arch].read, arch: other })).toBe(EPERM);
  });
});

describe('the seccomp program', () => {
  it('refuses x32 calls on x86_64', () => {
    const bytes = seccompFilter({ arch: 'x64', allowUnixSockets: false });
    expect(evaluate(bytes, { nr: 0x40000000 + 272, arch: SECCOMP_ARCHES.x64.audit })).toBe(EPERM);
    expect(evaluate(bytes, { nr: 0x40000000, arch: SECCOMP_ARCHES.x64.audit })).toBe(EPERM);
  });

  it('is laid out as sock_filter entries in little-endian order', () => {
    const program = seccompProgram({ arch: 'x64', allowUnixSockets: false });
    const bytes = seccompBytes(program);
    expect(bytes.byteLength).toBe(program.length * 8);
    expect([...bytes.slice(0, 16)]).toEqual([
      0x20, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x15, 0x00, 0x01, 0x00, 0x3e, 0x00, 0x00,
      0xc0,
    ]);
    expect(program.at(-1)).toEqual({ code: 0x06, jt: 0, jf: 0, k: ALLOW });
    expect(program.every((entry) => entry.jt < 256 && entry.jf < 256)).toBe(true);
  });

  it('names every namespace flag', () => {
    expect(CLONE_NAMESPACE_FLAGS).toBe(0x7e020000);
  });

  it('is built only for the CPUs it knows', () => {
    expect(seccompArch('x64')).toBe('x64');
    expect(seccompArch('arm64')).toBe('arm64');
    expect(seccompArch('ia32')).toBeUndefined();
    expect(seccompArch('riscv64')).toBeUndefined();
  });
});

describe('the bubblewrap probe helpers', () => {
  it('reads the version bwrap prints and whether it has --disable-userns', () => {
    expect(bubblewrapVersion('bubblewrap 0.8.0\n')).toEqual([0, 8, 0]);
    expect(bubblewrapVersion('bubblewrap 0.11.1')).toEqual([0, 11, 1]);
    expect(bubblewrapVersion('bubblewrap 0.6')).toEqual([0, 6, 0]);
    expect(bubblewrapVersion('')).toBeUndefined();
    expect(supportsDisableUserns([0, 8, 0])).toBe(true);
    expect(supportsDisableUserns([0, 11, 1])).toBe(true);
    expect(supportsDisableUserns([0, 7, 9])).toBe(false);
    expect(supportsDisableUserns([1, 0, 0])).toBe(true);
    expect(supportsDisableUserns(undefined)).toBe(false);
  });

  it('tries the strongest nesting protection first, and nothing when none exists', () => {
    expect(nestingCandidates(true, 'x64')).toEqual([
      { disableUserns: true, seccomp: true },
      { disableUserns: false, seccomp: true },
    ]);
    expect(nestingCandidates(true, 'x64', true)).toEqual([
      { disableUserns: true, seccomp: true },
      { disableUserns: false, seccomp: true },
      { disableUserns: true, seccomp: false },
    ]);
    expect(nestingCandidates(false, 'arm64')).toEqual([{ disableUserns: false, seccomp: true }]);
    expect(nestingCandidates(true, undefined)).toEqual([]);
    expect(nestingCandidates(true, undefined, true)).toEqual([
      { disableUserns: true, seccomp: false },
    ]);
    expect(nestingCandidates(true, 'x64', false)).not.toContainEqual({
      disableUserns: true,
      seccomp: false,
    });
    expect(nestingCandidates(false, undefined)).toEqual([]);
  });
});
