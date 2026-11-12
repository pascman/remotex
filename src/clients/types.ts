import * as vscode from 'vscode';

export interface RemoteStat {
  type: vscode.FileType;
  size: number;
  mtime: number;
  ctime: number;
}

export type RemoteErrorKind = 'notFound' | 'exists' | 'permission' | 'notADirectory' | 'other';

export class RemoteError extends Error {
  constructor(public readonly kind: RemoteErrorKind, message: string) {
    super(message);
  }
}

/** Minimal file-system operations every protocol implementation provides. Paths are absolute POSIX paths. */
export interface RemoteClient {
  readonly protocol: 'sftp' | 'ftp';
  isConnected(): boolean;
  connect(): Promise<void>;
  stat(path: string): Promise<RemoteStat>;
  readDirectory(path: string): Promise<[string, vscode.FileType][]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  createDirectory(path: string): Promise<void>;
  delete(path: string, recursive: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  dispose(): Promise<void>;
}
