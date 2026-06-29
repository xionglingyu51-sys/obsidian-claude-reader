import {
  ItemView,
  MarkdownRenderer,
  Notice,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type ClaudeReaderPlugin from "./main";
import { streamClaude } from "./api";

export const VIEW_TYPE_CHAT = "claude-reader-chat-view";

export interface AskContext {
  bookTitle: string;
  chapterTitle: string;
  selection: string;
}

type Msg = { role: "user" | "assistant"; content: string };

export class ChatView extends ItemView {
  plugin: ClaudeReaderPlugin;
  messages: Msg[] = [];
  pendingContext: AskContext | null = null;
  messagesEl!: HTMLElement;
  inputEl!: HTMLTextAreaElement;
  sendBtn!: HTMLButtonElement;
  contextEl!: HTMLElement;
  abortController: AbortController | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeReaderPlugin) {
    super(leaf);
    this.plugin = plugin;
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
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("cr-chat-root");

    const header = root.createDiv({ cls: "cr-chat-header" });
    header.createSpan({ text: "Claude Chat", cls: "cr-chat-title" });
    const clearBtn = header.createEl("button", { cls: "cr-icon-btn" });
    setIcon(clearBtn, "trash-2");
    clearBtn.setAttr("aria-label", "清空对话");
    clearBtn.onclick = () => {
      this.messages = [];
      this.pendingContext = null;
      this.renderMessages();
      this.renderContext();
    };

    this.messagesEl = root.createDiv({ cls: "cr-chat-messages" });
    this.renderMessages();

    const inputArea = root.createDiv({ cls: "cr-chat-input-area" });
    this.contextEl = inputArea.createDiv({ cls: "cr-chat-context" });
    this.renderContext();

    const inputRow = inputArea.createDiv({ cls: "cr-chat-input-row" });
    this.inputEl = inputRow.createEl("textarea", {
      cls: "cr-chat-input",
      attr: {
        rows: "1",
        placeholder: "问点什么...",
      },
    });
    this.inputEl.addEventListener("input", () => this.autoSize());
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
    if (!this.pendingContext) return;
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
    if (this.messages.length === 1) this.messagesEl.empty();
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
        system: this.plugin.settings.systemPrompt,
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
