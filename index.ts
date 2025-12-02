/**
 * =================================================================================
 * Project: Heck-2API (Bun Edition)
 * Version: 3.5.0 (Hybrid Fix)
 * Base: v3.4.0 Logic + v2.1.0 Standards
 * Fixes:
 * - [x] Enhance Prompt (Force English context & Restore Tag format)
 * - [x] Markdown Formatting (Apply formatChunk from v3.4)
 * - [x] Strict OpenAI Stream (finish_reason: stop for VSCode)
 * =================================================================================
 */

import { randomUUID } from "crypto";

const CONFIG = {
  PORT: parseInt(process.env.PORT || "3000"),
  API_MASTER_KEY: (process.env.API_MASTER_KEY || "1").trim(),
  UPSTREAM_API_BASE: process.env.UPSTREAM_API_BASE || "https://api.heckai.weight-wave.com/api/ha/v1",
  AI_LANGUAGE: process.env.AI_LANGUAGE || "Vietnamese", // Mặc định Việt, nhưng sẽ auto-switch khi Enhance

  HEADERS: {
    "Host": "api.heckai.weight-wave.com",
    "Origin": "https://heck.ai",
    "Referer": "https://heck.ai/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9", // Ưu tiên En để format code tốt hơn
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

console.log(`🚀 Heck-2API v3.5.0 running on port ${CONFIG.PORT}`);

Bun.serve({
  port: CONFIG.PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
    
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        return handleChatCompletions(req);
    }
    
    if (url.pathname === '/v1/models') return handleModels(req);
    
    return new Response(JSON.stringify({ status: "alive" }), { headers: { "Content-Type": "application/json" } });
  }
});

// --- [HELPER FROM v3.4] ---
function formatChunk(text: string): string {
  let formatted = text;
  formatted = formatted.replace(/([^\n])\s?(###+\s)/g, "$1\n\n$2"); // Header
  formatted = formatted.replace(/([a-zA-Z0-9])\s?(\d+\.\s\*\*)/g, "$1\n\n$2"); // List số
  formatted = formatted.replace(/([^\n])\s?(- \*\*|- [a-zA-Z])/g, "$1\n\n$2"); // List thường
  formatted = formatted.replace(/([^\n])\s?(```)/g, "$1\n\n$2"); // Code block
  return formatted;
}

function extractContent(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => (typeof part === 'string' ? part : (part?.text || ""))).join("\n");
    }
    return ""; 
}

async function handleChatCompletions(req) {
  if (!verifyAuth(req)) return createErrorResponse("Unauthorized", 401);

  const requestId = `chatcmpl-${randomUUID()}`;
  
  try {
    const body = await req.json();
    let requestModel = body.model || CONFIG.DEFAULT_MODEL;
    let upstreamModel = CONFIG.MODEL_MAP[requestModel] || requestModel;
    
    // Logic Reasoning
    const allowReasoning = requestModel.includes('r1') || requestModel.includes('think') || requestModel.includes('o1');

    // --- PROMPT BUILDER (Style v3.4) ---
    // Khôi phục lại tag [System]/[User] vì v3.4 chứng minh nó hoạt động tốt
    let fullPrompt = "";
    let lastUserMsg = "";
    
    for (const msg of body.messages) {
       const cleanContent = extractContent(msg.content);
       if (!cleanContent) continue;
       
       if (msg.role === 'system') fullPrompt += `[System]: ${cleanContent}\n`;
       else if (msg.role === 'user') {
           fullPrompt += `[User]: ${cleanContent}\n`;
           lastUserMsg = cleanContent;
       }
       else if (msg.role === 'assistant') fullPrompt += `[Assistant]: ${cleanContent}\n`;
    }

    // --- ENHANCE PROMPT FIX ---
    // Nếu phát hiện lệnh Enhance, ép ngôn ngữ về English để model hiểu lệnh
    // v3.4 hardcode English, ở đây ta linh động
    let targetLanguage = CONFIG.AI_LANGUAGE;
    if (fullPrompt.includes("Generate an enhanced version") || fullPrompt.includes("provide a better version")) {
        targetLanguage = "English";
    }

    const safeTitle = (lastUserMsg && typeof lastUserMsg === 'string') ? lastUserMsg : "Chat";
    const sessionTitle = (safeTitle.substring(0, 15) || "Chat").replace(/\n/g, " ");
    const sessionId = await createSession(sessionTitle);

    // Payload (Match v3.4 structure)
    const payload = {
        model: upstreamModel,
        question: fullPrompt.trim(),
        language: targetLanguage,
        sessionId: sessionId,
        previousQuestion: null,
        previousAnswer: null,
        imgUrls: [], // v3.4 có field này
        superSmartMode: false // v3.4 có field này
    };

    const response = await fetch(`${CONFIG.UPSTREAM_API_BASE}/chat`, {
      method: "POST", headers: CONFIG.HEADERS, body: JSON.stringify(payload)
    });

    if (!response.ok) return createErrorResponse(`Upstream Error: ${response.status}`, response.status);

    // Headers chuẩn cho VSCode/Kilo
    const streamHeaders = corsHeaders({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
    });

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    (async () => {
      try {
        const reader = response.body.getReader();
        let buffer = "";
        let isReasoning = false;
        let stopStream = false;
        let lastChar = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done || stopStream) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || "";

          for (const line of lines) {
            // Regex Parser từ v3.4: Xử lý dính chữ tốt hơn
            let cleanLine = line.replace(/^data: ?/, "");
            if (cleanLine.endsWith("\r")) cleanLine = cleanLine.slice(0, -1);
            
            // Nếu dòng trống (chỉ có data:), skip hoặc xử lý newline
            if (!line.startsWith("data:")) continue;

            const command = cleanLine.trim();

            if (command === '[ANSWER_DONE]' || command.startsWith('[RELATE_Q')) {
                stopStream = true; break;
            }
            if (command === '[DONE]' || command === '[ANSWER_START]') continue;
            
            // Logic DeepSeek R1
            if (command === '[REASON_START]') { if (allowReasoning) isReasoning = true; continue; }
            if (command === '[REASON_DONE]') { isReasoning = false; continue; }
            if (command.startsWith('{"error":')) continue;

            // --- FORMATTING (From v3.4) ---
            let dataStr = cleanLine;
            
            // Garbage cleanup
            if (dataStr.includes("ðŸ˜Š")) dataStr = dataStr.replace(/ðŸ˜Š/g, "😊");
            if (dataStr.includes("âœ©") || dataStr.includes("✩")) break;

            // Apply v3.4 Formatter
            if (!isReasoning) {
                dataStr = formatChunk(dataStr);
                const cleanStart = dataStr.trimStart();
                const isBlockStart = /^(?:- |\* |\d+\. |### |```)/.test(cleanStart);
                if (isBlockStart && lastChar && !lastChar.endsWith("\n")) {
                    dataStr = "\n\n" + dataStr;
                }
            }
            if (dataStr.length > 0) lastChar = dataStr;

            // Handle Empty Content
            if (dataStr.length === 0) dataStr = "\n";

            // --- SEND CHUNK ---
            let finalIsReasoning = isReasoning && allowReasoning;
            const chunk = createChunk(requestId, requestModel, dataStr, null, finalIsReasoning);
            
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
        }
        
        // --- STRICT STANDARD: STOP CHUNK ---
        // VSCode cần cái này, v3.4 không có nhưng ta thêm vào để đảm bảo chuẩn
        const stopChunk = createChunk(requestId, requestModel, "", "stop", false);
        await writer.write(encoder.encode(`data: ${JSON.stringify(stopChunk)}\n\n`));
        
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        
      } catch (e) {
         // Silent error as requested (production mode)
      } finally {
        try { await writer.close(); } catch (e) {}
      }
    })();

    return new Response(readable, { headers: streamHeaders });
  } catch (e) {
    return createErrorResponse(e.message, 500);
  }
}

// --- Helpers ---

async function createSession(title) {
  try {
    const res = await fetch(`${CONFIG.UPSTREAM_API_BASE}/session/create`, {
      method: "POST", headers: CONFIG.HEADERS, body: JSON.stringify({ title })
    });
    if(!res.ok) return randomUUID();
    const data = await res.json();
    return data.id;
  } catch (e) { return randomUUID(); }
}

function createChunk(id, model, content, finishReason, isReasoning) {
  if (finishReason === "stop") {
      return {
        id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      };
  }
  const delta = isReasoning ? { reasoning_content: content } : { content: content };
  return {
    id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: null }]
  };
}

function handleModels(req) {
    const models = Object.keys(CONFIG.MODEL_MAP).map(id => ({
        id, object: "model", created: Date.now(), owned_by: "heck-ai"
    }));
    return new Response(JSON.stringify({ object: "list", data: models }), { headers: corsHeaders() });
}

function verifyAuth(req) {
  const auth = req.headers.get('Authorization');
  if (!auth) return CONFIG.API_MASTER_KEY === "1";
  const token = auth.replace("Bearer ", "").trim();
  return token === CONFIG.API_MASTER_KEY;
}

function createErrorResponse(msg, code) {
  return new Response(JSON.stringify({ error: { message: msg } }), {
    status: code, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function corsHeaders(extra = {}) {
  return {
    ...extra,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Allow-Headers': '*'
  };
}
