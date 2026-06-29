import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { BookStorage } from "./storage";
import { ReaderView, VIEW_TYPE_READER } from "./reader-view";
import { ChatView, VIEW_TYPE_CHAT, AskContext } from "./chat-view";
import { BookshelfView, VIEW_TYPE_SHELF } from "./shelf-view";
import { NotesPanelView, VIEW_TYPE_NOTES } from "./notes-panel";

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
}

const DEFAULT_SETTINGS: ClaudeReaderSettings = {
  apiKey: "",
  baseUrl: "https://api.anthropic.com",
  model: "claude-sonnet-4-6",
  systemPrompt:
    "你是一个友好、简洁的阅读助手。用户在读书,会发给你他选中的段落和问题。回答用 markdown,保持简短直接。",
  templates: DEFAULT_TEMPLATES,
};

export type { PromptTemplate };

export default class ClaudeReaderPlugin extends Plugin {
  settings!: ClaudeReaderSettings;
  storage!: BookStorage;

  async onload() {
    await this.loadSettings();
    this.storage = new BookStorage(this.app);

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

    // 接管 epub 文件打开
    this.registerExtensions(["epub"], VIEW_TYPE_READER);

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

    this.addSettingTab(new ClaudeReaderSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
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
