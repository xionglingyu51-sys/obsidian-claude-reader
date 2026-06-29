import { Highlight } from "./types";

/**
 * 计算节点在容器中的「path」: 一连串子节点索引。
 * 用于持久化选区位置,在重新渲染时还原。
 */
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

/**
 * 渲染高亮: 在指定 chapter root 内,用 Range 找到位置,
 * 用 surroundContents 把命中文字段包成 span。
 *
 * 跨多个 text node 的选区: 拆分 range 成多个原子 range。
 */
export function applyHighlight(
  root: HTMLElement,
  h: Highlight,
  onClick: (h: Highlight, target: HTMLElement) => void
) {
  const startNode = nodeFromPath(h.startPath, root);
  const endNode = nodeFromPath(h.endPath, root);
  if (!startNode || !endNode) return;
  if (
    !(startNode instanceof Text) ||
    !(endNode instanceof Text)
  )
    return;

  try {
    const range = document.createRange();
    range.setStart(startNode, h.startOffset);
    range.setEnd(endNode, h.endOffset);
    wrapRangeWithSpans(range, h, onClick);
  } catch {
    // ignore — 偶尔 path 失效
  }
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
    span.className = `cr-hl cr-hl-${h.color}`;
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
 * 给一个 Range,生成 Highlight 的 path 信息。
 * 注意: 必须在「未渲染任何高亮 span」之前调用,否则 path 不稳。
 * 实际使用中我们先 normalize root,再算 path。
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
} | null {
  if (!(range.startContainer instanceof Text)) return null;
  if (!(range.endContainer instanceof Text)) return null;

  return {
    startPath: nodePath(range.startContainer, root),
    startOffset: range.startOffset,
    endPath: nodePath(range.endContainer, root),
    endOffset: range.endOffset,
    text: range.toString(),
  };
}
