# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MediaNote — a VS Code extension that adds Obsidian-style note-taking on top of plain markdown files in the user's workspace: `[[wiki-links]]`, backlinks, `#tags`. There is no separate database; the workspace's `.md` files *are* the vault.

## Commands

- `npm run compile` — one-shot `tsc -p ./` to `out/`. This is also the `vscode:prepublish` step and the default build task referenced by `.vscode/tasks.json`.
- `npm run watch` — incremental compile during development.
- Debug the extension by pressing **F5** in VS Code (uses `.vscode/launch.json`, runs the `npm: compile` preLaunchTask, then opens a new Extension Development Host with this extension loaded).

There is no test runner, linter, or formatter wired up. Type checking happens via `strict: true` in `tsconfig.json` — treat `tsc` as the correctness gate.

## Architecture

The extension is small (~8 files in `src/`) but has one piece of shared state that everything else hangs off of: **`NoteIndex`** in `src/noteIndex.ts`. Understanding it is most of the architecture.

### `NoteIndex` is the single source of truth

- On `activate()`, `extension.ts` constructs one `NoteIndex`, kicks off `index.scan()` in the background, and passes the same instance into every provider and command.
- The index maintains two parallel maps: `byUri` (keyed by `uri.toString()`) and `byKey` (keyed by lowercased basename). Wiki-link resolution is **basename-based and case-insensitive** — `[[Foo]]` matches `Foo.md` anywhere in the workspace. If two files share a basename, the most recently indexed one wins in `byKey`. Anything that needs basename-keyed lookup goes through `resolve()` / `backlinksFor()` / `notesWithTag()`.
- A `FileSystemWatcher('**/*.md')` plus `onDidSaveTextDocument` keeps the index fresh. After any change the index calls `scheduleFire()`, which debounces a single `onDidChange` event by 100ms so the three tree views and any other listeners refresh once per burst rather than per file.
- `scan()` honors the `medianote.exclude` glob (default `**/node_modules/**`).

### Providers consume the index, never bypass it

Three tree views (`OutlineProvider`, `BacklinksProvider`, `TagsProvider`) and five language providers in `wikiLinkProvider.ts` (Definition / Completion / DocumentLink / Reference / Hover) all read from `NoteIndex`. They subscribe to `index.onDidChange` (tree views) or are queried on-demand by VS Code (language providers). `extension.ts` is the only place these are wired up.

### Wiki-link regex lives in two places — keep them in sync

- `src/noteIndex.ts` has `LINK_RE` for **indexing**: it captures only the link target (group 1) and is run after stripping fenced code blocks via `CODE_FENCE_RE`.
- `src/wikiLinkProvider.ts` has its own `LINK_RE` for **editor interactions**: it captures target / section / alias (groups 1–3) so providers can show "Foo › section" in hovers and respect `[[Foo|alias]]`.

Both implement the same `[[target(#section)?(|alias)?]]` grammar. If you change link syntax, change both. The reference provider also builds a third regex per-call to find references to a specific basename.

### Tag grammar

`TAG_RE` in `noteIndex.ts` requires a leading boundary `(^|[\s>(`])` before `#`, so `#tag` after whitespace counts but `foo#tag` (likely a URL fragment or markdown heading anchor) does not. Tags must start with a letter and may contain `\w/-` (so `#proj/sub-task` is valid). Code fences are stripped before tag scanning.

### Markdown preview integration

`activate()` returns an object with `extendMarkdownIt(md)` — VS Code's built-in markdown preview calls this (because of `"markdown.markdownItPlugins": true` in `package.json`) and hands us its markdown-it instance. `markdownPlugin.ts` registers an inline rule **before `link`** so `[[Foo|alias]]` becomes a real `<a class="medianote-wikilink" href="#Foo">alias</a>` in the rendered HTML. This is purely cosmetic — preview links jump within the document; the real "open note" wiring is via the `DocumentLinkProvider` in the editor.

### Creating notes from broken links

When a wiki-link's target doesn't resolve to an existing note, `WikiLinkDocumentLinkProvider` emits a `command:medianote.createFromLink?<encoded-args>` URI instead of a file URI. Clicking it invokes the `medianote.createFromLink` command (registered in `commands.ts`) which writes a new `.md` file under `medianote.newNoteFolder` and opens it. `medianote.createFromLink` is hidden from the command palette via the `commandPalette` menu contribution because it requires arguments.

### Attachments and file links

`src/attachments.ts` + `src/mediaDropPaste.ts` handle dropping, pasting, and inserting files. Audio/video become `![[file]]` embeds and images become `![](file)`; everything else (doc/ppt/xls/pdf/zip/…) becomes a plain `[name](path)` link. Files dragged/pasted from outside the workspace — or chosen via the single **MediaNote: Insert Link** command (`medianote.insertLink`, `Ctrl/Cmd+Alt+L`), which lets you pick a note or browse for any file and auto-detects its kind — are copied into the per-note attachments folder (each note gets its own folder beside it, named `<note>.<medianote.attachmentsFolder>` — so `note.md` uses `note.attachments/` by default) so links stay portable; files already inside the vault are linked in place. Classification is by extension/MIME via `classify()` in `mediaDropPaste.ts` (the catch-all is kind `'other'`); the drop/paste providers are registered in `extension.ts` with the `files` mime so any file type triggers them.

MediaNote inserts and links such files but does **not** open them — VS Code has no built-in viewer for PDFs/Office documents, and clicking a `[name](path)` link uses VS Code's own handling.

`src/renameHandler.ts` (registered in `extension.ts`, fires on `onWillRenameFiles`) keeps links healthy when files are renamed: it rewrites `[[wiki-links]]` to a renamed note (via `index.backlinksFor`), rewrites path-based references (`![[path]]`, `[text](path)`, `![](path)`) to any renamed file, and — for note renames — renames the note's per-note attachments folder to match (`note.attachments` → `renamed.attachments`) and rewrites every reference to a file inside it (`collectAttachmentsFolderRename`). The folder rename is skipped when the folder doesn't exist, when `medianote.attachmentsFolder` is empty (attachments sit alongside the note), or when the target folder name is already taken.

### Backlinks

Backlinks are **never written into note files**. They surface two ways, both read from `index.backlinksFor(basename)`:

- The `BacklinksProvider` tree view in the activity bar, refreshed on `index.onDidChange` / active-editor change.
- A generated `## Backlinks` `<section>` appended to the **built-in Markdown preview**, via the `medianote_backlinks` rule in `markdownPlugin.ts`. A core rule pushes a placeholder `medianote_backlinks` token at the end of the document; the matching renderer rule fills it using `env.currentDocument` (only populated for renderer rules, not core rules) to identify the previewed note, emitting relative `.md` links the preview navigates on click. Renders nothing when `env.currentDocument` is absent (e.g. `markdown.api.render` for export) or there are no backlinks; self-links and duplicate basenames are filtered. Styling lives in the generated `media/preview.css` (see `writePreviewStylesheet`). Consequence: the preview only re-computes backlinks when the previewed note itself re-renders (edit/save/reopen) — not when *another* note adds a link to it; the tree view updates live.

### Table of contents (preview-only, opt-in)

A standalone table-of-contents directive line — `\tableofcontents`, `[toc]`, or `[TOC]` (case-insensitive, recognized via `isTocDirective()`) — renders a table of contents **in the preview only**; the source file is never modified, the directive stays as written. It's a markdown-it core rule (`medianote_toc`) in `markdownPlugin.ts`: after parsing, it collects the document's level-2+ headings (H1 is the title) and replaces any paragraph whose content is exactly one of those directives with a generated `<nav class="medianote-toc">` containing a "Table of Contents" header (`<p class="medianote-toc-header">`) and an auto-numbered nested list. Entries are numbered hierarchically (`1`, `1.1`, `1.2`, `2`, …) by `renderToc`, which emits each number in a `<span class="medianote-toc-num">` — the numbers live in the HTML (not CSS counters) so they render identically in the preview and in export. Heading anchors use a GitHub-style slug to match VS Code's preview heading ids (best-effort — not guaranteed for non-ASCII or duplicate headings). Because it runs at render time, the ToC also appears in HTML/PDF export (which renders via the preview engine). Styling for the header and numbers lives in both `writePreviewStylesheet` (`extension.ts`) and the export `<style>` block (`export.ts`). Toggled by `medianote.tableOfContents` (default `true`); when off, the directive is left as plain text.

### Export (HTML / PDF)

`src/export.ts` adds the `medianote.exportNote` command. The pipeline:

1. Call `vscode.commands.executeCommand('markdown.api.render', docUri)` — this reuses VS Code's preview engine, so our `wikiLinksMarkdownPlugin` runs and `markdown.math.enabled` produces KaTeX-ready HTML.
2. Strip preview-only `vscode-resource:` / `vscode-webview-resource:` / absolute `file://` rewrites that the engine sometimes applies, leaving plain relative paths from the note's directory.
3. Wrap in a standalone HTML document with a `<base href>` pointing to the note's directory (so attachments resolve without copying), an inlined offline copy of KaTeX's stylesheet, and a print stylesheet.
4. For PDF: write the HTML to a temp file (or the user-chosen `.html` if they asked for both), then spawn the user's Chrome/Chromium/Edge with `--headless=new --print-to-pdf=<dest>`. The browser path is auto-detected across platform defaults and overridable via `medianote.exportPdfBrowserPath`.

KaTeX is bundled as a runtime dependency (`node_modules/katex/dist/`). `loadInlineKatexCss()` reads `katex.min.css` once per session, rewrites every `src:url(fonts/X.woff2) format(...),url(...).woff,url(...).ttf` block into a single `src:url(data:font/woff2;base64,...) format("woff2")` data URI, and caches the result (~360 KB). woff/ttf fallbacks are dropped because every Chromium that supports `--print-to-pdf` also supports woff2. The result: exported HTML/PDF renders math correctly with **no network access** — and the HTML file is fully self-contained, safe to email or move offline.

The HTML file is saved next to the source note (`foo.md` → `foo.html`). If only PDF was requested, no `.html` is left behind.

### Preview

MediaNote does **not** ship its own preview. It hooks VS Code's built-in Markdown preview (`Ctrl/Cmd+Shift+V`) via the `extendMarkdownIt(md)` object returned from `activate()`, so wiki-links, audio/video embeds, image sizing, KaTeX math, and `\tableofcontents` all render there. Wiki-links become real `.md` anchors (`markdownPlugin.ts`), and the built-in preview navigates them on click using its own link handling. Preview fonts come from `medianote.previewFont` / `medianote.previewCodeFont` written into `media/preview.css` (see `writePreviewStylesheet` in `extension.ts`).

A previous custom webview preview (`src/preview.ts`, `medianote.openPreview`) was removed; backlinks, which it also rendered, are back via the `medianote_backlinks` markdown-it rule (see above).

## Configuration surface

Defined in `package.json` under `contributes.configuration`:

- `medianote.newNoteFolder` (default `""` = workspace root)
- `medianote.attachmentsFolder` (default `attachments` — suffix for each note's own attachments folder, `<note>.<attachmentsFolder>`; where dropped/inserted files are copied; see "Attachments and file links")
- `medianote.tableOfContents` (default `true` — render a ToC in the preview where a note has a `\tableofcontents`, `[toc]`, or `[TOC]` line; see "Table of contents")
- `medianote.exclude` (default `**/node_modules/**`)
- `medianote.exportPdfBrowserPath` (default `""` = auto-detect Chrome/Chromium/Edge)

When adding a new setting, also read it via `vscode.workspace.getConfiguration('medianote')` at the call site — there is no central config wrapper.
