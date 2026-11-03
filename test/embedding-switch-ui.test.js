// =======================================================
// Mochi Chat · 前端模型切换面板测试（双模型改造 · 阶段 3.5）
// 运行方式： node test/embedding-switch-ui.test.js
//
// 用 jsdom 打开真实页面 + 真实服务端（假 Ollama / 假百炼客户端）：
// 不联网、不需要密钥、不安装 Ollama。
//
// 覆盖：状态显示、检查中/切换中/失败原因、切换成功后续请求换人、
//      切换失败保留原 Provider、身份失效复用既有机制、关键词与默认回复不受影响。
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
function cloudClient(dimensions) {
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
      return {
        embeddings: texts.map(function (t, i) { return vector(dimensions, i + 1); }),
        model: 'text-embedding-v4', dimensions: dimensions, usage: null
      };
    },
    redact: function (t) { return String(t); }
  };
}

// 打开页面：让相对路径的 fetch 打到测试服务器上
async function openPage(app) {
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
  const w = dom.window;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !(w.MochiChat && w.MochiChatCards && w.MochiChatMatcher && w.MochiChatAI && w.MochiChatProviderUI && w.MochiChatCustomKeys)) {
    await wait(100);
  }
  return dom;
}

(async function run() {
  console.log('===== 前端模型切换面板测试 =====\n');

  const TEXT = '我今天有点累，想被安慰一下';

  // ============ 一、面板读取并显示云端与本地状态 ============
  console.log('【一】状态显示');
  {
    const fake = await startFakeOllama(function (res, record) {
      const list = (record.payload && record.payload.input) || [];
      json(res, 200, { embeddings: list.map(function (t, i) { return vector(768, i + 1); }) });
    });
    const app = await startApp({
      bailianClient: cloudClient(1024),
      env: { OLLAMA_HOST: fake.host, OLLAMA_MODEL: 'qwen3-embedding:0.6b' },
      fetchImpl: function (url, init) { return fetch(url, init); }
    });
    const dom = await openPage(app);

    try {
      const w = dom.window, d = w.document;
      await wait(1200);

      check('页面注入了切换面板模块', typeof w.MochiChatProviderUI, 'object');
      check('面板默认关闭', d.getElementById('providerModal').hidden, 'true');

      // 通过侧边栏「模型」按钮打开，验证真实入口而非直接调 API
      d.getElementById('openProviderBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      check('点按钮后弹窗可见', d.getElementById('providerModal').hidden, 'false');
      check('点开后立即进入检查中', w.MochiChatProviderUI.getState().phase, 'checking');
      check('检查中提示可见', d.getElementById('providerMessage').textContent.includes('检查中'), 'true');

      await wait(1200);
      const state = w.MochiChatProviderUI.getState();
      check('检查完成', state.phase, 'idle');
      check('默认当前是云端', state.currentProviderId, 'cloud-bailian');
      check('默认供应商仍是云端', state.defaultProviderId, 'cloud-bailian');
      check('列出两个供应商', state.providers.length, 2);

      const cloud = state.providers.find(function (p) { return p.providerId === 'cloud-bailian'; });
      const local = state.providers.find(function (p) { return p.providerId === 'local-ollama'; });
      check('云端显示为当前', cloud.isCurrent, 'true');
      check('云端显示可用', cloud.usable, 'true');
      check('云端模型名显示正确', cloud.model, 'text-embedding-v4');
      check('云端维度显示 1024', cloud.dimensions, 1024);
      check('本地显示模型名', local.model, 'qwen3-embedding:0.6b');
      check('本地显示真实维度', local.dimensions, 768);
      check('本地显示可用', local.usable, 'true');

      const currentText = d.getElementById('providerCurrent').textContent;
      check('顶部显示当前供应商名称', currentText.includes(cloud.label), 'true');
      check('顶部显示模型名', currentText.includes('text-embedding-v4'), 'true');
      check('顶部显示维度', currentText.includes('1024'), 'true');
      check('顶部标明可用', currentText.includes('可用'), 'true');

      const cards = d.querySelectorAll('#providerList .provider-card');
      check('渲染两张卡片', cards.length, 2);
      check('当前卡片的按钮不可点', cards[0].querySelector('.provider-action').disabled, 'true');
      check('当前卡片按钮文字', cards[0].querySelector('.provider-action').textContent, '正在使用');
      check('另一张卡片按钮可点', cards[1].querySelector('.provider-action').disabled, 'false');

      const html = d.getElementById('providerModal').outerHTML;
      check('面板不含内部地址', html.includes('127.0.0.1'), 'false');
      check('面板不含密钥形态', /sk-[A-Za-z0-9]/.test(html), 'false');
    } finally {
      dom.window.close();
      await close(app.server);
      await close(fake.server);
    }
  }

  // ============ 二、切换成功：状态推进 + 后续请求换人 ============
  console.log('【二】切换成功');
  {
    const fake = await startFakeOllama(function (res, record) {
      const list = (record.payload && record.payload.input) || [];
      json(res, 200, { embeddings: list.map(function (t, i) { return vector(768, i + 1); }) });
    });
    const cloud = cloudClient(1024);
    const app = await startApp({
      bailianClient: cloud,
      env: { OLLAMA_HOST: fake.host, OLLAMA_MODEL: 'qwen3-embedding:0.6b' },
      fetchImpl: function (url, init) { return fetch(url, init); }
    });
    const dom = await openPage(app);

    try {
      const w = dom.window, d = w.document;
      await wait(1200);

      w.MochiChatProviderUI.open();
      await wait(1000);
      check('切换前身份是云端', w.MochiChatAI.getState().activeIdentity.providerId, 'cloud-bailian');
      check('切换前维度 1024', w.MochiChatAI.getState().activeIdentity.dimensions, 1024);

      const localBtn = d.querySelectorAll('#providerList .provider-action')[1];
      localBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      // 点击瞬间应当处于「检查中」
      check('点击后立刻显示检查中',
        d.getElementById('providerMessage').textContent.includes('检查中'), 'true');
      check('切换过程中按钮禁用',
        d.querySelectorAll('#providerList .provider-action')[1].disabled, 'true');

      await wait(1500);
      const after = w.MochiChatProviderUI.getState();
      check('切换完成', after.currentProviderId, 'local-ollama');
      check('成功提示可见', d.getElementById('providerMessage').textContent.includes('已切换到'), 'true');
      check('成功提示带模型名', d.getElementById('providerMessage').textContent.includes('qwen3-embedding'), 'true');
      check('成功提示带维度', d.getElementById('providerMessage').textContent.includes('768'), 'true');

      const ai = w.MochiChatAI.getState();
      check('前端身份切换到本地', ai.activeIdentity.providerId, 'local-ollama');
      check('前端维度更新为 768', ai.activeIdentity.dimensions, 768);
      check('身份变化触发一次作废', ai.identityChanges, 1);
      check('身份版本号自增', ai.identityVersion > 0, 'true');
      check('旧向量缓存已清空', ai.cached, 0);

      // 后续请求真的走本地：发一条消息，调试面板记录本地身份
      const box = d.getElementById('input');
      box.value = TEXT;
      box.dispatchEvent(new w.Event('input', { bubbles: true }));
      d.getElementById('sendBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await wait(1500);

      const bubbles = [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
      check('切换后仍能正常回复', bubbles.length >= 2, 'true');
      check('回复不是错误提示', /失败|错误|异常/.test(bubbles[bubbles.length - 1]), 'false');

      const health = await (await fetch(app.base + '/api/health')).json();
      check('服务端确实已切到本地', health.provider.id, 'local-ollama');
      check('服务端维度为 768', health.embedding.dimensions, 768);
      check('云端请求未再新增', cloud.calls.length, 0);
    } finally {
      dom.window.close();
      await close(app.server);
      await close(fake.server);
    }
  }

  // ============ 三、目标不可用：按钮禁用 + 强制切换失败并保留原 Provider ============
  console.log('【三】目标不可用时保留原 Provider');
  {
    const app = await startApp({
      bailianClient: cloudClient(1024),
      env: { OLLAMA_HOST: 'http://127.0.0.1:1', OLLAMA_MODEL: 'm', OLLAMA_TIMEOUT_MS: '400' },
      fetchImpl: function (url, init) { return fetch(url, init); }
    });
    const dom = await openPage(app);

    try {
      const w = dom.window, d = w.document;
      await wait(1200);

      w.MochiChatProviderUI.open();
      await wait(1500);

      const state = w.MochiChatProviderUI.getState();
      const local = state.providers.find(function (p) { return p.providerId === 'local-ollama'; });
      check('本地显示不可用', local.usable, 'false');
      check('当前仍是云端', state.currentProviderId, 'cloud-bailian');

      const cards = d.querySelectorAll('#providerList .provider-card');
      const localCard = cards[1];
      check('本地卡片按钮禁用', localCard.querySelector('.provider-action').disabled, 'true');
      check('本地卡片按钮文字', localCard.querySelector('.provider-action').textContent, '不可切换');
      check('本地卡片直接给出原因', Boolean(localCard.querySelector('.provider-why')), 'true');
      check('原因里不含内部地址',
        localCard.querySelector('.provider-why').textContent.includes('127.0.0.1'), 'false');

      // 绕过按钮直接调用：应被拦下并说明原因，原 Provider 不变
      const ok = await w.MochiChatProviderUI.switchTo('local-ollama');
      check('强制切换被拒绝', ok, 'false');
      const afterForce = w.MochiChatProviderUI.getState();
      check('拒绝后仍处于错误提示', afterForce.phase, 'error');
      check('提示说明检查未通过',
        d.getElementById('providerMessage').textContent.includes('检查未通过'), 'true');
      check('提示保留当前模型',
        d.getElementById('providerMessage').textContent.includes('保留当前模型'), 'true');
      check('当前供应商未变', afterForce.currentProviderId, 'cloud-bailian');

      const ai = w.MochiChatAI.getState();
      check('前端身份未变', ai.activeIdentity.providerId, 'cloud-bailian');
      check('身份未变则不作废', ai.identityChanges, 0);

      const health = await (await fetch(app.base + '/api/health')).json();
      check('服务端供应商未变', health.provider.id, 'cloud-bailian');
    } finally {
      dom.window.close();
      await close(app.server);
    }
  }

  // ============ 四、切换请求本身失败：显示原因且保留原 Provider ============
  console.log('【四】切换请求失败');
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
    const dom = await openPage(app);

    try {
      const w = dom.window, d = w.document;
      await wait(1200);
      w.MochiChatProviderUI.open();
      await wait(1200);

      // 只让切换接口断掉，其余照常：模拟切换途中网络/服务异常
      const realFetch = w.fetch;
      w.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : String(input);
        if (url.indexOf('/api/embedding/switch') >= 0) {
          return Promise.reject(new Error('network down'));
        }
        return realFetch(input, init);
      };

      const ok = await w.MochiChatProviderUI.switchTo('local-ollama');
      check('切换失败返回 false', ok, 'false');
      const state = w.MochiChatProviderUI.getState();
      check('失败后进入错误状态', state.phase, 'error');
      check('失败错误码明确', state.errorCode, 'switch_failed');
      check('提示说明在切换中失败',
        d.getElementById('providerMessage').textContent.includes('切换中'), 'true');
      check('提示说明已保留当前模型',
        d.getElementById('providerMessage').textContent.includes('保留当前模型'), 'true');
      check('失败后当前仍是云端', state.currentProviderId, 'cloud-bailian');

      w.fetch = realFetch;
      const ai = w.MochiChatAI.getState();
      check('失败后前端身份未变', ai.activeIdentity.providerId, 'cloud-bailian');
      check('失败不触发作废', ai.identityChanges, 0);
    } finally {
      dom.window.close();
      await close(app.server);
      await close(fake.server);
    }
  }

  // ============ 五、切回云端：身份再次变化并作废旧结果 ============
  console.log('【五】切回云端');
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
    const dom = await openPage(app);

    try {
      const w = dom.window, d = w.document;
      await wait(1200);
      w.MochiChatProviderUI.open();
      await wait(1000);

      await w.MochiChatProviderUI.switchTo('local-ollama');
      await wait(300);
      check('先切到本地', w.MochiChatAI.getState().activeIdentity.providerId, 'local-ollama');

      await w.MochiChatProviderUI.switchTo('cloud-bailian');
      await wait(600);
      const ai = w.MochiChatAI.getState();
      check('再切回云端', ai.activeIdentity.providerId, 'cloud-bailian');
      check('维度回到 1024', ai.activeIdentity.dimensions, 1024);
      check('两次切换各作废一次', ai.identityChanges, 2);
      check('旧向量缓存被清空', ai.cached, 0);

      const cards = d.querySelectorAll('#providerList .provider-card');
      check('云端重新成为当前卡片', Boolean(cards[0].className.includes('is-current')), 'true');
    } finally {
      dom.window.close();
      await close(app.server);
      await close(fake.server);
    }
  }

  // ============ 六、关键词匹配与默认回复不受影响 ============
  console.log('【六】关键词匹配与默认回复');
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
    const dom = await openPage(app);

    try {
      const w = dom.window, d = w.document;
      await wait(1200);
      w.MochiChatProviderUI.open();
      await wait(1000);
      await w.MochiChatProviderUI.switchTo('local-ollama');
      await wait(400);
      w.MochiChatProviderUI.close();
      check('关闭后弹窗隐藏', d.getElementById('providerModal').hidden, 'true');

      const box = d.getElementById('input');
      box.value = '完全不相关的随机内容 zzqqxx';
      box.dispatchEvent(new w.Event('input', { bubbles: true }));
      d.getElementById('sendBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await wait(1500);

      const bubbles = [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
      const last = bubbles[bubbles.length - 1];
      const defaults = w.MochiChatMatcher.getDefaultReplies();
      check('无匹配时仍给默认回复', defaults.includes(last), 'true');
      check('字卡模块仍在', typeof w.MochiChatCards, 'object');
      check('联系人列表仍渲染', d.querySelectorAll('#contactList li').length > 0, 'true');
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
