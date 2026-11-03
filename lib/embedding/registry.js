// =======================================================
// Mochi Chat · 向量供应商注册表（双模型改造 · 阶段 2）
//
// 负责：注册 → 查找 → 选择 Provider。
//
// 阶段 2 的定位：
//   · 默认仍然是【云端百炼】，不引入任何自动切换逻辑
//   · 本地 Ollama 只注册进来并可被查询，是否选用由后续阶段决定
//   · 本文件不参与网络调用，构造 Provider 是惰性的（用到才创建）
// =======================================================

'use strict';

const { createCloudBailianProvider, PROVIDER_ID: CLOUD_ID } = require('./cloud-bailian.js');
const { createOllamaProvider, PROVIDER_ID: LOCAL_ID } = require('./local-ollama.js');
const { assertProvider, describeReadiness, safeRedact } = require('./provider-contract.js');

// 默认供应商：阶段 2 起保持不变，仍然是云端百炼
const DEFAULT_PROVIDER_ID = CLOUD_ID;

// 阶段 3.3：就绪检查结果的缓存时长
//   成功 → 5 分钟（本地模型不会自己变维度，没必要反复打扰）
//   失败 → 30 秒（既避免刷屏，又能较快恢复）
const READY_TTL_OK_MS = 5 * 60 * 1000;
const READY_TTL_FAIL_MS = 30 * 1000;

function createEmbeddingRegistry(options) {
  const settings = options || {};
  const env = settings.env || {};
  const fetchImpl = settings.fetchImpl;
  // 旧注入方式（既有测试在用）传给云端供应商，保证默认行为不变
  const bailianClient = settings.bailianClient;
  // 便于测试注入时钟，用来验证缓存过期
  const now = settings.now || function () { return Date.now(); };

  const builders = {};

  builders[CLOUD_ID] = function () {
    return createCloudBailianProvider({ client: bailianClient, env: env, fetchImpl: fetchImpl });
  };

  builders[LOCAL_ID] = function () {
    return createOllamaProvider({ env: env, fetchImpl: fetchImpl });
  };

  const instances = new Map();

  // 阶段 3.4：当前生效的供应商。默认仍是云端百炼，只有显式切换才会改变
  let activeId = DEFAULT_PROVIDER_ID;
  // 切换串行化：同一时刻只允许一个切换动作，避免并发切换互相踩踏
  let switchChain = Promise.resolve();

  function build(id) {
    const factory = builders[id];
    if (!factory) return null;
    if (!instances.has(id)) instances.set(id, factory());
    return instances.get(id);
  }

  function get(id) {
    const provider = build(id);
    if (!provider) {
      throw new Error('未注册的向量供应商：' + id + '（可用：' + Object.keys(builders).join('、') + '）');
    }
    return provider;
  }

  function summaryOf(provider) {
    const info = provider.describe();
    return {
      providerId: info.providerId,
      label: info.label,
      model: info.model,
      dimensions: info.dimensions,
      ready: info.ready
    };
  }

  // 配置身份：model / endpoint（含 host）变化后，旧检查结果立即失效
  // 注意：只认「配置」，不把测量得到的维度算进来，
  // 否则测量成功会让刚写入的缓存立刻失效（维度从未知变成实测值）
  function tokenOf(provider) {
    const info = provider.describe();
    return [info.providerId, info.model, info.endpoint || ''].join('|');
  }

  // 就绪检查结果缓存与在途合并（single-flight）
  const readyCache = new Map();   // id → { status, token, expiresAt }
  const readyPending = new Map(); // id + '|' + token → Promise

  function normalizeStatus(provider, raw) {
    const info = provider.describe();
    const readiness = describeReadiness(provider);
    const ok = Boolean(raw && raw.ok === true);
    return {
      providerId: info.providerId,
      label: info.label,
      model: info.model,
      ok: ok,
      ready: readiness.ready,
      measured: readiness.measured,
      dimensionSource: readiness.dimensionSource,
      // 未知维度一律是 null，绝不用 1024 之类的默认值顶替
      dimensions: readiness.dimensions,
      usable: ok && readiness.usable,
      code: raw && raw.code ? raw.code : (ok ? null : readiness.reason),
      message: safeRedact(provider, raw && raw.message ? raw.message : ''),
      checkedAt: now()
    };
  }

  async function runCheck(provider) {
    if (typeof provider.ensureMeasured === 'function') return await provider.ensureMeasured();
    if (typeof provider.ensureReady === 'function') return await provider.ensureReady();
    // 没有就绪能力的供应商（含既有测试里的假供应商）：按结构信息判断，不发任何请求
    const info = provider.describe();
    if (!(info.dimensions > 0)) {
      return { ok: false, code: 'dimensions_unknown', message: '该供应商未提供可用维度' };
    }
    return { ok: info.ready === true, code: info.ready === true ? null : 'provider_not_ready', message: info.ready === true ? '就绪' : '供应商未就绪' };
  }

  /**
   * 阶段 3.3：统一就绪检查。
   * 先取得供应商实例（未测量也能安全取得），再执行真实探针；
   * 结果带缓存：成功 5 分钟、失败 30 秒，配置身份变化立即失效。
   */
  async function ensureReady(id) {
    const provider = assertProvider(get(id));
    const token = tokenOf(provider);

    const cached = readyCache.get(id);
    if (cached && cached.token === token && cached.expiresAt > now()) {
      return Object.assign({}, cached.status);
    }

    const key = id + '|' + token;
    if (readyPending.has(key)) return await readyPending.get(key);

    const task = (async function () {
      let raw;
      try {
        raw = await runCheck(provider);
      } catch (error) {
        raw = {
          ok: false,
          code: error && error.code ? error.code : 'local_unavailable',
          message: error && error.message ? error.message : String(error)
        };
      }
      const status = normalizeStatus(provider, raw);
      const ttl = status.ok ? READY_TTL_OK_MS : READY_TTL_FAIL_MS;
      // 期间配置若已变化，就不写缓存，避免旧结果盖住新状态
      if (tokenOf(provider) === token) {
        readyCache.set(id, { status: status, token: token, expiresAt: now() + ttl });
      }
      return status;
    })();

    readyPending.set(key, task);
    try {
      return await task;
    } finally {
      readyPending.delete(key);
    }
  }

  // 真正的切换动作：先体检，再换人；任何一步不成就原样退回
  // 阶段 5.12：statusOverride 允许调用方（自定义凭据作用域）先用
  // 自己的供应商实例完成体检并把结果交进来；闸门逻辑不变，只是不重复体检
  async function doSwitch(id, statusOverride) {
    const targetId = String(id == null ? '' : id).trim();
    const currentBefore = activeId;

    if (!builders[targetId]) {
      return {
        ok: false,
        code: 'unknown_provider',
        message: '未注册的向量供应商：' + targetId,
        providerId: targetId,
        previousProviderId: currentBefore,
        currentProviderId: currentBefore
      };
    }

    // 未就绪就不切换：未测量的 Ollama 在这里被拦下
    let status;
    if (statusOverride) {
      status = {
        ok: statusOverride.ok === true,
        usable: statusOverride.ok === true,
        code: statusOverride.code || null,
        message: statusOverride.message || '目标供应商未就绪',
        dimensions: statusOverride.dimensions == null ? null : statusOverride.dimensions
      };
    } else {
      try {
        status = await ensureReady(targetId);
      } catch (error) {
        status = {
          ok: false,
          code: error && error.code ? error.code : 'provider_not_ready',
          message: error && error.message ? error.message : String(error)
        };
      }
    }

    if (!status.ok || status.usable !== true) {
      return {
        ok: false,
        code: status.code || 'provider_not_ready',
        message: status.message || '目标供应商未就绪',
        providerId: targetId,
        previousProviderId: currentBefore,
        currentProviderId: currentBefore
      };
    }

    activeId = targetId;
    const info = get(targetId).describe();
    return {
      ok: true,
      code: null,
      message: '已切换',
      providerId: info.providerId,
      label: info.label,
      model: info.model,
      dimensions: status.dimensions,
      previousProviderId: currentBefore,
      currentProviderId: activeId,
      switchedAt: now()
    };
  }

  // 串行化：并发切换排队执行，每个调用者都能拿到自己那次的结果
  // 阶段 5.12：第二个参数为可选的外部就绪结果（自定义凭据作用域体检用）
  function switchTo(id, statusOverride) {
    const run = switchChain.then(
      function () { return doSwitch(id, statusOverride); },
      function () { return doSwitch(id, statusOverride); }
    );
    switchChain = run.then(function () { return null; }, function () { return null; });
    return run;
  }

  return {
    // 当前阶段的默认值：永远是云端百炼
    defaultId: function () { return DEFAULT_PROVIDER_ID; },

    // 选择供应商；不传 id 就用默认的云端
    select: function (id) { return get(id || DEFAULT_PROVIDER_ID); },

    // 取已注册的供应商；不存在时返回 null（不抛，方便健康检查用）
    tryGet: function (id) { return build(id); },

    get: get,

    ids: function () { return Object.keys(builders); },

    // 给 /api/health 用：列出所有供应商的基本信息
    list: function () {
      return Object.keys(builders).map(function (id) { return summaryOf(build(id)); });
    },

    // 给 /api/health 用：当前默认供应商的基本信息
    describeDefault: function () { return summaryOf(get(DEFAULT_PROVIDER_ID)); },

    // 阶段 3.3：统一就绪检查（可选能力，不影响上面的选择逻辑）
    ensureReady: ensureReady,

    // 给 /api/embedding/status 用：逐个供应商的就绪状态（只读，不含地址与密钥）
    readiness: async function () {
      const list = [];
      for (const id of Object.keys(builders)) {
        list.push(await ensureReady(id));
      }
      return list;
    },

    // 便于测试：清空就绪缓存
    clearReadyCache: function () { readyCache.clear(); },

    // ===== 阶段 3.4：运行时切换 =====
    // 当前生效的供应商 id（默认云端百炼）
    currentId: function () { return activeId; },

    // 当前生效的供应商实例：每次请求都现取，保证拿到的是切换后的那一个
    current: function () { return get(activeId); },

    /**
     * 切换到指定供应商。
     * 切换前必须先通过 ensureReady：目标未就绪就拒绝，原供应商一个字节都不动。
     * 未测量的 Ollama（维度未知）绝不可能进入正式服务状态。
     */
    switchTo: switchTo
  };
}

module.exports = {
  DEFAULT_PROVIDER_ID: DEFAULT_PROVIDER_ID,
  CLOUD_PROVIDER_ID: CLOUD_ID,
  LOCAL_PROVIDER_ID: LOCAL_ID,
  createEmbeddingRegistry: createEmbeddingRegistry
};
