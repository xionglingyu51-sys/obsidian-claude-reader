import { ItemView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type ClaudeReaderPlugin from "./main";
import { Annotation, BookData, COLORS, HighlightColor, NOTE_TYPES, NoteType } from "./types";

export const VIEW_TYPE_NOTES = "claude-reader-notes-view";

type FilterKind = "all" | "highlight" | "note";
type GroupMode = "flat" | "byBook";

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
  groupMode: GroupMode = "byBook"; // 默认按书分组
  collapsedBooks = new Set<string>();

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

    // 分组切换按钮
    const groupBtn = header.createEl("button", { cls: "cr-icon-btn" });
    setIcon(groupBtn, this.groupMode === "byBook" ? "list" : "library");
    groupBtn.setAttr(
      "aria-label",
      this.groupMode === "byBook" ? "切换为平铺视图" : "切换为按书分组"
    );
    groupBtn.onclick = () => {
      this.groupMode = this.groupMode === "byBook" ? "flat" : "byBook";
      setIcon(
        groupBtn,
        this.groupMode === "byBook" ? "list" : "library"
      );
      groupBtn.setAttr(
        "aria-label",
        this.groupMode === "byBook" ? "切换为平铺视图" : "切换为按书分组"
      );
      this.renderList();
    };

    // 导出全部按钮
    const exportAll = header.createEl("button", {
      cls: "cr-icon-btn",
    });
    setIcon(exportAll, "file-down");
    exportAll.setAttr("aria-label", "导出全部书的笔记");
    exportAll.onclick = async () => {
      await this.exportAllBooks();
    };

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

  async exportAllBooks() {
    if (this.cached.length === 0) {
      const { Notice } = await import("obsidian");
      new Notice("没有笔记可导出");
      return;
    }
    for (const { data, bookFile } of this.cached) {
      await this.plugin.exportBook(data, bookFile ?? null);
    }
  }

  renderList() {
    this.listEl.empty();
    const q = this.query.trim().toLowerCase();

    // flatten + filter
    type Row = { ann: Annotation; bookTitle: string; bookFile?: TFile; bookKey: string };
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
        rows.push({
          ann: a,
          bookTitle: data.title,
          bookFile,
          bookKey: data.bookKey,
        });
      }
    }

    this.countEl.setText(`${rows.length} 条`);

    if (rows.length === 0) {
      this.listEl.createDiv({
        cls: "cr-notes-empty",
        text: q ? "没找到匹配的条目" : "还没有任何划线或笔记",
      });
      return;
    }

    if (this.groupMode === "flat") {
      rows.sort((a, b) => b.ann.updatedAt - a.ann.updatedAt);
      for (const r of rows) {
        this.renderCard(r.ann, r.bookTitle, r.bookFile);
      }
      return;
    }

    // byBook: 按 bookKey 分组
    const byBook = new Map<
      string,
      { title: string; file?: TFile; items: Row[] }
    >();
    for (const r of rows) {
      let g = byBook.get(r.bookKey);
      if (!g) {
        g = { title: r.bookTitle, file: r.bookFile, items: [] };
        byBook.set(r.bookKey, g);
      }
      g.items.push(r);
    }
    // 每书按更新时间倒序;书之间按"最新条目"倒序
    const groups = Array.from(byBook.entries()).map(([key, g]) => ({
      key,
      ...g,
    }));
    for (const g of groups) {
      g.items.sort((a, b) => b.ann.updatedAt - a.ann.updatedAt);
    }
    groups.sort(
      (a, b) =>
        (b.items[0]?.ann.updatedAt ?? 0) - (a.items[0]?.ann.updatedAt ?? 0)
    );

    for (const g of groups) {
      this.renderBookGroup(g.key, g.title, g.file, g.items);
    }
  }

  renderBookGroup(
    bookKey: string,
    title: string,
    bookFile: TFile | undefined,
    items: { ann: Annotation; bookTitle: string; bookFile?: TFile }[]
  ) {
    const collapsed = this.collapsedBooks.has(bookKey);
    const group = this.listEl.createDiv({
      cls: "cr-notes-book-group" + (collapsed ? " collapsed" : ""),
    });
    const head = group.createDiv({ cls: "cr-notes-book-head" });
    const caret = head.createDiv({ cls: "cr-notes-book-caret" });
    setIcon(caret, collapsed ? "chevron-right" : "chevron-down");

    head.createDiv({ cls: "cr-notes-book-title", text: title });
    head.createDiv({
      cls: "cr-notes-book-count",
      text: `${items.length}`,
    });

    head.onclick = () => {
      if (collapsed) this.collapsedBooks.delete(bookKey);
      else this.collapsedBooks.add(bookKey);
      this.renderList();
    };

    // 单本导出按钮
    if (bookFile && !collapsed) {
      const exportBtn = head.createEl("button", { cls: "cr-notes-book-export" });
      setIcon(exportBtn, "file-down");
      exportBtn.setAttr("aria-label", "导出这本书的笔记");
      exportBtn.onclick = async (e) => {
        e.stopPropagation();
        const cached = this.cached.find((c) => c.data.bookKey === bookKey);
        if (cached) await this.plugin.exportBook(cached.data, bookFile);
      };
    }

    if (collapsed) return;

    const body = group.createDiv({ cls: "cr-notes-book-body" });
    for (const r of items) {
      this.renderCard(r.ann, r.bookTitle, r.bookFile, body, true);
    }
  }

  renderCard(
    a: Annotation,
    bookTitle: string,
    bookFile?: TFile,
    container?: HTMLElement,
    hideBookTitle = false
  ) {
    const parent = container ?? this.listEl;
    const card = parent.createDiv({ cls: "cr-notes-card" });
    // color bar
    const bar = card.createDiv({ cls: `cr-notes-card-bar cr-notes-bar-${a.color}` });
    bar.style.background = COLORS[a.color].fill;

    const main = card.createDiv({ cls: "cr-notes-card-main" });
    if (!hideBookTitle) {
      const meta = main.createDiv({ cls: "cr-notes-card-meta" });
      meta.createSpan({
        text: bookTitle,
        cls: "cr-notes-card-book",
      });
    }

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
