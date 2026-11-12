import { posix } from 'path';
import { Readable, Writable } from 'stream';
import * as vscode from 'vscode';
import { Client, FileInfo, FTPError } from 'basic-ftp';
import { RemoteConfig } from '../config';
import { RemoteClient, RemoteError, RemoteStat } from './types';

const LIST_CACHE_TTL = 3000;

function toRemoteError(err: unknown, path: string): RemoteError {
  if (err instanceof RemoteError) {
    return err;
  }
  const msg = `${(err as Error)?.message ?? String(err)} (${path})`;
  if (err instanceof FTPError) {
    if (/permission|denied|not allowed/i.test(err.message)) {
      return new RemoteError('permission', msg);
    }
    if (err.code === 550 || err.code === 450) {
      return new RemoteError(/exist/i.test(err.message) && !/not exist|no such/i.test(err.message) ? 'exists' : 'notFound', msg);
    }
  }
  return new RemoteError('other', msg);
}

function entryType(info: FileInfo): vscode.FileType {
  if (info.isDirectory) {
    return vscode.FileType.Directory;
  }
  if (info.isSymbolicLink) {
    return vscode.FileType.SymbolicLink;
  }
  return vscode.FileType.File;
}

/**
 * FTP / FTPS client. basic-ftp allows only one command at a time per control connection,
 * so every operation goes through a serial queue.
 */
export class FtpClient implements RemoteClient {
  readonly protocol = 'ftp' as const;
  private client?: Client;
  private queue: Promise<unknown> = Promise.resolve();
  private listCache = new Map<string, { time: number; entries: FileInfo[] }>();
  /** Symlink paths already resolved to a directory/file. */
  private linkCache = new Map<string, vscode.FileType>();

  constructor(private readonly cfg: RemoteConfig, private readonly log: (msg: string) => void) {}

  isConnected(): boolean {
    return !!this.client && !this.client.closed;
  }

  async connect(): Promise<void> {
    const cfg = this.cfg;
    const client = new Client(cfg.connectTimeout ?? 20000);
    if (cfg.encoding) {
      client.ftp.encoding = cfg.encoding as typeof client.ftp.encoding;
    }
    const port = cfg.port ?? (cfg.secure === 'implicit' ? 990 : 21);
    try {
      await client.access({
        host: cfg.host,
        port,
        user: cfg.username || 'anonymous',
        password: cfg.password ?? (cfg.username ? '' : 'anonymous@'),
        secure: cfg.secure ?? false,
        secureOptions: cfg.allowUnauthorizedCert ? { rejectUnauthorized: false } : undefined,
      });
    } catch (e) {
      client.close();
      throw e;
    }
    this.client = client;
    this.listCache.clear();
    this.log(`[${cfg.name}] FTP${cfg.secure ? 'S' : ''} connected to ${cfg.host}:${port}`);
  }

  private run<T>(path: string, fn: (c: Client) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      if (!this.isConnected()) {
        this.log(`[${this.cfg.name}] reconnecting...`);
        await this.connect();
      }
      try {
        return await fn(this.client!);
      } catch (e) {
        throw toRemoteError(e, path);
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  private invalidate(path: string): void {
    this.listCache.delete(posix.dirname(path));
    this.listCache.delete(path);
    for (const key of [...this.listCache.keys(), ...this.linkCache.keys()]) {
      if (key.startsWith(path + '/')) {
        this.listCache.delete(key);
        this.linkCache.delete(key);
      }
    }
    this.linkCache.delete(path);
  }

  private async list(c: Client, dir: string, useCache: boolean): Promise<FileInfo[]> {
    const cached = this.listCache.get(dir);
    if (useCache && cached && Date.now() - cached.time < LIST_CACHE_TTL) {
      return cached.entries;
    }
    const entries = (await c.list(dir)).filter((e) => e.name !== '.' && e.name !== '..');
    this.listCache.set(dir, { time: Date.now(), entries });
    return entries;
  }

  /** Determines whether a symlink points at a directory by trying to cd into it. */
  private async resolveLink(c: Client, path: string): Promise<vscode.FileType> {
    let t = this.linkCache.get(path);
    if (t === undefined) {
      try {
        await c.cd(path);
        t = vscode.FileType.SymbolicLink | vscode.FileType.Directory;
      } catch {
        t = vscode.FileType.SymbolicLink | vscode.FileType.File;
      }
      this.linkCache.set(path, t);
    }
    return t;
  }

  stat(path: string): Promise<RemoteStat> {
    if (path === '/') {
      return Promise.resolve({ type: vscode.FileType.Directory, size: 0, mtime: 0, ctime: 0 });
    }
    return this.run(path, async (c) => {
      const entries = await this.list(c, posix.dirname(path), true);
      const name = posix.basename(path);
      const info = entries.find((e) => e.name === name);
      if (!info) {
        throw new RemoteError('notFound', `No such file: ${path}`);
      }
      let type = entryType(info);
      if (type === vscode.FileType.SymbolicLink) {
        type = await this.resolveLink(c, path);
      }
      const mtime = info.modifiedAt?.getTime() ?? 0;
      return { type, size: info.size, mtime, ctime: mtime };
    });
  }

  readDirectory(path: string): Promise<[string, vscode.FileType][]> {
    return this.run(path, async (c) => {
      const entries = await this.list(c, path, false);
      const result: [string, vscode.FileType][] = [];
      for (const e of entries) {
        let t = entryType(e);
        if (t === vscode.FileType.SymbolicLink) {
          t = await this.resolveLink(c, posix.join(path, e.name));
        }
        result.push([e.name, t]);
      }
      return result;
    });
  }

  readFile(path: string): Promise<Uint8Array> {
    return this.run(path, async (c) => {
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk: Buffer, _enc, cb) {
          chunks.push(chunk);
          cb();
        },
      });
      await c.downloadTo(sink, path);
      return Buffer.concat(chunks);
    });
  }

  writeFile(path: string, data: Uint8Array): Promise<void> {
    this.invalidate(path);
    return this.run(path, async (c) => {
      await c.uploadFrom(Readable.from([Buffer.from(data)]), path);
      this.invalidate(path);
    });
  }

  createDirectory(path: string): Promise<void> {
    return this.run(path, async (c) => {
      await c.send(`MKD ${path}`);
      this.invalidate(path);
    });
  }

  delete(path: string, recursive: boolean): Promise<void> {
    return this.stat(path).then((st) =>
      this.run(path, async (c) => {
        const isDir = (st.type & vscode.FileType.Directory) !== 0 && (st.type & vscode.FileType.SymbolicLink) === 0;
        if (!isDir) {
          await c.remove(path);
        } else if (recursive) {
          await c.removeDir(path);
        } else {
          await c.send(`RMD ${path}`);
        }
        this.invalidate(path);
      }),
    );
  }

  rename(from: string, to: string): Promise<void> {
    return this.run(from, async (c) => {
      await c.rename(from, to);
      this.invalidate(from);
      this.invalidate(to);
    });
  }

  async dispose(): Promise<void> {
    this.client?.close();
    this.client = undefined;
  }
}
