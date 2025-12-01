/**
 * =================================================================================
 * Project: heck-2api (Bun Edition)
 * Version: 2.0.0 (Bun Native)
 * Author: Senior Software Engineer (Ported by CezDev)
 *
 * [Tính năng]
 * 1. Bun Native Server (High Performance).
 * 2. Hỗ trợ chuẩn OpenAI (Stream & Non-Stream).
 * 3. Tự động xử lý Session nặc danh.
 * 4. Hỗ trợ DeepSeek Reasoning (reasoning_content).
 * =================================================================================
 */

import { randomUUID } from "crypto";

// --- [Cấu hình] ---
const CONFIG = {
  PORT: parseInt(process.env.PORT || "3000"),
  API_KEY: process.env.API_MASTER_KEY || "1",
  UPSTREAM_API_BASE: process.env.UPSTREAM_API_BASE || "https://api.heckai.weight-wave.com/api/ha/v1",
  
  // Headers giả lập trình duyệt
  HEADERS: {
    "Host": "api.heckai.weight-wave.com",
    "Origin": "https://heck.ai",
    "Referer": "https://heck.ai/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  },

  // Mapping model (OpenAI -> Heck)
  MODEL_MAP: {
    "gpt-4o-mini": "openai/gpt-4o-mini",
    "gpt-4o": "openai/chatgpt-4o-latest",
    "deepseek-r1": "deepseek/deepseek-r1",
    "deepseek-v3": "deepseek/deepseek-chat",
    "gemini-2.5-flash": "google/gemini-2.5-flash-preview",
    "claude-3.7-sonnet": "anthropic/claude-3.7-sonnet",
  } as Record<string, string>,

  DEFAULT_MODEL: "openai/gpt-4o-mini"
};

// --- [Helpers] ---

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function verifyAuth(req: Request): boolean {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return CONFIG.API_KEY === "1"; // Nếu key là "1" thì mở công khai (dev mode)
  const token = authHeader.replace("Bearer ", "").trim();
  return token === CONFIG.API_KEY;
}

// Tạo Session mới từ Upstream
async function createSession(title = "Chat") {
  try {
    const res = await fetch(`${CONFIG.UPSTREAM_API_BASE}/session/create`, {
      method: "POST",
      headers: CONFIG.HEADERS,
      body: JSON.stringify({ title }),
    });
    
    if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
    const data = await res.json() as any;
    return data.id;
  } catch (e) {
    console.error("Session Error:", e);
    throw e;
  }
}

// --- [Core Logic: Stream Parser - Đã sửa lỗi dính chữ] ---

async function* streamProcessor(upstreamResponse: Response, requestId: string, model: string) {
  const reader = upstreamResponse.body?.getReader();
  if (!reader) throw new Error("No response body from upstream");

  const decoder = new TextDecoder();
  let buffer = "";
  let isReasoning = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        // Chỉ xử lý dòng bắt đầu bằng "data: "
        if (!line.startsWith("data: ")) continue;
        
        // Lấy nội dung thô, chỉ cắt bỏ "data: " (6 ký tự)
        // QUAN TRỌNG: Không dùng .trim() ở đây vì sẽ mất dấu cách đầu từ
        let dataStr = line.slice(6);

        // Loại bỏ ký tự \r nếu có (do split \n để lại)
        if (dataStr.endsWith("\r")) {
            dataStr = dataStr.slice(0, -1);
        }

        // Kiểm tra các thẻ điều khiển (Cần trim tạm để so sánh chính xác)
        const tagCheck = dataStr.trim();
        
        if (["[ANSWER_DONE]", "[RELATE_Q_START]", "[RELATE_Q_DONE]", "[ANSWER_START]"].includes(tagCheck)) continue;
        if (tagCheck === "[REASON_START]") { isReasoning = true; continue; }
        if (tagCheck === "[REASON_DONE]") { isReasoning = false; continue; }
        if (tagCheck === "[ERROR]") continue;

        // Xử lý dấu sao (gợi ý câu hỏi) nếu có: Thay vì dính chùm, ta xuống dòng
        if (dataStr.includes("✩")) {
            dataStr = dataStr.replace(/✩/g, "\n\n💡 Gợi ý: ");
        }

        // Xử lý nội dung
        let chunk: any = null;
        
        if (isReasoning) {
          chunk = {
            id: requestId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta: { reasoning_content: dataStr }, finish_reason: null }]
          };
        } else {
          chunk = {
            id: requestId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta: { content: dataStr }, finish_reason: null }]
          };
        }

        yield `data: ${JSON.stringify(chunk)}\n\n`;
      }
    }
    yield `data: [DONE]\n\n`;
  } catch (e) {
    console.error("Stream processing error:", e);
    const errChunk = {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{ index: 0, delta: { content: `\n[Error: Upstream stream failed]` }, finish_reason: "stop" }]
    };
    yield `data: ${JSON.stringify(errChunk)}\n\n`;
  } finally {
    reader.releaseLock();
  }
}

// --- [Handlers] ---

async function handleChatCompletions(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const requestId = `chatcmpl-${randomUUID()}`;
  const requestModel = body.model || "gpt-4o-mini";
  // Logic Map Model
  let upstreamModel = CONFIG.MODEL_MAP[requestModel] || requestModel;
  if (!Object.values(CONFIG.MODEL_MAP).includes(upstreamModel) && !CONFIG.MODEL_MAP[requestModel]) {
     upstreamModel = CONFIG.DEFAULT_MODEL;
  }

  // Xử lý Messages -> Prompt (Heck dùng prompt text)
  let fullPrompt = "";
  let lastUserMsg = "";
  for (const msg of (body.messages || [])) {
    if (msg.role === "system") fullPrompt += `[System]: ${msg.content}\n`;
    else if (msg.role === "user") {
      fullPrompt += `[User]: ${msg.content}\n`;
      lastUserMsg = msg.content;
    }
    else if (msg.role === "assistant") fullPrompt += `[Assistant]: ${msg.content}\n`;
  }
  const question = fullPrompt.trim() || "Hello";

  // 1. Tạo Session ID (Anonymous)
  const sessionTitle = lastUserMsg.substring(0, 10) || "Chat";
  let sessionId;
  try {
    sessionId = await createSession(sessionTitle);
  } catch (e) {
    return Response.json({ error: { message: "Upstream session creation failed", type: "upstream_error" } }, { status: 502 });
  }

  // 2. Gọi Upstream
  const upstreamPayload = {
    model: upstreamModel,
    question: question,
    language: "Chinese", // Có thể chỉnh thành "English" hoặc "Vietnamese" tùy nhu cầu
    sessionId: sessionId,
    previousQuestion: null,
    previousAnswer: null,
    imgUrls: [],
    superSmartMode: false // Bật true nếu muốn ép chế độ suy nghĩ sâu
  };

  const upstreamRes = await fetch(`${CONFIG.UPSTREAM_API_BASE}/chat`, {
    method: "POST",
    headers: CONFIG.HEADERS,
    body: JSON.stringify(upstreamPayload)
  });

  if (!upstreamRes.ok) {
    return Response.json({ error: { message: `Upstream error: ${upstreamRes.status}` } }, { status: upstreamRes.status });
  }

  // 3. Xử lý phản hồi (Stream vs Non-Stream)
  const isStream = body.stream === true;

  if (isStream) {
    // --- Streaming Mode ---
    const stream = streamProcessor(upstreamRes, requestId, requestModel);
    // @ts-ignore: Bun supports async generator as body
    return new Response(stream, {
      headers: {
        ...corsHeaders(),
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Heck-Session-Id": sessionId
      }
    });
  } else {
    // --- Non-Streaming Mode (Buffer toàn bộ) ---
    // Chúng ta phải tiêu thụ streamProcessor để lấy toàn bộ text
    let fullContent = "";
    let fullReasoning = "";
    const stream = streamProcessor(upstreamRes, requestId, requestModel);
    
    for await (const chunkStr of stream) {
      if (chunkStr.trim() === "data: [DONE]") break;
      if (!chunkStr.startsWith("data: ")) continue;
      
      try {
        const jsonStr = chunkStr.slice(6).trim();
        const chunk = JSON.parse(jsonStr);
        if (chunk.choices[0].delta.content) {
          fullContent += chunk.choices[0].delta.content;
        }
        if (chunk.choices[0].delta.reasoning_content) {
          fullReasoning += chunk.choices[0].delta.reasoning_content;
        }
      } catch (e) { /* ignore parse error in chunks */ }
    }

    // Cấu trúc JSON trả về chuẩn OpenAI Non-stream
    const responseBody = {
      id: requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: requestModel,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: fullContent,
          // Một số client hỗ trợ field này ở non-stream (không chuẩn hoàn toàn nhưng hữu ích)
          reasoning_content: fullReasoning || undefined 
        },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } // Dummy usage
    };

    return Response.json(responseBody, { headers: corsHeaders() });
  }
}

// --- [Server Entry] ---

console.log(`🚀 Heck-2API (Bun) starting on port ${CONFIG.PORT}...`);

Bun.serve({
  port: CONFIG.PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Route: /v1/chat/completions
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      if (!verifyAuth(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      return handleChatCompletions(req);
    }

    // Route: /v1/models
    if (url.pathname === "/v1/models" && req.method === "GET") {
      if (!verifyAuth(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const models = Object.keys(CONFIG.MODEL_MAP).map(id => ({
        id, object: "model", created: Date.now(), owned_by: "heck-bun"
      }));
      return Response.json({ object: "list", data: models }, { headers: corsHeaders() });
    }

    // Default: 404
    return Response.json({ error: "Not Found" }, { status: 404 });
  }
});
