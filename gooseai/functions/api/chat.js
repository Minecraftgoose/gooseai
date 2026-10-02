// 反代到后端 Worker（gooseai-api）。密钥只在 Worker 内，浏览器只连 pages.dev。
// 直接调 Worker URL（服务端请求 workers.dev，不受境内 workers.dev 被墙影响）。
const WORKER_URL = 'https://gooseai-api.18540120423.workers.dev';

export async function onRequest({ request }) {
  const u = new URL(request.url);
  const target = WORKER_URL + u.pathname + u.search;
  const headers = {};
  for (const [k, v] of request.headers.entries()) {
    if (k.toLowerCase() === 'host') continue;
    headers[k] = v;
  }
  headers['x-real-ip'] = request.headers.get('CF-Connecting-IP') || '';
  headers['x-gate-secret'] = 'fba02f873bb4722ef3c2eb0067d1f7cb7f04144b5ad7930333d5590979e62512';
  const resp = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'follow',
  });
  return resp;
}
