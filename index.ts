/**
 * =================================================================================
 * Project: Heck-2API (Bun Edition)
 * Version: 1.8.0 (Enhance Prompt Fix)
 * Fixes:
 * - [x] Disable Reasoning for non-R1 models (Fixes Client Parse Error)
 * - [x] Log raw content of first chunks to debug "Enhance" issues
 * - [x] Remove leading newlines (Fixes Prompt format)
 * =================================================================================
 */

const CONFIG = {
  PORT: process.env.PORT || 3000,
  API_MASTER_KEY: process.env.API_MASTER_KEY || "1",
  UPSTREAM_API_BASE: process.env.UPSTREAM_API_BASE || "https://api.heckai.weight-wave.com/api/ha/v1",
  AI_LANGUAGE: process.env.AI_LANGUAGE || "Vietnamese",
  
  // Headers
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

// --- Logger ---
function log(id: string, type: string, msg: string) {
    const time = new Date().toLocaleTimeString();
    let color = "\x1b[37m"; 
    if (type === 'INFO') color = "\x1b[36m";
    if (type === 'UPSTREAM') color = "\x1b[33m"; 
    if (type === 'STREAM') color = "\x1b[32m"; 
    if (type === 'ERROR') color = "\x1b[31m";
    if (type === 'DATA') color = "\x1b[90m"; // Grey for raw data

    console.log(`\x1b[90m[${time}]\x1b[0m \x1b[35m[${id}]\x1b[0m ${color}[${type}]\x1b[0m ${msg}`);
}

console.log(`🚀 Heck-2API (v1.8.0) running on port ${CONFIG.PORT}`);

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

function extractContent(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => (typeof part === 'string' ? part : (part?.text || ""))).join("\n");
    }
    return ""; 
}

async function handleChatCompletions(req) {
  const reqId = `req-${Math.floor(Math.random() * 10000)}`;
  
  if (!verifyAuth(req)) {
      log(reqId, 'ERROR', 'Auth Failed');
      return createErrorResponse("Unauthorized", 401);
  }

  try {
    const body = await req.json();
    let requestModel = body.model || CONFIG.DEFAULT_MODEL;
    let upstreamModel = CONFIG.MODEL_MAP[requestModel] || requestModel;
    
    // [FIX 1] Chỉ cho phép Reasoning nếu model là dòng R1 hoặc Thinking
    const allowReasoning = requestModel.includes('r1') || requestModel.includes('think') || requestModel.includes('o1');

    log(reqId, 'INFO', `Request: ${requestModel} (Reasoning Allowed: ${allowReasoning})`);

    let fullPrompt = "";
    let lastUserMsg = "";

    for (const msg of body.messages) {
       const cleanContent = extractContent(msg.content);
       if (msg.role === 'system') fullPrompt += `[System]: ${cleanContent}\n`;
       else if (msg.role === 'user') {
           fullPrompt += `[User]: ${cleanContent}\n`;
           lastUserMsg = cleanContent;
       }
       else if (msg.role === 'assistant') fullPrompt += `[Assistant]: ${cleanContent}\n`;
    }

    const safeTitle = (lastUserMsg && typeof lastUserMsg === 'string') ? lastUserMsg : "New Chat";
    const sessionTitle = (safeTitle.substring(0, 15) || "Chat").replace(/\n/g, " ");
    
    const sessionId = await createSession(sessionTitle, reqId);
    
    // [DEBUG] Log prompt ngắn gọn để biết user đang gửi gì
    const shortPrompt = fullPrompt.length > 50 ? fullPrompt.substring(0, 50) + "..." : fullPrompt;
    log(reqId, 'INFO', `Prompt Start: "${shortPrompt.replace(/\n/g, ' ')}"`);

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

    if (!response.ok) {
        const errText = await response.text();
        log(reqId, 'ERROR', `Upstream Error ${response.status}: ${errText}`);
        return createErrorResponse(`Upstream Error: ${response.status}`, response.status);
    }

    log(reqId, 'UPSTREAM', `Response OK. Stream Started.`);

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
        let chunkCount = 0;

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
            
            // [FIX 2] DeepSeek Logic
            if (command === '[REASON_START]') { 
                if (allowReasoning) isReasoning = true; 
                // Nếu không cho phép reasoning (như Enhance Prompt), ta bỏ qua tag này 
                // và coi nội dung bên trong là text thường hoặc bỏ qua (tùy Heck).
                // Heck thường tách biệt, nên ta cứ để flag chạy, nhưng xử lý ở dưới.
                continue; 
            }
            if (command === '[REASON_DONE]') { isReasoning = false; continue; }
            if (command.startsWith('{"error":')) continue;

            // [FIX 3] Xử lý xuống dòng & Empty content
            if (content.length === 0) content = "\n";
            
            // [FIX 4] Log 5 chunk đầu tiên để Debug
            if (chunkCount < 5) {
                log(reqId, 'DATA', `Chunk ${chunkCount}: ${JSON.stringify(content)}`);
            }

            // [FIX 5] Nếu model không hỗ trợ Reasoning, ép toàn bộ nội dung thành 'content'
            // Điều này giúp Client không bị lỗi khi nhận 'reasoning_content' ở model thường
            let finalIsReasoning = isReasoning && allowReasoning;

            // Tạo chunk
            const chunk = createChunk(reqId, requestModel, content, null, finalIsReasoning);
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            chunkCount++;
          }
        }
        
        await writer.write(encoder.encode('data: [DONE]\n\n'));
        log(reqId, 'INFO', `Done. Total Chunks: ${chunkCount}`);
      } catch (e) {
        if (e && e.name !== 'AbortError') log(reqId, 'ERROR', `Stream: ${e.message}`);
      } finally {
        try { await writer.close(); } catch (e) {}
      }
    })();

    return new Response(readable, { headers: corsHeaders({ 'Content-Type': 'text/event-stream' }) });
  } catch (e) {
    log(reqId, 'ERROR', `Crash: ${e.message}`);
    return createErrorResponse(e.message, 500);
  }
}

// --- Helpers ---

async function createSession(title, reqId) {
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
    return new Response(JSON.stringify({ 
        object: "list", 
        data: Object.keys(CONFIG.MODEL_MAP).map(id => ({
            id, object: "model", created: Date.now(), owned_by: "heck-ai"
        })) 
    }), { headers: corsHeaders() });
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
