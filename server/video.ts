import { createHash } from 'node:crypto';
import { readdir, realpath, lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { MediaSummary } from '../shared/protocol.js';

export interface MediaFile extends MediaSummary {
  file: string; root: string; modified: number; subtitleFile?: string; subtitleRoot?: string;
}
export class MediaLibrary {
  items = new Map<string, MediaFile>();
  warnings: string[] = [];
  constructor(private directories: string[], private selectedFiles: string[] = [], private subtitles: Record<string, string> = {}) {}
  setSources(directories: string[], selectedFiles: string[], subtitles: Record<string, string> = {}) {
    this.directories = directories; this.selectedFiles = selectedFiles; this.subtitles = subtitles;
  }
  async scan() {
    const next = new Map<string, MediaFile>();
    const warnings: string[] = [];
    const add = async (file: string, root: string) => {
      const s = await lstat(file);
      if (!s.isFile() || s.isSymbolicLink() || !s.size || path.extname(file).toLowerCase() !== '.mp4') return;
      const canonical = await realpath(file);
      if (!inside(root, canonical)) return;
      const stem = path.parse(canonical).name;
      const candidate = this.subtitles[canonical] || this.subtitles[file] || path.join(root, `${stem}.vtt`);
      let subtitleFile: string | undefined, subtitleRoot: string | undefined;
      try {
        const stat = await lstat(candidate);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024) {
          subtitleFile = await realpath(candidate); subtitleRoot = path.dirname(subtitleFile);
        }
      } catch { /* A subtitle is optional. */ }
      const id = createHash('sha256').update(`${canonical}\0${s.size}\0${s.mtimeMs}`).digest('hex').slice(0, 24);
      next.set(id, { id, name: stem, size: s.size, subtitle: !!subtitleFile,
        file: canonical, root, modified: s.mtimeMs, subtitleFile, subtitleRoot });
    };
    for (const directory of this.directories) {
      try {
        const root = await realpath(directory);
        const entries = await readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.mp4') continue;
          await add(path.join(root, entry.name), root);
        }
      } catch { warnings.push(`无法读取媒体目录：${directory}`); }
    }
    for (const file of this.selectedFiles) {
      try { const canonical = await realpath(file); await add(file, path.dirname(canonical)); }
      catch { warnings.push(`影片无法读取，可能已移动或删除：${path.basename(file)}`); }
    }
    this.items = next;
    this.warnings = warnings;
    return this.list();
  }
  list(): MediaSummary[] {
    return [...this.items.values()].map(summary).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }
  async open(id: string, subtitle = false): Promise<{ handle: FileHandle; size: number; modified: number }> {
    const media = this.items.get(id);
    const file = subtitle ? media?.subtitleFile : media?.file;
    if (!media || !file) throw new Error('影片或字幕不存在，请房主刷新片库');
    const s = await lstat(file);
    const canonical = await realpath(file);
    if (!s.isFile() || s.isSymbolicLink() || !inside(subtitle ? media.subtitleRoot || media.root : media.root, canonical) || canonical !== file)
      throw new Error('文件不在允许共享的目录内');
    const handle = await open(file, 'r');
    try {
      const current = await handle.stat();
      if (!current.isFile() || (!subtitle && (current.size !== media.size || current.mtimeMs !== media.modified)))
        throw new Error('影片已改变，请房主刷新片库并重新选择');
      if (subtitle && current.size > 2 * 1024 * 1024) throw new Error('字幕文件过大');
      return { handle, size: current.size, modified: current.mtimeMs };
    } catch (error) { await handle.close(); throw error; }
  }
}
export function summary(m: MediaFile): MediaSummary {
  return { id: m.id, name: m.name, size: m.size, subtitle: m.subtitle };
}
function inside(root: string, file: string) {
  const relative = path.relative(root, file);
  return !!relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header || !header.startsWith('bytes=')) return null;
  // Multiple ranges are safely ignored; a full 200 response is permitted by HTTP.
  if (header.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return 'invalid';
  let start: number, end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start)
    return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}
