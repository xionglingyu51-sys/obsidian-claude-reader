import { App, ItemView, Modal, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type ClaudeReaderPlugin from "./main";
import { EpubBook, parseEpub } from "./epub";
import {
  BookData,
  COLORS,
  Highlight,
  HighlightColor,
  HighlightStyle,
  NOTE_TYPES,
  NoteType,
  STYLES,
} from "./types";
import { applyHighlight, highlightFromRange } from "./highlight";
import { bookKeyFor } from "./storage";
import { SearchModal } from "./search-modal";

function formatReadingTime(seconds: number): string {
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 > 0 ? ` ${m % 60}min` : ""}`;
}

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
    const path: string | undefined = state?.file ?? state?.filePath;
    const jumpId: string | undefined = state?.jumpToAnnotationId;
    if (path && path !== this.file?.path) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) {
        await this.openFile(f, jumpId);
      } else {
        this.showError(`找不到文件: ${path}`);
      }
    } else if (jumpId && this.data) {
      await this.scrollToAnnotation(jumpId);
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

    if (!this.file) {
      const placeholder = this.rootEl.createDiv({ cls: "cr-shelf-empty" });
      placeholder.setText("正在加载...");
    } else {
      this.renderShell();
    }

    this.startReadingTimer();
  }

  async onClose() {
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.blobUrls = [];
    this.removeToolbar();
    this.stopReadingTimer(true);
  }

  // ---------- Reading timer ----------
  private readingTimerInterval: number | null = null;
  private lastTickAt = 0;
  private idleThresholdMs = 60 * 1000; // 60s 没活动就停计时
  private lastActivityAt = Date.now();
  private visibilityHandler?: () => void;
  private activityHandler?: () => void;

  startReadingTimer() {
    this.stopReadingTimer(false);
    this.lastTickAt = Date.now();
    this.lastActivityAt = Date.now();

    this.readingTimerInterval = window.setInterval(() => this.tickReading(), 5000);

    this.visibilityHandler = () => {
      if (document.hidden) {
        // 离开页面: 把已经累积的写一次
        this.flushReadingTime();
      } else {
        this.lastTickAt = Date.now();
        this.lastActivityAt = Date.now();
      }
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);

    this.activityHandler = () => {
      this.lastActivityAt = Date.now();
    };
    // 任何阅读相关交互都算活动
    document.addEventListener("pointermove", this.activityHandler, {
      passive: true,
    });
    document.addEventListener("pointerdown", this.activityHandler, {
      passive: true,
    });
    document.addEventListener("keydown", this.activityHandler, true);
    document.addEventListener("scroll", this.activityHandler, true);
  }

  stopReadingTimer(flush: boolean) {
    if (this.readingTimerInterval !== null) {
      window.clearInterval(this.readingTimerInterval);
      this.readingTimerInterval = null;
    }
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = undefined;
    }
    if (this.activityHandler) {
      document.removeEventListener("pointermove", this.activityHandler);
      document.removeEventListener("pointerdown", this.activityHandler);
      document.removeEventListener("keydown", this.activityHandler, true);
      document.removeEventListener("scroll", this.activityHandler, true);
      this.activityHandler = undefined;
    }
    if (flush) void this.flushReadingTime();
  }

  /**
   * 每 5 秒一次: 判断"是否在活动",在则累积。
   * 用 lastTickAt → now 的差(秒)累加,而不是固定 5 秒,这样能正确处理被挂起的情况。
   */
  tickReading() {
    if (!this.data) return;
    if (document.hidden) return;
    const now = Date.now();
    const delta = now - this.lastTickAt;
    this.lastTickAt = now;
    const idle = now - this.lastActivityAt;
    if (idle > this.idleThresholdMs) return;
    // 计入,但上限 30s 防止跳跃
    const add = Math.min(delta, 30_000) / 1000;
    this.data.readingSeconds = (this.data.readingSeconds || 0) + add;
    // 不每次写硬盘,5 次 tick 才写一次
    this.tickCounter++;
    if (this.tickCounter >= 5) {
      this.tickCounter = 0;
      void this.flushReadingTime();
    }
  }
  private tickCounter = 0;

  async flushReadingTime() {
    if (!this.data) return;
    await this.plugin.storage.save(this.data);
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

    // 兜底: 顶栏 AI 按钮 — 选中任意文字后,点这里直接发到 chat
    const askBtn = header.createEl("button", { cls: "cr-icon-btn" });
    askBtn.setText("AI");
    askBtn.setAttr("aria-label", "问选区");
    askBtn.onclick = () => this.askFromCurrentSelection();

    const themeBtn = header.createEl("button", { cls: "cr-icon-btn" });
    setIcon(themeBtn, "palette");
    themeBtn.setAttr("aria-label", "主题");
    themeBtn.onclick = () => this.cycleTheme();

    // 导出按钮
    const exportBtn = header.createEl("button", { cls: "cr-icon-btn" });
    setIcon(exportBtn, "file-down");
    exportBtn.setAttr("aria-label", "导出笔记到 markdown");
    exportBtn.onclick = () => {
      if (this.data) this.plugin.exportBook(this.data, this.file);
    };

    // 搜索按钮
    const searchBtn = header.createEl("button", { cls: "cr-icon-btn" });
    setIcon(searchBtn, "search");
    searchBtn.setAttr("aria-label", "全书搜索");
    searchBtn.onclick = () => this.openSearchModal();

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

    // 浮动章节进度指示器
    this.navIndicatorEl = this.rootEl.createDiv({ cls: "cr-progress-pill" });
    this.navIndicatorEl.setText("--");

    // 点滑翻页: 触摸滑动 + 桌面滚轮章节切换
    this.registerSwipeNav();

    // selection 监听 (桌面 + iOS 都覆盖)
    this.registerDomEvent(document, "selectionchange", () =>
      this.scheduleSelectionCheck(200)
    );
    this.registerDomEvent(this.contentEl_, "mouseup", () =>
      this.scheduleSelectionCheck(150)
    );
    this.registerDomEvent(this.contentEl_, "touchend", () =>
      this.scheduleSelectionCheck(300)
    );
    this.registerDomEvent(this.contentEl_, "pointerup", () =>
      this.scheduleSelectionCheck(300)
    );

    // scroll progress
    this.contentEl_.addEventListener("scroll", () => this.onScroll());
  }

  navIndicatorEl!: HTMLElement;

  async openFile(file: TFile, jumpToAnnId?: string) {
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

    if (jumpToAnnId) {
      await this.scrollToAnnotation(jumpToAnnId);
    } else {
      const initial = this.data.progress?.chapterIndex ?? 0;
      await this.gotoChapter(initial, this.data.progress?.scrollPercent ?? 0);
    }
  }

  async scrollToAnnotation(annId: string) {
    if (!this.data || !this.book) return;
    const ann = this.data.highlights.find((a) => a.id === annId);
    if (!ann) return;
    const chIdx = this.book.chapters.findIndex((c) => c.id === ann.chapterId);
    if (chIdx < 0) return;
    await this.gotoChapter(chIdx, 0);
    // 等渲染完再 scrollIntoView 那个高亮 span
    requestAnimationFrame(() => {
      const el = this.chapterRootEl.querySelector(
        `[data-hl-id="${annId}"]`
      );
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("cr-hl-flash");
        window.setTimeout(() => el.classList.remove("cr-hl-flash"), 1600);
      }
    });
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
    // 如果有 pending 搜索关键词,在新章节里高亮第一个匹配
    requestAnimationFrame(() => this.highlightSearchHitInChapter());
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
    if (!this.book || !this.navIndicatorEl) return;
    const total = this.book.chapters.length;
    const cur = this.chapterIndex + 1;
    const seconds = this.data?.readingSeconds ?? 0;
    const timeStr = formatReadingTime(seconds);
    this.navIndicatorEl.setText(`${cur} / ${total} · ${timeStr}`);
    // 切换章节时短暂高亮提示
    this.navIndicatorEl.addClass("show");
    if (this.indicatorTimer) window.clearTimeout(this.indicatorTimer);
    this.indicatorTimer = window.setTimeout(() => {
      this.navIndicatorEl.removeClass("show");
      this.indicatorTimer = null;
    }, 2000);
  }

  indicatorTimer: number | null = null;

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

  /**
   * 兜底入口: 顶栏 AI 按钮触发,直接从当前 selection 抓文字发到 chat。
   * 即使工具条因为各种原因没出现,这里也能用。
   */
  askFromCurrentSelection() {
    const sel = window.getSelection();
    let text = sel?.toString().trim() || "";
    if (!text) {
      // 兼容 iOS: 有时 selection 在 iframe 内但 window.getSelection 拿不到
      // 退化方案: 弹 prompt 让用户粘贴
      const pasted = window.prompt(
        "在书里选中文字后,系统会自动用它。\n如果系统没抓到,请把要问的文字粘到这里:"
      );
      if (!pasted) return;
      text = pasted.trim();
    }
    if (!text) return;
    new Notice(`正在问 Claude:「${text.slice(0, 40)}...」`);
    this.askClaudeAbout(text);
  }

  onSelectionChange() {
    const sel = window.getSelection();
    // 工具条已经存在时,不因为选区变化而关闭——靠 outside click 关闭
    if (this.toolbarEl) return;
    if (!sel || sel.isCollapsed) return;
    if (sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!this.chapterRootEl.contains(range.commonAncestorContainer)) return;
    const text = sel.toString().trim();
    if (!text) return;
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

    // 工具条空白处吸住 pointer,但不再阻止按钮内的 click
    tb.addEventListener("pointerdown", (e) => {
      // 只在点的是工具条本身(空白)时阻止默认
      if (e.target === tb) e.preventDefault();
    });

    /**
     * iOS 上 long-press 后点按钮时,touchstart→click 链路在工具条祖先
     * preventDefault 后会断掉。改用 pointerdown 触发动作,绕过 click。
     */
    const onPress = (
      btn: HTMLElement,
      handler: () => void
    ) => {
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // pointerup 之后再触发,这样手感更接近原生 tap
        const onUp = () => {
          btn.removeEventListener("pointerup", onUp);
          btn.removeEventListener("pointerleave", onCancel);
          handler();
        };
        const onCancel = () => {
          btn.removeEventListener("pointerup", onUp);
          btn.removeEventListener("pointerleave", onCancel);
        };
        btn.addEventListener("pointerup", onUp);
        btn.addEventListener("pointerleave", onCancel);
      });
    };

    // 4 color dots
    for (const c of Object.keys(COLORS) as HighlightColor[]) {
      const dot = tb.createEl("button", {
        cls: `cr-tb-dot cr-tb-dot-${c}`,
        attr: { "aria-label": `${COLORS[c].label} - ${COLORS[c].meaning}` },
      });
      dot.style.background = COLORS[c].fill;
      onPress(dot, () => {
        this.addHighlight(savedRange.cloneRange(), c);
        window.getSelection()?.removeAllRanges();
        this.removeToolbar();
      });
    }

    // 笔记按钮 — 划线 + 写笔记 一气呵成
    const noteBtn = tb.createEl("button", { cls: "cr-tb-btn" });
    noteBtn.setText("📝");
    noteBtn.setAttr("aria-label", "划线并写笔记");
    onPress(noteBtn, async () => {
      const h = await this.addHighlight(
        savedRange.cloneRange(),
        "yellow",
        true
      );
      window.getSelection()?.removeAllRanges();
      this.removeToolbar();
      if (h) this.openNoteModal(h);
    });

    // AI button
    const ai = tb.createEl("button", { cls: "cr-tb-btn cr-tb-ai" });
    ai.setText("AI");
    ai.setAttr("aria-label", "问 Claude");
    onPress(ai, () => {
      this.askClaudeAbout(selectedText);
      window.getSelection()?.removeAllRanges();
      this.removeToolbar();
    });

    // 快捷 prompt 模板按钮
    for (const tpl of this.plugin.settings.templates) {
      const btn = tb.createEl("button", { cls: "cr-tb-btn cr-tb-tpl" });
      btn.setText(tpl.label);
      btn.setAttr("aria-label", tpl.prompt);
      onPress(btn, () => {
        this.askClaudeWithTemplate(selectedText, tpl.prompt);
        window.getSelection()?.removeAllRanges();
        this.removeToolbar();
      });
    }

    // copy
    const copy = tb.createEl("button", { cls: "cr-tb-btn" });
    setIcon(copy, "copy");
    copy.setAttr("aria-label", "复制");
    onPress(copy, () => {
      this.copyToClipboard(selectedText);
      window.getSelection()?.removeAllRanges();
      this.removeToolbar();
    });

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
      this.removeToolbar();
    };
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

  /** Clipboard 兜底: navigator.clipboard 在 iOS Obsidian 里偶尔失败,用 textarea 备份 */
  async copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      new Notice("已复制");
      return;
    } catch {
      // fallthrough to textarea
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      new Notice("已复制");
    } catch (e) {
      new Notice("复制失败: " + (e as Error).message);
    }
  }

  async addHighlight(
    range: Range,
    color: HighlightColor,
    silent = false
  ): Promise<Highlight | null> {
    if (!this.data || !this.book) return null;
    const ch = this.book.chapters[this.chapterIndex];
    this.chapterRootEl.normalize();

    const info = highlightFromRange(range, this.chapterRootEl);
    if (!info) return null;

    const now = Date.now();
    const h: Highlight = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 6),
      kind: "highlight",
      chapterId: ch.id,
      chapterTitle: ch.title,
      ...info,
      color,
      style: "fill",
      createdAt: now,
      updatedAt: now,
    };
    applyHighlight(this.chapterRootEl, h, (hh, el) =>
      this.onHighlightClick(hh, el)
    );
    await this.plugin.storage.upsertAnnotation(
      this.data.bookKey,
      h,
      this.data.title
    );
    this.data.highlights.push(h);
    return h;
  }

  onHighlightClick(h: Highlight, target: HTMLElement) {
    const rect = target.getBoundingClientRect();
    this.removeToolbar();
    const tb = document.body.createDiv({ cls: "cr-toolbar cr-toolbar-hl" });

    tb.addEventListener("pointerdown", (e) => {
      if (e.target === tb) e.preventDefault();
    });
    const onPress = (
      btn: HTMLElement,
      handler: () => void
    ) => {
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const onUp = () => {
          btn.removeEventListener("pointerup", onUp);
          btn.removeEventListener("pointerleave", onCancel);
          handler();
        };
        const onCancel = () => {
          btn.removeEventListener("pointerup", onUp);
          btn.removeEventListener("pointerleave", onCancel);
        };
        btn.addEventListener("pointerup", onUp);
        btn.addEventListener("pointerleave", onCancel);
      });
    };

    for (const c of Object.keys(COLORS) as HighlightColor[]) {
      const dot = tb.createEl("button", {
        cls: `cr-tb-dot cr-tb-dot-${c}` + (c === h.color ? " active" : ""),
      });
      dot.style.background = COLORS[c].fill;
      onPress(dot, async () => {
        h.color = c;
        await this.plugin.storage.upsertHighlight(
          this.data!.bookKey,
          h,
          this.data!.title
        );
        await this.gotoChapter(this.chapterIndex, this.scrollPercent());
        this.removeToolbar();
      });
    }

    // 笔记按钮
    const noteBtn = tb.createEl("button", { cls: "cr-tb-btn" });
    noteBtn.setText(h.note ? "✏️" : "📝");
    noteBtn.setAttr("aria-label", h.note ? "编辑笔记" : "添加笔记");
    onPress(noteBtn, () => {
      this.removeToolbar();
      this.openNoteModal(h);
    });

    const ai = tb.createEl("button", { cls: "cr-tb-btn cr-tb-ai" });
    ai.setText("AI");
    onPress(ai, () => {
      this.askClaudeAbout(h.text);
      this.removeToolbar();
    });
    const del = tb.createEl("button", { cls: "cr-tb-btn" });
    setIcon(del, "trash-2");
    onPress(del, async () => {
      await this.plugin.storage.deleteHighlight(this.data!.bookKey, h.id);
      this.data!.highlights = this.data!.highlights.filter(
        (x) => x.id !== h.id
      );
      await this.gotoChapter(this.chapterIndex, this.scrollPercent());
      this.removeToolbar();
    });
    const top = rect.top - 44 < 8 ? rect.bottom + 8 : rect.top - 44;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 240));
    tb.style.top = `${top}px`;
    tb.style.left = `${left}px`;
    this.toolbarEl = tb;

    this.outsideClickHandler = (e: Event) => {
      const target = e.target as Node;
      if (tb.contains(target)) return;
      this.removeToolbar();
    };
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

  scrollPercent(): number {
    const max =
      this.contentEl_.scrollHeight - this.contentEl_.clientHeight;
    return max > 0 ? this.contentEl_.scrollTop / max : 0;
  }

  /**
   * 给一段文字,在当前章节 DOM 里找匹配位置,创建 NoteAnnotation。
   * 用于 AI 回答存为想法时,源选区已经丢失的情况。
   * 返回 null 表示在当前章节里找不到。
   */
  async createAnnotationFromText(
    text: string,
    opts: {
      color: HighlightColor;
      note: string;
      noteType: NoteType;
    }
  ): Promise<import("./types").NoteAnnotation | null> {
    if (!this.book || !this.data) return null;
    const target = text.trim();
    if (!target) return null;
    // 用 TreeWalker 找包含此文字的第一个文本节点
    this.chapterRootEl.normalize();
    const walker = document.createTreeWalker(
      this.chapterRootEl,
      NodeFilter.SHOW_TEXT
    );
    let n: Node | null;
    let startNode: Text | null = null;
    let startOff = 0;
    let endNode: Text | null = null;
    let endOff = 0;
    while ((n = walker.nextNode())) {
      const t = n as Text;
      const idx = t.data.indexOf(target);
      if (idx >= 0) {
        startNode = t;
        startOff = idx;
        endNode = t;
        endOff = idx + target.length;
        break;
      }
    }
    if (!startNode || !endNode) {
      // 单节点没找到,尝试跨节点 (粗暴: 拼成一段 plaintext 找 index)
      // 限于实现复杂度,这里先放弃跨节点匹配,直接返回 null
      return null;
    }
    const range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    const info = highlightFromRange(range, this.chapterRootEl);
    if (!info) return null;
    const ch = this.book.chapters[this.chapterIndex];
    const now = Date.now();
    const note: import("./types").NoteAnnotation = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 6),
      kind: "note",
      chapterId: ch.id,
      chapterTitle: ch.title,
      ...info,
      color: opts.color,
      style: "fill",
      note: opts.note,
      noteType: opts.noteType,
      createdAt: now,
      updatedAt: now,
    };
    return note;
  }

  askClaudeAbout(text: string) {
    this.plugin.askWithContext({
      bookTitle: this.book?.title || "",
      chapterTitle:
        this.book?.chapters[this.chapterIndex]?.title || "",
      selection: text.trim(),
    });
  }

  askClaudeWithTemplate(text: string, prompt: string) {
    this.plugin.askWithTemplate(
      {
        bookTitle: this.book?.title || "",
        chapterTitle:
          this.book?.chapters[this.chapterIndex]?.title || "",
        selection: text.trim(),
      },
      prompt
    );
  }

  openSearchModal() {
    if (!this.book) return;
    new SearchModal(this.app, this.book, async (chapterIndex, query) => {
      this.pendingSearchQuery = query;
      await this.gotoChapter(chapterIndex, 0);
    }).open();
  }

  /** gotoChapter 之后若有 pendingSearchQuery,在新章节里找首个匹配并滚到它,临时高亮 */
  private pendingSearchQuery: string | null = null;
  private highlightSearchHitInChapter() {
    if (!this.pendingSearchQuery) return;
    const q = this.pendingSearchQuery;
    this.pendingSearchQuery = null;
    const lower = q.toLowerCase();
    // 找第一个匹配的文本节点
    const walker = document.createTreeWalker(
      this.chapterRootEl,
      NodeFilter.SHOW_TEXT
    );
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = n as Text;
      const idx = t.data.toLowerCase().indexOf(lower);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(t, idx);
        range.setEnd(t, idx + q.length);
        // 用临时 span 标记
        const span = document.createElement("span");
        span.className = "cr-search-flash";
        try {
          range.surroundContents(span);
          span.scrollIntoView({ behavior: "smooth", block: "center" });
          window.setTimeout(() => {
            // 还原: 把 span 替换回纯文本
            if (span.parentNode) {
              const text = document.createTextNode(span.textContent || "");
              span.parentNode.replaceChild(text, span);
              this.chapterRootEl.normalize();
            }
          }, 2200);
        } catch {
          // 跨节点 range 不能 surroundContents — 退而求其次,只 scrollIntoView 父元素
          const parent = t.parentElement;
          parent?.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        return;
      }
    }
  }

  openNoteModal(h: Highlight) {
    new NoteModal(
      this.app,
      {
        text: h.text,
        note: h.kind === "note" ? h.note : "",
        color: h.color,
        style: h.style,
        noteType: h.kind === "note" ? h.noteType : "insight",
      },
      async (result) => {
        if (!this.data) return;
        const next: Highlight = result.note.trim()
          ? {
              ...h,
              kind: "note",
              note: result.note.trim(),
              noteType: result.noteType,
              color: result.color,
              style: result.style,
              updatedAt: Date.now(),
            }
          : {
              ...h,
              kind: "highlight",
              color: result.color,
              style: result.style,
              updatedAt: Date.now(),
            };
        // 删除可能多余的字段
        if (next.kind === "highlight") {
          // @ts-expect-error 清理旧的 note 字段
          delete (next as any).note;
          // @ts-expect-error
          delete (next as any).noteType;
        }
        await this.plugin.storage.upsertAnnotation(
          this.data.bookKey,
          next,
          this.data.title
        );
        const idx = this.data.highlights.findIndex((x) => x.id === h.id);
        if (idx >= 0) this.data.highlights[idx] = next;
        await this.gotoChapter(this.chapterIndex, this.scrollPercent());
      }
    ).open();
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

  // ---------- Swipe nav ----------
  registerSwipeNav() {
    // 点按翻页: 左侧 35% → 上翻一页, 右侧 35% → 下翻一页
    // 严格判定为「干净的 tap」: 不滚动、不长按、没产生选区、不点在交互元素上
    let downX = 0;
    let downY = 0;
    let downT = 0;
    let downScrollTop = 0;

    this.contentEl_.addEventListener(
      "pointerdown",
      (e: PointerEvent) => {
        downX = e.clientX;
        downY = e.clientY;
        downT = Date.now();
        downScrollTop = this.contentEl_.scrollTop;
      }
    );

    this.contentEl_.addEventListener(
      "pointerup",
      (e: PointerEvent) => {
        const dx = e.clientX - downX;
        const dy = e.clientY - downY;
        const dt = Date.now() - downT;
        // 判定 tap
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) return;
        if (dt > 350) return; // 长按不算
        if (Math.abs(this.contentEl_.scrollTop - downScrollTop) > 4) return;

        // 有选区不翻
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && sel.toString().length > 0) return;

        // 不在交互元素上 (高亮/链接/图片/按钮/工具条)
        const target = e.target as HTMLElement;
        if (target.closest(".cr-hl, a, img, button, .cr-toolbar")) return;

        const rect = this.contentEl_.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const w = rect.width;
        if (x < w * 0.35) {
          this.flipPage(-1);
        } else if (x > w * 0.65) {
          this.flipPage(1);
        }
        // 中间 30% 不翻 — 留给单纯点击/关闭工具条
      }
    );

    // 桌面: 在章节顶/底时滚轮再滚就翻章
    let wheelLock = false;
    this.registerDomEvent(this.contentEl_, "wheel", (e: WheelEvent) => {
      if (wheelLock) return;
      const atTop = this.contentEl_.scrollTop <= 0;
      const atBottom =
        this.contentEl_.scrollTop + this.contentEl_.clientHeight >=
        this.contentEl_.scrollHeight - 2;
      if (e.deltaY > 30 && atBottom) {
        wheelLock = true;
        this.gotoChapter(this.chapterIndex + 1);
        window.setTimeout(() => (wheelLock = false), 500);
      } else if (e.deltaY < -30 && atTop) {
        wheelLock = true;
        this.gotoChapter(this.chapterIndex - 1, 1);
        window.setTimeout(() => (wheelLock = false), 500);
      }
    });

    // 键盘
    this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
      if (!this.rootEl.isShown()) return;
      if (e.target instanceof HTMLInputElement) return;
      if (e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        this.flipPage(-1);
      } else if (
        e.key === "ArrowRight" ||
        e.key === "PageDown" ||
        e.key === " "
      ) {
        e.preventDefault();
        this.flipPage(1);
      }
    });
  }

  /** 翻一屏。到底自动进下一章;到顶上一章并滚到底 */
  flipPage(direction: 1 | -1) {
    const el = this.contentEl_;
    const step = el.clientHeight * 0.9;
    const atBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
    const atTop = el.scrollTop <= 4;

    if (direction > 0 && atBottom) {
      if (this.book && this.chapterIndex < this.book.chapters.length - 1) {
        this.gotoChapter(this.chapterIndex + 1);
      }
      return;
    }
    if (direction < 0 && atTop) {
      if (this.chapterIndex > 0) {
        this.gotoChapter(this.chapterIndex - 1, 1);
      }
      return;
    }
    el.scrollTo({
      top: el.scrollTop + direction * step,
      behavior: "smooth",
    });
  }
}

class NoteModal extends Modal {
  initial: {
    text: string;
    note: string;
    color: HighlightColor;
    style: HighlightStyle;
    noteType: NoteType;
  };
  onSave: (result: {
    note: string;
    color: HighlightColor;
    style: HighlightStyle;
    noteType: NoteType;
  }) => void;

  constructor(
    app: App,
    initial: {
      text: string;
      note: string;
      color: HighlightColor;
      style: HighlightStyle;
      noteType: NoteType;
    },
    onSave: (result: {
      note: string;
      color: HighlightColor;
      style: HighlightStyle;
      noteType: NoteType;
    }) => void
  ) {
    super(app);
    this.initial = initial;
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cr-note-modal");

    contentEl.createEl("h3", {
      text: "写下你的想法",
      cls: "cr-note-modal-title",
    });

    // 原文引用 (截断 240)
    const txt = this.initial.text;
    const quote = contentEl.createDiv({ cls: "cr-note-modal-quote" });
    quote.setText(txt.length > 240 ? txt.slice(0, 240) + "…" : txt);

    let color = this.initial.color;
    let style = this.initial.style;
    let noteType = this.initial.noteType;

    // 颜色行
    const colorRow = contentEl.createDiv({ cls: "cr-note-row" });
    colorRow.createEl("span", { cls: "cr-note-label", text: "画线颜色" });
    const colorBox = colorRow.createDiv({ cls: "cr-note-color-box" });
    const colorEls: Record<string, HTMLElement> = {};
    for (const c of Object.keys(COLORS) as HighlightColor[]) {
      const dot = colorBox.createDiv({
        cls: "cr-note-color-dot" + (c === color ? " active" : ""),
      });
      dot.style.background = COLORS[c].fill;
      dot.title = COLORS[c].label;
      dot.onclick = () => {
        color = c;
        Object.values(colorEls).forEach((d) =>
          d.removeClass("active")
        );
        dot.addClass("active");
      };
      colorEls[c] = dot;
    }

    // 样式行
    const styleRow = contentEl.createDiv({ cls: "cr-note-row" });
    styleRow.createEl("span", { cls: "cr-note-label", text: "标注样式" });
    const styleBox = styleRow.createDiv({ cls: "cr-note-chips" });
    const styleEls: Record<string, HTMLElement> = {};
    for (const s of STYLES) {
      const chip = styleBox.createDiv({
        cls: "cr-note-chip" + (s.id === style ? " active" : ""),
        text: s.label,
      });
      chip.onclick = () => {
        style = s.id;
        Object.values(styleEls).forEach((d) => d.removeClass("active"));
        chip.addClass("active");
      };
      styleEls[s.id] = chip;
    }

    // 想法类型行
    const typeRow = contentEl.createDiv({ cls: "cr-note-row" });
    typeRow.createEl("span", { cls: "cr-note-label", text: "想法类型" });
    const typeBox = typeRow.createDiv({ cls: "cr-note-chips" });
    const typeEls: Record<string, HTMLElement> = {};
    for (const t of NOTE_TYPES) {
      const chip = typeBox.createDiv({
        cls: "cr-note-chip" + (t.value === noteType ? " active" : ""),
        text: `${t.emoji} ${t.label}`,
      });
      chip.onclick = () => {
        noteType = t.value;
        Object.values(typeEls).forEach((d) => d.removeClass("active"));
        chip.addClass("active");
      };
      typeEls[t.value] = chip;
    }

    // 文本框
    const ta = contentEl.createEl("textarea", {
      cls: "cr-note-modal-input",
      attr: { placeholder: "在这里写下你的想法、疑问或联想…", rows: "6" },
    });
    ta.value = this.initial.note;

    // 按钮
    const actions = contentEl.createDiv({ cls: "cr-note-modal-actions" });
    const cancel = actions.createEl("button", {
      text: "取消",
      cls: "cr-note-modal-btn",
    });
    cancel.onclick = () => this.close();
    const save = actions.createEl("button", {
      text: "保存",
      cls: "cr-note-modal-btn cr-note-modal-save mod-cta",
    });
    save.onclick = () => {
      this.onSave({ note: ta.value, color, style, noteType });
      this.close();
    };

    // 快捷键
    ta.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        this.onSave({ note: ta.value, color, style, noteType });
        this.close();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });

    window.setTimeout(() => ta.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}
