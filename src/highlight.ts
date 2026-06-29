import { Highlight } from "./types";

/* ============================================================
   高亮锚点 = path + offset (主) + text/prefix/suffix (fallback)
   path 失效时,用 text 在章节里搜,用 prefix/suffix 排重复匹配。
   ============================================================ */

export function nodePath(node: Node, root: HTMLElement): number[] {
  const path: number[] = [];
  let cur: Node | null = node;
  while (cur && cur !== root) {
    const parent: Node | null = cur.parentNode;
    if (!parent) break;
    let idx = 0;
    let sibling: Node | null = parent.firstChild;
    while (sibling && sibling !== cur) {
      idx++;
      sibling = sibling.nextSibling;
    }
    path.unshift(idx);
    cur = parent;
  }
  return path;
}

export function nodeFromPath(path: number[], root: HTMLElement): Node | null {
  let cur: Node = root;
  for (const idx of path) {
    if (!cur.childNodes[idx]) return null;
    cur = cur.childNodes[idx];
  }
  return cur;
}

export function applyHighlight(
  root: HTMLElement,
  h: Highlight,
  onClick: (h: Highlight, target: HTMLElement) => void
) {
  // 主路径: path + offset
  if (tryApplyByPath(root, h, onClick)) return;
  // Fallback: 按 text + prefix/suffix 重新定位
  tryApplyByText(root, h, onClick);
}

function tryApplyByPath(
  root: HTMLElement,
  h: Highlight,
  onClick: (h: Highlight, target: HTMLElement) => void
): boolean {
  const startNode = nodeFromPath(h.startPath, root);
  const endNode = nodeFromPath(h.endPath, root);
  if (!(startNode instanceof Text) || !(endNode instanceof Text)) return false;
  if (h.startOffset > startNode.data.length) return false;
  if (h.endOffset > endNode.data.length) return false;
  try {
    const range = document.createRange();
    range.setStart(startNode, h.startOffset);
    range.setEnd(endNode, h.endOffset);
    // 校验: 用 range 实际取出的文字必须等于 h.text
    if (range.toString() !== h.text) return false;
    wrapRangeWithSpans(range, h, onClick);
    return true;
  } catch {
    return false;
  }
}

function tryApplyByText(
  root: HTMLElement,
  h: Highlight,
  onClick: (h: Highlight, target: HTMLElement) => void
): boolean {
  const target = h.text;
  if (!target) return false;

  // 把所有文本节点串成一个长字符串 + 索引映射,便于一次性查找
  const textNodes: Text[] = [];
  const offsets: number[] = [];
  let full = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    textNodes.push(t);
    offsets.push(full.length);
    full += t.data;
  }
  if (!full.includes(target)) return false;

  // 找最佳匹配位置 (用 prefix/suffix 排重复)
  const matchIdx = bestMatch(full, target, h.prefix || "", h.suffix || "");
  if (matchIdx < 0) return false;

  // 把 (matchIdx, matchIdx+target.length) 转回 (textNode, offset)
  const start = locateNodeOffset(textNodes, offsets, matchIdx);
  const end = locateNodeOffset(textNodes, offsets, matchIdx + target.length);
  if (!start || !end) return false;

  try {
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    wrapRangeWithSpans(range, h, onClick);
    return true;
  } catch {
    return false;
  }
}

function bestMatch(
  full: string,
  target: string,
  prefix: string,
  suffix: string
): number {
  // 找所有 occurrence
  const positions: number[] = [];
  let pos = 0;
  while (true) {
    const found = full.indexOf(target, pos);
    if (found < 0) break;
    positions.push(found);
    pos = found + target.length;
    if (positions.length > 100) break; // 防爆
  }
  if (positions.length === 0) return -1;
  if (positions.length === 1) return positions[0];

  // 多个匹配: 用 prefix/suffix 打分,取最高
  let best = positions[0];
  let bestScore = -1;
  for (const p of positions) {
    let score = 0;
    if (prefix) {
      const actualPrefix = full.slice(Math.max(0, p - prefix.length), p);
      score += commonSuffixLength(actualPrefix, prefix);
    }
    if (suffix) {
      const actualSuffix = full.slice(p + target.length, p + target.length + suffix.length);
      score += commonPrefixLength(actualSuffix, suffix);
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
function commonSuffixLength(a: string, b: string): number {
  let i = 0;
  while (
    i < a.length &&
    i < b.length &&
    a[a.length - 1 - i] === b[b.length - 1 - i]
  )
    i++;
  return i;
}

function locateNodeOffset(
  nodes: Text[],
  offsets: number[],
  globalOffset: number
): { node: Text; offset: number } | null {
  // 二分找最后一个 offsets[i] <= globalOffset
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= globalOffset) lo = mid;
    else hi = mid - 1;
  }
  const node = nodes[lo];
  if (!node) return null;
  const offset = globalOffset - offsets[lo];
  if (offset < 0 || offset > node.data.length) return null;
  return { node, offset };
}

function wrapRangeWithSpans(
  range: Range,
  h: Highlight,
  onClick: (h: Highlight, target: HTMLElement) => void
) {
  const textNodes: Text[] = [];
  collectTextNodes(range, textNodes);
  for (const node of textNodes) {
    const isStart = node === range.startContainer;
    const isEnd = node === range.endContainer;
    const start = isStart ? range.startOffset : 0;
    const end = isEnd ? range.endOffset : node.data.length;
    if (start >= end) continue;

    const before = node.data.slice(0, start);
    const middle = node.data.slice(start, end);
    const after = node.data.slice(end);
    if (!middle) continue;

    const parent = node.parentNode;
    if (!parent) continue;

    const span = document.createElement("span");
    const styleCls = `cr-hl-style-${h.style ?? "fill"}`;
    span.className = `cr-hl cr-hl-${h.color} ${styleCls}`;
    if (h.kind === "note") {
      span.classList.add("cr-hl-has-note");
      span.title = h.note;
    }
    span.dataset.hlId = h.id;
    span.textContent = middle;
    span.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick(h, span);
    });

    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    frag.appendChild(span);
    if (after) frag.appendChild(document.createTextNode(after));

    parent.replaceChild(frag, node);
  }
}

function collectTextNodes(range: Range, out: Text[]) {
  const root = range.commonAncestorContainer;
  if (root instanceof Text) {
    out.push(root);
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (range.intersectsNode(node)) return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_REJECT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (n instanceof Text) out.push(n);
  }
}

/**
 * 生成 Highlight 的锚点信息。
 * 同时记录 prefix/suffix (各 32 字符) 用于 fallback 重定位。
 */
export function highlightFromRange(
  range: Range,
  root: HTMLElement
): {
  startPath: number[];
  startOffset: number;
  endPath: number[];
  endOffset: number;
  text: string;
  prefix: string;
  suffix: string;
} | null {
  if (!(range.startContainer instanceof Text)) return null;
  if (!(range.endContainer instanceof Text)) return null;

  const text = range.toString();
  const { prefix, suffix } = extractContext(range, root, 32);

  return {
    startPath: nodePath(range.startContainer, root),
    startOffset: range.startOffset,
    endPath: nodePath(range.endContainer, root),
    endOffset: range.endOffset,
    text,
    prefix,
    suffix,
  };
}

function extractContext(
  range: Range,
  root: HTMLElement,
  len: number
): { prefix: string; suffix: string } {
  // 把章节文本平铺,定位选区在其中的 global offset,取前后 len 个字符
  let full = "";
  let startGlobal = -1;
  let endGlobal = -1;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    if (t === range.startContainer) startGlobal = full.length + range.startOffset;
    if (t === range.endContainer) endGlobal = full.length + range.endOffset;
    full += t.data;
  }
  if (startGlobal < 0 || endGlobal < 0) return { prefix: "", suffix: "" };
  const prefix = full.slice(Math.max(0, startGlobal - len), startGlobal);
  const suffix = full.slice(endGlobal, endGlobal + len);
  return { prefix, suffix };
}
