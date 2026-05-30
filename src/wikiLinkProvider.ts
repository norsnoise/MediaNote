import * as vscode from 'vscode';
import * as path from 'path';
import { NoteIndex } from './noteIndex';
import { headingSlug } from './markdownPlugin';

const LINK_RE = /(?<!!)\[\[([^\]\n|#]+)(?:#([^\]\n|]*))?(?:\|([^\]\n]*))?\]\]/g;

interface MatchedLink {
  range: vscode.Range;
  target: string;
  section?: string;
  alias?: string;
}

function findLinkAt(doc: vscode.TextDocument, pos: vscode.Position): MatchedLink | undefined {
  const lineText = doc.lineAt(pos.line).text;
  LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(lineText)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (pos.character >= start && pos.character <= end) {
      return {
        range: new vscode.Range(pos.line, start, pos.line, end),
        target: m[1].trim(),
        section: m[2]?.trim() || undefined,
        alias: m[3]?.trim(),
      };
    }
  }
  return undefined;
}

// Line (0-based) of the markdown heading matching `section`, by exact text
// (case-insensitive) or GitHub-style slug — the same slug the preview anchors
// use. Skips fenced code blocks. Returns undefined if no heading matches.
export function findHeadingLine(text: string, section: string): number | undefined {
  const wanted = section.trim();
  if (!wanted) return undefined;
  const wantedSlug = headingSlug(wanted);
  const lines = text.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    const heading = m[2].trim();
    if (heading.toLowerCase() === wanted.toLowerCase() || headingSlug(heading) === wantedSlug) {
      return i;
    }
  }
  return undefined;
}

function* iterateLinks(doc: vscode.TextDocument): Generator<{ line: number; start: number; match: RegExpExecArray }> {
  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(text)) !== null) {
      yield { line, start: m.index, match: m };
    }
  }
}

export class WikiLinkDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private index: NoteIndex) {}
  async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Definition | undefined> {
    const link = findLinkAt(doc, pos);
    if (!link) return;
    const note = this.index.resolve(link.target);
    if (!note) return;
    let line = 0;
    if (link.section) {
      try {
        const data = await vscode.workspace.fs.readFile(note.uri);
        const found = findHeadingLine(Buffer.from(data).toString('utf8'), link.section);
        if (found !== undefined) line = found;
      } catch {
        // fall back to the top of the file
      }
    }
    return new vscode.Location(note.uri, new vscode.Position(line, 0));
  }
}

export class WikiLinkDocumentLinkProvider implements vscode.DocumentLinkProvider {
  constructor(private index: NoteIndex) {}
  provideDocumentLinks(doc: vscode.TextDocument): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    for (const { line, start, match } of iterateLinks(doc)) {
      const end = start + match[0].length;
      const target = match[1].trim();
      const section = match[2]?.trim();
      const range = new vscode.Range(line, start, line, end);
      const note = this.index.resolve(target);
      if (note) {
        if (section) {
          // Navigate to the heading via a command — VS Code's file-URI opener
          // only understands line-number fragments, not heading slugs.
          const args = encodeURIComponent(JSON.stringify([note.uri.toString(), section]));
          const link = new vscode.DocumentLink(range, vscode.Uri.parse(`command:medianote.openNote?${args}`));
          link.tooltip = `Open ${note.basename} › ${section}`;
          links.push(link);
        } else {
          const link = new vscode.DocumentLink(range, note.uri);
          link.tooltip = `Open ${note.basename}`;
          links.push(link);
        }
      } else {
        const args = encodeURIComponent(JSON.stringify([target]));
        const link = new vscode.DocumentLink(range, vscode.Uri.parse(`command:medianote.createFromLink?${args}`));
        link.tooltip = `Create note: ${target}`;
        links.push(link);
      }
    }
    return links;
  }
}

export class WikiLinkCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private index: NoteIndex) {}
  provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] {
    const before = doc.lineAt(pos.line).text.substring(0, pos.character);
    const open = before.lastIndexOf('[[');
    const close = before.lastIndexOf(']]');
    if (open < 0 || close > open) return [];
    const typed = before.substring(open + 2);
    if (typed.includes(']')) return [];

    return this.index.all().map(note => {
      const item = new vscode.CompletionItem(note.basename, vscode.CompletionItemKind.File);
      item.detail = vscode.workspace.asRelativePath(note.uri);
      item.insertText = note.basename;
      item.filterText = note.basename;
      return item;
    });
  }
}

export class WikiLinkReferenceProvider implements vscode.ReferenceProvider {
  constructor(private index: NoteIndex) {}
  async provideReferences(doc: vscode.TextDocument): Promise<vscode.Location[]> {
    const basename = path.basename(doc.uri.fsPath, '.md');
    const result: vscode.Location[] = [];
    const escaped = escapeRe(basename);
    const refRe = new RegExp(`(?<!!)\\[\\[\\s*${escaped}\\s*(?:#[^\\]\\|]*)?(?:\\|[^\\]]*)?\\]\\]`, 'gi');
    for (const note of this.index.backlinksFor(basename)) {
      let text: string;
      try {
        const data = await vscode.workspace.fs.readFile(note.uri);
        text = Buffer.from(data).toString('utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        refRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = refRe.exec(lines[i])) !== null) {
          result.push(new vscode.Location(note.uri, new vscode.Range(i, m.index, i, m.index + m[0].length)));
        }
      }
    }
    return result;
  }
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class WikiLinkHoverProvider implements vscode.HoverProvider {
  constructor(private index: NoteIndex) {}
  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const link = findLinkAt(doc, pos);
    if (!link) return;
    const note = this.index.resolve(link.target);
    if (!note) {
      const md = new vscode.MarkdownString(`Note **${link.target}** does not exist. _Click the link to create it._`);
      return new vscode.Hover(md, link.range);
    }
    let preview = '';
    try {
      const data = await vscode.workspace.fs.readFile(note.uri);
      preview = Buffer.from(data).toString('utf8').slice(0, 800);
    } catch {
      // ignore
    }
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${note.basename}** — _${vscode.workspace.asRelativePath(note.uri)}_\n\n`);
    md.appendMarkdown(preview);
    md.isTrusted = false;
    return new vscode.Hover(md, link.range);
  }
}
