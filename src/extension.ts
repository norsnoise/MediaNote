import * as vscode from 'vscode';
import { NoteIndex } from './noteIndex';
import { BacklinksProvider } from './backlinksProvider';
import { TagsProvider } from './tagsProvider';
import { OutlineProvider } from './outlineProvider';
import {
  WikiLinkDefinitionProvider,
  WikiLinkCompletionProvider,
  WikiLinkDocumentLinkProvider,
  WikiLinkReferenceProvider,
  WikiLinkHoverProvider,
} from './wikiLinkProvider';
import { registerCommands } from './commands';
import { registerRenameHandler } from './renameHandler';
import { wikiLinksMarkdownPlugin } from './markdownPlugin';
import {
  MediaDocumentDropProvider,
  MediaDocumentPasteProvider,
  MEDIA_PASTE_KIND,
} from './mediaDropPaste';

export function activate(context: vscode.ExtensionContext) {
  const index = new NoteIndex();
  context.subscriptions.push(index);

  void writePreviewStylesheet(context);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('medianote.previewFont') || e.affectsConfiguration('medianote.previewCodeFont')) {
        void writePreviewStylesheet(context);
      }
    }),
  );

  const backlinks = new BacklinksProvider(index);
  const tags = new TagsProvider(index);
  const outline = new OutlineProvider(index);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('medianote.backlinks', backlinks),
    vscode.window.registerTreeDataProvider('medianote.tags', tags),
    vscode.window.registerTreeDataProvider('medianote.outline', outline),
    vscode.window.onDidChangeActiveTextEditor(() => backlinks.refresh()),
    index.onDidChange(() => {
      backlinks.refresh();
      tags.refresh();
      outline.refresh();
    }),
  );

  const mdSelector: vscode.DocumentSelector = { language: 'markdown', scheme: 'file' };
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(mdSelector, new WikiLinkDefinitionProvider(index)),
    vscode.languages.registerCompletionItemProvider(mdSelector, new WikiLinkCompletionProvider(index), '[', '#'),
    vscode.languages.registerDocumentLinkProvider(mdSelector, new WikiLinkDocumentLinkProvider(index)),
    vscode.languages.registerReferenceProvider(mdSelector, new WikiLinkReferenceProvider(index)),
    vscode.languages.registerHoverProvider(mdSelector, new WikiLinkHoverProvider(index)),
    vscode.languages.registerDocumentDropEditProvider(mdSelector, new MediaDocumentDropProvider(), {
      dropMimeTypes: ['text/uri-list', 'files', 'audio/*', 'video/*', 'image/*'],
      providedDropEditKinds: [MEDIA_PASTE_KIND],
    }),
    vscode.languages.registerDocumentPasteEditProvider(mdSelector, new MediaDocumentPasteProvider(), {
      pasteMimeTypes: ['text/uri-list', 'files', 'audio/*', 'video/*', 'image/*'],
      providedPasteEditKinds: [MEDIA_PASTE_KIND],
    }),
  );

  registerCommands(context, index);
  registerRenameHandler(context, index);

  // Kick off the initial index in the background.
  void index.scan();

  return {
    extendMarkdownIt(md: any) {
      return md.use((m: any) => wikiLinksMarkdownPlugin(m, index));
    },
  };
}

export function deactivate() {}

// VS Code only loads stylesheets listed in `contributes.markdown.previewStyles`
// (paths relative to the extension root). To make the font user-configurable,
// rewrite that file in place from `medianote.previewFont` at activation and on
// config change. The preview re-reads the file on each render.
async function writePreviewStylesheet(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration('medianote');
  const body = sanitizeFont(cfg.get<string>('previewFont', ''));
  const code = sanitizeFont(cfg.get<string>('previewCodeFont', ''));
  const rules: string[] = [];
  if (body) rules.push(`body { --markdown-font-family: ${body}; font-family: var(--markdown-font-family); }`);
  if (code) rules.push(`code, kbd, pre, pre code, tt, samp { font-family: ${code}; }`);
  // Styling for the generated Backlinks section (see markdownPlugin.ts). Constant,
  // not derived from settings — appended on every write so it survives font changes.
  rules.push(
    'hr.medianote-backlinks-sep { margin-top: 2.5em; }',
    'section.medianote-backlinks { font-size: 0.95em; }',
    'section.medianote-backlinks h2 { font-size: 1.05em; border: 0; }',
    'nav.medianote-toc .medianote-toc-header { font-weight: 600; margin: 0 0 0.3em; }',
    'nav.medianote-toc ul { list-style: none; }',
    'nav.medianote-toc .medianote-toc-num { color: var(--vscode-descriptionForeground, #6a737d); }',
  );
  const css = rules.join('\n') + '\n';
  const target = vscode.Uri.joinPath(context.extensionUri, 'media', 'preview.css');
  const desired = Buffer.from(css, 'utf8');
  // Skip the write when on-disk content already matches — keeps file mtime stable
  // across activations and avoids spurious working-tree diffs in git.
  try {
    const current = await vscode.workspace.fs.readFile(target);
    if (Buffer.from(current).equals(desired)) return;
  } catch {
    // File missing or unreadable — fall through and write below.
  }
  await vscode.workspace.fs.writeFile(target, desired);
}

function sanitizeFont(value: string): string {
  return value.trim().replace(/[^\w\s,'"\-.]/g, '');
}
