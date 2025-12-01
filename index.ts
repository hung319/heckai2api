/**
 * =================================================================================
 * Project: Heck-2API (Bun Edition)
 * Version: 1.2.0 (Updated Model Map)
 * Fixes included: 
 * - Sticky words (Spacing fix)
 * - Garbage output removal ([ANSWER_DONE] trigger)
 * =================================================================================
 */

const CONFIG = {
  PORT: process.env.PORT || 3000,
  API_MASTER_KEY: process.env.API_MASTER_KEY || "1",
  UPSTREAM_API_BASE: process.env.UPSTREAM_API_BASE || "https://api.heckai.weight-wave.com/api/ha/v1",
  AI_LANGUAGE: process.env.AI_LANGUAGE || "Vietnamese", // Mặc định trả lời tiếng Việt
  
  // Headers giả lập trình duyệt Chrome 142
  HEADERS: {
    "Host": "api.heckai.weight-wave.com",
    "Origin": "https://heck.ai",
    "Referer": "https://heck.ai/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    "Accept": "*/*"
  },

  // Danh sách model mới nhất
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
  
  // Model mặc định nếu client gửi lên model không có trong list
  DEFAULT_MODEL: "openai/gpt-4o-mini"
};

console.log(`🚀 Heck-2API running on port ${CONFIG.PORT}`);
console.log(`📋 Loaded ${Object.keys(CONFIG.MODEL_MAP).length} models.`);

Bun.serve({
  port: CONFIG.PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Xử lý CORS Preflight
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

    // API Routes
    if (url.pathname === '/v1/chat/completions') return handleChatCompletions(req);
    if (url.pathname === '/v1/models') return handleModels(req);

    // Health Check
    return new Response(JSON.stringify({ status: "alive", models: Object.keys(CONFIG.MODEL_MAP) }), { 
        headers: { "Content-Type": "application/json" } 
    });
  }
});

// --- Core Logic ---

async function handleChatCompletions(req) {
  if (!verifyAuth(req)) return createErrorResponse("Unauthorized", 401);

  const requestId = `chatcmpl-${crypto.randomUUID()}`;
  
  try {
    const body = await req.json();
    
    // 1. Map Model: Client Model -> Heck Model
    let requestModel = body.model || CONFIG.DEFAULT_MODEL;
    let upstreamModel = CONFIG.MODEL_MAP[requestModel] || requestModel;
    
    // 2. Tạo Prompt & Session
    let fullPrompt = "";
    let lastUserMsg = "";
    for (const msg of body.messages) {
       if (msg.role === 'system') fullPrompt += `[System]: ${msg.content}\n`;
       else if (msg.role === 'user') {
           fullPrompt += `[User]: ${msg.content}\n`;
           lastUserMsg = msg.content;
       }
       else if (msg.role === 'assistant') fullPrompt += `[Assistant]: ${msg.content}\n`;
    }

    // Tiêu đề session lấy 15 ký tự đầu của câu hỏi user
    const sessionTitle = (lastUserMsg.substring(0, 15) || "New Chat").replace(/\n/g, " ");
    const sessionId = await createSession(sessionTitle);

    // 3. Payload chuẩn
    const upstreamPayload = {
      model: upstreamModel,
      question: fullPrompt.trim(),
      language: CONFIG.AI_LANGUAGE,
      sessionId: sessionId,
      previousQuestion: null,
      previousAnswer: null
    };

    // 4. Gọi Upstream
    const response = await fetch(`${CONFIG.UPSTREAM_API_BASE}/chat`, {
      method: "POST",
      headers: CONFIG.HEADERS,
      body: JSON.stringify(upstreamPayload)
    });

    if (!response.ok) return createErrorResponse(`Upstream Error: ${response.status}`, response.status);

    // 5. Xử lý Stream (Fix lỗi dính chữ & Rác)
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    (async () => {
      try {
        const reader = response.body.getReader();
        let buffer = "";
        let isReasoning = false;
        let stopStream = false; // Cờ ngắt stream cứng

        while (true) {
          const { done, value } = await reader.read();
          if (done || stopStream) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || "";

          for (const line of lines) {
            // [FIX] Xử lý CRLF, không dùng .trim() để bảo toàn khoảng trắng
            let cleanLine = line.endsWith('\r') ? line.slice(0, -1) : line;

            if (!cleanLine.startsWith('data: ')) continue;
            
            // Lấy nội dung sau 'data: ' (giữ nguyên khoảng trắng đầu)
            let dataStr = cleanLine.slice(6); 
            if (!dataStr) continue;

            // --- Logic điều khiển ---
            const command = dataStr.trim(); // Bản copy đã trim để check lệnh

            // Gặp lệnh kết thúc là dừng ngay (chặn rác ✩...)
            if (command === '[ANSWER_DONE]' || command === '[RELATE_Q_START]') {
                stopStream = true;
                break; 
            }
            
            if (command === '[DONE]' || command === '[ANSWER_START]') continue;
            
            // DeepSeek Reasoning (Deep Thinking)
            if (command === '[REASON_START]') { isReasoning = true; continue; }
            if (command === '[REASON_DONE]') { isReasoning = false; continue; }
            
            // Skip error json lines
            if (command.startsWith('{"error":')) continue;

            // --- Tạo Chunk ---
            let chunk;
            if (isReasoning) {
                // Hỗ trợ hiển thị suy nghĩ (Thinking process)
                chunk = createChunk(requestId, requestModel, dataStr, null, true);
            } else {
                chunk = createChunk(requestId, requestModel, dataStr, null, false);
            }

            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
        }
        
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        console.error("Stream pipe error:", e);
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: corsHeaders({ 'Content-Type': 'text/event-stream' })
    });

  } catch (e) {
    return createErrorResponse(e.message, 500);
  }
}

// --- Helpers ---

async function createSession(title) {
  try {
    const res = await fetch(`${CONFIG.UPSTREAM_API_BASE}/session/create`, {
      method: "POST",
      headers: CONFIG.HEADERS,
      body: JSON.stringify({ title })
    });
    if(!res.ok) return crypto.randomUUID(); // Fallback nếu lỗi
    const data = await res.json();
    return data.id;
  } catch (e) {
    return crypto.randomUUID();
  }
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
    return new Response(JSON.stringify({ object: "list", data: models }), {
        headers: corsHeaders({ 'Content-Type': 'application/json' })
    });
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
