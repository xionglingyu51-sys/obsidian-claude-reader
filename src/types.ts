export interface Highlight {
  id: string;
  chapterId: string;
  // 选区定位用 path + offset (XPath-ish)
  startPath: number[];
  startOffset: number;
  endPath: number[];
  endOffset: number;
  text: string;
  color: HighlightColor;
  note?: string;
  createdAt: number;
}

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

export interface BookData {
  bookKey: string; // sha-like, from filename + size
  title: string;
  highlights: Highlight[];
  progress: BookProgress | null;
  lastOpenedAt: number;
  readingSeconds: number;
}
