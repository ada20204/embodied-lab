// 作品集语音讲解员的后端（Cloudflare Worker）。
// 网页负责收音、判断说话、打断、播放；这里只替它保管密钥、转发 DeepSeek 的流式回答，并做限流。
// 接口：POST /chat  { messages: [{role:'user'|'assistant', content}], code? }  → text/event-stream（DeepSeek 原样透传）
//       GET  /health → { ok, model }

export const LIMITS = {
  maxMessages: 12,        // 只保留最近几轮，控制成本
  maxCharsPerMsg: 400,    // 语音一句话不会太长
  maxTokens: 220,         // 回答要短：会被念出来
  perMinute: 8,           // 每个 IP 每分钟请求数（单个实例内的尽力而为，不是全局精确限流）
  perDay: 120,            // 每个 IP 每天
};

export const SYSTEM_PROMPT = `你是一个具身智能作品集网页里的讲解员，形象是一台宇树 G1 人形机器人的数字模型。访客在用语音和你说话，你的回答会被合成语音念出来。
规则：
- 用简短的口语回答，一般一到三句话，不超过 80 个字；不要用列表、标题、表情、链接或 Markdown。
- 只介绍这个作品集里有的内容。不知道、页面上没写的，就直说不知道，不要编造数字、公司、经历或结论。
- 作品集的章节：双臂与 ACT 模仿学习（把 ACT 策略量化后部署到地瓜 S100 板子，并测精度和速度）；G1 人形机器人的语音交互管线（一句话如何变成一个白名单动作，头部指示灯红色表示在听、蓝色表示在回复）；Microduck 开源双足小鸭子（强化学习策略，从仿真导出 ONNX 到端侧）；端侧平台矩阵（哪些做成了、哪些没过）；副线是用机械臂做影视运镜预演。页面里还有动作库，可以播放开源动捕数据和小鸭子的仿真轨迹。
- 访客想看某部分时，告诉他往下滚到对应章节，或者点右上角的按钮（动作库、指示灯、灯光）。
- 与作品集无关的请求（写代码、长文、敏感话题）礼貌地一句话带过，把话题拉回作品集。`;

const hits = new Map(); // ip -> { m: [时间戳...], d: 日期, n: 当天次数 }

export function allow(ip, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  let h = hits.get(ip);
  if (!h || h.d !== day) { h = { m: [], d: day, n: 0 }; hits.set(ip, h); }
  h.m = h.m.filter(t => now - t < 60_000);
  if (h.m.length >= LIMITS.perMinute) return { ok: false, why: '说得太快了，请稍等一下再试。' };
  if (h.n >= LIMITS.perDay) return { ok: false, why: '今天的对话次数用完了，明天再来吧。' };
  h.m.push(now); h.n++;
  if (hits.size > 5000) hits.clear();   // 防止单个实例内存涨太多
  return { ok: true };
}
export function _resetLimits() { hits.clear(); }

/** 校验并裁剪网页发来的对话；不合法返回错误文字 */
export function cleanMessages(input) {
  if (!Array.isArray(input) || !input.length) return { error: 'messages 不能为空' };
  const out = [];
  for (const m of input.slice(-LIMITS.maxMessages)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return { error: 'messages 格式不对' };
    const c = m.content.trim().slice(0, LIMITS.maxCharsPerMsg);
    if (c) out.push({ role: m.role, content: c });
  }
  if (!out.length || out[out.length - 1].role !== 'user') return { error: '最后一条必须是访客说的话' };
  return { messages: out };
}

function cors(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    ok,
    headers: ok ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' } : { Vary: 'Origin' },
  };
}
const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

export default {
  async fetch(request, env, _ctx, fetchImpl = fetch) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const c = cors(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: c.ok ? 204 : 403, headers: c.headers });
    if (url.pathname === '/health') return json({ ok: true, model: env.MODEL || 'deepseek-chat', key: !!env.DEEPSEEK_API_KEY }, 200, c.headers);
    if (url.pathname !== '/chat' || request.method !== 'POST') return json({ error: 'not found' }, 404, c.headers);
    if (!c.ok) return json({ error: '这个网页没有被允许调用' }, 403, c.headers);
    if (!env.DEEPSEEK_API_KEY) return json({ error: '服务端还没配置密钥' }, 503, c.headers);

    let body;
    try { body = await request.json(); } catch { return json({ error: '请求不是 JSON' }, 400, c.headers); }
    if (env.ACCESS_CODE && body.code !== env.ACCESS_CODE) return json({ error: '需要访问码' }, 401, c.headers);
    const cm = cleanMessages(body.messages);
    if (cm.error) return json({ error: cm.error }, 400, c.headers);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const lim = allow(ip);
    if (!lim.ok) return json({ error: lim.why }, 429, c.headers);

    const up = await fetchImpl('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.MODEL || 'deepseek-chat', stream: true, max_tokens: LIMITS.maxTokens, temperature: 0.6, messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...cm.messages] }),
    });
    if (!up.ok || !up.body) return json({ error: `模型服务出错（${up.status}）` }, 502, c.headers);
    return new Response(up.body, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', ...c.headers } });
  },
};
