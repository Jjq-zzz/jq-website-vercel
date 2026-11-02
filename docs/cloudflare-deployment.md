# Cloudflare 长期部署

本项目的云端入口为 `cloudflare/worker.js`，前端仍使用现有 React 页面。运行环境全部位于 Cloudflare，个人电脑关机不影响已发布网站。

## 架构与费用

| 模块 | 云端服务 | 用途 |
| --- | --- | --- |
| 前端 | Workers Static Assets | 托管构建后的网页，支持直接访问课程和阅读页链接 |
| 接口 | Workers | 登录、课程、上传、搜索、导出与删除 |
| 数据库 | D1 | 账号、密码哈希、会话、文本、Markdown 与任务进度 |
| 原始文件 | 私有 R2 | 流式接收，文本提取并入库后立即删除；失败也删除 |
| 后台任务 | Durable Objects | 单一持久化协调器，全站最多同时处理两篇，每次推进一个分块 |
| 文件解析 | Containers | 复用现有 42 种扩展名解析能力，仅在临时目录处理文件 |

需要 Workers Paid 套餐及已开通的 R2、Containers。官方当前 Workers Paid 起价为每月 5 美元，容器、存储和 AI 的实际用量另计；不是零成本托管方案。参考 [容器价格](https://developers.cloudflare.com/containers/pricing/)、[容器部署前提](https://developers.cloudflare.com/containers/get-started/)。

无需先购买域名。首次部署可使用 Cloudflare 分配的 `workers.dev` 地址，之后再在控制台的“设置 → 域和路由”中添加自己的域名。

## 一、准备环境并登录

需要 Node.js 24，以及已运行的 Docker Desktop。Docker 使用 Linux 容器模式。安装 Docker Desktop 的过程不由项目脚本自动执行。执行：

```powershell
cd "D:\1\Documents\重点提取"
npm install
docker info
npm run cf:login
```

浏览器会打开 Cloudflare 授权页面，由账号持有人完成登录。不要把 Cloudflare API Token 或 AI 密钥发到聊天中。

## 二、创建云端数据库和文件桶

首次执行：

```powershell
npx wrangler d1 create course-notes
npx wrangler r2 bucket create course-notes-uploads
```

第一条命令会返回 `database_id`。打开项目根目录 `wrangler.jsonc`，将唯一的 `00000000-0000-0000-0000-000000000000` 替换为刚返回的数据库 ID。数据库 ID 是资源标识，不是密钥，可提交到仓库。若名称已存在，复用当前账号中同名且确属本项目的资源，不要重复创建。

保持 R2 桶为私有，不开启公共访问。

然后初始化表结构：

```powershell
npm run cf:migrate
```

## 三、发布完整应用

```powershell
npm run cf:deploy
```

命令会构建前端、构建并推送解析容器镜像、部署 Workers 和两个持久化对象。完成后会显示 HTTPS 网址。首次容器部署可能需要等待镜像就绪，初次解析也会有冷启动时间。

首次发布时无需自建服务器，也不要在 Cloudflare Pages 中仅上传 `dist/client`；那样只有页面，没有数据库和解析接口。

## 四、配置用户密钥加密主密钥

先在本机生成一次随机主密钥：
```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npx wrangler secret put BYOK_SECRET
```

在第二条命令的输入提示中粘贴第一条生成的值。安全备份此值，不要提交 GitHub；更换或遗失后用户需重填 API Key。也可在已部署 Worker 的设置 → 变量和机密中添加 BYOK_SECRET，类型选择 Secret。

每个用户登录后从右上角用户菜单打开「AI Key 设置」并填写自己的 Key。D1 只存 AES-GCM 密文与 IV，接口仅返回尾四位掩码。后台每个任务按所属用户取 Key；解密失败走全局兜底或本地模式，不阻断其他用户。0002 迁移为旧用户补充四个可空字段，由 D1 迁移记录避免重复应用。

全局兜底可选；如果不希望网站替未配置用户支付模型费用，不要设置 AI_API_KEY。需要兜底时才执行下面命令。

## 可选：全局 AI 兜底密钥

```powershell
npx wrangler secret put AI_API_KEY
```

在隐藏输入提示中粘贴密钥并确认。项目默认模型和接口地址位于 `wrangler.jsonc` 的 `vars` 中：

```json
{
  "AI_BASE_URL": "https://api.deepseek.com/v1",
  "AI_MODEL": "deepseek-chat",
  "AI_MAX_TOKENS": "8192",
  "AI_CHUNK_CHARS": "4000"
}
```

接口地址或模型变更后重新运行 `npm run cf:deploy`。本机 `.env` 和系统中的密钥不会自动传到 Cloudflare；必须设置云端 Secret。未设置时页面明确显示本地结构化模式，不会调用真实 AI。

## 五、验收与日志

打开发布网址，创建一个新账号，然后检查新建课程、多文件上传、ZIP、队列、搜索、导出与删除。后台处理不依赖用户保持浏览器开启。

```powershell
npm run cf:logs
```

日志记录调用分块、尝试次数、自动重试和失败状态，不输出密钥或原始课件正文。队列每篇任务最多两次自动重试；成功分块保存到 D1，重试复用，进程恢复后也可继续。截断时自动缩小失败分块，固定提示词逐字复用原项目。

闹钟采用至少执行一次的机制。极端中断可能发生“模型已返回，但数据库尚未确认”的情况，此时可能重新调用该块；不能保证外部 API 恰好计费一次。定时任务每五分钟唤醒队列并清理无主文件，正常进度轮询也会唤醒未完成任务。

本地可执行以下检查，不创建付费资源：

```powershell
npm run build
npm run cf:check
npm run test:cloudflare
```

`cf:check` 检查 Worker 打包与绑定配置，明确跳过容器镜像构建；`test:cloudflare` 使用真实本地 workerd、D1、R2 和闹钟，解析服务以相同 Node 入口运行，AI 为本机模拟接口。Docker 镜像构建与 Cloudflare 线上运行需要在发布环境另行验证。测试不会访问真实用户数据库或外发真实课件。

## 六、迁移已有本地笔记（可选）

云端数据库与本地数据库相互独立，不会自动同步。本地仍使用 `npm start`。

仅在需要保留旧账号和笔记时执行：

```powershell
npm run cf:export
npx wrangler d1 execute course-notes --remote --file cloudflare/private/import.sql
```

迁移目标必须已经初始化且没有业务数据；不要重复导入。生成的文件含私人笔记和账号哈希，已排除 Git 和 Docker 构建。导出过程只读，不删除或修改本地数据。正在本地处理的任务会迁移为失败；有已提取文本的可以在云端重试，尚未提取文本的需重新上传。原始课件和登录会话不会导出。

已设置密码的旧账号使用原昵称和密码登录，首次登录成功后自动升级云端密码哈希。尚未设置密码或需要重置的账号，由管理员在本机执行：

```powershell
npm run cf:password -- "原来的昵称"
```

密码通过隐藏输入获取，仅发送加盐哈希到 D1，并撤销该账号旧会话。

## 七、通过 GitHub 更新部署

项目提供 `.github/workflows/cloudflare.yml`。先按上述步骤完成资源初始化，把实际数据库 ID 提交到仓库。在 GitHub 仓库的“Settings → Secrets and variables → Actions”添加 `CLOUDFLARE_ACCOUNT_ID` 和 `CLOUDFLARE_API_TOKEN`，令牌权限需允许项目使用的 Workers、D1、R2、Durable Objects 和 Containers 资源。令牌留在 GitHub Secrets 中。

在仓库“Actions → 部署到 Cloudflare → Run workflow”手动发布。GitHub 的 Linux 构建机负责镜像构建，因此此路径不需要个人电脑安装 Docker。工作流不自动上传本地数据库、课件或 `.env`，也不会替你开通付费套餐、创建 D1／R2 或设置 AI Secret。工作流当前为手动触发，避免每次提交都启动部署。

## 八、GitHub 应上传哪些文件

本次提供 release/cloudflare-github.zip。先解压，将解压后的文件放在 GitHub 仓库根目录；不要只上传 ZIP，也不要额外套一层目录。特别注意包含隐藏的 .github/workflows/cloudflare.yml、.gitignore 和 .dockerignore。

源码包包含 client、cloudflare、serverless、shared、server、scripts、tests、vercel、api 等源码，以及 package.json、package-lock.json、wrangler.jsonc 和部署文档。server 仍是解析容器与共用工具的依赖，不能删。vercel/api 为保留兼容及现有测试而包含，Cloudflare 的入口仍由 wrangler.jsonc 指定。

不上传 node_modules、dist、.git、.env、.env.local、.dev.vars、.wrangler、.vercel、data、数据库、私人迁移导出文件和个人课件。压缩包按源码文件白名单生成，不打包运行数据与本地配置。

推荐使用 GitHub Desktop 提交解压后的源码目录，或在 GitHub 网页 Upload files 中上传所有解压内容。工作流必须位于默认分支，Actions 页才会出现手动运行入口。

## 九、推荐：通过 GitHub 首次部署（本机无需 Docker）

1. 开通 Workers Paid 和 R2，确认账户可用 Containers。新建 GitHub 私有仓库，将上面的源码解压后上传。
2. 在本机项目目录执行 npm ci、npm run cf:login，完成浏览器授权。
3. 执行 npx wrangler d1 create course-notes 和 npx wrangler r2 bucket create course-notes-uploads。
4. 把 D1 返回的 database_id 填入 wrangler.jsonc，替换全零占位符，并将修改提交到 GitHub。
5. Cloudflare 控制台复制 Account ID，创建范围限定到该账户的 API Token。令牌需允许编辑 Workers Scripts、D1、R2，并具备 Containers 和镜像注册表所需的编辑权限；权限名称以控制台为准。不能只给读取权限。
6. GitHub 仓库 Settings → Secrets and variables → Actions → New repository secret，分别添加 CLOUDFLARE_ACCOUNT_ID、CLOUDFLARE_API_TOKEN。
7. 打开 Actions → 部署到 Cloudflare → Run workflow，选择默认分支运行。工作流依次安装依赖、构建网页、应用 D1 迁移、构建容器并发布 Worker。GitHub 托管的 Ubuntu 构建机提供 Docker。
8. 工作流全部成功后，Cloudflare Workers & Pages 中打开 course-notes，查看分配的网址。按第四节设置 BYOK_SECRET；可在控制台直接添加 Secret，或本机用 Wrangler 设置。
9. 打开网站注册账号，用户菜单填写自己的 API Key，上传小份 TXT/PPTX 验证生成，再测第二个未配置用户走本地模式。不要只依赖 /api/health 判断用户 Key，它只报告全局配置状态。

后续更新源码并提交后，手动再运行同一个工作流即可；不会每次推送自动发布。不要重建数据库或更换 BYOK_SECRET。部署使用 Workers 完整应用，不使用 Pages 静态站点上传流程。

官方参考：[容器部署](https://developers.cloudflare.com/containers/guides/deploy/)、[Worker Secret](https://developers.cloudflare.com/workers/configuration/secrets/)、[D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)。

## 当前验证与限制

本次已验证 Worker 打包、本地云端 API 与完整网页流程，包括密码、五类实际格式、混合 ZIP、损坏隔离、并发上限 2、失败两次重试、截断缩块、重启后数据与待处理任务恢复。真实 Cloudflare 账号尚未登录，本机未安装 Docker，因此没有构建或上线实际容器，也没有生成可公开访问的网址。

单文件应用上限 100MB，同时受 Cloudflare 当前套餐的请求体上限约束。ZIP 初始按一个任务展示，解压后队列总数会按内部课件更新。单篇文字上限 24 万字符；过大课程导出需分篇下载，避免边缘内存不足。大规模用户的用量预算、数据库备份和账号注册策略应在实际开放范围确定后配置。
