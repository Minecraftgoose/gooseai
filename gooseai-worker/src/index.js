// gooseai-api Worker
// 持有三个后端 key，前端只调同源 /api/chat 与 /api/glm（经 Pages Functions 反代）。
// 浏览器永远只连 pages.dev，Worker 走 Cloudflare 内网，key 不进前端。

// 轻量 per-IP 限流（防白嫖 / 刷量）。注：Worker 实例间不共享内存，仅作近似保护。
const RATE_WINDOW = 60_000;
const RATE_LIMIT = 30;
const RATE = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let e = RATE.get(ip);
  if (!e || now > e.reset) {
    e = { count: 0, reset: now + RATE_WINDOW };
    RATE.set(ip, e);
  }
  e.count++;
  if (e.count > RATE_LIMIT) return true;
  if (RATE.size > 5000) {
    for (const [k, v] of RATE) if (now > v.reset) RATE.delete(k);
  }
  return false;
}

export default {
  async fetch(request, env) {
    // 闸门：仅经 Pages Functions（带 x-gate-secret）的请求放行；裸调 Worker 直接 403。
    // 堵死「直接打 Worker 原始地址」这条绕过 Pages/CORS 的路径。
    const gate = env.WORKER_GATE_SECRET;
    if (gate && request.headers.get('x-gate-secret') !== gate) {
      return new Response('Forbidden', { status: 403 });
    }
    const url = new URL(request.url);
    const p = url.pathname;
    // 真实用户 IP：优先取 Pages Functions 透传的 x-real-ip，否则取 edge 直连 IP
    const ip = request.headers.get('x-real-ip') || request.headers.get('CF-Connecting-IP') || '0.0.0.0';

    // 限流：仅对消耗模型额度的写端点（chat / glm / video 提交）；视频轮询 status 放行
    if (request.method === 'POST' && (p === '/api/chat' || p === '/api/glm' || p === '/api/video')) {
      if (rateLimited(ip)) {
        return json({ error: '请求过于频繁，请稍后再试（每分钟上限 ' + RATE_LIMIT + ' 次）' }, 429);
      }
    }

    if (request.method === 'POST' && p === '/api/chat') {
      return handleChat(request, env);
    }
    if (request.method === 'POST' && p === '/api/glm') {
      return handleGlm(request, env);
    }
    if (request.method === 'POST' && p === '/api/video') {
      return handleAgnesVideo(request, env);
    }
    if (request.method === 'GET' && p === '/api/video/status') {
      return handleAgnesVideoStatus(request, env);
    }
    return new Response('Not Found', { status: 404 });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// 流式聊天代理：普通模式(provider=chat) 与 码牛(provider=beast)
async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const provider = body.provider === 'beast' ? 'beast' : 'chat';
  const upstreamUrl = provider === 'beast' ? env.BEAST_URL : env.CHAT_URL;
  const upstreamKey = provider === 'beast' ? env.BEAST_KEY : env.CHAT_KEY;

  const { model, messages } = body;
  if (!upstreamUrl || !upstreamKey || !model || !Array.isArray(messages)) {
    return json({ error: 'missing params' }, 400);
  }

  const upstreamResp = await fetch(upstreamUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + upstreamKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: typeof body.temperature === 'number' ? body.temperature : 0.7,
    }),
  });

  if (!upstreamResp.ok) {
    const txt = await upstreamResp.text().catch(() => '');
    return new Response('upstream ' + upstreamResp.status + ': ' + txt, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // 透传上游 SSE 流
  return new Response(upstreamResp.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

// 智谱（bigmodel）代理：生图模式的意图判断 + toolcalls 精细化，非流式 JSON
async function handleGlm(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  if (!env.GLM_URL || !env.GLM_KEY) {
    return json({ error: 'glm not configured' }, 500);
  }

  const upstreamBody = {
    model: body.model || 'glm-4-flash',
    messages: body.messages,
    tools: body.tools,
    tool_choice: body.tool_choice,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
  };
  for (const k of Object.keys(upstreamBody)) {
    if (upstreamBody[k] === undefined) delete upstreamBody[k];
  }

  const upstreamResp = await fetch(env.GLM_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.GLM_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(upstreamBody),
  });

  const txt = await upstreamResp.text().catch(() => '');
  return new Response(txt, {
    status: upstreamResp.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// Agnes 视频生成代理：提交任务（异步），原样转发 body 到 /v1/videos，返回含 video_id 的 JSON
async function handleAgnesVideo(request, env) {
  if (!env.AGNES_URL || !env.AGNES_KEY) {
    return json({ error: 'video not configured' }, 500);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const upstreamResp = await fetch(env.AGNES_URL + '/v1/videos', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.AGNES_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const txt = await upstreamResp.text().catch(() => '');
  return new Response(txt, {
    status: upstreamResp.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// Agnes 视频轮询：根据 video_id 查询状态/结果（/agnesapi?video_id=）
async function handleAgnesVideoStatus(request, env) {
  if (!env.AGNES_URL || !env.AGNES_KEY) {
    return json({ error: 'video not configured' }, 500);
  }
  const videoId = new URL(request.url).searchParams.get('video_id');
  if (!videoId) return json({ error: 'missing video_id' }, 400);
  const upstreamResp = await fetch(env.AGNES_URL + '/agnesapi?video_id=' + encodeURIComponent(videoId), {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + env.AGNES_KEY },
  });
  const txt = await upstreamResp.text().catch(() => '');
  return new Response(txt, {
    status: upstreamResp.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
