import { ItemView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type ClaudeReaderPlugin from "./main";

export const VIEW_TYPE_SHELF = "claude-reader-shelf-view";

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
      .filter((f) => f.extension === "epub")
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

    const grid = this.rootEl.createDiv({ cls: "cr-shelf-grid" });
    if (books.length === 0) {
      grid.createDiv({
        cls: "cr-shelf-empty",
        text: "vault 里没有 EPUB。把 .epub 拖进任意文件夹即可。",
      });
      return;
    }
    for (const file of books) {
      const card = grid.createDiv({ cls: "cr-shelf-card" });
      const cover = card.createDiv({ cls: "cr-shelf-cover" });
      setIcon(cover, "book");
      const meta = card.createDiv({ cls: "cr-shelf-meta" });
      const title = file.basename;
      meta.createDiv({ cls: "cr-shelf-name", text: title });
      const folder = file.parent?.path || "";
      if (folder && folder !== "/") {
        meta.createDiv({ cls: "cr-shelf-path", text: folder });
      }
      card.onclick = () => this.plugin.openBook(file);
    }
  }
}
