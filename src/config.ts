import * as vscode from 'vscode';

export const SCHEME = 'remotex';
const SECTION = 'remotex';

export type Protocol = 'sftp' | 'ftp';

export interface RemoteSettings {
  protocol: Protocol;
  host: string;
  port?: number;
  username?: string;
  password?: string;
  rootPath?: string;
  privateKeyPath?: string;
  passphrase?: string;
  agent?: boolean | string;
  secure?: boolean | 'implicit';
  allowUnauthorizedCert?: boolean;
  encoding?: string;
  connectTimeout?: number;
}

export interface RemoteConfig extends RemoteSettings {
  name: string;
}

export function getRemotes(): RemoteConfig[] {
  const raw = vscode.workspace.getConfiguration(SECTION).get<Record<string, RemoteSettings>>('remotes', {});
  return Object.entries(raw ?? {})
    .filter(([, v]) => v && typeof v === 'object' && v.host)
    .map(([name, v]) => ({ ...v, name, protocol: v.protocol === 'ftp' ? 'ftp' : 'sftp' }));
}

export function findRemote(name: string): RemoteConfig | undefined {
  const remotes = getRemotes();
  return remotes.find((r) => r.name === name) ?? remotes.find((r) => r.name.toLowerCase() === name.toLowerCase());
}

export function rememberPasswords(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>('rememberPasswords', true);
}

/** Saves a remote into the user (global) settings. */
export async function saveRemote(name: string, settings: RemoteSettings): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  const current = config.inspect<Record<string, RemoteSettings>>('remotes')?.globalValue ?? {};
  await config.update('remotes', { ...current, [name]: settings }, vscode.ConfigurationTarget.Global);
}

export function remoteUri(name: string, path = '/'): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, authority: name, path });
}

export function describe(r: RemoteConfig): string {
  const proto = r.protocol === 'ftp' ? (r.secure ? 'ftps' : 'ftp') : 'sftp';
  const user = r.username ? `${r.username}@` : '';
  const port = r.port ? `:${r.port}` : '';
  return `${proto}://${user}${r.host}${port}${r.rootPath ?? '/'}`;
}
