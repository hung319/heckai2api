/**
 * =================================================================================
 * Project: Heck-2API (Bun Edition)
 * Version: 1.5.0 (Crash Fix)
 * Fixes:
 * - [x] "lastUserMsg.substring is not a function" (Handle Multimodal/Array content)
 * - [x] Safe string handling for all message types
 * - [x] Previous fixes (Spacing, Garbage removal, Line breaks)
 * =================================================================================
 */

const CONFIG = {
  PORT: process.env.PORT || 3000,
  API_MASTER_KEY: process.env.API_MASTER_KEY || "1",
  UPSTREAM_API_BASE: process.env.UPSTREAM_API_BASE || "https://api.heckai.weight-wave.com/api/ha/v1",
  AI_LANGUAGE: process.env.AI_LANGUAGE || "Vietnamese",
  
  HEADERS: {
    "Host": "api.heckai.weight-wave.com",
    "Origin": "https://heck.ai",
    "Referer": "https://heck.ai/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    "Accept": "*/*"
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

console.log(`🚀 Heck-2API running on port ${CONFIG.PORT}`);

Bun.serve({
  port: CONFIG.PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
    if (url.pathname === '/v1/chat/completions') return handleChatCompletions(req);
    if (url.pathname === '/v1/models') return handleModels(req);
    return new Response(JSON.stringify({ status: "alive" }), { headers: { "Content-Type": "application/json" } });
  }
});

// --- Hàm xử lý nội dung tin nhắn an toàn ---
function extractContent(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        // Xử lý trường hợp GPT-4 Vision (Array of content parts)
        return content
            .map(part => {
                if (typeof part === 'string') return part;
                if (part?.type === 'text') return part.text || "";
                return ""; // Bỏ qua phần hình ảnh (image_url) vì API text không nhận
            })
            .join("\n");
    }
    return ""; // Fallback cho null/undefined
}

async function handleChatCompletions(req) {
  if (!verifyAuth(req)) return createErrorResponse("Unauthorized", 401);

  const requestId = `chatcmpl-${crypto.randomUUID()}`;
  
  try {
    const body = await req.json();
    let requestModel = body.model || CONFIG.DEFAULT_MODEL;
    let upstreamModel = CONFIG.MODEL_MAP[requestModel] || requestModel;
    
    let fullPrompt = "";
    let lastUserMsg = ""; // Đảm bảo luôn là string

    // --- LOOP FIX ---
    for (const msg of body.messages) {
       // Trích xuất text an toàn từ mọi loại msg
       const cleanContent = extractContent(msg.content);
       
       if (msg.role === 'system') fullPrompt += `[System]: ${cleanContent}\n`;
       else if (msg.role === 'user') {
           fullPrompt += `[User]: ${cleanContent}\n`;
           lastUserMsg = cleanContent;
       }
       else if (msg.role === 'assistant') fullPrompt += `[Assistant]: ${cleanContent}\n`;
    }

    // --- TITLE GENERATION SAFEGUARD ---
    // Đảm bảo lastUserMsg là string và không rỗng trước khi gọi substring
    const safeTitle = (lastUserMsg && typeof lastUserMsg === 'string') ? lastUserMsg : "New Chat";
    const sessionTitle = (safeTitle.substring(0, 15) || "Chat").replace(/\n/g, " ");
    
    const sessionId = await createSession(sessionTitle);

    const response = await fetch(`${CONFIG.UPSTREAM_API_BASE}/chat`, {
      method: "POST",
      headers: CONFIG.HEADERS,
      body: JSON.stringify({
        model: upstreamModel,
        question: fullPrompt.trim(),
        language: CONFIG.AI_LANGUAGE,
        sessionId: sessionId,
        previousQuestion: null,
        previousAnswer: null
      })
    });

    if (!response.ok) return createErrorResponse(`Upstream Error: ${response.status}`, response.status);

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

        while (true) {
          const { done, value } = await reader.read();
          if (done || stopStream) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || "";

          for (const line of lines) {
            let cleanLine = line.endsWith('\r') ? line.slice(0, -1) : line;
            if (!cleanLine.startsWith('data:')) continue;
            
            let temp = cleanLine.slice(5); 
            let content = "";
            if (temp.startsWith(' ')) content = temp.slice(1);
            else content = temp;

            const command = content.trim();
            if (command === '[ANSWER_DONE]' || command === '[RELATE_Q_START]') {
                stopStream = true; break;
            }
            if (command === '[DONE]' || command === '[ANSWER_START]') continue;
            if (command === '[REASON_START]') { isReasoning = true; continue; }
            if (command === '[REASON_DONE]') { isReasoning = false; continue; }
            if (command.startsWith('{"error":')) continue;

            if (content.length === 0) content = "\n";

            const chunk = createChunk(requestId, requestModel, content, null, isReasoning);
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
        }
        
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        console.error("Stream error:", e);
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, { headers: corsHeaders({ 'Content-Type': 'text/event-stream' }) });
  } catch (e) {
    console.error("Critical Error:", e);
    return createErrorResponse(e.message, 500);
  }
}

// --- Helpers ---

async function createSession(title) {
  try {
    const res = await fetch(`${CONFIG.UPSTREAM_API_BASE}/session/create`, {
      method: "POST", headers: CONFIG.HEADERS, body: JSON.stringify({ title })
    });
    if(!res.ok) return crypto.randomUUID();
    const data = await res.json();
    return data.id;
  } catch (e) { return crypto.randomUUID(); }
}

function createChunk(id, model, content, finishReason, isReasoning) {
  const delta = isReasoning ? { reasoning_content: content } : { content: content };
  return {
    id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
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
  if (CONFIG.API_MASTER_KEY === "1") return true;
  return auth === `Bearer ${CONFIG.API_MASTER_KEY}`;
}

function createErrorResponse(msg, code) {
  return new Response(JSON.stringify({ error: { message: msg } }), {
    status: code, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Allow-Headers': '*'
  };
}
