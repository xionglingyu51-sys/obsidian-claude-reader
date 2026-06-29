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
      const err = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${err.slice(0, 300)}`);
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
            handlers.onError(new Error(obj.error?.message || "stream error"));
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
    throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 300)}`);
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
