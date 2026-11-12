import * as fs from 'fs';
import * as os from 'os';
import { posix } from 'path';
import * as vscode from 'vscode';
import { Client, ConnectConfig, SFTPWrapper, Stats } from 'ssh2';
import { RemoteConfig } from '../config';
import { RemoteClient, RemoteError, RemoteStat } from './types';

// SFTP status codes (draft-ietf-secsh-filexfer)
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;

function expandHome(p: string): string {
  return p.startsWith('~') ? posix.join(os.homedir().replace(/\\/g, '/'), p.slice(1)) : p;
}

function defaultAgent(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) {
    return process.env.SSH_AUTH_SOCK;
  }
  return process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined;
}

function toRemoteError(err: unknown, path: string): RemoteError {
  if (err instanceof RemoteError) {
    return err;
  }
  const e = err as { code?: number | string; message?: string };
  const msg = `${e?.message ?? String(err)} (${path})`;
  if (e?.code === NO_SUCH_FILE) {
    return new RemoteError('notFound', msg);
  }
  if (e?.code === PERMISSION_DENIED) {
    return new RemoteError('permission', msg);
  }
  return new RemoteError('other', msg);
}

function fileType(s: Stats): vscode.FileType {
  if (s.isDirectory()) {
    return vscode.FileType.Directory;
  }
  if (s.isFile()) {
    return vscode.FileType.File;
  }
  if (s.isSymbolicLink()) {
    return vscode.FileType.SymbolicLink;
  }
  return vscode.FileType.Unknown;
}

export class SftpClient implements RemoteClient {
  readonly protocol = 'sftp' as const;
  private conn?: Client;
  private sftp?: SFTPWrapper;
  private connected = false;

  constructor(private readonly cfg: RemoteConfig, private readonly log: (msg: string) => void) {}

  isConnected(): boolean {
    return this.connected && !!this.sftp;
  }

  connect(): Promise<void> {
    const cfg = this.cfg;
    const opts: ConnectConfig = {
      host: cfg.host,
      port: cfg.port ?? 22,
      username: cfg.username,
      readyTimeout: cfg.connectTimeout ?? 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      tryKeyboard: true,
    };
    if (cfg.password) {
      opts.password = cfg.password;
    }
    if (cfg.privateKeyPath) {
      opts.privateKey = fs.readFileSync(expandHome(cfg.privateKeyPath));
      if (cfg.passphrase) {
        opts.passphrase = cfg.passphrase;
      }
    }
    if (cfg.agent) {
      opts.agent = cfg.agent === true ? defaultAgent() : cfg.agent;
    }

    return new Promise((resolve, reject) => {
      const conn = new Client();
      this.conn = conn;
      conn.on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => {
        finish(prompts.map(() => cfg.password ?? ''));
      });
      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }
          this.sftp = sftp;
          this.connected = true;
          this.log(`[${cfg.name}] SFTP connected to ${cfg.host}:${opts.port}`);
          resolve();
        });
      });
      conn.on('error', (err) => {
        this.log(`[${cfg.name}] SSH error: ${err.message}`);
        if (!this.connected) {
          reject(err);
        }
      });
      conn.on('close', () => {
        if (this.connected) {
          this.log(`[${cfg.name}] SFTP connection closed`);
        }
        this.connected = false;
        this.sftp = undefined;
      });
      conn.connect(opts);
    });
  }

  private get s(): SFTPWrapper {
    if (!this.sftp) {
      throw new RemoteError('other', 'SFTP session is not connected');
    }
    return this.sftp;
  }

  private call<T>(path: string, fn: (cb: (err: Error | null | undefined, res?: T) => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      try {
        fn((err, res) => (err ? reject(toRemoteError(err, path)) : resolve(res as T)));
      } catch (e) {
        reject(toRemoteError(e, path));
      }
    });
  }

  private lstatRaw(path: string): Promise<Stats> {
    return this.call<Stats>(path, (cb) => this.s.lstat(path, cb));
  }

  private statRaw(path: string): Promise<Stats> {
    return this.call<Stats>(path, (cb) => this.s.stat(path, cb));
  }

  /** Resolves a symlink target's type; broken links report as plain SymbolicLink. */
  private async linkType(path: string): Promise<vscode.FileType> {
    try {
      return vscode.FileType.SymbolicLink | fileType(await this.statRaw(path));
    } catch {
      return vscode.FileType.SymbolicLink;
    }
  }

  async stat(path: string): Promise<RemoteStat> {
    const l = await this.lstatRaw(path);
    let type = fileType(l);
    let s = l;
    if (l.isSymbolicLink()) {
      try {
        s = await this.statRaw(path);
        type = vscode.FileType.SymbolicLink | fileType(s);
      } catch {
        // broken link
      }
    }
    return { type, size: s.size, mtime: s.mtime * 1000, ctime: s.mtime * 1000 };
  }

  async readDirectory(path: string): Promise<[string, vscode.FileType][]> {
    const list = await this.call<{ filename: string; attrs: Stats }[]>(path, (cb) => this.s.readdir(path, cb as never));
    return Promise.all(
      list
        .filter((e) => e.filename !== '.' && e.filename !== '..')
        .map(async (e): Promise<[string, vscode.FileType]> => {
          const t = fileType(e.attrs);
          if (t === vscode.FileType.SymbolicLink) {
            return [e.filename, await this.linkType(posix.join(path, e.filename))];
          }
          return [e.filename, t];
        }),
    );
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.call<Buffer>(path, (cb) => this.s.readFile(path, cb));
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    await this.call<void>(path, (cb) => this.s.writeFile(path, Buffer.from(data), cb));
  }

  async createDirectory(path: string): Promise<void> {
    await this.call<void>(path, (cb) => this.s.mkdir(path, cb));
  }

  async delete(path: string, recursive: boolean): Promise<void> {
    const l = await this.lstatRaw(path);
    if (!l.isDirectory()) {
      await this.call<void>(path, (cb) => this.s.unlink(path, cb));
      return;
    }
    if (recursive) {
      const list = await this.call<{ filename: string }[]>(path, (cb) => this.s.readdir(path, cb as never));
      for (const e of list) {
        if (e.filename !== '.' && e.filename !== '..') {
          await this.delete(posix.join(path, e.filename), true);
        }
      }
    }
    await this.call<void>(path, (cb) => this.s.rmdir(path, cb));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.call<void>(from, (cb) => this.s.rename(from, to, cb));
  }

  async dispose(): Promise<void> {
    this.connected = false;
    this.sftp = undefined;
    this.conn?.end();
    this.conn = undefined;
  }
}
