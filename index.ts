/**
 * =================================================================================
 * Project: heck-2api (Bun Edition)
 * Version: 2.9.0 (Reasoning Support)
 * Author: Senior Software Engineer (Ported by CezDev)
 *
 * [Changelog v2.9]
 * - Feature: Hỗ trợ đầy đủ DeepSeek Reasoning (tách [REASON_START] -> reasoning_content).
 * - Fix: Tự động bỏ qua thẻ [ANSWER_START] để không bị lặp chữ.
 * - Fix: Tự động sửa lỗi font icon (ðŸ˜Š -> 😊).
 * - Fix: Giữ nguyên logic cắt bỏ phần gợi ý (Suggestions).
 * =================================================================================
 */

import { randomUUID } from "crypto";

const CONFIG = {
  PORT: parseInt(process.env.PORT || "3000"),
  API_KEY: process.env.API_MASTER_KEY || "1",
  UPSTREAM_API_BASE: process.env.UPSTREAM_API_BASE || "https://api.heckai.weight-wave.com/api/ha/v1",
  
  HEADERS: {
    "Host": "api.heckai.weight-wave.com",
    "Origin": "https://heck.ai",
    "Referer": "https://heck.ai/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  },

  // Giữ lại danh sách model gọn gàng (v2.6)
  MODEL_MAP: {
    "gemini-2.5-flash": "google/gemini-2.5-flash-preview",
    "deepseek-v3":      "deepseek/deepseek-chat",
    "deepseek-r1":      "deepseek/deepseek-r1",
    "gpt-4o-mini":      "openai/gpt-4o-mini",
    "gpt-4.1-mini":     "openai/gpt-4.1-mini",
    "grok-3-mini":      "x-ai/grok-3-mini-beta",
    "llama-4-scout":    "meta-llama/llama-4-scout",
    "gpt-5-mini":       "openai/gpt-5-mini",
    "gpt-5-nano":       "openai/gpt-5-nano",
  } as Record<string, string>,

  DEFAULT_MODEL: "openai/gpt-4o-mini"
};

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

const extractText = (content: any): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" ");
  }
  return "";
};

async function createSession(title = "Chat") {
  try {
    const res = await fetch(`${CONFIG.UPSTREAM_API_BASE}/session/create`, {
      method: "POST", headers: CONFIG.HEADERS, body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
    const data = await res.json() as any;
    return data.id;
  } catch (e) { console.error("Session Error:", e); throw e; }
}

// --- [CORE LOGIC: REASONING & STREAM PARSER] ---

async function* streamProcessor(upstreamResponse: Response, requestId: string, model: string) {
  const reader = upstreamResponse.body?.getReader();
  if (!reader) throw new Error("No response body from upstream");

  const decoder = new TextDecoder();
  let buffer = "";
  let isReasoning = false; // Trạng thái: Đang suy nghĩ hay đang trả lời
  let lastChar = ""; 

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        // [PARSING] Cắt chuỗi chính xác để giữ khoảng trắng
        let dataStr = "";
        if (line.startsWith("data: ")) dataStr = line.slice(6);
        else if (line.startsWith("data:")) dataStr = line.slice(5);
        else continue;

        if (dataStr.endsWith("\r")) dataStr = dataStr.slice(0, -1);
        
        const tagCheck = dataStr.trim();

        // [CONTROL FLOW]
        // 1. Dừng stream ngay khi xong câu trả lời (Bỏ qua gợi ý)
        if (tagCheck === "[ANSWER_DONE]") break;
        if (tagCheck.startsWith("[RELATE_Q")) break;

        // 2. Chuyển đổi trạng thái Suy luận
        if (tagCheck === "[REASON_START]") { 
            isReasoning = true; 
            continue; 
        }
        if (tagCheck === "[REASON_DONE]") { 
            isReasoning = false; 
            continue; 
        }
        
        // 3. Bỏ qua thẻ bắt đầu trả lời (để không in ra text thừa)
        if (tagCheck === "[ANSWER_START]") continue;

        // [TEXT CLEANUP]
        // Fix lỗi font icon (Mojibake): ðŸ˜Š -> 😊
        if (dataStr.includes("ðŸ˜Š")) dataStr = dataStr.replace(/ðŸ˜Š/g, "😊");
        // Chặn các ký tự gợi ý nếu lọt lưới
        if (dataStr.includes("âœ©") || dataStr.includes("✩")) break;

        // [SMART FORMATTING]
        // Logic xuống dòng thông minh cho các mục lục, code block
        const cleanStart = dataStr.trimStart();
        const isBlockStart = /^(?:- |\* |\d+\. |### |```)/.test(cleanStart);

        if (!isReasoning && isBlockStart && lastChar && !lastChar.endsWith("\n")) {
             dataStr = "\n" + dataStr;
        }

        if (dataStr.length > 0) lastChar = dataStr;

        // [OUTPUT GENERATION]
        let chunk: any = null;
        
        if (isReasoning) {
          // Output cho phần suy nghĩ (OpenAI Standard: reasoning_content)
          chunk = {
            id: requestId, 
            object: "chat.completion.chunk", 
            created: Math.floor(Date.now() / 1000), 
            model: model,
            choices: [{ 
                index: 0, 
                delta: { reasoning_content: dataStr }, // Quan trọng: Đẩy vào field này
                finish_reason: null 
            }]
          };
        } else {
          // Output cho phần trả lời chính
          chunk = {
            id: requestId, 
            object: "chat.completion.chunk", 
            created: Math.floor(Date.now() / 1000), 
            model: model,
            choices: [{ 
                index: 0, 
                delta: { content: dataStr }, 
                finish_reason: null 
            }]
          };
        }

        yield `data: ${JSON.stringify(chunk)}\n\n`;
      }
      
      if (buffer.includes("[ANSWER_DONE]") || buffer.includes("[RELATE_Q")) break;
    }
    yield `data: [DONE]\n\n`;
  } catch (e) {
    console.error("Stream Error:", e);
    yield `data: ${JSON.stringify({
        id: requestId, object: "chat.completion.chunk", model: model,
        choices: [{ index: 0, delta: { content: "\n[Error]" }, finish_reason: "stop" }]
    })}\n\n`;
  } finally {
    reader.releaseLock();
  }
}

// --- [HANDLERS] ---

async function handleChatCompletions(req: Request): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  const requestId = `chatcmpl-${randomUUID()}`;
  const requestModel = body.model || "gpt-4o-mini";
  
  let upstreamModel = CONFIG.MODEL_MAP[requestModel];
  if (!upstreamModel) {
      if (requestModel.includes("/")) upstreamModel = requestModel;
      else upstreamModel = CONFIG.DEFAULT_MODEL;
  }

  let fullPrompt = "";
  let lastUserMsg = "";
  
  for (const msg of (body.messages || [])) {
    const contentStr = extractText(msg.content);
    if (msg.role === "system") fullPrompt += `[System]: ${contentStr}\n`;
    else if (msg.role === "user") {
      fullPrompt += `[User]: ${contentStr}\n`;
      lastUserMsg = contentStr;
    } else if (msg.role === "assistant") fullPrompt += `[Assistant]: ${contentStr}\n`;
  }
  
  const question = fullPrompt.trim() || "Hello";
  const safeTitle = (lastUserMsg || "Chat").toString();
  const sessionTitle = safeTitle.substring(0, 10) || "Chat";
  
  let sessionId;
  try {
    sessionId = await createSession(sessionTitle);
  } catch (e) {
    return Response.json({ error: "Upstream session error" }, { status: 502 });
  }

  const upstreamPayload = {
    model: upstreamModel,
    question: question,
    language: "English",
    sessionId: sessionId,
    previousQuestion: null,
    previousAnswer: null,
    imgUrls: [],
    superSmartMode: false
  };

  const upstreamRes = await fetch(`${CONFIG.UPSTREAM_API_BASE}/chat`, {
    method: "POST", headers: CONFIG.HEADERS, body: JSON.stringify(upstreamPayload)
  });

  if (!upstreamRes.ok) return Response.json({ error: `Upstream: ${upstreamRes.status}` }, { status: upstreamRes.status });

  const isStream = body.stream === true;

  if (isStream) {
    return new Response(streamProcessor(upstreamRes, requestId, requestModel), {
      headers: { ...corsHeaders(), "Content-Type": "text/event-stream", "Connection": "keep-alive" }
    });
  } else {
    // Non-stream handler (Aggregated)
    let fullContent = "";
    let fullReasoning = "";
    for await (const chunkStr of streamProcessor(upstreamRes, requestId, requestModel)) {
      if (chunkStr.includes("[DONE]")) break;
      if (!chunkStr.startsWith("data: ")) continue;
      try {
        const chunk = JSON.parse(chunkStr.slice(6));
        if (chunk.choices[0].delta.content) fullContent += chunk.choices[0].delta.content;
        if (chunk.choices[0].delta.reasoning_content) fullReasoning += chunk.choices[0].delta.reasoning_content;
      } catch {}
    }
    return Response.json({
      id: requestId, object: "chat.completion", created: Date.now()/1000|0, model: requestModel,
      choices: [{ index: 0, message: { role: "assistant", content: fullContent, reasoning_content: fullReasoning }, finish_reason: "stop" }]
    }, { headers: corsHeaders() });
  }
}

// --- [SERVER] ---
console.log(`🚀 Heck-2API (Bun) v2.9 running on port ${CONFIG.PORT}`);
Bun.serve({
  port: CONFIG.PORT,
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    const url = new URL(req.url);
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      if (!verifyAuth(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      return handleChatCompletions(req);
    }
    if (url.pathname === "/v1/models") {
        const models = Object.keys(CONFIG.MODEL_MAP).map(id => ({ id, object: "model", created: Date.now(), owned_by: "heck-bun" }));
        return Response.json({ object: "list", data: models }, { headers: corsHeaders() });
    }
    return Response.json({ error: "Not Found" }, { status: 404 });
  }
});
