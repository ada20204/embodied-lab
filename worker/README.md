# 语音讲解员后端（Cloudflare Worker）

作品集网页的语音对话要调用 DeepSeek，密钥不能写在公开网页里，所以放在这个 Worker 里。它只做三件事：保管密钥、转发流式回答、限流。收音、打断、播放都在网页里。

- `POST /chat`：`{ "messages": [{ "role": "user", "content": "你是谁" }], "code": "可选访问码" }`，返回 DeepSeek 原样的流（text/event-stream）。
- `GET /health`：检查是否在线、有没有配密钥。
- 只接受 `wrangler.toml` 里 `ALLOWED_ORIGINS` 列出的网页；每个 IP 每分钟 8 次、每天 120 次（单实例内尽力而为，不是精确的全局限流）；回答最多 220 个 token；系统提示词在服务端，访客改不了。

## 开通（约 10 分钟，只需做一次）

1. **注册 Cloudflare**：https://dash.cloudflare.com/sign-up ，免费套餐即可。
2. **记下账号 ID**：登录后进入 Workers 和 Pages 页面，右侧栏有 Account ID。
3. **建 API 令牌**：右上角头像 → My Profile → API Tokens → Create Token → 选模板 “Edit Cloudflare Workers” → 创建，复制令牌（只显示一次）。
4. **DeepSeek 密钥**：https://platform.deepseek.com 创建 API key。DeepSeek 是预充值，**只充少量金额**就是天然的花费上限。
5. **填到 GitHub**：仓库 Settings → Secrets and variables → Actions → New repository secret，添加：
   - `CLOUDFLARE_API_TOKEN`（第 3 步）
   - `CLOUDFLARE_ACCOUNT_ID`（第 2 步）
   - `DEEPSEEK_API_KEY`（第 4 步）
   - `WORKER_ACCESS_CODE`（可选；设了之后网页要带访问码才能对话，适合只给面试官用）
6. **部署**：仓库 Actions → “部署语音讲解员后端” → Run workflow。成功后日志里会给出地址，形如 `https://embodied-lab-guide.<你的子域>.workers.dev`。把这个地址告诉我，网页就接上去。

## 本地调试

```bash
cd worker
npx wrangler dev          # 需要先 `npx wrangler secret put DEEPSEEK_API_KEY` 或建 .dev.vars 写 DEEPSEEK_API_KEY=...
curl -N -X POST http://localhost:8787/chat -H 'Origin: http://localhost:8765' -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"你是谁"}]}'
```

`.dev.vars` 已在 `.gitignore` 里，不要把密钥提交进仓库。
