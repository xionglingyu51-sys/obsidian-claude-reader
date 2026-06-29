import { App, normalizePath, TFile } from "obsidian";
import {
  Annotation,
  BookData,
  LegacyHighlight,
} from "./types";

const DATA_DIR = ".claude-reader";

/** 用于通知插件 "annotation 改了" 的回调 */
export type AnnotationChangeListener = (data: BookData) => void;

export class BookStorage {
  private listeners: Set<AnnotationChangeListener> = new Set();

  constructor(private app: App) {}

  onAnnotationChanged(listener: AnnotationChangeListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private fire(data: BookData) {
    for (const l of this.listeners) {
      try {
        l(data);
      } catch {}
    }
  }

  async ensureDir() {
    if (!(await this.app.vault.adapter.exists(DATA_DIR))) {
      await this.app.vault.adapter.mkdir(DATA_DIR);
    }
  }

  private fileFor(key: string): string {
    return normalizePath(`${DATA_DIR}/${key}.json`);
  }

  async load(key: string): Promise<BookData | null> {
    const path = this.fileFor(key);
    if (!(await this.app.vault.adapter.exists(path))) return null;
    try {
      const text = await this.app.vault.adapter.read(path);
      const raw = JSON.parse(text) as any;
      return migrate(raw);
    } catch {
      return null;
    }
  }

  async save(data: BookData) {
    await this.ensureDir();
    await this.app.vault.adapter.write(
      this.fileFor(data.bookKey),
      JSON.stringify(data, null, 2)
    );
  }

  async upsertAnnotation(key: string, a: Annotation, title: string) {
    let data = await this.load(key);
    if (!data) {
      data = {
        bookKey: key,
        title,
        highlights: [],
        progress: null,
        lastOpenedAt: Date.now(),
        readingSeconds: 0,
      };
    }
    const i = data.highlights.findIndex((x) => x.id === a.id);
    if (i >= 0) data.highlights[i] = a;
    else data.highlights.push(a);
    await this.save(data);
    this.fire(data);
  }

  /** 兼容旧 API */
  async upsertHighlight(key: string, a: Annotation, title: string) {
    return this.upsertAnnotation(key, a, title);
  }

  async deleteAnnotation(key: string, id: string) {
    const data = await this.load(key);
    if (!data) return;
    data.highlights = data.highlights.filter((x) => x.id !== id);
    await this.save(data);
    this.fire(data);
  }

  async deleteHighlight(key: string, id: string) {
    return this.deleteAnnotation(key, id);
  }
}

/** 旧数据 (v0.x note?: string) → 新数据 (note 是独立 kind) */
function migrate(raw: any): BookData {
  const highlights: Annotation[] = [];
  for (const h of raw.highlights ?? []) {
    if (h.kind === "highlight" || h.kind === "note") {
      // 新版本数据,补缺省字段
      highlights.push({
        ...h,
        style: h.style ?? "fill",
        updatedAt: h.updatedAt ?? h.createdAt ?? Date.now(),
      });
      continue;
    }
    // 旧版本数据
    const legacy = h as LegacyHighlight;
    const base = {
      id: legacy.id,
      chapterId: legacy.chapterId,
      startPath: legacy.startPath,
      startOffset: legacy.startOffset,
      endPath: legacy.endPath,
      endOffset: legacy.endOffset,
      text: legacy.text,
      color: legacy.color,
      style: "fill" as const,
      createdAt: legacy.createdAt,
      updatedAt: legacy.createdAt,
    };
    if (legacy.note && legacy.note.trim()) {
      highlights.push({
        ...base,
        kind: "note",
        note: legacy.note,
        noteType: "insight",
      });
    } else {
      highlights.push({ ...base, kind: "highlight" });
    }
  }
  return {
    ...raw,
    highlights,
  };
}

export async function bookKeyFor(file: TFile): Promise<string> {
  const safe = file.path.replace(/[^\w一-龥.-]/g, "_");
  return `${safe}-${file.stat.size}`;
}
