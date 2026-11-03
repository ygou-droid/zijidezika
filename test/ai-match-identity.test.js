// =======================================================
// Mochi Chat · 前端向量缓存身份隔离测试（双模型改造 · 阶段 3.2）
// 运行方式： node test/ai-match-identity.test.js
//
// 覆盖：
//   · 初始身份来自 /api/health
//   · 身份不变时缓存正常复用（不无故清空）
//   · 响应身份变化时，向量缓存与召回结果一律作废
//   · 同一句话在不同 Provider / 模型 / 维度下不会互相命中缓存
//   · 旧请求晚返回时不得污染新身份
//   · 关键词优先、阈值 0.6、点击发送、失败回退等原有行为保持原样
//
// 说明：全部走本地模拟服务端与 jsdom 真实交互，不联网、不安装 Ollama。
// =======================================================

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');
const { createApp } = require('../server.js');
// 阶段 8：后端已剥离，本测试依赖 Node.js 后端的身份 / 切换语义，默认隐藏（set MOCHI_RUN_BACKEND_TESTS=1 可强行运行）
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

// ---------- 可控维度的确定性假向量 ----------
function unit(dimensions, index) {
  const v = new Array(dimensions).fill(0);
  v[index] = 1;
  return v;
}
function vectorFor(text, dimensions, similarity) {
  const sim = typeof similarity === 'number' ? similarity : 0.9;
  if (String(text).includes('想休息放松')) return unit(dimensions, 0); // 用户消息
  if (String(text).includes('【向量卡】')) {
    const v = new Array(dimensions).fill(0);
    v[0] = sim;
    v[1] = Math.sqrt(1 - sim * sim); // 单位向量：与用户消息的点积即相似度
    return v;
  }
  const hash = crypto.createHash('sha1').update(String(text)).digest()[0];
  return unit(dimensions, 2 + (hash % (dimensions - 2))); // 其余文本彼此正交
}

// 身份可变、延迟可控的模拟供应商（直接注入 server，不改动服务端代码）
function switchableProvider(config) {
  return {
    calls: [],
    describe: function () {
      return {
        providerId: config.providerId,
        label: config.providerId,
        model: config.model,
        dimensions: config.dimensions,
        endpoint: 'mock',
        maxTexts: 10,
        maxTextLength: 8192,
        timeoutMs: 5000,
        ready: true,
        hasApiKey: true
      };
    },
    embedTexts: async function (texts) {
      // 关键：快照当前身份与延迟，模拟「请求出发时服务端的样子」
      const snapshot = {
        providerId: config.providerId,
        model: config.model,
        dimensions: config.dimensions,
        delay: config.delay || 0
      };
      this.calls.push({ texts: texts.slice(), identity: snapshot.providerId + '|' + snapshot.model + '|' + snapshot.dimensions });
      if (snapshot.delay) await new Promise(r => setTimeout(r, snapshot.delay));
      if (config.fail) throw config.fail;
      return {
        embeddings: texts.map(t => vectorFor(t, snapshot.dimensions, config.similarity)),
        model: snapshot.model,
        dimensions: snapshot.dimensions,
        usage: null
      };
    },
    redact: function (t) { return String(t); }
  };
}

function identityText(state) {
  const id = state.activeIdentity || {};
  return id.providerId + '|' + id.model + '|' + id.dimensions;
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
    }
  });
  // 等待前端脚本（含 custom-keys → ai-match）全部加载完成，避免固定等待过早断言
  const w = dom.window;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !(w.MochiChat && w.MochiChatCards && w.MochiChatMatcher && w.MochiChatAI && w.MochiChatProviderUI && w.MochiChatCustomKeys)) {
    await wait(100);
  }
  return dom;
}

function typeText(w, text) {
  const box = w.document.getElementById('input');
  box.value = '';
  for (let i = 0; i < text.length; i++) {
    box.value += text[i];
    box.dispatchEvent(new w.Event('input', { bubbles: true }));
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
  console.log('===== 前端向量缓存身份隔离测试 =====\n');

  const AI_MESSAGE = '我今天很累，想休息放松一下';
  const CARD = '【向量卡】先歇一会儿吧，我陪你。';

  async function addCard(w, d, content) {
    const click = n => n.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    click(d.getElementById('openCardsBtn'));
    await wait(60);
    const owner = d.getElementById('libraryOwner');
    owner.value = 'mochi';
    owner.dispatchEvent(new w.Event('change', { bubbles: true }));
    await wait(40);
    click(d.getElementById('newCardBtn'));
    d.getElementById('cardContent').value = content;
    d.getElementById('cardCategory').value = '安慰';
    d.getElementById('cardKeywords').value = '不存在的关键词';
    d.getElementById('cardScene').value = '对方很累时';
    d.getElementById('cardOwner').value = 'mochi';
    d.getElementById('cardForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await wait(80);
    click(d.getElementById('closeCardsBtn'));
    await wait(40);
  }

  // ============ 一、初始身份来自 /api/health ============
  console.log('【一】初始身份来自健康检查');
  {
    const config = { providerId: 'cloud-bailian', model: 'text-embedding-v4', dimensions: 1024 };
    const { server, base } = await startApp({ provider: switchableProvider(config) });
    const dom = await openPage(base);
    await wait(1500);
    const w = dom.window, d = w.document;

    const st = w.MochiChatAI.getState();
    check('初始身份取自 health', identityText(st), 'cloud-bailian|text-embedding-v4|1024');
    check('初始身份没有发生跳变', st.identityChanges, 0);
    check('后端识别为可用', st.available, 'true');

    // ---------- 二、身份不变时缓存正常复用 ----------
    await addCard(w, d, CARD);
    const before = w.MochiChatAI.getState().requests;
    typeText(w, AI_MESSAGE);
    pressEnter(w);
    await wait(1500);
    const bubbles = () => [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
    const last = () => bubbles()[bubbles().length - 1];
    check('云端身份下正常命中字卡', last(), CARD);
    const afterFirst = w.MochiChatAI.getState();
    check('身份未变：没有触发作废', afterFirst.identityChanges, 0);
    check('身份未变：缓存已有内容', afterFirst.cached > 0, 'true');

    typeText(w, AI_MESSAGE);
    pressEnter(w);
    await wait(1500);
    check('同句重发不重复请求', w.MochiChatAI.getState().requests, afterFirst.requests);
    check('同句重发结果一致', last(), CARD);

    // ---------- 三、响应身份变化 → 缓存与召回结果作废 ----------
    Object.assign(config, {
      providerId: 'local-ollama', model: 'qwen3-embedding:0.6b', dimensions: 768
    });
    typeText(w, AI_MESSAGE + '（换模型后）');
    clickSend(w);
    await wait(1800);

    const afterSwitch = w.MochiChatAI.getState();
    check('身份已随响应更新', identityText(afterSwitch), 'local-ollama|qwen3-embedding:0.6b|768');
    check('身份变化被记录', afterSwitch.identityChanges, 1);
    check('身份版本号已自增', afterSwitch.identityVersion > 0, 'true');

    // ---------- 四、同句在新身份下不会命中旧缓存 ----------
    const requestsBefore = w.MochiChatAI.getState().requests;
    typeText(w, AI_MESSAGE);
    pressEnter(w);
    await wait(1800);
    const afterResend = w.MochiChatAI.getState();
    check('换身份后同句重新发起请求（旧缓存未复用）',
      afterResend.requests > requestsBefore, 'true');
    check('换身份后结果仍由新身份算出', last(), CARD);
    check('换身份后身份仍稳定', identityText(afterResend), 'local-ollama|qwen3-embedding:0.6b|768');
    check('换身份后没有再次跳变', afterResend.identityChanges, 1);

    dom.window.close();
    await close(server);
  }

  // ============ 五、旧请求晚返回不得污染新身份 ============
  console.log('【五】旧请求晚返回时不能污染新身份');
  {
    // 第一个请求故意慢（1200ms），期间把服务端身份换成 B
    const config = { providerId: 'cloud-bailian', model: 'text-embedding-v4', dimensions: 1024, delay: 1200 };
    const provider = switchableProvider(config);
    const { server, base } = await startApp({ provider: provider });
    const dom = await openPage(base);
    await wait(1500);
    const w = dom.window, d = w.document;

    await addCard(w, d, CARD);

    // 1) 发一条慢请求（身份 A）
    typeText(w, AI_MESSAGE);
    pressEnter(w);
    await wait(200);

    // 2) 请求还在路上时，把服务端换成身份 B，并发一条快请求
    Object.assign(config, {
      providerId: 'local-ollama', model: 'qwen3-embedding:0.6b', dimensions: 768, delay: 0
    });
    typeText(w, AI_MESSAGE + '（新身份）');
    pressEnter(w);
    await wait(1500);

    const mid = w.MochiChatAI.getState();
    check('快请求已把身份切到新值', identityText(mid), 'local-ollama|qwen3-embedding:0.6b|768');

    // 3) 等慢请求回来：它带的是旧身份，绝不能把身份拽回去
    await wait(1500);
    const settled = w.MochiChatAI.getState();
    check('慢请求返回后身份未被拽回旧值', identityText(settled), 'local-ollama|qwen3-embedding:0.6b|768');
    check('慢请求没有造成第二次跳变', settled.identityChanges, 1);

    // 4) 再发原来那句：应当用新身份重新计算并正常命中（若被污染则维度不匹配、相似度为 0）
    const bubbles = () => [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
    const last = () => bubbles()[bubbles().length - 1];
    typeText(w, AI_MESSAGE);
    pressEnter(w);
    await wait(1800);
    check('旧请求污染检测：结果仍由新身份算出', last(), CARD);

    dom.window.close();
    await close(server);
  }

  // ============ 六、原有行为回归 ============
  console.log('【六】原有行为回归（关键词优先 / 阈值 / 点击发送 / 失败回退）');
  {
    const config = { providerId: 'cloud-bailian', model: 'text-embedding-v4', dimensions: 1024, similarity: 0.9 };
    const { server, base } = await startApp({ provider: switchableProvider(config) });
    const dom = await openPage(base);
    await wait(1500);
    const w = dom.window, d = w.document;

    const bubbles = () => [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
    const last = () => bubbles()[bubbles().length - 1];
    const debugText = () => [...d.querySelectorAll('#debugBody .debug-row')].map(r => r.textContent).join(' | ');

    await addCard(w, d, CARD);

    // 点击发送路径
    typeText(w, AI_MESSAGE);
    clickSend(w);
    await wait(1500);
    check('点击发送：AI 召回命中', last(), CARD);
    check('点击发送：身份未变', w.MochiChatAI.getState().identityChanges, 0);

    // 关键词优先
    const click = n => n.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    click(d.getElementById('openCardsBtn'));
    await wait(60);
    const owner = d.getElementById('libraryOwner');
    owner.value = 'mochi';
    owner.dispatchEvent(new w.Event('change', { bubbles: true }));
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
    check('关键词命中时优先关键词', last(), '【关键词卡】你说了疲惫这个词');
    check('调试区说明沿用关键词', debugText().includes('关键词已命中，沿用关键词结果'), 'true');
    check('回归用例全程身份未变', w.MochiChatAI.getState().identityChanges, 0);

    dom.window.close();
    await close(server);
  }

  // ============ 六·二、阈值边界（全新页面，避免复用已缓存的向量）============
  console.log('【六·二】相似度阈值 0.6 边界');
  {
    const cases = [{ similarity: 0.5231, expectHit: false }, { similarity: 0.7972, expectHit: true }];
    for (const item of cases) {
      const config = { providerId: 'cloud-bailian', model: 'text-embedding-v4', dimensions: 1024, similarity: item.similarity };
      const { server, base } = await startApp({ provider: switchableProvider(config) });
      const dom = await openPage(base);
      await wait(1500);
      const w = dom.window, d = w.document;

      const bubbles = () => [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
      const last = () => bubbles()[bubbles().length - 1];
      const debugText = () => [...d.querySelectorAll('#debugBody .debug-row')].map(r => r.textContent).join(' | ');

      await addCard(w, d, CARD);
      typeText(w, AI_MESSAGE);
      pressEnter(w);
      await wait(1500);

      if (item.expectHit) {
        check('相似度 ' + item.similarity + ' 应触发 AI 召回', last(), CARD);
        check('相似度 ' + item.similarity + ' 身份未变', w.MochiChatAI.getState().identityChanges, 0);
      } else {
        check('相似度 ' + item.similarity + ' 不触发 AI 召回', last() === CARD, 'false');
        check('相似度 ' + item.similarity + ' 走默认回复',
          w.MochiChatMatcher.getDefaultReplies().includes(last()), 'true');
        check('相似度 ' + item.similarity + ' 调试区说明未达阈值',
          debugText().includes('低于阈值 0.6'), 'true');
      }

      dom.window.close();
      await close(server);
    }
  }

  // ============ 七、调用失败时保持回退且不污染身份 ============
  console.log('【七】调用失败时的回退与身份稳定性');
  {
    const config = {
      providerId: 'cloud-bailian', model: 'text-embedding-v4', dimensions: 1024,
      fail: Object.assign(new Error('上游异常 boom'), { code: 'http_error' })
    };
    const { server, base } = await startApp({ provider: switchableProvider(config) });
    const dom = await openPage(base);
    await wait(1500);
    const w = dom.window, d = w.document;

    await addCard(w, d, CARD);
    typeText(w, AI_MESSAGE);
    pressEnter(w);
    await wait(1800);

    const bubbles = [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
    const lastReply = bubbles[bubbles.length - 1];
    check('调用失败时回落到默认回复', w.MochiChatMatcher.getDefaultReplies().includes(lastReply), 'true');
    check('调用失败不会改变身份', w.MochiChatAI.getState().identityChanges, 0);
    const debugText = [...d.querySelectorAll('#debugBody .debug-row')].map(r => r.textContent).join(' | ');
    check('调试区记录未取得向量结果', debugText.includes('本次未取得向量结果'), 'true');

    dom.window.close();
    await close(server);
  }

  console.log('\n' + pass.join('\n'));
  if (fail.length) console.log('\n' + fail.join('\n'));
  console.log(`\n共 ${pass.length + fail.length} 项，通过 ${pass.length} 项，失败 ${fail.length} 项`);
  process.exit(fail.length ? 1 : 0);
})();
