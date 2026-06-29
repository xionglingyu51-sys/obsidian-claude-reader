import {
  ItemView,
  MarkdownRenderer,
  Notice,
  TFile,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type ClaudeReaderPlugin from "./main";
import { streamClaude } from "./api";
import { FileSuggestModal } from "./file-suggest";
import { parseBook } from "./book-parser";

export const VIEW_TYPE_CHAT = "claude-reader-chat-view";

export interface AskContext {
  bookTitle: string;
  chapterTitle: string;
  selection: string;
}

interface AttachedFile {
  path: string;
  kind: "note" | "book";
  content: string;
  fullLength: number;
}

const MAX_FILE_CHARS = 60000;

export type Msg = { role: "user" | "assistant"; content: string };

export interface Conversation {
  id: string;
  title: string;
  messages: Msg[];
  createdAt: number;
  updatedAt: number;
}

export class ChatView extends ItemView {
  plugin: ClaudeReaderPlugin;
  conv: Conversation;
  pendingContext: AskContext | null = null;
  attachedFiles: AttachedFile[] = [];

  rootEl!: HTMLElement;
  messagesEl!: HTMLElement;
  inputEl!: HTMLTextAreaElement;
  sendBtn!: HTMLButtonElement;
  contextEl!: HTMLElement;
  attachBtn!: HTMLButtonElement;
  sidebarEl!: HTMLElement;
  titleEl!: HTMLElement;
  abortController: AbortController | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeReaderPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.conv = this.getOrCreateActiveConversation();
  }

  getOrCreateActiveConversation(): Conversation {
    const id = this.plugin.activeConversationId;
    if (id) {
      const found = this.plugin.conversations.find((c) => c.id === id);
      if (found) return found;
    }
    return this.newConversation(false);
  }

  get messages() {
    return this.conv.messages;
  }
  set messages(v: Msg[]) {
    this.conv.messages = v;
  }

  newConversation(save = true): Conversation {
    const conv: Conversation = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: "新对话",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.plugin.conversations.unshift(conv);
    this.plugin.activeConversationId = conv.id;
    if (save) this.plugin.saveSettings();
    return conv;
  }

  async switchConversation(id: string) {
    const conv = this.plugin.conversations.find((c) => c.id === id);
    if (!conv) return;
    this.conv = conv;
    this.plugin.activeConversationId = id;
    this.attachedFiles = [];
    this.pendingContext = null;
    await this.plugin.saveSettings();
    this.renderAll();
  }

  async deleteConversation(id: string) {
    this.plugin.conversations = this.plugin.conversations.filter(
      (c) => c.id !== id
    );
    if (this.plugin.activeConversationId === id) {
      if (this.plugin.conversations.length === 0) {
        this.conv = this.newConversation(false);
      } else {
        this.conv = this.plugin.conversations[0];
        this.plugin.activeConversationId = this.conv.id;
      }
      this.attachedFiles = [];
      this.pendingContext = null;
    }
    await this.plugin.saveSettings();
    this.renderAll();
  }

  async renameConversation(id: string, title: string) {
    const conv = this.plugin.conversations.find((c) => c.id === id);
    if (!conv) return;
    conv.title = title.trim() || "未命名";
    await this.plugin.saveSettings();
    this.renderSidebar();
    if (this.conv.id === id) this.titleEl?.setText(conv.title);
  }

  getViewType() {
    return VIEW_TYPE_CHAT;
  }
  getDisplayText() {
    return "Claude Chat";
  }
  getIcon() {
    return "message-square";
  }

  async onOpen() {
    this.rootEl = this.containerEl.children[1] as HTMLElement;
    this.rootEl.empty();
    this.rootEl.addClass("cr-chat-root");
    this.renderAll();
  }

  renderAll() {
    this.rootEl.empty();
    this.sidebarEl = this.rootEl.createDiv({ cls: "cr-chat-sidebar" });
    this.renderSidebar();

    const main = this.rootEl.createDiv({ cls: "cr-chat-main" });

    const header = main.createDiv({ cls: "cr-chat-header" });
    const toggleBtn = header.createEl("button", { cls: "cr-icon-btn" });
    setIcon(toggleBtn, "panel-left");
    toggleBtn.setAttr("aria-label", "对话列表");
    toggleBtn.onclick = () =>
      this.rootEl.toggleClass("cr-chat-sidebar-open", true);

    this.titleEl = header.createSpan({
      cls: "cr-chat-title",
      text: this.conv.title,
    });

    const newBtn = header.createEl("button", { cls: "cr-icon-btn" });
    setIcon(newBtn, "plus");
    newBtn.setAttr("aria-label", "新对话");
    newBtn.onclick = async () => {
      this.conv = this.newConversation(true);
      this.attachedFiles = [];
      this.pendingContext = null;
      await this.plugin.saveSettings();
      this.renderAll();
    };

    const clearBtn = header.createEl("button", { cls: "cr-icon-btn" });
    setIcon(clearBtn, "trash-2");
    clearBtn.setAttr("aria-label", "清空当前对话");
    clearBtn.onclick = async () => {
      this.conv.messages = [];
      this.pendingContext = null;
      this.attachedFiles = [];
      await this.plugin.saveSettings();
      this.renderMessages();
      this.renderContext();
    };

    this.messagesEl = main.createDiv({ cls: "cr-chat-messages" });
    this.renderMessages();

    const inputArea = main.createDiv({ cls: "cr-chat-input-area" });
    this.contextEl = inputArea.createDiv({ cls: "cr-chat-context" });
    this.renderContext();

    const inputRow = inputArea.createDiv({ cls: "cr-chat-input-row" });
    this.attachBtn = inputRow.createEl("button", { cls: "cr-chat-attach" });
    setIcon(this.attachBtn, "paperclip");
    this.attachBtn.setAttr("aria-label", "引用文件 (笔记/书)");
    this.attachBtn.onclick = () => this.openFilePicker();

    this.inputEl = inputRow.createEl("textarea", {
      cls: "cr-chat-input",
      attr: {
        rows: "1",
        placeholder: "问点什么... (@ 引用文件)",
      },
    });
    this.inputEl.addEventListener("input", () => {
      this.autoSize();
      const v = this.inputEl.value;
      if (v.endsWith("@")) {
        this.inputEl.value = v.slice(0, -1);
        this.openFilePicker();
      }
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });

    this.sendBtn = inputRow.createEl("button", { cls: "cr-chat-send" });
    setIcon(this.sendBtn, "send-horizontal");
    this.sendBtn.onclick = () => this.send();
  }

  renderSidebar() {
    if (!this.sidebarEl) return;
    this.sidebarEl.empty();
    const top = this.sidebarEl.createDiv({ cls: "cr-chat-sb-top" });
    top.createSpan({ text: "对话", cls: "cr-chat-sb-title" });
    const closeBtn = top.createEl("button", { cls: "cr-icon-btn cr-chat-sb-close" });
    setIcon(closeBtn, "x");
    closeBtn.onclick = () =>
      this.rootEl.toggleClass("cr-chat-sidebar-open", false);

    const newBtn = this.sidebarEl.createEl("button", {
      cls: "cr-chat-sb-new",
    });
    setIcon(newBtn.createSpan({ cls: "cr-chat-sb-new-icon" }), "plus");
    newBtn.createSpan({ text: "新对话" });
    newBtn.onclick = async () => {
      this.conv = this.newConversation(true);
      this.attachedFiles = [];
      this.pendingContext = null;
      await this.plugin.saveSettings();
      this.renderAll();
    };

    const list = this.sidebarEl.createDiv({ cls: "cr-chat-sb-list" });
    if (this.plugin.conversations.length === 0) {
      list.createDiv({ cls: "cr-chat-sb-empty", text: "还没有对话" });
      return;
    }
    for (const c of this.plugin.conversations) {
      const item = list.createDiv({
        cls:
          "cr-chat-sb-item" + (c.id === this.conv.id ? " active" : ""),
      });
      const title = item.createDiv({
        cls: "cr-chat-sb-item-title",
        text: c.title,
      });
      title.onclick = () => {
        this.switchConversation(c.id);
        this.rootEl.toggleClass("cr-chat-sidebar-open", false);
      };
      title.ondblclick = (e) => {
        e.stopPropagation();
        const next = window.prompt("重命名对话", c.title);
        if (next !== null) this.renameConversation(c.id, next);
      };
      const del = item.createEl("button", { cls: "cr-chat-sb-item-del" });
      setIcon(del, "trash-2");
      del.onclick = (e) => {
        e.stopPropagation();
        if (window.confirm(`删除对话「${c.title}」?`)) {
          this.deleteConversation(c.id);
        }
      };
    }
  }

  async onClose() {
    if (this.abortController) this.abortController.abort();
  }

  setContext(ctx: AskContext) {
    this.pendingContext = ctx;
    this.renderContext();
    this.inputEl?.focus();
  }

  async setContextAndSend(ctx: AskContext, prompt: string) {
    this.pendingContext = ctx;
    this.renderContext();
    this.inputEl.value = prompt;
    await this.send();
  }

  renderContext() {
    this.contextEl.empty();

    // 引文 card (划词来的)
    if (this.pendingContext) {
      const c = this.contextEl.createDiv({ cls: "cr-chat-context-card" });
      const meta = c.createDiv({ cls: "cr-chat-context-meta" });
      meta.createSpan({ text: `📖 ${this.pendingContext.bookTitle}` });
      if (this.pendingContext.chapterTitle) {
        meta.createSpan({
          text: ` · ${this.pendingContext.chapterTitle}`,
          cls: "cr-chat-context-sub",
        });
      }
      c.createDiv({
        cls: "cr-chat-context-quote",
        text: this.pendingContext.selection,
      });
      const x = c.createEl("button", { cls: "cr-icon-btn cr-chat-context-x" });
      setIcon(x, "x");
      x.onclick = () => {
        this.pendingContext = null;
        this.renderContext();
      };
    }

    // 引用文件 chips
    if (this.attachedFiles.length > 0) {
      const chips = this.contextEl.createDiv({ cls: "cr-chat-chips" });
      for (const f of this.attachedFiles) {
        const chip = chips.createDiv({ cls: "cr-chat-chip" });
        setIcon(
          chip.createSpan({ cls: "cr-chat-chip-icon" }),
          f.kind === "book" ? "book" : "file-text"
        );
        const name = f.path.split("/").pop() || f.path;
        chip.createSpan({ text: name });
        if (f.content.length < f.fullLength) {
          chip.createSpan({
            cls: "cr-chat-chip-trunc",
            text: ` (${Math.round((f.content.length / f.fullLength) * 100)}%)`,
          });
        }
        const x = chip.createSpan({ cls: "cr-chat-chip-x" });
        setIcon(x, "x");
        x.onclick = (e) => {
          e.stopPropagation();
          this.attachedFiles = this.attachedFiles.filter(
            (a) => a.path !== f.path
          );
          this.renderContext();
        };
      }
    }
  }

  openFilePicker() {
    new FileSuggestModal(this.app, async (file) => {
      await this.attachFile(file);
    }).open();
  }

  async attachFile(file: TFile) {
    if (this.attachedFiles.some((a) => a.path === file.path)) return;
    try {
      const ext = file.extension.toLowerCase();
      if (ext === "md") {
        const txt = await this.app.vault.read(file);
        this.attachedFiles.push({
          path: file.path,
          kind: "note",
          content: txt.slice(0, MAX_FILE_CHARS),
          fullLength: txt.length,
        });
      } else {
        new Notice(`正在解析 ${file.name}...`);
        const buf = await this.app.vault.readBinary(file);
        const book = await parseBook(buf, file.name);
        const fullText = book.chapters
          .map((c) => `# ${c.title}\n\n` + c.html.replace(/<[^>]+>/g, ""))
          .join("\n\n");
        this.attachedFiles.push({
          path: file.path,
          kind: "book",
          content: fullText.slice(0, MAX_FILE_CHARS),
          fullLength: fullText.length,
        });
      }
      this.renderContext();
    } catch (e) {
      new Notice(`加载失败: ${(e as Error).message}`);
    }
  }

  renderMessages() {
    this.messagesEl.empty();
    if (this.messages.length === 0) {
      const e = this.messagesEl.createDiv({ cls: "cr-chat-empty" });
      e.createDiv({ text: "选中书里的文字,点 AI 开始", cls: "cr-chat-empty-title" });
      e.createDiv({ text: "也可以直接在下面输入问题", cls: "cr-chat-empty-sub" });
      return;
    }
    for (const m of this.messages) {
      this.appendBubble(m.role, m.content, true);
    }
  }

  appendBubble(role: "user" | "assistant", text: string, render: boolean) {
    const wrap = this.messagesEl.createDiv({ cls: `cr-msg cr-msg-${role}` });
    const bubble = wrap.createDiv({ cls: "cr-bubble" });
    const content = bubble.createDiv({ cls: "cr-content" });
    if (render && role === "assistant") {
      MarkdownRenderer.render(this.app, text, content, "", this);
    } else {
      content.setText(text);
    }
    this.scrollToBottom();
    return { wrap, bubble, content };
  }

  scrollToBottom() {
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }

  autoSize() {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height =
      Math.min(this.inputEl.scrollHeight, 160) + "px";
  }

  appendSaveAsNoteBtn(
    bubble: HTMLElement,
    aiText: string,
    src: AskContext
  ) {
    const row = bubble.createDiv({ cls: "cr-msg-actions" });
    const btn = row.createEl("button", { cls: "cr-msg-action-btn" });
    setIcon(btn.createSpan({ cls: "cr-msg-action-icon" }), "bookmark-plus");
    btn.createSpan({ text: "存为蓝色想法" });
    btn.onclick = async () => {
      btn.disabled = true;
      const ok = await this.plugin.saveAiAnswerAsNote(src, aiText);
      if (ok) {
        btn.empty();
        btn.createSpan({ text: "已保存到笔记" });
      } else {
        btn.disabled = false;
      }
    };
  }

  buildSystemPrompt(): string {
    let sys = this.plugin.settings.systemPrompt;
    if (this.attachedFiles.length > 0) {
      sys += "\n\n---\n\n用户附加了以下文件作为上下文,请基于它们回答:\n";
      for (const f of this.attachedFiles) {
        const tag = f.kind === "book" ? "[书]" : "[笔记]";
        sys += `\n\n# ${tag} ${f.path}\n\n${f.content}`;
        if (f.content.length < f.fullLength) {
          sys += "\n\n[...内容已截断]";
        }
      }
    }
    return sys;
  }

  buildUserMessage(text: string): string {
    if (!this.pendingContext) return text;
    const c = this.pendingContext;
    let prefix = `我在读《${c.bookTitle}》`;
    if (c.chapterTitle) prefix += ` 「${c.chapterTitle}」`;
    return `${prefix}\n\n> ${c.selection.replace(/\n/g, "\n> ")}\n\n${text || "请帮我理解这段。"}`;
  }

  async send() {
    let text = this.inputEl.value.trim();
    if (!text && this.pendingContext) text = "";
    if (!text && !this.pendingContext) return;
    if (!this.plugin.settings.apiKey) {
      new Notice("请先在设置里填 API key");
      return;
    }

    // 记住这条消息的源选区,以便 AI 回答存为想法时知道贴回哪里
    const sourceCtx = this.pendingContext;
    const fullText = this.buildUserMessage(text);
    this.pendingContext = null;
    this.renderContext();

    this.messages.push({ role: "user", content: fullText });
    if (this.messages.length === 1) {
      this.messagesEl.empty();
      // 首条消息时把 conv 标题改成它的前 24 字
      this.conv.title = text.slice(0, 24) || "新对话";
      this.titleEl?.setText(this.conv.title);
      this.renderSidebar();
    }
    this.conv.updatedAt = Date.now();
    this.appendBubble("user", fullText, false);
    this.inputEl.value = "";
    this.autoSize();

    const placeholder = this.appendBubble("assistant", "", false);
    placeholder.content.addClass("cr-streaming");
    let acc = "";

    this.sendBtn.disabled = true;
    this.abortController = new AbortController();

    streamClaude(
      {
        apiKey: this.plugin.settings.apiKey,
        baseUrl: this.plugin.settings.baseUrl,
        model: this.plugin.settings.model,
        system: this.buildSystemPrompt(),
        messages: this.messages,
      },
      {
        onText: (chunk) => {
          acc += chunk;
          placeholder.content.setText(acc);
          this.scrollToBottom();
        },
        onDone: async () => {
          placeholder.content.removeClass("cr-streaming");
          placeholder.content.empty();
          if (acc) {
            await MarkdownRenderer.render(
              this.app,
              acc,
              placeholder.content,
              "",
              this
            );
            this.messages.push({ role: "assistant", content: acc });
            this.conv.updatedAt = Date.now();
            await this.plugin.saveSettings();
            // 如果用户带着选区上下文问的,AI 回答给一个「存为蓝色想法」按钮
            if (sourceCtx) {
              this.appendSaveAsNoteBtn(placeholder.bubble, acc, sourceCtx);
            }
          } else {
            placeholder.content.createDiv({
              text: "(空回复)",
              cls: "cr-error",
            });
          }
          this.sendBtn.disabled = false;
          this.scrollToBottom();
        },
        onError: (err) => {
          placeholder.content.removeClass("cr-streaming");
          placeholder.content.empty();
          placeholder.content.createDiv({
            text: `出错: ${err.message}`,
            cls: "cr-error",
          });
          this.sendBtn.disabled = false;
        },
      },
      this.abortController.signal
    );
  }
}
