export type HighlightStyle = "fill" | "underline" | "wavy";
export type NoteType = "insight" | "question" | "reminder";

export const STYLES: { id: HighlightStyle; label: string }[] = [
  { id: "fill", label: "填充" },
  { id: "underline", label: "下划线" },
  { id: "wavy", label: "波浪线" },
];

export const NOTE_TYPES: { value: NoteType; label: string; emoji: string }[] = [
  { value: "insight", label: "洞见", emoji: "💡" },
  { value: "question", label: "疑问", emoji: "❓" },
  { value: "reminder", label: "提醒", emoji: "🔔" },
];

/**
 * 两类标记:
 * - highlight: 单纯划线,无笔记
 * - note: 带笔记的想法,必然含 note 文字 + noteType
 *
 * 共享: 锚点 (path + offset)、color、style、text
 */
export interface BaseAnnotation {
  id: string;
  chapterId: string;
  chapterTitle?: string;
  startPath: number[];
  startOffset: number;
  endPath: number[];
  endOffset: number;
  text: string;
  color: HighlightColor;
  style: HighlightStyle;
  createdAt: number;
  updatedAt: number;
}

export interface HighlightAnnotation extends BaseAnnotation {
  kind: "highlight";
}

export interface NoteAnnotation extends BaseAnnotation {
  kind: "note";
  note: string;
  noteType: NoteType;
}

export type Annotation = HighlightAnnotation | NoteAnnotation;

/** 兼容旧版数据 */
export interface LegacyHighlight {
  id: string;
  chapterId: string;
  startPath: number[];
  startOffset: number;
  endPath: number[];
  endOffset: number;
  text: string;
  color: HighlightColor;
  note?: string;
  createdAt: number;
}

export type Highlight = Annotation;

export type HighlightColor = "yellow" | "green" | "pink" | "blue";

export const COLORS: Record<
  HighlightColor,
  { fill: string; label: string; meaning: string }
> = {
  yellow: {
    fill: "rgba(212, 192, 142, 0.45)",
    label: "米黄",
    meaning: "喜欢 / 想记",
  },
  green: {
    fill: "rgba(166, 184, 161, 0.45)",
    label: "雾绿",
    meaning: "想问 / 待确认",
  },
  pink: {
    fill: "rgba(196, 165, 168, 0.45)",
    label: "灰粉",
    meaning: "反对 / 存疑",
  },
  blue: {
    fill: "rgba(158, 178, 196, 0.45)",
    label: "浅蓝",
    meaning: "AI 笔记",
  },
};

export interface BookProgress {
  chapterIndex: number;
  scrollPercent: number;
}

export interface Bookmark {
  id: string;
  chapterId: string;
  chapterTitle?: string;
  scrollPercent: number;
  label: string;
  snippet?: string;
  createdAt: number;
}

export interface BookData {
  bookKey: string; // sha-like, from filename + size
  title: string;
  highlights: Highlight[];
  bookmarks?: Bookmark[];
  progress: BookProgress | null;
  lastOpenedAt: number;
  readingSeconds: number;
  totalChars?: number;
  chapterChars?: number[];
}
