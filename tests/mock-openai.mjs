/**
 * 本地 mock 的 OpenAI 兼容接口，用于验证 AI 调用、重试、分块合并。
 * - 前两次请求故意返回 500，第三次成功，验证“失败自动重试 2 次”。
 * - GET /stats 查看请求次数。
 * 仅测试用，不参与生产运行。
 */
import http from 'node:http';

const port = Number(process.env.MOCK_PORT || 4010);
let requests = 0;

const markdown = `## 一、流行病学定义

- **流行病学是研究人群中疾病与健康状况分布及其影响因素的科学** 📌 必背
- ⚠️ 考点：定义的三个关键词

## 二、研究设计

- 描述性研究提出假设
- 分析性研究检验假设

### 📖 老师举例

- 某市高血压患病率调查

## 🎯 本章速记

- 人群是研究对象
- 分布是核心
- 关注影响因素
- 研究防制策略
- 重视因果推断`;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ requests }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    requests += 1;
    if (requests < 3) {
      res.writeHead(500, { 'content-type': 'application/json', 'x-request-id': `mock-${requests}` });
      res.end(JSON.stringify({ error: { message: `mock transient failure ${requests}`, type: 'server_error' } }));
      return;
    }
    try {
      const payload = JSON.parse(body);
      if (!payload.messages?.[0]?.content?.includes('你是一个资深大学生学习助手')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'prompt missing' } }));
        return;
      }
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad json' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: `chatcmpl-mock-${requests}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: markdown }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      }),
    );
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-openai] listening on http://127.0.0.1:${port}/v1`);
});
