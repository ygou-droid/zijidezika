// =======================================================
// Mochi Chat · 模型服务面板（阶段 8 · 纯前端静态化）
//
// 阶段 8 起已经没有后端，本面板只做两件事：
//   1. 展示当前生效的模型服务（来自用户在面板里填的 Key / 地址，前端本地判断）
//   2. 提供「测试连接」按钮，由浏览器直接发一次真实向量请求来验证配置是否可用
//
// 不再有任何后端状态检查接口（/api/embedding/status、/api/embedding/providers、
// /api/embedding/switch 都已随后端一起移除）。明文 Key 只活在请求链路里。
// =======================================================

(function () {
  'use strict';

  const modal = document.getElementById('providerModal');
  if (!modal) return; // 页面没引入这块 UI 就安静退出

  const currentEl = document.getElementById('providerCurrent');
  const listEl = document.getElementById('providerList');
  const messageEl = document.getElementById('providerMessage');
  const refreshBtn = document.getElementById('refreshProviderBtn');
  const closeBtn = document.getElementById('closeProviderBtn');
  const openBtn = document.getElementById('openProviderBtn');
  const testBtn = document.getElementById('testProviderBtn');

  const TIMEOUT_MS = 8000;

  // phase: idle | checking | testing | error | ok
  const state = {
    phase: 'idle',
    providers: [],
    currentProviderId: null,
    message: '',
    errorCode: null
  };

  // 阶段 3.7：切换 / 测试期间把聊天输入框锁住，避免「操作中发出脏请求」
  let locked = false;
  function lockComposer(isLocked) {
    const input = document.getElementById('input');
    const send = document.getElementById('sendBtn');
    const composer = document.getElementById('composer');
    if (!input) return;

    if (isLocked) {
      if (locked) return;
      if (!input.dataset.originalPlaceholder) {
        input.dataset.originalPlaceholder = input.placeholder || '';
      }
      locked = true;
      input.disabled = true;
      input.placeholder = '正在验证模型服务…';
      if (send) send.disabled = true;
      if (composer) composer.classList.add('is-switching');
      return;
    }

    if (!locked) return;
    locked = false;
    input.disabled = false;
    input.placeholder = input.dataset.originalPlaceholder || '说点什么吧…（按 Enter 发送）';
    if (send) send.disabled = false;
    if (composer) composer.classList.remove('is-switching');
  }

  function setMessage(text, kind) {
    state.message = text || '';
    if (!text) {
      messageEl.hidden = true;
      messageEl.textContent = '';
      messageEl.className = 'provider-message';
      return;
    }
    messageEl.hidden = false;
    messageEl.textContent = text;
    messageEl.className = 'provider-message' + (kind ? ' is-' + kind : '');
  }

  // 纯前端判断当前配置：返回 { providerId, label, model, dimensions, usable }
  function readProviderConfig() {
    const keys = window.MochiChatCustomKeys;
    if (!keys || typeof keys.getProviderInfo !== 'function') return null;
    return keys.getProviderInfo();
  }

  function providerLabel(info) {
    if (!info) return '未配置';
    if (info.providerId === 'cloud-bailian') return '云端百炼';
    if (info.providerId === 'local-ollama') return '本地 Ollama';
    return info.providerId;
  }

  function renderCurrent() {
    const info = readProviderConfig();
    if (!info) {
      currentEl.textContent = '当前：未配置模型服务（仅关键词匹配）';
      return;
    }
    const bits = ['当前：' + providerLabel(info)];
    if (info.model) bits.push(info.model);
    if (info.dimensions != null) bits.push(info.dimensions + ' 维');
    currentEl.textContent = bits.join(' · ');
  }

  function render() {
    listEl.innerHTML = '';
    const info = readProviderConfig();
    const detail = document.createElement('li');
    detail.className = 'provider-card' + (info ? ' is-current' : '');

    const head = document.createElement('div');
    head.className = 'provider-card-head';
    const name = document.createElement('span');
    name.className = 'provider-name';
    name.textContent = info ? providerLabel(info) : '未配置任何模型服务';
    head.appendChild(name);

    const badge = document.createElement('span');
    badge.className = 'provider-badge is-ok';
    badge.textContent = info ? '已启用（直接调用官方接口）' : '未启用';
    head.appendChild(badge);
    detail.appendChild(head);

    const meta = document.createElement('p');
    meta.className = 'provider-meta';
    if (info) {
      const parts = [];
      if (info.model) parts.push('模型：' + info.model);
      if (info.dimensions != null) parts.push('维度：' + info.dimensions);
      meta.textContent = parts.join(' · ') || '模型信息未知';
    } else {
      meta.textContent = '在上方填写云端 Key 或本地 Ollama 地址后即可启用向量召回';
    }
    detail.appendChild(meta);
    listEl.appendChild(detail);
  }

  // 读取配置并刷新界面（纯前端，不发任何网络请求）
  async function refresh() {
    state.phase = 'idle';
    state.errorCode = null;
    renderCurrent();
    render();
    setMessage('');
    return true;
  }

  // 前端连通性测试：直接发一次真实向量请求（云端 / 本地），验证配置是否可用
  async function testConnection() {
    const info = readProviderConfig();
    if (!info) {
      state.phase = 'error';
      state.errorCode = 'no_provider';
      setMessage('尚未填写任何模型服务，无法测试（请填写云端 Key 或本地 Ollama 地址）', 'error');
      return false;
    }

    state.phase = 'testing';
    setMessage('正在验证 ' + providerLabel(info) + ' 是否可用…', 'info');
    render();
    lockComposer(true);

    try {
      const keys = window.MochiChatCustomKeys;
      // 用一句固定文本做探针，拿到真实维度即可证明链路通
      const result = await keys.embed(['__mochi_connectivity_probe__']);
      const dims = result && result.embeddings && result.embeddings[0] ? result.embeddings[0].length : null;
      // 切换成功：复用既有身份失效机制，让旧向量与旧召回结果作废
      if (window.MochiChatAI && typeof window.MochiChatAI.refreshIdentity === 'function') {
        await window.MochiChatAI.refreshIdentity();
      }
      state.phase = 'ok';
      setMessage('连接成功' + (dims ? '（向量维度 ' + dims + '）' : '') + '，后续向量请求将使用 ' + providerLabel(info) + '。', 'success');
      renderCurrent();
      render();
      return true;
    } catch (error) {
      // Ollama 跨域是常见坑，给出明确提示
      const code = error && error.code ? error.code : '';
      let hint = (error && error.message) ? String(error.message) : '连接失败';
      if (code === 'local_unavailable' || /OLLAMA_ORIGINS|跨域|CORS/i.test(hint)) {
        hint = '本地 Ollama 连接失败：请确认服务已启动，并在运行 Ollama 的电脑上设置环境变量 OLLAMA_ORIGINS="*" 以允许浏览器跨域访问。';
      }
      state.phase = 'error';
      state.errorCode = code || 'test_failed';
      setMessage('连接失败：' + hint + '（' + state.errorCode + '）', 'error');
      render();
      return false;
    } finally {
      lockComposer(false);
    }
  }

  function open() {
    modal.hidden = false;
    refresh();
  }

  function close() {
    modal.hidden = true;
  }

  if (openBtn) openBtn.addEventListener('click', open);
  if (closeBtn) closeBtn.addEventListener('click', close);
  if (refreshBtn) refreshBtn.addEventListener('click', function () { refresh(); });
  if (testBtn) testBtn.addEventListener('click', function () { testConnection(); });

  modal.addEventListener('click', function (event) {
    if (event.target && event.target.hasAttribute && event.target.hasAttribute('data-close')) close();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.hidden) close();
  });

  // 对外只暴露调试 / 测试所需的最小接口（不含任何敏感信息）
  window.MochiChatProviderUI = {
    open: open,
    close: close,
    refresh: refresh,
    testConnection: testConnection,
    getState: function () {
      return {
        phase: state.phase,
        errorCode: state.errorCode,
        message: state.message,
        currentProviderId: state.currentProviderId,
        providers: state.providers.map(function (p) {
          return {
            providerId: p.providerId,
            label: p.label,
            model: p.model,
            dimensions: p.dimensions
          };
        })
      };
    }
  };
})();
