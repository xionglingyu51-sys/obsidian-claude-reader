import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type ClaudeReaderPlugin from "./main";
import { EpubBook, parseEpub } from "./epub";
import {
  BookData,
  COLORS,
  Highlight,
  HighlightColor,
} from "./types";
import { applyHighlight, highlightFromRange } from "./highlight";
import { bookKeyFor } from "./storage";

export const VIEW_TYPE_READER = "claude-reader-view";

export interface ReaderViewState {
  filePath: string;
}

export class ReaderView extends ItemView {
  plugin: ClaudeReaderPlugin;
  file: TFile | null = null;
  book: EpubBook | null = null;
  data: BookData | null = null;
  chapterIndex = 0;
  blobUrls: string[] = [];

  // dom
  rootEl!: HTMLElement;
  tocEl!: HTMLElement;
  contentEl_!: HTMLElement;
  chapterRootEl!: HTMLElement;
  toolbarEl: HTMLElement | null = null;
  toolbarTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeReaderPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE_READER;
  }
  getDisplayText() {
    return this.book?.title ?? "Claude Reader";
  }
  getIcon() {
    return "book-open";
  }

  async setState(state: any, result: any): Promise<void> {
    await super.setState(state, result);
    // Obsidian 默认走 state.file (FileView 约定);我们也兼容 filePath
    const path: string | undefined = state?.file ?? state?.filePath;
    if (path && path !== this.file?.path) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) {
        await this.openFile(f);
      } else {
        this.showError(`找不到文件: ${path}`);
      }
    }
  }

  getState(): any {
    return { file: this.file?.path, filePath: this.file?.path };
  }

  showError(msg: string) {
    if (!this.rootEl) return;
    this.rootEl.empty();
    const e = this.rootEl.createDiv({ cls: "cr-shelf-empty" });
    e.setText(msg);
  }

  async onOpen() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("cr-root");
    this.rootEl = root;

    // 如果还没收到 setState (file 还没就位),显示加载占位
    if (!this.file) {
      const placeholder = this.rootEl.createDiv({ cls: "cr-shelf-empty" });
      placeholder.setText("正在加载...");
    } else {
      this.renderShell();
    }
  }

  async onClose() {
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls = [];
    this.removeToolbar();
  }

  renderShell() {
    this.rootEl.empty();

    // header
    const header = this.rootEl.createDiv({ cls: "cr-header" });
    const tocBtn = header.createEl("button", { cls: "cr-icon-btn" });
    setIcon(tocBtn, "list");
    tocBtn.setAttr("aria-label", "目录");
    tocBtn.onclick = () => this.rootEl.toggleClass("cr-toc-open", true);

    const titleEl = header.createDiv({ cls: "cr-title" });
    titleEl.setText(this.book?.title ?? "未打开书籍");

    const themeBtn = header.createEl("button", { cls: "cr-icon-btn" });
    setIcon(themeBtn, "palette");
    themeBtn.setAttr("aria-label", "主题");
    themeBtn.onclick = () => this.cycleTheme();

    // body
    const body = this.rootEl.createDiv({ cls: "cr-body" });
    this.tocEl = body.createDiv({ cls: "cr-toc" });
    this.contentEl_ = body.createDiv({ cls: "cr-content" });
    this.chapterRootEl = this.contentEl_.createDiv({ cls: "cr-chapter" });

    // close TOC overlay
    body.addEventListener("click", (e) => {
      if (e.target === body && this.rootEl.hasClass("cr-toc-open")) {
        this.rootEl.toggleClass("cr-toc-open", false);
      }
    });

    // nav buttons
    const nav = this.rootEl.createDiv({ cls: "cr-nav" });
    const prev = nav.createEl("button", { cls: "cr-nav-btn" });
    setIcon(prev, "chevron-left");
    prev.onclick = () => this.gotoChapter(this.chapterIndex - 1);
    const indicator = nav.createDiv({ cls: "cr-nav-indicator" });
    indicator.setText("--");
    const next = nav.createEl("button", { cls: "cr-nav-btn" });
    setIcon(next, "chevron-right");
    next.onclick = () => this.gotoChapter(this.chapterIndex + 1);

    this.navIndicatorEl = indicator;

    // selection 监听 (桌面 + iOS 都覆盖)
    this.registerDomEvent(document, "selectionchange", () =>
      this.scheduleSelectionCheck()
    );
    this.registerDomEvent(this.contentEl_, "mouseup", () =>
      this.scheduleSelectionCheck(80)
    );
    this.registerDomEvent(this.contentEl_, "touchend", () =>
      this.scheduleSelectionCheck(120)
    );

    // scroll progress
    this.contentEl_.addEventListener("scroll", () => this.onScroll());
  }

  navIndicatorEl!: HTMLElement;

  async openFile(file: TFile) {
    this.file = file;
    this.contentEl_?.empty?.();
    this.chapterRootEl?.empty?.();

    try {
      const buf = await this.app.vault.readBinary(file);
      this.book = await parseEpub(buf);
    } catch (e) {
      new Notice(`解析 EPUB 失败: ${(e as Error).message}`);
      return;
    }

    const key = await bookKeyFor(file);
    this.data =
      (await this.plugin.storage.load(key)) ?? {
        bookKey: key,
        title: this.book.title,
        highlights: [],
        progress: null,
        lastOpenedAt: Date.now(),
        readingSeconds: 0,
      };
    this.data.lastOpenedAt = Date.now();
    await this.plugin.storage.save(this.data);

    this.renderShell();
    this.renderToc();

    const initial = this.data.progress?.chapterIndex ?? 0;
    await this.gotoChapter(initial, this.data.progress?.scrollPercent ?? 0);
  }

  renderToc() {
    this.tocEl.empty();
    if (!this.book) return;
    const head = this.tocEl.createDiv({ cls: "cr-toc-head" });
    head.createSpan({ text: "目录" });
    const closeBtn = head.createEl("button", { cls: "cr-icon-btn" });
    setIcon(closeBtn, "x");
    closeBtn.onclick = () => this.rootEl.toggleClass("cr-toc-open", false);

    const list = this.tocEl.createDiv({ cls: "cr-toc-list" });
    this.book.chapters.forEach((ch, i) => {
      const item = list.createDiv({
        cls: "cr-toc-item" + (i === this.chapterIndex ? " active" : ""),
        text: ch.title,
      });
      item.onclick = () => {
        this.rootEl.toggleClass("cr-toc-open", false);
        this.gotoChapter(i);
      };
    });
  }

  async gotoChapter(i: number, scrollPercent = 0) {
    if (!this.book) return;
    if (i < 0 || i >= this.book.chapters.length) return;
    this.chapterIndex = i;
    const ch = this.book.chapters[i];

    // revoke prior blob urls (chapter-specific images only)
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls = [];

    this.chapterRootEl.empty();
    this.chapterRootEl.innerHTML = ch.html;

    // resolve images
    const imgs = Array.from(this.chapterRootEl.querySelectorAll("img"));
    for (const img of imgs) {
      const src = img.getAttribute("data-src");
      if (!src) continue;
      const res = this.book.resources.get(src);
      if (!res) {
        img.remove();
        continue;
      }
      const blob = new Blob([res.data.buffer as ArrayBuffer], { type: res.mime });
      const url = URL.createObjectURL(blob);
      this.blobUrls.push(url);
      img.setAttribute("src", url);
      img.removeAttribute("data-src");
    }

    // apply highlights
    this.renderHighlights();

    // scroll to position
    requestAnimationFrame(() => {
      this.contentEl_.scrollTop =
        scrollPercent * (this.contentEl_.scrollHeight - this.contentEl_.clientHeight);
    });

    this.updateNavIndicator();
    this.renderToc();
  }

  renderHighlights() {
    if (!this.data || !this.book) return;
    const ch = this.book.chapters[this.chapterIndex];
    const items = this.data.highlights.filter((h) => h.chapterId === ch.id);
    for (const h of items) {
      applyHighlight(this.chapterRootEl, h, (hh, el) =>
        this.onHighlightClick(hh, el)
      );
    }
  }

  updateNavIndicator() {
    if (!this.book) return;
    this.navIndicatorEl.setText(
      `${this.chapterIndex + 1} / ${this.book.chapters.length}`
    );
  }

  scrollSaveTimer: number | null = null;
  onScroll() {
    if (this.scrollSaveTimer) window.clearTimeout(this.scrollSaveTimer);
    this.scrollSaveTimer = window.setTimeout(() => this.saveProgress(), 600);
  }

  async saveProgress() {
    if (!this.data) return;
    const maxScroll =
      this.contentEl_.scrollHeight - this.contentEl_.clientHeight;
    const pct = maxScroll > 0 ? this.contentEl_.scrollTop / maxScroll : 0;
    this.data.progress = {
      chapterIndex: this.chapterIndex,
      scrollPercent: pct,
    };
    await this.plugin.storage.save(this.data);
  }

  // ---------- Selection toolbar ----------
  selectionCheckTimer: number | null = null;
  outsideClickHandler: ((e: Event) => void) | null = null;

  scheduleSelectionCheck(delay = 0) {
    if (this.selectionCheckTimer) window.clearTimeout(this.selectionCheckTimer);
    this.selectionCheckTimer = window.setTimeout(() => {
      this.selectionCheckTimer = null;
      this.onSelectionChange();
    }, delay);
  }

  onSelectionChange() {
    const sel = window.getSelection();
    // 工具条已经存在时,不因为选区变化而关闭——靠 outside click 关闭
    if (this.toolbarEl) return;
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!this.chapterRootEl.contains(range.commonAncestorContainer)) return;
    if (!sel.toString().trim()) return;
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    this.showToolbar(rect, range);
  }

  removeToolbar() {
    if (this.toolbarEl) {
      this.toolbarEl.remove();
      this.toolbarEl = null;
    }
    if (this.outsideClickHandler) {
      document.removeEventListener("pointerdown", this.outsideClickHandler, true);
      this.outsideClickHandler = null;
    }
    if (this.selectionCheckTimer) {
      window.clearTimeout(this.selectionCheckTimer);
      this.selectionCheckTimer = null;
    }
  }

  showToolbar(rect: DOMRect, range: Range) {
    this.removeToolbar();
    // 提前快照选中文字,防止 iOS 上 range 被吃掉
    const selectedText = range.toString();
    const savedRange = range.cloneRange();

    const tb = document.body.createDiv({ cls: "cr-toolbar" });

    // 阻止点工具条本身导致选区被清掉
    tb.addEventListener("mousedown", (e) => e.preventDefault());
    tb.addEventListener("touchstart", (e) => e.preventDefault(), {
      passive: false,
    });

    // 4 color dots
    for (const c of Object.keys(COLORS) as HighlightColor[]) {
      const dot = tb.createEl("button", {
        cls: `cr-tb-dot cr-tb-dot-${c}`,
        attr: { "aria-label": `${COLORS[c].label} - ${COLORS[c].meaning}` },
      });
      dot.style.background = COLORS[c].fill;
      dot.onclick = (e) => {
        e.stopPropagation();
        this.addHighlight(savedRange.cloneRange(), c);
        window.getSelection()?.removeAllRanges();
        this.removeToolbar();
      };
    }

    // AI button
    const ai = tb.createEl("button", { cls: "cr-tb-btn cr-tb-ai" });
    ai.setText("AI");
    ai.setAttr("aria-label", "问 Claude");
    ai.onclick = (e) => {
      e.stopPropagation();
      this.askClaudeAbout(selectedText);
      window.getSelection()?.removeAllRanges();
      this.removeToolbar();
    };

    // copy
    const copy = tb.createEl("button", { cls: "cr-tb-btn" });
    setIcon(copy, "copy");
    copy.setAttr("aria-label", "复制");
    copy.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(selectedText);
      window.getSelection()?.removeAllRanges();
      this.removeToolbar();
    };

    // position
    const top = rect.top - 44 < 8 ? rect.bottom + 8 : rect.top - 44;
    const left = Math.max(
      8,
      Math.min(rect.left, window.innerWidth - 240)
    );
    tb.style.top = `${top}px`;
    tb.style.left = `${left}px`;

    this.toolbarEl = tb;

    // 点工具条外部才关闭
    this.outsideClickHandler = (e: Event) => {
      const target = e.target as Node;
      if (tb.contains(target)) return;
      // 如果用户点在 chapter 区域内并产生了新选区,onSelectionChange 会重开
      this.removeToolbar();
    };
    // 用 setTimeout 避免立刻被同一次点击关掉
    window.setTimeout(() => {
      if (this.outsideClickHandler) {
        document.addEventListener(
          "pointerdown",
          this.outsideClickHandler,
          true
        );
      }
    }, 50);
  }

  async addHighlight(range: Range, color: HighlightColor) {
    if (!this.data || !this.book) return;
    const ch = this.book.chapters[this.chapterIndex];
    // normalize root: 合并相邻文本节点,确保 path 稳定
    this.chapterRootEl.normalize();

    const info = highlightFromRange(range, this.chapterRootEl);
    if (!info) return;

    const h: Highlight = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      chapterId: ch.id,
      ...info,
      color,
      createdAt: Date.now(),
    };
    applyHighlight(this.chapterRootEl, h, (hh, el) =>
      this.onHighlightClick(hh, el)
    );
    await this.plugin.storage.upsertHighlight(
      this.data.bookKey,
      h,
      this.data.title
    );
    this.data.highlights.push(h);
  }

  onHighlightClick(h: Highlight, target: HTMLElement) {
    const rect = target.getBoundingClientRect();
    this.removeToolbar();
    const tb = document.body.createDiv({ cls: "cr-toolbar cr-toolbar-hl" });
    tb.addEventListener("mousedown", (e) => e.preventDefault());
    tb.addEventListener("touchstart", (e) => e.preventDefault(), {
      passive: false,
    });
    for (const c of Object.keys(COLORS) as HighlightColor[]) {
      const dot = tb.createEl("button", {
        cls: `cr-tb-dot cr-tb-dot-${c}` + (c === h.color ? " active" : ""),
      });
      dot.style.background = COLORS[c].fill;
      dot.onclick = async (e) => {
        e.stopPropagation();
        h.color = c;
        // 重新渲染章节以反映新颜色
        await this.plugin.storage.upsertHighlight(
          this.data!.bookKey,
          h,
          this.data!.title
        );
        await this.gotoChapter(this.chapterIndex, this.scrollPercent());
        this.removeToolbar();
      };
    }
    const ai = tb.createEl("button", { cls: "cr-tb-btn cr-tb-ai" });
    ai.setText("AI");
    ai.onclick = (e) => {
      e.stopPropagation();
      this.askClaudeAbout(h.text);
      this.removeToolbar();
    };
    const del = tb.createEl("button", { cls: "cr-tb-btn" });
    setIcon(del, "trash-2");
    del.onclick = async (e) => {
      e.stopPropagation();
      await this.plugin.storage.deleteHighlight(this.data!.bookKey, h.id);
      this.data!.highlights = this.data!.highlights.filter(
        (x) => x.id !== h.id
      );
      await this.gotoChapter(this.chapterIndex, this.scrollPercent());
      this.removeToolbar();
    };
    const top = rect.top - 44 < 8 ? rect.bottom + 8 : rect.top - 44;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 240));
    tb.style.top = `${top}px`;
    tb.style.left = `${left}px`;
    this.toolbarEl = tb;
  }

  scrollPercent(): number {
    const max =
      this.contentEl_.scrollHeight - this.contentEl_.clientHeight;
    return max > 0 ? this.contentEl_.scrollTop / max : 0;
  }

  askClaudeAbout(text: string) {
    this.plugin.askWithContext({
      bookTitle: this.book?.title || "",
      chapterTitle:
        this.book?.chapters[this.chapterIndex]?.title || "",
      selection: text.trim(),
    });
  }

  // ---------- Theme ----------
  cycleTheme() {
    const themes = ["theme-paper", "theme-sepia", "theme-night", ""];
    const cur = themes.find((t) => t && this.rootEl.hasClass(t)) || "";
    const next = themes[(themes.indexOf(cur) + 1) % themes.length];
    for (const t of themes) {
      if (t) this.rootEl.toggleClass(t, false);
    }
    if (next) this.rootEl.toggleClass(next, true);
  }
}
