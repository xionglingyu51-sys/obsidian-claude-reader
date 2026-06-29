import { App, normalizePath, TFile } from "obsidian";
import { BookData, Highlight } from "./types";

const DATA_DIR = ".claude-reader";

export class BookStorage {
  constructor(private app: App) {}

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
      return JSON.parse(text) as BookData;
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

  async upsertHighlight(key: string, h: Highlight, title: string) {
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
    const i = data.highlights.findIndex((x) => x.id === h.id);
    if (i >= 0) data.highlights[i] = h;
    else data.highlights.push(h);
    await this.save(data);
  }

  async deleteHighlight(key: string, id: string) {
    const data = await this.load(key);
    if (!data) return;
    data.highlights = data.highlights.filter((x) => x.id !== id);
    await this.save(data);
  }
}

export async function bookKeyFor(file: TFile): Promise<string> {
  // 用 path + size 做 key,简单且稳定
  const safe = file.path.replace(/[^\w一-龥.-]/g, "_");
  return `${safe}-${file.stat.size}`;
}
