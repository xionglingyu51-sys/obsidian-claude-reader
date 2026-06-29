import { App, normalizePath, TFile } from "obsidian";
import { Annotation, BookData, COLORS, NOTE_TYPES } from "./types";

const DEFAULT_FOLDER = "Reading Notes";

export interface ExportSettings {
  exportFolder: string;
}

/**
 * 把一本书的所有笔记导出 / 同步到一篇 markdown。
 *
 * 文件路径: <exportFolder>/<bookTitle>.md
 * 每条 annotation 一个 callout 块, 带:
 *   - 颜色 callout 类型 (claude-yellow / claude-green / claude-pink / claude-blue)
 *   - 原文引用
 *   - 笔记 (如果是 note 类型)
 *   - 隐藏元数据 (id / chapter / cfi) 用 HTML 注释保存,便于将来回链与去重
 *   - 跳回原文链接 obsidian://claude-reader-jump?book=...&id=...
 */
export async function exportBookNotes(
  app: App,
  data: BookData,
  bookFile: TFile | null,
  settings: ExportSettings
): Promise<TFile> {
  const folder = settings.exportFolder || DEFAULT_FOLDER;
  await ensureFolder(app, folder);

  const filename = sanitizeFilename(data.title || "未命名") + ".md";
  const path = normalizePath(`${folder}/${filename}`);

  const md = renderMarkdown(data, bookFile);

  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await app.vault.modify(existing, md);
    return existing;
  }
  return await app.vault.create(path, md);
}

function renderMarkdown(data: BookData, bookFile: TFile | null): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`book: "${escapeYaml(data.title)}"`);
  if (bookFile) lines.push(`source: "[[${bookFile.path}]]"`);
  lines.push(`bookKey: "${data.bookKey}"`);
  lines.push(`updated: ${new Date().toISOString()}`);
  lines.push(`count: ${data.highlights.length}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${data.title}`);
  lines.push("");
  if (data.highlights.length === 0) {
    lines.push("_还没有划线和笔记。_");
    return lines.join("\n");
  }

  // 按章节分组
  const byChapter = new Map<string, Annotation[]>();
  for (const a of data.highlights) {
    const list = byChapter.get(a.chapterId) || [];
    list.push(a);
    byChapter.set(a.chapterId, list);
  }
  // 同章按 createdAt 升序
  for (const list of byChapter.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt);
  }

  for (const [chapterId, list] of byChapter) {
    lines.push(`## ${chapterTitleFor(data, chapterId, list[0])}`);
    lines.push("");
    for (const a of list) {
      lines.push(renderAnnotation(a, data));
      lines.push("");
    }
  }
  return lines.join("\n");
}

function chapterTitleFor(
  _data: BookData,
  chapterId: string,
  sample: Annotation
): string {
  return sample.chapterTitle || chapterId || "章节";
}

function renderAnnotation(a: Annotation, data: BookData): string {
  const out: string[] = [];
  const calloutType = `claude-${a.color}`;
  const headerEmoji =
    a.kind === "note"
      ? NOTE_TYPES.find((t) => t.value === a.noteType)?.emoji || "📝"
      : "·";
  out.push(`> [!${calloutType}] ${headerEmoji}`);

  // 原文 (多行兼容)
  const quoted = a.text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  out.push(quoted);

  // 笔记
  if (a.kind === "note" && a.note.trim()) {
    out.push(">");
    const note = a.note
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    out.push(note);
  }

  // 跳回原文的 link 与元数据 (HTML 注释,visible 但不抢戏)
  const params = new URLSearchParams({
    book: data.bookKey,
    id: a.id,
  });
  const jumpUrl = `obsidian://claude-reader-jump?${params.toString()}`;
  out.push(">");
  out.push(`> [↩ 回到原文](${jumpUrl})`);
  out.push(
    `<!-- claude-reader id=${a.id} chapter=${a.chapterId} color=${a.color} kind=${a.kind} -->`
  );
  return out.join("\n");
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  const norm = normalizePath(folder);
  if (await app.vault.adapter.exists(norm)) return;
  await app.vault.createFolder(norm);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "未命名";
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"');
}
