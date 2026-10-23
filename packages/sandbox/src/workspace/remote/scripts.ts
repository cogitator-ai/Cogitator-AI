/**
 * The shell scripts a `RemoteShellWorkspace` runs in its sandbox. Each one runs as
 * `sh -c <script> cogitator <root> <args...>` with every argument a separate word, so no path
 * is ever parsed by the shell, and reports what went wrong with an exit code of
 * {@link SCRIPT_EXIT}. They need GNU coreutils (`realpath -m`, `stat -c`, `mv -T`), GNU
 * findutils (`find -printf`), GNU tar and util-linux `setsid`, which `START` checks.
 */

/** Exit codes of the scripts, each one a `WorkspaceError` code for the path it is about. */
export const SCRIPT_EXIT = {
  outside: 40,
  outsideTarget: 41,
  symlinkLoop: 42,
  notFound: 44,
  notEmpty: 45,
  exists: 46,
  isDirectory: 47,
  notADirectory: 48,
  tooLarge: 49,
  readOnly: 50,
  internal: 51,
  insideItself: 52,
  busy: 53,
  rootPath: 55,
  internalTarget: 56,
  notRegular: 57,
  missingTools: 60,
} as const;

const E = SCRIPT_EXIT;

/**
 * Helpers every script starts with. `resolve <abs> <follow>` sets `p` to the path with its
 * symlinks resolved (all of them, or all but the last component) and `rel` to it relative to the
 * root, and fails when it lands outside. A trailing `x` keeps newlines at the end of names that
 * command substitution would strip.
 */
const PRELUDE = `root=$1; shift
canon() {
  c=$(realpath -m -- "$1" && printf x) || return 1
  c=\${c%?x}
}
resolve() {
  if [ "$2" = 1 ]; then
    canon "$1" || return ${E.symlinkLoop}
    p=$c
    [ -L "$p" ] && return ${E.symlinkLoop}
  else
    d=\${1%/*}; [ -n "$d" ] || d=/
    canon "$d" || return ${E.symlinkLoop}
    if [ "$c" = / ]; then p=/\${1##*/}; else p=$c/\${1##*/}; fi
  fi
  case $p in
    "$root") rel=. ;;
    "$root"/*) rel=\${p#"$root"/} ;;
    *) return ${E.outside} ;;
  esac
}
internal() {
  case $1 in
    .cogitator|.cogitator/pending|.cogitator/pending/*|.cogitator/snapshots|.cogitator/snapshots/*) return 0 ;;
  esac
  return 1
}
present() { [ -e "$1" ] || [ -L "$1" ]; }
isdir() { [ -d "$1" ] && [ ! -L "$1" ]; }
hasentries() { [ -n "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)" ]; }
mkdirs() {
  mkdir -p -- "$1" 2>/dev/null || {
    m=$1
    while ! present "$m"; do m=\${m%/*}; [ -n "$m" ] || m=/; done
    [ -d "$m" ] || exit ${E.notADirectory}
    mkdir -p -- "$1" || exit 1
  }
  m=$(realpath -e -- "$1" && printf x) || exit 1
  m=\${m%?x}
  case $m in "$root"|"$root"/*) ;; *) exit ${E.outside} ;; esac
}
gitignore() {
  [ -e "$root/.cogitator/.gitignore" ] || printf '*\\n' > "$root/.cogitator/.gitignore"
}
busy() {
  for g in "$@"; do kill -s 0 -- "-$g" 2>/dev/null && return 0; done
  return 1
}
`;

function script(body: string): string {
  return `${PRELUDE}${body}`;
}

/**
 * Checks the tools, creates the root when asked (`$1` = 1) and prints the root with its
 * symlinks resolved. Missing tools are named on stderr.
 */
export const START = `root=$1
missing=
for tool in setsid realpath find stat mv tar xargs mkdir rmdir; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -z "$missing" ]; then
  realpath -m / >/dev/null 2>&1 || missing="$missing realpath-m(GNU-coreutils)"
  find / -maxdepth 0 -printf '' >/dev/null 2>&1 || missing="$missing find-printf(GNU-findutils)"
  setsid -w true >/dev/null 2>&1 || missing="$missing setsid-w(util-linux)"
fi
[ -z "$missing" ] || { printf '%s' "$missing" >&2; exit ${E.missingTools}; }
if [ -e "$root" ] && [ ! -d "$root" ]; then exit ${E.notADirectory}; fi
if [ "$2" = 1 ]; then mkdir -p -- "$root" || exit 1; fi
[ -e "$root" ] || exit ${E.notFound}
[ -d "$root" ] || exit ${E.notADirectory}
r=$(realpath -e -- "$root" && printf x) || exit 1
printf '%s' "\${r%?x}"`;

/** Creates `.cogitator/pending` and `.cogitator/snapshots`, refusing them when they lead out of the root. */
export const ENSURE_SERVICE =
  script(`for d in "$root/.cogitator/pending" "$root/.cogitator/snapshots"; do mkdirs "$d"; done
gitignore`);

/** `$1` path: exits 0 when it resolves inside the root. */
export const CONTAINS = script(`resolve "$1" 1 || exit $?`);

/** `$1` path: prints `1` when something exists there, `0` otherwise. */
export const EXISTS = script(`resolve "$1" 1 || exit $?
if present "$p"; then printf 1; else printf 0; fi`);

/** `$1` path: prints type, size, modification time and the resolved path, NUL-separated. */
export const STAT = script(`resolve "$1" 1 || exit $?
present "$p" || exit ${E.notFound}
find "$p" -maxdepth 0 -printf '%y\\0%s\\0%T@\\0' || exit 1
printf '%s\\0' "$rel"`);

/**
 * `$1` path, `$2` byte limit: prints the resolved path of a regular file within the limit, or
 * its size when it is over.
 */
export const READ = script(`resolve "$1" 1 || exit $?
present "$p" || exit ${E.notFound}
[ -d "$p" ] && exit ${E.isDirectory}
[ -f "$p" ] || exit ${E.notRegular}
s=$(stat -c %s -- "$p") || exit 1
[ "$s" -le "$2" ] || { printf '%s' "$s"; exit ${E.tooLarge}; }
printf '%s' "$p"`);

/**
 * `$1` path, `$2` the uploaded temporary file, `$3` create parents (1/0), `$4` force (1/0):
 * moves the upload over the file, keeping the mode of the file it replaces. The upload is
 * removed whatever happens.
 */
export const COMMIT_WRITE = script(`t=$2
trap 'rm -f -- "$t"' EXIT
resolve "$1" 1 || exit $?
[ "$rel" = . ] && exit ${E.isDirectory}
internal "$rel" && exit ${E.internal}
d=\${p%/*}; [ -n "$d" ] || d=/
if [ "$3" = 1 ]; then
  mkdirs "$d"
elif ! [ -d "$d" ]; then
  present "$d" && exit ${E.notADirectory}
  exit ${E.notFound}
fi
if present "$p"; then
  [ -d "$p" ] && exit ${E.isDirectory}
  [ -f "$p" ] || exit ${E.notRegular}
  [ "$4" = 1 ] || [ -w "$p" ] || exit ${E.readOnly}
  chmod --reference="$p" -- "$t" 2>/dev/null
fi
case $rel in .cogitator/*) gitignore ;; esac
mv -f -T -- "$t" "$p" || exit 1`);

/**
 * `$1` directory, then the \`find\` expression that prints its entries: prints the directory
 * relative to the root, then type, size, modification time and path of every entry, NUL-separated.
 * Entries \`find\` cannot read are left out.
 */
export const LIST = script(`resolve "$1" 1 || exit $?
present "$p" || exit ${E.notFound}
[ -d "$p" ] || exit ${E.notADirectory}
shift
printf '%s\\0' "$rel"
find "$p" -mindepth 1 "$@" 2>/dev/null
exit 0`);

/** `$1` path: creates the directory and its missing parents. */
export const MKDIR = script(`resolve "$1" 1 || exit $?
mkdirs "$p"`);

/**
 * `$1` path, `$2` recursive (1/0), `$3` trash directory (empty to delete), then the process
 * groups that may still run: removes the entry (a symlink itself, not its target) and prints it
 * relative to the root.
 */
export const REMOVE = script(`resolve "$1" 0 || exit $?
r=$2; t=$3; shift 3
busy "$@" && exit ${E.busy}
[ "$rel" = . ] && exit ${E.rootPath}
internal "$rel" && exit ${E.internal}
present "$p" || exit ${E.notFound}
if isdir "$p" && [ "$r" != 1 ] && hasentries "$p"; then exit ${E.notEmpty}; fi
if [ -n "$t" ]; then
  mkdirs "$t/$rel"
  rmdir -- "$t/$rel"
  gitignore
  mv -T -- "$p" "$t/$rel" || exit 1
elif isdir "$p"; then
  if [ "$r" = 1 ]; then rm -rf -- "$p" || exit 1; else rmdir -- "$p" || exit 1; fi
else
  rm -f -- "$p" || exit 1
fi
printf '%s' "$rel"`);

/**
 * `$1` source, `$2` target, `$3` overwrite (1/0), then the process groups that may still run:
 * moves the entry (a symlink itself, not its target), its target's parents created.
 */
export const RENAME = script(`resolve "$1" 0 || exit $?
s=$p; srel=$rel
resolve "$2" 0 || { e=$?; [ "$e" = ${E.outside} ] && e=${E.outsideTarget}; exit "$e"; }
t=$p; trel=$rel
o=$3; shift 3
busy "$@" && exit ${E.busy}
if [ "$srel" = . ] || [ "$trel" = . ]; then exit ${E.rootPath}; fi
internal "$srel" && exit ${E.internal}
internal "$trel" && exit ${E.internalTarget}
[ "$s" = "$t" ] && exit 0
case $t in "$s"/*) exit ${E.insideItself} ;; esac
present "$s" || exit ${E.notFound}
if present "$t"; then
  [ "$o" = 1 ] || exit ${E.exists}
  if isdir "$t" && ! isdir "$s"; then exit ${E.isDirectory}; fi
  if ! isdir "$t" && isdir "$s"; then exit ${E.notADirectory}; fi
  if isdir "$t" && hasentries "$t"; then exit ${E.notEmpty}; fi
fi
d=\${t%/*}; [ -n "$d" ] || d=/
mkdirs "$d"
if [ "$o" = 1 ]; then
  mv -f -T -- "$s" "$t" || exit 1
else
  mv -n -T -- "$s" "$t" 2>/dev/null || { present "$t" && exit ${E.exists}; exit 1; }
  present "$s" && exit ${E.exists}
fi
exit 0`);

/**
 * Runs a command as the leader of its own session and process group (under `setsid -w`),
 * reporting the group, a bad directory and the exit code on stderr with marker lines. The token
 * that makes them unforgeable comes on stdin, read before the command starts: it is in no argv
 * or environment the command can read. `$1` is the directory, `$2` the command.
 */
export const EXEC_WRAPPER = `IFS= read -r t || exit 125
printf '__cogitator_%s_pgid:%s\\n' "$t" "$$" >&2
${PRELUDE}resolve "$1" 1 || { e=$?; printf '__cogitator_%s_cwd:%s\\n' "$t" "$e" >&2; exit 125; }
if ! [ -d "$p" ]; then
  if present "$p"; then c=${E.notADirectory}; else c=${E.notFound}; fi
  printf '__cogitator_%s_cwd:%s\\n' "$t" "$c" >&2
  exit 125
fi
cd -- "$p" || { printf '__cogitator_%s_cwd:%s\\n' "$t" ${E.notADirectory} >&2; exit 125; }
sh -c "$2" </dev/null; c=$?
printf '__cogitator_%s_exit:%s\\n' "$t" "$c" >&2
exit $c`;

/** `$1` signal name, then process group ids: signals every group, ignoring the gone ones. */
export const SIGNAL_GROUPS = `s=$1; shift
for g in "$@"; do kill -s "$s" -- "-$g" 2>/dev/null; done
exit 0`;

/**
 * Prints type and path (relative to the root) of everything in the root, NUL-separated, but for
 * the workspace's own pending files and snapshots.
 */
export const SNAPSHOT_TREE = script(`cd -- "$root" || exit 1
find . -mindepth 1 \\( -path ./.cogitator/snapshots -o -path ./.cogitator/pending \\) -prune -o -printf '%y\\0%P\\0' 2>/dev/null
exit 0`);

/**
 * `$1` snapshot id, `$2` its record (JSON): archives the paths listed in `<id>.list`, then
 * writes the record, which marks the snapshot complete. Files that vanish meanwhile are skipped.
 */
export const SNAPSHOT_CREATE = script(`cd -- "$root/.cogitator/snapshots" || exit 1
id=$1
trap 'rm -f -- "$id.tar.part"' EXIT
tar -C "$root" --null --no-recursion --ignore-failed-read -T "$id.list" -cf "$id.tar.part" 2>/dev/null
c=$?
[ "$c" -le 1 ] || { rm -f -- "$id.list" "$id.dirs"; exit 1; }
mv -f -- "$id.tar.part" "$id.tar" || exit 1
printf '%s' "$2" > "$id.json.part" && mv -f -- "$id.json.part" "$id.json" || exit 1`);

/** Prints the records of the snapshots, each followed by a NUL. */
export const SNAPSHOT_RECORDS = script(`for f in "$root"/.cogitator/snapshots/*.json; do
  [ -f "$f" ] || continue
  cat -- "$f" && printf '\\0'
done
exit 0`);

/**
 * `$1` snapshot id, `$2` and `$3` the uploaded lists of files and of directories (deepest first)
 * to remove first: removes them, then extracts the snapshot over the root.
 */
export const SNAPSHOT_RESTORE = script(`a=$2; b=$3
trap 'rm -f -- "$a" "$b"' EXIT
cd -- "$root" || exit 1
[ -f ".cogitator/snapshots/$1.tar" ] || exit ${E.notFound}
xargs -0 -r rm -f -- < "$a" || exit 1
xargs -0 -r rmdir --ignore-fail-on-non-empty -- < "$b" 2>/dev/null
tar -xpf ".cogitator/snapshots/$1.tar" || exit 1`);

/** `$1` snapshot id: forgets the snapshot. */
export const SNAPSHOT_DELETE =
  script(`cd -- "$root/.cogitator/snapshots" 2>/dev/null || exit ${E.notFound}
[ -f "$1.json" ] || exit ${E.notFound}
rm -f -- "$1.json" "$1.tar" "$1.list" "$1.dirs"`);
