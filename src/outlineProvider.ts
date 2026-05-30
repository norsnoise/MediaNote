import * as vscode from 'vscode';
import * as path from 'path';
import { NoteIndex } from './noteIndex';

export class OutlineProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private index: NoteIndex) {}

  refresh() {
    this._onDidChange.fire();
  }

  getTreeItem(el: vscode.TreeItem) {
    return el;
  }

  getChildren(): vscode.TreeItem[] {
    const all = this.index.all();
    if (!all.length) {
      const it = new vscode.TreeItem('No notes yet — create one with MediaNote: New Note');
      it.iconPath = new vscode.ThemeIcon('info');
      return [it];
    }
    return all
      .sort((a, b) => a.basename.localeCompare(b.basename))
      .map(n => {
        const it = new vscode.TreeItem(n.basename);
        it.resourceUri = n.uri;
        it.description = vscode.workspace.asRelativePath(path.dirname(n.uri.fsPath));
        it.command = { command: 'vscode.open', title: 'Open', arguments: [n.uri] };
        it.iconPath = new vscode.ThemeIcon('file');
        it.tooltip = vscode.workspace.asRelativePath(n.uri);
        return it;
      });
  }
}
