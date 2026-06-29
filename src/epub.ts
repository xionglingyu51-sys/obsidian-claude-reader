import { unzipSync, strFromU8 } from "fflate";

export interface EpubChapter {
  id: string;
  href: string;
  title: string;
  html: string;
}

export interface EpubBook {
  title: string;
  author: string;
  chapters: EpubChapter[];
  resources: Map<string, { data: Uint8Array; mime: string }>;
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

export async function parseEpub(buf: ArrayBuffer): Promise<EpubBook> {
  const zip = unzipSync(new Uint8Array(buf));

  // container.xml -> opf path
  const container = zip["META-INF/container.xml"];
  if (!container) throw new Error("不是有效的 EPUB(缺 container.xml)");
  const containerStr = strFromU8(container);
  const opfMatch = containerStr.match(/full-path="([^"]+)"/);
  if (!opfMatch) throw new Error("EPUB 缺少 OPF 路径");
  const opfPath = opfMatch[1];
  const opfDir = opfPath.includes("/")
    ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1)
    : "";

  // parse OPF
  const opfFile = zip[opfPath];
  if (!opfFile) throw new Error("找不到 OPF 文件");
  const opfStr = strFromU8(opfFile);

  // metadata
  const title =
    matchTag(opfStr, "dc:title") || matchTag(opfStr, "title") || "未命名";
  const author =
    matchTag(opfStr, "dc:creator") || matchTag(opfStr, "creator") || "";

  // manifest
  const manifest: Record<string, { href: string; type: string }> = {};
  const itemRe =
    /<item\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(opfStr))) {
    const attrs = m[1];
    const id = attr(attrs, "id");
    const href = attr(attrs, "href");
    const type = attr(attrs, "media-type") || "";
    if (id && href) manifest[id] = { href, type };
  }

  // spine
  const spineIds: string[] = [];
  const spineRe = /<itemref\b([^>]*)\/?>/g;
  while ((m = spineRe.exec(opfStr))) {
    const idref = attr(m[1], "idref");
    if (idref) spineIds.push(idref);
  }

  // toc (try nav.xhtml first, then NCX)
  const tocMap = await buildTocMap(zip, opfDir, manifest);

  // chapters
  const chapters: EpubChapter[] = [];
  for (const id of spineIds) {
    const item = manifest[id];
    if (!item) continue;
    const fullPath = normalizePath(opfDir + item.href);
    const file = zip[fullPath];
    if (!file) continue;
    const html = strFromU8(file);
    const cleaned = cleanChapterHtml(html, fullPath);
    const title =
      tocMap.get(item.href) ||
      tocMap.get(fullPath) ||
      extractH1(cleaned) ||
      `第 ${chapters.length + 1} 节`;
    chapters.push({
      id,
      href: fullPath,
      title,
      html: cleaned,
    });
  }

  // resources (images etc)
  const resources = new Map<string, { data: Uint8Array; mime: string }>();
  for (const [path, data] of Object.entries(zip)) {
    if (!data || (data as Uint8Array).length === 0) continue;
    const ext = path.split(".").pop()?.toLowerCase() || "";
    if (MIME_BY_EXT[ext]) {
      resources.set(path, { data: data as Uint8Array, mime: MIME_BY_EXT[ext] });
    }
  }

  return { title, author, chapters, resources };
}

function matchTag(html: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([^<]*)<\\/${tag}>`, "i");
  const m = html.match(re);
  return m ? decodeEntities(m[1]).trim() : "";
}

function attr(attrs: string, name: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i");
  const m = attrs.match(re);
  return m ? m[1] : "";
}

function normalizePath(p: string): string {
  const parts = p.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

async function buildTocMap(
  zip: Record<string, Uint8Array>,
  opfDir: string,
  manifest: Record<string, { href: string; type: string }>
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  // EPUB3 nav
  for (const [, item] of Object.entries(manifest)) {
    if (item.href.toLowerCase().endsWith("nav.xhtml") || item.type.includes("nav")) {
      const path = normalizePath(opfDir + item.href);
      const file = zip[path];
      if (!file) continue;
      const text = strFromU8(file);
      const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const href = m[1].split("#")[0];
        const title = stripTags(m[2]).trim();
        if (title) {
          map.set(href, title);
          map.set(normalizePath(opfDir + href), title);
        }
      }
      if (map.size > 0) return map;
    }
  }
  // EPUB2 NCX
  for (const [, item] of Object.entries(manifest)) {
    if (
      item.type.includes("dtbncx") ||
      item.href.toLowerCase().endsWith(".ncx")
    ) {
      const path = normalizePath(opfDir + item.href);
      const file = zip[path];
      if (!file) continue;
      const text = strFromU8(file);
      const re =
        /<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\s+src="([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const title = stripTags(m[1]).trim();
        const href = m[2].split("#")[0];
        if (title) {
          map.set(href, title);
          map.set(normalizePath(opfDir + href), title);
        }
      }
    }
  }
  return map;
}

function extractH1(html: string): string {
  const m = html.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i);
  return m ? stripTags(m[1]).trim().slice(0, 40) : "";
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ""));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

/**
 * 清理章节 HTML：去掉 script/style/外部样式/绝对路径，
 * 保留 p/h/blockquote/em/strong/img 等。
 * 同时把图片 src 改成 data-src,由 ReaderView 后续替换为 blob URL。
 */
function cleanChapterHtml(html: string, chapterPath: string): string {
  let body = "";
  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  body = bodyMatch ? bodyMatch[1] : html;

  body = body.replace(/<script[\s\S]*?<\/script>/gi, "");
  body = body.replace(/<style[\s\S]*?<\/style>/gi, "");
  body = body.replace(/<link\b[^>]*>/gi, "");
  body = body.replace(/<meta\b[^>]*>/gi, "");

  // 把 img src 改成 data-src,记录相对路径(用 chapter 目录解析)
  const chapDir = chapterPath.includes("/")
    ? chapterPath.slice(0, chapterPath.lastIndexOf("/") + 1)
    : "";
  body = body.replace(
    /<img\b([^>]*?)src=["']([^"']+)["']([^>]*)>/gi,
    (_full, pre, src, post) => {
      const resolved = normalizePath(chapDir + src.split("#")[0]);
      return `<img ${pre} data-src="${resolved}" ${post}>`;
    }
  );

  // 移除内联 style 里的颜色和背景,防止覆盖主题
  body = body.replace(/\s+style="[^"]*"/gi, "");
  body = body.replace(/\s+class="[^"]*"/gi, "");

  return body;
}
