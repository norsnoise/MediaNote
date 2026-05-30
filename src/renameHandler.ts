import * as vscode from 'vscode';
import * as path from 'path';
import { NoteIndex } from './noteIndex';

const FENCE_RE = /```[\s\S]*?```/g;
const EMBED_WIKI_RE = /!\[\[([^\]\n|#]+)((?:#[^\]\n|]*)?(?:\|[^\]\n]*)?)\]\]/g;
const MD_LINK_RE = /(!?)\[([^\]\n]*)\]\((<[^>\n]*>|[^)\s]+)\)/g;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function computeFences(text: string): Array<[number, number]> {
  const fences: Array<[number, number]> = [];
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    fences.push([m.index, m.index + m[0].length]);
  }
  return fences;
}

function splitPathSuffix(s: string): [string, string] {
  const h = s.indexOf('#');
  const q = s.indexOf('?');
  const idx = h >= 0 && q >= 0 ? Math.min(h, q) : h >= 0 ? h : q;
  return idx < 0 ? [s, ''] : [s.slice(0, idx), s.slice(idx)];
}

function looksLikeUrl(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('//') || s.startsWith('mailto:');
}

function safeDecode(s: string): string {
  try { return decodeURI(s); } catch { return s; }
}

function relFromDoc(docDir: string, targetFsPath: string): string {
  return path.relative(docDir, targetFsPath).split(path.sep).join('/');
}

function pathsEqual(a: string, b: string): boolean {
  const na = path.normalize(a);
  const nb = path.normalize(b);
  // Windows / macOS default file systems are case-insensitive.
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

async function openDoc(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  try { return await vscode.workspace.openTextDocument(uri); } catch { return undefined; }
}

async function collectWikiLinkRenames(
  uri: vscode.Uri,
  oldName: string,
  newName: string,
  edit: vscode.WorkspaceEdit,
): Promise<void> {
  const doc = await openDoc(uri);
  if (!doc) return;
  const text = doc.getText();
  const fences = computeFences(text);
  const inFence = (o: number) => fences.some(([s, e]) => o >= s && o < e);

  const re = new RegExp(
    `(?<!!)\\[\\[(${escapeRegex(oldName)})((?:#[^\\]\\n|]*)?(?:\\|[^\\]\\n]*)?)\\]\\]`,
    'gi',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (inFence(m.index)) continue;
    const start = m.index + 2; // skip "[["
    const end = start + m[1].length;
    edit.replace(uri, new vscode.Range(doc.positionAt(start), doc.positionAt(end)), newName);
  }
}

async function collectPathRenames(
  uri: vscode.Uri,
  oldFsPath: string,
  newFsPath: string,
  edit: vscode.WorkspaceEdit,
): Promise<void> {
  const oldBase = path.basename(oldFsPath);
  const doc = await openDoc(uri);
  if (!doc) return;
  const text = doc.getText();
  // Quick filter: if the basename doesn't appear at all, skip the regex passes.
  if (!text.includes(oldBase)) return;

  const docDir = path.dirname(uri.fsPath);
  const fences = computeFences(text);
  const inFence = (o: number) => fences.some(([s, e]) => o >= s && o < e);

  // ![[path(#section)?(|alias)?]]
  EMBED_WIKI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMBED_WIKI_RE.exec(text)) !== null) {
    if (inFence(m.index)) continue;
    const raw = m[1];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(docDir, safeDecode(trimmed));
    if (!pathsEqual(resolved, oldFsPath)) continue;
    const pathStart = m.index + 3; // skip "![["
    const pathEnd = pathStart + raw.length;
    edit.replace(
      uri,
      new vscode.Range(doc.positionAt(pathStart), doc.positionAt(pathEnd)),
      relFromDoc(docDir, newFsPath),
    );
  }

  // [label](target) and ![label](target), with optional <…> around the target.
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(text)) !== null) {
    if (inFence(m.index)) continue;
    // `](` cannot appear inside the label (label regex excludes `]`), so this find is reliable.
    const bracketEnd = m[0].indexOf('](') + 2;
    const targetStart = m.index + bracketEnd;
    const targetRaw = m[3];
    const targetEnd = targetStart + targetRaw.length;
    let inner = targetRaw;
    if (inner.startsWith('<') && inner.endsWith('>')) inner = inner.slice(1, -1);
    if (!inner || inner.startsWith('#') || looksLikeUrl(inner)) continue;
    const [pathPart, suffix] = splitPathSuffix(inner);
    if (!pathPart) continue;
    const resolved = path.resolve(docDir, safeDecode(pathPart));
    if (!pathsEqual(resolved, oldFsPath)) continue;
    const newRel = relFromDoc(docDir, newFsPath);
    const combined = newRel + suffix;
    const needsAngle = /[\s()<>]/.test(newRel);
    const formatted = needsAngle ? `<${combined}>` : combined;
    edit.replace(
      uri,
      new vscode.Range(doc.positionAt(targetStart), doc.positionAt(targetEnd)),
      formatted,
    );
  }
}

async function buildRenameEdit(
  files: ReadonlyArray<{ oldUri: vscode.Uri; newUri: vscode.Uri }>,
  index: NoteIndex,
): Promise<vscode.WorkspaceEdit> {
  const edit = new vscode.WorkspaceEdit();
  for (const { oldUri, newUri } of files) {
    if (oldUri.fsPath === newUri.fsPath) continue;
    const oldIsMd = path.extname(oldUri.fsPath).toLowerCase() === '.md';
    const newIsMd = path.extname(newUri.fsPath).toLowerCase() === '.md';

    if (oldIsMd && newIsMd) {
      const oldName = path.basename(oldUri.fsPath, '.md');
      const newName = path.basename(newUri.fsPath, '.md');
      if (oldName !== newName) {
        const referrers = index.backlinksFor(oldName);
        await Promise.all(
          referrers.map(r => collectWikiLinkRenames(r.uri, oldName, newName, edit)),
        );
      }
    }

    // Path-based references — any file rename can affect ![[path]], ![](path), [text](path).
    await Promise.all(
      index.all().map(n => collectPathRenames(n.uri, oldUri.fsPath, newUri.fsPath, edit)),
    );
  }
  return edit;
}

export function registerRenameHandler(context: vscode.ExtensionContext, index: NoteIndex) {
  context.subscriptions.push(
    vscode.workspace.onWillRenameFiles(event => {
      event.waitUntil(buildRenameEdit(event.files, index));
    }),
  );
}
