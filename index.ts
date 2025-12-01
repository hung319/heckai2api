/**
 * =================================================================================
 * Project: heck-2api (Bun Edition)
 * Version: 3.3.0 (Regex Parser Fix)
 * Author: Senior Software Engineer (Ported by CezDev)
 *
 * [Changelog v3.3]
 * - Fix: Thay thế slice() bằng Regex /^data: ?/ để xử lý dính chữ triệt để.
 * - Fix: Sửa lỗi hiển thị icon (Mojibake).
 * - Core: Giữ nguyên Logging & Safe Config.
 * =================================================================================
 */

import { randomUUID } from "crypto";

// --- [LOGGING HELPER] ---
const log = (level: "INFO" | "WARN" | "ERROR" | "DEBUG", reqId: string, msg: string, data?: any) => {
  const time = new Date().toISOString().split("T")[1].replace("Z", "");
  let dataStr = "";
  if (data) {
    try {
      const str = JSON.stringify(data);
      dataStr = str.length > 500 ? ` ${str.slice(0, 500)}...` : ` ${str}`;
    } catch { dataStr = " [Data Error]"; }
  }
  const colors = { INFO: "\x1b[32m", WARN: "\x1b[33m", ERROR: "\x1b[31m", DEBUG: "\x1b[36m", RESET: "\x1b[0m" };
  console.log(`${colors[level]}[${time}] [${reqId}] ${msg}${colors.RESET}${dataStr}`);
};

// --- [SAFE CONFIG] ---
const getEnv = (key: string, def: string) => {
  const val = process.env[key];
  return val ? val.trim().replace(/\/$/, "") : def;
};

const CONFIG = {
  PORT: parseInt(process.env.PORT || "3000"),
  API_KEY: (process.env.API_MASTER_KEY || "1").trim(),
  UPSTREAM_API_BASE: getEnv("UPSTREAM_API_BASE", "https://api.heckai.weight-wave.com/api/ha/v1"),
  
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

async function createSession(reqId: string, title = "Chat") {
  const targetUrl = `${CONFIG.UPSTREAM_API_BASE}/session/create`;
  log("DEBUG", reqId, "Creating Upstream Session...", { title });
  try {
    const res = await fetch(targetUrl, {
      method: "POST", headers: CONFIG.HEADERS, body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error(`Status ${res.status}: ${res.statusText}`);
    const data = await res.json() as any;
    log("INFO", reqId, "Session Created", { sessionId: data.id });
    return data.id;
  } catch (e: any) { 
    log("ERROR", reqId, "Session Creation Failed", e.message);
    throw e; 
  }
}

// --- [FORMATTER] ---
function formatChunk(text: string): string {
  let formatted = text;
  // Tự động xuống dòng trước các thẻ quan trọng nếu bị dính
  formatted = formatted.replace(/([^\n])\s?(###+\s)/g, "$1\n\n$2"); // Header
  formatted = formatted.replace(/([a-zA-Z0-9])\s?(\d+\.\s\*\*)/g, "$1\n\n$2"); // List số
  formatted = formatted.replace(/([^\n])\s?(- \*\*|- [a-zA-Z])/g, "$1\n\n$2"); // List thường
  formatted = formatted.replace(/([^\n])\s?(```)/g, "$1\n\n$2"); // Code block
  return formatted;
}

// --- [STREAM PROCESSOR] ---
async function* streamProcessor(upstreamResponse: Response, requestId: string, model: string) {
  const reader = upstreamResponse.body?.getReader();
  if (!reader) {
      log("ERROR", requestId, "No response body");
      throw new Error("No response body");
  }
  log("INFO", requestId, "Stream Started");

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
        // [FIX: Regex Parser] 
        // Thay vì slice(), dùng regex để chỉ xóa "data:" và TỐI ĐA 1 dấu cách.
        // Nếu dòng là "data:  hello" (2 dấu cách) -> kết quả là " hello" (1 dấu cách).
        if (!line.startsWith("data:")) continue;
        let dataStr = line.replace(/^data: ?/, ""); // ? nghĩa là 0 hoặc 1 dấu cách

        if (dataStr.endsWith("\r")) dataStr = dataStr.slice(0, -1);
        
        const tagCheck = dataStr.trim();

        // Filters
        if (tagCheck === "[ANSWER_DONE]") { log("DEBUG", requestId, "End: [ANSWER_DONE]"); break; }
        if (tagCheck.startsWith("[RELATE_Q")) { log("DEBUG", requestId, "End: [RELATE_Q]"); break; }

        // Reasoning
        if (tagCheck === "[REASON_START]") { isReasoning = true; continue; }
        if (tagCheck === "[REASON_DONE]") { isReasoning = false; continue; }
        if (tagCheck === "[ANSWER_START]") continue;

        // Cleanup
        // Fix emoji lỗi font (Mojibake)
        if (dataStr.includes("ðŸ˜Š")) dataStr = dataStr.replace(/ðŸ˜Š/g, "😊");
        // Chặn gợi ý sao
        if (dataStr.includes("âœ©") || dataStr.includes("✩")) { log("DEBUG", requestId, "End: Star"); break; }

        // Formatting
        if (!isReasoning) {
            dataStr = formatChunk(dataStr);
            
            const cleanStart = dataStr.trimStart();
            const isBlockStart = /^(?:- |\* |\d+\. |### |```)/.test(cleanStart);
            if (isBlockStart && lastChar && !lastChar.endsWith("\n")) {
                dataStr = "\n\n" + dataStr;
            }
        }

        if (dataStr.length > 0) lastChar = dataStr;

        // Output Chunk
        let chunk: any = null;
        if (isReasoning) {
          chunk = {
            id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: model,
            choices: [{ index: 0, delta: { reasoning_content: dataStr }, finish_reason: null }]
          };
        } else {
          chunk = {
            id: requestId, object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: model,
            choices: [{ index: 0, delta: { content: dataStr }, finish_reason: null }]
          };
        }
        yield `data: ${JSON.stringify(chunk)}\n\n`;
      }
      
      if (buffer.includes("[ANSWER_DONE]") || buffer.includes("[RELATE_Q")) break;
    }
    log("INFO", requestId, "Stream Finished");
    yield `data: [DONE]\n\n`;
  } catch (e: any) {
    log("ERROR", requestId, "Stream Error", e.message);
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
  const requestId = `chatcmpl-${randomUUID().slice(0, 8)}`;
  let body: any;
  try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  const requestModel = body.model || "gpt-4o-mini";
  log("INFO", requestId, "Request", { model: requestModel, stream: body.stream });

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
    sessionId = await createSession(requestId, sessionTitle);
  } catch (e) { return Response.json({ error: "Upstream session error" }, { status: 502 }); }

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

  if (!upstreamRes.ok) {
      log("ERROR", requestId, "Upstream Failed", await upstreamRes.text());
      return Response.json({ error: `Upstream: ${upstreamRes.status}` }, { status: upstreamRes.status });
  }

  if (body.stream === true) {
    return new Response(streamProcessor(upstreamRes, requestId, requestModel), {
      headers: { ...corsHeaders(), "Content-Type": "text/event-stream", "Connection": "keep-alive" }
    });
  } else {
    log("INFO", requestId, "Non-Stream Accumulating...");
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
      id: requestId, object: "chat.completion", created: Math.floor(Date.now()/1000), model: requestModel,
      choices: [{ index: 0, message: { role: "assistant", content: fullContent, reasoning_content: fullReasoning }, finish_reason: "stop" }]
    }, { headers: corsHeaders() });
  }
}

// --- [SERVER] ---
console.log(`🚀 Heck-2API (Bun) v3.3 running on port ${CONFIG.PORT}`);
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
        return Response.json({ object: "list", data: Object.keys(CONFIG.MODEL_MAP).map(id => ({ id, object: "model", created: Date.now(), owned_by: "heck-bun" })) }, { headers: corsHeaders() });
    }
    return Response.json({ error: "Not Found" }, { status: 404 });
  }
});
