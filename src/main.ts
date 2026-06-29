import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { BookStorage, bookKeyFor } from "./storage";
import { ReaderView, VIEW_TYPE_READER } from "./reader-view";
import { ChatView, VIEW_TYPE_CHAT, AskContext } from "./chat-view";
import { BookshelfView, VIEW_TYPE_SHELF } from "./shelf-view";
import { NotesPanelView, VIEW_TYPE_NOTES } from "./notes-panel";
import { exportBookNotes } from "./export";

interface PromptTemplate {
  label: string;
  prompt: string;
}

const DEFAULT_TEMPLATES: PromptTemplate[] = [
  { label: "解释", prompt: "请用通俗的话帮我理解这段。" },
  { label: "翻译", prompt: "把这段翻译成中文,保持语气。" },
  { label: "批判", prompt: "用批判性视角分析这段的论点和漏洞。" },
  { label: "延伸", prompt: "这段让人想到什么相关的概念或例子? 推荐进一步阅读。" },
];

interface ClaudeReaderSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  templates: PromptTemplate[];
  exportFolder: string;
  fontSize: number; // px
  lineHeight: number; // 1.4 ~ 2.2
  maxWidth: number; // px
  autoSyncNotes: boolean;
}

const DEFAULT_SETTINGS: ClaudeReaderSettings = {
  apiKey: "",
  baseUrl: "https://api.anthropic.com",
  model: "claude-sonnet-4-6",
  systemPrompt:
    "你是一个友好、简洁的阅读助手。用户在读书,会发给你他选中的段落和问题。回答用 markdown,保持简短直接。",
  templates: DEFAULT_TEMPLATES,
  exportFolder: "Reading Notes",
  fontSize: 17,
  lineHeight: 1.75,
  maxWidth: 720,
  autoSyncNotes: false,
};

export type { PromptTemplate };

export default class ClaudeReaderPlugin extends Plugin {
  settings!: ClaudeReaderSettings;
  storage!: BookStorage;

  async onload() {
    await this.loadSettings();
    this.storage = new BookStorage(this.app);

    // 自动同步: storage 变化时若开启就静默写 markdown
    this.storage.onAnnotationChanged(async (data) => {
      if (!this.settings.autoSyncNotes) return;
      // 用 debounce 避免连续多次划线触发多次写盘
      this.scheduleAutoSync(data);
    });

    this.registerView(
      VIEW_TYPE_READER,
      (leaf) => new ReaderView(leaf, this)
    );
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));
    this.registerView(
      VIEW_TYPE_SHELF,
      (leaf) => new BookshelfView(leaf, this)
    );
    this.registerView(
      VIEW_TYPE_NOTES,
      (leaf) => new NotesPanelView(leaf, this)
    );

    // 接管 epub/mobi/azw3/txt 文件打开
    this.registerExtensions(["epub", "mobi", "azw3", "txt"], VIEW_TYPE_READER);

    this.addRibbonIcon("library", "Claude Reader 书架", () =>
      this.activateShelf()
    );
    this.addRibbonIcon("sticky-note", "Claude Reader 笔记", () =>
      this.activateNotes()
    );

    this.addCommand({
      id: "ask-selection",
      name: "用选中文字问 Claude",
      callback: () => {
        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (!text) {
          new Notice("先选中一段文字");
          return;
        }
        this.askWithContext({
          bookTitle: "",
          chapterTitle: "",
          selection: text,
        });
      },
    });

    this.addCommand({
      id: "open-shelf",
      name: "打开 Claude Reader 书架",
      callback: () => this.activateShelf(),
    });
    this.addCommand({
      id: "open-notes",
      name: "打开笔记面板",
      callback: () => this.activateNotes(),
    });
    this.addCommand({
      id: "open-chat",
      name: "打开 Claude Chat 面板",
      callback: () => this.activateChat(),
    });

    this.addCommand({
      id: "export-current-book",
      name: "导出当前书的所有笔记到 markdown",
      callback: async () => {
        const view = this.app.workspace
          .getLeavesOfType(VIEW_TYPE_READER)
          .map((l) => l.view)
          .find((v) => v instanceof ReaderView) as ReaderView | undefined;
        if (!view || !view.data) {
          new Notice("先在阅读器里打开一本书");
          return;
        }
        await this.exportBook(view.data, view.file);
      },
    });

    // obsidian://claude-reader-jump?book=...&id=...
    this.registerObsidianProtocolHandler("claude-reader-jump", async (p) => {
      await this.jumpToAnnotation(p.book, p.id);
    });

    this.addSettingTab(new ClaudeReaderSettingTab(this.app, this));

    this.applyReadingStyles();
  }

  styleEl: HTMLStyleElement | null = null;

  applyReadingStyles() {
    if (!this.styleEl) {
      this.styleEl = document.createElement("style");
      this.styleEl.id = "claude-reader-vars";
      document.head.appendChild(this.styleEl);
    }
    const s = this.settings;
    this.styleEl.textContent = `
      .cr-chapter {
        font-size: ${s.fontSize}px !important;
        line-height: ${s.lineHeight} !important;
        max-width: ${s.maxWidth}px !important;
      }
    `;
  }

  async exportBook(data: import("./types").BookData, bookFile: TFile | null) {
    try {
      const file = await exportBookNotes(this.app, data, bookFile, {
        exportFolder: this.settings.exportFolder,
      });
      new Notice(`已导出 ${data.highlights.length} 条到 ${file.path}`);
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    } catch (e) {
      new Notice("导出失败: " + (e as Error).message);
    }
  }

  /**
   * 静默同步: 不打开 markdown,不弹 notice。autoSyncNotes 开启时由 storage 钩子触发。
   */
  async syncBookSilently(
    data: import("./types").BookData,
    bookFile: TFile | null
  ) {
    try {
      await exportBookNotes(this.app, data, bookFile, {
        exportFolder: this.settings.exportFolder,
      });
    } catch {
      // 静默失败,不打扰
    }
  }

  /** 自动同步: 用一个 short debounce 避免连续多次划线打风暴 */
  private autoSyncTimers = new Map<string, number>();
  scheduleAutoSync(data: import("./types").BookData) {
    const prev = this.autoSyncTimers.get(data.bookKey);
    if (prev) window.clearTimeout(prev);
    const t = window.setTimeout(async () => {
      this.autoSyncTimers.delete(data.bookKey);
      // 找当前 bookFile
      const books = this.app.vault
        .getFiles()
        .filter((f) =>
          ["epub", "mobi", "azw3", "txt"].includes(
            f.extension.toLowerCase()
          )
        );
      let target: TFile | null = null;
      for (const f of books) {
        const k = await bookKeyFor(f);
        if (k === data.bookKey) {
          target = f;
          break;
        }
      }
      await this.syncBookSilently(data, target);
    }, 1500);
    this.autoSyncTimers.set(data.bookKey, t);
  }

  /** obsidian://claude-reader-jump 协议: 找到书的 sidecar -> 找 annotation -> 打开 reader -> 跳章节 -> 滚到附近 */
  async jumpToAnnotation(bookKey: string, annId: string) {
    if (!bookKey || !annId) return;
    // 通过遍历 vault 里的所有书找到对应 bookKey
    const books = this.app.vault
      .getFiles()
      .filter((f) =>
        ["epub", "mobi", "azw3", "txt"].includes(f.extension.toLowerCase())
      );
    let target: TFile | null = null;
    for (const f of books) {
      const k = await bookKeyFor(f);
      if (k === bookKey) {
        target = f;
        break;
      }
    }
    if (!target) {
      new Notice("找不到对应的 EPUB (可能已删除或重命名)");
      return;
    }
    // 找 annotation
    const data = await this.storage.load(bookKey);
    if (!data) return;
    const ann = data.highlights.find((a) => a.id === annId);
    if (!ann) {
      new Notice("找不到这条笔记");
      return;
    }
    // 打开 reader
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_READER,
      state: { file: target.path, jumpToAnnotationId: annId },
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  conversations: import("./chat-view").Conversation[] = [];
  activeConversationId: string | null = null;

  async loadSettings() {
    const raw = ((await this.loadData()) ?? {}) as Partial<
      ClaudeReaderSettings
    > & {
      conversations?: import("./chat-view").Conversation[];
      activeConversationId?: string | null;
    };
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
    this.conversations = Array.isArray(raw.conversations)
      ? raw.conversations
      : [];
    this.activeConversationId = raw.activeConversationId ?? null;
  }

  async saveSettings() {
    const payload = {
      ...this.settings,
      conversations: this.conversations,
      activeConversationId: this.activeConversationId,
    };
    await this.saveData(payload);
  }

  async openBook(file: TFile) {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_READER,
      state: { file: file.path },
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  async activateShelf() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SHELF);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_SHELF, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async activateNotes() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTES);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_NOTES, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  async activateChat(): Promise<ChatView | null> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    let leaf: WorkspaceLeaf | null;
    if (existing.length) {
      leaf = existing[0];
    } else {
      leaf = this.app.workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
      }
    }
    if (!leaf) return null;
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    return view instanceof ChatView ? view : null;
  }

  async askWithContext(ctx: AskContext) {
    const chat = await this.activateChat();
    if (chat) chat.setContext(ctx);
  }

  async askWithTemplate(ctx: AskContext, prompt: string) {
    const chat = await this.activateChat();
    if (chat) chat.setContextAndSend(ctx, prompt);
  }

  /**
   * AI 回答存为「蓝色想法」:
   * - 找到 reader 中对应这段文字的 highlight (或当作新选区,要求 reader 在 active 状态)
   * - 如果当前 reader 里能找到这段文字 → 创建一个蓝色 NoteAnnotation
   * - 否则只能存到剪贴板提示用户手动贴
   */
  async saveAiAnswerAsNote(
    ctx: AskContext,
    aiAnswer: string
  ): Promise<boolean> {
    const view = this.app.workspace
      .getLeavesOfType(VIEW_TYPE_READER)
      .map((l) => l.view)
      .find((v) => v instanceof ReaderView) as ReaderView | undefined;
    if (!view || !view.data || !view.book) {
      new Notice("请先在 Claude Reader 里打开一本书");
      return false;
    }
    if (!ctx.selection) {
      new Notice("没有源选区,无法定位");
      return false;
    }
    // 在当前 reader 的高亮列表里找文字匹配的
    const exist = view.data.highlights.find(
      (a) => a.text.trim() === ctx.selection.trim()
    );
    const note: import("./types").NoteAnnotation = exist
      ? {
          ...exist,
          kind: "note",
          color: "blue",
          note: aiAnswer,
          noteType: "insight",
          updatedAt: Date.now(),
        }
      : await view.createAnnotationFromText(ctx.selection, {
          color: "blue",
          note: aiAnswer,
          noteType: "insight",
        });
    if (!note) {
      new Notice("没找到这段文字在当前章节里,无法定位");
      return false;
    }
    await this.storage.upsertAnnotation(
      view.data.bookKey,
      note,
      view.data.title
    );
    const idx = view.data.highlights.findIndex((x) => x.id === note.id);
    if (idx >= 0) view.data.highlights[idx] = note;
    else view.data.highlights.push(note);
    // 重渲染当前章节
    await view.gotoChapter(view.chapterIndex, view.scrollPercent());
    new Notice("已存为蓝色 AI 想法");
    return true;
  }
}

class ClaudeReaderSettingTab extends PluginSettingTab {
  plugin: ClaudeReaderPlugin;
  constructor(app: App, plugin: ClaudeReaderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("API Key").addText((t) =>
      t
        .setPlaceholder("sk-...")
        .setValue(this.plugin.settings.apiKey)
        .onChange(async (v) => {
          this.plugin.settings.apiKey = v.trim();
          await this.plugin.saveSettings();
        })
    );
    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("中转站地址,留空走 https://api.anthropic.com")
      .addText((t) =>
        t
          .setPlaceholder("https://newapi.deepwisdom.ai")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (v) => {
            this.plugin.settings.baseUrl =
              v.trim() || "https://api.anthropic.com";
            await this.plugin.saveSettings();
          })
      );
    new Setting(containerEl).setName("Model").addText((t) =>
      t
        .setPlaceholder("claude-sonnet-4-6")
        .setValue(this.plugin.settings.model)
        .onChange(async (v) => {
          this.plugin.settings.model = v.trim() || "claude-sonnet-4-6";
          await this.plugin.saveSettings();
        })
    );
    new Setting(containerEl)
      .setName("笔记导出文件夹")
      .setDesc("导出 markdown 笔记会放在这个文件夹下,按书名命名")
      .addText((t) =>
        t
          .setPlaceholder("Reading Notes")
          .setValue(this.plugin.settings.exportFolder)
          .onChange(async (v) => {
            this.plugin.settings.exportFolder = v.trim() || "Reading Notes";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("自动同步笔记到 markdown")
      .setDesc("打开后,每次划线/写想法都自动写回导出文件夹的 markdown")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSyncNotes).onChange(async (v) => {
          this.plugin.settings.autoSyncNotes = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "阅读体验" });

    new Setting(containerEl)
      .setName("字号 (px)")
      .setDesc("阅读区正文字号, 12 ~ 28")
      .addSlider((s) =>
        s
          .setLimits(12, 28, 1)
          .setValue(this.plugin.settings.fontSize)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.fontSize = v;
            await this.plugin.saveSettings();
            this.plugin.applyReadingStyles();
          })
      );

    new Setting(containerEl)
      .setName("行距")
      .setDesc("行高倍数, 1.3 ~ 2.4")
      .addSlider((s) =>
        s
          .setLimits(13, 24, 1)
          .setValue(Math.round(this.plugin.settings.lineHeight * 10))
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.lineHeight = v / 10;
            await this.plugin.saveSettings();
            this.plugin.applyReadingStyles();
          })
      );

    new Setting(containerEl)
      .setName("阅读区最大宽度 (px)")
      .setDesc("阅读区内容最大宽度, 480 ~ 1100")
      .addSlider((s) =>
        s
          .setLimits(480, 1100, 20)
          .setValue(this.plugin.settings.maxWidth)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxWidth = v;
            await this.plugin.saveSettings();
            this.plugin.applyReadingStyles();
          })
      );

    containerEl.createEl("h3", { text: "AI" });

    new Setting(containerEl).setName("System prompt").setDesc("整体指令,所有对话生效").addTextArea((t) => {
      t.setValue(this.plugin.settings.systemPrompt).onChange(async (v) => {
        this.plugin.settings.systemPrompt = v;
        await this.plugin.saveSettings();
      });
      t.inputEl.rows = 4;
      t.inputEl.style.width = "100%";
    });

    // ----- Templates -----
    new Setting(containerEl)
      .setName("快捷 prompt 模板")
      .setDesc("AI 工具条按钮下方的快捷问法,每行一条,格式: 标签 || 完整指令")
      .addTextArea((t) => {
        const text = this.plugin.settings.templates
          .map((p) => `${p.label} || ${p.prompt}`)
          .join("\n");
        t.setValue(text).onChange(async (v) => {
          const lines = v
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          const parsed: PromptTemplate[] = [];
          for (const line of lines) {
            const idx = line.indexOf("||");
            if (idx === -1) {
              parsed.push({ label: line.slice(0, 8), prompt: line });
            } else {
              const label = line.slice(0, idx).trim();
              const prompt = line.slice(idx + 2).trim();
              if (label && prompt) parsed.push({ label, prompt });
            }
          }
          this.plugin.settings.templates =
            parsed.length > 0 ? parsed : DEFAULT_TEMPLATES;
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 8;
        t.inputEl.style.width = "100%";
        t.inputEl.style.fontFamily = "var(--font-monospace)";
      });

    new Setting(containerEl)
      .setName("恢复默认模板")
      .addButton((b) =>
        b
          .setButtonText("恢复默认")
          .onClick(async () => {
            this.plugin.settings.templates = DEFAULT_TEMPLATES;
            await this.plugin.saveSettings();
            this.display();
          })
      );
  }
}
