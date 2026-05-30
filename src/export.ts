import * as cp from 'child_process';
import { readFileSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export type ExportFormat = 'html' | 'pdf' | 'both';

export interface ExportDestination {
  htmlPath?: string;
  pdfPath?: string;
}

// Show a save dialog. Returns undefined if the user cancels. For "both", the
// dialog asks for the HTML path; the PDF is saved alongside with the same stem.
export async function pickExportDestination(
  docUri: vscode.Uri,
  format: ExportFormat,
): Promise<ExportDestination | undefined> {
  if (docUri.scheme !== 'file' || !docUri.fsPath) {
    void vscode.window.showErrorMessage(
      `Cannot export note with scheme '${docUri.scheme}'. Save the note to disk before exporting.`,
    );
    return undefined;
  }
  const dir = path.dirname(docUri.fsPath);
  const stem = path.basename(docUri.fsPath, path.extname(docUri.fsPath));

  if (format === 'html') {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(dir, `${stem}.html`)),
      filters: { HTML: ['html'] },
      saveLabel: 'Export HTML',
    });
    return target ? { htmlPath: target.fsPath } : undefined;
  }
  if (format === 'pdf') {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(dir, `${stem}.pdf`)),
      filters: { PDF: ['pdf'] },
      saveLabel: 'Export PDF',
    });
    return target ? { pdfPath: target.fsPath } : undefined;
  }
  // both
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(dir, `${stem}.html`)),
    filters: { HTML: ['html'] },
    saveLabel: 'Export HTML + PDF',
    title: 'Choose HTML path (PDF will be saved alongside)',
  });
  if (!target) return undefined;
  const htmlPath = target.fsPath;
  const sibDir = path.dirname(htmlPath);
  const sibStem = path.basename(htmlPath, path.extname(htmlPath));
  return { htmlPath, pdfPath: path.join(sibDir, `${sibStem}.pdf`) };
}

export async function exportNote(
  docUri: vscode.Uri,
  destination: ExportDestination,
  extensionUri: vscode.Uri,
): Promise<void> {
  try {
    await exportNoteInner(docUri, destination, extensionUri);
  } catch (err) {
    // Catch-all so silent rejections (anywhere past the render step) become a
    // visible error instead of "the command did nothing".
    const msg = err instanceof Error ? `${err.message}` : String(err);
    vscode.window.showErrorMessage(`MediaNote export failed: ${msg}`);
  }
}

async function exportNoteInner(
  docUri: vscode.Uri,
  destination: ExportDestination,
  extensionUri: vscode.Uri,
): Promise<void> {
  if (!destination.htmlPath && !destination.pdfPath) {
    throw new Error('No export destination specified.');
  }
  if (docUri.scheme !== 'file' || !docUri.fsPath) {
    throw new Error(`Cannot export note with scheme '${docUri.scheme}'.`);
  }
  const noteDir = path.dirname(docUri.fsPath);
  const noteStem = path.basename(docUri.fsPath, path.extname(docUri.fsPath));

  let bodyHtml: string;
  try {
    bodyHtml = await renderViaMarkdownApi(docUri);
  } catch (err) {
    throw new Error(`Could not render markdown: ${err instanceof Error ? err.message : String(err)}`);
  }
  bodyHtml = normalizeResourceUris(bodyHtml, noteDir);

  const katexCss = await loadInlineKatexCss(extensionUri);
  const fonts = readExportFonts();
  const html = wrapHtml(bodyHtml, noteStem, noteDir, katexCss, fonts);

  // PDF generation needs an HTML file on disk for the browser to load. Either
  // we write to the user's chosen HTML path, or we use a temp file for PDF-only.
  // For the temp case, create a fresh 0700 directory via mkdtemp so a local
  // attacker on a shared host can't pre-plant a symlink at a guessable path
  // and redirect our write.
  const chosenHtmlPath = destination.htmlPath;
  let htmlPath: string;
  let tempDir: string | undefined;
  if (chosenHtmlPath) {
    htmlPath = chosenHtmlPath;
  } else {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'medianote-'));
    htmlPath = path.join(tempDir, `${noteStem}.html`);
  }
  const cleanupTemp = async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    await fs.writeFile(htmlPath, html, 'utf8');
  } catch (err) {
    await cleanupTemp();
    throw new Error(`Could not write ${htmlPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (destination.pdfPath) {
    try {
      await renderPdf(htmlPath, destination.pdfPath);
    } catch (err) {
      await cleanupTemp();
      throw new Error(`PDF export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await cleanupTemp();

  const written: string[] = [];
  if (destination.htmlPath) written.push(path.basename(destination.htmlPath));
  if (destination.pdfPath) written.push(path.basename(destination.pdfPath));
  const msg = `Exported ${written.join(' and ')}`;
  const openTarget = destination.pdfPath ?? destination.htmlPath!;
  // Fire-and-forget: awaiting this would keep the surrounding `withProgress`
  // spinner up until the user clicks a button on the toast.
  void vscode.window.showInformationMessage(msg, 'Open', 'Reveal in Explorer').then(choice => {
    if (choice === 'Open') {
      void vscode.env.openExternal(vscode.Uri.file(openTarget));
    } else if (choice === 'Reveal in Explorer') {
      void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(openTarget));
    }
  });
}

export interface ExportFonts {
  body: string;
  code: string;
}

// Mirrors the sanitization in extension.ts so a setting that produced a working
// preview also produces a working export — and an unsafe value can't break the CSS.
export function readExportFonts(): ExportFonts {
  const cfg = vscode.workspace.getConfiguration('medianote');
  return {
    body: sanitizeFont(cfg.get<string>('previewFont', '')),
    code: sanitizeFont(cfg.get<string>('previewCodeFont', '')),
  };
}

function sanitizeFont(value: string): string {
  return value.trim().replace(/[^\w\s,'"\-.]/g, '');
}

function wrapHtml(body: string, title: string, noteDir: string, katexCss: string, fonts: ExportFonts): string {
  // <base href> lets relative paths (images, audio/video, other notes) resolve
  // against the original note's directory, so the standalone HTML works without
  // copying attachments.
  const baseHref = pathToFileUri(noteDir) + '/';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<base href="${escapeAttr(baseHref)}">
<style>${katexCss}</style>
<style>
  body { font-family: ${fonts.body || '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif'};
         max-width: 780px; margin: 2.2em auto; padding: 0 1.2em; line-height: 1.55; color: #1f2328; }
  h1, h2, h3, h4 { line-height: 1.25; margin-top: 1.6em; }
  h1 { border-bottom: 1px solid #d0d7de; padding-bottom: 0.3em; }
  h2 { border-bottom: 1px solid #d0d7de; padding-bottom: 0.2em; }
  a { color: #0969da; }
  code, kbd, pre, pre code, tt, samp { font-family: ${fonts.code || 'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace'};
                              font-size: 0.92em; }
  code { background: #f6f8fa; padding: 0.15em 0.35em; border-radius: 3px; }
  pre { background: #f6f8fa; padding: 0.9em 1em; border-radius: 6px; overflow-x: auto; }
  pre code { background: transparent; padding: 0; }
  blockquote { border-left: 3px solid #d0d7de; margin: 0; padding: 0 1em; color: #57606a; }
  img, video, audio { max-width: 100%; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #d0d7de; padding: 0.4em 0.7em; }
  hr { border: 0; border-top: 1px solid #d0d7de; margin: 1.6em 0; }
  /* matches markdownPlugin.ts class for embedded wiki-link anchors */
  a.medianote-wikilink { color: #6f42c1; }
  /* matches markdownPlugin.ts table-of-contents numbering */
  nav.medianote-toc ul { list-style: none; }
  nav.medianote-toc .medianote-toc-num { color: #6a737d; }
  @media print {
    body { max-width: none; margin: 0; padding: 0; }
    a { color: inherit; text-decoration: none; }
    pre, blockquote { page-break-inside: avoid; }
  }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

// VS Code's preview engine rewrites image src to vscode-resource: URIs or file://
// paths with extra query strings. Convert those back to plain relative paths from
// the note directory so the <base href>-anchored HTML can find them.
export function normalizeResourceUris(html: string, noteDir: string): string {
  return html.replace(/\b(src|href)=("|')([^"']+)\2/g, (match, attr, quote, value: string) => {
    const cleaned = unwrapResource(value, noteDir);
    if (cleaned === undefined) return match;
    return `${attr}=${quote}${cleaned}${quote}`;
  });
}

function unwrapResource(value: string, noteDir: string): string | undefined {
  // Leave fragments and mailto alone.
  if (value.startsWith('#') || value.startsWith('mailto:')) {
    return undefined;
  }

  let target: string | undefined;
  if (value.startsWith('vscode-resource:')) {
    target = decodeURI(value.replace(/^vscode-resource:(\/\/[^/]+)?/, ''));
  } else if (/^vscode-webview-resource:/i.test(value) || /\.vscode-cdn\.net\//i.test(value)) {
    // VS Code webview resource URI (e.g. https://file+.vscode-resource.vscode-cdn.net/abs/path).
    // Must run BEFORE the generic https check — its path component is the real file path.
    try {
      target = uriPathToFsPath(vscode.Uri.parse(value));
    } catch {
      return undefined;
    }
  } else if (value.startsWith('file://')) {
    try {
      target = vscode.Uri.parse(value).fsPath;
    } catch {
      return undefined;
    }
  } else if (/^https?:\/\//i.test(value)) {
    return undefined; // genuine external URL — leave alone
  } else {
    return undefined;
  }

  if (!target) return undefined;
  const rel = path.relative(noteDir, target).split(path.sep).join('/');
  // Preserve any query/hash that survived parsing.
  return /[\s()<>"']/.test(rel) ? encodeURI(rel) : rel;
}

// The path component of a webview-resource URI is the underlying file path
// (with a leading slash before a Windows drive letter, which we strip).
function uriPathToFsPath(u: vscode.Uri): string {
  let p = decodeURIComponent(u.path);
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  return p;
}

// `markdown.api.render` has shipped with a few different signatures across VS
// Code versions: some accept a TextDocument, some a Uri, some only a markdown
// string. Worse, when given a Uri the engine sometimes constructs an `env` that
// is missing the `containingImages` Set that VS Code's own image renderer adds
// to during rendering — which surfaces as a misleading
// "Cannot read properties of undefined (reading 'toString')" from deep inside
// the engine. Try each signature until one returns HTML.
export async function renderViaMarkdownApi(docUri: vscode.Uri): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(docUri);
  const attempts: Array<{ label: string; arg: unknown }> = [
    { label: 'TextDocument', arg: doc },
    { label: 'Uri', arg: docUri },
    { label: 'markdown text', arg: doc.getText() },
  ];
  const errors: string[] = [];
  for (const { label, arg } of attempts) {
    try {
      const out = await vscode.commands.executeCommand<string>('markdown.api.render', arg);
      if (typeof out === 'string' && out.length > 0) return out;
      errors.push(`${label} → returned ${typeof out}`);
    } catch (err) {
      errors.push(`${label} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`markdown.api.render failed for every supported call form:\n  ${errors.join('\n  ')}`);
}

// Read KaTeX's bundled stylesheet from node_modules and rewrite every @font-face
// `src:` block to use a base64 woff2 data URI, so exported HTML/PDF renders
// math correctly without any network access. The woff fallback formats are
// stripped — every Chromium that does --print-to-pdf supports woff2.
let cachedKatexCss: string | undefined;
export async function loadInlineKatexCss(extensionUri: vscode.Uri): Promise<string> {
  if (cachedKatexCss !== undefined) return cachedKatexCss;
  const distDir = path.join(extensionUri.fsPath, 'node_modules', 'katex', 'dist');
  let css: string;
  try {
    css = await fs.readFile(path.join(distDir, 'katex.min.css'), 'utf8');
  } catch (err) {
    throw new Error(
      `Could not read bundled KaTeX CSS (${path.join(distDir, 'katex.min.css')}). ` +
      `Run \`npm install\` in the extension folder. Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const fontCache = new Map<string, string>();
  // Match the multi-format src list KaTeX ships:
  //   src:url(fonts/X.woff2) format("woff2"),url(fonts/X.woff) format("woff"),url(fonts/X.ttf) format("truetype")
  // and replace with a single woff2 data URI. Falls through (leaves CSS untouched)
  // for any @font-face we don't recognize.
  const replaced = css.replace(
    /src:\s*url\(\s*fonts\/([^)]+\.woff2)\s*\)[^;}]*/g,
    (_match, woff2File: string) => {
      let dataUri = fontCache.get(woff2File);
      if (!dataUri) {
        try {
          const fontPath = path.join(distDir, 'fonts', woff2File);
          // Synchronous read keeps us inside string.replace; fonts are small
          // (~5–30KB each) and the whole loop runs once per session behind cachedKatexCss.
          const buf = readFileSync(fontPath);
          dataUri = `data:font/woff2;base64,${buf.toString('base64')}`;
          fontCache.set(woff2File, dataUri);
        } catch {
          return _match; // keep original; will fail offline but stay valid CSS
        }
      }
      return `src:url(${dataUri}) format("woff2")`;
    },
  );

  cachedKatexCss = replaced;
  return cachedKatexCss;
}

async function renderPdf(htmlPath: string, pdfPath: string): Promise<void> {
  const browser = await findBrowser();
  if (!browser) {
    throw new Error(
      'No Chrome/Chromium binary found. Install Chrome/Chromium or set `medianote.exportPdfBrowserPath` in settings.',
    );
  }

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`,
    pathToFileUri(htmlPath),
  ];
  // --no-sandbox is required when running Chromium as root (common in CI/containers).
  if (process.getuid && process.getuid() === 0) args.unshift('--no-sandbox');

  await new Promise<void>((resolve, reject) => {
    cp.execFile(browser, args, { timeout: 60_000 }, (err, _stdout, stderr) => {
      if (err) {
        const detail = stderr?.toString().trim();
        reject(new Error(detail ? `${err.message}\n${detail}` : err.message));
      } else {
        resolve();
      }
    });
  });
}

async function findBrowser(): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration('medianote').get<string>('exportPdfBrowserPath', '').trim();
  if (configured) {
    return (await fileExists(configured)) ? configured : undefined;
  }

  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
            '/usr/bin/microsoft-edge',
          ];
  for (const p of candidates) {
    if (await fileExists(p)) return p;
  }
  return undefined;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function pathToFileUri(p: string): string {
  return vscode.Uri.file(p).toString();
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}
