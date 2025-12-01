/**
 * =================================================================================
 * Project: heck-2api (Bun Edition)
 * Version: 2.7.0 (Aggressive Filter)
 * Author: Senior Software Engineer (Ported by CezDev)
 *
 * [Changelog v2.7]
 * - Fix: Cắt bỏ hoàn toàn các dòng chứa "✩" hoặc "âœ©" (Suggestion stars).
 * - Fix: Dừng stream ngay khi phát hiện dấu hiệu kết thúc câu trả lời chính.
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

// --- [FIXED STREAM PROCESSOR] ---

async function* streamProcessor(upstreamResponse: Response, requestId: string, model: string) {
  const reader = upstreamResponse.body?.getReader();
  if (!reader) throw new Error("No response body from upstream");

  const decoder = new TextDecoder();
  let buffer = "";
  let isReasoning = false;
  let lastChar = ""; 

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        
        let dataStr = line.replace(/^data:\s?/, "");
        if (dataStr.endsWith("\r")) dataStr = dataStr.slice(0, -1);
        
        const tagCheck = dataStr.trim();

        // [AGRESSIVE FILTER]
        // 1. Nếu gặp thẻ báo hiệu kết thúc câu trả lời chính
        if (tagCheck === "[ANSWER_DONE]") break;
        
        // 2. Nếu gặp thẻ bắt đầu phần gợi ý
        if (tagCheck.startsWith("[RELATE_Q")) break;

        // 3. Nếu nội dung chứa ký tự ngôi sao gợi ý (Dấu hiệu của phần Suggestion)
        // Đây là fix quan trọng cho lỗi của bạn
        if (dataStr.includes("✩") || dataStr.includes("âœ©")) break;

        // DeepSeek Logic
        if (tagCheck === "[REASON_START]") { isReasoning = true; continue; }
        if (tagCheck === "[REASON_DONE]") { isReasoning = false; continue; }
        if (tagCheck === "[ANSWER_START]") continue;

        // Smart Formatting
        const cleanStart = dataStr.trimStart();
        const isBlockStart = /^(?:- |\* |\d+\. |### |Step \d)/.test(cleanStart);

        if (!isReasoning && isBlockStart && lastChar && !lastChar.endsWith("\n")) {
             dataStr = "\n" + dataStr;
        }

        if (dataStr.length > 0) lastChar = dataStr;

        let chunk: any = null;
        if (isReasoning) {
          chunk = {
            id: requestId, object: "chat.completion.chunk", created: Date.now()/1000|0, model: model,
            choices: [{ index: 0, delta: { reasoning_content: dataStr }, finish_reason: null }]
          };
        } else {
          chunk = {
            id: requestId, object: "chat.completion.chunk", created: Date.now()/1000|0, model: model,
            choices: [{ index: 0, delta: { content: dataStr }, finish_reason: null }]
          };
        }

        yield `data: ${JSON.stringify(chunk)}\n\n`;
      }
      
      // Kiểm tra buffer tổng để break sớm nếu tag bị chia cắt giữa các chunks
      if (buffer.includes("[ANSWER_DONE]") || buffer.includes("[RELATE_Q") || buffer.includes("✩")) break;
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
console.log(`🚀 Heck-2API (Bun) v2.7 running on port ${CONFIG.PORT}`);
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
