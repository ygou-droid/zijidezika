// =======================================================
// Mochi Chat · Ollama 供应商与 Registry 测试（双模型改造 · 阶段 2）
// 运行方式： node test/embedding-local.test.js
// 说明：全部使用本地假 HTTP 服务模拟 Ollama，不安装 / 不启动 Ollama，
//       不联网、不调用真实百炼 API、不需要任何密钥。
//       刻意使用 768 / 2560 / 4096 等非 1024 维度，验证维度来自实际返回值。
// =======================================================

'use strict';

const http = require('http');
const { createApp } = require('../server.js');
const { assertProvider } = require('../lib/embedding/provider-contract.js');
const {
  createOllamaProvider,
  PROVIDER_ID: LOCAL_ID,
  DEFAULT_HOST,
  DEFAULT_MODEL
} = require('../lib/embedding/local-ollama.js');
const {
  createEmbeddingRegistry,
  DEFAULT_PROVIDER_ID,
  CLOUD_PROVIDER_ID,
  LOCAL_PROVIDER_ID
} = require('../lib/embedding/registry.js');

const pass = [];
const fail = [];
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  const line = `${ok ? '通过' : '失败'}  ${name} => 实际: ${actual}` + (ok ? '' : `  期望: ${expected}`);
  (ok ? pass : fail).push(line);
}

const FAKE_KEY = 'sk-test-not-a-real-key';

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function stop(server) {
  return new Promise(function (resolve) { server.close(resolve); });
}
function vector(dimensions, seed) {
  const v = new Array(dimensions).fill(0);
  v[seed % dimensions] = 1;
  return v;
}
function startFakeOllama(handler) {
  const requests = [];
  return new Promise(function (resolve) {
    const server = http.createServer(function (req, res) {
      let body = '';
      req.on('data', function (chunk) { body += chunk; });
      req.on('end', function () {
        const record = { path: req.url, payload: body ? JSON.parse(body) : null };
        requests.push(record);
        handler(res, record);
      });
    });
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, requests: requests, host: 'http://127.0.0.1:' + server.address().port });
    });
  });
}
function startApp(options) {
  return new Promise(function (resolve) {
    const s = createApp(options).listen(0, '127.0.0.1', function () {
      resolve({ server: s, base: 'http://127.0.0.1:' + s.address().port });
    });
  });
}
function embed(base, texts) {
  return fetch(base + '/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: texts })
  });
}

(async function run() {
  console.log('===== Ollama 供应商与 Registry 测试 =====\n');

  // ============ 一、Registry 默认行为 ============
  console.log('【一】Registry 默认行为');
  {
    const registry = createEmbeddingRegistry({ env: {} });

    check('默认供应商是云端百炼', registry.defaultId(), CLOUD_PROVIDER_ID);
    check('默认供应商 id 常量', DEFAULT_PROVIDER_ID, 'cloud-bailian');
    check('注册了两个供应商', registry.ids().join(','), 'cloud-bailian,local-ollama');
    check('本地供应商 id 常量', LOCAL_PROVIDER_ID, LOCAL_ID);

    const cloud = registry.select();
    check('select() 不传参返回云端', cloud.describe().providerId, 'cloud-bailian');
    check('云端模型名不变', cloud.describe().model, 'text-embedding-v4');
    check('云端维度仍是 1024', cloud.describe().dimensions, 1024);
    check('无密钥时云端未就绪', cloud.describe().ready, 'false');

    const local = registry.select('local-ollama');
    check('可以显式取到本地供应商', local.describe().providerId, 'local-ollama');
    check('本地供应商默认模型', local.describe().model, DEFAULT_MODEL);
    check('本地供应商默认地址', local.describe().endpoint, DEFAULT_HOST + '/api/embed');
    check('未调用过时尚无维度信息', local.describe().dimensions, 'null');
    check('本地无需密钥即视为已配置', local.describe().ready, 'true');

    check('list() 返回两个供应商摘要', registry.list().length, 2);
    check('list() 第一个是云端', registry.list()[0].providerId, 'cloud-bailian');
    check('describeDefault() 是云端', registry.describeDefault().providerId, 'cloud-bailian');
    check('tryGet 未知 id 返回 null', registry.tryGet('不存在的供应商'), 'null');

    let notFound = '未抛出异常';
    try { registry.get('不存在的供应商'); } catch (error) {
      notFound = String(error.message).includes('未注册的向量供应商') ? '已报错' : error.message;
    }
    check('选择未注册供应商会明确报错', notFound, '已报错');
    check('同一个 id 只创建一次实例', registry.select('local-ollama') === local, 'true');
  }

  // ============ 二、正常响应与维度识别 ============
  console.log('【二】Ollama 正常响应 · 维度以实际返回为准');
  {
    const DIM = 768;
    const fake = await startFakeOllama(function (res, record) {
      const list = (record.payload && record.payload.input) || [];
      json(res, 200, { model: 'local-model', embeddings: list.map((t, i) => vector(DIM, i + 1)) });
    });

    const provider = createOllamaProvider({ host: fake.host, model: 'fake-local-model' });
    const result = await provider.embedTexts(['甲', '乙']);

    check('返回向量条数正确', result.embeddings.length, 2);
    check('返回向量维度等于真实返回 768', result.embeddings[0].length, DIM);
    check('describe().dimensions 自动更新为实际维度', provider.describe().dimensions, DIM);
    check('describe().dimensions 不是写死的 1024', provider.describe().dimensions === 1024, 'false');
    check('调用后通过统一接口校验', assertProvider(provider) === provider, 'true');
    check('请求体带上了 model', fake.requests[0].payload.model, 'fake-local-model');
    check('请求体 input 是数组', Array.isArray(fake.requests[0].payload.input), 'true');
    const avail = await provider.checkAvailable();
    check('checkAvailable 成功', avail.ok, 'true');
    check('checkAvailable 报出真实维度', avail.dimensions, DIM);

    await stop(fake.server);
  }
  {
    const DIM = 2560;
    const fake = await startFakeOllama(function (res, record) {
      const list = (record.payload && record.payload.input) || [];
      json(res, 200, { embeddings: list.map((t, i) => vector(DIM, i + 1)) });
    });
    const provider = createOllamaProvider({ host: fake.host, model: 'm' });
    const result = await provider.embedTexts(['甲']);
    check('换成 2560 维也能自动识别', provider.describe().dimensions, DIM);
    check('单条请求返回正确维度', result.embeddings[0].length, DIM);
    await stop(fake.server);
  }
  {
    const provider = createOllamaProvider({ host: 'http://127.0.0.1:1', model: 'm', dimensions: 512 });
    check('允许显式声明维度', provider.describe().dimensions, 512);
    check('未调用时也能通过接口校验', assertProvider(provider) === provider, 'true');
  }

  // ============ 三、旧版 Ollama 单条接口 ============
  console.log('【三】旧版 Ollama：退回单条接口');
  {
    const DIM = 4096;
    const fake = await startFakeOllama(function (res, record) {
      if (record.path === '/api/embed') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 page not found');
        return;
      }
      json(res, 200, { embedding: vector(DIM, 3) });
    });
    const provider = createOllamaProvider({ host: fake.host, model: 'm' });
    const result = await provider.embedTexts(['甲', '乙']);
    check('旧版接口也能取到向量', result.embeddings.length, 2);
    check('旧版接口的维度同样取自返回值', provider.describe().dimensions, DIM);
    const times = fake.requests.filter(function (r) { return r.path === '/api/embeddings'; }).length;
    check('确实退回到了单条接口', times, 2);
    await stop(fake.server);
  }

  // ============ 四、不可用与错误响应 ============
  console.log('【四】Ollama 不可用与错误响应');
  {
    const provider = createOllamaProvider({ host: 'http://127.0.0.1:1', model: 'm', timeoutMs: 500 });
    let err = null;
    try { await provider.embedTexts(['你好']); } catch (e) { err = e; }
    check('连接失败时给出 local_unavailable', err && err.code, 'local_unavailable');
    check('错误信息不含凭据字样', /sk-|Bearer/i.test(err ? err.message : ''), 'false');

    const avail = await provider.checkAvailable();
    check('checkAvailable 返回结构化结果', typeof avail.ok, 'boolean');
    check('服务不可用时 ok 为 false', avail.ok, 'false');
    check('服务不可用时给出错误码', avail.code, 'local_unavailable');
    check('服务不可用时给出说明文字', avail.message.length > 0, 'true');
    check('服务不可用不会污染维度', provider.describe().dimensions, 'null');
  }
  {
    const fake = await startFakeOllama(function (res) { json(res, 500, { error: 'boom' }); });
    const provider = createOllamaProvider({ host: fake.host, model: 'm' });
    let err = null;
    try { await provider.embedTexts(['甲']); } catch (e) { err = e; }
    check('HTTP 500 映射为 http_error', err && err.code, 'http_error');
    await stop(fake.server);
  }
  {
    const fake = await startFakeOllama(function (res) {
      json(res, 404, { error: 'model "m" not found, try pulling it first' });
    });
    const provider = createOllamaProvider({ host: fake.host, model: 'm' });
    const avail = await provider.checkAvailable();
    check('模型缺失时给出 local_model_missing', avail.code, 'local_model_missing');
    check('提示里给出 pull 命令', avail.message.includes('ollama pull'), 'true');
    await stop(fake.server);
  }
  {
    const fake = await startFakeOllama(function (res) { res.writeHead(200); res.end('not json'); });
    const provider = createOllamaProvider({ host: fake.host, model: 'm' });
    let err = null;
    try { await provider.embedTexts(['甲']); } catch (e) { err = e; }
    check('非法 JSON 时给出 invalid_response', err && err.code, 'invalid_response');
    await stop(fake.server);
  }
  {
    const fake = await startFakeOllama(function (res) { json(res, 200, { embeddings: [vector(8, 1)] }); });
    const provider = createOllamaProvider({ host: fake.host, model: 'm' });
    let err = null;
    try { await provider.embedTexts(['甲', '乙']); } catch (e) { err = e; }
    check('返回条数不一致时报错', err && err.code, 'invalid_response');
    await stop(fake.server);
  }
  {
    const fake = await startFakeOllama(function (res) {
      json(res, 200, { embeddings: [vector(8, 1), vector(16, 2)] });
    });
    const provider = createOllamaProvider({ host: fake.host, model: 'm' });
    let err = null;
    try { await provider.embedTexts(['甲', '乙']); } catch (e) { err = e; }
    check('同批维度不一致时给出 dimension_mismatch', err && err.code, 'dimension_mismatch');
    await stop(fake.server);
  }
  {
    const provider = createOllamaProvider({ host: 'http://127.0.0.1:1', model: 'm', maxTexts: 2 });
    let e1 = null;
    let e2 = null;
    try { await provider.embedTexts([]); } catch (e) { e1 = e; }
    try { await provider.embedTexts(['a', 'b', 'c']); } catch (e) { e2 = e; }
    check('空数组时给出 invalid_input', e1 && e1.code, 'invalid_input');
    check('超过上限时给出 invalid_input', e2 && e2.code, 'invalid_input');
  }
  {
    check('host 留空时用默认地址', createOllamaProvider({ env: {} }).describe().endpoint, DEFAULT_HOST + '/api/embed');
    check('host 尾部斜杠会被归一化',
      createOllamaProvider({ host: 'http://127.0.0.1:1234///', model: 'm' }).describe().endpoint,
      'http://127.0.0.1:1234/api/embed');
    check('host 可用环境变量指定',
      createOllamaProvider({ env: { OLLAMA_HOST: 'http://192.168.1.9:11434' } }).describe().endpoint,
      'http://192.168.1.9:11434/api/embed');
    check('模型名可用环境变量指定',
      createOllamaProvider({ env: { OLLAMA_MODEL: 'another-model' } }).describe().model, 'another-model');
  }

  // ============ 五、Ollama 作为当前供应商接入 server ============
  console.log('【五】把 Ollama 接到 server（默认仍是云端，这里是显式注入）');
  {
    const DIM = 768;
    const fake = await startFakeOllama(function (res, record) {
      const list = (record.payload && record.payload.input) || [];
      json(res, 200, { embeddings: list.map((t, i) => vector(DIM, i + 1)) });
    });

    const local = createOllamaProvider({ host: fake.host, model: 'local-model', dimensions: DIM });
    // 阶段 3.3：未测量的供应商不允许处理正式请求，先用真实探针量出维度
    await local.ensureMeasured();
    const { server, base } = await startApp({ provider: local });

    try {
      const res = await embed(base, ['甲', '乙']);
      const body = await res.json();
      check('本地供应商也能提供向量服务', res.status, 200);
      check('响应 model 来自本地供应商', body.model, 'local-model');
      check('响应 dimensions 来自本地真实维度', body.dimensions, DIM);
      check('响应 dimensions 不是 1024', body.dimensions === 1024, 'false');
      check('向量条数正确', body.embeddings.length, 2);

      const health = await (await fetch(base + '/api/health')).json();
      check('health.provider.id 是本地供应商', health.provider.id, 'local-ollama');
      check('health.provider.label 正确', health.provider.label, '本地 Ollama');
      check('health.embedding.model 跟随当前供应商', health.embedding.model, 'local-model');
      check('health.embedding.dimensions 跟随当前供应商', health.embedding.dimensions, DIM);
      const keyState = ['已配置', '未配置'].indexOf(health.dashscopeApiKey) >= 0;
      check('health 原有字段 dashscopeApiKey 仍在', keyState, 'true');
      check('health.features.embeddingApi 保持 true', health.features.embeddingApi, 'true');
    } finally {
      await stop(server);
      await stop(fake.server);
    }
  }

  // ============ 六、Ollama 坏掉不影响云端默认服务 ============
  console.log('【六】Ollama 不可用不影响百炼默认服务');
  {
    const cloudClient = {
      describe: function () {
        return {
          model: 'text-embedding-v4', dimensions: 1024, endpoint: 'mock',
          hasApiKey: true, maxTexts: 10, maxTextLength: 8192, timeoutMs: 1000
        };
      },
      embedTexts: async function (texts) {
        return {
          embeddings: texts.map(function (t, i) { return vector(1024, i + 1); }),
          model: 'text-embedding-v4', dimensions: 1024, usage: null
        };
      },
      redact: function (t) { return String(t); }
    };

    const { server, base } = await startApp({
      bailianClient: cloudClient,
      env: { OLLAMA_HOST: 'http://127.0.0.1:1' }
    });

    try {
      const res = await embed(base, ['你好']);
      const body = await res.json();
      check('默认仍走云端：model 不变', body.model, 'text-embedding-v4');
      check('默认仍走云端：dimensions 不变', body.dimensions, 1024);
      check('默认仍走云端：向量维度不变', body.embeddings[0].length, 1024);

      const health = await (await fetch(base + '/api/health')).json();
      check('默认供应商仍然是云端', health.provider.id, 'cloud-bailian');
      check('云端密钥状态仍正确', health.dashscopeApiKey, '已配置');
      check('embedding.apiKeyConfigured 仍正确', health.embedding.apiKeyConfigured, 'true');
      const ids = (health.availableProviders || []).map(function (p) { return p.providerId; }).join(',');
      check('已注册供应商清单包含两个', ids, 'cloud-bailian,local-ollama');
      check('没有发生任何真实模型切换', health.provider.id === 'cloud-bailian', 'true');
    } finally {
      await stop(server);
    }
  }

  // ============ 七、安全检查 ============
  console.log('【七】安全检查');
  {
    const provider = createOllamaProvider({ host: 'http://127.0.0.1:1', model: 'm', apiKey: FAKE_KEY });
    check('配置了代理密钥时会被脱敏', provider.redact('失败 ' + FAKE_KEY), '失败 ***');
    check('describe() 不含密钥', JSON.stringify(provider.describe()).includes(FAKE_KEY), 'false');

    const { server, base } = await startApp({
      env: { OLLAMA_HOST: 'http://127.0.0.1:11434', OLLAMA_MODEL: 'qwen3-embedding:0.6b' }
    });
    try {
      const res = await fetch(base + '/api/health');
      const text = await res.text();
      // 原有的两条安全断言：保留不放宽
      check('health 不含本地地址', text.includes('127.0.0.1:11434'), 'false');
      check('health 不含密钥形态', /sk-[A-Za-z0-9]/.test(text), 'false');

      // health 允许暴露供应商的通用标识，但不得暴露本地服务地址等细节
      const listed = JSON.parse(text).availableProviders || [];
      check('availableProviders 不含本地 Ollama 服务地址',
        JSON.stringify(listed).includes('127.0.0.1:11434'), 'false');
      check('availableProviders 只暴露标识符（providerId 均为字符串）',
        listed.length > 0 && listed.every(function (p) { return typeof p.providerId === 'string'; }), 'true');
    } finally {
      await stop(server);
    }
  }

  console.log('\n' + pass.join('\n'));
  if (fail.length) console.log('\n' + fail.join('\n'));
  console.log('\n共 ' + (pass.length + fail.length) + ' 项，通过 ' + pass.length + ' 项，失败 ' + fail.length + ' 项');
  process.exit(fail.length ? 1 : 0);
})();
