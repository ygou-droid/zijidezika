// =======================================================
// Mochi Chat · 模型服务凭据与向量请求（阶段 8 · 纯前端静态化）
//
// 阶段 8 起项目不再依赖任何 Node.js 后端：
//   · 用户在「模型服务」面板里填的云端 Key / Ollama 地址 / 模型名，
//     实时存进 localStorage（只存本地浏览器，绝不上传任何服务器）
//   · 向量请求由浏览器直接发出：
//       - 云端：POST 阿里云百炼官方接口，Authorization: Bearer <用户 Key>
//       - 本地：POST 用户填的 Ollama 地址 /api/embed
//   · 没填任何凭据时，调用方（ai-match / card-import-ui）自行降级到关键词匹配，
//     绝不发起请求、绝不弹红字报错
//
// 明文 Key 只在请求链路里存在，绝不会写进任何日志或落到本文件之外的存储。
// 测试可通过 window.__MOCK_EMBED__ 注入本地向量实现，彻底脱离后端。
// =======================================================

(function () {
  'use strict';

  const STORAGE_KEY = 'mochi-chat-custom-keys-v1';

  const CLOUD_PROVIDER_ID = 'cloud-bailian';
  const LOCAL_PROVIDER_ID = 'local-ollama';
  const CLOUD_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding';
  const CLOUD_MODEL = 'text-embedding-v4';
  const CLOUD_DIMENSIONS = 1024;
  const EMBED_TIMEOUT_MS = 15000;
  const OLLAMA_EMBED_PATH = '/api/embed';

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
      // 本地存储不可用或数据损坏：静默退回空配置（即使用关键词匹配）
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

  // 当前生效的向量供应商（纯前端判断，不再依赖后端）：
  //   · 填了云端 Key → 云端百炼
  //   · 否则填了 Ollama 地址 → 本地 Ollama
  //   · 都没填 → null（调用方应降级到关键词匹配）
  function getProvider() {
    if (state.apiKey !== '') return CLOUD_PROVIDER_ID;
    if (state.ollamaHost !== '') return LOCAL_PROVIDER_ID;
    return null;
  }

  // 当前供应商的只读身份信息（不含任何密钥 / 地址明文），用于缓存隔离与展示
  function getProviderInfo() {
    const provider = getProvider();
    if (provider === CLOUD_PROVIDER_ID) {
      return { providerId: CLOUD_PROVIDER_ID, model: CLOUD_MODEL, dimensions: CLOUD_DIMENSIONS };
    }
    if (provider === LOCAL_PROVIDER_ID) {
      return {
        providerId: LOCAL_PROVIDER_ID,
        model: state.ollamaModel !== '' ? state.ollamaModel : '本地模型',
        dimensions: null // 维度要等第一次真实响应才知道
      };
    }
    return null;
  }

  // 用供应商配置散列出一个令牌（仅用于缓存隔离，不含明文）
  function credentialsToken() {
    const p = getProvider();
    if (!p) return '';
    const raw = [p, state.apiKey, state.ollamaHost, state.ollamaModel].join('|');
    let h = 0;
    for (let i = 0; i < raw.length; i++) {
      h = (h * 31 + raw.charCodeAt(i)) >>> 0;
    }
    return h.toString(16);
  }

  // ===== 真正的向量请求（前端直连）=====
  // 返回 { embeddings: number[][], providerId, model, dimensions, credentialsToken }
  async function embed(texts) {
    const provider = getProvider();
    if (!provider) {
      const err = new Error('未配置任何模型服务（云端 Key 或本地 Ollama 地址）');
      err.code = 'no_provider';
      throw err;
    }

    // 测试钩子：完全脱离后端，由测试注入本地向量实现
    if (typeof window.__MOCK_EMBED__ === 'function') {
      const vectors = await window.__MOCK_EMBED__(texts);
      return wrap(vectors, provider, state.ollamaModel || CLOUD_MODEL);
    }

    if (provider === CLOUD_PROVIDER_ID) return wrap(await callCloud(texts), CLOUD_PROVIDER_ID, CLOUD_MODEL);
    return wrap(await callLocal(texts), LOCAL_PROVIDER_ID, state.ollamaModel || '本地模型');
  }

  function wrap(embeddings, providerId, model) {
    return {
      embeddings: embeddings,
      providerId: providerId,
      model: model,
      dimensions: embeddings && embeddings[0] ? embeddings[0].length : 0,
      credentialsToken: credentialsToken()
    };
  }

  async function callCloud(texts) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, EMBED_TIMEOUT_MS);
    try {
      const response = await fetch(CLOUD_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + state.apiKey
        },
        // 阿里云百炼 text-embedding 接口形态
        body: JSON.stringify({
          model: CLOUD_MODEL,
          input: { texts: texts },
          parameters: { dimension: CLOUD_DIMENSIONS }
        }),
        signal: controller.signal
      });
      const data = await response.json().catch(function () { return null; });
      if (!response.ok || !data || !data.output || !Array.isArray(data.output.embeddings)) {
        const code = response.status === 401 ? 'invalid_api_key'
          : response.status === 429 ? 'rate_limited'
          : 'cloud_error';
        const detail = data && (data.message || data.code) ? String(data.message || data.code) : ('HTTP ' + response.status);
        const err = new Error('云端向量请求失败：' + detail);
        err.code = code;
        throw err;
      }
      const embeddings = data.output.embeddings
        .map(function (item) { return Array.isArray(item.embedding) ? item.embedding : null; })
        .filter(Boolean);
      if (embeddings.length !== texts.length) {
        const err = new Error('云端返回的向量数量与请求不一致');
        err.code = 'dimension_mismatch';
        throw err;
      }
      return embeddings;
    } catch (error) {
      if (error && error.code) throw error;
      const timedOut = error && error.name === 'AbortError';
      const err = new Error(timedOut ? '云端向量请求超时' : ('云端向量请求失败：' + (error && error.message ? error.message : '网络错误')));
      err.code = timedOut ? 'request_timeout' : 'network_error';
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function callLocal(texts) {
    const host = state.ollamaHost.replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, EMBED_TIMEOUT_MS);
    try {
      const response = await fetch(host + OLLAMA_EMBED_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: state.ollamaModel, input: texts }),
        signal: controller.signal
      });
      const data = await response.json().catch(function () { return null; });
      if (!response.ok || !data || !Array.isArray(data.embeddings)) {
        const err = new Error('本地 Ollama 未响应：请确认服务已启动，并设置环境变量 OLLAMA_ORIGINS="*" 以允许跨域');
        err.code = 'local_unavailable';
        throw err;
      }
      const embeddings = data.embeddings;
      if (embeddings.length !== texts.length) {
        const err = new Error('本地返回的向量数量与请求不一致');
        err.code = 'dimension_mismatch';
        throw err;
      }
      return embeddings;
    } catch (error) {
      if (error && error.code) throw error;
      const timedOut = error && error.name === 'AbortError';
      const err = new Error(timedOut ? '本地 Ollama 请求超时' : '连不上本地 Ollama 服务（需设置 OLLAMA_ORIGINS="*"）');
      err.code = timedOut ? 'request_timeout' : 'local_unavailable';
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ===== UI 接线：模型服务弹窗里的输入框 =====
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

  // 凭据变化 → 立刻清空前端向量缓存（不同 Key / 地址的向量绝不共用），
  // 并让模型服务面板重新读取配置（仅前端本地判断）
  let verifyTimer = null;
  function onCredentialsChanged() {
    const ai = window.MochiChatAI;
    if (ai && typeof ai.clearCache === 'function') {
      try { ai.clearCache(); } catch (error) { /* 忽略 */ }
    }
    if (verifyTimer) clearTimeout(verifyTimer);
    verifyTimer = setTimeout(function () {
      verifyTimer = null;
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
    getProvider: getProvider,
    getProviderInfo: getProviderInfo,
    embed: embed,
    // 仅测试用：注入前端本地向量实现，彻底脱离后端
    __setEmbedOverride: function (fn) { window.__MOCK_EMBED__ = fn; }
  };
})();
