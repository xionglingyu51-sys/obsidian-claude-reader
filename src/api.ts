import { requestUrl } from "obsidian";

export interface CallParams {
  apiKey: string;
  baseUrl: string;
  model: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

export interface StreamHandlers {
  onText: (chunk: string) => void;
  onDone: () => void;
  onError: (err: Error) => void;
}

/**
 * 粗略 token 估算: 英文按 4 字符/token, 中日韩按 1.5 字符/token。
 * 不准, 但够拦截"显然太长"的情况。
 */
export function estimateTokens(text: string): number {
  let asciiChars = 0;
  let cjkChars = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) asciiChars++;
    else if (c >= 0x3000 && c <= 0x9fff) cjkChars++;
    else cjkChars++;
  }
  return Math.ceil(asciiChars / 4 + cjkChars / 1.5);
}

/** 把 Anthropic 错误响应转换成用户能看懂的话 */
export function formatApiError(status: number, body: string): string {
  let msg = body;
  try {
    const json = JSON.parse(body);
    msg = json?.error?.message || json?.message || body;
  } catch {
    // 不是 json
  }
  // 常见错误专门翻译
  if (status === 401 || /authentication|api key|api_key|invalid/i.test(msg))
    return "API key 无效或没权限,检查设置";
  if (status === 429 || /rate/i.test(msg))
    return "请求过快或额度用尽 (rate limit / quota)";
  if (status === 400 && /context|too long|exceed|max_tokens|tokens/i.test(msg))
    return "上下文太长,Claude 装不下。试试少引用一两个文件,或清空对话";
  if (status === 404 || /model/i.test(msg))
    return `模型名 / base URL 可能写错: ${msg.slice(0, 120)}`;
  if (status === 0 || /network|fetch|connect/i.test(msg))
    return "网络问题: 中转站不通或被屏蔽";
  return `HTTP ${status}: ${msg.slice(0, 200)}`;
}

export async function streamClaude(
  params: CallParams,
  handlers: StreamHandlers,
  signal?: AbortSignal
) {
  const url = params.baseUrl.replace(/\/+$/, "") + "/v1/messages";
  const body = JSON.stringify({
    model: params.model,
    max_tokens: 4096,
    system: params.system,
    stream: true,
    messages: params.messages,
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": params.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body,
      signal,
    });
    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      throw new Error(formatApiError(res.status, errText));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const ev of events) {
        const lines = ev.split("\n");
        let data = "";
        for (const l of lines) if (l.startsWith("data:")) data = l.slice(5).trim();
        if (!data) continue;
        try {
          const obj = JSON.parse(data);
          if (
            obj.type === "content_block_delta" &&
            obj.delta?.type === "text_delta"
          ) {
            handlers.onText(obj.delta.text || "");
          } else if (obj.type === "error") {
            handlers.onError(
              new Error(obj.error?.message || "stream error")
            );
          }
        } catch {}
      }
    }
    handlers.onDone();
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      handlers.onDone();
      return;
    }
    try {
      const text = await callNonStream(params);
      handlers.onText(text);
      handlers.onDone();
    } catch (e2) {
      handlers.onError(e2 as Error);
    }
  }
}

async function callNonStream(p: CallParams): Promise<string> {
  const url = p.baseUrl.replace(/\/+$/, "") + "/v1/messages";
  const res = await requestUrl({
    url,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": p.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: p.model,
      max_tokens: 4096,
      system: p.system,
      messages: p.messages,
    }),
    throw: false,
  });
  if (res.status >= 400) {
    throw new Error(formatApiError(res.status, res.text));
  }
  const json = res.json as {
    content?: Array<{ type: string; text?: string }>;
    error?: { message?: string };
  };
  if (json.error) throw new Error(json.error.message || "未知错误");
  return (
    json.content
      ?.filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("") || "(空回复)"
  );
}
