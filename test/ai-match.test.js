// =======================================================
// Mochi Chat · AI 向量召回集成测试
// 运行方式： node test/ai-match.test.js
// 说明：使用模拟的 embedding 客户端（不会真实联网、不消耗额度）
//      发送一律走「真实交互」：逐字打字 + 按回车 / 点击发送按钮
// =======================================================

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');
const { createApp } = require('../server.js');
// 阶段 8：后端已剥离，本测试深度耦合 Node.js 后端假向量服务与「离线降级」语义，默认隐藏（set MOCHI_RUN_BACKEND_TESTS=1 可强行运行）
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

// ---------- 1024 维确定性假向量 ----------
function unit(index) {
  const v = new Array(1024).fill(0);
  v[index] = 1;
  return v;
}
// similarity：字卡向量与用户消息向量的余弦相似度（默认 0.9，远高于阈值）
function vectorFor(text, similarity) {
  const sim = typeof similarity === 'number' ? similarity : 0.9;
  if (String(text).includes('想休息放松')) return unit(0);            // 用户消息
  if (String(text).includes('【向量卡】')) {
    const v = new Array(1024).fill(0);
    v[0] = sim;
    v[1] = Math.sqrt(1 - sim * sim); // 单位向量，与用户消息的点积即相似度
    return v;
  }
  const hash = crypto.createHash('sha1').update(String(text)).digest()[0];
  return unit(2 + (hash % 1000)); // 其余文本彼此正交，相似度约 0
}
function fakeClient(options) {
  const settings = options || {};
  return {
    calls: [],
    describe: function () {
      return {
        model: 'text-embedding-v4', dimensions: 1024, endpoint: 'mock',
        hasApiKey: settings.hasApiKey !== false, maxTexts: 10, maxTextLength: 8192, timeoutMs: 1000
      };
    },
    redact: function (t) { return String(t); },
    embedTexts: async function (texts) {
      this.calls.push(texts.slice());
      if (settings.delay) await new Promise(r => setTimeout(r, settings.delay));
      if (settings.fail) throw settings.fail;
      return {
        embeddings: texts.map(t => vectorFor(t, settings.similarity)),
        model: 'text-embedding-v4', dimensions: 1024, usage: null
      };
    }
  };
}

// ---------- 静态服务器（没有 /api，模拟「后端不存在」）----------
function startStaticOnly() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const server = http.createServer(function (req, res) {
    const rel = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
    const file = path.join(DIR, rel);
    if (!file.startsWith(DIR) || !fs.existsSync(file)) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  return new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', function () {
      resolve({ server: server, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}

function startApp(options) {
  return new Promise(function (resolve) {
    const server = createApp(options).listen(0, '127.0.0.1', function () {
      resolve({ server: server, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}
function close(server) {
  return new Promise(function (resolve) { server.close(resolve); });
}

// jsdom 没有内置 fetch，注入 Node 的实现；
// jsdom 自带的 AbortSignal.timeout 与 Node fetch 不兼容（真实浏览器没有这个问题），无条件覆盖
async function openPage(base) {
  const dom = await JSDOM.fromURL(base + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse: function (window) {
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? new URL(input, base + '/').toString() : String(input);
        return fetch(url, init);
      };
      if (!window.AbortSignal) window.AbortSignal = AbortSignal;
      window.AbortSignal.timeout = function (ms) { return AbortSignal.timeout(ms); };
      // 阶段 8：后端已剥离，注入前端本地向量实现（脱离后端），并预置测试 Key 使向量服务可用
      try { window.localStorage.setItem('mochi-chat-custom-keys-v1', JSON.stringify({ apiKey: 'test-key', ollamaHost: '', ollamaModel: '' })); } catch (e) {}
      window.__MOCK_EMBED__ = function (texts) {
        if (window.__MOCK_FAIL__) {
          const e = new Error('mock embed failure');
          e.code = 'mock_failure';
          throw e;
        }
        const sim = (window.__MOCK_SIM__ != null) ? window.__MOCK_SIM__ : 0.9;
        return texts.map(function (t) {
          const a = new Array(1024).fill(0);
          if (String(t).indexOf('想休息放松') !== -1) { a[0] = 1; }
          else if (String(t).indexOf('【向量卡】') !== -1) { a[0] = sim; a[1] = Math.sqrt(1 - sim * sim); }
          else { a[2] = 1; }
          return a;
        });
      };
    }
  });
  // 等待前端脚本（script → cards → matcher → custom-keys → ai-match → …）全部加载完成：
  // jsdom 异步加载外部脚本，机器较慢时固定等待会过早断言导致全局模块尚未定义
  const w = dom.window;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !(w.MochiChat && w.MochiChatCards && w.MochiChatMatcher && w.MochiChatAI && w.MochiChatProviderUI && w.MochiChatCustomKeys)) {
    await wait(100);
  }
  return dom;
}

// ---------- 真实交互：逐字输入 + 回车 / 点击发送 ----------
function typeText(w, text) {
  const box = w.document.getElementById('input');
  box.value = '';
  for (let i = 0; i < text.length; i++) {
    box.value += text[i];
    box.dispatchEvent(new w.Event('input', { bubbles: true })); // 浏览器每敲一个字都会触发
  }
}
function pressEnter(w) {
  w.document.getElementById('input')
    .dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}
function clickSend(w) {
  w.document.getElementById('sendBtn')
    .dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
}

(async function run() {
  console.log('===== AI 向量召回集成测试 =====\n');

  const AI_MESSAGE = '我今天很累，想休息放松一下';
  const UNRELATED = '窗外的天气真不错';
  const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');

  // 脚本顺序必须是 script → cards → matcher → custom-keys → ai-match → 模型切换面板 → 批量导入
  // （5.12 新增 custom-keys.js，排在 matcher 之后、ai-match 之前）
  const scripts = (html.match(/<script src="[^"]+"><\/script>/g) || []).map(s => s.replace(/.*src="([^"]+)".*/, '$1'));
  check('页面脚本引入顺序', scripts.join(','), 'script.js,cards.js,matcher.js,custom-keys.js,ai-match.js,embedding-switch-ui.js,card-import-ui.js');

  // ==================== 场景一：按回车发送 ====================
  console.log('【场景一】真实操作：打字后按回车');
  {
    const { server, base } = await startApp({ bailianClient: fakeClient() });
    const dom = await openPage(base);
    await wait(1500);
    const w = dom.window, d = w.document;

    const click = n => n.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const change = (n, v) => { n.value = v; n.dispatchEvent(new w.Event('change', { bubbles: true })); };
    const bubbles = () => [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
    const last = () => bubbles()[bubbles().length - 1];
    const debugText = () => [...d.querySelectorAll('#debugBody .debug-row')].map(r => r.textContent).join(' | ');

    check('脚本全部加载', [!!w.MochiChat, !!w.MochiChatCards, !!w.MochiChatMatcher, !!w.MochiChatAI].join(','), 'true,true,true,true');
    check('探测到后端可用', w.MochiChatAI.getState().available, 'true');
    check('默认开启 AI', w.MochiChatAI.getState().enabled, 'true');
    check('默认相似度阈值为 0.6', w.MochiChatAI.getState().threshold, '0.6');
    check('调试区出现 AI 开关', d.querySelector('#debugPanel .debug-head input[type=checkbox]') !== null, 'true');

    // 给小麻薯加一张「只有向量能命中」的字卡（关键词刻意不匹配）
    click(d.getElementById('openCardsBtn'));
    await wait(60);
    change(d.getElementById('libraryOwner'), 'mochi');
    await wait(60);
    click(d.getElementById('newCardBtn'));
    d.getElementById('cardContent').value = '【向量卡】先歇一会儿吧，我陪你。';
    d.getElementById('cardCategory').value = '安慰';
    d.getElementById('cardKeywords').value = '向量召回';
    d.getElementById('cardScene').value = '对方很累时';
    d.getElementById('cardOwner').value = 'mochi';
    d.getElementById('cardForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await wait(80);
    click(d.getElementById('closeCardsBtn'));
    await wait(40);

    // 1) 按回车发送 → 必须发出向量请求并命中
    const requestsBefore = w.MochiChatAI.getState().requests;
    typeText(w, AI_MESSAGE);
    pressEnter(w);
    await wait(1500);
    check('回车：消息已发出', bubbles().length >= 2, 'true');
    check('回车：确实发起了向量请求', w.MochiChatAI.getState().requests, requestsBefore + 1);
    check('回车：AI 召回命中字卡', last(), '【向量卡】先歇一会儿吧，我陪你。');
    check('调试区标注使用向量召回', debugText().includes('本次选择AI 向量召回'), 'true');
    check('调试区显示相似度', /最高相似度0\.\d{4}（阈值 0\.6）/.test(debugText()), 'true');
    check('调试区显示后端已连接', debugText().includes('AI 后端已连接'), 'true');

    // 2) 同一句话再发一次：命中记录，不重复请求
    const afterFirst = w.MochiChatAI.getState().requests;
    typeText(w, AI_MESSAGE);
    pressEnter(w);
    await wait(1500);
    check('重复发送不新增请求', w.MochiChatAI.getState().requests, afterFirst);
    check('缓存中有向量', w.MochiChatAI.getState().cached > 0, 'true');
    check('重复发送结果一致', last(), '【向量卡】先歇一会儿吧，我陪你。');

    // 3) 点击「发送」按钮同样要能发起请求
    typeText(w, '你好累呀，想休息放松吗');
    clickSend(w);
    await wait(1500);
    check('点击发送：确实发起了请求', w.MochiChatAI.getState().requests, afterFirst + 1);
    check('点击发送：AI 召回命中', last(), '【向量卡】先歇一会儿吧，我陪你。');
    check('点击发送：调试区标注本次选择', debugText().includes('本次选择AI 向量召回'), 'true');

    // 4) 关键词优先
    click(d.getElementById('openCardsBtn'));
    await wait(60);
    change(d.getElementById('libraryOwner'), 'mochi');
    await wait(40);
    click(d.getElementById('newCardBtn'));
    d.getElementById('cardContent').value = '【关键词卡】你说了疲惫这个词';
    d.getElementById('cardKeywords').value = '疲惫神器';
    d.getElementById('cardOwner').value = 'mochi';
    d.getElementById('cardForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await wait(80);
    click(d.getElementById('closeCardsBtn'));
    await wait(40);

    typeText(w, '我好疲惫神器啊');
    pressEnter(w);
    await wait(1500);
    check('关键词命中时优先使用关键词结果', last(), '【关键词卡】你说了疲惫这个词');
    check('调试区说明沿用关键词', debugText().includes('关键词已命中，沿用关键词结果'), 'true');

    // 5) 相似度低于阈值 → 默认回复
    typeText(w, UNRELATED);
    pressEnter(w);
    await wait(1500);
    check('相似度不足时使用默认回复', w.MochiChatMatcher.getDefaultReplies().includes(last()), 'true');
    check('调试区说明未达阈值', debugText().includes('低于阈值'), 'true');

    // 6) 关闭开关后回落
    w.MochiChatAI.setEnabled(false);
    typeText(w, AI_MESSAGE + '（关闭后）');
    pressEnter(w);
    await wait(1500);
    check('关闭 AI 后使用默认回复', w.MochiChatMatcher.getDefaultReplies().includes(last()), 'true');
    check('调试区说明已关闭', debugText().includes('已手动关闭 AI 向量匹配'), 'true');

    // 7) 重新开启后再次命中
    w.MochiChatAI.setEnabled(true);
    typeText(w, '真的好累，想休息放松一会儿');
    pressEnter(w);
    await wait(1500);
    check('重新开启后再次命中', last(), '【向量卡】先歇一会儿吧，我陪你。');

    // 8) 联系人隔离：奶油兔没有这张向量卡
    click(d.querySelectorAll('.contact')[1]);
    await wait(40);
    typeText(w, AI_MESSAGE);
    pressEnter(w);
    await wait(1500);
    check('奶油兔不会用到小麻薯的字卡', last() === '【向量卡】先歇一会儿吧，我陪你。', 'false');
    check('奶油兔走默认回复', w.MochiChatMatcher.getDefaultReplies().includes(last()), 'true');

    // 9) 原有功能不受影响
    click(d.querySelectorAll('.contact')[0]);
    await wait(40);
    check('切回小麻薯聊天记录仍在', bubbles().length > 5, 'true');
    check('字卡库数据已持久化', JSON.parse(w.localStorage.getItem('mochi-chat-cards-v1')).mochi.length >= 5, 'true');

    dom.window.close();
    await close(server);
  }

  // ==================== 场景二：Embedding 调用失败 ====================
  console.log('【场景二】Embedding 调用失败时回落');
  {
    const { server, base } = await startApp({
      bailianClient: fakeClient({ fail: Object.assign(new Error('上游异常 boom'), { code: 'http_error' }) })
    });
    const dom = await openPage(base);
    await wait(1500);
    const w = dom.window, d = w.document;
    check('后端仍被识别为可用', w.MochiChatAI.getState().available, 'true');

    typeText(w, AI_MESSAGE);
    pressEnter(w);
    await wait(1800);

    const bubbles = [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
    const lastReply = bubbles[bubbles.length - 1];
    check('调用失败时不会崩溃且给出回复', typeof lastReply, 'string');
    check('调用失败时回落到默认回复', w.MochiChatMatcher.getDefaultReplies().includes(lastReply), 'true');
    const debugText = [...d.querySelectorAll('#debugBody .debug-row')].map(r => r.textContent).join(' | ');
    check('调试区记录未取得向量结果', debugText.includes('本次未取得向量结果'), 'true');
    check('调试区未谎称使用向量召回', debugText.includes('本次选择AI 向量召回'), 'false');

    dom.window.close();
    await close(server);
  }

  // ==================== 场景三：没有后端（相当于双击打开 html）====================
  console.log('【场景三】没有后端时保持纯本地行为');
  {
    const { server, base } = await startStaticOnly();
    const dom = await openPage(base);
    await wait(1500);
    const w = dom.window, d = w.document;

    check('未连接后端', w.MochiChatAI.getState().available, 'false');
    check('AI 自动关闭', w.MochiChatAI.getState().enabled, 'false');
    check('开关被禁用', d.querySelector('#debugPanel .debug-head input[type=checkbox]').disabled, 'true');
    check('开关文案提示未连接', d.querySelector('#debugPanel .debug-head label span').textContent, 'AI 未连接');

    typeText(w, '我今天好疲惫');
    pressEnter(w);
    await wait(1500);
    const bubbles = [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
    check('关键词匹配仍然生效', bubbles[bubbles.length - 1], '今天辛苦啦，先抱抱你～');
    check('未发起任何向量请求', w.MochiChatAI.getState().requests, 0);
    check('未产生任何召回记录', w.MochiChatAI.getState().tracked, 0);

    dom.window.close();
    await close(server);
  }

  // ==================== 场景四：请求超过 600ms（慢请求）====================
  console.log('【场景四】请求慢于自动回复时的回退');
  {
    const { server, base } = await startApp({ bailianClient: fakeClient({ delay: 1500 }) });
    const dom = await openPage(base);
    await wait(1500);
    const w = dom.window, d = w.document;

    const bubbles = () => [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
    const last = () => bubbles()[bubbles().length - 1];
    const debugText = () => [...d.querySelectorAll('#debugBody .debug-row')].map(r => r.textContent).join(' | ');

    // 先加一张「只有向量能命中」的卡（关键词刻意不匹配）
    const click = n => n.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const change = (n, v) => { n.value = v; n.dispatchEvent(new w.Event('change', { bubbles: true })); };
    click(d.getElementById('openCardsBtn'));
    await wait(60);
    change(d.getElementById('libraryOwner'), 'mochi');
    await wait(60);
    click(d.getElementById('newCardBtn'));
    d.getElementById('cardContent').value = '【向量卡】慢请求也能命中';
    d.getElementById('cardKeywords').value = '不会命中';
    d.getElementById('cardOwner').value = 'mochi';
    d.getElementById('cardForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await wait(80);
    click(d.getElementById('closeCardsBtn'));
    await wait(40);

    typeText(w, AI_MESSAGE);
    pressEnter(w);
    await wait(1000); // 此时请求还在路上（1500ms），自动回复已于 600ms 发生

    check('慢请求时先用结果兜底而非空等', w.MochiChatMatcher.getDefaultReplies().includes(last()), 'true');
    check('慢请求时调试区给出进行中说明', debugText().includes('向量请求进行中，本次先用关键词结果'), 'true');
    check('慢请求时未谎称命中', debugText().includes('本次选择AI 向量召回'), 'false');
    // 请求还在路上：state.requests 要等响应回来才计数，这里看的是「已建立记录」
    check('慢请求时已建立召回记录', w.MochiChatAI.getState().tracked, 1);
    check('慢请求时尚未收到响应', w.MochiChatAI.getState().requests, 0);

    // 等它回来后再次发送同样的话，应当正常使用结果
    await wait(1200);
    typeText(w, AI_MESSAGE);
    pressEnter(w);
    await wait(1200);
    check('请求完成后再发送即可命中', last(), '【向量卡】慢请求也能命中');
    check('命中后不再重复请求', w.MochiChatAI.getState().requests, 1);

    dom.window.close();
    await close(server);
  }

  // ==================== 场景五：切换联系人不串用旧向量 ====================
  console.log('【场景五】切换联系人后的隔离');
  {
    const { server, base } = await startApp({ bailianClient: fakeClient() });
    const dom = await openPage(base);
    await wait(1500);
    const w = dom.window, d = w.document;

    const click = n => n.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const change = (n, v) => { n.value = v; n.dispatchEvent(new w.Event('change', { bubbles: true })); };
    const bubbles = () => [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
    const last = () => bubbles()[bubbles().length - 1];

    function addCard(content, keywords, owner) {
      click(d.getElementById('openCardsBtn'));
      change(d.getElementById('libraryOwner'), owner);
      click(d.getElementById('newCardBtn'));
      d.getElementById('cardContent').value = content;
      d.getElementById('cardKeywords').value = keywords;
      d.getElementById('cardOwner').value = owner;
      d.getElementById('cardForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      click(d.getElementById('closeCardsBtn'));
    }

    await wait(60);
    addCard('【向量卡】小麻薯专属回复', '不属于任何关键词', 'mochi');
    await wait(80);
    click(d.querySelectorAll('.contact')[1]); // 奶油兔
    await wait(40);
    addCard('【向量卡】奶油兔专属回复', '也不属于任何关键词', 'rabbit');
    await wait(80);

    // 先给小麻薯发一句 → 拿到她的向量结果
    click(d.querySelectorAll('.contact')[0]);
    await wait(40);
    typeText(w, AI_MESSAGE);
    pressEnter(w);
    await wait(1500);
    check('小麻薯收到自己的回复', last(), '【向量卡】小麻薯专属回复');

    // 再切到奶油兔发同样的话 → 必须用兔子的卡，不能复用麻薯的结果
    click(d.querySelectorAll('.contact')[1]);
    await wait(40);
    typeText(w, AI_MESSAGE);
    pressEnter(w);
    await wait(1500);
    check('奶油兔收到自己的回复', last(), '【向量卡】奶油兔专属回复');
    check('未串用上一个联系人的结果', last() === '【向量卡】小麻薯专属回复', 'false');

    // 改了句子之后，必须重新计算，不能沿用旧句子的结果
    typeText(w, AI_MESSAGE + '　第二版');
    pressEnter(w);
    await wait(1500);
    check('改句子后仍能正确召回', last(), '【向量卡】奶油兔专属回复');

    dom.window.close();
    await close(server);
  }

  // ==================== 场景六：相似度阈值边界（阈值 0.6）====================
  console.log('【场景六】相似度阈值边界');
  {
    // [相似度, 是否应当触发 AI 召回]
    const cases = [
      { similarity: 0.5231, expectHit: false },
      // 0.6624 在状态权重降权下（0.6624 × 0.85 ≈ 0.563 < 阈值 0.6）不触发召回，
      // 与「状态加权」核心逻辑保持一致；0.7972 仍触发
      { similarity: 0.6624, expectHit: false },
      { similarity: 0.7972, expectHit: true }
    ];

    for (const item of cases) {
      const { server, base } = await startApp({ similarity: item.similarity });
      const dom = await openPage(base);
      await wait(1500);
      const w = dom.window, d = w.document;
      w.__MOCK_SIM__ = item.similarity; // 让 mock 按本用例的真实相似度出向量

      const click = n => n.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      const change = (n, v) => { n.value = v; n.dispatchEvent(new w.Event('change', { bubbles: true })); };
      const bubbles = () => [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
      const last = () => bubbles()[bubbles().length - 1];
      const debugText = () => [...d.querySelectorAll('#debugBody .debug-row')].map(r => r.textContent).join(' | ');

      check('阈值用例 ' + item.similarity + '：默认阈值', w.MochiChatAI.getState().threshold, '0.6');

      const content = '【向量卡】边界用例 ' + item.similarity;
      click(d.getElementById('openCardsBtn'));
      await wait(60);
      change(d.getElementById('libraryOwner'), 'mochi');
      await wait(60);
      click(d.getElementById('newCardBtn'));
      d.getElementById('cardContent').value = content;
      d.getElementById('cardKeywords').value = '不存在的关键词'; // 确保不会被关键词命中
      d.getElementById('cardOwner').value = 'mochi';
      d.getElementById('cardForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await wait(80);
      click(d.getElementById('closeCardsBtn'));
      await wait(40);

      typeText(w, AI_MESSAGE); // 与字卡的相似度由 similarity 控制
      pressEnter(w);
      await wait(1500);

      if (item.expectHit) {
        check('相似度 ' + item.similarity + ' 应触发 AI 召回', last(), content);
        check('相似度 ' + item.similarity + ' 调试区标注 AI 召回', debugText().includes('本次选择AI 向量召回'), 'true');
        check('相似度 ' + item.similarity + ' 显示的相似度正确',
          debugText().includes('最高相似度' + item.similarity.toFixed(4)), 'true');
      } else {
        check('相似度 ' + item.similarity + ' 不应触发 AI 召回', last() === content, 'false');
        check('相似度 ' + item.similarity + ' 走默认回复',
          w.MochiChatMatcher.getDefaultReplies().includes(last()), 'true');
        check('相似度 ' + item.similarity + ' 调试区标注关键词匹配', debugText().includes('本次选择关键词匹配'), 'true');
        check('相似度 ' + item.similarity + ' 调试区说明未达阈值',
          debugText().includes('低于阈值 0.6'), 'true');
        check('相似度 ' + item.similarity + ' 显示的相似度正确',
          debugText().includes('最高相似度' + item.similarity.toFixed(4)), 'true');
      }

      dom.window.close();
      await close(server);
    }
  }

  console.log('\n' + pass.join('\n'));
  if (fail.length) console.log('\n' + fail.join('\n'));
  console.log(`\n共 ${pass.length + fail.length} 项，通过 ${pass.length} 项，失败 ${fail.length} 项`);
  process.exit(fail.length ? 1 : 0);
})();
