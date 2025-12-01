/**
 * =================================================================================
 * Project: heck-2api (Bun Edition)
 * Version: 2.1.0 (Stable)
 * Author: Senior Software Engineer (Ported by CezDev)
 *
 * [Changelog]
 * - Fix: Lỗi dính chữ do hàm trim() (Spaces preserved).
 * - Fix: Lỗi crash khi content là array (Multimodal support).
 * - Feat: Tự động format lại các gợi ý câu hỏi (✩).
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
  if (!authHeader) return CONFIG.API_KEY === "1"; 
  const token = authHeader.replace("Bearer ", "").trim();
  return token === CONFIG.API_KEY;
}

// Trích xuất text an toàn từ message content (xử lý cả string và array)
const extractText = (content: any): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(" ");
  }
  return ""; // Fallback cho null/undefined
};

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

// --- [Core Logic: Stream Parser] ---

/**
 * Generator xử lý stream từ Upstream và convert sang OpenAI Chunk format
 */
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
        if (!line.startsWith("data: ")) continue;
        
        // [FIX TRIMMING] Dùng slice(6) thay vì trim() để giữ khoảng trắng đầu câu
        let dataStr = line.slice(6);
        
        // [FIX NEWLINE] Loại bỏ ký tự \r do split để lại (nếu có)
        if (dataStr.endsWith("\r")) {
            dataStr = dataStr.slice(0, -1);
        }

        // Kiểm tra tags (cần trim tạm để check)
        const tagCheck = dataStr.trim();

        // Bỏ qua các tag điều khiển
        if (["[ANSWER_DONE]", "[RELATE_Q_START]", "[RELATE_Q_DONE]", "[ANSWER_START]"].includes(tagCheck)) continue;
        
        // Logic suy luận (Reasoning)
        if (tagCheck === "[REASON_START]") { isReasoning = true; continue; }
        if (tagCheck === "[REASON_DONE]") { isReasoning = false; continue; }
        if (tagCheck === "[ERROR]") continue;

        // [FEATURE] Format dấu sao (gợi ý) thành xuống dòng
        if (dataStr.includes("✩")) {
            dataStr = dataStr.replace(/✩/g, "\n\n💡 Gợi ý: ");
        }

        // Tạo chunk OpenAI
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
    // Kết thúc stream
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

  // [FIX CRASH] Dùng extractText thay vì lấy trực tiếp msg.content
  let fullPrompt = "";
  let lastUserMsg = "";
  
  for (const msg of (body.messages || [])) {
    const contentStr = extractText(msg.content);

    if (msg.role === "system") {
      fullPrompt += `[System]: ${contentStr}\n`;
    } else if (msg.role === "user") {
      fullPrompt += `[User]: ${contentStr}\n`;
      lastUserMsg = contentStr; // Đảm bảo luôn là string
    } else if (msg.role === "assistant") {
      fullPrompt += `[Assistant]: ${contentStr}\n`;
    }
  }
  
  const question = fullPrompt.trim() || "Hello";

  // 1. Tạo Session ID (Anonymous)
  // [FIX CRASH] Đảm bảo biến title luôn là string an toàn
  const safeTitle = (lastUserMsg || "Chat").toString();
  const sessionTitle = safeTitle.substring(0, 10) || "Chat";
  
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
    language: "Chinese", // Mặc định ngôn ngữ
    sessionId: sessionId,
    previousQuestion: null,
    previousAnswer: null,
    imgUrls: [],
    superSmartMode: false
  };

  const upstreamRes = await fetch(`${CONFIG.UPSTREAM_API_BASE}/chat`, {
    method: "POST",
    headers: CONFIG.HEADERS,
    body: JSON.stringify(upstreamPayload)
  });

  if (!upstreamRes.ok) {
    return Response.json({ error: { message: `Upstream error: ${upstreamRes.status}` } }, { status: upstreamRes.status });
  }

  // 3. Xử lý phản hồi
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
    // --- Non-Streaming Mode ---
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
      } catch (e) { /* ignore */ }
    }

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
          reasoning_content: fullReasoning || undefined 
        },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
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

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      if (!verifyAuth(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      return handleChatCompletions(req);
    }

    if (url.pathname === "/v1/models" && req.method === "GET") {
      if (!verifyAuth(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const models = Object.keys(CONFIG.MODEL_MAP).map(id => ({
        id, object: "model", created: Date.now(), owned_by: "heck-bun"
      }));
      return Response.json({ object: "list", data: models }, { headers: corsHeaders() });
    }

    return Response.json({ error: "Not Found" }, { status: 404 });
  }
});
