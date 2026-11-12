import { posix } from 'path';
import * as vscode from 'vscode';
import { RemoteClient, RemoteError } from './clients/types';
import { findRemote } from './config';
import { ConnectionManager } from './connectionManager';

function toFsError(err: unknown, uri: vscode.Uri): Error {
  if (err instanceof vscode.FileSystemError) {
    return err;
  }
  if (err instanceof RemoteError) {
    switch (err.kind) {
      case 'notFound':
        return vscode.FileSystemError.FileNotFound(uri);
      case 'exists':
        return vscode.FileSystemError.FileExists(uri);
      case 'permission':
        return vscode.FileSystemError.NoPermissions(uri);
      case 'notADirectory':
        return vscode.FileSystemError.FileNotADirectory(uri);
    }
  }
  return vscode.FileSystemError.Unavailable(`${(err as Error)?.message ?? String(err)}`);
}

function isNotFound(err: unknown): boolean {
  return err instanceof RemoteError && err.kind === 'notFound';
}

export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(private readonly connections: ConnectionManager) {}

  watch(): vscode.Disposable {
    // Remote servers offer no change notifications; changes made through this provider are fired below.
    return new vscode.Disposable(() => undefined);
  }

  private remotePath(uri: vscode.Uri): string {
    const cfg = findRemote(uri.authority);
    const root = cfg?.rootPath || '/';
    return posix.join(root.startsWith('/') ? root : '/' + root, uri.path || '/');
  }

  private async op<T>(uri: vscode.Uri, fn: (client: RemoteClient, path: string) => Promise<T>): Promise<T> {
    try {
      const client = await this.connections.get(uri.authority);
      return await fn(client, this.remotePath(uri));
    } catch (e) {
      throw toFsError(e, uri);
    }
  }

  private fire(...events: vscode.FileChangeEvent[]): void {
    this.emitter.fire(events);
  }

  private parent(uri: vscode.Uri): vscode.Uri {
    return uri.with({ path: posix.dirname(uri.path) });
  }

  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.op(uri, (c, p) => c.stat(p));
  }

  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.op(uri, (c, p) => c.readDirectory(p));
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.op(uri, (c, p) => c.readFile(p));
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const created = await this.op(uri, async (c, p) => {
      let exists = true;
      try {
        const st = await c.stat(p);
        if (st.type & vscode.FileType.Directory) {
          throw vscode.FileSystemError.FileIsADirectory(uri);
        }
      } catch (e) {
        if (!isNotFound(e)) {
          throw e;
        }
        exists = false;
      }
      if (!exists && !options.create) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      if (exists && options.create && !options.overwrite) {
        throw vscode.FileSystemError.FileExists(uri);
      }
      await c.writeFile(p, content);
      return !exists;
    });
    if (created) {
      this.fire({ type: vscode.FileChangeType.Changed, uri: this.parent(uri) }, { type: vscode.FileChangeType.Created, uri });
    } else {
      this.fire({ type: vscode.FileChangeType.Changed, uri });
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    await this.op(uri, (c, p) => c.createDirectory(p));
    this.fire({ type: vscode.FileChangeType.Changed, uri: this.parent(uri) }, { type: vscode.FileChangeType.Created, uri });
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    await this.op(uri, (c, p) => c.delete(p, options.recursive));
    this.fire({ type: vscode.FileChangeType.Changed, uri: this.parent(uri) }, { type: vscode.FileChangeType.Deleted, uri });
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    if (oldUri.authority.toLowerCase() !== newUri.authority.toLowerCase()) {
      throw vscode.FileSystemError.NoPermissions('Cannot move files between different remotes');
    }
    const to = this.remotePath(newUri);
    await this.op(oldUri, async (c, from) => {
      let targetExists = true;
      try {
        await c.stat(to);
      } catch (e) {
        if (!isNotFound(e)) {
          throw e;
        }
        targetExists = false;
      }
      if (targetExists) {
        if (!options.overwrite) {
          throw vscode.FileSystemError.FileExists(newUri);
        }
        await c.delete(to, true);
      }
      await c.rename(from, to);
    });
    this.fire(
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
      { type: vscode.FileChangeType.Changed, uri: this.parent(oldUri) },
      { type: vscode.FileChangeType.Changed, uri: this.parent(newUri) },
    );
  }
}
