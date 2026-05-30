import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';

export const AUDIO_EXTS = new Set([
  '.mp3',
  '.wav',
  '.m4a',
  '.ogg',
  '.oga',
  '.flac',
  '.aac',
  '.opus',
  '.webm',
]);

export const VIDEO_EXTS = new Set([
  '.mp4',
  '.mov',
  '.webm',
  '.mkv',
  '.m4v',
  '.ogv',
  '.avi',
]);

export const IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.avif',
  '.tiff',
  '.tif',
  '.ico',
]);

// Common document/data file types, for the "Insert File Link" picker filter.
// Not used for classification — any non-media/non-image/non-markdown file is
// treated as a linkable attachment regardless of extension.
export const DOC_EXTS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.csv',
  '.rtf',
  '.txt',
  '.odt',
  '.ods',
  '.odp',
  '.epub',
  '.pages',
  '.key',
  '.numbers',
  '.zip',
]);

export const AUDIO_EXT_LIST = [...AUDIO_EXTS].map(e => e.slice(1));
export const VIDEO_EXT_LIST = [...VIDEO_EXTS].map(e => e.slice(1));
export const IMAGE_EXT_LIST = [...IMAGE_EXTS].map(e => e.slice(1));
export const DOC_EXT_LIST = [...DOC_EXTS].map(e => e.slice(1));

export function isAudioPath(p: string): boolean {
  return AUDIO_EXTS.has(path.extname(p).toLowerCase());
}

export function isVideoPath(p: string): boolean {
  return VIDEO_EXTS.has(path.extname(p).toLowerCase());
}

export function isImagePath(p: string): boolean {
  return IMAGE_EXTS.has(path.extname(p).toLowerCase());
}

// `.webm` appears in both sets; treat ambiguous extensions as audio if the source mime
// says so, otherwise the caller decides. `isMediaPath` is just the union test.
export function isMediaPath(p: string): boolean {
  return isAudioPath(p) || isVideoPath(p);
}

export function withTimestamp(fileName: string, now: Date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext) || 'image';
  return `${stem}-${stamp}${ext || '.png'}`;
}

// Each note gets its own attachments folder, sitting beside the note in the
// same directory and named after it: `note.md` → `note.<attachmentsFolder>`
// (default `note.attachments`). This keeps a note's media self-contained — one
// folder per note rather than one folder shared by every note in the directory.
export function attachmentsFolderUri(docUri: vscode.Uri): vscode.Uri {
  const folder = vscode.workspace.getConfiguration('medianote').get<string>('attachmentsFolder', 'attachments');
  const docDir = vscode.Uri.joinPath(docUri, '..');
  const noteName = path.basename(docUri.fsPath, path.extname(docUri.fsPath));
  return folder ? vscode.Uri.joinPath(docDir, `${noteName}.${folder}`) : docDir;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function uniqueDestination(dir: vscode.Uri, fileName: string): Promise<vscode.Uri> {
  const safeName = fileName.replace(/[\\/:*?"<>|]/g, '-');
  const ext = path.extname(safeName);
  const stem = path.basename(safeName, ext);
  let candidate = vscode.Uri.joinPath(dir, safeName);
  let i = 1;
  while (await exists(candidate)) {
    candidate = vscode.Uri.joinPath(dir, `${stem}-${i}${ext}`);
    i++;
  }
  return candidate;
}

export async function copyToAttachments(
  srcUri: vscode.Uri,
  docUri: vscode.Uri,
  nameOverride?: string,
): Promise<vscode.Uri | undefined> {
  const dir = attachmentsFolderUri(docUri);
  await vscode.workspace.fs.createDirectory(dir);
  const dest = await uniqueDestination(dir, nameOverride ?? path.basename(srcUri.fsPath));
  const data = await vscode.workspace.fs.readFile(srcUri);
  await vscode.workspace.fs.writeFile(dest, data);
  await ensureMp3AudioForVideo(dest);
  return dest;
}

export async function saveBufferToAttachments(
  data: Uint8Array,
  docUri: vscode.Uri,
  fileName: string,
): Promise<vscode.Uri | undefined> {
  const dir = attachmentsFolderUri(docUri);
  await vscode.workspace.fs.createDirectory(dir);
  const dest = await uniqueDestination(dir, fileName);
  await vscode.workspace.fs.writeFile(dest, data);
  await ensureMp3AudioForVideo(dest);
  return dest;
}

type ProcResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; missing: true }
  | { ok: false; missing: false; code: number; stderr: string };

function runProcess(cmd: string, args: string[]): Promise<ProcResult> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = cp.spawn(cmd, args);
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (e.code === 'ENOENT') resolve({ ok: false, missing: true });
      else resolve({ ok: false, missing: false, code: -1, stderr: e.message });
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ ok: true, stdout, stderr });
      else resolve({ ok: false, missing: false, code: code ?? -1, stderr });
    });
  });
}

let warnedMissingTool = false;
function warnMissingTool(tool: 'ffprobe' | 'ffmpeg') {
  if (warnedMissingTool) return;
  warnedMissingTool = true;
  vscode.window.showWarningMessage(
    `MediaNote couldn't find ${tool} on PATH — video audio tracks won't be transcoded to MP3 automatically. Install ffmpeg to enable this.`,
  );
}

async function probeAudioCodec(filePath: string): Promise<{ codec: string | null; missing: boolean }> {
  const r = await runProcess('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'default=nw=1:nk=1',
    filePath,
  ]);
  if (!r.ok && r.missing) return { codec: null, missing: true };
  if (!r.ok) return { codec: null, missing: false };
  return { codec: r.stdout.trim() || null, missing: false };
}

async function transcodeAudioToMp3(srcPath: string, dstPath: string): Promise<'ok' | 'missing' | 'failed'> {
  const r = await runProcess('ffmpeg', [
    '-y',
    '-i', srcPath,
    '-c:v', 'copy',
    '-c:a', 'libmp3lame',
    '-b:a', '192k',
    '-movflags', '+faststart',
    dstPath,
  ]);
  if (!r.ok && r.missing) return 'missing';
  return r.ok ? 'ok' : 'failed';
}

export async function ensureMp3AudioForVideo(uri: vscode.Uri): Promise<void> {
  if (uri.scheme !== 'file') return;
  if (!isVideoPath(uri.fsPath)) return;

  const probe = await probeAudioCodec(uri.fsPath);
  if (probe.missing) { warnMissingTool('ffprobe'); return; }
  if (!probe.codec) return;
  if (probe.codec === 'mp3') return;

  const ext = path.extname(uri.fsPath);
  const stem = uri.fsPath.slice(0, uri.fsPath.length - ext.length);
  const tmpPath = `${stem}.medianote-mp3${ext}`;
  const tmpUri = vscode.Uri.file(tmpPath);

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Transcoding ${path.basename(uri.fsPath)} audio (${probe.codec} → mp3)…`,
      cancellable: false,
    },
    () => transcodeAudioToMp3(uri.fsPath, tmpPath),
  );

  if (result === 'missing') { warnMissingTool('ffmpeg'); return; }
  if (result === 'failed') {
    try { await vscode.workspace.fs.delete(tmpUri); } catch { /* tmp may not exist */ }
    vscode.window.showWarningMessage(
      `Couldn't transcode audio in ${path.basename(uri.fsPath)} to MP3. The file was kept as-is.`,
    );
    return;
  }

  try {
    await vscode.workspace.fs.rename(tmpUri, uri, { overwrite: true });
  } catch {
    try { await vscode.workspace.fs.delete(tmpUri); } catch { /* best effort */ }
    vscode.window.showWarningMessage(`Couldn't replace ${path.basename(uri.fsPath)} after transcoding.`);
  }
}

export function embedSnippetFor(destUri: vscode.Uri, currentDocUri: vscode.Uri): string {
  const docDir = path.dirname(currentDocUri.fsPath);
  const rel = path.relative(docDir, destUri.fsPath).split(path.sep).join('/');
  return `![[${rel}]]`;
}

export function imageEmbedSnippet(destUri: vscode.Uri, currentDocUri: vscode.Uri): string {
  const docDir = path.dirname(currentDocUri.fsPath);
  const rel = path.relative(docDir, destUri.fsPath).split(path.sep).join('/');
  const needsBrackets = /[\s()<>]/.test(rel);
  return needsBrackets ? `![](<${rel}>)` : `![](${rel})`;
}
