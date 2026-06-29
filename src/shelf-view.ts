import { ItemView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type ClaudeReaderPlugin from "./main";
import { bookKeyFor } from "./storage";

export const VIEW_TYPE_SHELF = "claude-reader-shelf-view";

function formatReadingTime(seconds: number): string {
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest > 0 ? `${h}h ${rest}min` : `${h}h`;
}

export class BookshelfView extends ItemView {
  plugin: ClaudeReaderPlugin;
  rootEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeReaderPlugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_SHELF;
  }
  getDisplayText() {
    return "书架";
  }
  getIcon() {
    return "library";
  }

  async onOpen() {
    this.rootEl = this.containerEl.children[1] as HTMLElement;
    this.rootEl.empty();
    this.rootEl.addClass("cr-shelf-root");
    await this.render();

    this.registerEvent(this.app.vault.on("create", () => this.render()));
    this.registerEvent(this.app.vault.on("delete", () => this.render()));
    this.registerEvent(this.app.vault.on("rename", () => this.render()));
  }

  async render() {
    if (!this.rootEl) return;
    this.rootEl.empty();
    const header = this.rootEl.createDiv({ cls: "cr-shelf-header" });
    header.createSpan({ text: "书架", cls: "cr-shelf-title" });

    const books = this.app.vault
      .getFiles()
      .filter((f) =>
        ["epub", "mobi", "azw3", "txt"].includes(f.extension.toLowerCase())
      )
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

    const grid = this.rootEl.createDiv({ cls: "cr-shelf-grid" });
    if (books.length === 0) {
      grid.createDiv({
        cls: "cr-shelf-empty",
        text: "vault 里没有 EPUB / MOBI / TXT。把书拖进任意文件夹即可。",
      });
      return;
    }
    for (const file of books) {
      const card = grid.createDiv({ cls: "cr-shelf-card" });
      const cover = card.createDiv({ cls: "cr-shelf-cover" });
      setIcon(cover, "book");

      // 读取 sidecar 取阅读时长 (并行,但不阻塞首次渲染)
      const timeEl = cover.createDiv({ cls: "cr-shelf-cover-time" });
      this.loadReadingTime(file, timeEl);

      const meta = card.createDiv({ cls: "cr-shelf-meta" });
      meta.createDiv({ cls: "cr-shelf-name", text: file.basename });
      const folder = file.parent?.path || "";
      if (folder && folder !== "/") {
        meta.createDiv({ cls: "cr-shelf-path", text: folder });
      }
      card.onclick = () => this.plugin.openBook(file);
    }
  }

  private async loadReadingTime(file: TFile, el: HTMLElement) {
    try {
      const key = await bookKeyFor(file);
      const data = await this.plugin.storage.load(key);
      if (!data || !data.readingSeconds || data.readingSeconds < 1) {
        el.remove();
        return;
      }
      el.setText(formatReadingTime(data.readingSeconds));
    } catch {
      el.remove();
    }
  }
}
