/**
 * What the sandbox of a harness denies the commands of a session, for the Node processes among
 * them: every connection out, unix sockets included, and every write outside the folder the
 * session works in (any write at all when the sandbox is read-only). The fake harnesses load it
 * into the commands they run with `--import` in NODE_OPTIONS. A server of tools is started by the harness
 * itself and never gets it, which is the point: it lives outside the sandbox.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';

const mode = process.env.FAKE_SANDBOX;
const root = process.env.FAKE_SANDBOX_ROOT;

function denied(syscall, target) {
  const error = new Error(`${syscall} EPERM${target ? ` ${target}` : ''}`);
  error.code = 'EPERM';
  error.errno = -1;
  error.syscall = syscall;
  return error;
}

function real(file) {
  const absolute = path.resolve(String(file));
  for (let current = absolute, rest = []; ; current = path.dirname(current)) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest.reverse());
    } catch {
      if (path.dirname(current) === current) return absolute;
      rest.push(path.basename(current));
    }
  }
}

function writable(file) {
  if (mode !== 'workspace-write' || !root) return false;
  const inner = path.relative(real(root), real(file));
  return inner === '' || (!inner.startsWith('..') && !path.isAbsolute(inner));
}

const writes = (flags) => flags !== undefined && !/^r(?!\+)/.test(String(flags));

/** Whether a call of `name` with `args` would write to a place the sandbox keeps from it. */
function refuses(name, args) {
  const [file, second] = args;
  if (typeof file !== 'string' && !Buffer.isBuffer(file) && !(file instanceof URL)) return false;
  if (name === 'open' && !writes(second)) return false;
  return !writable(file instanceof URL ? file.pathname : file);
}

const GUARDED = ['writeFile', 'appendFile', 'mkdir', 'open', 'rm', 'unlink', 'rename'];

if (mode && mode !== 'danger-full-access') {
  net.Socket.prototype.connect = function sandboxedConnect(...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const target =
      typeof first === 'object' && first !== null
        ? (first.path ?? `${first.host ?? 'localhost'}:${first.port}`)
        : String(first);
    process.nextTick(() => this.destroy(denied('connect', target)));
    return this;
  };

  for (const name of GUARDED) {
    const sync = fs[`${name}Sync`];
    fs[`${name}Sync`] = function sandboxedSync(...args) {
      if (refuses(name, args)) throw denied(name, String(args[0]));
      return sync.apply(this, args);
    };
    const later = fs[name];
    fs[name] = function sandboxedCallback(...args) {
      if (!refuses(name, args)) return later.apply(this, args);
      const done = args.at(-1);
      if (typeof done === 'function') process.nextTick(done, denied(name, String(args[0])));
    };
    const promised = fs.promises[name];
    fs.promises[name] = function sandboxedPromise(...args) {
      if (refuses(name, args)) return Promise.reject(denied(name, String(args[0])));
      return promised.apply(this, args);
    };
  }
  syncBuiltinESMExports();
}
