import * as vscode from 'vscode';
import { FtpClient } from './clients/ftpClient';
import { SftpClient } from './clients/sftpClient';
import { RemoteClient } from './clients/types';
import { findRemote, RemoteConfig, rememberPasswords } from './config';

const secretKey = (name: string) => `remotex.password:${name}`;

export class ConnectionManager implements vscode.Disposable {
  private clients = new Map<string, Promise<RemoteClient>>();

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: (msg: string) => void,
  ) {}

  /** Returns a connected client for the remote, connecting (and prompting for a password) if needed. */
  async get(name: string): Promise<RemoteClient> {
    const key = name.toLowerCase();
    const existing = this.clients.get(key);
    if (existing) {
      try {
        const c = await existing;
        // FTP reconnects on its own inside its queue; SFTP needs a fresh session.
        if (c.isConnected() || c.protocol === 'ftp') {
          return c;
        }
      } catch {
        // fall through and retry
      }
      if (this.clients.get(key) === existing) {
        this.clients.delete(key);
      } else {
        return this.get(name);
      }
    }
    const created = this.create(name);
    this.clients.set(key, created);
    created.catch(() => {
      if (this.clients.get(key) === created) {
        this.clients.delete(key);
      }
    });
    return created;
  }

  isOpen(name: string): boolean {
    return this.clients.has(name.toLowerCase());
  }

  private needsPassword(cfg: RemoteConfig): boolean {
    if (cfg.protocol === 'ftp') {
      return !!cfg.username && cfg.username !== 'anonymous';
    }
    return !cfg.privateKeyPath && !cfg.agent;
  }

  private async create(name: string): Promise<RemoteClient> {
    const base = findRemote(name);
    if (!base) {
      throw new Error(`Remote "${name}" is not configured (remotex.remotes).`);
    }
    const cfg: RemoteConfig = { ...base };
    let prompted = false;
    if (!cfg.password && this.needsPassword(cfg)) {
      cfg.password = await this.secrets.get(secretKey(cfg.name));
      if (!cfg.password) {
        cfg.password = await vscode.window.showInputBox({
          title: `Remotex: ${cfg.name}`,
          prompt: `Password for ${cfg.username ?? ''}@${cfg.host}`,
          password: true,
          ignoreFocusOut: true,
        });
        if (cfg.password === undefined) {
          throw new Error('Password entry cancelled');
        }
        prompted = true;
      }
    }

    const client: RemoteClient = cfg.protocol === 'ftp' ? new FtpClient(cfg, this.log) : new SftpClient(cfg, this.log);
    try {
      await client.connect();
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      this.log(`[${cfg.name}] connection failed: ${msg}`);
      if (/auth|login|password|530/i.test(msg)) {
        await this.secrets.delete(secretKey(cfg.name));
      }
      void vscode.window.showErrorMessage(`Remotex: cannot connect to "${cfg.name}": ${msg}`);
      throw e;
    }
    if (prompted && rememberPasswords() && cfg.password) {
      await this.secrets.store(secretKey(cfg.name), cfg.password);
    }
    return client;
  }

  async close(name: string): Promise<void> {
    const key = name.toLowerCase();
    const p = this.clients.get(key);
    this.clients.delete(key);
    if (p) {
      try {
        await (await p).dispose();
      } catch {
        // ignore
      }
    }
  }

  async closeAll(): Promise<void> {
    const all = [...this.clients.keys()];
    await Promise.all(all.map((k) => this.close(k)));
  }

  async forgetPassword(name: string): Promise<void> {
    await this.secrets.delete(secretKey(name));
  }

  dispose(): void {
    void this.closeAll();
  }
}
