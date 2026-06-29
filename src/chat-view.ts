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
  /** 截断后的纯文本内容 */
  content: string;
  /** 实际原文长度,用于显示 */
  fullLength: number;
}

const MAX_FILE_CHARS = 60000;

type Msg = { role: "user" | "assistant"; content: string };

export class ChatView extends ItemView {
  plugin: ClaudeReaderPlugin;
  messages: Msg[] = [];
  pendingContext: AskContext | null = null;
  attachedFiles: AttachedFile[] = [];
  messagesEl!: HTMLElement;
  inputEl!: HTMLTextAreaElement;
  sendBtn!: HTMLButtonElement;
  contextEl!: HTMLElement;
  attachBtn!: HTMLButtonElement;
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
      this.attachedFiles = [];
      this.renderMessages();
      this.renderContext();
    };

    this.messagesEl = root.createDiv({ cls: "cr-chat-messages" });
    this.renderMessages();

    const inputArea = root.createDiv({ cls: "cr-chat-input-area" });
    this.contextEl = inputArea.createDiv({ cls: "cr-chat-context" });
    this.renderContext();

    const inputRow = inputArea.createDiv({ cls: "cr-chat-input-row" });
    // 左侧 + 引用文件按钮
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
        // 触发 @ 文件选择
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
