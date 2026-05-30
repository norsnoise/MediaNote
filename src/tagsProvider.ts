import * as vscode from 'vscode';
import { NoteIndex } from './noteIndex';

class TagItem extends vscode.TreeItem {
  tagName?: string;
}

export class TagsProvider implements vscode.TreeDataProvider<TagItem> {
  private _onDidChange = new vscode.EventEmitter<TagItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private index: NoteIndex) {}

  refresh() {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(el: TagItem) {
    return el;
  }

  getChildren(parent?: TagItem): TagItem[] {
    if (!parent) {
      const tags = this.index.allTags();
      if (!tags.length) {
        const it = new TagItem('No tags found', vscode.TreeItemCollapsibleState.None);
        it.iconPath = new vscode.ThemeIcon('info');
        return [it];
      }
      return tags.map(t => {
        const count = this.index.notesWithTag(t).length;
        const it = new TagItem(`#${t}`, vscode.TreeItemCollapsibleState.Collapsed);
        it.tagName = t;
        it.description = String(count);
        it.iconPath = new vscode.ThemeIcon('tag');
        return it;
      });
    }
    if (parent.tagName) {
      return this.index.notesWithTag(parent.tagName).map(n => {
        const it = new TagItem(n.basename, vscode.TreeItemCollapsibleState.None);
        it.resourceUri = n.uri;
        it.command = { command: 'vscode.open', title: 'Open', arguments: [n.uri] };
        it.iconPath = new vscode.ThemeIcon('file');
        it.tooltip = vscode.workspace.asRelativePath(n.uri);
        return it;
      });
    }
    return [];
  }
}
