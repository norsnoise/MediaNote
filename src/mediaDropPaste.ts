import * as vscode from 'vscode';
import * as path from 'path';
import {
  copyToAttachments,
  embedSnippetFor,
  imageEmbedSnippet,
  isImagePath,
  isMediaPath,
  saveBufferToAttachments,
  withTimestamp,
} from './attachments';

type ItemKind = 'media' | 'image' | 'markdown' | 'other';

interface IncomingItem {
  uri?: vscode.Uri;
  name: string;
  kind: ItemKind;
  data?: () => Thenable<Uint8Array>;
}

function classify(name: string, mime?: string): ItemKind {
  if (mime?.startsWith('image/') || isImagePath(name)) return 'image';
  if (mime?.startsWith('audio/') || mime?.startsWith('video/') || isMediaPath(name)) return 'media';
  if (path.extname(name).toLowerCase() === '.md') return 'markdown';
  return 'other';
}

async function collectItems(dt: vscode.DataTransfer, token: vscode.CancellationToken): Promise<IncomingItem[]> {
  const out: IncomingItem[] = [];
  const seen = new Set<string>();

  dt.forEach((item, mime) => {
    const file = item.asFile();
    if (!file) return;
    const key = (file.uri?.toString() ?? '') + '|' + file.name;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      uri: file.uri,
      name: file.name,
      kind: classify(file.name, mime),
      data: () => file.data(),
    });
  });

  if (out.length === 0) {
    const uriList = dt.get('text/uri-list');
    if (uriList) {
      const value = await uriList.asString();
      if (token.isCancellationRequested) return [];
      const lines = value.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
      for (const line of lines) {
        let parsed: vscode.Uri;
        try {
          parsed = vscode.Uri.parse(line);
        } catch {
          continue;
        }
        if (parsed.scheme !== 'file') continue;
        const key = parsed.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        const name = path.basename(parsed.fsPath);
        out.push({ uri: parsed, name, kind: classify(name) });
      }
    }
  }

  return out;
}

function relativeFromDoc(targetUri: vscode.Uri, docUri: vscode.Uri): string {
  const docDir = path.dirname(docUri.fsPath);
  return path.relative(docDir, targetUri.fsPath).split(path.sep).join('/');
}

function plainLinkSnippet(uri: vscode.Uri, docUri: vscode.Uri): string {
  const rel = relativeFromDoc(uri, docUri);
  const label = path.basename(uri.fsPath);
  const needsAngle = /[\s()<>]/.test(rel);
  const target = needsAngle ? `<${rel}>` : rel;
  return `[${label}](${target})`;
}

function wikiLinkSnippet(uri: vscode.Uri): string {
  return `[[${path.basename(uri.fsPath, '.md')}]]`;
}

export async function linkSnippetForUri(uri: vscode.Uri, docUri: vscode.Uri): Promise<string | undefined> {
  const name = path.basename(uri.fsPath);
  const kind = classify(name);
  if (kind === 'markdown') {
    return vscode.workspace.getWorkspaceFolder(uri)
      ? wikiLinkSnippet(uri)
      : plainLinkSnippet(uri, docUri);
  }
  if (kind === 'other') {
    // Already in the vault → link in place. From outside → copy into the
    // attachments folder (like media/images) so the link stays portable.
    if (vscode.workspace.getWorkspaceFolder(uri)) {
      return plainLinkSnippet(uri, docUri);
    }
    const dest = await copyToAttachments(uri, docUri);
    return dest ? plainLinkSnippet(dest, docUri) : undefined;
  }
  const isImage = kind === 'image';
  // Already inside the workspace → link in place; don't duplicate into attachments.
  if (vscode.workspace.getWorkspaceFolder(uri)) {
    return isImage ? imageEmbedSnippet(uri, docUri) : embedSnippetFor(uri, docUri);
  }
  const targetName = isImage ? withTimestamp(name) : name;
  const dest = await copyToAttachments(uri, docUri, isImage ? targetName : undefined);
  if (!dest) return undefined;
  return isImage ? imageEmbedSnippet(dest, docUri) : embedSnippetFor(dest, docUri);
}

async function materialize(items: IncomingItem[], docUri: vscode.Uri): Promise<string[]> {
  const snippets: string[] = [];
  for (const item of items) {
    if (item.uri) {
      const snippet = await linkSnippetForUri(item.uri, docUri);
      if (snippet) snippets.push(snippet);
      continue;
    }
    // No URI → in-memory data (clipboard paste).
    if ((item.kind === 'media' || item.kind === 'image') && item.data) {
      const isImage = item.kind === 'image';
      const targetName = isImage ? withTimestamp(item.name) : item.name;
      const data = await item.data();
      const dest = await saveBufferToAttachments(data, docUri, targetName);
      if (dest) snippets.push(isImage ? imageEmbedSnippet(dest, docUri) : embedSnippetFor(dest, docUri));
    } else if (item.kind === 'other' && item.data) {
      const data = await item.data();
      const dest = await saveBufferToAttachments(data, docUri, item.name);
      if (dest) snippets.push(plainLinkSnippet(dest, docUri));
    }
  }
  return snippets;
}

function dropTargets(items: IncomingItem[], docUri: vscode.Uri): IncomingItem[] {
  return items.filter(i => !i.uri || i.uri.toString() !== docUri.toString());
}

export class MediaDocumentDropProvider implements vscode.DocumentDropEditProvider {
  async provideDocumentDropEdits(
    doc: vscode.TextDocument,
    _pos: vscode.Position,
    dt: vscode.DataTransfer,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentDropEdit | undefined> {
    const items = dropTargets(await collectItems(dt, token), doc.uri);
    if (items.length === 0 || token.isCancellationRequested) return undefined;
    const snippets = await materialize(items, doc.uri);
    if (snippets.length === 0) return undefined;
    return new vscode.DocumentDropEdit(snippets.join('\n'));
  }
}

export class MediaDocumentPasteProvider implements vscode.DocumentPasteEditProvider {
  async provideDocumentPasteEdits(
    doc: vscode.TextDocument,
    _ranges: readonly vscode.Range[],
    dt: vscode.DataTransfer,
    _context: vscode.DocumentPasteEditContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.DocumentPasteEdit[] | undefined> {
    const items = dropTargets(await collectItems(dt, token), doc.uri);
    if (items.length === 0 || token.isCancellationRequested) return undefined;
    const snippets = await materialize(items, doc.uri);
    if (snippets.length === 0) return undefined;
    return [new vscode.DocumentPasteEdit(snippets.join('\n'), 'Insert MediaNote link', MEDIA_PASTE_KIND)];
  }
}

export const MEDIA_PASTE_KIND = vscode.DocumentDropOrPasteEditKind.Empty.append('medianote', 'media');
