import { ItemView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type ClaudeReaderPlugin from "./main";
import { Annotation, BookData, COLORS, HighlightColor, NOTE_TYPES, NoteType } from "./types";

export const VIEW_TYPE_NOTES = "claude-reader-notes-view";

type FilterKind = "all" | "highlight" | "note";

export class NotesPanelView extends ItemView {
  plugin: ClaudeReaderPlugin;
  rootEl!: HTMLElement;
  searchEl!: HTMLInputElement;
  listEl!: HTMLElement;
  countEl!: HTMLElement;

  query = "";
  filterKind: FilterKind = "all";
  filterColor: HighlightColor | "all" = "all";
  filterType: NoteType | "all" = "all";

  // 缓存所有书的笔记
  cached: { data: BookData; bookFile?: TFile }[] = [];

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeReaderPlugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_NOTES;
  }
  getDisplayText() {
    return "笔记";
  }
  getIcon() {
    return "sticky-note";
  }

  async onOpen() {
    this.rootEl = this.containerEl.children[1] as HTMLElement;
    this.rootEl.empty();
    this.rootEl.addClass("cr-notes-root");

    const header = this.rootEl.createDiv({ cls: "cr-notes-header" });
    header.createEl("span", { text: "笔记", cls: "cr-notes-title" });
    this.countEl = header.createEl("span", { cls: "cr-notes-count" });

    const searchWrap = this.rootEl.createDiv({ cls: "cr-notes-search" });
    setIcon(searchWrap.createSpan({ cls: "cr-notes-search-icon" }), "search");
    this.searchEl = searchWrap.createEl("input", {
      cls: "cr-notes-search-input",
      attr: { placeholder: "搜索原文或笔记内容..." },
    });
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value;
      this.renderList();
    });

    // 类型筛选
    const filterRow = this.rootEl.createDiv({ cls: "cr-notes-filter-row" });
    const mkSegment = (
      label: string,
      isActive: () => boolean,
      onClick: () => void
    ) => {
      const seg = filterRow.createDiv({
        cls: "cr-notes-seg" + (isActive() ? " active" : ""),
        text: label,
      });
      seg.onclick = () => {
        onClick();
        this.renderHeaderFilters();
        this.renderList();
      };
      return seg;
    };

    this.kindFilterEl = filterRow;
    this.renderHeaderFilters();

    this.listEl = this.rootEl.createDiv({ cls: "cr-notes-list" });
    await this.refresh();

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file.path.startsWith(".claude-reader/")) this.refresh();
      })
    );
  }

  kindFilterEl!: HTMLElement;

  renderHeaderFilters() {
    this.kindFilterEl.empty();
    const seg = (
      label: string,
      active: boolean,
      cb: () => void
    ): HTMLElement => {
      const el = this.kindFilterEl.createDiv({
        cls: "cr-notes-seg" + (active ? " active" : ""),
        text: label,
      });
      el.onclick = cb;
      return el;
    };
    seg("全部", this.filterKind === "all", () => {
      this.filterKind = "all";
      this.renderHeaderFilters();
      this.renderList();
    });
    seg("🟡 划线", this.filterKind === "highlight", () => {
      this.filterKind = "highlight";
      this.renderHeaderFilters();
      this.renderList();
    });
    seg("📝 想法", this.filterKind === "note", () => {
      this.filterKind = "note";
      this.renderHeaderFilters();
      this.renderList();
    });
  }

  async refresh() {
    const epubs = this.app.vault.getFiles().filter((f) => f.extension === "epub");
    const all: { data: BookData; bookFile?: TFile }[] = [];
    for (const f of epubs) {
      // 找已存在的 sidecar
      const key = await (await import("./storage")).bookKeyFor(f);
      const data = await this.plugin.storage.load(key);
      if (data && data.highlights.length > 0) {
        all.push({ data, bookFile: f });
      }
    }
    this.cached = all;
    this.renderList();
  }

  renderList() {
    this.listEl.empty();
    const q = this.query.trim().toLowerCase();

    // flatten + filter
    type Row = { ann: Annotation; bookTitle: string; bookFile?: TFile };
    const rows: Row[] = [];
    for (const { data, bookFile } of this.cached) {
      for (const a of data.highlights) {
        if (this.filterKind === "highlight" && a.kind !== "highlight") continue;
        if (this.filterKind === "note" && a.kind !== "note") continue;
        if (q) {
          const hay =
            a.text.toLowerCase() +
            " " +
            (a.kind === "note" ? a.note.toLowerCase() : "");
          if (!hay.includes(q)) continue;
        }
        rows.push({ ann: a, bookTitle: data.title, bookFile });
      }
    }
    rows.sort((a, b) => b.ann.updatedAt - a.ann.updatedAt);

    this.countEl.setText(`${rows.length} 条`);

    if (rows.length === 0) {
      this.listEl.createDiv({
        cls: "cr-notes-empty",
        text: q ? "没找到匹配的条目" : "还没有任何划线或笔记",
      });
      return;
    }

    for (const r of rows) {
      this.renderCard(r.ann, r.bookTitle, r.bookFile);
    }
  }

  renderCard(a: Annotation, bookTitle: string, bookFile?: TFile) {
    const card = this.listEl.createDiv({ cls: "cr-notes-card" });
    // color bar
    const bar = card.createDiv({ cls: `cr-notes-card-bar cr-notes-bar-${a.color}` });
    bar.style.background = COLORS[a.color].fill;

    const main = card.createDiv({ cls: "cr-notes-card-main" });
    // book + chapter
    const meta = main.createDiv({ cls: "cr-notes-card-meta" });
    meta.createSpan({
      text: bookTitle,
      cls: "cr-notes-card-book",
    });

    // text
    const text = main.createDiv({
      cls: "cr-notes-card-text",
      text: a.text,
    });

    // 如果是 note,显示笔记
    if (a.kind === "note") {
      const noteWrap = main.createDiv({ cls: "cr-notes-card-note" });
      const typeMeta = NOTE_TYPES.find((t) => t.value === a.noteType);
      if (typeMeta) {
        noteWrap.createSpan({
          cls: "cr-notes-card-type",
          text: `${typeMeta.emoji} ${typeMeta.label}`,
        });
      }
      noteWrap.createDiv({ cls: "cr-notes-card-note-text", text: a.note });
    }

    // actions
    const actions = main.createDiv({ cls: "cr-notes-card-actions" });
    if (bookFile) {
      const jump = actions.createEl("button", { cls: "cr-notes-card-btn" });
      setIcon(jump, "external-link");
      jump.setAttr("aria-label", "在阅读器打开");
      jump.onclick = () => {
        this.plugin.openBook(bookFile);
      };
    }

    const ask = actions.createEl("button", { cls: "cr-notes-card-btn" });
    ask.setText("AI");
    ask.setAttr("aria-label", "问 Claude");
    ask.onclick = () => {
      this.plugin.askWithContext({
        bookTitle,
        chapterTitle: "",
        selection: a.text,
      });
    };

    text.onclick = () => bookFile && this.plugin.openBook(bookFile);
  }
}
