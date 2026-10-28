/**
 * The seccomp filter of a command under bubblewrap: a classic BPF program, in the bytes of the
 * kernel's `struct sock_filter` array that `bwrap --seccomp <fd>` reads, which keeps the command
 * from making namespaces of its own (where it would hold every capability over a private copy of
 * the mount tree and could undo the read-only binds that protect paths), from mounting, from
 * io_uring (which would create sockets past the filter), and from creating Unix sockets unless
 * the policy allows them
 */

/** CPU architectures the filter is built for */
export type SeccompArch = 'x64' | 'arm64';

export interface SeccompOptions {
  arch: SeccompArch;
  /** Let the command create `AF_UNIX` sockets (the policy allows Unix sockets) */
  allowUnixSockets: boolean;
}

/** One instruction of a classic BPF program */
export interface BpfInstruction {
  code: number;
  jt: number;
  jf: number;
  k: number;
}

const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_JGE_K = 0x35;
const BPF_JSET_K = 0x45;
const BPF_AND_K = 0x54;
const BPF_RET_K = 0x06;

/** Offsets in `struct seccomp_data` */
const NR = 0;
const ARCH = 4;
const ARG0_LOW = 16;
const ARG1_LOW = 24;

const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO = 0x00050000;
const EPERM = 1;
const ENOSYS = 38;

const AF_UNIX = 1;
/** The socket type without `SOCK_NONBLOCK` and `SOCK_CLOEXEC` */
const SOCK_TYPE_MASK = 0xf;
const SOCK_STREAM = 1;
const SOCK_SEQPACKET = 5;
/** `x32` system calls on x86_64 carry this bit in their number */
const X32_SYSCALL_BIT = 0x40000000;

/** Every `CLONE_NEW*` flag: mount, cgroup, UTS, IPC, user, PID and network namespaces */
export const CLONE_NAMESPACE_FLAGS =
  0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000;

interface ArchTable {
  audit: number;
  clone: number;
  clone3: number;
  socket: number;
  socketpair: number;
  /** Calls refused with `EPERM` whatever their arguments */
  denied: readonly number[];
}

/**
 * The calls refused outright: `unshare`, `setns`, `mount`, `umount2`, `pivot_root`, the new mount
 * API (`open_tree`, `move_mount`, `fsopen`, `fsconfig`, `fsmount`, `fspick`, `mount_setattr`) and
 * io_uring (`io_uring_setup`, `io_uring_enter`, `io_uring_register`). Numbers from 424 on are
 * the same on every architecture
 */
const COMMON_DENIED = [425, 426, 427, 428, 429, 430, 431, 432, 433, 442];

export const SECCOMP_ARCHES: Readonly<Record<SeccompArch, ArchTable>> = {
  x64: {
    audit: 0xc000003e,
    clone: 56,
    clone3: 435,
    socket: 41,
    socketpair: 53,
    denied: [272, 308, 165, 166, 155, ...COMMON_DENIED],
  },
  arm64: {
    audit: 0xc00000b7,
    clone: 220,
    clone3: 435,
    socket: 198,
    socketpair: 199,
    denied: [97, 268, 40, 39, 41, ...COMMON_DENIED],
  },
};

/** The architecture the filter is built for on this machine, undefined when it cannot be */
export function seccompArch(arch: string = process.arch): SeccompArch | undefined {
  return arch === 'x64' || arch === 'arm64' ? arch : undefined;
}

const load = (offset: number): BpfInstruction => ({ code: BPF_LD_W_ABS, jt: 0, jf: 0, k: offset });
const ret = (value: number): BpfInstruction => ({ code: BPF_RET_K, jt: 0, jf: 0, k: value });
const errno = (code: number): BpfInstruction => ret(SECCOMP_RET_ERRNO | code);

/**
 * The filter for `options`: a call of another architecture (`int 0x80` on x86_64, which numbers
 * calls differently) and an x32 call are refused, then the denied calls, `clone3` with `ENOSYS`
 * (its flags sit in memory a filter cannot read, so the C library falls back to `clone`), `clone`
 * with a namespace flag, and unless allowed `socket(AF_UNIX, ...)` and a `socketpair(AF_UNIX, ...)`
 * of a datagram type, whose ends can be connected again to any path (a stream or seqpacket pair,
 * which libuv makes for child process pipes, cannot). Everything else is allowed
 */
export function seccompProgram(options: SeccompOptions): BpfInstruction[] {
  const table = SECCOMP_ARCHES[options.arch];
  const program: BpfInstruction[] = [
    load(ARCH),
    { code: BPF_JEQ_K, jt: 1, jf: 0, k: table.audit },
    errno(EPERM),
    load(NR),
  ];
  if (options.arch === 'x64') {
    program.push({ code: BPF_JGE_K, jt: 0, jf: 1, k: X32_SYSCALL_BIT }, errno(EPERM));
  }
  for (const nr of table.denied) {
    program.push({ code: BPF_JEQ_K, jt: 0, jf: 1, k: nr }, errno(EPERM));
  }
  program.push({ code: BPF_JEQ_K, jt: 0, jf: 1, k: table.clone3 }, errno(ENOSYS));
  program.push(
    { code: BPF_JEQ_K, jt: 0, jf: 4, k: table.clone },
    load(ARG0_LOW),
    { code: BPF_JSET_K, jt: 0, jf: 1, k: CLONE_NAMESPACE_FLAGS },
    errno(EPERM),
    ret(SECCOMP_RET_ALLOW)
  );
  if (!options.allowUnixSockets) {
    program.push(
      { code: BPF_JEQ_K, jt: 0, jf: 4, k: table.socket },
      load(ARG0_LOW),
      { code: BPF_JEQ_K, jt: 0, jf: 1, k: AF_UNIX },
      errno(EPERM),
      ret(SECCOMP_RET_ALLOW),
      { code: BPF_JEQ_K, jt: 0, jf: 8, k: table.socketpair },
      load(ARG0_LOW),
      { code: BPF_JEQ_K, jt: 0, jf: 5, k: AF_UNIX },
      load(ARG1_LOW),
      { code: BPF_AND_K, jt: 0, jf: 0, k: SOCK_TYPE_MASK },
      { code: BPF_JEQ_K, jt: 2, jf: 0, k: SOCK_STREAM },
      { code: BPF_JEQ_K, jt: 1, jf: 0, k: SOCK_SEQPACKET },
      errno(EPERM),
      ret(SECCOMP_RET_ALLOW)
    );
  }
  program.push(ret(SECCOMP_RET_ALLOW));
  return program;
}

/**
 * `program` as the bytes of a `struct sock_filter` array in the byte order of the machine (both
 * supported architectures are little-endian): per instruction a 16-bit code, the two 8-bit jump
 * offsets and a 32-bit operand
 */
export function seccompBytes(program: readonly BpfInstruction[]): Uint8Array {
  const bytes = new Uint8Array(program.length * 8);
  const view = new DataView(bytes.buffer);
  program.forEach((instruction, index) => {
    const at = index * 8;
    view.setUint16(at, instruction.code, true);
    view.setUint8(at + 2, instruction.jt);
    view.setUint8(at + 3, instruction.jf);
    view.setUint32(at + 4, instruction.k >>> 0, true);
  });
  return bytes;
}

/** The filter of {@link seccompProgram} as the bytes `bwrap --seccomp` reads */
export function seccompFilter(options: SeccompOptions): Uint8Array {
  return seccompBytes(seccompProgram(options));
}
