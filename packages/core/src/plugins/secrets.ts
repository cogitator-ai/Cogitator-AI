/**
 * Secrets of plugin options in the operating system's credential store, through the tools the
 * system already has: `security` on macOS (the login keychain), `secret-tool` on Linux (the Secret
 * Service of GNOME Keyring or KWallet) and PowerShell with the Credential Manager API on Windows.
 * A secret never goes on a command line, it is written to the tool's standard input. Without such
 * a tool a secret cannot be kept, and the error says so: there is no fallback to a plain file
 */

import { spawn } from 'node:child_process';
import { CogitatorError, ErrorCode, type PluginSecretStore } from '@cogitator-ai/types';

/** How a store command ended */
export interface SecretCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a credential tool: `input` written to its standard input */
export type SecretCommandRunner = (
  file: string,
  args: readonly string[],
  input: string
) => Promise<SecretCommandResult>;

/** Options of `experimental_keychainSecretStore`, for other platforms and tests */
export interface KeychainSecretStoreOptions {
  /** The platform whose store is used (default this process's) */
  platform?: NodeJS.Platform;
  /** Runs the credential tool (default a child process) */
  run?: SecretCommandRunner;
  /** A label the stored items are shown with (default `Cogitator plugin option`) */
  label?: string;
}

/** Secrets are stored base64 encoded behind this prefix, so any text survives every tool */
const ENCODED = 'b64:';

const NOT_FOUND_MACOS = 44;

/** Most bytes of output read from a credential tool */
const MAX_OUTPUT = 1024 * 1024;

const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CogitatorCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWriteW(ref CREDENTIAL credential, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr buffer);
}
'@
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.op -eq 'get') {
  $pointer = [IntPtr]::Zero
  if (-not [CogitatorCred]::CredReadW($request.target, 1, 0, [ref]$pointer)) {
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 3 }
    exit 2
  }
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][CogitatorCred+CREDENTIAL])
  $bytes = New-Object byte[] $credential.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $credential.CredentialBlobSize)
  [CogitatorCred]::CredFree($pointer)
  [Console]::Out.Write([Text.Encoding]::Unicode.GetString($bytes))
  exit 0
}
if ($request.op -eq 'set') {
  $bytes = [Text.Encoding]::Unicode.GetBytes($request.secret)
  $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
  $credential = New-Object CogitatorCred+CREDENTIAL
  $credential.Type = 1
  $credential.TargetName = $request.target
  $credential.UserName = $request.account
  $credential.Comment = $request.label
  $credential.CredentialBlobSize = $bytes.Length
  $credential.CredentialBlob = $blob
  $credential.Persist = 2
  $written = [CogitatorCred]::CredWriteW([ref]$credential, 0)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
  if (-not $written) { exit 2 }
  exit 0
}
if ($request.op -eq 'delete') {
  if (-not [CogitatorCred]::CredDeleteW($request.target, 1, 0)) {
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 0 }
    exit 2
  }
  exit 0
}
exit 2
`;

function unavailable(reason: string): CogitatorError {
  return new CogitatorError({
    message: `No credential store to keep plugin secrets in: ${reason}. Install the system's credential tool, or pass experimental_plugins.secrets with a store of your own. Secrets are never written to a plain file`,
    code: ErrorCode.SECRET_STORE_UNAVAILABLE,
  });
}

function failed(action: string, result: SecretCommandResult): CogitatorError {
  const detail = result.stderr.trim().split('\n')[0] ?? '';
  return new CogitatorError({
    message: `The credential store could not ${action} the secret${detail ? `: ${detail}` : ''} (exit code ${String(result.code)})`,
    code: ErrorCode.SECRET_STORE_UNAVAILABLE,
  });
}

function encode(secret: string): string {
  return ENCODED + Buffer.from(secret, 'utf8').toString('base64');
}

function decode(stored: string): string {
  return stored.startsWith(ENCODED)
    ? Buffer.from(stored.slice(ENCODED.length), 'base64').toString('utf8')
    : stored;
}

/** A word of a `security -i` command line, quoted */
function quoted(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Runs `file` with `input` on its standard input, without a shell */
export const runSecretCommand: SecretCommandRunner = (file, args, input) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(file, [...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * The operating system's credential store as a `PluginSecretStore`: the default where plugin
 * options marked `sensitive` are kept. Each secret is an item of `service` and `account`
 * (`cogitator-plugin:<plugin id>` and the option's key). A call on a system without its credential
 * tool, or one the tool refuses, fails with `SECRET_STORE_UNAVAILABLE`
 */
export function experimental_keychainSecretStore(
  options: KeychainSecretStoreOptions = {}
): PluginSecretStore {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runSecretCommand;
  const label = options.label ?? 'Cogitator plugin option';
  const call = async (
    file: string,
    args: readonly string[],
    input: string
  ): Promise<SecretCommandResult> => {
    try {
      return await run(file, args, input);
    } catch (error) {
      if (isMissing(error)) throw unavailable(`${file} is not installed`);
      throw unavailable(error instanceof Error ? error.message : String(error));
    }
  };

  if (platform === 'darwin') {
    const get = async (service: string, account: string): Promise<string | undefined> => {
      const result = await call(
        'security',
        ['find-generic-password', '-s', service, '-a', account, '-w'],
        ''
      );
      if (result.code === NOT_FOUND_MACOS) return undefined;
      if (result.code !== 0) throw failed('read', result);
      return decode(result.stdout.replace(/\n$/, ''));
    };
    return {
      get,
      async set(service, account, secret) {
        const line = `add-generic-password -U -s ${quoted(service)} -a ${quoted(account)} -l ${quoted(label)} -w ${quoted(encode(secret))}\n`;
        const result = await call('security', ['-i'], line);
        if (result.code !== 0) throw failed('save', result);
        if ((await get(service, account)) !== secret) throw failed('save', result);
      },
      async delete(service, account) {
        const result = await call(
          'security',
          ['delete-generic-password', '-s', service, '-a', account],
          ''
        );
        if (result.code !== 0 && result.code !== NOT_FOUND_MACOS) throw failed('delete', result);
      },
    };
  }

  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    return {
      async get(service, account) {
        const result = await call(
          'secret-tool',
          ['lookup', 'service', service, 'account', account],
          ''
        );
        if (result.code === 1 && result.stdout === '') return undefined;
        if (result.code !== 0) throw failed('read', result);
        return decode(result.stdout.replace(/\n$/, ''));
      },
      async set(service, account, secret) {
        const result = await call(
          'secret-tool',
          ['store', `--label=${label}`, 'service', service, 'account', account],
          encode(secret)
        );
        if (result.code !== 0) throw failed('save', result);
      },
      async delete(service, account) {
        const result = await call(
          'secret-tool',
          ['clear', 'service', service, 'account', account],
          ''
        );
        if (result.code !== 0 && result.code !== 1) throw failed('delete', result);
      },
    };
  }

  if (platform === 'win32') {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64'),
    ];
    const request = (body: Record<string, string>) => JSON.stringify(body);
    return {
      async get(service, account) {
        const result = await call(
          'powershell.exe',
          args,
          request({ op: 'get', target: `${service}:${account}` })
        );
        if (result.code === 3) return undefined;
        if (result.code !== 0) throw failed('read', result);
        return decode(result.stdout);
      },
      async set(service, account, secret) {
        const result = await call(
          'powershell.exe',
          args,
          request({
            op: 'set',
            target: `${service}:${account}`,
            account,
            label,
            secret: encode(secret),
          })
        );
        if (result.code !== 0) throw failed('save', result);
      },
      async delete(service, account) {
        const result = await call(
          'powershell.exe',
          args,
          request({ op: 'delete', target: `${service}:${account}` })
        );
        if (result.code !== 0) throw failed('delete', result);
      },
    };
  }

  const refuse = async (): Promise<never> => {
    throw unavailable(`the platform ${platform} has no supported credential store`);
  };
  return { get: refuse, set: refuse, delete: refuse };
}

/**
 * A store that keeps secrets in this process's memory only, gone when it exits: for tests and for
 * hosts that pass option secrets in from their own vault on every start
 */
export function experimental_memorySecretStore(
  initial: Readonly<Record<string, Readonly<Record<string, string>>>> = {}
): PluginSecretStore {
  const items = new Map<string, string>();
  for (const [service, accounts] of Object.entries(initial)) {
    for (const [account, secret] of Object.entries(accounts)) {
      items.set(`${service}\n${account}`, secret);
    }
  }
  return {
    get: async (service, account) => items.get(`${service}\n${account}`),
    set: async (service, account, secret) => {
      items.set(`${service}\n${account}`, secret);
    },
    delete: async (service, account) => {
      items.delete(`${service}\n${account}`);
    },
  };
}

/** The service a plugin's secrets are kept under */
export function secretServiceOf(pluginId: string): string {
  return `cogitator-plugin:${pluginId}`;
}
