import { parseEpub } from "./epub";
import type { EpubBook } from "./epub";

export type SupportedExt = "epub" | "txt" | "mobi" | "azw3";

export const SUPPORTED_EXTENSIONS: SupportedExt[] = ["epub", "txt", "mobi", "azw3"];

/**
 * 统一解析入口。给一个 buffer + 文件名,返回标准 EpubBook 结构。
 */
export async function parseBook(
  buf: ArrayBuffer,
  filename: string
): Promise<EpubBook> {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "epub":
      return await parseEpub(buf);
    case "txt":
      return parseTxt(buf, filename);
    case "mobi":
    case "azw3":
      return await parseMobi(buf, filename);
    default:
      throw new Error(`不支持的格式: ${ext}`);
  }
}

/** TXT: 整书当一章,简单按段落分隔渲染 */
function parseTxt(buf: ArrayBuffer, filename: string): EpubBook {
  // 用 BOM 检测 UTF-8 / UTF-16,fallback UTF-8
  const text = decodeText(new Uint8Array(buf));
  const title = filename.replace(/\.[^.]+$/, "");
  const paragraphs = text.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  // 用启发式切章: 检测"第X章""Chapter X"等标题行,有则切,没有就单章
  const chapters = splitTxtIntoChapters(paragraphs);
  return {
    title,
    author: "",
    chapters,
    resources: new Map(),
  };
}

function decodeText(bytes: Uint8Array): string {
  // BOM check
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.slice(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.slice(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.slice(2));
  }
  // 尝试 utf-8, 失败 fallback gb18030
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return s;
  } catch {
    try {
      return new TextDecoder("gb18030").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

const CHAPTER_HEADING_RE =
  /^\s*(第[\s\d零一二三四五六七八九十百千万]+[章节回卷部篇集]|chapter\s+\d+|prologue|epilogue|[ivxlcdm]+\.\s|\d+\.\s)/i;

function splitTxtIntoChapters(paragraphs: string[]): import("./epub").EpubChapter[] {
  const chapters: import("./epub").EpubChapter[] = [];
  let current: { title: string; paragraphs: string[] } | null = null;

  for (const p of paragraphs) {
    const firstLine = p.split("\n")[0].trim();
    if (
      firstLine.length <= 50 &&
      CHAPTER_HEADING_RE.test(firstLine)
    ) {
      // flush
      if (current) {
        chapters.push(buildChapter(chapters.length, current));
      }
      current = { title: firstLine, paragraphs: [] };
      // 标题行后面如果还有内容,也算到这章
      const rest = p.slice(firstLine.length).trim();
      if (rest) current.paragraphs.push(rest);
    } else {
      if (!current) {
        current = { title: "正文", paragraphs: [] };
      }
      current.paragraphs.push(p);
    }
  }
  if (current && current.paragraphs.length > 0) {
    chapters.push(buildChapter(chapters.length, current));
  }
  if (chapters.length === 0) {
    chapters.push({
      id: "txt-0",
      href: "txt-0",
      title: "正文",
      html: paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n"),
    });
  }
  return chapters;
}

function buildChapter(
  index: number,
  c: { title: string; paragraphs: string[] }
): import("./epub").EpubChapter {
  const html = c.paragraphs
    .map((p) => {
      // 段内换行保留为 <br>
      return `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
  return {
    id: `txt-${index}`,
    href: `txt-${index}`,
    title: c.title || `章节 ${index + 1}`,
    html,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * MOBI / AZW3 解析 — 复杂.
 * 实现策略: 调用一个第三方纯 JS lib `@undecaf/mobi-tools` 或自己解。
 * 为了不引大依赖,这里写一个最小可用版,只支持 PalmDoc 压缩的 MOBI。
 * AZW3 (KF8) 复杂得多,先抛错提示用户转 EPUB。
 */
async function parseMobi(buf: ArrayBuffer, filename: string): Promise<EpubBook> {
  const u8 = new Uint8Array(buf);
  // 简单识别: PalmDB header @ offset 0; PalmDOC type @ offset 60-67 should be "BOOKMOBI"
  if (u8.length < 78) throw new Error("MOBI 文件损坏");
  const type = String.fromCharCode(...u8.slice(60, 68));
  if (type !== "BOOKMOBI") {
    throw new Error(`不是合法的 MOBI/AZW3 (type=${type})`);
  }

  const result = parseMobiBook(u8);
  return {
    title: result.title || filename.replace(/\.[^.]+$/, ""),
    author: result.author,
    chapters: result.chapters,
    resources: new Map(),
  };
}

interface MobiResult {
  title: string;
  author: string;
  chapters: import("./epub").EpubChapter[];
}

/**
 * 解 PalmDB + MOBI header,提取正文 HTML,按 <mbp:pagebreak/> 或 <h1>/<h2> 切章。
 * 只支持 PalmDoc 压缩 (compression=2),不支持 HuffDic (compression=17480 → AZW3 主用)。
 */
function parseMobiBook(u8: Uint8Array): MobiResult {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  // PalmDB header: name(32) ... numRecords @76
  const numRecords = dv.getUint16(76, false);
  const recordOffsets: number[] = [];
  for (let i = 0; i < numRecords; i++) {
    const o = 78 + i * 8;
    recordOffsets.push(dv.getUint32(o, false));
  }
  // record 0 is MOBI header
  const rec0Start = recordOffsets[0];
  const compression = dv.getUint16(rec0Start, false);
  // textLength @ rec0Start+4
  // recordCount @ rec0Start+8 (number of text records)
  const textRecordCount = dv.getUint16(rec0Start + 8, false);
  // MOBI header signature @ rec0Start+16 = "MOBI"
  const mobiSig = String.fromCharCode(...u8.slice(rec0Start + 16, rec0Start + 20));
  if (mobiSig !== "MOBI") {
    throw new Error("MOBI header signature 不对");
  }
  const headerLength = dv.getUint32(rec0Start + 20, false);
  // textEncoding @ rec0Start+28: 1252=cp1252, 65001=utf-8
  const textEncoding = dv.getUint32(rec0Start + 28, false);
  // MOBI version @ rec0Start+36 — 决定 header 是否含 0xF2 extraDataFlags
  const mobiVersion =
    rec0Start + 40 <= u8.length
      ? dv.getUint32(rec0Start + 36, false)
      : 0;
  // fullNameOffset @ rec0Start+84, fullNameLength @ rec0Start+88
  const fullNameOffset = dv.getUint32(rec0Start + 84, false);
  const fullNameLength = dv.getUint32(rec0Start + 88, false);

  // extra data flags @ MOBI header offset 0xF2 (仅 mobiVersion >= 5 才有效)
  let extraDataFlags = 0;
  if (
    mobiVersion >= 5 &&
    headerLength >= 0xf4 &&
    rec0Start + 0xf2 + 2 <= u8.length
  ) {
    extraDataFlags = dv.getUint16(rec0Start + 0xf2, false);
  }

  const titleBytes = u8.slice(
    rec0Start + fullNameOffset,
    rec0Start + fullNameOffset + fullNameLength
  );
  const title = decodeMobiString(titleBytes, textEncoding);

  if (compression !== 1 && compression !== 2) {
    throw new Error(
      `MOBI 用了 HuffDic 或 KF8 压缩 (compression=${compression}),本插件暂不支持。建议用 Calibre 转 EPUB。`
    );
  }

  // 读取文本记录 1..textRecordCount
  const textParts: Uint8Array[] = [];
  for (let i = 1; i <= textRecordCount; i++) {
    const start = recordOffsets[i];
    const end = i + 1 < numRecords ? recordOffsets[i + 1] : u8.length;
    const data = u8.slice(start, end);
    const trimmed = stripTrailingEntries(data, extraDataFlags);
    if (compression === 1) {
      textParts.push(trimmed);
    } else {
      textParts.push(palmDocDecompress(trimmed));
    }
  }
  const fullBytes = concatU8(textParts);
  const fullHtml = decodeMobiString(fullBytes, textEncoding);

  // 按 mbp:pagebreak 切章 (MOBI 最常用)
  let chunks = fullHtml.split(/<mbp:pagebreak\s*\/?>/gi);
  // 如果没 pagebreak,尝试按 <h1>/<h2> 切
  if (chunks.length <= 1) {
    chunks = splitByHeading(fullHtml);
  }
  // 至少一章
  if (chunks.length === 0) chunks = [fullHtml];

  const chapters: import("./epub").EpubChapter[] = chunks
    .map((c, i) => {
      const cleaned = cleanMobiHtml(c);
      const title = extractFirstHeading(c) || `章节 ${i + 1}`;
      return {
        id: `mobi-${i}`,
        href: `mobi-${i}`,
        title,
        html: cleaned,
      };
    })
    .filter((c) => c.html.trim().length > 0);

  if (chapters.length === 0) {
    chapters.push({
      id: "mobi-0",
      href: "mobi-0",
      title: "正文",
      html: cleanMobiHtml(fullHtml),
    });
  }

  return { title, author: "", chapters };
}

function splitByHeading(html: string): string[] {
  // 按 <h1> / <h2> 切
  const parts = html.split(/(?=<h[12]\b)/gi);
  return parts.filter((p) => p.trim().length > 0);
}

function extractFirstHeading(html: string): string {
  const m = html.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i);
  if (!m) return "";
  return m[1].replace(/<[^>]+>/g, "").trim().slice(0, 50);
}

function cleanMobiHtml(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<mbp:[^>]*\/?>/gi, "");
  s = s.replace(/<\/mbp:[^>]*>/gi, "");
  s = s.replace(/\s+style="[^"]*"/gi, "");
  s = s.replace(/\s+class="[^"]*"/gi, "");
  return s.trim();
}

function decodeMobiString(bytes: Uint8Array, encoding: number): string {
  // 中文 MOBI 大部分是 UTF-8 (encoding=65001), 英文 MOBI 是 Windows-1252 (encoding=1252)。
  // 不能用 fatal:true 因为正文里偶有控制字节会让整本切换错编码 — 改为容错解码,
  // 非法字节变 U+FFFD,绝大多数文字仍然正确。
  //
  // 优先级:
  //   1. header 说 65001 → UTF-8
  //   2. header 说 1252  → 但中文盗版 MOBI 经常错标, 用启发式判断: 字节里有大量 >=0xE0 三字节
  //      序列就当 UTF-8, 否则 Windows-1252
  //   3. 其他 → UTF-8 (最常见)
  const looksLikeUtf8 = sniffUtf8(bytes);

  if (encoding === 65001 || looksLikeUtf8) {
    return new TextDecoder("utf-8").decode(bytes);
  }
  if (encoding === 1252) {
    // 但要先排除 GB18030 (有些中文 MOBI 用 GBK 系列编码)
    if (sniffGb18030(bytes)) {
      try {
        return new TextDecoder("gb18030").decode(bytes);
      } catch {
        // ignore
      }
    }
    try {
      return new TextDecoder("windows-1252").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * 简单启发: 扫一段 sample, 数有多少看起来是 UTF-8 多字节序列的开头字节,
 * 并且后续字节确实符合 UTF-8 continuation 模式 (0x80-0xBF)。
 * 中文 UTF-8 文本会有大量 0xE4-0xE9 开头的三字节序列。
 */
function sniffUtf8(bytes: Uint8Array): boolean {
  const sampleLen = Math.min(bytes.length, 8192);
  let utf8MultibyteHits = 0;
  let badBytes = 0;
  for (let i = 0; i < sampleLen; ) {
    const b = bytes[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    if (b >= 0xc2 && b <= 0xdf && i + 1 < sampleLen) {
      // 2-byte
      if ((bytes[i + 1] & 0xc0) === 0x80) {
        utf8MultibyteHits++;
        i += 2;
        continue;
      }
    }
    if (b >= 0xe0 && b <= 0xef && i + 2 < sampleLen) {
      // 3-byte (中文常见)
      if (
        (bytes[i + 1] & 0xc0) === 0x80 &&
        (bytes[i + 2] & 0xc0) === 0x80
      ) {
        utf8MultibyteHits++;
        i += 3;
        continue;
      }
    }
    if (b >= 0xf0 && b <= 0xf4 && i + 3 < sampleLen) {
      // 4-byte
      if (
        (bytes[i + 1] & 0xc0) === 0x80 &&
        (bytes[i + 2] & 0xc0) === 0x80 &&
        (bytes[i + 3] & 0xc0) === 0x80
      ) {
        utf8MultibyteHits++;
        i += 4;
        continue;
      }
    }
    badBytes++;
    i++;
  }
  // 如果命中超过 10 次 UTF-8 序列且坏字节远少于命中,认为是 UTF-8
  return utf8MultibyteHits >= 10 && utf8MultibyteHits >= badBytes * 3;
}

function sniffGb18030(bytes: Uint8Array): boolean {
  // GB18030 双字节区间: 第一字节 0x81-0xFE, 第二字节 0x40-0xFE (除 0x7F)
  // 这和 Windows-1252 的可打印字符范围有重叠, 但中文文本里 >= 0x80 的字节非常密集
  // 而英文 Windows-1252 文本里 >= 0x80 的字节很少 (主要是少数标点)
  const sampleLen = Math.min(bytes.length, 8192);
  let highByteRuns = 0;
  for (let i = 0; i < sampleLen - 1; i++) {
    const b = bytes[i];
    if (b >= 0x81 && b <= 0xfe) {
      const next = bytes[i + 1];
      if (next >= 0x40 && next <= 0xfe && next !== 0x7f) {
        highByteRuns++;
        i++; // skip pair
      }
    }
  }
  return highByteRuns >= 50;
}

/**
 * MOBI 每条 PalmDoc 记录的末尾可能有 trailing entries (元数据,不是正文)。
 * 根据 MOBI header 0xF2 处的 extra-data-flags 位决定有哪些 entries 要剥掉。
 *
 * 注意 bit 0 (multibyte indicator) 在「其他 bits」之后剥,即最先在末尾被消耗。
 *
 * 参考: https://wiki.mobileread.com/wiki/MOBI#Trailing_entries
 */
function stripTrailingEntries(data: Uint8Array, flags: number): Uint8Array {
  if (flags === 0) return data;
  let end = data.length;

  // Step 1: 先剥 bit 1..15 (从最高 bit 往最低 bit 倒序剥, 末尾的先剥)
  for (let bit = 15; bit >= 1; bit--) {
    if ((flags & (1 << bit)) === 0) continue;
    const size = readBackwardVarint(data, end);
    if (size === 0 || size > end) return data; // 异常,放弃剥
    end -= size;
  }

  // Step 2: 最后处理 bit 0 (multibyte char indicator)
  if ((flags & 1) !== 0) {
    if (end <= 0) return data;
    const last = data[end - 1];
    const skip = (last & 0x3) + 1;
    if (skip > end) return data;
    end -= skip;
  }

  return data.slice(0, end);
}

/**
 * 反向 varint: 从末尾往前读,直到遇到「高位为 1」的字节为止,
 * 那个字节是 varint 的「第一字节」(最高 7 位)。
 * 每个字节的低 7 位贡献 value, 高位 1 标记结束 (从右向左读时,第一个高位=1 的字节)。
 *
 * 返回的是这条 trailing entry 的「总长度」(含 varint 自身字节数)。
 */
function readBackwardVarint(data: Uint8Array, endExclusive: number): number {
  // 我们从右往左累积。最后读到的高位=1 字节是 MSB。
  const bytes: number[] = [];
  for (let i = endExclusive - 1; i >= 0 && bytes.length < 4; i--) {
    const b = data[i];
    bytes.push(b & 0x7f);
    if ((b & 0x80) !== 0) {
      // 这是终止字节 (varint 的第一字节, 在数组里是最后一个)
      // 按从 MSB 到 LSB 拼回去
      let value = 0;
      for (let k = bytes.length - 1; k >= 0; k--) {
        value = (value << 7) | bytes[k];
      }
      return value;
    }
  }
  return 0;
}

function concatU8(arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of arrs) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

/** PalmDoc LZ77 解压 */
function palmDocDecompress(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    const byte = input[i++];
    if (byte === 0) {
      out.push(0);
    } else if (byte <= 8) {
      // literal copy of `byte` bytes
      for (let k = 0; k < byte && i < input.length; k++) {
        out.push(input[i++]);
      }
    } else if (byte <= 0x7f) {
      out.push(byte);
    } else if (byte <= 0xbf) {
      // distance/length pair
      if (i >= input.length) break;
      const second = input[i++];
      const combined = ((byte << 8) | second) & 0x3fff;
      const distance = combined >> 3;
      const length = (combined & 0x07) + 3;
      const startPos = out.length - distance;
      for (let k = 0; k < length; k++) {
        out.push(out[startPos + k] || 0);
      }
    } else {
      // 0xc0..0xff: space + (byte ^ 0x80)
      out.push(0x20);
      out.push(byte ^ 0x80);
    }
  }
  return new Uint8Array(out);
}
