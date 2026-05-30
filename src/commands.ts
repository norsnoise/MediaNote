import * as vscode from 'vscode';
import { NoteIndex } from './noteIndex';
import { linkSnippetForUri } from './mediaDropPaste';
import { exportNote, ExportFormat, pickExportDestination } from './export';
import { findHeadingLine } from './wikiLinkProvider';

export function registerCommands(context: vscode.ExtensionContext, index: NoteIndex) {
  context.subscriptions.push(
    vscode.commands.registerCommand('medianote.newNote', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Note name (without .md)',
        validateInput: v => (v.trim().length === 0 ? 'Name is required' : null),
      });
      if (!name) return;
      const uri = await createNote(name.trim());
      if (uri) await vscode.window.showTextDocument(uri);
    }),

    vscode.commands.registerCommand('medianote.createFromLink', async (target: string) => {
      if (!target) return;
      const uri = await createNote(target);
      if (uri) await vscode.window.showTextDocument(uri);
    }),

    vscode.commands.registerCommand('medianote.refreshIndex', () => index.scan()),

    // Target of section-bearing wiki-link DocumentLinks (`[[Note#Heading]]`):
    // open the note and reveal the matching heading. VS Code's generic file-URI
    // opener only handles line-number fragments, so we resolve the heading here.
    vscode.commands.registerCommand('medianote.openNote', async (arg?: string, section?: string) => {
      if (!arg) return;
      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(arg, true);
      } catch {
        return;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      if (!section) return;
      const line = findHeadingLine(doc.getText(), section);
      if (line === undefined) return;
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
    }),

    vscode.commands.registerCommand('medianote.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.medianote'),
    ),

    vscode.commands.registerCommand('medianote.openTagFilter', async () => {
      const tags = index.allTags();
      if (!tags.length) {
        vscode.window.showInformationMessage('No tags in this vault yet.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        tags.map(t => ({ label: `#${t}`, tag: t, description: `${index.notesWithTag(t).length} notes` })),
        { placeHolder: 'Pick a tag' },
      );
      if (!picked) return;
      const notes = index.notesWithTag(picked.tag);
      const note = await vscode.window.showQuickPick(
        notes.map(n => ({
          label: n.basename,
          description: vscode.workspace.asRelativePath(n.uri),
          uri: n.uri,
        })),
        { placeHolder: `Notes tagged #${picked.tag}` },
      );
      if (note) await vscode.window.showTextDocument(note.uri);
    }),

    vscode.commands.registerCommand('medianote.insertLink', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'markdown') {
        vscode.window.showErrorMessage('Open a markdown file first.');
        return;
      }
      type Pick = vscode.QuickPickItem & { uri?: vscode.Uri; browse?: boolean };
      const notes = index.all().sort((a, b) => a.basename.localeCompare(b.basename));
      const items: Pick[] = [
        { label: '$(folder-opened) Browse for file...', browse: true, alwaysShow: true },
        ...notes.map<Pick>(n => ({
          label: `$(note) ${n.basename}`,
          description: vscode.workspace.asRelativePath(n.uri),
          uri: n.uri,
        })),
      ];
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Pick a note or file to link',
        matchOnDescription: true,
      });
      if (!picked) return;
      let targetUri: vscode.Uri | undefined = picked.uri;
      if (picked.browse) {
        const files = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Insert link' });
        if (!files?.length) return;
        targetUri = files[0];
      }
      if (!targetUri) return;
      const snippet = await linkSnippetForUri(targetUri, editor.document.uri);
      if (!snippet) return;
      await editor.edit(eb => eb.replace(editor.selection, snippet));
    }),

    vscode.commands.registerCommand('medianote.exportNote', async (target?: vscode.Uri) => {
      const docUri = target ?? vscode.window.activeTextEditor?.document.uri;
      if (!docUri || (vscode.window.activeTextEditor?.document.uri === docUri &&
          vscode.window.activeTextEditor?.document.languageId !== 'markdown')) {
        vscode.window.showErrorMessage('Open a markdown note to export.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        [
          { label: 'HTML', detail: 'Standalone .html', format: 'html' as ExportFormat },
          { label: 'PDF', detail: 'Rendered via headless Chrome/Chromium', format: 'pdf' as ExportFormat },
          { label: 'HTML + PDF', detail: 'Both, in one go', format: 'both' as ExportFormat },
        ],
        { placeHolder: 'Export format' },
      );
      if (!picked) return;
      const destination = await pickExportDestination(docUri, picked.format);
      if (!destination) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Exporting ${picked.label}...` },
        () => exportNote(docUri, destination, context.extensionUri),
      );
    }),

    vscode.commands.registerCommand('medianote.search', async () => {
      const all = index.all();
      if (!all.length) {
        vscode.window.showInformationMessage('No notes in this vault yet.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        all
          .sort((a, b) => a.basename.localeCompare(b.basename))
          .map(n => ({
            label: n.basename,
            description: vscode.workspace.asRelativePath(n.uri),
            detail: [...n.tags].map(t => `#${t}`).join(' '),
            uri: n.uri,
          })),
        { placeHolder: 'Search notes by name', matchOnDescription: true, matchOnDetail: true },
      );
      if (picked) await vscode.window.showTextDocument(picked.uri);
    }),
  );
}

function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function ensureParent(uri: vscode.Uri) {
  const parent = vscode.Uri.joinPath(uri, '..');
  try {
    await vscode.workspace.fs.createDirectory(parent);
  } catch {
    // already exists or unwritable; the subsequent write will surface a real error
  }
}

async function createNote(name: string): Promise<vscode.Uri | undefined> {
  const ws = workspaceRoot();
  if (!ws) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }
  const folder = vscode.workspace.getConfiguration('medianote').get<string>('newNoteFolder', '');
  const safe = name.replace(/[\\/:*?"<>|]/g, '-');
  const uri = folder
    ? vscode.Uri.joinPath(ws, folder, `${safe}.md`)
    : vscode.Uri.joinPath(ws, `${safe}.md`);
  if (!(await exists(uri))) {
    await ensureParent(uri);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(`# ${name}\n\n`, 'utf8'));
  }
  return uri;
}
