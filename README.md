# 课研 · 课件批量转笔记

**部署到 Vercel：** 已提供 Node.js Functions、Turso、私有 Blob 和持久化队列适配，无需 Docker。请按 [Vercel 部署步骤](docs/vercel-deployment.md) 连接数据库和文件存储后发布。

整门课的课件，一键变成结构化复习笔记库。

使用 React、Ant Design、Express、SQLite 和官方 OpenAI SDK。批量导入演示文稿、Word、表格、PDF、文本、电子书或 ZIP 后，后台独立生成并归档每份资料的 Markdown 笔记。

> **Java 版本已同步落地**：同一套 React 前端 + `/api` 契约，后端使用 **Java 21 / Spring Boot 3 / Spring Data JPA / PostgreSQL / Flyway / Apache POI / PDFBox / OkHttp / Resilience4j**，默认运行在 **8080**。详见 [server-java/README.md](server-java/README.md)。Node 原版仍在 3000 端口运行，两套后端互不影响。

![笔记阅读与搜索高亮](docs/screenshots/08-reader-highlight.png)

## Java 版本启动（本次技术栈选型）

要求：JDK 21、Maven 3.9+。

```powershell
cd "D:\1\Documents\重点提取"
npm run build          # 构建 React；Maven 会把 dist/client 打进 jar
cd server-java
mvn test
mvn package
java -jar target/course-notes-java-1.0.0.jar
```

打开 **http://localhost:8080**。

- 本地零配置使用 H2 文件库（`server-java/data-java`，PostgreSQL 兼容模式）。
- 生产 PostgreSQL：项目内提供 `server-java/compose.yaml`，设置 `SPRING_PROFILES_ACTIVE=postgres` 与 `DB_URL/DB_USER/DB_PASSWORD` 即可，Flyway 自动迁移。
- AI 配置复用仓库根目录 `.env` 或系统环境变量；未配置时仍使用本地结构化引擎。
- 支持 PPTX/PDF/ZIP，以及 Word、Excel、旧版 PPT、TXT/Markdown、HTML、RTF、EPUB、ODF 等格式（`.xlsb` 除外）。
- Java 的 API、JPA 实体、队列、解析、AI 重试和验收细节见 [server-java/README.md](server-java/README.md)。

## Node 版本启动（原有，端口 3000）

需要 Node.js 22.13 或更新版本，推荐 Node.js 24。

```powershell
npm install
Copy-Item .env.example .env
```

在 `.env` 中填写 OpenAI 兼容接口配置：

```dotenv
AI_BASE_URL=https://api.deepseek.com/v1
AI_API_KEY=填写你自己的密钥
AI_MODEL=deepseek-chat
```

```powershell
npm run build
npm start
```

打开 [本地应用](http://localhost:3000)，使用昵称和密码创建账号或登录，新建课程，然后批量上传课件。密钥仅在服务端读取，`.env` 已排除版本管理。

已在 Windows 环境变量中设置 `DEEPSEEK_API_KEY` 时，无需把密钥填入 `.env`，程序会直接读取。`.env` 只需保留 `AI_BASE_URL` 和 `AI_MODEL` 等配置。也兼容 `AI_API_KEY` 和 `OPENAI_API_KEY`；新增系统环境变量后，需在能读取该变量的新终端中启动服务。

开发时使用 `npm run dev`，前端默认位于 `http://localhost:5173`，代理到后端 3000 端口。

构建脚本使用项目内的 `.tmp-build` 作为临时目录，避免 Windows 系统 Temp 目录权限导致 esbuild 报“Access is denied”。首次构建成功后再启动服务；若服务已在构建前启动，请按 `Ctrl+C` 停止，再运行 `npm start`。

未配置密钥或模型名时，仅启用界面明确标识的“本地模式”，便于体验流程。这是规则整理，不能作为真实 AI 生成质量的验收依据；填写配置并重启服务后才会调用模型。

## 已实现功能

- 昵称／学号与密码登录，密码加盐哈希保存，随机会话凭证保持 30 天，退出时服务端撤销。
- 新建课程，课程卡片展示笔记数和最近更新时间。
- 拖拽多文件上传常见办公文档、文本、电子书和 ZIP，选择后立即显示待上传队列，上传时显示进度。
- ZIP 自动展开其中所有支持的文档，允许混装 Word、表格、演示文稿、文本和电子书。
- 上传接口写入持久队列后返回 202，不等待 AI；底部浮条实时显示处理进度。
- PPTX 只提取文字，按实际演示页序输出 `[Page N]`；PDF 逐页读取文本层，纯图片页跳过。
- 严格使用需求提供的六条固定 Prompt；双花括号原文保持不变。
- AI 默认并发 2，只允许配置 2 或 3；失败自动重试两次，指数退避为 1 秒、2 秒。
- 长课件预先分块，输出截断时在同一重试预算内缩小失败块；本次任务内已成功的块直接复用，不再重复调用。
- 检查模型输出的章节标题和结尾 5～8 条速记；空响应、截断输出、原文回显等不会被直接标为成功。
- 单文件失败独立标记，其他任务继续；日志记录 AI 请求、错误及自动重试。
- 笔记列表展示标题、前 100 字摘要和处理时间；阅读页提供左侧课程笔记目录及 Markdown 渲染。
- 课程内标题及正文搜索，阅读页关键词高亮并定位。
- 单篇复制／下载 Markdown；整门课程合并 Markdown 或打包 ZIP。
- 课程卡片、课程详情提供删除课程；笔记列表和阅读页提供删除笔记。均有确认提示，删除时取消排队和进行中的任务。

P1 的手动编辑、Mermaid、自动出题、分享只保留扩展位置，见 `server/routes/notes.js`。未开发邮箱／手机号注册、协作、OCR、独立移动端应用、会员或第三方登录。

## 格式兼容

前后端及 ZIP 共用 `shared/file-formats.js`，支持文档和常见图片。表格保留公式源表达式，结构化数学公式以 LaTeX 文本输出，不执行宏、公式或脚本。

| 类型 | 可上传扩展名 |
| --- | --- |
| PowerPoint | `.pptx`、`.pptm`、`.ppsx`、`.ppsm`、`.potx`、`.potm` |
| 旧版 PowerPoint | `.ppt`、`.pps`、`.pot` |
| Word | `.docx`、`.docm`、`.dotx`、`.dotm`、`.doc`、`.dot` |
| Excel 与表格 | `.xlsx`、`.xls`、`.xlsm`、`.xlsb`、`.xltx`、`.xltm`、`.xlt`、`.csv`、`.tsv` |
| OpenDocument | `.odt`、`.ott`、`.odp`、`.otp`、`.ods`、`.ots` |
| 文本与网页 | `.txt`、`.md`、`.markdown`、`.html`、`.htm`、`.xhtml` |
| 富文本／电子书／公式文档 | `.rtf`、`.epub`、`.tex`、`.latex` |
| PDF 与资料包 | `.pdf`、`.zip` |

文本支持 UTF-8、UTF-16、GB18030／常见 GBK 中文编码。表格逐工作表读取，保留单元格文字、公式及已有计算结果，不在服务器执行公式。Word、文本、网页和电子书使用逻辑分段标记，不把逻辑段号冒充原排版页码；演示文稿和 PDF 保留页面顺序。

WPS 保存的 DOCX／PPTX／XLSX 可直接读取；`.wps`、`.dps`、`.et` 等专有格式需另存为通用格式。RAR／7Z 需先解压或重新打包为 ZIP；不展开嵌套 ZIP。加密或损坏文件独立失败并给出提示，图片与扫描件继续遵守不执行 OCR 的约束。旧版二进制 Office 的复杂版本若不兼容，会提示另存为新版格式。

文档解析在本机完成，HTML 外链图片不下载，解析器禁用远程资源、附件提取及 OCR。AI 的固定 Prompt 保持原样，新格式统一转换为带 `[Page N]` 标记的文本后进入同一队列。

## 文件隐私与失败恢复

课件提取文本后即从磁盘删除，不等待 AI 调用结束。解析失败也立即删除；ZIP 原件在展开后删除。数据库仅保存提取文本、生成笔记及任务元数据。

AI 调用失败可复用数据库文本手动重试，无需保留课件。损坏或无文本文件没有可重试的文本，界面明确提示重新上传。服务重启会恢复未完成任务，并保留已消耗的自动尝试次数。旧版本残留的失败文件在启动时清理。

上传目录为 `data/uploads`，上传中转目录为 `data/tmp`，两者均不通过静态服务暴露。接口不返回 `raw_text`。

## 配置

Vercel 部署支持登录用户在「AI Key 设置」中填写自己的密钥，服务端通过 `BYOK_SECRET` 加密存储并按任务取用；`AI_API_KEY` 作为可选全局兜底。

| 变量 | 默认值／说明 |
| --- | --- |
| `PORT` | 3000 |
| `DATA_DIR` | `./data` |
| `DB_PATH` | 数据目录中的 `course-notes.db` |
| `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL` | 供应商地址、密钥、模型名 |
| `AI_CONCURRENCY` | 默认 2，限制为整数 2～3 |
| `AI_TIMEOUT_MS` | 120000 |
| `AI_CHUNK_CHARS` | 4000；实际块长还会按输出额度收紧，分块串行调用 |
| `AI_MAX_CHARS` | 240000 |
| `AI_MAX_TOKENS` | 8192；发生截断时缩小失败块再重试，不保存截断正文 |
| `MAX_FILE_SIZE_MB` | 单文件 100MB |
| `MAX_FILES_PER_UPLOAD` | 每批 60 个上传文件 |
| `MAX_FILES_FROM_ZIP` | 每个 ZIP 最多展开 120 份课件 |
| `MAX_ZIP_EXTRACT_MB` | 每个 ZIP 解压体积最多 400MB |

自动重试固定两次，不能通过环境变量放宽。所有配置见 `.env.example`。

若终端出现 `AI_TRUNCATED_RESPONSE`，表示模型输出被长度上限截断。当前配置已调整为 8192 输出额度和 4000 字符分块；重启服务后，对失败笔记点击“重试”即可复用数据库文本重新生成，无需再次上传。分块成功结果只在本次任务重试期间保存在内存中，服务重启或一次任务最终失败后，后续手动重试会重新生成。

## 数据与结构

`server/schema.sql` 包含需求指定的四张表及全部字段：

- `users(id, nickname, created_at)`
- `courses(id, user_id, name, created_at)`
- `notes(id, course_id, title, source_filename, raw_text, markdown_content, status, created_at)`
- `upload_queue(id, note_id, file_path, retry_count)`

附加字段记录更新时间、摘要、引擎、错误和尝试次数。笔记状态固定为 `processing / done / failed`。使用 UUID 主键、ISO 时间、外键和数据库版本管理，为迁移 Postgres 保留空间。

```text
client/src/pages/       登录、课程首页、课程详情、笔记阅读
client/src/components/ 上传弹窗、队列、Markdown、搜索及导出
server/routes/         登录、课程、笔记 API
server/parsers/        PPTX、PDF、办公文档、文本、表格、电子书、ZIP 解析
shared/file-formats.js 前后端共用的格式白名单及提示
server/ai/prompt.js    固定 Prompt 与分块
server/ai/provider.js  OpenAI 兼容调用
server/ai/markdown.js  输出检查与分块合并
server/queue.js        队列、重试、恢复与清理
server/db.js           数据库初始化、事务及访问
server/schema.sql      四张表与索引
```

接口说明见 [API 契约](docs/api-contract.md)。

## 验证

```powershell
npm test
npm run test:browser
```

`npm test` 使用独立临时数据库、本机模拟 OpenAI 接口和示例课件，验证 API、解析、固定 Prompt、自动重试、并发限制、格式校验和文件清理。新增格式动态生成测试样例，并包含作者公开的真实旧版 DOC 样例；来源与许可证见 `tests/fixtures/来源说明.md`。测试不会发送请求到真实模型供应商。

`npm run test:browser` 自动启动隔离服务，使用本机 Chrome 验证登录、新建课程、批量上传、进度、失败隔离、搜索高亮、复制、下载、导出和登录态保留，并额外上传 Word、Excel、旧版 PPT、TXT 和 EPUB 验证网页完整链路。截图保存到 `docs/screenshots`。可设置 `CHROME_PATH` 指定浏览器位置；设置 `BASE_URL` 则验收指定服务。

示例课件已位于 `tests/fixtures`；需要重新生成时，安装 Python、python-pptx 后运行 `npm run fixtures`。

本次验收记录见 [验收结果](docs/acceptance.md)。

## 使用范围

昵称由账号独占，密码错误无法访问课程。旧版无密码账号必须由服务器管理员在本机设置密码；公开接口不允许认领旧账号。单个服务进程负责队列；若扩展为多实例，需要替换为共享任务调度。ZIP 在上传请求内展开，较大压缩包的接收阶段耗时会增加；AI 始终在后台运行。扫描 PDF 与纯图片课件无可读文本时会提示失败，不执行 OCR。


### 旧版账号设置密码

升级后原课程和笔记保留，旧的无密码登录状态失效。在项目目录运行以下命令，将“小林”替换为原昵称：

```powershell
npm run set-password -- "小林"
```

按提示输入两次 8–128 字符的密码，输入不会显示。此命令也可由站点管理员重置密码，并撤销该账号已有会话。不要把密码直接写在命令行或提交到项目文件。新用户在登录页点击“第一次使用？创建账号”，设置昵称、密码和确认密码即可。正式部署应通过 HTTPS 访问。

Cloudflare 部署支持用户级 BYOK，完整 GitHub 上传与首次部署步骤见 [Cloudflare 部署教程](docs/cloudflare-deployment.md)。

本地图片文字识别使用 Tesseract.js。将官方压缩语言文件（如 eng.traineddata.gz、chi_sim.traineddata.gz）放到同一目录，在服务环境设置 OCR_LANG_PATH 指向该目录，OCR_LANGUAGES 可设为 eng+chi_sim（默认 eng）。可处理 PNG、JPEG、WebP、BMP、扫描 PDF 和可提取的文档内嵌图片。每份文件最多识别 12 张图，每张不超过 5 MB。OCR 输出为可读文字，不保证恢复图片公式的二维结构。
