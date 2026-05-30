import * as vscode from 'vscode';
import * as path from 'path';

export interface NoteInfo {
  uri: vscode.Uri;
  basename: string;
  links: Set<string>;
  tags: Set<string>;
}

const LINK_RE = /(?<!!)\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g;
const TAG_RE = /(^|[\s>(`])#([A-Za-z][\w/-]*)/g;
const CODE_FENCE_RE = /```[\s\S]*?```/g;

export class NoteIndex implements vscode.Disposable {
  private byKey = new Map<string, NoteInfo>();
  private byUri = new Map<string, NoteInfo>();
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private watcher: vscode.FileSystemWatcher;
  private disposables: vscode.Disposable[] = [];
  private pendingFire?: NodeJS.Timeout;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*.md');
    this.disposables.push(
      this.watcher,
      this.watcher.onDidCreate(uri => this.onFsChange(uri)),
      this.watcher.onDidChange(uri => this.onFsChange(uri)),
      this.watcher.onDidDelete(uri => {
        this.removeFile(uri);
        this.scheduleFire();
      }),
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId === 'markdown') this.onFsChange(doc.uri);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scan()),
    );
  }

  dispose() {
    this.disposables.forEach(d => d.dispose());
    this._onDidChange.dispose();
  }

  async scan(): Promise<void> {
    this.byKey.clear();
    this.byUri.clear();
    if (!vscode.workspace.workspaceFolders?.length) {
      this._onDidChange.fire();
      return;
    }
    const exclude = vscode.workspace.getConfiguration('medianote').get<string>('exclude', '**/node_modules/**');
    const files = await vscode.workspace.findFiles('**/*.md', exclude);
    await Promise.all(files.map(uri => this.indexFile(uri)));
    this._onDidChange.fire();
  }

  private async onFsChange(uri: vscode.Uri) {
    await this.indexFile(uri);
    this.scheduleFire();
  }

  private scheduleFire() {
    if (this.pendingFire) clearTimeout(this.pendingFire);
    this.pendingFire = setTimeout(() => {
      this.pendingFire = undefined;
      this._onDidChange.fire();
    }, 100);
  }

  private async indexFile(uri: vscode.Uri): Promise<void> {
    let text: string;
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      text = Buffer.from(data).toString('utf8');
    } catch {
      return;
    }

    const stripped = text.replace(CODE_FENCE_RE, m => ' '.repeat(m.length));
    const basename = path.basename(uri.fsPath, '.md');
    const links = new Set<string>();
    const tags = new Set<string>();

    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(stripped)) !== null) {
      const target = m[1].trim();
      if (target) links.add(target.toLowerCase());
    }

    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(stripped)) !== null) {
      tags.add(m[2]);
    }

    const old = this.byUri.get(uri.toString());
    if (old) {
      const oldKey = old.basename.toLowerCase();
      if (this.byKey.get(oldKey) === old) this.byKey.delete(oldKey);
    }

    const info: NoteInfo = { uri, basename, links, tags };
    this.byUri.set(uri.toString(), info);
    this.byKey.set(basename.toLowerCase(), info);
  }

  private removeFile(uri: vscode.Uri) {
    const info = this.byUri.get(uri.toString());
    if (!info) return;
    this.byUri.delete(uri.toString());
    const key = info.basename.toLowerCase();
    if (this.byKey.get(key) === info) this.byKey.delete(key);
  }

  resolve(name: string): NoteInfo | undefined {
    return this.byKey.get(name.trim().toLowerCase());
  }

  all(): NoteInfo[] {
    return [...this.byUri.values()];
  }

  backlinksFor(name: string): NoteInfo[] {
    const key = name.trim().toLowerCase();
    return this.all().filter(n => n.links.has(key));
  }

  notesWithTag(tag: string): NoteInfo[] {
    return this.all().filter(n => n.tags.has(tag));
  }

  allTags(): string[] {
    const s = new Set<string>();
    for (const n of this.byUri.values()) for (const t of n.tags) s.add(t);
    return [...s].sort();
  }
}
