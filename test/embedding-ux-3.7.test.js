// =======================================================
// Mochi Chat · 阶段 3.7 稳定性与体验测试
// 运行方式： node test/embedding-ux-3.7.test.js
//
// 用 jsdom 打开真实页面 + 真实服务端（假 Ollama / 假百炼客户端）：
// 不联网、不需要密钥、不安装 Ollama。
//
// 覆盖：切换后首次聊天、切换期间输入框受控、超时与 503 的静默回退、
//      本地宕机时的友好中文提示、联系人隔离、关闭 AI 后关键词仍可用、
//      窄屏样式规则存在性。
// =======================================================

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { JSDOM } = require('jsdom');
const { createApp } = require('../server.js');
// 阶段 8：后端已剥离，本测试依赖 Node.js 后端 / 专属假 Ollama 服务，默认隐藏（set MOCHI_RUN_BACKEND_TESTS=1 可强行运行）
if (process.env.MOCHI_RUN_BACKEND_TESTS !== '1') {
  console.log('（跳过）' + __filename.split(/[\\/]/).pop() + '：依赖已废弃的 Node.js 后端，已隐藏。');
  return;
}

const DIR = path.join(__dirname, '..');
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
function typeText(w, d, text) {
  const box = d.getElementById('input');
  box.value = '';
  for (let i = 0; i < text.length; i++) {
    box.value += text[i];
    box.dispatchEvent(new w.Event('input', { bubbles: true }));
  }
}
function clickSend(w, d) {
  d.getElementById('sendBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
}
function lastBubble(d) {
  const list = [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
  return list[list.length - 1];
}

(async function run() {
  console.log('===== 阶段 3.7 稳定性与体验测试 =====\n');

  const TEXT = '我今天很累，想休息放松一下';

  // ============ 一、切换后第一次聊天 ============
  console.log('【一】切换后首次聊天');
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
    const dom = await openPage(app);
    try {
      const w = dom.window, d = w.document;
      await wait(1200);

      // 先发一条，产生云端身份下的缓存与召回结果
      typeText(w, d, TEXT);
      clickSend(w, d);
      await wait(1800);
      const before = w.MochiChatAI.getState();
      check('切换前是云端身份', before.activeIdentity.providerId, 'cloud-bailian');
      check('切换前已有缓存', before.cached > 0, 'true');
      const cloudCallsBefore = cloud.calls.length;

      // 打开面板读取清单后切到本地（真实入口也是先读清单再切）
      w.MochiChatProviderUI.open();
      await wait(1000);
      await w.MochiChatProviderUI.switchTo('local-ollama');
      await wait(300);
      const afterSwitch = w.MochiChatAI.getState();
      check('切换后身份为本地', afterSwitch.activeIdentity.providerId, 'local-ollama');
      check('切换后旧缓存已作废', afterSwitch.cached, 0);
      check('切换只作废一次', afterSwitch.identityChanges, 1);

      // 切换后第一次聊天：应当顺畅，且只按新身份请求一次
      const localCallsBefore = fake.records.length;
      typeText(w, d, TEXT + '，可以抱抱我吗');
      clickSend(w, d);
      await wait(2000);

      const settled = w.MochiChatAI.getState();
      check('首次聊天后身份仍是本地', settled.activeIdentity.providerId, 'local-ollama');
      check('首次聊天维度为 768', settled.activeIdentity.dimensions, 768);
      check('身份未被重复作废', settled.identityChanges, 1);
      check('首次聊天确实发了请求', fake.records.length > localCallsBefore, 'true');
      check('切换后不再调用云端', cloud.calls.length, cloudCallsBefore);
      // 字卡较多时会按 10 条一批分块，因此只要求次数合理、没有成倍重复
      const localCalls = fake.records.length - localCallsBefore;
      check('本地请求次数合理（无重复轰炸）', localCalls >= 1 && localCalls <= 4, 'true');
      const reply = lastBubble(d);
      check('首次聊天有回复', typeof reply, 'string');
      check('回复不是错误文案', /失败|异常|错误/.test(reply), 'false');
      const debug = [...d.querySelectorAll('#debugBody .debug-row')].map(r => r.textContent).join(' | ');
      check('调试区未谎称失败', debug.includes('本次未取得向量结果'), 'false');
    } finally {
      dom.window.close();
      await close(app.server);
      await close(fake.server);
    }
  }

  // ============ 二、切换期间输入框受控 ============
  console.log('【二】切换期间输入框受控');
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

      const input = d.getElementById('input');
      const send = d.getElementById('sendBtn');
      check('切换前输入框可用', input.disabled, 'false');
      check('切换前发送按钮可用', send.disabled, 'false');

      const promise = w.MochiChatProviderUI.switchTo('local-ollama');
      // 切换进行中：输入框与发送按钮都被锁住
      check('切换中输入框被禁用', input.disabled, 'true');
      check('切换中发送按钮被禁用', send.disabled, 'true');
      check('切换中提示「正在切换模型」', input.placeholder, '正在切换模型…');
      check('切换中 composer 有标记', d.getElementById('composer').className.includes('is-switching'), 'true');
      check('面板状态为 switching', w.MochiChatProviderUI.getState().composerLocked, 'true');

      await promise;
      await wait(200);
      check('切换完成后输入框恢复', input.disabled, 'false');
      check('切换完成后发送按钮恢复', send.disabled, 'false');
      check('切换完成后 placeholder 复原', input.placeholder.includes('说点什么'), 'true');
      check('切换完成后移除标记', d.getElementById('composer').className.includes('is-switching'), 'false');
      check('面板状态已解锁', w.MochiChatProviderUI.getState().composerLocked, 'false');

      // 切换失败也必须解锁，且不改变当前供应商
      const beforeFail = w.MochiChatProviderUI.getState().currentProviderId;
      const failPromise = w.MochiChatProviderUI.switchTo('no-such-provider');
      await failPromise;
      await wait(200);
      check('切换失败后输入框恢复', input.disabled, 'false');
      check('切换失败后仍可发送', send.disabled, 'false');
      check('切换失败后供应商未变',
        w.MochiChatProviderUI.getState().currentProviderId, beforeFail);
    } finally {
      dom.window.close();
      await close(app.server);
      await close(fake.server);
    }
  }

  // ============ 三、503 / 超时：静默回退到关键词 ============
  console.log('【三】向量服务不可用时静默回退');
  {
    // 云端客户端直接抛错，模拟「服务不可用 / 超时」
    const broken = {
      describe: function () {
        return {
          model: 'text-embedding-v4', dimensions: 1024, endpoint: 'mock',
          hasApiKey: true, maxTexts: 10, maxTextLength: 8192, timeoutMs: 1000
        };
      },
      embedTexts: async function () {
        const error = new Error('本地 Ollama 服务已断开');
        error.code = 'local_unavailable';
        throw error;
      },
      redact: function (t) { return String(t); }
    };
    const app = await startApp({ bailianClient: broken });
    const dom = await openPage(app);
    try {
      const w = dom.window, d = w.document;
      await wait(1200);
      check('后端被识别为可用', w.MochiChatAI.getState().available, 'true');

      typeText(w, d, TEXT);
      clickSend(w, d);
      await wait(2000);

      const reply = lastBubble(d);
      check('失败时聊天不卡死且给出回复', typeof reply, 'string');
      check('失败时回落到关键词/默认回复', w.MochiChatMatcher.getDefaultReplies().includes(reply), 'true');

      const state = w.MochiChatAI.getState();
      check('失败被记为一次提示', typeof state.lastError, 'string');
      check('提示是友好中文而非错误码',
        state.lastError.includes('本地 Ollama') && state.lastError.includes('回退'), 'true');
      check('提示里没有生涩的 code 字段', /local_unavailable/.test(state.lastError), 'false');

      const debug = [...d.querySelectorAll('#debugBody .debug-row')].map(r => r.textContent).join(' | ');
      check('调试区保留原有文案', debug.includes('本次未取得向量结果'), 'true');
      check('调试区给出友好原因', debug.includes('本地 Ollama 服务已断开'), 'true');
      check('调试区未谎称使用向量召回', debug.includes('本次选择AI 向量召回'), 'false');

      const toast = d.getElementById('toast');
      check('页面给出气泡提示', toast.hidden, 'false');
      check('气泡提示是友好中文', toast.textContent.includes('回退'), 'true');

      // 还能继续聊天：再发一条
      typeText(w, d, '完全不相关的随机内容 xyzzy');
      clickSend(w, d);
      await wait(1200);
      check('故障后仍能继续聊天', w.MochiChatMatcher.getDefaultReplies().includes(lastBubble(d)), 'true');
    } finally {
      dom.window.close();
      await close(app.server);
    }
  }

  // ============ 四、本地服务中途宕机：切换成功后请求失败 ============
  console.log('【四】切换成功后本地宕机');
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
      // 先切到本地（此时 Ollama 活着）
      w.MochiChatProviderUI.open();
      await wait(1000);
      const ok = await w.MochiChatProviderUI.switchTo('local-ollama');
      check('切换到本地成功', ok, 'true');
      await wait(300);
      w.MochiChatProviderUI.close();

      // 切换成功之后把本地服务关掉：这正是 3.5 提到的「5 分钟就绪缓存」盲区
      await close(fake.server);
      await wait(200);

      typeText(w, d, TEXT);
      clickSend(w, d);
      await wait(2500);

      const reply = lastBubble(d);
      check('本地宕机后聊天不卡死', typeof reply, 'string');
      check('本地宕机后回落到关键词/默认', w.MochiChatMatcher.getDefaultReplies().includes(reply), 'true');
      const state = w.MochiChatAI.getState();
      check('给出本地断开的友好提示',
        String(state.lastError).includes('本地 Ollama') && String(state.lastError).includes('回退'), 'true');
      check('身份仍是本地（不谎报切回云端）', state.activeIdentity.providerId, 'local-ollama');
    } finally {
      dom.window.close();
      await close(app.server);
    }
  }

  // ============ 五、联系人隔离与关键词兜底 ============
  console.log('【五】联系人隔离与关键词兜底');
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

      // 发给第一个联系人
      typeText(w, d, TEXT);
      clickSend(w, d);
      await wait(1800);
      const firstContact = w.MochiChat.getCurrentContact();
      const trackedAfterFirst = w.MochiChatAI.getState().tracked;

      // 切到另一个联系人，发同样的句子
      const others = w.MochiChat.getContacts ? w.MochiChat.getContacts() : null;
      const next = others ? others.find(function (c) { return c.id !== firstContact.id; }) : null;
      if (next) {
        d.querySelectorAll('#contactList li')[others.indexOf(next)]
          .dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
        await wait(300);
        typeText(w, d, TEXT);
        clickSend(w, d);
        await wait(1800);
        check('切换联系人后当前联系人已变', w.MochiChat.getCurrentContact().id, next.id);
        check('不同联系人各自独立记录', w.MochiChatAI.getState().tracked > trackedAfterFirst, 'true');
        const bubbles = [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
        check('第二个联系人也有回复', bubbles.length >= 2, 'true');
      } else {
        check('至少有两个联系人', false, 'true');
      }

      // 关闭 AI 匹配：关键词仍要工作
      w.MochiChatAI.setEnabled(false);
      check('已关闭 AI 匹配', w.MochiChatAI.getState().enabled, 'false');
      typeText(w, d, '完全不相关的随机内容 zzqqxx');
      clickSend(w, d);
      await wait(1200);
      check('关闭 AI 后仍有回复', w.MochiChatMatcher.getDefaultReplies().includes(lastBubble(d)), 'true');
      const debug = [...d.querySelectorAll('#debugBody .debug-row')].map(r => r.textContent).join(' | ');
      check('关闭 AI 后说明为已手动关闭', debug.includes('已手动关闭'), 'true');
      check('字卡模块仍在', typeof w.MochiChatCards, 'object');
    } finally {
      dom.window.close();
      await close(app.server);
      await close(fake.server);
    }
  }

  // ============ 六、窄屏适配（静态规则检查）============
  console.log('【六】窄屏适配');
  {
    const css = fs.readFileSync(path.join(DIR, 'style.css'), 'utf8');
    const mediaBlocks = css.match(/@media[^{]+\{[\s\S]*?\n\}/g) || [];
    const narrow = mediaBlocks.filter(function (block) {
      return /max-width:\s*(720|480)px/.test(block);
    });
    const relevant = narrow.filter(function (block) {
      return block.indexOf('.provider-panel') >= 0 || block.indexOf('.modal-actions') >= 0;
    });
    check('存在窄屏媒体查询', narrow.length > 0, 'true');
    check('窄屏规则覆盖模型面板', relevant.length > 0, 'true');
    check('窄屏下面板宽度受限', /\.provider-panel[\s\S]{0,120}max-width:\s*100%/.test(relevant.join('\n')), 'true');
    check('窄屏下按钮可换行', relevant.join('\n').includes('flex-wrap: wrap'), 'true');

    const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
    check('切换面板在页面中存在', html.includes('id="providerModal"'), 'true');
    check('切换面板有滚动容器', css.indexOf('.modal-panel') >= 0 && css.includes('overflow-y: auto'), 'true');
  }

  console.log('\n' + pass.join('\n'));
  if (fail.length) console.log('\n' + fail.join('\n'));
  console.log(`\n共 ${pass.length + fail.length} 项，通过 ${pass.length} 项，失败 ${fail.length} 项`);
  process.exit(fail.length ? 1 : 0);
})();
