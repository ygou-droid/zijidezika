// =======================================================
// Mochi Chat · 阶段 4.2 导入查重测试（完全重复 + 语义相似度）
// 运行方式： node test/cards-dedupe.test.js
//
// 页面用 jsdom 打开真实页面；向量接口用进程内的假云端客户端，
// 不联网、不调用真实百炼、不需要 Ollama。
// =======================================================

'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');
const { createApp } = require('../server.js');
// 阶段 8：后端已剥离，本测试依赖 Node.js 后端 / 专属假向量服务，默认隐藏（set MOCHI_RUN_BACKEND_TESTS=1 可强行运行）
if (process.env.MOCHI_RUN_BACKEND_TESTS !== '1') {
  console.log('（跳过）' + __filename.split(/[\\/]/).pop() + '：依赖已废弃的 Node.js 后端，已隐藏。');
  return;
}

const DIR = path.join(__dirname, '..');
const STORAGE_KEY = 'mochi-chat-cards-v1';
const pass = [];
const fail = [];
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  (ok ? pass : fail).push(`${ok ? '通过' : '失败'}  ${name} => 实际: ${actual}` + (ok ? '' : `  期望: ${expected}`));
}
const wait = ms => new Promise(r => setTimeout(r, ms));
function close(server) {
  return new Promise(function (resolve) { server.close(resolve); });
}
function startApp(options) {
  return new Promise(function (resolve) {
    const s = createApp(options || {}).listen(0, '127.0.0.1', function () {
      resolve({ server: s, base: 'http://127.0.0.1:' + s.address().port });
    });
  });
}

// 假云端：把文本映射成固定的 4 维向量，让「语义相近」这件事可控可断言
function fakeVector(text) {
  const raw = String(text || '');
  const v = [
    raw.indexOf('辛苦') >= 0 ? 1 : 0,
    raw.indexOf('抱抱') >= 0 ? 1 : 0,
    raw.indexOf('休息') >= 0 ? 1 : 0,
    raw.indexOf('周末') >= 0 ? 1 : 0
  ];
  if (v[0] + v[1] + v[2] + v[3] === 0) v[0] = 0.01; // 避免零向量
  return v;
}
function fakeCloudClient(options) {
  const settings = options || {};
  return {
    calls: [],
    describe: function () {
      return {
        model: 'fake-model', dimensions: 4, endpoint: 'fake',
        hasApiKey: true, maxTexts: 10, maxTextLength: 8192, timeoutMs: 1000
      };
    },
    embedTexts: async function (texts) {
      this.calls.push(texts.slice());
      if (settings.delayMs) await wait(settings.delayMs);
      if (settings.fail) {
        const error = new Error('向量服务不可用');
        error.code = 'provider_not_ready';
        throw error;
      }
      return {
        embeddings: texts.map(fakeVector),
        model: 'fake-model', dimensions: 4, usage: null
      };
    },
    redact: function (t) { return String(t); }
  };
}

async function openPage(app, initialStorage) {
  const dom = await JSDOM.fromURL(app.base + '/', {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse: function (window) {
      if (initialStorage) window.localStorage.setItem(STORAGE_KEY, initialStorage);
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? new URL(input, app.base + '/').toString() : String(input);
        return fetch(url, init);
      };
      if (!window.AbortSignal) window.AbortSignal = AbortSignal;
      window.AbortSignal.timeout = function (ms) { return AbortSignal.timeout(ms); };
    }
  });
  // 等待前端脚本（含 custom-keys → ai-match → embedding-switch-ui → card-import-ui）全部加载完成
  const w = dom.window;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !(w.MochiChat && w.MochiChatCards && w.MochiChatMatcher && w.MochiChatAI && w.MochiChatProviderUI && w.MochiChatCustomKeys)) {
    await wait(100);
  }
  return dom;
}

(async function run() {
  console.log('===== 阶段 4.2 导入查重测试 =====\n');

  // ============ 一、完全重复 + 语义相似 ============
  console.log('【一】完全重复与语义相似');
  const app1 = await startApp({ bailianClient: fakeCloudClient() });
  let savedRaw = null;
  try {
    const dom = await openPage(app1);
    const w = dom.window, d = w.document;
    await wait(2500);
    const importer = w.MochiChatCardImport;

    check('AI 后端可用', w.MochiChatAI.getState().available, 'true');
    check('AI 开关默认开启', w.MochiChatAI.getState().enabled, 'true');

    // 打开字卡库：当前联系人是示例里的 mochi（库内已有「今天辛苦啦，先抱抱你～」）
    d.getElementById('openCardsBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(120);
    d.getElementById('importCardsBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(120);
    const ownerId = w.MochiChatCards.getOwnerId();
    const before = w.MochiChatCards.getCardsOf(ownerId).length;
    check('库内已有示例字卡', before > 0, 'true');

    // 四条待导入：完全重复 / 语义相近 / 正常 / 太短
    const txt = [
      '今天辛苦啦，先抱抱你～',   // 与库内逐字相同 → 完全重复
      '今天辛苦啦，先抱抱你',     // 语义相近（向量一致）→ 疑似重复
      '周末一起去吃甜品吧',       // 正常
      '抱抱'                     // 不足 5 字，不参与语义比对
    ].join('\n');

    await importer.previewFromText(txt, 'dup.txt');
    await wait(150);

    const st = importer.getState();
    check('解析出 4 条', st.cards, 4);
    check('识别出 1 条完全重复', st.exact, 1);
    check('识别出 1 条疑似重复', st.similar, 1);
    check('重复项默认不勾选', st.selected, 2);
    check('语义查重已执行', st.dedupeMode, 'semantic');

    const summary = d.getElementById('importSummary').textContent;
    check('摘要含成功条数', summary.includes('成功解析 4 条'), 'true');
    check('摘要含完全重复条数', summary.includes('完全重复 1 条'), 'true');
    check('摘要含疑似重复条数', summary.includes('疑似重复 1 条'), 'true');
    check('摘要含失败条数', summary.includes('失败 0 条'), 'true');
    check('摘要含已勾选条数', summary.includes('已勾选 2 条'), 'true');

    const tags = [...d.querySelectorAll('#importPreview .dupe-tag')].map(t => t.textContent);
    check('预览里有完全重复标签', tags.some(t => t.includes('完全重复')), 'true');
    check('预览里有疑似重复标签', tags.some(t => t.includes('疑似重复')), 'true');
    check('疑似重复带相似度', tags.some(t => /疑似重复（\d\.\d+）/.test(t)), 'true');
    check('短文本没有被误判', tags.filter(t => t.includes('重复')).length, 2);

    const boxes = [...d.querySelectorAll('#importPreview .import-check input')];
    check('预览项都有勾选框', boxes.length, 4);
    check('重复项默认未勾选', boxes[0].checked, 'false');
    check('疑似重复默认未勾选', boxes[1].checked, 'false');
    check('新内容默认勾选', boxes[2].checked, 'true');

    // 手动取消勾选第 3 条 → 只导入第 4 条
    boxes[2].checked = false;
    boxes[2].dispatchEvent(new w.Event('change', { bubbles: true }));
    await wait(50);
    check('取消勾选后立即生效', importer.getState().selected, 1);

    // 把完全重复那条勾回来 → 应该被导入（尊重用户选择）
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new w.Event('change', { bubbles: true }));
    await wait(50);
    check('手动勾回重复项生效', importer.getState().selected, 2);

    importer.confirm();
    await wait(150);
    const after = w.MochiChatCards.getCardsOf(ownerId);
    check('只导入勾选的 2 条', after.length, before + 2);
    check('导入了手动勾回的完全重复项',
      after.some(c => c.content === '今天辛苦啦，先抱抱你～'), 'true');
    check('未导入未勾选的普通项',
      after.some(c => c.content === '周末一起去吃甜品吧'), 'false');
    check('未导入疑似重复项',
      after.filter(c => c.content === '今天辛苦啦，先抱抱你').length, 0);

    savedRaw = w.localStorage.getItem(STORAGE_KEY);
    check('已写入 localStorage', typeof savedRaw, 'string');
    dom.window.close();
  } finally {
    await close(app1.server);
  }

  // ============ 二、刷新后数据正确 ============
  console.log('【二】刷新后仍在');
  {
    const app2 = await startApp({ bailianClient: fakeCloudClient() });
    try {
      const dom = await openPage(app2, savedRaw);
      await wait(2500);
      const w = dom.window;
      const ownerId = w.MochiChatCards.getOwnerId();
      const list = w.MochiChatCards.getCardsOf(ownerId);
      check('刷新后字卡仍在', list.length >= 4, 'true');
      check('刷新后导入的重复项仍在',
        list.some(c => c.content === '今天辛苦啦，先抱抱你～'), 'true');
      check('刷新后未导入项仍不存在',
        list.some(c => c.content === '周末一起去吃甜品吧'), 'false');

      // 再导入一次「今天辛苦啦，先抱抱你～」：这次应该被判为完全重复
      w.document.getElementById('openCardsBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await wait(120);
      w.document.getElementById('importCardsBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await wait(120);
      await w.MochiChatCardImport.previewFromText('今天辛苦啦，先抱抱你～\n周末一起去吃甜品吧', 'again.txt');
      await wait(150);
      check('再次导入同一句被判完全重复', w.MochiChatCardImport.getState().exact, 1);
      check('只剩新内容被勾选', w.MochiChatCardImport.getState().selected, 1);
      dom.window.close();
    } finally {
      await close(app2.server);
    }
  }

  // ============ 三、语义查重的加载态 ============
  console.log('【三】加载态');
  {
    const app3 = await startApp({ bailianClient: fakeCloudClient({ delayMs: 400 }) });
    try {
      const dom = await openPage(app3);
      await wait(2500);
      const w = dom.window, d = w.document;
      d.getElementById('openCardsBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await wait(120);
      d.getElementById('importCardsBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await wait(120);

      const pending = w.MochiChatCardImport.previewFromText('周末一起去吃甜品吧', 'slow.txt');
      await wait(120);
      check('查重期间有加载态', w.MochiChatCardImport.getState().checking, 'true');
      check('加载文案是语义查重', d.getElementById('importLoading').textContent.includes('正在进行语义查重'), 'true');
      check('加载时隐藏摘要', d.getElementById('importSummary').hidden, 'true');
      check('加载时禁用确认', d.getElementById('confirmImportBtn').disabled, 'true');

      await pending;
      await wait(50);
      check('查重结束后加载态消失', w.MochiChatCardImport.getState().checking, 'false');
      check('查重结束后摘要出现', d.getElementById('importSummary').hidden, 'false');
      check('查重结束后可确认', d.getElementById('confirmImportBtn').disabled, 'false');
      dom.window.close();
    } finally {
      await close(app3.server);
    }
  }

  // ============ 四、AI 关闭时静默降级 ============
  console.log('【四】AI 关闭时降级');
  {
    const app4 = await startApp({ bailianClient: fakeCloudClient() });
    try {
      const dom = await openPage(app4);
      await wait(2500);
      const w = dom.window, d = w.document;
      d.getElementById('openCardsBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await wait(120);
      d.getElementById('importCardsBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await wait(120);

      w.MochiChatAI.setEnabled(false);
      await w.MochiChatCardImport.previewFromText('今天辛苦啦，先抱抱你～\n周末一起去吃甜品吧', 'off.txt');
      await wait(150);

      const st = w.MochiChatCardImport.getState();
      check('关闭 AI 后仍做完全重复', st.exact, 1);
      check('关闭 AI 后不做语义查重', st.similar, 0);
      check('降级模式为 exact', st.dedupeMode, 'exact');
      check('新内容仍默认勾选', st.selected, 1);
      check('检测查重按钮被禁用', d.getElementById('detectDupeBtn').disabled, 'true');

      // 降级后仍能正常导入
      const ownerId = w.MochiChatCards.getOwnerId();
      const before = w.MochiChatCards.getCardsOf(ownerId).length;
      w.MochiChatCardImport.confirm();
      await wait(120);
      check('降级后仍可导入', w.MochiChatCards.getCardsOf(ownerId).length, before + 1);
      dom.window.close();
    } finally {
      await close(app4.server);
    }
  }

  // ============ 五、向量服务报错时静默降级 ============
  console.log('【五】向量服务不可用时降级');
  {
    const app5 = await startApp({ bailianClient: fakeCloudClient({ fail: true }) });
    try {
      const dom = await openPage(app5);
      await wait(2500);
      const w = dom.window, d = w.document;
      d.getElementById('openCardsBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await wait(120);
      d.getElementById('importCardsBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await wait(120);

      await w.MochiChatCardImport.previewFromText('今天辛苦啦，先抱抱你～\n周末一起去吃甜品吧', 'err.txt');
      await wait(200);

      const st = w.MochiChatCardImport.getState();
      check('服务报错不崩溃', st.cards, 2);
      check('完全重复照样识别', st.exact, 1);
      check('语义查重静默放弃', st.similar, 0);
      check('降级为仅完全重复', st.dedupeMode, 'exact');
      check('仍可勾选新内容', st.selected, 1);

      const ownerId = w.MochiChatCards.getOwnerId();
      const before = w.MochiChatCards.getCardsOf(ownerId).length;
      w.MochiChatCardImport.confirm();
      await wait(120);
      check('服务报错时导入仍成功', w.MochiChatCards.getCardsOf(ownerId).length, before + 1);
      check('聊天仍能发送', typeof d.getElementById('input').value, 'string');
      dom.window.close();
    } finally {
      await close(app5.server);
    }
  }

  // ============ 六、手动点「检测查重」============
  console.log('【六】手动检测查重');
  {
    const app6 = await startApp({ bailianClient: fakeCloudClient() });
    try {
      const dom = await openPage(app6);
      await wait(2500);
      const w = dom.window, d = w.document;
      d.getElementById('openCardsBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await wait(120);
      d.getElementById('importCardsBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await wait(120);

      // 先关 AI 预览：只会标出完全重复
      w.MochiChatAI.setEnabled(false);
      await w.MochiChatCardImport.previewFromText('今天辛苦啦，先抱抱你', 'manual.txt');
      await wait(120);
      check('关 AI 时没有疑似重复', w.MochiChatCardImport.getState().similar, 0);
      check('关 AI 时仍可导入', w.MochiChatCardImport.getState().selected, 1);

      // 再开 AI，手动点按钮补做语义查重
      w.MochiChatAI.setEnabled(true);
      await w.MochiChatCardImport.previewFromText('今天辛苦啦，先抱抱你', 'manual.txt');
      await wait(150);
      check('开 AI 后自动标出疑似重复', w.MochiChatCardImport.getState().similar, 1);
      check('疑似重复默认不勾选', w.MochiChatCardImport.getState().selected, 0);
      check('按钮可用', d.getElementById('detectDupeBtn').disabled, 'false');

      // 点全选：所有条目都勾上
      d.getElementById('selectAllBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await wait(50);
      check('全选生效', w.MochiChatCardImport.getState().selected, 1);
      d.getElementById('selectNoneBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await wait(50);
      check('全不选生效', w.MochiChatCardImport.getState().selected, 0);
      check('全不选后禁用确认', d.getElementById('confirmImportBtn').disabled, 'true');
      dom.window.close();
    } finally {
      await close(app6.server);
    }
  }

  console.log('\n' + pass.join('\n'));
  if (fail.length) console.log('\n' + fail.join('\n'));
  console.log(`\n共 ${pass.length + fail.length} 项，通过 ${pass.length} 项，失败 ${fail.length} 项`);
  process.exit(fail.length ? 1 : 0);
})();
