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

    // 兜底: 顶栏 AI 按钮 — 选中任意文字后,点这里直接发到 chat
    const askBtn = header.createEl("button", { cls: "cr-icon-btn" });
    askBtn.setText("AI");
    askBtn.setAttr("aria-label", "问选区");
    askBtn.onclick = () => this.askFromCurrentSelection();

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
    // 切换章节时短暂高亮提示
    this.navIndicatorEl.addClass("show");
    if (this.indicatorTimer) window.clearTimeout(this.indicatorTimer);
    this.indicatorTimer = window.setTimeout(() => {
      this.navIndicatorEl.removeClass("show");
      this.indicatorTimer = null;
    }, 1600);
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
