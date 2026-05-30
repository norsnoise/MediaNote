import * as vscode from 'vscode';
import * as path from 'path';
import { NoteIndex } from './noteIndex';

class BacklinkItem extends vscode.TreeItem {}

export class BacklinksProvider implements vscode.TreeDataProvider<BacklinkItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private index: NoteIndex) {}

  refresh() {
    this._onDidChange.fire();
  }

  getTreeItem(el: BacklinkItem) {
    return el;
  }

  getChildren(): BacklinkItem[] {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') {
      return [emptyItem('Open a markdown note to see backlinks')];
    }
    const basename = path.basename(editor.document.uri.fsPath, '.md');
    const refs = this.index.backlinksFor(basename);
    if (!refs.length) return [emptyItem('No backlinks')];
    return refs.map(n => {
      const item = new BacklinkItem(n.basename, vscode.TreeItemCollapsibleState.None);
      item.resourceUri = n.uri;
      item.description = vscode.workspace.asRelativePath(path.dirname(n.uri.fsPath));
      item.command = { command: 'vscode.open', title: 'Open', arguments: [n.uri] };
      item.iconPath = new vscode.ThemeIcon('file');
      item.tooltip = vscode.workspace.asRelativePath(n.uri);
      return item;
    });
  }
}

function emptyItem(label: string): BacklinkItem {
  const it = new BacklinkItem(label, vscode.TreeItemCollapsibleState.None);
  it.iconPath = new vscode.ThemeIcon('info');
  return it;
}
