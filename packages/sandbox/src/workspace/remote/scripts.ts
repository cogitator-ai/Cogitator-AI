/**
 * The shell scripts a `RemoteShellWorkspace` runs in its sandbox. Each one runs as
 * `sh -c <script> cogitator <root> <args...>` with every argument a separate word, so no path
 * is ever parsed by the shell, and reports what went wrong with an exit code of
 * {@link SCRIPT_EXIT}. They need GNU coreutils (`realpath -m`, `stat -c`, `mv -T`, `head -z`,
 * `sort -z`), GNU findutils (`find -printf`), GNU tar and util-linux `setsid`, which `START`
 * checks.
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
  uploadChanged: 58,
  missingTools: 60,
} as const;

const E = SCRIPT_EXIT;

/**
 * `leaders` sets `L` to the process groups that still lead their own session (` 12 34 `): a
 * group a command's `setsid` wrapper made keeps its id as its session id, so an id the system
 * gave to an unrelated process since is not taken for it. Without `/proc` every group given is
 * taken as alive.
 */
const GROUPS = `leaders() {
  L=' '
  if ! [ -r /proc/self/stat ]; then
    for g in "$@"; do L="$L$g "; done
    return 0
  fi
  for f in /proc/[0-9]*/stat; do
    { IFS= read -r l < "$f"; } 2>/dev/null || continue
    l=\${l##*\\) }
    set -- $l
    [ "$3" = "$4" ] && L="$L$3 "
  done
  return 0
}
`;

/**
 * Helpers every script starts with. `resolve <abs> <follow>` sets `p` to the path with its
 * symlinks resolved (all of them, or all but the last component) and `rel` to it relative to the
 * root, and fails when it lands outside. A trailing `x` keeps newlines at the end of names that
 * command substitution would strip. `mkdirs` checks the nearest existing ancestor is inside the
 * root before it creates anything, so nothing is made outside through a symlink. `servicedir
 * <name> <create>` checks `.cogitator/<name>` is a real directory of the root (neither it nor
 * `.cogitator` a symlink), every time a script goes through it, and `temp <name>` sets `f` to a
 * file of the sandbox's temporary directory the workspace named, refusing any other name.
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
inroot() {
  n=$(realpath -e -- "$1" && printf x) || return 1
  n=\${n%?x}
  case $n in "$root"|"$root"/*) return 0 ;; esac
  return 1
}
mkdirs() {
  m=$1
  while ! present "$m"; do m=\${m%/*}; [ -n "$m" ] || m=/; done
  inroot "$m" || exit ${E.outside}
  [ -d "$m" ] || exit ${E.notADirectory}
  mkdir -p -- "$1" || exit 1
  inroot "$1" || exit ${E.outside}
}
gitignore() {
  [ -e "$root/.cogitator/.gitignore" ] || printf '*\\n' > "$root/.cogitator/.gitignore"
}
servicedir() {
  sd="$root/.cogitator/$1"
  [ ! -L "$root/.cogitator" ] || exit ${E.outside}
  if ! present "$sd"; then
    [ "$2" = 1 ] || return 2
    mkdirs "$sd"
  fi
  { [ ! -L "$root/.cogitator" ] && [ ! -L "$sd" ] && [ -d "$sd" ]; } || exit ${E.outside}
  n=$(realpath -e -- "$sd" && printf x) || exit 1
  [ "\${n%?x}" = "$sd" ] || exit ${E.outside}
  gitignore
}
T=\${TMPDIR:-/tmp}
temp() {
  case $1 in
    */*|'') exit 1 ;;
    cogitator-read-*|cogitator-upload-*|cogitator-list-*) f="$T/$1" ;;
    *) exit 1 ;;
  esac
}
${GROUPS}busy() {
  leaders "$@"
  for g in "$@"; do
    case $L in *" $g "*) return 0 ;; esac
  done
  return 1
}
`;

function script(body: string): string {
  return `${PRELUDE}${body}`;
}

/**
 * Checks the tools, creates the root when asked (`$2` = 1), removes what interrupted operations
 * left in the temporary directory over an hour ago, and prints the root with its symlinks
 * resolved and the temporary directory, NUL-separated. Missing tools are named on stderr.
 */
export const START = `root=$1
missing=
for tool in setsid realpath find stat mv tar xargs mkdir rmdir head sort tr od date; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -z "$missing" ]; then
  realpath -m / >/dev/null 2>&1 || missing="$missing realpath-m(GNU-coreutils)"
  stat -c %s / >/dev/null 2>&1 || missing="$missing stat-c(GNU-coreutils)"
  head -z -n 1 </dev/null >/dev/null 2>&1 || missing="$missing head-z(GNU-coreutils)"
  sort -z </dev/null >/dev/null 2>&1 || missing="$missing sort-z(GNU-coreutils)"
  find / -maxdepth 0 -printf '' >/dev/null 2>&1 || missing="$missing find-printf(GNU-findutils)"
  tar --null --no-recursion -cf /dev/null -T /dev/null >/dev/null 2>&1 || missing="$missing GNU-tar"
  setsid -w true >/dev/null 2>&1 || missing="$missing setsid-w(util-linux)"
  case $(date +%s%N) in *N|'') missing="$missing date-N(GNU-coreutils)" ;; esac
fi
[ -z "$missing" ] || { printf '%s' "$missing" >&2; exit ${E.missingTools}; }
if [ -e "$root" ] && [ ! -d "$root" ]; then exit ${E.notADirectory}; fi
if [ "$2" = 1 ]; then mkdir -p -- "$root" || exit 1; fi
[ -e "$root" ] || exit ${E.notFound}
[ -d "$root" ] || exit ${E.notADirectory}
r=$(realpath -e -- "$root" && printf x) || exit 1
t=\${TMPDIR:-/tmp}
find "$t" -mindepth 1 -maxdepth 1 \\( -name 'cogitator-read-*' -o -name 'cogitator-upload-*' -o -name 'cogitator-list-*' -o -name 'cogitator-env.*' \\) -mmin +60 -exec rm -rf -- {} + 2>/dev/null
printf '%s\\0%s' "\${r%?x}" "$t"`;

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
 * `$1` path, `$2` byte limit, `$3` a fresh file name: copies at most one byte over the limit of
 * the regular file there to that name in the sandbox's temporary directory (mode 0600, the root
 * is not written), so a file that grows meanwhile is caught without moving more than that. Prints
 * the copy's path, or the size when it is over the limit. A failed read leaves no copy.
 */
export const READ = script(`resolve "$1" 1 || exit $?
present "$p" || exit ${E.notFound}
[ -d "$p" ] && exit ${E.isDirectory}
[ -f "$p" ] || exit ${E.notRegular}
s=$(stat -c %s -- "$p") || exit 1
[ "$s" -le "$2" ] || { printf '%s' "$s"; exit ${E.tooLarge}; }
t="\${TMPDIR:-/tmp}/$3"
ok=0
trap '[ "$ok" = 1 ] || rm -f -- "$t"' EXIT
(umask 077; set -C; head -c "$(($2 + 1))" -- "$p" > "$t") || exit 1
s=$(stat -c %s -- "$t") || exit 1
[ "$s" -le "$2" ] || { printf '%s' "$s"; exit ${E.tooLarge}; }
ok=1
printf '%s' "$t"`);

/** Removes files of the temporary directory the workspace named for one operation, nothing else. */
export const DISCARD = script(`for name in "$@"; do
  case $name in
    */*|'') ;;
    cogitator-read-*|cogitator-upload-*|cogitator-list-*) rm -f -- "$T/$name" ;;
  esac
done
exit 0`);

/**
 * `$1` path, `$2` the name of the upload in the temporary directory, `$3` create parents (1/0),
 * `$4` force (1/0), `$5` the size uploaded, `$6` a fresh token: copies the upload to a new file
 * next to the target and moves that over it, keeping the mode of the file it replaces. Nothing
 * is written through the workspace's own directories, and the upload and the copy are removed
 * whatever happens.
 */
export const COMMIT_WRITE = script(`temp "$2"; t=$f
w=
trap 'rm -f -- "$t"; [ -z "$w" ] || rm -f -- "$w"' EXIT
{ [ -f "$t" ] && [ ! -L "$t" ]; } || exit ${E.uploadChanged}
[ "$(stat -c %s -- "$t" 2>/dev/null)" = "$5" ] || exit ${E.uploadChanged}
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
fi
w="$d/.cogitator-tmp-$6"
(set -C; cat -- "$t" > "$w") || exit 1
[ "$(stat -c %s -- "$w")" = "$5" ] || exit ${E.uploadChanged}
present "$p" && chmod --reference="$p" -- "$w" 2>/dev/null
case $rel in .cogitator/*) gitignore ;; esac
mv -f -T -- "$w" "$p" || exit 1
w=`);

/**
 * `$1` directory, `$2` how many entries at most (empty for all), `$3` the most bytes to print,
 * `$4` `sorted` or `raw`, then the \`find\` expression that prints its entries. Prints the
 * directory relative to the root and a NUL, then the entries. \`sorted\` entries are
 * `path SOH type SOH size SOH mtime SOH depth NUL`, sorted in tree order (\`/\` turned into STX
 * sorts before every other byte) and cut at the limit, so a big tree is never shipped whole.
 * \`raw\` entries are `type NUL size NUL mtime NUL depth NUL path NUL`, unsorted and hex-encoded,
 * for names holding SOH or STX. The output stops one byte past `$3`. Entries \`find\` cannot
 * read are left out.
 */
export const LIST = script(`resolve "$1" 1 || exit $?
present "$p" || exit ${E.notFound}
[ -d "$p" ] || exit ${E.notADirectory}
n=$2; cap=$(($3 + 1)); mode=$4; shift 4
printf '%s\\0' "$rel"
if [ "$mode" = raw ]; then
  find "$p" -mindepth 1 "$@" 2>/dev/null | head -c "$cap" | od -An -v -tx1 | tr -d ' \\n'
elif [ -n "$n" ]; then
  find "$p" -mindepth 1 "$@" 2>/dev/null | tr '/' '\\002' | LC_ALL=C sort -z | head -z -n "$n" | head -c "$cap"
else
  find "$p" -mindepth 1 "$@" 2>/dev/null | tr '/' '\\002' | LC_ALL=C sort -z | head -c "$cap"
fi
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
 * or environment the command can read. `$1` is the deadline in milliseconds since the epoch,
 * past which the command is not run (a provider that started it that late was given up on), `$2`
 * the root, `$3` the directory and `$4` the command.
 */
export const EXEC_WRAPPER = `IFS= read -r t || exit 125
[ "$(( $(date +%s%N) / 1000000 ))" -le "$1" ] || exit 125
shift
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

/**
 * `$1` signal name, then process group ids: signals every group that still leads its session,
 * skipping the gone ones and ids the system gave to another process since.
 */
export const SIGNAL_GROUPS = `${GROUPS}s=$1; shift
leaders "$@"
for g in "$@"; do
  case $L in *" $g "*) kill -s "$s" -- "-$g" 2>/dev/null ;; esac
done
exit 0`;

/**
 * `$1` the most bytes to print, then the \`find\` tests (`-o -path ./dir`, `-o -name dir`) of the
 * directories to leave out with everything in them: prints type, size, mode (octal) and path
 * (relative to the root) of everything else in the root, NUL-separated and hex-encoded, so names that are not
 * UTF-8 arrive as they are, and each directory left out (`.cogitator` always) with the type `X`,
 * without what it holds. The output stops one byte past `$1`.
 */
export const SNAPSHOT_TREE = script(`cd -- "$root" || exit 1
cap=$(($1 + 1)); shift
find . -mindepth 1 \\( -path ./.cogitator "$@" \\) -prune -printf 'X\\0%s\\0%m\\0%P\\0' -o -printf '%y\\0%s\\0%m\\0%P\\0' 2>/dev/null | head -c "$cap" | od -An -v -tx1 | tr -d ' \\n'
exit 0`);

/**
 * `$1` snapshot id, `$2` its record (JSON), `$3`, `$4` and `$5` the names of the uploaded lists
 * of paths, of directories and of the modes of the directories: keeps the lists, archives the paths listed, then writes the record,
 * which marks the snapshot complete. Files that vanish meanwhile are skipped, and a snapshot that
 * fails leaves nothing behind.
 */
export const SNAPSHOT_CREATE = script(`id=$1
temp "$3"; l=$f
temp "$4"; dl=$f
temp "$5"; ml=$f
trap 'rm -f -- "$l" "$dl" "$ml"' EXIT
servicedir snapshots 1
cd -- "$root/.cogitator/snapshots" || exit 1
trap 'rm -f -- "$l" "$dl" "$ml" "$id.tar.part" "$id.json.part"; [ -f "$id.json" ] || rm -f -- "$id.list" "$id.dirs" "$id.modes" "$id.tar"' EXIT
cat -- "$l" > "$id.list" && cat -- "$dl" > "$id.dirs" && cat -- "$ml" > "$id.modes" || exit 1
tar -C "$root" --null --no-recursion --ignore-failed-read -T "$id.list" -cf "$id.tar.part" 2>/dev/null
c=$?
{ [ "$c" -le 1 ] && [ -s "$id.tar.part" ]; } || exit 1
mv -f -- "$id.tar.part" "$id.tar" || exit 1
printf '%s' "$2" > "$id.json.part" && mv -f -- "$id.json.part" "$id.json" || exit 1`);

/** `$1` snapshot id: removes what an unfinished snapshot left. */
export const SNAPSHOT_DISCARD = script(`servicedir snapshots 0 || exit 0
cd -- "$root/.cogitator/snapshots" || exit 0
[ -f "$1.json" ] || rm -f -- "$1.list" "$1.dirs" "$1.modes" "$1.tar" "$1.tar.part"
exit 0`);

/**
 * `$1` snapshot id, `$2` `list`, `dirs` or `modes`, `$3` the most bytes to print: prints that
 * list of the snapshot hex-encoded (a snapshot taken before modes were kept has no `modes`).
 */
export const SNAPSHOT_SAVED = script(`servicedir snapshots 0 || exit ${E.notFound}
f="$root/.cogitator/snapshots/$1.$2"
[ -f "$f" ] || exit ${E.notFound}
head -c "$(($3 + 1))" -- "$f" | od -An -v -tx1 | tr -d ' \\n'`);

/** `$1` the most bytes to print: prints the records of the snapshots, each followed by a NUL. */
export const SNAPSHOT_RECORDS = script(`servicedir snapshots 0 || exit 0
cap=$(($1 + 1))
for f in "$root"/.cogitator/snapshots/*.json; do
  [ -f "$f" ] || continue
  cat -- "$f" && printf '\\0'
done | head -c "$cap"
exit 0`);

/**
 * `$1` snapshot id, `$2` and `$3` the names of the uploaded lists of files and of directories
 * (deepest first) to remove first: removes them, then extracts the snapshot over the root.
 */
export const SNAPSHOT_RESTORE = script(`temp "$2"; a=$f
temp "$3"; b=$f
trap 'rm -f -- "$a" "$b"' EXIT
servicedir snapshots 0 || exit ${E.notFound}
cd -- "$root" || exit 1
[ -f ".cogitator/snapshots/$1.tar" ] || exit ${E.notFound}
xargs -0 -r rm -f -- < "$a" || exit 1
xargs -0 -r rmdir --ignore-fail-on-non-empty -- < "$b" 2>/dev/null
tar -xpf ".cogitator/snapshots/$1.tar" || exit 1`);

/** `$1` snapshot id: forgets the snapshot. */
export const SNAPSHOT_DELETE = script(`servicedir snapshots 0 || exit ${E.notFound}
cd -- "$root/.cogitator/snapshots" || exit ${E.notFound}
[ -f "$1.json" ] || exit ${E.notFound}
rm -f -- "$1.json" "$1.tar" "$1.list" "$1.dirs" "$1.modes"`);
