import {
  App,
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

interface ClaudeReaderSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
}

const DEFAULT_SETTINGS: ClaudeReaderSettings = {
  apiKey: "",
  baseUrl: "https://api.anthropic.com",
  model: "claude-sonnet-4-6",
  systemPrompt:
    "你是一个友好、简洁的阅读助手。用户在读书,会发给你他选中的段落和问题。回答用 markdown,保持简短直接。",
};

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

    // 接管 epub 文件打开
    this.registerExtensions(["epub"], VIEW_TYPE_READER);

    this.addRibbonIcon("library", "Claude Reader 书架", () =>
      this.activateShelf()
    );

    this.addCommand({
      id: "open-shelf",
      name: "打开 Claude Reader 书架",
      callback: () => this.activateShelf(),
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
    new Setting(containerEl).setName("System prompt").addTextArea((t) => {
      t.setValue(this.plugin.settings.systemPrompt).onChange(async (v) => {
        this.plugin.settings.systemPrompt = v;
        await this.plugin.saveSettings();
      });
      t.inputEl.rows = 4;
      t.inputEl.style.width = "100%";
    });
  }
}
