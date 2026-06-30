import { App, Modal } from "obsidian";
import {
  COLORS,
  HighlightColor,
  HighlightStyle,
  NOTE_TYPES,
  NoteType,
  STYLES,
} from "./types";

export interface NoteModalInitial {
  text: string;
  note: string;
  color: HighlightColor;
  style: HighlightStyle;
  noteType: NoteType;
}

export interface NoteModalResult {
  note: string;
  color: HighlightColor;
  style: HighlightStyle;
  noteType: NoteType;
}

/**
 * 想法 modal: 选颜色 + 样式 + 想法类型 + 文本。
 * Cmd/Ctrl+Enter 保存, Esc 取消。
 * 风格参考 inklight。
 */
export class NoteModal extends Modal {
  initial: NoteModalInitial;
  onSave: (result: NoteModalResult) => void;

  constructor(
    app: App,
    initial: NoteModalInitial,
    onSave: (result: NoteModalResult) => void
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

    const txt = this.initial.text;
    const quote = contentEl.createDiv({ cls: "cr-note-modal-quote" });
    quote.setText(txt.length > 240 ? txt.slice(0, 240) + "…" : txt);

    let color = this.initial.color;
    let style = this.initial.style;
    let noteType = this.initial.noteType;

    // 颜色
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
        Object.values(colorEls).forEach((d) => d.removeClass("active"));
        dot.addClass("active");
      };
      colorEls[c] = dot;
    }

    // 样式
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

    // 想法类型
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

    const ta = contentEl.createEl("textarea", {
      cls: "cr-note-modal-input",
      attr: { placeholder: "在这里写下你的想法、疑问或联想…", rows: "6" },
    });
    ta.value = this.initial.note;

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
