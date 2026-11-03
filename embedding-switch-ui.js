// =======================================================
// Mochi Chat · 模型服务切换面板（双模型改造 · 阶段 3.5）
//
// 只做三件事：
//   1. 读 GET /api/embedding/status   —— 当前身份与可用性
//   2. 读 GET /api/embedding/providers —— 可选供应商清单（含各自状态）
//   3. 发 POST /api/embedding/switch   —— 切换，并把结果如实显示
//
// 刻意不做的：
//   - 不展示任何 host、端口、密钥或环境变量（后端已脱敏，前端也不展示）
//   - 不自己维护一套身份/缓存作废逻辑，切换成功后调用
//     window.MochiChatAI.refreshIdentity()，复用既有的身份失效机制
//   - 不碰关键词匹配、字卡、联系人等任何既有模块
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

  const TIMEOUT_MS = 8000;

  // phase: idle | checking | switching | error | done
  const state = {
    phase: 'idle',
    providers: [],
    currentProviderId: null,
    defaultProviderId: null,
    switchingEnabled: true,
    pendingProviderId: null,
    message: '',
    errorCode: null
  };

  // 阶段 3.7：切换期间把聊天输入框锁住，避免「切换途中发出脏请求」
  let lockedBySwitch = false;
  function lockComposer(locked) {
    const input = document.getElementById('input');
    const send = document.getElementById('sendBtn');
    const composer = document.getElementById('composer');
    if (!input) return;

    if (locked) {
      if (lockedBySwitch) return; // 已经锁了就别再覆盖原始 placeholder
      if (!input.dataset.originalPlaceholder) {
        input.dataset.originalPlaceholder = input.placeholder || '';
      }
      lockedBySwitch = true;
      input.disabled = true;
      input.placeholder = '正在切换模型…';
      if (send) send.disabled = true;
      if (composer) composer.classList.add('is-switching');
      return;
    }

    if (!lockedBySwitch) return;
    lockedBySwitch = false;
    input.disabled = false;
    input.placeholder = input.dataset.originalPlaceholder || '说点什么吧…（按 Enter 发送）';
    if (send) send.disabled = false;
    if (composer) composer.classList.remove('is-switching');
  }

  function timeoutSignal() {
    if (window.AbortSignal && typeof window.AbortSignal.timeout === 'function') {
      return window.AbortSignal.timeout(TIMEOUT_MS);
    }
    return undefined;
  }

  // 阶段 5.12：把用户的自定义凭据附加到请求上
  //   · 云端 Key 走 Header（x-custom-api-key），不进 URL，也不进请求体日志
  //   · 本地地址 / 模型名走 body
  function buildRequestExtras() {
    const keys = window.MochiChatCustomKeys;
    const extras = { headers: {}, body: {} };
    if (keys && typeof keys.requestExtras === 'function') {
      const got = keys.requestExtras();
      Object.assign(extras.headers, got.headers || {});
      Object.assign(extras.body, got.body || {});
    }
    if (!extras.headers['Content-Type']) extras.headers['Content-Type'] = 'application/json';
    return extras;
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

  async function getJSON(url) {
    const response = await fetch(url, { signal: timeoutSignal() });
    const data = await response.json();
    return { ok: response.ok, data: data };
  }

  function providerText(item) {
    if (item.usable) return '可用';
    if (item.ready === false) return '未配置或未就绪';
    if (item.lastErrorCode) return '不可用';
    return '状态未知';
  }

  function failureText(data) {
    const code = data && data.code ? data.code : 'switch_failed';
    let hint = '';
    if (code === 'local_unavailable') hint = '本地服务没有响应';
    else if (code === 'local_model_missing') hint = '本地模型尚未下载';
    else if (code === 'missing_api_key') hint = '云端未配置密钥';
    else if (code === 'provider_not_ready') hint = '目标服务尚未就绪';
    else if (code === 'unknown_provider') hint = '没有这个模型服务';
    else if (code === 'switch_disabled') hint = '当前不支持切换';
    else if (code === 'invalid_input') hint = '请求参数不正确';
    const detail = data && data.message ? String(data.message) : '';
    return (hint ? hint + '：' : '') + (detail || '切换失败') + '（' + code + '）';
  }

  // 渲染清单：每张卡片一个「切换到此」按钮
  function render() {
    listEl.innerHTML = '';

    state.providers.forEach(function (item) {
      const li = document.createElement('li');
      li.className = 'provider-card' + (item.isCurrent ? ' is-current' : '');

      const head = document.createElement('div');
      head.className = 'provider-card-head';

      const name = document.createElement('span');
      name.className = 'provider-name';
      name.textContent = item.label || item.providerId;
      head.appendChild(name);

      const badge = document.createElement('span');
      badge.className = 'provider-badge' + (item.usable ? ' is-ok' : ' is-bad');
      badge.textContent = providerText(item);
      head.appendChild(badge);

      li.appendChild(head);

      const meta = document.createElement('p');
      meta.className = 'provider-meta';
      const parts = [];
      if (item.model) parts.push('模型：' + item.model);
      if (item.dimensions != null) parts.push('维度：' + item.dimensions);
      meta.textContent = parts.join(' · ') || '模型信息未知';
      li.appendChild(meta);

      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'provider-action';
      if (item.isCurrent) {
        action.textContent = '正在使用';
        action.disabled = true;
      } else if (!item.usable) {
        action.textContent = '不可切换';
        action.disabled = true;
        // 失败原因直接写在这里，用户不用点也知道为什么不能选
        if (item.lastErrorMessage) {
          const why = document.createElement('p');
          why.className = 'provider-why';
          why.textContent = item.lastErrorMessage + (item.lastErrorCode ? '（' + item.lastErrorCode + '）' : '');
          li.appendChild(why);
        }
      } else if (state.phase === 'switching' && state.pendingProviderId === item.providerId) {
        action.textContent = '切换中…';
        action.disabled = true;
      } else if (state.phase === 'switching' || state.phase === 'checking') {
        action.textContent = '切换到此';
        action.disabled = true;
      } else {
        action.textContent = '切换到此';
        action.disabled = !state.switchingEnabled;
        action.addEventListener('click', function () {
          switchTo(item.providerId);
        });
      }
      li.appendChild(action);

      listEl.appendChild(li);
    });
  }

  function renderCurrent() {
    const current = state.providers.find(function (p) { return p.isCurrent; });
    const identity = window.MochiChatAI && window.MochiChatAI.getState
      ? window.MochiChatAI.getState().activeIdentity
      : null;

    if (current) {
      const bits = ['当前：' + (current.label || current.providerId)];
      if (current.model) bits.push(current.model);
      if (current.dimensions != null) bits.push(current.dimensions + ' 维');
      bits.push(current.usable ? '可用' : '不可用');
      currentEl.textContent = bits.join(' · ');
      return;
    }
    if (identity) {
      currentEl.textContent = '当前：' + identity.providerId + ' · ' + identity.model + ' · ' + identity.dimensions + ' 维';
      return;
    }
    currentEl.textContent = '正在读取当前模型…';
  }

  // 读取状态：先 status（当前身份语义），再 providers（清单与各自状态）
  // silent = true 时只刷新数据，不动界面上的状态文字（避免把失败提示冲掉）
  async function refresh(options) {
    const settings = options || {};
    if (!settings.silent) {
      state.phase = 'checking';
      setMessage('检查中：正在确认各模型服务的状态…', 'info');
    }
    render();

    try {
      const status = await getJSON('/api/embedding/status');
      if (status.ok && status.data) {
        state.currentProviderId = status.data.currentProviderId || state.currentProviderId;
        state.defaultProviderId = status.data.defaultProviderId || state.defaultProviderId;
        if (status.data.current && status.data.current.providerId) {
          state.currentProviderId = status.data.current.providerId;
        }
      }
    } catch (error) {
      // status 读不到不影响主流程，稍后用 providers 渲染
    }

    // 阶段 5.12：填了自定义凭据时，体检必须针对用户自己的配置，
    // 改走 POST /api/embedding/test（Key 走 Header，绝不进 URL）
    const keys = window.MochiChatCustomKeys;
    const usingCustom = Boolean(keys && typeof keys.hasAny === 'function' && keys.hasAny());

    try {
      let remote;
      if (usingCustom) {
        const packed = buildRequestExtras();
        const resp = await fetch('/api/embedding/test', {
          method: 'POST',
          headers: packed.headers,
          body: JSON.stringify(packed.body),
          signal: timeoutSignal()
        });
        const data = await resp.json().catch(function () { return null; });
        remote = { ok: resp.ok, data: data };
      } else {
        remote = await getJSON('/api/embedding/providers');
      }

      const data = remote.data || {};
      if (!remote.ok || data.status !== 'ok') {
        throw new Error((data && data.message) || '供应商清单读取失败');
      }

      // test 接口与 providers 接口字段略有差异，统一成面板所需形状
      const list = usingCustom ? (data.results || []) : (data.providers || []);
      state.providers = list.map(function (item) {
        return {
          providerId: item.providerId,
          label: item.label,
          model: item.model,
          dimensions: item.dimensions,
          isCurrent: item.isCurrent === true || item.providerId === state.currentProviderId,
          usable: usingCustom
            ? (item.usable === true || item.ok === true)
            : item.usable === true,
          ready: item.ready === true,
          lastErrorCode: item.lastErrorCode || item.code || null,
          lastErrorMessage: item.lastErrorMessage || item.message || null
        };
      });
      state.currentProviderId = data.currentProviderId || state.currentProviderId;
      state.defaultProviderId = data.defaultProviderId || state.defaultProviderId;
      state.switchingEnabled = data.switchingEnabled !== false;
      if (!settings.silent) {
        state.phase = 'idle';
        setMessage('');
      }
      renderCurrent();
      render();
      return true;
    } catch (error) {
      if (!settings.silent) {
        state.phase = 'error';
        state.errorCode = 'status_unavailable';
        setMessage('读取模型服务状态失败：' + (error && error.message ? error.message : '未知错误') + '（status_unavailable）', 'error');
      }
      renderCurrent();
      render();
      return false;
    }
  }

  // 切换：先本地判定目标是否可用（检查），再发切换请求（切换中）
  async function switchTo(providerId) {
    if (state.phase === 'switching' || state.phase === 'checking') return false;

    const target = state.providers.find(function (p) { return p.providerId === providerId; });
    const label = target && target.label ? target.label : providerId;

    // 切换全过程锁住输入框：这期间发出的请求都会用错身份，一律不接受
    lockComposer(true);

    try {
      // ① 检查中：目标不可用就直接拦下，原供应商一动不动
      if (!target || !target.usable) {
        state.phase = 'error';
        state.errorCode = 'provider_not_ready';
        const why = target && target.lastErrorMessage ? target.lastErrorMessage : '目标服务尚未就绪';
        const code = target && target.lastErrorCode ? target.lastErrorCode : 'provider_not_ready';
        setMessage('检查未通过：' + label + ' 暂时不能使用，已保留当前模型。原因：' + why + '（' + code + '）', 'error');
        render();
        return false;
      }

      state.phase = 'switching';
      state.pendingProviderId = providerId;
      setMessage('检查中：正在确认 ' + label + ' 是否可用…', 'info');
      render();

      let data = null;
      try {
      const extras = buildRequestExtras();
      const response = await fetch('/api/embedding/switch', {
        method: 'POST',
        headers: extras.headers,
        body: JSON.stringify(Object.assign({ providerId: providerId }, extras.body)),
        signal: timeoutSignal()
      });
      data = await response.json();

      if (!response.ok || !data || data.status !== 'ok') {
        state.phase = 'error';
        state.errorCode = data && data.code ? data.code : 'switch_failed';
        setMessage('切换中：' + label + ' 切换失败，已保留当前模型。' + failureText(data), 'error');
        state.pendingProviderId = null;
        await refresh({ silent: true });
        return false;
      }
      } catch (error) {
        state.phase = 'error';
        state.errorCode = 'switch_failed';
        setMessage('切换中：无法连接到本地服务，已保留当前模型。（switch_failed）', 'error');
        state.pendingProviderId = null;
        await refresh({ silent: true });
        return false;
      }

      // ② 切换成功：复用既有身份失效机制，让旧向量与旧召回结果作废
      setMessage('切换中：已切到 ' + label + '，正在刷新模型身份…', 'info');
      if (window.MochiChatAI && typeof window.MochiChatAI.refreshIdentity === 'function') {
        await window.MochiChatAI.refreshIdentity();
      }

      state.pendingProviderId = null;
      await refresh({ silent: true });
      state.phase = 'done';
      const model = data && data.model ? data.model : '';
      const dims = data && data.dimensions != null ? data.dimensions + ' 维' : '';
      const detail = [model, dims].filter(Boolean).join(' · ');
      setMessage('已切换到 ' + label + (detail ? '（' + detail + '）' : '') + '，后续向量请求将使用新模型。', 'success');
      render();
      return true;
    } finally {
      // 无论成功还是失败，都要把聊天框还给用户
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

  modal.addEventListener('click', function (event) {
    if (event.target && event.target.hasAttribute && event.target.hasAttribute('data-close')) close();
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.hidden) close();
  });

  // 对外只暴露调试/测试所需的最小接口（不含任何敏感信息）
  window.MochiChatProviderUI = {
    open: open,
    close: close,
    refresh: refresh,
    switchTo: switchTo,
    getState: function () {
      return {
        phase: state.phase,
        errorCode: state.errorCode,
        message: state.message,
        currentProviderId: state.currentProviderId,
        defaultProviderId: state.defaultProviderId,
        switchingEnabled: state.switchingEnabled,
        pendingProviderId: state.pendingProviderId,
        composerLocked: lockedBySwitch,
        providers: state.providers.map(function (p) {
          return {
            providerId: p.providerId,
            label: p.label,
            model: p.model,
            dimensions: p.dimensions,
            isCurrent: p.isCurrent === true,
            usable: p.usable === true
          };
        })
      };
    }
  };
})();
