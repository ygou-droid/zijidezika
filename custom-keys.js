// =======================================================
// Mochi Chat · 自定义模型凭据（阶段 5.12）
//
// 负责三件事：
//   1. 把用户在「模型服务」面板里填的自定义 API Key / Ollama 地址 / 模型名
//      实时存进 localStorage（只存本地浏览器，不上传服务器数据库）
//   2. 在向后端发请求时，把凭据附加出去：
//        · 云端 Key 走 Request Header（x-custom-api-key），不进请求体日志
//        · Ollama 地址 / 模型名走请求体（customOllamaHost / customOllamaModel）
//   3. 凭据一旦变动：立刻清空前端向量缓存（不同 Key 的向量绝不混用），
//      并让模型服务面板重新体检，确认新配置生效
//
// 明文 Key 只在请求链路里存在，绝不会写进任何日志或落到本文件之外的存储。
// =======================================================

(function () {
  'use strict';

  const STORAGE_KEY = 'mochi-chat-custom-keys-v1';

  const state = {
    apiKey: '',
    ollamaHost: '',
    ollamaModel: ''
  };

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function load() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return;
      state.apiKey = typeof data.apiKey === 'string' ? data.apiKey : '';
      state.ollamaHost = typeof data.ollamaHost === 'string' ? data.ollamaHost : '';
      state.ollamaModel = typeof data.ollamaModel === 'string' ? data.ollamaModel : '';
    } catch (error) {
      // 本地存储不可用或数据损坏：静默退回空配置（即使用服务端默认）
    }
  }

  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        apiKey: state.apiKey,
        ollamaHost: state.ollamaHost,
        ollamaModel: state.ollamaModel
      }));
    } catch (error) {
      // 存不进去也不影响本次会话使用
    }
  }

  function get() {
    return {
      apiKey: state.apiKey,
      ollamaHost: state.ollamaHost,
      ollamaModel: state.ollamaModel
    };
  }

  function hasAny() {
    return state.apiKey !== '' || state.ollamaHost !== '' || state.ollamaModel !== '';
  }

  // 请求附加项：Key 走 Header，本地地址 / 模型名走 Body。
  // 没配置时返回空对象，调用方直接 Object.assign 即可，行为与从前完全一致
  function requestExtras() {
    const extras = { headers: {}, body: {} };
    if (state.apiKey !== '') extras.headers['x-custom-api-key'] = state.apiKey;
    if (state.ollamaHost !== '') extras.body.customOllamaHost = state.ollamaHost;
    if (state.ollamaModel !== '') extras.body.customOllamaModel = state.ollamaModel;
    return extras;
  }

  // ===== UI 接线：模型服务弹窗里的三个输入框 =====
  const apiKeyInput = document.getElementById('customApiKeyInput');
  const apiKeyToggle = document.getElementById('customApiKeyToggle');
  const hostInput = document.getElementById('customOllamaHostInput');
  const modelInput = document.getElementById('customOllamaModelInput');
  const providerModal = document.getElementById('providerModal');

  function syncInputs() {
    if (apiKeyInput) apiKeyInput.value = state.apiKey;
    if (hostInput) hostInput.value = state.ollamaHost;
    if (modelInput) modelInput.value = state.ollamaModel;
  }

  // 凭据变化 → 立刻清空前端向量缓存（不同 Key 的向量绝不能共用）；
  // 再让模型服务面板重新体检，确认新配置生效
  let verifyTimer = null;
  function onCredentialsChanged() {
    const ai = window.MochiChatAI;
    if (ai && typeof ai.clearCache === 'function') {
      try { ai.clearCache(); } catch (error) { /* 忽略 */ }
    }
    if (verifyTimer) clearTimeout(verifyTimer);
    verifyTimer = setTimeout(function () {
      verifyTimer = null;
      // 只在面板还开着时体检，避免无谓的网络请求
      const panel = window.MochiChatProviderUI;
      if (panel && typeof panel.refresh === 'function' && providerModal && !providerModal.hidden) {
        panel.refresh();
      }
    }, 700);
  }

  function bindInput(input, field) {
    if (!input) return;
    input.addEventListener('input', function () {
      state[field] = clean(input.value);
      save();
      onCredentialsChanged();
    });
  }

  load();
  syncInputs();
  bindInput(apiKeyInput, 'apiKey');
  bindInput(hostInput, 'ollamaHost');
  bindInput(modelInput, 'ollamaModel');

  // 密码框显示 / 隐藏切换
  if (apiKeyToggle && apiKeyInput) {
    apiKeyToggle.addEventListener('click', function () {
      const hidden = apiKeyInput.type === 'password';
      apiKeyInput.type = hidden ? 'text' : 'password';
      apiKeyToggle.textContent = hidden ? '隐藏' : '显示';
    });
  }

  window.MochiChatCustomKeys = {
    get: get,
    hasAny: hasAny,
    requestExtras: requestExtras
  };
})();
