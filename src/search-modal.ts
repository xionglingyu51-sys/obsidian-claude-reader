import { App, Modal } from "obsidian";
import type { EpubBook, EpubChapter } from "./epub";

export interface SearchHit {
  chapterIndex: number;
  chapterTitle: string;
  /** 文本节点路径 (在 cleaned html parsed 后的 DOM) — 我们直接给章节正文做字符串搜索, 返回 chapterIndex + 命中位置预览 */
  preview: string;
  snippetStart: number;
  fullText: string;
}

const MAX_HITS_PER_CHAPTER = 5;
const MAX_TOTAL_HITS = 200;

/** 把章节 HTML 转纯文本,用于搜索预览(简单 strip 标签) */
function chapterToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class SearchModal extends Modal {
  book: EpubBook;
  onPick: (chapterIndex: number, queryText: string) => void;
  inputEl!: HTMLInputElement;
  listEl!: HTMLElement;
  statusEl!: HTMLElement;
  cachedTexts: string[];
  debounceTimer: number | null = null;

  constructor(
    app: App,
    book: EpubBook,
    onPick: (chapterIndex: number, queryText: string) => void
  ) {
    super(app);
    this.book = book;
    this.onPick = onPick;
    // 预处理所有章节正文 (开销很小,一本书最多几十章)
    this.cachedTexts = book.chapters.map((ch) => chapterToText(ch.html));
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("cr-search-modal");

    contentEl.createEl("h3", { text: "全书搜索", cls: "cr-search-title" });

    this.inputEl = contentEl.createEl("input", {
      cls: "cr-search-input",
      attr: { placeholder: "输入关键词..." },
    });
    this.inputEl.addEventListener("input", () => {
      if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
      this.debounceTimer = window.setTimeout(() => this.runSearch(), 180);
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });

    this.statusEl = contentEl.createDiv({ cls: "cr-search-status" });
    this.statusEl.setText("输入关键词开始搜索");
    this.listEl = contentEl.createDiv({ cls: "cr-search-list" });

    window.setTimeout(() => this.inputEl.focus(), 50);
  }

  runSearch() {
    const q = this.inputEl.value.trim();
    this.listEl.empty();
    if (!q) {
      this.statusEl.setText("输入关键词开始搜索");
      return;
    }
    const qLower = q.toLowerCase();
    const hits: SearchHit[] = [];
    let totalHits = 0;
    for (let i = 0; i < this.book.chapters.length; i++) {
      const ch = this.book.chapters[i];
      const text = this.cachedTexts[i];
      const lower = text.toLowerCase();
      let pos = 0;
      let chapterHits = 0;
      while (chapterHits < MAX_HITS_PER_CHAPTER) {
        const found = lower.indexOf(qLower, pos);
        if (found < 0) break;
        const start = Math.max(0, found - 40);
        const end = Math.min(text.length, found + q.length + 60);
        const before = text.slice(start, found);
        const match = text.slice(found, found + q.length);
        const after = text.slice(found + q.length, end);
        hits.push({
          chapterIndex: i,
          chapterTitle: ch.title,
          preview: (start > 0 ? "…" : "") + before + "<mark>" + escapeHtml(match) + "</mark>" + after + (end < text.length ? "…" : ""),
          snippetStart: found,
          fullText: text,
        });
        chapterHits++;
        totalHits++;
        pos = found + q.length;
        if (totalHits >= MAX_TOTAL_HITS) break;
      }
      if (totalHits >= MAX_TOTAL_HITS) break;
    }
    if (hits.length === 0) {
      this.statusEl.setText("没找到");
      return;
    }
    this.statusEl.setText(
      `找到 ${hits.length} 处${hits.length >= MAX_TOTAL_HITS ? " (已截断)" : ""}`
    );
    // 按章节分组渲染
    let curCh = -1;
    let groupEl: HTMLElement | null = null;
    for (const hit of hits) {
      if (hit.chapterIndex !== curCh) {
        curCh = hit.chapterIndex;
        const grp = this.listEl.createDiv({ cls: "cr-search-group" });
        grp.createDiv({
          cls: "cr-search-group-title",
          text: hit.chapterTitle,
        });
        groupEl = grp.createDiv({ cls: "cr-search-group-items" });
      }
      if (!groupEl) continue;
      const item = groupEl.createDiv({ cls: "cr-search-item" });
      // 不能直接 innerHTML 用户输入,但前面我们 escape 过
      item.innerHTML = hit.preview;
      item.onclick = () => {
        this.close();
        this.onPick(hit.chapterIndex, q);
      };
    }
  }

  onClose() {
    this.contentEl.empty();
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
