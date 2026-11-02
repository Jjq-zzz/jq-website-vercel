# 课研 API 契约（前后端共用，v1）

所有接口前缀 `/api`。除 `POST /auth/login`、`GET /health` 外，均要求请求头：

```
Authorization: Bearer <随机会话凭证>
```

未登录 / 无效用户：`401 { "error": { "code": "UNAUTHORIZED", "message": "请先登录" } }`
无权限访问他人资源：`404`（不暴露资源存在性）。
校验失败：`400`。服务端错误：`500`。
统一错误体：`{ "error": { "code": string, "message": string } }`。

时间字段均为 ISO 8601 UTC 字符串。ID 均为 UUID 字符串。

## 1. 登录

`POST /api/auth/login`
```json
{ "nickname": "小林", "password": "自行设置的密码", "register": true }
```
→ `200`
```json
{ "user": { "id": "uuid", "nickname": "小林", "createdAt": "2026-10-25T08:00:00.000Z" } }
```
昵称 1–20 个字符（前后空格去除）。昵称唯一；密码 8–128 字符。登录校验密码，创建账号需传 register: true，重名返回 409。旧版无密码账号返回 403，由管理员本机设置密码。

`GET /api/auth/me` → `{ "user": { "id": "uuid", "nickname": "小林", "createdAt": "...", "aiKeyConfigured": false } }`。云端的 `aiKeyConfigured` 依据密文是否存在返回布尔值。

## 2. 课程

`GET /api/courses` →
```json
{
  "courses": [
    {
      "id": "uuid", "name": "预防医学", "createdAt": "...", "updatedAt": "...",
      "noteCount": 5, "doneCount": 5, "processingCount": 0, "failedCount": 0
    }
  ]
}
```
按 `updatedAt` 倒序（最近有笔记变化的在前；新建空课程用创建时间）。

`POST /api/courses` `{ "name": "预防医学" }` → `201 { "course": {...同单项...} }`
课程名 1–40 字符；同一用户下禁止重名（返回 `409 DUPLICATE_COURSE`）。

`GET /api/courses/:courseId` →
```json
{
  "course": { "id": "uuid", "name": "预防医学", "createdAt": "...", "updatedAt": "..." },
  "notes": [
    {
      "id": "uuid", "title": "第一章 绪论", "sourceFilename": "第一章 绪论.pptx",
      "summary": "本笔记摘要（已去除 Markdown，最多 100 字）",
      "status": "done", "engine": "ai", "errorMessage": null,
      "createdAt": "...", "updatedAt": "..."
    }
  ]
}
```
`status`: `processing | done | failed`；`engine`: `ai | local-fallback | null`。
笔记按 `createdAt` 正序（上传先后）。

`PATCH /api/courses/:courseId` `{ "name": "新名字" }` → `{ "course": {...} }`（P1 扩展，已提供）
`DELETE /api/courses/:courseId` → `204`。仅允许当前用户删除自己的课程；级联删除全部笔记和队列记录，移除待处理任务并中止正在进行的模型请求。首页课程卡片和课程详情提供带确认提示的删除按钮。

## 3. 上传（异步）

`POST /api/courses/:courseId/files`，`multipart/form-data`，字段名 `files`，可多个。
支持演示文稿、Word、表格、PDF、TXT／Markdown、HTML、RTF、EPUB、LaTeX、OpenDocument 和 ZIP，共 42 种扩展名。完整清单见 `shared/file-formats.js` 和 README 的“格式兼容”表。ZIP 内可混装这些文档，支持多层目录，忽略隐藏文件与 `__MACOSX`，不展开嵌套 ZIP。
单文件最大 100MB，一次最多 60 个文件。

→ `202`
```json
{
  "accepted": 5,
  "notes": [ { "id": "uuid", "noteId": "uuid", "title": "第一章 绪论", "sourceFilename": "第一章 绪论.pptx", "status": "processing" } ],
  "skipped": [ { "name": "notes.wps", "reason": "WPS 专有格式请先另存为 DOCX、PPTX 或 XLSX 后上传" } ],
  "message": "已加入队列，共 5 个文件"
}
```
接口只负责接收文件并写入队列，**立即返回**，不在请求中调用 AI。
前端和后端从同一清单读取格式支持；不受支持的格式返回具体转换提示。已接受但损坏／加密的文件独立标记 `failed`，不阻断其他文件。文本支持 UTF-8、UTF-16 和 GB18030 编码，表格逐工作表读取。
`id` 与 `noteId` 同值，均返回以兼容不同前端调用。

`GET /api/courses/:courseId/queue` →
```json
{
  "active": true,
  "summary": { "total": 6, "done": 3, "processing": 1, "queued": 1, "failed": 1 },
  "items": [
    {
      "noteId": "uuid", "title": "第一章 绪论", "status": "done",
      "queueStatus": null, "engine": "ai", "retryCount": 0, "attempts": 1,
      "errorMessage": null, "createdAt": "...", "updatedAt": "..."
    }
  ]
}
```
轮询间隔建议 1000–1500ms。`active` 为 `false` 时停止轮询。

`POST /api/notes/:noteId/retry` → `202 { "note": {...} }`
仅允许 `failed` 且已有提取文本的笔记重试，复用数据库中的 `raw_text`，不依赖原始文件。损坏或无文本课件返回 `409 FILE_EXPIRED`，提示重新上传。笔记详情、列表和队列项提供 `canRetry` 布尔值，供界面决定是否展示重试按钮。

## 4. 笔记

`GET /api/notes/:noteId` →
```json
{
  "note": {
    "id": "uuid", "title": "第一章 绪论", "sourceFilename": "...",
    "summary": "摘要，最多 100 字",
    "markdownContent": "## 第一节 ...", "status": "done", "engine": "ai",
    "createdAt": "...", "updatedAt": "...", "errorMessage": null
  },
  "course": { "id": "uuid", "name": "预防医学" },
  "siblings": [ { "id": "uuid", "title": "第一章 绪论", "status": "done" } ]
}
```
`raw_text` 永不通过 API 返回。

`DELETE /api/notes/:noteId` → `204`。仅允许当前用户删除自己的笔记，处理、完成和失败状态均可删除；同步清理队列记录和临时文件，中止未完成请求，更新课程最近更新时间。无权限或不存在返回 `404`。列表和阅读页提供带确认提示的删除按钮。

`GET /api/notes/:noteId/download` → `text/markdown; charset=utf-8`，附件文件名 `<标题>.md`。正文第一行为 `# <标题>`，随后空行和 Markdown。

## 5. 课程内搜索

`GET /api/courses/:courseId/search?q=流行病学`
→
```json
{
  "query": "流行病学",
  "total": 2,
  "matchedNotes": 1,
  "results": [
    {
      "noteId": "uuid", "title": "第三章 流行病学", "heading": "一、定义",
      "snippet": "……流行病学是研究人群中疾病与健康状况的分布……",
      "matchCount": 3,
      "occurrence": 0
    }
  ]
}
```
每个笔记最多返回 3 段命中，`snippet` 两侧最多各 60 字。`heading` 为该命中之前最近的 Markdown 标题，可为空。
前端点击结果跳转 `/courses/:courseId/notes/:noteId?q=<query>&hit=<index>`，阅读页高亮所有命中并滚动到第一个（或第 hit 个）。
搜索范围：标题 + `markdown_content`，仅 `done` 笔记。

## 6. 导出

`GET /api/courses/:courseId/export?format=md` → `text/markdown`，合并所有 `done` 笔记：
```
# 课程名

> 共 N 篇笔记 · 由「课研」整理 · 2026-xx-xx

---

# 笔记标题

...
```
`format=zip` → `application/zip`，内部每个笔记一个 `<序号>-<标题>.md`，另含 `README.md`（课程与导出信息）和 `全部笔记.md`（合并版）。文件名安全化，重名自动加序号。

## 7. 健康检查

`GET /api/health` → `{ "ok": true, "ai": { "configured": false, "mode": "local-fallback", "model": null } }`
前端可在上传弹窗底部用一行小字说明当前笔记引擎（AI 已配置 / 本地结构化模式）。

## 8. 队列处理规则（后端约定）

- 并发：默认同时处理 2 个文件（`AI_CONCURRENCY`），强制限制为整数 2～3；每个文件的分块串行调用。
- 重试：AI 失败自动重试 2 次（指数退避 1 秒、2 秒），仍失败 → `status=failed`；解析阶段的损坏文件独立失败。空响应、截断输出及不符合章节／速记格式的输出也会进入同一重试预算。
- 长课件：默认按 4000 字符预分块，并根据输出额度进一步收紧；截断时把失败块拆小，下一次重试复用本任务已成功的块。固定 Prompt 不变，最终只保留一节本章速记，不把截断内容记为完成。
- 错误隔离：单文件异常不影响同批其他文件。
- 隐私：原始课件在提取文本并保存后立即删除，解析失败也删除；AI 重试只依赖已提取文本。ZIP 原件在展开后删除。成功和失败终态均不保留原始文件。


## 密码与会话补充

`POST /api/auth/login` 请求为 `{ "nickname": "小林", "password": "自行设置的密码", "register": false }`；注册使用 `register: true`。响应 `user` 包含 `id`、`nickname`、`createdAt`、`token`，不返回密码哈希。前端保存随机 token，后续所有 JSON、上传和下载请求均发送 Authorization 请求头，原 x-user-id 不再接受。会话有效期 30 天，数据库仅保存 token 的 SHA-256 摘要。密码使用随机盐及 scrypt 派生。

`POST /api/auth/logout` 撤销当前会话并返回 204；`GET /api/auth/me` 校验有效期后返回公开用户信息。缺少凭证、伪造或过期凭证返回 401。错误密码返回 401 INVALID_CREDENTIALS；无密码旧账号返回 403 PASSWORD_SETUP_REQUIRED。每个来源 IP 在 15 分钟内最多尝试 30 次登录／注册，超限返回 429。


## AI Key 设置（Vercel / Cloudflare）

两个接口均需登录，仅访问当前用户的配置；浏览器只向本站提交，不直接调用模型。

`GET /api/settings/ai-key` → `200`
```json
{ "configured": true, "masked": "••••abcd", "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-flash" }
```
未配置或密文无法解密时 `configured:false`、`masked:null`；可选字段返回已存值或 null。接口永不返回完整密钥。

`PUT /api/settings/ai-key`
```json
{ "apiKey": "sk-示例密钥-abcd", "baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-flash" }
```
→ `200`，响应结构同 GET。apiKey 去首尾空白后需为 8–200 字符；空串、null 或省略表示清除密文与 IV。baseUrl、model 省略时保留旧值，null 清空；baseUrl 须以 http:// 或 https:// 开头，model 去空白后至多 64 字符。清除不需要主密钥。

| 状态码 | code | 含义 |
| --- | --- | --- |
| 400 | INVALID_AI_KEY | 密钥类型或长度无效 |
| 400 | INVALID_BASE_URL | 地址不是 http/https |
| 400 | INVALID_MODEL | 模型名类型或长度无效 |
| 401 | UNAUTHORIZED | 未登录或会话失效 |
| 503 | BYOK_SECRET_MISSING | 服务端未配置 BYOK_SECRET，无法保存密钥 |
| 503 | BYOK_SECRET_INVALID | 服务端主密钥不是 64 位十六进制 |
