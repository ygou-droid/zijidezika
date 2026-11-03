// =======================================================
// Mochi Chat · 阶段 4.3 自动分类与标签生成测试
// 运行方式： node test/cards-auto-tag.test.js
//
// 关注点：只补「缺失的分类 / 缺失的关键词」，用户填过的一律不动；
//        预览里有明显提示且可手动改；改后的值才是最终入库的值。
// =======================================================

'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');
const { createApp } = require('../server.js');

const DIR = path.join(__dirname, '..');
const STORAGE_KEY = 'mochi-chat-cards-v1';
const STOP = ['我', '你', '他', '的', '了', '是', '在', '有', '和', '就', '都', '也', '很', '要', '会', '不', '没', '这', '那', '吗', '啊', '吧', '呢', '上', '去', '来'];
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
function startApp() {
  return new Promise(function (resolve) {
    const s = createApp({}).listen(0, '127.0.0.1', function () {
      resolve({ server: s, base: 'http://127.0.0.1:' + s.address().port });
    });
  });
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
// 每个预览项里：inputs[0] = 分类，inputs[1] = 关键词
function itemInputs(item) {
  return [...item.querySelectorAll('.import-input')];
}

(async function run() {
  console.log('===== 阶段 4.3 自动分类与标签测试 =====\n');
  const app = await startApp();
  let savedRaw = null;

  try {
    const dom = await openPage(app);
    const w = dom.window, d = w.document;
    await wait(2500);
    const importer = w.MochiChatCardImport;
    // 本文件只验证自动生成：关掉 AI，避免触发真实云端语义查重
    w.MochiChatAI.setEnabled(false);
    check('导入模块已加载', typeof importer, 'object');

    d.getElementById('openCardsBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(120);
    d.getElementById('importCardsBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(120);

    // ============ 一、缺分类 / 缺标签时自动生成 ============
    console.log('【一】自动生成');
    {
      const txt = [
        '晚上要不要一起吃夜宵', // 含「吃」→ 映射到库里已有的「日常」
        '今天好累啊想哭',       // 含「累/哭」→ 「安慰」
        '周末一起出去玩吧',     // 含「周末/一起」→ 「邀约」
        '随便写的一句话'        // 没有任何特征 → 保留「未分类」
      ].join('\n');

      await importer.previewFromText(txt, 'auto.txt');
      await wait(200);

      const st = importer.getState();
      check('解析出 4 条', st.cards, 4);
      check('3 条自动补了分类', st.autoCategory, 3);
      check('4 条都自动补了标签', st.autoKeywords, 4);

      const items = [...d.querySelectorAll('#importPreview .import-item')];
      check('预览列出 4 条', items.length, 4);
      check('吃夜宵 → 日常', itemInputs(items[0])[0].value, '日常');
      check('累想哭 → 安慰', itemInputs(items[1])[0].value, '安慰');
      check('出去玩 → 邀约', itemInputs(items[2])[0].value, '邀约');
      check('无特征 → 仍是未分类', itemInputs(items[3])[0].value, '未分类');

      const allTags = items.map(function (item) {
        return itemInputs(item)[1].value.split(/[,，、\s]+/).filter(Boolean);
      });
      check('每条都给了标签', allTags.every(function (t) { return t.length >= 1 && t.length <= 3; }), 'true');
      check('标签长度在 2-4 字之间',
        allTags.every(function (t) { return t.every(function (x) { return x.length >= 2 && x.length <= 4; }); }), 'true');
      check('标签不含停用词',
        allTags.every(function (t) { return t.every(function (x) { return STOP.indexOf(x) === -1; }); }), 'true');
      check('标签没有叠词重复用字', (function () {
        const tags = allTags[0];
        for (let i = 0; i < tags.length; i++) {
          for (let j = i + 1; j < tags.length; j++) {
            const shared = tags[i].split('').some(function (ch) { return tags[j].indexOf(ch) !== -1; });
            if (shared) return false;
          }
        }
        return true;
      })(), 'true');

      // UI 提示
      const note = d.getElementById('importAutoNote');
      check('自动提示可见', note.hidden, 'false');
      check('提示说明补了分类', note.textContent.includes('自动补了分类'), 'true');
      check('提示说明补了标签', note.textContent.includes('自动补了标签'), 'true');

      const badges = [...d.querySelectorAll('#importPreview .auto-tag')].map(b => b.textContent);
      check('有 AI 推荐分类标识', badges.some(t => t.includes('AI 推荐分类')), 'true');
      check('有自动标签标识', badges.some(t => t.includes('自动标签')), 'true');
    }

    // ============ 二、用户已填的不被覆盖 ============
    console.log('【二】用户数据优先');
    {
      const json = JSON.stringify([
        { content: '晚上一起吃夜宵吧', category: '自定义分类', keywords: ['原有标签'], scene: '深夜' },
        { content: '你推荐的歌真好听', category: '夸奖', keywords: ['音乐'] }
      ]);
      await importer.previewFromText(json, 'user.json');
      await wait(200);

      const st = importer.getState();
      check('已填分类的字卡不再自动生成', st.autoCategory, 0);
      check('已填标签的字卡不再自动生成', st.autoKeywords, 0);

      const items = [...d.querySelectorAll('#importPreview .import-item')];
      check('保留用户原分类', itemInputs(items[0])[0].value, '自定义分类');
      check('保留用户原标签', itemInputs(items[0])[1].value, '原有标签');
      check('第二张保留用户分类', itemInputs(items[1])[0].value, '夸奖');
      check('第二张保留用户标签', itemInputs(items[1])[1].value, '音乐');
      check('已填项没有自动标识', items[0].querySelectorAll('.auto-tag').length, 0);
      check('自动提示已隐藏', d.getElementById('importAutoNote').hidden, 'true');
    }

    // ============ 三、手动修改后以用户值为准 ============
    console.log('【三】手动修改');
    {
      await importer.previewFromText('晚上要不要一起吃夜宵\n今天好累啊想哭', 'edit.txt');
      await wait(200);

      let items = [...d.querySelectorAll('#importPreview .import-item')];
      const catInput = itemInputs(items[0])[0];
      const kwInput = itemInputs(items[0])[1];

      catInput.value = '深夜食堂';
      catInput.dispatchEvent(new w.Event('change', { bubbles: true }));
      await wait(80);
      items = [...d.querySelectorAll('#importPreview .import-item')];
      check('分类改完立即生效', itemInputs(items[0])[0].value, '深夜食堂');

      kwInput.value = '烧烤, 夜宵';
      kwInput.dispatchEvent(new w.Event('change', { bubbles: true }));
      await wait(80);
      items = [...d.querySelectorAll('#importPreview .import-item')];
      check('标签改完立即生效', itemInputs(items[0])[1].value, '烧烤, 夜宵');
      const badges = [...items[0].querySelectorAll('.auto-tag')].map(b => b.textContent);
      check('改动后标识变已手动修改', badges.every(t => t.includes('已手动修改')), 'true');

      // 第二条保持自动值不动
      check('另一条仍是自动分类', itemInputs(items[1])[0].value, '安慰');

      const ownerId = w.MochiChatCards.getOwnerId();
      const before = w.MochiChatCards.getCardsOf(ownerId).length;
      importer.confirm();
      await wait(150);

      const list = w.MochiChatCards.getCardsOf(ownerId);
      check('只导入 2 条', list.length, before + 2);
      const first = list.find(function (c) { return c.content === '晚上要不要一起吃夜宵'; });
      check('入库的是手动改后的分类', first.category, '深夜食堂');
      check('入库的是手动改后的标签', first.keywords.join(','), '烧烤,夜宵');
      const second = list.find(function (c) { return c.content === '今天好累啊想哭'; });
      check('未改动的用自动分类', second.category, '安慰');
      check('自动标签也一并入库', second.keywords.length > 0, 'true');

      savedRaw = w.localStorage.getItem(STORAGE_KEY);
    }

    // ============ 四、4.2 查重未被破坏 ============
    console.log('【四】查重仍生效');
    {
      const ownerId = w.MochiChatCards.getOwnerId();
      const existing = w.MochiChatCards.getCardsOf(ownerId)[0].content;
      await importer.previewFromText(existing + '\n全新的一句话内容', 'dup.txt');
      await wait(200);
      const st = importer.getState();
      check('完全重复仍被识别', st.exact, 1);
      check('重复项仍默认不勾选', st.selected, 1);
      check('新内容仍自动补分类或标签', st.autoCategory + st.autoKeywords >= 1, 'true');
      importer.close();
    }

    // ============ 五、大文件不卡死 ============
    console.log('【五】大文件');
    {
      const big = [];
      for (let i = 0; i < 5000; i++) big.push('大文件第 ' + i + ' 条字卡内容，今天好累啊想吃夜宵');
      const started = Date.now();
      await importer.previewFromText(big.join('\n'), 'big.txt');
      const cost = Date.now() - started;
      check('5000 条全部解析', importer.getState().cards, 5000);
      check('生成耗时可接受（<8000ms）', cost < 8000, 'true');
      console.log('    解析 + 自动生成 5000 条耗时 ' + cost + 'ms');
      importer.close();
    }

    dom.window.close();
  } finally {
    await close(app.server);
  }

  // ============ 六、刷新后仍是最终值 ============
  console.log('【六】持久化');
  {
    const app2 = await startApp();
    try {
      const dom = await openPage(app2, savedRaw);
      await wait(2500);
      const w = dom.window;
      const ownerId = w.MochiChatCards.getOwnerId();
      const list = w.MochiChatCards.getCardsOf(ownerId);
      const first = list.find(function (c) { return c.content === '晚上要不要一起吃夜宵'; });
      check('刷新后字卡仍在', !!first, 'true');
      check('刷新后仍是手动改后的分类', first.category, '深夜食堂');
      check('刷新后仍是手动改后的标签', first.keywords.join(','), '烧烤,夜宵');
      check('刷新后导入模块仍在', typeof w.MochiChatCardImport, 'object');
      dom.window.close();
    } finally {
      await close(app2.server);
    }
  }

  console.log('\n' + pass.join('\n'));
  if (fail.length) console.log('\n' + fail.join('\n'));
  console.log(`\n共 ${pass.length + fail.length} 项，通过 ${pass.length} 项，失败 ${fail.length} 项`);
  process.exit(fail.length ? 1 : 0);
})();
