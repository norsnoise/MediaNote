import * as path from 'path';
import * as vscode from 'vscode';
import { isAudioPath, isVideoPath } from './attachments';
import { NoteIndex } from './noteIndex';

// markdown-it plugin:
//   - `[[Wiki Link|alias]]` / `[[Wiki Link#section]]` → anchor link
//   - `![[file.mp3]]` (audio extension)             → <audio controls>
//   - `![[file.mp4]]` (video extension)             → <video controls>
//
// Media embeds are emitted as `image` tokens so VS Code's preview engine
// (`#addImageRenderer` in markdown-language-features) registers the src with
// `env.containingImages` (used to compute the webview's `localResourceRoots`).
// VS Code's `#toResourceUri` only converts /-rooted paths to webview URIs via
// `asWebviewUri()`; document-relative paths like `../attachments/foo.mp4` are
// left to `<base href>` resolution which loses the remote authority on
// SSH-remote, so we resolve them ourselves below.
export function wikiLinksMarkdownPlugin(md: any, index: NoteIndex) {
  // `![alt](url =WIDTHxHEIGHT)` — image with explicit size. Either dimension may be
  // omitted (`=80x`, `=x60`). Runs before the default `image` rule; if the size
  // suffix is absent we return false and let the default rule handle it.
  md.inline.ruler.before('image', 'medianote_image_size', (state: any, silent: boolean) => {
    const src: string = state.src;
    const start: number = state.pos;
    if (src.charCodeAt(start) !== 0x21 /* ! */) return false;
    if (src.charCodeAt(start + 1) !== 0x5b /* [ */) return false;

    let labelEnd = -1;
    let depth = 1;
    for (let i = start + 2; i < src.length; i++) {
      const ch = src.charCodeAt(i);
      if (ch === 0x5c /* \\ */) { i++; continue; }
      if (ch === 0x0a /* \n */) {
        // allow newlines inside label
      } else if (ch === 0x5b /* [ */) {
        depth++;
      } else if (ch === 0x5d /* ] */) {
        depth--;
        if (depth === 0) { labelEnd = i; break; }
      }
    }
    if (labelEnd < 0) return false;
    if (src.charCodeAt(labelEnd + 1) !== 0x28 /* ( */) return false;

    let p = labelEnd + 2;
    while (p < src.length && isWhitespace(src.charCodeAt(p))) p++;

    let destStart = p;
    let destEnd = p;
    if (src.charCodeAt(p) === 0x3c /* < */) {
      destStart = p + 1;
      destEnd = src.indexOf('>', destStart);
      if (destEnd < 0) return false;
      p = destEnd + 1;
    } else {
      while (destEnd < src.length) {
        const ch = src.charCodeAt(destEnd);
        if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x29 /* ) */) break;
        destEnd++;
      }
      p = destEnd;
    }
    const dest = src.slice(destStart, destEnd);
    if (!dest) return false;

    while (p < src.length && isWhitespace(src.charCodeAt(p))) p++;
    if (src.charCodeAt(p) !== 0x3d /* = */) return false;
    p++;
    const sizeMatch = /^(\d*)x(\d*)/.exec(src.slice(p));
    if (!sizeMatch || (!sizeMatch[1] && !sizeMatch[2])) return false;
    const width = sizeMatch[1];
    const height = sizeMatch[2];
    p += sizeMatch[0].length;

    while (p < src.length && isWhitespace(src.charCodeAt(p))) p++;
    if (src.charCodeAt(p) !== 0x29 /* ) */) return false;

    if (!silent) {
      const label = src.slice(start + 2, labelEnd);
      const token = state.push('image', 'img', 0);
      const attrs: [string, string][] = [
        ['src', dest],
        ['alt', ''],
      ];
      if (width) attrs.push(['width', width]);
      if (height) attrs.push(['height', height]);
      token.attrs = attrs;
      token.children = [];
      state.md.inline.parse(label, state.md, state.env, token.children);
      token.content = label;
    }

    state.pos = p + 1;
    return true;
  });

  md.inline.ruler.before('link', 'wikilink', (state: any, silent: boolean) => {
    const src: string = state.src;
    const start: number = state.pos;

    let cursor = start;
    let embed = false;
    if (src.charCodeAt(cursor) === 0x21 /* ! */) {
      embed = true;
      cursor++;
    }
    if (src.charCodeAt(cursor) !== 0x5b /* [ */ || src.charCodeAt(cursor + 1) !== 0x5b) return false;

    const end = src.indexOf(']]', cursor + 2);
    if (end < 0) return false;

    const inner = src.slice(cursor + 2, end);
    if (inner.includes('\n') || inner.includes('[[')) return false;

    if (!silent) {
      const [targetPart, alias] = inner.split('|');
      const [target, section] = targetPart.split('#');
      const targetTrim = target.trim();
      const mediaKind = isAudioPath(targetTrim) ? 'audio' : isVideoPath(targetTrim) ? 'video' : undefined;

      if (embed && mediaKind) {
        const token = state.push('image', 'img', 0);
        token.attrs = [
          ['src', targetTrim],
          ['alt', alias?.trim() ?? ''],
        ];
        token.meta = { medianoteMedia: mediaKind };
        token.children = [];
      } else {
        const display = (alias ?? (section ? `${target} › ${section}` : target)).trim();
        const resolved = index.resolve(targetTrim);

        const open = state.push('link_open', 'a', 1);
        if (resolved) {
          // Placeholder href; the link_open renderer rule below rewrites it to a path
          // relative to env.currentDocument so the preview's link handler can open it.
          // Only `href` here — VS Code's preview click handler ignores anchors that
          // carry any extra attributes beyond the ones it sets itself (class, data-*).
          open.attrs = [['href', '#']];
          open.meta = {
            medianoteWikilinkTarget: resolved.uri.toString(),
            medianoteWikilinkSection: section?.trim() ?? '',
          };
        } else if (targetTrim.includes('/')) {
          // Path-style wikilink like [[folder1/fff1]] — resolve relative to the
          // workspace folder of the previewed document at render time.
          open.attrs = [['href', '#']];
          open.meta = {
            medianoteWikilinkPath: targetTrim,
            medianoteWikilinkSection: section?.trim() ?? '',
          };
        } else {
          open.attrs = [['href', `#${encodeURIComponent(targetTrim)}`]];
        }
        const text = state.push('text', '', 0);
        text.content = display;
        state.push('link_close', 'a', -1);
      }
    }

    state.pos = end + 2;
    return true;
  });

  // For our wikilinks, emit the <a> HTML directly using env.currentDocument
  // (which is only available in renderer rules, not in core/parse state.env).
  // Bypassing prevLinkOpen for these tokens means the wrap ordering between
  // our rule and VS Code's link_open rule cannot corrupt href/data-href.
  const prevLinkOpen = md.renderer.rules.link_open;
  md.renderer.rules.link_open = function (tokens: any[], idx: number, options: any, env: any, self: any): string {
    const token = tokens[idx];
    const meta = token.meta;
    if (meta?.medianoteWikilinkTarget) {
      try {
        const targetUri = vscode.Uri.parse(meta.medianoteWikilinkTarget);
        const docUri: vscode.Uri | undefined = env?.currentDocument;
        let href: string;
        if (docUri) {
          const docDir = path.posix.dirname(docUri.path);
          const rel = path.posix.relative(docDir, targetUri.path);
          href = rel || path.posix.basename(targetUri.path);
        } else {
          href = targetUri.fsPath;
        }
        if (meta.medianoteWikilinkSection) {
          href += `#${headingSlug(meta.medianoteWikilinkSection)}`;
        }
        const safeHref = escapeAttr(href);
        return `<a href="${safeHref}" data-href="${safeHref}">`;
      } catch {
        // fall through to default rendering
      }
    } else if (meta?.medianoteWikilinkPath) {
      try {
        const docUri: vscode.Uri | undefined = env?.currentDocument;
        if (docUri) {
          const wsFolder = vscode.workspace.getWorkspaceFolder(docUri);
          const root = wsFolder ? wsFolder.uri.path : path.posix.dirname(docUri.path);
          let relPath: string = meta.medianoteWikilinkPath;
          if (!relPath.toLowerCase().endsWith('.md')) relPath += '.md';
          const targetAbsPath = path.posix.join(root, relPath);
          const docDir = path.posix.dirname(docUri.path);
          let href = path.posix.relative(docDir, targetAbsPath);
          if (!href) href = path.posix.basename(targetAbsPath);
          if (meta.medianoteWikilinkSection) {
            href += `#${headingSlug(meta.medianoteWikilinkSection)}`;
          }
          const safeHref = escapeAttr(href);
          return `<a href="${safeHref}" data-href="${safeHref}">`;
        }
      } catch {
        // fall through to default rendering
      }
    }
    return prevLinkOpen
      ? prevLinkOpen(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };

  const prevImage = md.renderer.rules.image;
  md.renderer.rules.image = function (tokens: any[], idx: number, options: any, env: any, self: any): string {
    // VS Code's image rule writes to env.containingImages and (in some code paths)
    // reads env.resourceProvider/env.currentDocument. When this plugin is invoked
    // via `markdown.api.render` outside the preview, the engine sometimes hands us
    // a stripped-down env — surface as "Cannot read properties of undefined" deep
    // in the engine. Backfill the fields the upstream rule expects.
    if (env) {
      if (env.containingImages === undefined) env.containingImages = new Set();
    }
    // Run VS Code's image rule first — it populates env.containingImages, which the
    // preview uses to expand localResourceRoots, and rewrites /-rooted paths.
    let baseHtml: string;
    try {
      baseHtml = prevImage
        ? prevImage(tokens, idx, options, env, self)
        : self.renderToken(tokens, idx, options);
    } catch {
      // Upstream rule blew up on a missing env field — emit the bare token so the
      // rest of the document still renders.
      baseHtml = self.renderToken(tokens, idx, options);
    }

    const token = tokens[idx];
    const kind = token.meta?.medianoteMedia;
    if (kind !== 'audio' && kind !== 'video') return baseHtml;

    let src: string = token.attrGet('src') ?? '';
    const isAlreadyResolved = /^[a-z][a-z0-9+\-.]*:/i.test(src);
    const docUri: vscode.Uri | undefined = env?.currentDocument;
    const asWebviewUri: ((u: vscode.Uri) => vscode.Uri) | undefined = env?.resourceProvider?.asWebviewUri?.bind(env.resourceProvider);

    if (src && !isAlreadyResolved && docUri && asWebviewUri) {
      try {
        const docDir = path.posix.dirname(docUri.path);
        const absolutePath = path.posix.resolve(docDir, src);
        const absoluteUri = docUri.with({ path: absolutePath });
        src = asWebviewUri(absoluteUri).toString(true);
      } catch {
        // keep original src as fallback
      }
    }

    const cls = kind === 'audio' ? 'medianote-audio' : 'medianote-video';
    return `<${kind} controls preload="metadata" class="${cls}" src="${escapeAttr(src)}"></${kind}>`;
  };

  // `\tableofcontents`, `[toc]`, or `[TOC]` on its own line → a generated table of contents, rendered
  // only in the preview (and preview-based export). The directive is left as-is
  // in the source file; nothing is written to disk. Toggled by
  // `medianote.tableOfContents`.
  md.core.ruler.push('medianote_toc', (state: any) => {
    const enabled = vscode.workspace.getConfiguration('medianote').get<boolean>('tableOfContents', true);
    if (!enabled) return;
    const tokens: any[] = state.tokens;

    const headings: Heading[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type === 'heading_open') {
        const level = Number(tokens[i].tag.slice(1)); // 'h2' -> 2
        if (level >= 2) headings.push({ level, text: inlineText(tokens[i + 1]) }); // H1 is the title
      }
    }

    for (let i = 0; i < tokens.length; i++) {
      if (
        tokens[i].type === 'paragraph_open' &&
        tokens[i + 1]?.type === 'inline' &&
        tokens[i + 2]?.type === 'paragraph_close' &&
        isTocDirective(tokens[i + 1].content)
      ) {
        const toc = new state.Token('html_block', '', 0);
        toc.content = renderToc(headings) + '\n';
        toc.map = tokens[i].map;
        tokens.splice(i, 3, toc);
      }
    }
  });

  // Append a "Backlinks" section to the end of the document, listing the notes
  // that link to the one being previewed. This is a render-time feature — nothing
  // is written into the source file. The previewed note is identified from
  // env.currentDocument, which is populated for renderer rules in the live preview
  // but not in core/parse rules, so a core rule appends a placeholder token and the
  // renderer rule below fills it in. When env.currentDocument is absent (e.g.
  // `markdown.api.render` for export) or there are no backlinks, it renders nothing.
  md.core.ruler.push('medianote_backlinks', (state: any) => {
    state.tokens.push(new state.Token('medianote_backlinks', '', 0));
  });

  md.renderer.rules.medianote_backlinks = function (_tokens: any[], _idx: number, _options: any, env: any): string {
    const docUri: vscode.Uri | undefined = env?.currentDocument;
    if (!docUri) return '';
    const name = path.posix.basename(docUri.path, '.md');
    if (!name) return '';
    const docDir = path.posix.dirname(docUri.path);
    const docKey = docUri.toString();
    const seen = new Set<string>();
    const items: string[] = [];
    for (const note of index.backlinksFor(name).sort((a, b) => a.basename.localeCompare(b.basename))) {
      if (note.uri.toString() === docKey) continue; // ignore self-links
      const key = note.basename.toLowerCase();
      if (seen.has(key)) continue; // dedupe duplicate basenames
      seen.add(key);
      let href = path.posix.relative(docDir, note.uri.path);
      if (!href) href = path.posix.basename(note.uri.path);
      items.push(`<li><a href="${escapeAttr(href)}">${escapeHtml(note.basename)}</a></li>`);
    }
    if (!items.length) return '';
    return `\n<hr class="medianote-backlinks-sep">\n<section class="medianote-backlinks">\n<h2>Backlinks</h2>\n<ul>\n${items.join('\n')}\n</ul>\n</section>\n`;
  };
}

interface Heading {
  level: number;
  text: string;
}

// Plain-text content of a heading's inline token (drops emphasis/link markup).
function inlineText(inline: any): string {
  const children: any[] = inline?.children ?? [];
  if (!children.length) return (inline?.content ?? '').trim();
  let s = '';
  for (const c of children) {
    if (c.type === 'text' || c.type === 'code_inline') s += c.content;
    else if (c.type === 'softbreak' || c.type === 'hardbreak') s += ' ';
  }
  return s.trim();
}

// GitHub-style slug, close to VS Code's preview heading ids so ToC links jump.
// Not guaranteed identical for non-ASCII headings or duplicate-heading suffixes.
export function headingSlug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-');
}

// Recognized table-of-contents directives, each on its own line:
// `\tableofcontents`, `[toc]`, `[TOC]` (case-insensitive).
function isTocDirective(content: string): boolean {
  const t = content.trim().toLowerCase();
  return t === '\\tableofcontents' || t === '[toc]';
}

function renderToc(headings: Heading[]): string {
  const header = '<p class="medianote-toc-header">Table of Contents</p>';
  if (!headings.length) return `<nav class="medianote-toc">${header}</nav>`;
  const min = Math.min(...headings.map(h => h.level));
  let html = '';
  let depth = 0;
  const counters: number[] = []; // counters[d] = current number at nesting depth d+1
  for (const h of headings) {
    const rel = h.level - min + 1;
    if (rel > depth) {
      while (depth < rel) { html += '<ul>'; depth++; counters[depth - 1] = 0; }
    } else if (rel < depth) {
      html += '</li>';
      while (depth > rel) { html += '</ul></li>'; depth--; }
    } else {
      html += '</li>';
    }
    counters[rel - 1]++; // bump this level; deeper levels were reset when their <ul> opened
    const num = counters.slice(0, rel).join('.');
    html += `<li><a href="#${headingSlug(h.text)}"><span class="medianote-toc-num">${num}</span> ${escapeHtml(h.text)}</a>`;
  }
  while (depth > 0) { html += '</li></ul>'; depth--; }
  return `<nav class="medianote-toc">${header}${html}</nav>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function isWhitespace(ch: number): boolean {
  return ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d;
}
