import * as os from 'os';
import * as vscode from 'vscode';
import { describe, getRemotes, remoteUri, RemoteConfig, RemoteSettings, saveRemote, SCHEME } from './config';
import { ConnectionManager } from './connectionManager';
import { RemoteFileSystemProvider } from './fileSystemProvider';

let connections: ConnectionManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Remotex');
  const log = (msg: string) => output.appendLine(`${new Date().toISOString()} ${msg}`);

  connections = new ConnectionManager(context.secrets, log);
  const provider = new RemoteFileSystemProvider(connections);
  const mgr = connections;

  context.subscriptions.push(
    output,
    mgr,
    vscode.workspace.registerFileSystemProvider(SCHEME, provider, { isCaseSensitive: true }),
    vscode.commands.registerCommand('remotex.connect', () => connect(mgr, false)),
    vscode.commands.registerCommand('remotex.openInNewWindow', () => connect(mgr, true)),
    vscode.commands.registerCommand('remotex.disconnect', (uri?: vscode.Uri) => disconnect(mgr, uri)),
    vscode.commands.registerCommand('remotex.addRemote', () => addRemote(mgr)),
    vscode.commands.registerCommand('remotex.clearPassword', async () => {
      const r = await pickRemote('Forget the saved password of...');
      if (r) {
        await mgr.forgetPassword(r.name);
        await mgr.close(r.name);
        void vscode.window.showInformationMessage(`Remotex: password for "${r.name}" forgotten.`);
      }
    }),
    vscode.commands.registerCommand('remotex.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'remotex.remotes'),
    ),
    vscode.commands.registerCommand('remotex.showLog', () => output.show()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('remotex.remotes')) {
        log('Remote configuration changed; closing connections (they reconnect on demand).');
        void mgr.closeAll();
      }
    }),
  );
}

export function deactivate(): Promise<void> | undefined {
  return connections?.closeAll();
}

async function pickRemote(placeHolder: string): Promise<RemoteConfig | undefined> {
  const remotes = getRemotes();
  if (remotes.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'Remotex: no remotes configured yet.',
      'Add Remote Server',
      'Open Settings',
    );
    if (choice === 'Add Remote Server') {
      await vscode.commands.executeCommand('remotex.addRemote');
    } else if (choice === 'Open Settings') {
      await vscode.commands.executeCommand('remotex.openSettings');
    }
    return undefined;
  }
  const item = await vscode.window.showQuickPick(
    remotes.map((r) => ({ label: r.name, description: describe(r), remote: r })),
    { placeHolder, matchOnDescription: true },
  );
  return item?.remote;
}

async function connect(mgr: ConnectionManager, newWindow: boolean): Promise<void> {
  const remote = await pickRemote(newWindow ? 'Open which remote in a new window?' : 'Connect to which remote?');
  if (!remote) {
    return;
  }
  const uri = remoteUri(remote.name);

  // Connect first so configuration / auth errors show up immediately.
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Connecting to ${remote.name}...` },
      () => mgr.get(remote.name),
    );
  } catch {
    return; // error already reported by the connection manager
  }

  if (newWindow) {
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
    return;
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  const existing = folders.find((f) => f.uri.toString() === uri.toString());
  if (existing) {
    await vscode.commands.executeCommand('workbench.view.explorer');
    return;
  }
  const label = `${remote.name} (${remote.protocol === 'ftp' && remote.secure ? 'ftps' : remote.protocol})`;
  vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name: label });
  await vscode.commands.executeCommand('workbench.view.explorer');
}

async function disconnect(mgr: ConnectionManager, uri?: vscode.Uri): Promise<void> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === SCHEME);
  let target = uri && uri.scheme === SCHEME ? folders.find((f) => f.uri.authority === uri.authority) : undefined;
  if (!target) {
    if (folders.length === 0) {
      void vscode.window.showInformationMessage('Remotex: no remote folders are open.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, folder: f })),
      { placeHolder: 'Disconnect which remote?' },
    );
    target = pick?.folder;
  }
  if (!target) {
    return;
  }
  await mgr.close(target.uri.authority);
  vscode.workspace.updateWorkspaceFolders(target.index, 1);
}

async function addRemote(mgr: ConnectionManager): Promise<void> {
  const title = 'Remotex: Add Remote Server';
  const proto = await vscode.window.showQuickPick(
    [
      { label: 'SFTP', description: 'SSH File Transfer Protocol', value: 'sftp' as const, secure: false as const },
      { label: 'FTP', description: 'Plain FTP', value: 'ftp' as const, secure: false as const },
      { label: 'FTPS (explicit)', description: 'FTP over TLS (AUTH TLS)', value: 'ftp' as const, secure: true as const },
      { label: 'FTPS (implicit)', description: 'FTP over TLS, port 990', value: 'ftp' as const, secure: 'implicit' as const },
    ],
    { title, placeHolder: 'Protocol', ignoreFocusOut: true },
  );
  if (!proto) {
    return;
  }

  const host = await vscode.window.showInputBox({
    title,
    prompt: 'Host (you can include a port, e.g. example.com:2222)',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Host is required'),
  });
  if (!host) {
    return;
  }
  let hostname = host.trim();
  let port: number | undefined;
  const m = /^(.*):(\d+)$/.exec(hostname);
  if (m) {
    hostname = m[1];
    port = Number(m[2]);
  }

  const username = await vscode.window.showInputBox({
    title,
    prompt: proto.value === 'ftp' ? 'Username (leave empty for anonymous)' : 'Username',
    ignoreFocusOut: true,
  });
  if (username === undefined) {
    return;
  }

  const settings: RemoteSettings = { protocol: proto.value, host: hostname };
  if (port) {
    settings.port = port;
  }
  if (username) {
    settings.username = username;
  }
  if (proto.secure) {
    settings.secure = proto.secure;
  }

  if (proto.value === 'sftp') {
    const auth = await vscode.window.showQuickPick(
      [
        { label: 'Password', description: 'Asked on first connect, stored in the OS keychain', value: 'password' },
        { label: 'Private key file', value: 'key' },
        { label: 'SSH agent', value: 'agent' },
      ],
      { title, placeHolder: 'Authentication', ignoreFocusOut: true },
    );
    if (!auth) {
      return;
    }
    if (auth.value === 'key') {
      const files = await vscode.window.showOpenDialog({
        title: 'Select private key',
        canSelectMany: false,
        defaultUri: vscode.Uri.file(os.homedir() + '/.ssh'),
      });
      if (!files?.[0]) {
        return;
      }
      settings.privateKeyPath = files[0].fsPath;
    } else if (auth.value === 'agent') {
      settings.agent = true;
    }
  }

  const rootPath = await vscode.window.showInputBox({
    title,
    prompt: 'Remote root directory',
    value: '/',
    ignoreFocusOut: true,
  });
  if (rootPath === undefined) {
    return;
  }
  settings.rootPath = rootPath.trim() || '/';

  const existingNames = new Set(getRemotes().map((r) => r.name.toLowerCase()));
  const name = await vscode.window.showInputBox({
    title,
    prompt: 'Name for this remote',
    value: hostname,
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v.trim()) {
        return 'Name is required';
      }
      if (/[\/\\@:?#]/.test(v)) {
        return 'Name cannot contain / \\ @ : ? #';
      }
      return existingNames.has(v.trim().toLowerCase()) ? 'A remote with this name already exists' : undefined;
    },
  });
  if (!name) {
    return;
  }

  await saveRemote(name.trim(), settings);
  const choice = await vscode.window.showInformationMessage(
    `Remotex: "${name.trim()}" saved to your user settings.`,
    'Connect',
  );
  if (choice === 'Connect') {
    await mgr.close(name.trim());
    await vscode.commands.executeCommand('remotex.connect');
  }
}
