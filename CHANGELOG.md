# Change Log

All notable changes to the MediaNote extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1]

### Changed

- Attachments now live in a **per-note** folder named after the note
  (`note.md` → `note.attachments/`, beside the note), instead of one
  `attachments/` folder shared by every note in the directory. The
  `medianote.attachmentsFolder` setting is now the suffix for that folder
  (`<note>.<attachmentsFolder>`).

### Fixed

- Renaming a note now also renames its per-note attachments folder
  (`note.attachments` → `renamed.attachments`) and rewrites every reference to
  the files inside it, so links stay intact.

## [0.1.0]

Initial release.

### Added

- `[[wiki-links]]` with case-insensitive, basename-based resolution, `#section`
  and `|alias` support, plus go-to-definition, completion, hover, and reference
  providers in the editor.
- Backlinks, surfaced both in an activity-bar tree view and as a generated
  `## Backlinks` section in the Markdown preview.
- `#tags` (including nested `#proj/sub-task`) with a Tags tree view and
  search-by-tag command.
- Activity-bar views: Notes outline, Backlinks, and Tags.
- Attachments: drag, drop, paste, or use a single **Insert Link** command
  (`Ctrl/Cmd+Alt+L`) that auto-detects the file type — audio/video become
  `![[embeds]]`, images become `![](links)`, notes become `[[wiki-links]]`, and
  other files become plain `[name](path)` links. Files from outside the
  workspace are copied into a per-note attachments folder.
- Markdown preview integration via VS Code's built-in preview: wiki-links,
  media embeds, image sizing, math (via VS Code's built-in Markdown math), and
  an opt-in table of contents (`\tableofcontents`, `[toc]`, `[TOC]`).
- Export to self-contained HTML (with inlined KaTeX fonts) and PDF via headless
  Chrome/Chromium/Edge.
- Create-note-from-broken-link, new-note command, and configurable note and
  attachment folders.
