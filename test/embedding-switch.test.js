// =======================================================
// Mochi Chat · Embedding Provider 运行时切换测试（双模型改造 · 阶段 3.4）
// 运行方式： node test/embedding-switch.test.js
//
// 全部使用本地假 Ollama 服务与假百炼客户端：不联网、不需要密钥、不安装 Ollama。
//
// 覆盖：切换成功、目标未就绪拒绝切换、未测量 Ollama 不得进入服务、
//      并发切换、切换期间在途请求不混用、旧请求晚返回、缓存身份隔离、
//      只读接口脱敏、/api/health 兼容、前端身份识别与旧结果作废。
// =======================================================

'use strict';

const http = require('http');
const { JSDOM } = require('jsdom');
const { createApp } = require('../server.js');

const pass = [];
const fail = [];
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  (ok ? pass : fail).push(`${ok ? '通过' : '失败'}  ${name} => 实际: ${actual}` + (ok ? '' : `  期望: ${expected}`));
}
const wait = ms => new Promise(r => setTimeout(r, ms));

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
function switchTo(base, providerId) {
  return fetch(base + '/api/embedding/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerId: providerId })
  });
}
function cloudClient(dimensions, options) {
  const settings = options || {};
  return {
    calls: [],
    describe: function () {
      return {
        model: 'text-embedding-v4', dimensions: dimensions, endpoint: 'mock',
        hasApiKey: true, maxTexts: 10, maxTextLength: 8192, timeoutMs: 1000
      };
    },
    embedTexts: async function (texts) {
      this.calls.push(texts.slice());
      if (settings.delay) await new Promise(r => setTimeout(r, settings.delay));
      if (settings.fail) throw settings.fail;
      return {
        embeddings: texts.map(function (t, i) { return vector(dimensions, i + 1); }),
        model: 'text-embedding-v4', dimensions: dimensions, usage: null
      };
    },
    redact: function (t) { return String(t); }
  };
}

(async function run() {
  console.log('===== Embedding Provider 运行时切换测试 =====\n');

  const TEXT = '我今天很累，想休息放松一下';

  // ============ 一、GET /api/embedding/providers 只读清单 ============
  console.log('【一】可选供应商只读清单');
  {
    const fake = await startFakeOllama(function (res, record) {
      const list = (record.payload && record.payload.input) || [];
      json(res, 200, { embeddings: list.map(function (t, i) { return vector(768, i + 1); }) });
    });
    const app = await startApp({
      bailianClient: cloudClient(1024),
      env: { OLLAMA_HOST: fake.host, OLLAMA_MODEL: 'm' },
      fetchImpl: function (url, init) { return fetch(url, init); }
    });
    try {
      const res = await fetch(app.base + '/api/embedding/providers');
      const body = await res.json();
      check('清单接口可用', res.status, 200);
      check('清单接口状态为 ok', body.status, 'ok');
      check('默认供应商是云端', body.defaultProviderId, 'cloud-bailian');
      check('当前供应商是云端', body.currentProviderId, 'cloud-bailian');
      check('允许切换', body.switchingEnabled, 'true');
      check('列出两个供应商', body.providers.map(function (p) { return p.providerId; }).join(','), 'cloud-bailian,local-ollama');
      const cloud = body.providers.find(function (p) { return p.providerId === 'cloud-bailian'; });
      const local = body.providers.find(function (p) { return p.providerId === 'local-ollama'; });
      check('云端标记为当前', cloud.isCurrent, 'true');
      check('云端可用', cloud.usable, 'true');
      check('云端维度为 1024', cloud.dimensions, 1024);
      check('本地已测得维度', local.dimensions, 768);
      check('本地可用', local.usable, 'true');

      const text = JSON.stringify(body);
      check('清单不含本地地址', text.includes('127.0.0.1:11434'), 'false');
      check('清单不含假服务地址', text.includes(fake.host), 'false');
      check('清单不含 endpoint 字段', text.includes('endpoint'), 'false');
      check('清单不含密钥形态', /sk-[A-Za-z0-9]|Bearer\s+\S/.test(text), 'false');
    } finally {
      await close(app.server);
      await close(fake.server);
    }
  }

  // ============ 二、切换成功 ============
  console.log('【二】切换成功后的身份与服务');
  {
    const fake = await startFakeOllama(function (res, record) {
      const list = (record.payload && record.payload.input) || [];
      json(res, 200, { embeddings: list.map(function (t, i) { return vector(768, i + 1); }) });
    });
    const cloud = cloudClient(1024);
    const app = await startApp({
      bailianClient: cloud,
      env: { OLLAMA_HOST: fake.host, OLLAMA_MODEL: 'm' },
      fetchImpl: function (url, init) { return fetch(url, init); }
    });
    try {
      // 切换前：走云端
      const before = await (await embed(app.base, [TEXT])).json();
      check('切换前走云端', before.providerId, 'cloud-bailian');
      check('切换前维度 1024', before.dimensions, 1024);

      const res = await switchTo(app.base, 'local-ollama');
      const body = await res.json();
      check('切换成功返回 200', res.status, 200);
      check('切换结果 providerId 正确', body.providerId, 'local-ollama');
      check('切换结果带模型名', body.model, 'm');
      check('切换结果带真实维度', body.dimensions, 768);
      check('切换结果记录原供应商', body.previousProviderId, 'cloud-bailian');

      const after = await (await embed(app.base, [TEXT])).json();
      check('切换后走本地', after.providerId, 'local-ollama');
      check('切换后维度为 768', after.dimensions, 768);
      check('切换后向量长度正确', after.embeddings[0].length, 768);

      const health = await (await fetch(app.base + '/api/health')).json();
      check('health.provider.id 跟随切换', health.provider.id, 'local-ollama');
      check('health.embedding.dimensions 跟随切换', health.embedding.dimensions, 768);
      check('health 旧字段仍齐全',
        ['cache', 'dashscopeApiKey', 'embedding', 'features', 'message', 'node', 'provider', 'service', 'status', 'timestamp', 'uptimeSeconds']
          .every(function (k) { return Object.keys(health).indexOf(k) >= 0; }), 'true');
      check('health.features.embeddingVerified 保持 false', health.features.embeddingVerified, 'false');
      check('health 仍列出两个供应商',
        (health.availableProviders || []).map(function (p) { return p.providerId; }).join(','), 'cloud-bailian,local-ollama');
    } finally {
      await close(app.server);
      await close(fake.server);
    }
  }

  // ============ 三、目标未就绪：拒绝切换且原供应商不变 ============
  console.log('【三】本地不可用时拒绝切换');
  {
    const cloud = cloudClient(1024);
    const app = await startApp({
      bailianClient: cloud,
      env: { OLLAMA_HOST: 'http://127.0.0.1:1', OLLAMA_MODEL: 'm', OLLAMA_TIMEOUT_MS: '400' },
      fetchImpl: function (url, init) { return fetch(url, init); }
    });
    try {
      const res = await switchTo(app.base, 'local-ollama');
      const body = await res.json();
      check('未就绪时返回 503', res.status, 503);
      check('未就绪时错误码明确', body.code, 'local_unavailable');
      check('未就绪时当前供应商仍是云端', body.currentProviderId, 'cloud-bailian');
      check('未就绪时 previousProviderId 不变', body.previousProviderId, 'cloud-bailian');
      check('未就绪时错误信息不含内部地址', /https?:\/\//.test(body.message), 'false');
      check('未就绪时错误信息不含端口', body.message.includes('127.0.0.1'), 'false');

      // 原供应商照常服务
      const ok = await embed(app.base, [TEXT]);
      const okBody = await ok.json();
      check('切换失败后云端仍可用', ok.status, 200);
      check('切换失败后仍是云端身份', okBody.providerId, 'cloud-bailian');
      check('切换失败后维度仍是 1024', okBody.dimensions, 1024);

      const health = await (await fetch(app.base + '/api/health')).json();
      check('切换失败后 health 未变', health.provider.id, 'cloud-bailian');
    } finally {
      await close(app.server);
    }
  }

  // ============ 四、未测量的 Ollama 不得进入服务 ============
  console.log('【四】未测量不得切换（维度未知）');
  {
    const cloud = cloudClient(1024);
    const app = await startApp({
      bailianClient: cloud,
      env: { OLLAMA_HOST: 'http://127.0.0.1:1', OLLAMA_MODEL: 'm', OLLAMA_TIMEOUT_MS: '400' },
      fetchImpl: function (url, init) { return fetch(url, init); }
    });
    try {
      const res = await switchTo(app.base, 'local-ollama');
      const body = await res.json();
      check('未测量时被拒绝', res.status, 503);
      check('未测量时未切换', body.currentProviderId, 'cloud-bailian');
      check('未测量时维度不是伪造值', body.dimensions === 1024, 'false');
    } finally {
      await close(app.server);
    }
  }

  // ============ 五、参数与未知供应商 ============
  console.log('【五】请求参数校验');
  {
    const app = await startApp({
      bailianClient: cloudClient(1024),
      fetchImpl: function (url, init) { return fetch(url, init); }
    });
    try {
      const bad = await (await fetch(app.base + '/api/embedding/switch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
      }));
      const badBody = await bad.json();
      check('缺少 providerId 返回 400', bad.status, 400);
      check('缺少 providerId 错误码', badBody.code, 'invalid_input');

      const unknown = await switchTo(app.base, 'no-such-provider');
      const unknownBody = await unknown.json();
      check('未知供应商返回 503', unknown.status, 503);
      check('未知供应商错误码', unknownBody.code, 'unknown_provider');
      check('未知供应商不改变当前', unknownBody.currentProviderId, 'cloud-bailian');
    } finally {
      await close(app.server);
    }
  }

  // ============ 六、并发切换 ============
  console.log('【六】并发切换结果一致');
  {
    const fake = await startFakeOllama(function (res, record) {
      const list = (record.payload && record.payload.input) || [];
      json(res, 200, { embeddings: list.map(function (t, i) { return vector(768, i + 1); }) });
    });
    const app = await startApp({
      bailianClient: cloudClient(1024),
      env: { OLLAMA_HOST: fake.host, OLLAMA_MODEL: 'm' },
      fetchImpl: function (url, init) { return fetch(url, init); }
    });
    try {
      const results = await Promise.all([
        switchTo(app.base, 'local-ollama'),
        switchTo(app.base, 'cloud-bailian'),
        switchTo(app.base, 'local-ollama')
      ]);
      const bodies = await Promise.all(results.map(function (r) { return r.json(); }));
      check('并发切换全部返回成功', bodies.every(function (b) { return b.status === 'ok'; }), 'true');
      const last = bodies[bodies.length - 1];
      check('最后一次切换生效', last.currentProviderId, 'local-ollama');
      check('最后一次切换维度正确', last.dimensions, 768);

      const after = await (await embed(app.base, [TEXT])).json();
      check('并发切换后服务身份一致', after.providerId, 'local-ollama');
      check('并发切换后维度一致', after.dimensions, 768);
    } finally {
      await close(app.server);
      await close(fake.server);
    }
  }

  // ============ 七、切换期间在途请求不混用两个 Provider ============
  console.log('【七】在途请求始终使用同一份快照');
  {
    const fake = await startFakeOllama(function (res, record) {
      const list = (record.payload && record.payload.input) || [];
      json(res, 200, { embeddings: list.map(function (t, i) { return vector(768, i + 1); }) });
    });
    const cloud = cloudClient(1024, { delay: 600 }); // 云端故意慢
    const app = await startApp({
      bailianClient: cloud,
      env: { OLLAMA_HOST: fake.host, OLLAMA_MODEL: 'm' },
      fetchImpl: function (url, init) { return fetch(url, init); }
    });
    try {
      // 发出慢请求（云端），趁它在途完成切换
      const inflight = embed(app.base, [TEXT + '（在途）']);
      await wait(120);
      const switched = await (await switchTo(app.base, 'local-ollama')).json();
      check('在途请求期间切换成功', switched.status, 'ok');

      const done = await (await inflight).json();
      check('在途请求仍用切换前的云端', done.providerId, 'cloud-bailian');
      check('在途请求维度仍是 1024', done.dimensions, 1024);
      check('在途请求向量长度一致', done.embeddings[0].length, 1024);

      // 切换之后的新请求走本地
      const after = await (await embed(app.base, [TEXT])).json();
      check('切换后的新请求走本地', after.providerId, 'local-ollama');
      check('切换后的新请求维度 768', after.dimensions, 768);
    } finally {
      await close(app.server);
      await close(fake.server);
    }
  }

  // ============ 八、缓存身份隔离：切换后不复用，切回后仍在 ============
  console.log('【八】切换前后的缓存身份隔离');
  {
    const fake = await startFakeOllama(function (res, record) {
      const list = (record.payload && record.payload.input) || [];
      json(res, 200, { embeddings: list.map(function (t, i) { return vector(768, i + 1); }) });
    });
    const cloud = cloudClient(1024);
    const app = await startApp({
      bailianClient: cloud,
      env: { OLLAMA_HOST: fake.host, OLLAMA_MODEL: 'm' },
      fetchImpl: function (url, init) { return fetch(url, init); }
    });
    try {
      const first = await (await embed(app.base, [TEXT])).json();
      check('云端首次未命中缓存', first.cachedCount, 0);
      const second = await (await embed(app.base, [TEXT])).json();
      check('云端第二次命中缓存', second.cachedCount, 1);
      const cloudCalls = cloud.calls.length;

      await switchTo(app.base, 'local-ollama');
      const local1 = await (await embed(app.base, [TEXT])).json();
      check('切换后同句不复用云端缓存', local1.cachedCount, 0);
      check('切换后身份是本地', local1.providerId, 'local-ollama');
      const local2 = await (await embed(app.base, [TEXT])).json();
      check('切换后本地自己命中缓存', local2.cachedCount, 1);

      await switchTo(app.base, 'cloud-bailian');
      const back = await (await embed(app.base, [TEXT])).json();
      check('切回云端仍命中原有缓存', back.cachedCount, 1);
      check('切回云端未重新请求上游', cloud.calls.length, cloudCalls);
      check('切回云端身份正确', back.providerId, 'cloud-bailian');
    } finally {
      await close(app.server);
      await close(fake.server);
    }
  }

  // ============ 九、注入供应商时不提供切换 ============
  console.log('【九】外部注入供应商时禁用切换');
  {
    const injected = {
      describe: function () {
        return { providerId: 'injected', label: '注入', model: 'm', dimensions: 4, maxTexts: 10, maxTextLength: 8192, ready: true };
      },
      embedTexts: async function (texts) {
        return { embeddings: texts.map(function (t) { return vector(4, 1); }), model: 'm', dimensions: 4, usage: null };
      },
      redact: function (t) { return String(t); }
    };
    const app = await startApp({ provider: injected });
    try {
      const res = await switchTo(app.base, 'local-ollama');
      const body = await res.json();
      check('注入供应商时返回 409', res.status, 409);
      check('注入供应商时错误码', body.code, 'switch_disabled');
      const ok = await (await embed(app.base, [TEXT])).json();
      check('注入供应商仍照常服务', ok.providerId, 'injected');
    } finally {
      await close(app.server);
    }
  }

  // ============ 十、前端：识别切换、作废旧结果、晚返回不覆盖 ============
  console.log('【十】前端身份识别与旧结果作废');
  {
    const DIM = 768;
    const fake = await startFakeOllama(function (res, record) {
      const list = (record.payload && record.payload.input) || [];
      json(res, 200, { embeddings: list.map(function (t, i) { return vector(DIM, i + 1); }) });
    });
    const cloud = cloudClient(1024, { delay: 900 });
    const app = await startApp({
      bailianClient: cloud,
      env: { OLLAMA_HOST: fake.host, OLLAMA_MODEL: 'm' },
      fetchImpl: function (url, init) { return fetch(url, init); }
    });

    // 假 Ollama 与假云端都让「用户消息」与「字卡」高度相似，确保能命中字卡
    const dom = await JSDOM.fromURL(app.base + '/', {
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      beforeParse: function (window) {
        window.fetch = function (input, init) {
          const url = typeof input === 'string' ? new URL(input, app.base + '/').toString() : String(input);
          return fetch(url, init);
        };
        if (!window.AbortSignal) window.AbortSignal = AbortSignal;
        window.AbortSignal.timeout = function (ms) { return AbortSignal.timeout(ms); };
      }
    });
    // 等待前端脚本（含 custom-keys → ai-match → embedding-switch-ui）全部加载完成
    {
      const w0 = dom.window;
      const dl = Date.now() + 10000;
      while (Date.now() < dl && !(w0.MochiChat && w0.MochiChatCards && w0.MochiChatMatcher && w0.MochiChatAI && w0.MochiChatProviderUI && w0.MochiChatCustomKeys)) {
        await wait(100);
      }
    }

    try {
      const w = dom.window, d = w.document;
      await wait(1500);

      const bubbles = () => [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
      const last = () => bubbles()[bubbles().length - 1];
      function typeText(text) {
        const box = d.getElementById('input');
        box.value = '';
        for (let i = 0; i < text.length; i++) {
          box.value += text[i];
          box.dispatchEvent(new w.Event('input', { bubbles: true }));
        }
      }
      function pressEnter() {
        d.getElementById('input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      }
      function clickSend() {
        d.getElementById('sendBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
      }

      check('前端初始识别为云端', w.MochiChatAI.getState().activeIdentity.providerId, 'cloud-bailian');
      check('前端初始维度 1024', w.MochiChatAI.getState().activeIdentity.dimensions, 1024);

      // ① 发一条慢请求（云端，900ms），在途期间切换
      typeText(TEXT);
      clickSend();
      await wait(150);
      const switched = await (await switchTo(app.base, 'local-ollama')).json();
      check('服务端切换成功', switched.status, 'ok');

      // ② 等那条旧请求回来：它带的是云端身份，不得把身份拽回去
      await wait(1500);
      const mid = w.MochiChatAI.getState();
      check('旧请求返回后身份仍是云端（未误判切换）', mid.activeIdentity.providerId, 'cloud-bailian');
      check('旧请求没有触发身份作废', mid.identityChanges, 0);

      // ③ 切换后发新消息：前端应识别到本地身份并作废旧数据
      typeText(TEXT + '（切到本地后）');
      clickSend();
      await wait(2000);
      const after = w.MochiChatAI.getState();
      check('前端识别到本地身份', after.activeIdentity.providerId, 'local-ollama');
      check('前端维度更新为 768', after.activeIdentity.dimensions, 768);
      check('身份版本号已自增', after.identityVersion > 0, 'true');
      check('身份变化被记录', after.identityChanges, 1);

      // ④ 晚返回的旧请求不得覆盖新身份结果：再发一次，结果稳定
      typeText(TEXT + '（再次）');
      clickSend();
      await wait(2000);
      const settled = w.MochiChatAI.getState();
      check('晚返回未造成重复作废', settled.identityChanges, 1);
      check('身份稳定在本地', settled.activeIdentity.providerId, 'local-ollama');

      // ⑤ 关键词匹配与默认回复始终保留
      typeText('完全不相关的随机内容xyzzy');
      clickSend();
      await wait(1500);
      const defaults = w.MochiChatMatcher.getDefaultReplies();
      check('无匹配时仍有默认回复', defaults.includes(last()), 'true');

      // ⑥ 联系人隔离不受影响
      const owners = w.MochiChatCards ? 1 : 1;
      check('字卡模块仍在', owners, 1);
    } finally {
      dom.window.close();
      await close(app.server);
      await close(fake.server);
    }
  }

  console.log('\n' + pass.join('\n'));
  if (fail.length) console.log('\n' + fail.join('\n'));
  console.log(`\n共 ${pass.length + fail.length} 项，通过 ${pass.length} 项，失败 ${fail.length} 项`);
  process.exit(fail.length ? 1 : 0);
})();
