// =======================================================
// Mochi Chat · Provider 可用性与维度前置检查测试（双模型改造 · 阶段 3.3）
// 运行方式： node test/embedding-readiness.test.js
//
// 全部使用本地假 HTTP 服务与假客户端：不联网、不需要密钥、不安装 Ollama。
// 覆盖：真实探针测维度、并发 single-flight、配置失效、未测量不得服务、
//      云端零探测兼容、状态接口脱敏、就绪缓存 TTL、结构校验与就绪校验分层。
// =======================================================

'use strict';

const http = require('http');
const { createOllamaProvider } = require('../lib/embedding/local-ollama.js');
const { createCloudBailianProvider } = require('../lib/embedding/cloud-bailian.js');
const { createEmbeddingRegistry } = require('../lib/embedding/registry.js');
const {
  assertProvider, describeReadiness, isUsable, assertUsable
} = require('../lib/embedding/provider-contract.js');
const { createApp } = require('../server.js');
// 阶段 8：后端已剥离，本测试依赖 Node.js 后端代理，默认隐藏（set MOCHI_RUN_BACKEND_TESTS=1 可强行运行）
if (process.env.MOCHI_RUN_BACKEND_TESTS !== '1') {
  console.log('（跳过）' + __filename.split(/[\\/]/).pop() + '：依赖已废弃的 Node.js 后端，已隐藏。');
  return;
}

const pass = [];
const fail = [];
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  (ok ? pass : fail).push(`${ok ? '通过' : '失败'}  ${name} => 实际: ${actual}` + (ok ? '' : `  期望: ${expected}`));
}

function vector(dimensions, seed) {
  const v = new Array(dimensions).fill(0);
  v[seed % dimensions] = 0.5;
  return v;
}
function close(server) {
  return new Promise(function (resolve) { server.close(resolve); });
}
function startApp(options) {
  return new Promise(function (resolve) {
    const s = createApp(options).listen(0, '127.0.0.1', function () {
      resolve({ server: s, base: 'http://127.0.0.1:' + s.address().port });
    });
  });
}

// 假 Ollama 服务：handler 决定返回什么；每次请求都记下来
function startFakeOllama(handler) {
  const records = [];
  const server = http.createServer(function (req, res) {
    let body = '';
    req.on('data', function (c) { body += c; });
    req.on('end', function () {
      let payload = null;
      try { payload = body ? JSON.parse(body) : null; } catch (e) { payload = null; }
      const record = { path: req.url, payload: payload };
      records.push(record);
      handler(res, record);
    });
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, host: 'http://127.0.0.1:' + server.address().port, records: records });
    });
  });
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function embed(base, texts) {
  return fetch(base + '/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: texts })
  });
}

(async function run() {
  console.log('===== Provider 就绪与维度前置检查测试 =====\n');

  // ============ 一、真实探针测量出维度（三种不同维度，证明不写死）============
  console.log('【一】Ollama 真实向量长度即维度');
  {
    for (const dim of [768, 2560, 4096]) {
      const fake = await startFakeOllama(function (res, record) {
        const list = (record.payload && record.payload.input) || [];
        json(res, 200, { embeddings: list.map(function (t, i) { return vector(dim, i + 1); }) });
      });
      const provider = createOllamaProvider({ host: fake.host, model: 'm' });
      const status = await provider.ensureMeasured();
      check('维度 ' + dim + '：测量成功', status.ok, 'true');
      check('维度 ' + dim + '：取到真实维度', status.dimensions, dim);
      check('维度 ' + dim + '：标记为已测量', status.measured, 'true');
      check('维度 ' + dim + '：describe 同步报告', provider.describe().dimensions, dim);
      check('维度 ' + dim + '：维度来源为实测', provider.describe().dimensionSource, 'measured');
      await close(fake.server);
    }
  }

  // ============ 二、未测量时的状态（结构合法但不可用）============
  console.log('【二】未测量：结构合法但不可正式使用');
  {
    const fake = await startFakeOllama(function (res) { json(res, 200, { embeddings: [vector(768, 1)] }); });
    const provider = createOllamaProvider({ host: fake.host, model: 'm' });

    check('未测量时维度为 null', provider.describe().dimensions, 'null');
    check('未测量时 measured 为 false', provider.describe().measured, 'false');
    check('未测量时维度来源为 unknown', provider.describe().dimensionSource, 'unknown');

    // 结构校验：未测量也能通过，可以安全注册与取得实例
    check('结构校验仍然通过', assertProvider(provider) === provider, 'true');
    check('结构校验通过但不可用', isUsable(provider), 'false');
    check('就绪原因明确', describeReadiness(provider).reason, 'dimensions_unknown');
    let thrown = '未抛出';
    try { assertUsable(provider); } catch (e) { thrown = e.code; }
    check('正式使用被拦下', thrown, 'provider_not_ready');

    // 声明了维度但未实测，同样不能使用（不允许用配置值冒充实测值）
    const declared = createOllamaProvider({ host: fake.host, model: 'm', dimensions: 768 });
    check('只声明维度仍不算已测量', declared.describe().measured, 'false');
    check('只声明维度仍不可用', isUsable(declared), 'false');

    // 注册表可以安全取得未测量的实例
    const registry = createEmbeddingRegistry({
      env: { OLLAMA_HOST: fake.host, OLLAMA_MODEL: 'm' },
      fetchImpl: function (url, init) { return fetch(url, init); }
    });
    const local = registry.tryGet('local-ollama');
    check('注册表能取得未测量实例', Boolean(local), 'true');
    check('注册表取到的实例同样不可用', isUsable(local), 'false');

    await close(fake.server);
  }

  // ============ 三、模型缺失（404）与不可达 ============
  console.log('【三】失败场景：模型缺失与不可达');
  {
    const missing = await startFakeOllama(function (res) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 page not found');
    });
    const p1 = createOllamaProvider({ host: missing.host, model: 'not-pulled' });
    const s1 = await p1.ensureMeasured();
    check('模型缺失：ok 为 false', s1.ok, 'false');
    check('模型缺失：错误码正确', s1.code, 'local_model_missing');
    check('模型缺失：给出 pull 提示', /ollama pull/.test(s1.message), 'true');
    check('模型缺失：维度仍为 null', p1.describe().dimensions, 'null');
    await close(missing.server);

    const p2 = createOllamaProvider({ host: 'http://127.0.0.1:1', model: 'm', timeoutMs: 400 });
    const s2 = await p2.ensureMeasured();
    check('不可达：ok 为 false', s2.ok, 'false');
    check('不可达：错误码正确', s2.code, 'local_unavailable');
    check('不可达：不抛异常且有说明', s2.message.length > 0, 'true');
    check('不可达：维度仍为 null', p2.describe().dimensions, 'null');

    // 脱敏：错误信息里不得出现密钥字样
    const p3 = createOllamaProvider({ host: 'http://127.0.0.1:1', model: 'm', timeoutMs: 400, apiKey: 'sk-secret-123' });
    const s3 = await p3.ensureMeasured();
    check('失败信息已脱敏', s3.message.includes('sk-secret-123'), 'false');
  }

  // ============ 四、旧版 Ollama（只有 /api/embeddings）也能测出维度 ============
  console.log('【四】旧版接口回退后仍测得真实维度');
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
    const status = await provider.ensureMeasured();
    check('旧版接口测量成功', status.ok, 'true');
    check('旧版接口取到真实维度', status.dimensions, DIM);
    await close(fake.server);
  }

  // ============ 五、并发 single-flight ============
  console.log('【五】同一配置并发测量只发一次请求');
  {
    const DIM = 768;
    const fake = await startFakeOllama(function (res, record) {
      const list = (record.payload && record.payload.input) || [];
      json(res, 200, { embeddings: list.map(function (t, i) { return vector(DIM, i + 1); }) });
    });
    const provider = createOllamaProvider({ host: fake.host, model: 'm' });
    const results = await Promise.all([
      provider.ensureMeasured(), provider.ensureMeasured(),
      provider.ensureMeasured(), provider.ensureMeasured(), provider.ensureMeasured()
    ]);
    check('并发结果全部成功', results.every(function (r) { return r.ok === true; }), 'true');
    check('并发结果维度一致', results.every(function (r) { return r.dimensions === DIM; }), 'true');
    check('上游只被请求一次', fake.records.length, 1);

    // 已经测过之后再次调用：直接复用，不再打扰上游
    await provider.ensureMeasured();
    check('已测量后复用结果，不再请求', fake.records.length, 1);
    await close(fake.server);
  }

  // ============ 六、配置变化后旧测量失效 ============
  console.log('【六】model / host 变化后旧测量结果不沿用');
  {
    const fake = await startFakeOllama(function (res, record) {
      const payload = record.payload || {};
      const model = payload.model || (record.path === '/api/embed' ? payload.model : payload.model);
      const dims = model === 'big-model' ? 2560 : 768;
      const list = payload.input || [];
      json(res, 200, { embeddings: list.map(function (t, i) { return vector(dims, i + 1); }) });
    });

    const small = createOllamaProvider({ host: fake.host, model: 'small-model' });
    const big = createOllamaProvider({ host: fake.host, model: 'big-model' });
    const s1 = await small.ensureMeasured();
    const s2 = await big.ensureMeasured();
    check('小模型测得 768', s1.dimensions, 768);
    check('大模型测得 2560', s2.dimensions, 2560);
    check('两个实例互不复用', small.describe().dimensions, 768);
    check('大模型实例保持自己的值', big.describe().dimensions, 2560);
    check('令牌随 model 变化', s1.token === s2.token, 'false');
    await close(fake.server);
  }

  // ============ 七、云端：不做真实探测，行为不变 ============
  console.log('【七】云端零探测兼容');
  {
    let calls = 0;
    const client = {
      describe: function () {
        return {
          model: 'text-embedding-v4', dimensions: 1024, endpoint: 'mock',
          hasApiKey: true, maxTexts: 10, maxTextLength: 8192, timeoutMs: 1000
        };
      },
      embedTexts: async function (texts) {
        calls++;
        return {
          embeddings: texts.map(function (t, i) { return vector(1024, i + 1); }),
          model: 'text-embedding-v4', dimensions: 1024, usage: null
        };
      },
      redact: function (t) { return String(t); }
    };
    const cloud = createCloudBailianProvider({ client: client });
    const status = await cloud.ensureMeasured();
    check('云端就绪检查成功', status.ok, 'true');
    check('云端维度为官方声明值', status.dimensions, 1024);
    check('云端维度来源为 declared', cloud.describe().dimensionSource, 'declared');
    check('云端检查不发任何请求', calls, 0);

    const noKey = createCloudBailianProvider({
      client: {
        describe: function () { return { model: 'text-embedding-v4', dimensions: 1024, hasApiKey: false, maxTexts: 10, maxTextLength: 8192 }; },
        embedTexts: async function () { throw new Error('不应被调用'); },
        redact: function (t) { return String(t); }
      }
    });
    const bad = await noKey.ensureMeasured();
    check('无密钥时未就绪', bad.ok, 'false');
    check('无密钥时错误码不变', bad.code, 'missing_api_key');
    check('无密钥时也不发请求', calls, 0);
  }

  // ============ 八、未测量 Provider 不得服务正式请求 ============
  console.log('【八】测量前禁止正式 embedding 请求');
  {
    const DIM = 768;
    const fake = await startFakeOllama(function (res, record) {
      const list = (record.payload && record.payload.input) || [];
      json(res, 200, { embeddings: list.map(function (t, i) { return vector(DIM, i + 1); }) });
    });
    const provider = createOllamaProvider({ host: fake.host, model: 'm' });
    const app = await startApp({ provider: provider, cacheMaxEntries: 50 });

    try {
      const res = await embed(app.base, ['你好']);
      const body = await res.json();
      check('未测量时返回 503', res.status, 503);
      check('未测量时错误码为 provider_not_ready', body.code, 'provider_not_ready');
      check('未测量时不返回向量', body.embeddings === undefined, 'true');
      check('未测量时维度不是伪造的 1024', body.dimensions === 1024, 'false');
      check('未测量时未调用上游', fake.records.length, 0);
      check('未测量时未写入缓存', body.cachedCount === undefined, 'true');

      const health = await (await fetch(app.base + '/api/health')).json();
      check('未测量时 health 维度为 null', health.embedding.dimensions, 'null');
      check('未测量时 health 仍完整', health.status, 'ok');

      // 测量完成后即可正常服务
      const status = await provider.ensureMeasured();
      check('补做测量成功', status.dimensions, DIM);
      const ok = await embed(app.base, ['你好']);
      const okBody = await ok.json();
      check('测量后即可正常服务', ok.status, 200);
      check('测量后维度为真实值', okBody.dimensions, DIM);
      check('测量后返回向量', okBody.embeddings.length, 1);
    } finally {
      await close(app.server);
      await close(fake.server);
    }
  }

  // ============ 九、探针不进入正式缓存 ============
  console.log('【九】探针不污染正式 embedding 缓存');
  {
    const DIM = 768;
    const fake = await startFakeOllama(function (res, record) {
      const list = (record.payload && record.payload.input) || [];
      json(res, 200, { embeddings: list.map(function (t, i) { return vector(DIM, i + 1); }) });
    });
    const provider = createOllamaProvider({ host: fake.host, model: 'm' });
    await provider.ensureMeasured(); // 探针
    const probeCalls = fake.records.length;
    check('探针确实发过一次请求', probeCalls, 1);

    const app = await startApp({ provider: provider, cacheMaxEntries: 50 });
    try {
      const first = await (await embed(app.base, ['你好'])).json();
      check('首次正式请求未命中缓存', first.cachedCount, 0);
      const second = await (await embed(app.base, ['你好'])).json();
      check('第二次才命中缓存', second.cachedCount, 1);
      check('探针文本没有被写进缓存', second.cachedCount, 1);
    } finally {
      await close(app.server);
      await close(fake.server);
    }
  }

  // ============ 十、就绪结果缓存：TTL 与失败短 TTL ============
  console.log('【十】就绪结果缓存与过期');
  {
    let fakeNow = 1000;
    const fake = await startFakeOllama(function (res, record) {
      const list = (record.payload && record.payload.input) || [];
      json(res, 200, { embeddings: list.map(function (t, i) { return vector(768, i + 1); }) });
    });
    const registry = createEmbeddingRegistry({
      env: { OLLAMA_HOST: fake.host, OLLAMA_MODEL: 'm' },
      fetchImpl: function (url, init) { return fetch(url, init); },
      now: function () { return fakeNow; }
    });

    const first = await registry.ensureReady('local-ollama');
    check('注册表就绪检查成功', first.ok, 'true');
    check('注册表就绪检查维度正确', first.dimensions, 768);
    check('注册表检查结果可用', first.usable, 'true');

    // 4 分钟后仍在 5 分钟成功缓存期内 → 直接命中缓存（检查时间不变）
    fakeNow += 4 * 60 * 1000;
    const cached = await registry.ensureReady('local-ollama');
    check('成功缓存 5 分钟内命中缓存', cached.checkedAt, first.checkedAt);

    // 累计 6 分钟：成功缓存已过期 → 重新检查（检查时间推进）
    fakeNow += 2 * 60 * 1000;
    const renewed = await registry.ensureReady('local-ollama');
    check('超过 5 分钟后重新检查', renewed.checkedAt > first.checkedAt, 'true');
    await close(fake.server);

    // 失败场景：短 TTL
    const badRegistry = createEmbeddingRegistry({
      env: { OLLAMA_HOST: 'http://127.0.0.1:1', OLLAMA_MODEL: 'm' },
      fetchImpl: function (url, init) { return fetch(url, init); },
      now: function () { return fakeNow; }
    });
    const bad1 = await badRegistry.ensureReady('local-ollama');
    check('失败检查结果 ok 为 false', bad1.ok, 'false');
    check('失败检查错误码正确', bad1.code, 'local_unavailable');
    check('失败检查维度为 null', bad1.dimensions, 'null');
    check('失败检查 usable 为 false', bad1.usable, 'false');

    // 失败 TTL 较短（30 秒）：20 秒内复用，40 秒后重新检查
    fakeNow += 20 * 1000;
    const badCached = await badRegistry.ensureReady('local-ollama');
    check('失败结果 20 秒内复用缓存', badCached.checkedAt, bad1.checkedAt);

    fakeNow += 40 * 1000;
    const badRenewed = await badRegistry.ensureReady('local-ollama');
    check('失败结果 30 秒后重新检查', badRenewed.checkedAt > bad1.checkedAt, 'true');
    check('重新检查后仍是同样的失败码', badRenewed.code, 'local_unavailable');
  }

  // ============ 十一、/api/embedding/status 只读且脱敏 ============
  console.log('【十一】状态接口只读且不泄露敏感信息');
  {
    const fake = await startFakeOllama(function (res, record) {
      const list = (record.payload && record.payload.input) || [];
      json(res, 200, { embeddings: list.map(function (t, i) { return vector(768, i + 1); }) });
    });
    const cloudClient = {
      describe: function () {
        return {
          model: 'text-embedding-v4', dimensions: 1024, endpoint: 'mock',
          hasApiKey: true, maxTexts: 10, maxTextLength: 8192, timeoutMs: 1000
        };
      },
      embedTexts: async function () { throw new Error('不应被调用'); },
      redact: function (t) { return String(t); }
    };
    const app = await startApp({
      env: { OLLAMA_HOST: fake.host, OLLAMA_MODEL: 'm' },
      fetchImpl: function (url, init) { return fetch(url, init); },
      bailianClient: cloudClient
    });
    try {
      const res = await fetch(app.base + '/api/embedding/status');
      const body = await res.json();
      check('状态接口可用', res.status, 200);
      check('状态接口状态为 ok', body.status, 'ok');
      check('默认供应商仍是云端', body.defaultProviderId, 'cloud-bailian');
      check('当前供应商可用', body.current.usable, 'true');

      const ids = body.providers.map(function (p) { return p.providerId; }).join(',');
      check('列出全部已注册供应商', ids, 'cloud-bailian,local-ollama');
      const local = body.providers.find(function (p) { return p.providerId === 'local-ollama'; });
      check('本地供应商状态已包含', Boolean(local), 'true');
      check('本地供应商已测得维度', local.dimensions, 768);
      check('本地供应商标记为已测量', local.measured, 'true');
      check('本地供应商可用', local.usable, 'true');

      const text = JSON.stringify(body);
      check('不含本地服务地址', text.includes('127.0.0.1:11434'), 'false');
      check('不含假服务地址与端口', text.includes(fake.host.replace('http://', '')), 'false');
      check('不含 endpoint 字段', text.includes('endpoint'), 'false');
      // 只允许出现「环境变量名」这种提示文案，绝不允许出现任何值
      check('不含任何密钥值', /sk-[A-Za-z0-9]|Bearer\s+\S/.test(text), 'false');
      check('不含环境变量的值（只可能有变量名提示）',
        text.includes(fake.host) || text.includes('11434'), 'false');

      // /api/health 语义不受影响
      const health = await (await fetch(app.base + '/api/health')).json();
      check('health 仍是十个旧字段齐全',
        ['cache', 'dashscopeApiKey', 'embedding', 'features', 'message', 'node', 'service', 'status', 'timestamp', 'uptimeSeconds']
          .every(function (k) { return Object.keys(health).indexOf(k) >= 0; }), 'true');
      check('health.embedding.dimensions 仍为云端 1024', health.embedding.dimensions, 1024);
      check('health.features.embeddingVerified 保持 false', health.features.embeddingVerified, 'false');
    } finally {
      await close(app.server);
      await close(fake.server);
    }
  }

  // ============ 十二、结构校验仍然严格 ============
  console.log('【十二】结构校验没有放松');
  {
    const base = {
      describe: function () {
        return { providerId: 'p', label: 'l', model: 'm', dimensions: 1024, maxTexts: 10, maxTextLength: 8192, ready: true };
      },
      embedTexts: async function () { return { embeddings: [], dimensions: 1024 }; },
      redact: function (t) { return String(t); }
    };
    function throws(mutate) {
      const p = Object.assign({}, base);
      p.describe = function () { return mutate(Object.assign({}, base.describe())); };
      try { assertProvider(p); return '未抛出'; } catch (e) { return e.message; }
    }
    check('dimensions 为字符串仍被拒绝', /dimensions 应为 number/.test(throws(function (d) { d.dimensions = '1024'; return d; })), 'true');
    check('dimensions 为 0 仍被拒绝', /dimensions 必须是正数/.test(throws(function (d) { d.dimensions = 0; return d; })), 'true');
    check('dimensions 为负数仍被拒绝', /dimensions 必须是正数/.test(throws(function (d) { d.dimensions = -1; return d; })), 'true');
    check('model 为空仍被拒绝', /model 不能为空字符串/.test(throws(function (d) { d.model = ''; return d; })), 'true');
    check('缺少 redact 仍被拒绝',
      /缺少方法 redact/.test((function () {
        try { assertProvider({ describe: base.describe, embedTexts: base.embedTexts }); return '未抛出'; }
        catch (e) { return e.message; }
      })()), 'true');

    // 未测量（null）通过结构校验，但就绪校验拦下——两层各司其职
    const unknown = Object.assign({}, base);
    unknown.describe = function () {
      return { providerId: 'p', label: 'l', model: 'm', dimensions: null, maxTexts: 10, maxTextLength: 8192, ready: true, measured: false };
    };
    check('未测量通过结构校验', assertProvider(unknown) === unknown, 'true');
    check('未测量未通过就绪校验', isUsable(unknown), 'false');
    let code = '未抛出';
    try { assertUsable(unknown); } catch (e) { code = e.code; }
    check('未测量被正式使用闸门拦下', code, 'provider_not_ready');
  }

  console.log('\n' + pass.join('\n'));
  if (fail.length) console.log('\n' + fail.join('\n'));
  console.log(`\n共 ${pass.length + fail.length} 项，通过 ${pass.length} 项，失败 ${fail.length} 项`);
  process.exit(fail.length ? 1 : 0);
})();
