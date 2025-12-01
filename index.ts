/**
 * =================================================================================
 * Project: Heck-2API (Bun Edition)
 * Refactored based on: layout-f4c08c4df7990e01.js
 * Features:
 * - Bun Native Server
 * - Auto .env loading
 * - Exact Payload Matching
 * - Chat Suggestion Removal ([RELATE_Q])
 * - OpenAI Format Conversion with Deep Thinking support
 * =================================================================================
 */

// [1] Configuration
const CONFIG = {
  PORT: process.env.PORT || 3000,
  API_MASTER_KEY: process.env.API_MASTER_KEY || "1",
  UPSTREAM_API_BASE: process.env.UPSTREAM_API_BASE || "https://api.heckai.weight-wave.com/api/ha/v1",
  AI_LANGUAGE: process.env.AI_LANGUAGE || "Vietnamese", // Default from file is "English", tuned for user

  // Headers impersonating the specific client found in layout.js
  HEADERS: {
    "Host": "api.heckai.weight-wave.com",
    "Origin": "https://heck.ai",
    "Referer": "https://heck.ai/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    "Accept": "*/*"
  },

  // Model Mapping (Based on snippet 7 in layout.js)
  MODEL_MAP: {
    "gpt-4o-mini": "openai/gpt-4o-mini",
    "gpt-4o": "openai/chatgpt-4o-latest",
    "gpt-5-mini": "openai/gpt-5-mini",
    "deepseek-r1": "deepseek/deepseek-r1",
    "deepseek-v3": "deepseek/deepseek-chat",
    "claude-3.7-sonnet": "anthropic/claude-3.7-sonnet",
    "grok-3": "x-ai/grok-3-beta", // Updated from snippets
    "gemini-2.0-flash": "google/gemini-2.0-flash-001"
  },
  
  DEFAULT_MODEL: "openai/gpt-4o-mini"
};

// [2] Bun Server
console.log(`🚀 Heck-2API running on port ${CONFIG.PORT}`);
console.log(`🌍 Target: ${CONFIG.UPSTREAM_API_BASE}`);

Bun.serve({
  port: CONFIG.PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS Handling
    if (req.method === 'OPTIONS') return handleCorsPreflight();

    // API Routes
    if (url.pathname === '/v1/chat/completions') return handleChatCompletions(req);
    if (url.pathname === '/v1/models') return handleModels(req);

    // Health Check
    if (url.pathname === '/') return new Response(JSON.stringify({ status: "ok", mode: "api-only" }), { headers: { "Content-Type": "application/json" } });

    return new Response("Not Found", { status: 404 });
  }
});

// [3] Core Logic

async function handleChatCompletions(req) {
  if (!verifyAuth(req)) return createErrorResponse("Unauthorized", 401);

  const requestId = `chatcmpl-${crypto.randomUUID()}`;
  
  try {
    const body = await req.json();
    
    // -- 3.1 Model & Prompt Prep --
    let requestModel = body.model || CONFIG.DEFAULT_MODEL;
    let upstreamModel = CONFIG.MODEL_MAP[requestModel] || requestModel;
    
    // Construct Prompt (Heck API takes a single 'question' string)
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

    // -- 3.2 Ghost Session Creation --
    // Based on snippet 7: P.A.post("/ha/v1/session/create",{title:e})
    const sessionTitle = (lastUserMsg.substring(0, 15) || "New Chat").replace(/\n/g, " ");
    const sessionId = await createSession(sessionTitle);

    // -- 3.3 Construct Payload (Exact match with layout.js logic) --
    // Snippet 3: JSON.stringify({model:a,question:s,language:r,sessionId:i,previousQuestion:l,previousAnswer:o})
    const upstreamPayload = {
      model: upstreamModel,
      question: fullPrompt.trim(),
      language: CONFIG.AI_LANGUAGE,
      sessionId: sessionId,
      previousQuestion: null, // Always null for new ghost session
      previousAnswer: null
    };

    // -- 3.4 Request to Upstream --
    // Based on snippet 3: V function
    const response = await fetch(`${CONFIG.UPSTREAM_API_BASE}/chat`, {
      method: "POST",
      headers: CONFIG.HEADERS,
      body: JSON.stringify(upstreamPayload)
    });

    if (!response.ok) {
      return createErrorResponse(`Upstream Error: ${response.status}`, response.status);
    }

    // -- 3.5 Stream Transformation --
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    (async () => {
      try {
        const reader = response.body.getReader();
        let buffer = "";
        let isReasoning = false;
        let isSuggesting = false; // Flag to filter related questions

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          // Split by newlines as per SSE standard/Raw text logic
          const lines = buffer.split('\n');
          buffer = lines.pop() || "";

          for (const line of lines) {
            // Check for standard SSE "data: " prefix or raw lines
            // layout.js handles raw text, but API usually sends "data: "
            const cleanLine = line.startsWith('data: ') ? line.slice(6) : line;
            const dataStr = cleanLine.trim();

            if (!dataStr) continue;
            if (dataStr === '[DONE]') continue;

            // --- FILTERING LOGIC (Remove Chat Suggestions) ---
            if (dataStr === '[RELATE_Q_START]') { isSuggesting = true; continue; }
            if (dataStr === '[RELATE_Q_DONE]') { isSuggesting = false; continue; }
            if (isSuggesting) continue; // Skip all content inside suggestion block

            // --- REASONING LOGIC (DeepSeek R1) ---
            if (dataStr === '[REASON_START]') { isReasoning = true; continue; }
            if (dataStr === '[REASON_DONE]') { isReasoning = false; continue; }
            
            // --- ANSWER LOGIC ---
            if (dataStr === '[ANSWER_START]') continue;
            if (dataStr === '[ANSWER_DONE]') continue;
            
            // Error handling
            if (dataStr.startsWith('{"error":')) continue;

            // Create Chunk
            let chunk;
            if (isReasoning) {
                // OpenAI Reasoning Format
                chunk = createChunk(requestId, requestModel, dataStr, null, true);
            } else {
                // Standard Content
                chunk = createChunk(requestId, requestModel, dataStr, null, false);
            }

            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
        }
        
        // Finalize
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        console.error("Stream pipe error:", e);
        const errChunk = createChunk(requestId, requestModel, `\n[Error: ${e.message}]`, "stop");
        await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: corsHeaders({ 'Content-Type': 'text/event-stream' })
    });

  } catch (e) {
    console.error(e);
    return createErrorResponse("Internal Server Error", 500);
  }
}

// [4] Helpers

async function createSession(title) {
  try {
    const res = await fetch(`${CONFIG.UPSTREAM_API_BASE}/session/create`, {
      method: "POST",
      headers: CONFIG.HEADERS,
      body: JSON.stringify({ title })
    });
    if(!res.ok) throw new Error("Session creation failed");
    const data = await res.json();
    return data.id;
  } catch (e) {
    // Fallback: use a random ID if API fails (though upstream might reject it)
    console.warn("Failed to create session, using random UUID");
    return crypto.randomUUID();
  }
}

function createChunk(id, model, content, finishReason = null, isReasoning = false) {
  const delta = isReasoning ? { reasoning_content: content } : { content: content };
  return {
    id: id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, delta: delta, finish_reason: finishReason }]
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
  if (CONFIG.API_MASTER_KEY === "1") return true; // Debug mode
  return auth === `Bearer ${CONFIG.API_MASTER_KEY}`;
}

function createErrorResponse(msg, code) {
  return new Response(JSON.stringify({ error: { message: msg } }), {
    status: code, headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}
