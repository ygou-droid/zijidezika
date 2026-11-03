// =======================================================
// Mochi Chat · 阶段 5.3 聊天外观（气泡 / 信纸）测试
// 运行方式： node test/space-chat-style-5.3.test.js
//
// 覆盖：chatStyle 兜底、双模式切换、气泡颜色/透明度/毛玻璃、
//      信纸样式、背景上传与大小限制、实时生效、持久化与互不干扰。
// =======================================================

'use strict';

const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');
const { createApp } = require('../server.js');

const DIR = path.join(__dirname, '..');
const SPACE_KEY = 'mochi-chat-space-v1';
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
      if (initialStorage) window.localStorage.setItem(SPACE_KEY, initialStorage);
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
const click = (node, w) => node.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
function setFiles(w, input, file) {
  Object.defineProperty(input, 'files', {
    value: { 0: file, length: 1, item: function () { return file; } },
    configurable: true
  });
}

(async function run() {
  console.log('===== 阶段 5.3 聊天外观测试 =====\n');

  // ============ 一、静态骨架检查 ============
  console.log('【一】面板与样式骨架');
  {
    const html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(DIR, 'style.css'), 'utf8');

    ['stylePanel', 'stylePanelBtn', 'modeBubbleBtn', 'modeLetterBtn', 'styleColorOptions',
      'styleColorInput', 'styleOpacityInput', 'styleGlassInput', 'styleLetterOptions',
      'styleBgFile', 'styleClearBgBtn', 'chatBg'].forEach(function (id) {
      check('控件存在：' + id, html.includes('id="' + id + '"'), 'true');
    });

    check('气泡色走变量', /\.app\.show-space \.bubble \{\s*background: var\(--bubble-bg/.test(css), 'true');
    check('毛玻璃有开关样式', css.includes('.app.show-space[data-glass="on"] .bubble'), 'true');
    check('信纸模式去气泡底色', css.includes('[data-chat-mode="letter"] .bubble'), 'true');
    ['lined', 'grid', 'plain'].forEach(function (name) {
      check('信纸纹理：' + name, css.includes('[data-letter="' + name + '"] .messages'), 'true');
    });
    check('面板 hidden 能生效', css.includes('.style-panel[hidden]'), 'true');
    check('聊天背景层有样式', css.includes('.app.show-space.chat-open.has-chat-bg .chat-bg'), 'true');
  }

  // ============ 二、默认值与脏数据兜底 ============
  console.log('【二】默认值与兜底');
  const app = await startApp();
  try {
    const dom = await openPage(app);
    const w = dom.window, d = w.document;
    await wait(2500);
    w.MochiChatAI.setEnabled(false);

    const def = w.MochiChat.getChatStyle('mochi');
    check('默认气泡模式', def.mode, 'bubble');
    check('默认气泡颜色', def.bubbleColor, '#FFFFFF');
    check('默认透明度', def.bubbleOpacity, 0.86);
    check('默认无毛玻璃', def.glassEffect, 'false');
    check('默认信纸横线', def.letterStyle, 'lined');
    check('默认无自定义背景', def.chatBackground, '');

    // 脏数据全部兜回默认
    check('非法模式被拒绝', w.MochiChat.setChatStyle('mochi', { mode: ' newspaper ' }).mode, 'bubble');
    check('非法颜色被拒绝', w.MochiChat.setChatStyle('mochi', { bubbleColor: 'red' }).bubbleColor, '#FFFFFF');
    check('透明度过大收敛为 1', w.MochiChat.setChatStyle('mochi', { bubbleOpacity: 9 }).bubbleOpacity, 1);
    check('透明度过小收敛为 0.3', w.MochiChat.setChatStyle('mochi', { bubbleOpacity: 0.01 }).bubbleOpacity, 0.3);
    check('非布尔毛玻璃被拒绝', w.MochiChat.setChatStyle('mochi', { glassEffect: 'yes' }).glassEffect, 'false');
    check('非法信纸样式被拒绝', w.MochiChat.setChatStyle('mochi', { letterStyle: 'gold' }).letterStyle, 'lined');
    check('非图片背景被拒绝', w.MochiChat.setChatStyle('mochi', { chatBackground: 'http://x.com/a.png' }).chatBackground, '');
    // 兜底测试把透明度压到了 0.3，恢复默认再继续
    w.MochiChat.setChatStyle('mochi', { bubbleOpacity: 0.86 });

    // 正常写入
    const ok = w.MochiChat.setChatStyle('mochi', { mode: 'letter', glassEffect: true });
    check('合法写入信纸模式', ok.mode, 'letter');
    check('合法写入毛玻璃', ok.glassEffect, 'true');
    w.MochiChat.setChatStyle('mochi', { mode: 'bubble', glassEffect: false });

    // ============ 三、面板交互与实时生效 ============
    console.log('【三】面板交互');
    {
      const items = [...d.querySelectorAll('#contactList li')];
      click(items[0], w);
      await wait(150);
      click(d.getElementById('dockChatBtn'), w);
      await wait(120);

      check('默认收起聊天时面板不可见', d.getElementById('stylePanel').hidden, 'true');
      click(d.getElementById('stylePanelBtn'), w);
      await wait(100);
      check('点外观打开面板', d.getElementById('stylePanel').hidden, 'false');
      check('气泡按钮默认选中', d.getElementById('modeBubbleBtn').classList.contains('is-active'), 'true');
      check('提供 6 个颜色预设', d.querySelectorAll('#styleColorOptions .style-color-swatch').length, 6);
      check('提供 3 种信纸样式', d.querySelectorAll('#styleLetterOptions .style-letter-btn').length, 3);

      // 切信纸模式
      click(d.getElementById('modeLetterBtn'), w);
      await wait(80);
      check('切到信纸模式', w.MochiChat.getChatStyle('mochi').mode, 'letter');
      check('容器记录信纸模式', w.MochiChat.getAppElement().dataset.chatMode, 'letter');
      check('信纸按钮高亮', d.getElementById('modeLetterBtn').classList.contains('is-active'), 'true');
      check('面板同步透明度文案', d.getElementById('styleOpacityValue').textContent, '86%');

      // 信纸样式切换
      const gridBtn = [...d.querySelectorAll('#styleLetterOptions .style-letter-btn')]
        .filter(function (b) { return b.dataset.letter === 'grid'; })[0];
      click(gridBtn, w);
      await wait(80);
      check('信纸样式切到方格', w.MochiChat.getChatStyle('mochi').letterStyle, 'grid');
      check('容器记录方格信纸', w.MochiChat.getAppElement().dataset.letter, 'grid');

      // 回气泡模式改颜色 / 透明度 / 毛玻璃
      click(d.getElementById('modeBubbleBtn'), w);
      await wait(80);
      const chatEl = d.querySelector('.chat');
      check('回气泡模式', w.MochiChat.getAppElement().dataset.chatMode, 'bubble');

      const pink = [...d.querySelectorAll('#styleColorOptions .style-color-swatch')]
        .filter(function (b) { return b.dataset.color === '#FFE3EC'; })[0];
      click(pink, w);
      await wait(80);
      check('点色板改颜色', w.MochiChat.getChatStyle('mochi').bubbleColor, '#FFE3EC');
      check('颜色实时写进变量',
        chatEl.style.getPropertyValue('--bubble-bg'), 'rgba(255, 227, 236, 0.86)');

      const opacity = d.getElementById('styleOpacityInput');
      opacity.value = '0.5';
      opacity.dispatchEvent(new w.Event('input', { bubbles: true }));
      await wait(80);
      check('拖透明度滑块', w.MochiChat.getChatStyle('mochi').bubbleOpacity, 0.5);
      check('透明度实时写进变量',
        chatEl.style.getPropertyValue('--bubble-bg'), 'rgba(255, 227, 236, 0.5)');
      check('透明度文案跟着变', d.getElementById('styleOpacityValue').textContent, '50%');

      const glass = d.getElementById('styleGlassInput');
      glass.checked = true;
      glass.dispatchEvent(new w.Event('change', { bubbles: true }));
      await wait(80);
      check('开毛玻璃', w.MochiChat.getChatStyle('mochi').glassEffect, 'true');
      check('容器记录毛玻璃', w.MochiChat.getAppElement().dataset.glass, 'on');

      const customColor = d.getElementById('styleColorInput');
      customColor.value = '#DFF6EC';
      customColor.dispatchEvent(new w.Event('input', { bubbles: true }));
      await wait(80);
      check('取色器自定义颜色', w.MochiChat.getChatStyle('mochi').bubbleColor, '#dff6ec');

      // 关面板
      click(d.getElementById('styleCloseBtn'), w);
      await wait(80);
      check('能关闭面板', d.getElementById('stylePanel').hidden, 'true');
      click(d.getElementById('stylePanelBtn'), w);
      await wait(80);
      check('能再次打开且状态同步',
        d.getElementById('styleGlassInput').checked
        && [...d.querySelectorAll('#styleColorOptions .style-color-swatch')]
          .some(function (b) { return b.dataset.color.toLowerCase() === '#dff6ec' && b.classList.contains('is-active'); }), 'true');
      click(d.getElementById('styleCloseBtn'), w);
      await wait(50);
    }

    // ============ 四、空间内聊天不受影响 ============
    console.log('【四】聊天功能');
    {
      const before = d.querySelectorAll('#messages .bubble').length;
      const input = d.getElementById('input');
      input.value = '信纸模式下也能聊天';
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
      click(d.getElementById('sendBtn'), w);
      await wait(1200);
      check('外观改动后发送正常', d.querySelectorAll('#messages .bubble').length >= before + 2, 'true');
      check('收起逻辑没坏', w.MochiChat.isSpaceChatOpen(), 'true');
      click(d.getElementById('chatCollapseBtn'), w);
      await wait(80);
      check('仍能收起聊天', w.MochiChat.isSpaceChatOpen(), 'false');
      click(d.getElementById('dockChatBtn'), w);
      await wait(80);
      check('仍能呼出聊天', w.MochiChat.isSpaceChatOpen(), 'true');
      check('主控台 Dock 还在', !!d.getElementById('dock'), 'true');
    }

    // ============ 五、背景图上传与限制 ============
    console.log('【五】聊天背景');
    {
      const fileInput = d.getElementById('styleBgFile');
      const small = new w.File(['fake-png-bytes'], 'bg.png', { type: 'image/png' });
      setFiles(w, fileInput, small);
      fileInput.dispatchEvent(new w.Event('change', { bubbles: true }));
      await wait(400);

      let style = w.MochiChat.getChatStyle('mochi');
      check('背景转成 base64 存下来了', style.chatBackground.indexOf('data:image/png') === 0, 'true');
      check('背景层标记生效', w.MochiChat.getAppElement().classList.contains('has-chat-bg'), 'true');
      check('背景层写入图片', d.getElementById('chatBg').style.backgroundImage.indexOf('data:image/png') !== -1, 'true');

      // 超过 600KB 拒绝
      const savedBg = style.chatBackground;
      const big = new w.File([new Array(650 * 1024).join('x')], 'big.png', { type: 'image/png' });
      setFiles(w, fileInput, big);
      fileInput.dispatchEvent(new w.Event('change', { bubbles: true }));
      await wait(400);
      style = w.MochiChat.getChatStyle('mochi');
      check('超大图被拒绝', style.chatBackground, savedBg);
      check('超大图给出提示', d.getElementById('toast').textContent.includes('600KB'), 'true');

      // 清除背景
      click(d.getElementById('stylePanelBtn'), w);
      await wait(60);
      click(d.getElementById('styleClearBgBtn'), w);
      await wait(80);
      check('能清除背景', w.MochiChat.getChatStyle('mochi').chatBackground, '');
      check('背景层标记移除', w.MochiChat.getAppElement().classList.contains('has-chat-bg'), 'false');
      click(d.getElementById('styleCloseBtn'), w);
      await wait(50);
    }

    // ============ 六、持久化与互不干扰 ============
    console.log('【六】持久化与隔离');
    {
      const saved = JSON.parse(w.localStorage.getItem(SPACE_KEY));
      check('chatStyle 已落盘', typeof saved.mochi.chatStyle, 'object');
      check('落盘的模式', saved.mochi.chatStyle.mode, 'bubble');
      check('落盘的颜色', saved.mochi.chatStyle.bubbleColor, '#dff6ec');
      check('落盘的透明度', saved.mochi.chatStyle.bubbleOpacity, 0.5);
      check('落盘的毛玻璃', saved.mochi.chatStyle.glassEffect, 'true');
      check('兔子的外观没被带偏', saved.rabbit.chatStyle.mode, 'bubble');
      check('兔子的颜色是默认', saved.rabbit.chatStyle.bubbleColor, '#FFFFFF');

      // 切联系人：外观跟着换
      w.MochiChat.setChatStyle('rabbit', { mode: 'letter', bubbleColor: '#FFF3D6' });
      await wait(60);
      const items = [...d.querySelectorAll('#contactList li')];
      click(items[1], w);
      await wait(150);
      check('兔子空间是信纸模式', w.MochiChat.getAppElement().dataset.chatMode, 'letter');
      check('麻薯外观没被兔子覆盖', w.MochiChat.getChatStyle('mochi').bubbleColor, '#dff6ec');
      click(items[0], w);
      await wait(150);
      check('回麻薯还是气泡模式', w.MochiChat.getAppElement().dataset.chatMode, 'bubble');

      global.__savedSpace = w.localStorage.getItem(SPACE_KEY);
    }

    dom.window.close();
  } finally {
    await close(app.server);
  }

  // ============ 七、刷新后保持 ============
  console.log('【七】刷新后保持');
  {
    const app2 = await startApp();
    try {
      const dom = await openPage(app2, global.__savedSpace);
      await wait(2500);
      const w = dom.window, d = w.document;

      const style = w.MochiChat.getChatStyle('mochi');
      check('刷新后颜色保持', style.bubbleColor, '#dff6ec');
      check('刷新后透明度保持', style.bubbleOpacity, 0.5);
      check('刷新后毛玻璃保持', style.glassEffect, 'true');
      check('刷新后兔子是信纸', w.MochiChat.getChatStyle('rabbit').mode, 'letter');
      check('刷新后兔子颜色保持', w.MochiChat.getChatStyle('rabbit').bubbleColor, '#FFF3D6');

      const items = [...d.querySelectorAll('#contactList li')];
      click(items[0], w);
      await wait(150);
      check('刷新后进空间外观正确', w.MochiChat.getAppElement().dataset.chatMode, 'bubble');
      check('刷新后容器记录毛玻璃', w.MochiChat.getAppElement().dataset.glass, 'on');
      check('刷新后气泡变量正确',
        d.querySelector('.chat').style.getPropertyValue('--bubble-bg'), 'rgba(223, 246, 236, 0.5)');
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
