/**
 * =================================================================================
 * Project: heck-2api (Bun Edition)
 * Version: 1.0.0 (Ghost Session)
 * Runtime: Bun v1.x
 * =================================================================================
 */

// --- [1. Configuration] ---
const CONFIG = {
  PORT: process.env.PORT || 3000,
  API_MASTER_KEY: process.env.API_MASTER_KEY || "1", // Set in .env
  
  // Upstream Configuration
  UPSTREAM_API_BASE: process.env.UPSTREAM_API_BASE || "https://api.heckai.weight-wave.com/api/ha/v1",
  
  // Headers (Impersonation)
  HEADERS: {
    "Host": "api.heckai.weight-wave.com",
    "Origin": "https://heck.ai",
    "Referer": "https://heck.ai/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "priority": "u=1, i"
  },

  // Model Mapping
  MODEL_MAP: {
    "gpt-4o-mini": "openai/gpt-4o-mini",
    "gpt-4o": "openai/chatgpt-4o-latest",
    "gpt-5-mini": "openai/gpt-5-mini",
    "deepseek-r1": "deepseek/deepseek-r1",
    "deepseek-v3": "deepseek/deepseek-chat",
    "claude-3.7-sonnet": "anthropic/claude-3.7-sonnet",
    "grok-3-mini": "x-ai/grok-3-mini-beta"
  },
  
  DEFAULT_MODEL: "openai/gpt-4o-mini"
};

// --- [2. Bun Server Entry] ---
console.log(`🚀 Service running on port ${CONFIG.PORT}`);
console.log(`🔑 Master Key: ${CONFIG.API_MASTER_KEY.slice(0, 4)}***`);

Bun.serve({
  port: CONFIG.PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS Preflight
    if (req.method === 'OPTIONS') return handleCorsPreflight();

    // Health Check
    if (url.pathname === '/') {
      return new Response(JSON.stringify({ status: "alive", service: "heck-2api-bun" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // API Routes
    if (url.pathname.startsWith('/v1/')) {
      return await handleApi(req);
    }

    return createErrorResponse(`Path not found: ${url.pathname}`, 404, 'not_found');
  }
});

// --- [3. API Logic] ---

async function handleApi(req) {
  // Auth Check
  const authHeader = req.headers.get('Authorization');
  if (CONFIG.API_MASTER_KEY !== "1") {
    if (!authHeader || authHeader !== `Bearer ${CONFIG.API_MASTER_KEY}`) {
      return createErrorResponse('Unauthorized', 401, 'unauthorized');
    }
  }

  const url = new URL(req.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(req, requestId);
  } else {
    return createErrorResponse(`Unsupported path: ${url.pathname}`, 404, 'not_found');
  }
}

function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: Object.keys(CONFIG.MODEL_MAP).map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'heck-2api',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}

async function createSession(title = "New Chat") {
  try {
    const response = await fetch(`${CONFIG.UPSTREAM_API_BASE}/session/create`, {
      method: "POST",
      headers: CONFIG.HEADERS,
      body: JSON.stringify({ title })
    });

    if (!response.ok) throw new Error(`Session creation failed: ${response.status}`);
    const data = await response.json();
    return data.id;
  } catch (e) {
    console.error("Session Error:", e);
    throw e;
  }
}

async function handleChatCompletions(req, requestId) {
  try {
    const body = await req.json();
    
    // 1. Model Resolution
    let requestModel = body.model || "gpt-4o-mini";
    let upstreamModel = CONFIG.MODEL_MAP[requestModel] || requestModel;
    if (!Object.values(CONFIG.MODEL_MAP).includes(upstreamModel) && !CONFIG.MODEL_MAP[requestModel]) {
        upstreamModel = CONFIG.DEFAULT_MODEL;
    }

    // 2. Prompt Construction
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

    // 3. Create Anonymous Session
    const sessionTitle = (lastUserMsg.substring(0, 10) || "Chat").replace(/\n/g, "");
    const sessionId = await createSession(sessionTitle);

    // 4. Upstream Request
    const upstreamPayload = {
      model: upstreamModel,
      question: fullPrompt.trim(),
      language: "Chinese",
      sessionId: sessionId,
      previousQuestion: null,
      previousAnswer: null,
      imgUrls: [],
      superSmartMode: false
    };

    const response = await fetch(`${CONFIG.UPSTREAM_API_BASE}/chat`, {
      method: "POST",
      headers: CONFIG.HEADERS,
      body: JSON.stringify(upstreamPayload)
    });

    if (!response.ok) {
      return createErrorResponse(`Upstream error: ${response.status}`, response.status, 'upstream_error');
    }

    // 5. Stream Transformation
    // Bun supports native Web Streams
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    (async () => {
      try {
        const reader = response.body.getReader();
        let buffer = "";
        let isReasoning = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const dataStr = line.slice(6).trim();

              // --- Protocol Parsing ---
              if (['[ANSWER_DONE]', '[RELATE_Q_START]', '[RELATE_Q_DONE]'].includes(dataStr)) continue;
              
              if (dataStr === '[REASON_START]') { isReasoning = true; continue; }
              if (dataStr === '[REASON_DONE]') { isReasoning = false; continue; }
              if (dataStr === '[ANSWER_START]') continue;
              
              if (dataStr === '[ERROR]') continue;
              if (dataStr.startsWith('{"error":')) {
                  const errChunk = createChunk(requestId, requestModel, `\n[Error: ${dataStr}]`, "stop");
                  await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
                  continue;
              }

              // Content Handling
              let chunk = null;
              if (isReasoning) {
                  chunk = {
                      id: requestId,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: requestModel,
                      choices: [{ index: 0, delta: { reasoning_content: dataStr }, finish_reason: null }]
                  };
              } else {
                  chunk = createChunk(requestId, requestModel, dataStr);
              }
              await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
          }
        }
        
        await writer.write(encoder.encode('data: [DONE]\n\n'));
      } catch (e) {
        console.error("Stream Error", e);
        const errChunk = createChunk(requestId, requestModel, `\n[Stream Error]`, "stop");
        await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: corsHeaders({ 
        'Content-Type': 'text/event-stream',
        'X-Heck-Session-Id': sessionId
      })
    });

  } catch (e) {
    return createErrorResponse(e.message, 500, 'internal_error');
  }
}

// --- [4. Helpers] ---

function createChunk(id, model, content, finishReason = null) {
  return {
    id: id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }]
  };
}

function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json' })
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
