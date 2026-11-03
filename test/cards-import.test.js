// =======================================================
// Mochi Chat · 阶段 4.1 字卡批量导入测试
// 运行方式： node test/cards-import.test.js
//
// 用 jsdom 打开真实页面（真实服务端提供静态文件），
// 覆盖：TXT / JSON 解析规则、字段校验、失败计数、预览、
//      确认后写入 localStorage、刷新后仍在、手动新增与关键词匹配不受影响。
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
  console.log('===== 阶段 4.1 字卡批量导入测试 =====\n');
  const app = await startApp();

  try {
    const dom = await openPage(app);
    const w = dom.window, d = w.document;
    await wait(2500);
    const importer = w.MochiChatCardImport;
    // 4.1 只验证「解析 + 预览 + 保存」：关掉 AI，避免预览时触发真实云端语义查重
    w.MochiChatAI.setEnabled(false);

    // ============ 一、页面入口 ============
    console.log('【一】入口与弹窗');
    check('导入模块已加载', typeof importer, 'object');
    check('工具栏有批量导入按钮', !!d.getElementById('importCardsBtn'), 'true');
    check('导入弹窗默认隐藏', d.getElementById('importModal').hidden, 'true');

    d.getElementById('openCardsBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(100);
    d.getElementById('importCardsBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await wait(100);
    check('点按钮后弹窗打开', d.getElementById('importModal').hidden, 'false');
    check('弹窗显示导入目标联系人', d.getElementById('importTarget').textContent.length > 0, 'true');
    check('未选择文件时不能确认', d.getElementById('confirmImportBtn').disabled, 'true');
    check('界面给了格式说明', d.getElementById('importModal').textContent.includes('TXT'), 'true');

    // ============ 二、TXT 解析 ============
    console.log('【二】TXT 解析');
    {
      // ① 一行一张
      let r = importer.parseTxt('今天辛苦啦\n你已经做得很好了\n');
      check('TXT 一行一张：条数', r.cards.length, 2);
      check('TXT 一行一张：内容', r.cards[0].content, '今天辛苦啦');
      check('TXT 一行一张：默认分类', r.cards[0].category, '未分类');
      check('TXT 一行一张：无失败', r.failures.length, 0);

      // ② 问答对
      r = importer.parseTxt('问：感觉很累\n答：先抱抱你，休息一下吧\n');
      check('TXT 问答对：条数', r.cards.length, 1);
      check('TXT 问答对：内容是答', r.cards[0].content, '先抱抱你，休息一下吧');
      check('TXT 问答对：问变成关键词', r.cards[0].keywords.join(','), '感觉很累');

      // 多组问答连续写
      r = importer.parseTxt('问：累\n答：抱抱\n问：饿\n答：去吃点好的\n');
      check('TXT 多组问答：条数', r.cards.length, 2);
      check('TXT 多组问答：第二条内容', r.cards[1].content, '去吃点好的');

      // ③ 字段行（空行分隔）
      r = importer.parseTxt('内容：今天辛苦啦\n分类：安慰\n关键词：疲惫, 辛苦\n场景：对方加班时\n\n内容：周末一起出去玩\n分类：邀约\n');
      check('TXT 字段行：条数', r.cards.length, 2);
      check('TXT 字段行：分类', r.cards[0].category, '安慰');
      check('TXT 字段行：关键词', r.cards[0].keywords.join('、'), '疲惫、辛苦');
      check('TXT 字段行：场景', r.cards[0].scene, '对方加班时');
      check('TXT 字段行：第二张分类', r.cards[1].category, '邀约');

      // ④ 空白与无效数据
      r = importer.parseTxt('\n\n   \n');
      check('TXT 空文件：条数', r.cards.length, 0);
      check('TXT 空文件：无失败', r.failures.length, 0);

      r = importer.parseTxt('分类：安慰\n');
      check('TXT 只有字段没有内容：不算成功', r.cards.length, 0);
      check('TXT 只有字段没有内容：记失败', r.failures.length, 1);

      // ⑤ 中文逗号与顿号
      r = importer.parseTxt('内容：摸摸头\n关键词：疲惫，辛苦、加班\n');
      check('TXT 关键词支持中文逗号', r.cards[0].keywords.join('/'), '疲惫/辛苦/加班');
    }

    // ============ 三、JSON 解析与校验 ============
    console.log('【三】JSON 解析与校验');
    {
      let r = importer.parseJson(JSON.stringify([
        { content: '今天辛苦啦', category: '安慰', keywords: ['疲惫'], scene: '对方很累' },
        { content: '摸摸头', category: '安慰' }
      ]));
      check('JSON 数组：条数', r.cards.length, 2);
      check('JSON 数组：字段完整', r.cards[0].keywords.join(','), '疲惫');
      check('JSON 数组：缺省场景为空', r.cards[1].scene, '');
      check('JSON 数组：无失败', r.failures.length, 0);

      r = importer.parseJson(JSON.stringify({ cards: [{ content: '包着的写法' }] }));
      check('JSON 支持 { cards: [] }', r.cards.length, 1);

      // 校验：缺 content
      r = importer.parseJson(JSON.stringify([{ category: '安慰' }, { content: '   ' }, { content: '正常' }]));
      check('JSON 缺内容被过滤', r.cards.length, 1);
      check('JSON 缺内容计失败', r.failures.length, 2);
      check('JSON 失败原因可读', r.failures[0].includes('字卡内容'), 'true');

      // 校验：类型错误
      r = importer.parseJson(JSON.stringify([
        { content: '关键词是数字', keywords: 123 },
        { content: '分类是数字', category: 5 },
        { content: '场景是数组', scene: ['x'] },
        { content: '关键词是字符串', keywords: '疲惫,辛苦' }
      ]));
      check('JSON 类型错误被拦下', r.cards.length, 1);
      check('JSON 类型错误计失败', r.failures.length, 3);
      check('JSON 字符串关键词可解析', r.cards[0].keywords.join('/'), '疲惫/辛苦');

      // 非数组顶层 / 坏 JSON
      r = importer.parseJson('{"foo":1}');
      check('JSON 顶层不是数组：整体失败', !!r.fatal, 'true');
      check('JSON 顶层不是数组：无字卡', r.cards.length, 0);

      r = importer.parseJson('{ 这不是 json ');
      check('坏 JSON 不崩溃', !!r.fatal, 'true');
      check('坏 JSON 提示含解析字样', r.fatal.includes('JSON'), 'true');
    }

    // ============ 四、预览界面 ============
    console.log('【四】预览与确认');
    {
      const txt = '问：好累\n答：抱抱你\n内容：周末出去玩\n分类：邀约\n\n分类：只有分类没有内容\n';
      await importer.previewFromText(txt, 'demo.txt');
      await wait(50);

      const summary = d.getElementById('importSummary').textContent;
      check('预览显示成功条数', summary.includes('成功解析 2 条'), 'true');
      check('预览显示失败条数', summary.includes('失败 1 条'), 'true');
      check('预览列出条目', d.querySelectorAll('#importPreview .import-item').length, 2);
      check('失败原因可见', d.querySelectorAll('#importErrors .import-error').length, 1);
      check('确认按钮已启用', d.getElementById('confirmImportBtn').disabled, 'false');

      // 预览只显示前 5 条
      const many = [];
      for (let i = 0; i < 12; i++) many.push('第 ' + i + ' 张字卡');
      await importer.previewFromText(many.join('\n'), 'many.txt');
      await wait(80);
      check('预览最多 5 条', d.querySelectorAll('#importPreview .import-item').length, 5);
      check('多余条数有提示', d.getElementById('importPreview').textContent.includes('还有 7 条'), 'true');

      // 确认导入：只导入合法的两条
      await importer.previewFromText(txt, 'demo.txt');
      await wait(50);
      const ownerId = w.MochiChatCards.getOwnerId();
      const before = w.MochiChatCards.getCardsOf(ownerId).length;
      importer.confirm();
      await wait(100);

      check('确认后弹窗关闭', d.getElementById('importModal').hidden, 'true');
      const after = w.MochiChatCards.getCardsOf(ownerId);
      check('确认后字卡已追加', after.length, before + 2);
      check('导入内容正确', after[after.length - 2].content, '抱抱你');
      check('导入分类正确', after[after.length - 1].category, '邀约');
      check('导入的字卡有新 id', typeof after[after.length - 1].id, 'string');
      check('失败数据没有入库', after.length - before, 2);
      check('提示已给出', d.getElementById('toast').textContent.includes('已导入'), 'true');
      check('列表已刷新', d.querySelectorAll('#cardGrid .card-item').length > 0, 'true');

      var savedRaw = w.localStorage.getItem(STORAGE_KEY);
      var savedStore = JSON.parse(savedRaw);
      check('已写入 localStorage', (savedStore[ownerId] || []).length, before + 2);
      check('导入的字卡含完整字段',
        ['content', 'category', 'keywords', 'scene'].every(function (k) {
          return k in savedStore[ownerId][savedStore[ownerId].length - 1];
        }), 'true');
    }

    // ============ 五、非法输入不崩溃 ============
    console.log('【五】异常输入');
    {
      await importer.previewFromText('', 'empty.txt');
      await wait(30);
      check('空文件不崩溃', importer.getState().cards, 0);
      check('空文件禁用确认', d.getElementById('confirmImportBtn').disabled, 'true');

      await importer.previewFromText('{ 坏掉的 json', 'bad.json');
      await wait(30);
      check('坏 JSON 有致命提示', !!importer.getState().fatal, 'true');
      check('坏 JSON 不导入任何字卡', importer.getState().cards, 0);

      importer.confirm();
      await wait(30);
      check('无合法数据时确认不写入', importer.getState().cards, 0);
    }

    // ============ 六、大文件不卡死 ============
    console.log('【六】大文件');
    {
      const big = [];
      for (let i = 0; i < 5000; i++) big.push('大文件第 ' + i + ' 张字卡内容');
      const started = Date.now();
      await importer.previewFromText(big.join('\n'), 'big.txt');
      const cost = Date.now() - started;
      check('5000 条全部解析', importer.getState().cards, 5000);
      check('解析耗时可接受（<8000ms）', cost < 8000, 'true');
      console.log('    解析 5000 条耗时 ' + cost + 'ms');
      importer.close();
    }

    // ============ 七、既有功能不受影响 ============
    console.log('【七】既有功能');
    {
      const ownerId = w.MochiChatCards.getOwnerId();
      const before = w.MochiChatCards.getCardsOf(ownerId).length;

      // 手动新建仍可用
      d.getElementById('newCardBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await wait(50);
      d.getElementById('cardContent').value = '手写的字卡';
      d.getElementById('cardForm').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
      await wait(100);
      check('手动新建仍可用', w.MochiChatCards.getCardsOf(ownerId).length, before + 1);

      // 关键词匹配仍可用（导入时「问：好累」自动成了关键词）
      const matched = w.MochiChatMatcher.match(ownerId, '我今天好累啊');
      check('关键词匹配命中导入的字卡', matched.matched, 'true');
      check('命中的是导入那张字卡', matched.card && matched.card.content, '抱抱你');
      check('回复内容非空', typeof matched.reply === 'string' && matched.reply.length > 0, 'true');

      // 聊天仍能发送
      const input = d.getElementById('input');
      input.value = '好累啊';
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      d.getElementById('sendBtn').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await wait(1500);
      const bubbles = [...d.querySelectorAll('#messages .bubble')].map(b => b.textContent);
      check('聊天仍能收到回复', bubbles.length >= 2, 'true');
      check('字卡模块仍在', typeof w.MochiChatCards, 'object');
    }

    dom.window.close();

    // ============ 八、刷新后仍在（模拟重新打开页面）============
    console.log('【八】持久化');
    {
      const reloaded = await openPage(app, savedRaw);
      await wait(2500);
      const w2 = reloaded.window, d2 = reloaded.window.document;
      const ownerId = w2.MochiChatCards.getOwnerId();
      const list = w2.MochiChatCards.getCardsOf(ownerId);
      const stored = JSON.parse(w2.localStorage.getItem(STORAGE_KEY));
      check('刷新后字卡数量一致', (stored[ownerId] || []).length, list.length);
      check('刷新后导入的字卡仍在',
        (stored[ownerId] || []).some(function (c) { return c.content === '抱抱你'; }), 'true');
      check('刷新后导入模块仍在', typeof w2.MochiChatCardImport, 'object');
      reloaded.window.close();
    }
  } finally {
    await close(app.server);
  }

  console.log('\n' + pass.join('\n'));
  if (fail.length) console.log('\n' + fail.join('\n'));
  console.log(`\n共 ${pass.length + fail.length} 项，通过 ${pass.length} 项，失败 ${fail.length} 项`);
  process.exit(fail.length ? 1 : 0);
})();
