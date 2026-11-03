// =======================================================
// Mochi Chat · 本地后端
// 第一步：静态托管现有前端页面 + GET /api/health
// 第二步：POST /api/embed（调用阿里云百炼 text-embedding-v4，密钥只在服务端）
// =======================================================

const express = require('express');
const {
  MODEL: EMBEDDING_MODEL
} = require('./lib/bailian.js');
const { createEmbeddingCache, validateTexts, ValidationError } = require('./lib/vector.js');
// 双模型改造 · 统一向量供应商接口（阶段 1 抽出，阶段 2 加入注册表，阶段 3.3 加就绪校验）
const { assertProvider, describeReadiness, safeRedact } = require('./lib/embedding/provider-contract.js');
const { createEmbeddingRegistry, DEFAULT_PROVIDER_ID, CLOUD_PROVIDER_ID, LOCAL_PROVIDER_ID } = require('./lib/embedding/registry.js');
const { createCloudBailianProvider } = require('./lib/embedding/cloud-bailian.js');
const { createOllamaProvider } = require('./lib/embedding/local-ollama.js');
// 阶段 5.12：自定义凭据（读取 / 规范化 / 散列令牌，明文绝不进日志与响应）
const {
  readCustomCredentials,
  hasCustomCredentials,
  customCredentialsToken,
  affectsProvider
} = require('./lib/embedding/custom-credentials.js');

const startedAt = Date.now();

// 这些文件只允许留在服务器上，禁止通过浏览器访问
const BLOCKED_PATHS = [
  '/.env',
  '/.env.example',
  '/.gitignore',
  '/package.json',
  '/package-lock.json',
  '/server.js',
  '/node_modules',
  '/lib'
];

// 阶段 3.4：对外文案里不允许出现内部地址（host / 端口 / 完整 URL）
// 例如本地 Ollama 的错误原文里会带 http://127.0.0.1:11434，这里统一抹掉
// 第二条规则处理「无协议 host:port」形态（如 0.0.0.0:11434）：
//   - IPv4 要求完整四段，避免误伤时间里的 15:50；
//   - 域名必须以字母开头，且前面不能紧跟字母/数字/点/冒号等，
//     因此 ISO 时间 2026-11-02T15:50:59 里的 T15:50 不会被当成 host。
//   - 两个端口分支都要求前后不是数字，不会把维度、错误码、序号错切掉。
function redactAddresses(text) {
  return String(text == null ? '' : text)
    .replace(/https?:\/\/[^\s'"），,）]+/g, '***')
    .replace(
      /(?<![A-Za-z0-9_.:@-])(?:\d{1,3}(?:\.\d{1,3}){3}|[a-zA-Z][\w-]*(?:\.[\w-]+)*):\d{1,5}(?!\d)/g,
      '***'
    );
}

// 把上游错误映射为合适的 HTTP 状态码
function statusForEmbedError(code) {
  if (code === 'missing_api_key') return 503;
  if (code === 'invalid_input' || code === 'dimension_mismatch') return 400;
  return 502;
}

function createApp(options) {
  const settings = options || {};
  const env = settings.env || process.env;
  const app = express();

  // 允许测试注入：
  //   registry      → 注入自定义注册表
  //   provider      → 直接指定当前供应商
  //   bailianClient → 旧写法，注入百炼客户端（既有测试仍在用，会包成云端供应商）
  // 正式运行时：注册表默认选中【云端百炼】，本阶段不会自动切换到 Ollama
  const registry = settings.registry || createEmbeddingRegistry({
    env: env,
    fetchImpl: settings.fetchImpl,
    bailianClient: settings.bailianClient
  });
  // 外部注入的供应商（测试用）优先级最高，且不支持运行时切换
  const pinnedProvider = settings.provider ? assertProvider(settings.provider) : null;
  // 未注入时才由注册表选择，并保持与过去一致的启动校验
  if (!pinnedProvider) assertProvider(registry.select(DEFAULT_PROVIDER_ID));

  // 每次请求现取「当前生效的供应商」：切换后立刻生效，
  // 且一条请求内部从头到尾只用这一份快照
  function currentProvider() {
    return pinnedProvider || registry.current();
  }

  // ===== 阶段 5.12：自定义凭据作用域 =====
  // 同一份凭据只构建一套供应商实例（按凭据令牌记忆化）：
  //   · 凭据变化 → 新令牌 → 新实例，旧测量结果自然作废（configToken 含 host / model）
  //   · 明文 Key 只存在于实例内部，与 .env 的 Key 同等待遇：绝不写日志、不进响应
  //   · 凭据与该供应商无关 / 为空 → 返回注册表原实例，行为与从前完全一致
  const CUSTOM_SCOPE_LIMIT = 8; // 防御性上限：异常请求也堆不出无限实例
  const customScopes = new Map(); // credentialsToken → provider 实例

  function scopedProviderFor(providerId, credentials) {
    if (!affectsProvider(providerId, credentials)) return registry.tryGet(providerId);

    const token = customCredentialsToken(credentials);
    if (customScopes.has(token)) return customScopes.get(token);

    let provider;
    if (providerId === CLOUD_PROVIDER_ID) {
      provider = createCloudBailianProvider({
        env: env,
        fetchImpl: settings.fetchImpl,
        // 空 Key 不覆盖：仍回退 .env 默认（affectsProvider 已保证非空，这里双保险）
        apiKey: credentials.apiKey !== '' ? credentials.apiKey : undefined
      });
    } else if (providerId === LOCAL_PROVIDER_ID) {
      provider = createOllamaProvider({
        env: env,
        fetchImpl: settings.fetchImpl,
        host: credentials.ollamaHost !== '' ? credentials.ollamaHost : undefined,
        model: credentials.ollamaModel !== '' ? credentials.ollamaModel : undefined
      });
    } else {
      return registry.tryGet(providerId);
    }

    customScopes.set(token, provider);
    if (customScopes.size > CUSTOM_SCOPE_LIMIT) {
      // 挤掉最旧的作用域，防止异常客户端制造无限实例
      customScopes.delete(customScopes.keys().next().value);
    }
    return provider;
  }

  const cache = settings.cache || createEmbeddingCache({
    maxEntries: settings.cacheMaxEntries || 500,
    ttlMs: settings.cacheTtlMs || 10 * 60 * 1000
  });

  app.use(express.json({ limit: '1mb' }));

  app.use(function (req, res, next) {
    const target = req.path.toLowerCase();
    const blocked = BLOCKED_PATHS.some(function (item) {
      return target === item || target.startsWith(item + '/');
    });
    if (blocked) {
      return res.status(403).type('text/plain; charset=utf-8').send('禁止访问该文件');
    }
    next();
  });

  // ===== GET /api/health：服务自检 =====
  app.get('/api/health', function (req, res) {
    const info = currentProvider().describe();

    // dashscopeApiKey / apiKeyConfigured 描述的是「云端密钥有没有配」，含义与过去一致
    const cloud = registry.tryGet(CLOUD_PROVIDER_ID);
    const cloudReady = cloud ? cloud.describe().hasApiKey === true : false;
    // 自定义注入的供应商（测试用）沿用原有规则：看当前供应商是否就绪
    const isKnownProvider = registry.ids().indexOf(info.providerId) >= 0;
    const keyConfigured = isKnownProvider ? cloudReady : info.ready === true;

    res.json({
      status: 'ok',
      message: 'Mochi Chat 后端运行正常',
      service: 'mochi-chat-server',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      node: process.version,
      // 只返回「有没有配置」，绝不返回密钥内容
      // 注：JSON 里的字段名 dashscopeApiKey 是历史遗留，为保证对外兼容保持不变
      dashscopeApiKey: keyConfigured ? '已配置' : '未配置',
      embedding: {
        endpoint: 'POST /api/embed',
        model: info.model || EMBEDDING_MODEL,
        // 阶段 3.3：未测量就是 null，不再用 1024 之类的默认值顶替
        // （云端恒为官方声明的 1024，既有行为不受影响）
        dimensions: info.dimensions == null ? null : info.dimensions,
        maxTextsPerRequest: info.maxTexts || 10,
        apiKeyConfigured: keyConfigured
      },
      cache: cache.stats ? cache.stats() : null,
      features: {
        staticHosting: true,
        // 表示该接口已经实现并注册；是否真的能调用成功取决于密钥与网络
        embeddingApi: true,
        embeddingVerified: false // 未经真实调用验证前保持 false
      },
      // 阶段 2 新增：当前供应商与全部已注册供应商（只含标识与是否就绪，不含任何地址或密钥）
      provider: {
        id: info.providerId,
        label: info.label,
        model: info.model,
        dimensions: info.dimensions,
        ready: info.ready
      },
      availableProviders: registry.list()
    });
  });

  // ===== GET /api/embedding/status：只读的向量服务状态（阶段 3.3）=====
  // 只输出标识与状态：不含任何 host、地址、密钥或环境变量值
  app.get('/api/embedding/status', async function (req, res) {
    let list = [];
    let error = null;
    try {
      list = await registry.readiness();
    } catch (e) {
      error = redactAddresses(safeRedact(currentProvider(), e && e.message ? e.message : String(e)));
    }

    const info = currentProvider().describe();
    const readiness = describeReadiness(currentProvider());

    res.json({
      status: error ? 'error' : 'ok',
      service: 'mochi-chat-server',
      timestamp: new Date().toISOString(),
      // 当前供应商
      current: {
        providerId: info.providerId,
        label: info.label,
        model: info.model,
        ready: readiness.ready,
        measured: readiness.measured,
        dimensionSource: readiness.dimensionSource,
        dimensions: readiness.dimensions,
        usable: readiness.usable
      },
      defaultProviderId: registry.defaultId(),
      // 全部已注册供应商：逐个给出可用性与维度来源
      providers: list.map(function (item) {
        return {
          providerId: item.providerId,
          label: item.label,
          model: item.model,
          available: item.ok === true,
          ready: item.ready === true,
          measured: item.measured === true,
          dimensionSource: item.dimensionSource,
          dimensions: item.dimensions == null ? null : item.dimensions,
          usable: item.usable === true,
          lastCheckedAt: item.checkedAt ? new Date(item.checkedAt).toISOString() : null,
          lastErrorCode: item.code || null,
          // 已脱敏：不带密钥、不带 host 或端口等内部地址
          lastErrorMessage: item.message ? redactAddresses(item.message) : null
        };
      }),
      error: error
    });
  });

  // ===== GET /api/embedding/providers：可选的向量供应商（阶段 3.4，只读）=====
  // 只输出标识与状态：不含 host、端口、密钥或环境变量值
  app.get('/api/embedding/providers', async function (req, res) {
    let list = [];
    let error = null;
    try {
      list = await registry.readiness();
    } catch (e) {
      error = redactAddresses(safeRedact(currentProvider(), e && e.message ? e.message : String(e)));
    }

    const currentId = currentProvider().describe().providerId;
    res.json({
      status: error ? 'error' : 'ok',
      service: 'mochi-chat-server',
      timestamp: new Date().toISOString(),
      // 默认供应商（启动时的选择）与当前生效供应商（可能被切换过）
      defaultProviderId: registry.defaultId(),
      currentProviderId: currentId,
      // 外部注入供应商时不提供切换能力（测试场景）
      switchingEnabled: !pinnedProvider,
      providers: list.map(function (item) {
        return {
          providerId: item.providerId,
          label: item.label,
          model: item.model,
          isCurrent: item.providerId === currentId,
          available: item.ok === true,
          ready: item.ready === true,
          measured: item.measured === true,
          dimensionSource: item.dimensionSource,
          dimensions: item.dimensions == null ? null : item.dimensions,
          usable: item.usable === true,
          lastErrorCode: item.code || null,
          lastErrorMessage: item.message ? redactAddresses(item.message) : null
        };
      }),
      error: error
    });
  });

  // ===== POST /api/embedding/switch：运行时切换供应商（阶段 3.4）=====
  // 请求体：{ "providerId": "local-ollama" }
  // 目标未就绪（含未测量的 Ollama）时拒绝切换，当前供应商保持不变
  app.post('/api/embedding/switch', async function (req, res) {
    const targetId = req.body && req.body.providerId;

    if (typeof targetId !== 'string' || targetId.trim() === '') {
      return res.status(400).json({
        status: 'error',
        code: 'invalid_input',
        message: '请在请求体中提供 providerId',
        currentProviderId: currentProvider().describe().providerId
      });
    }

    if (pinnedProvider) {
      return res.status(409).json({
        status: 'error',
        code: 'switch_disabled',
        message: '当前服务由外部注入供应商，不支持运行时切换',
        currentProviderId: pinnedProvider.describe().providerId
      });
    }

    // 阶段 5.12：带自定义凭据体检 —— 用户自己的 Ollama 地址 / 百炼 Key
    // 也要能通过切换闸门。体检用凭据作用域实例完成，切换动作本身仍走注册表串行队列。
    const credentials = readCustomCredentials(req);
    let scopedStatus = null;
    if (affectsProvider(targetId, credentials)) {
      const scoped = scopedProviderFor(targetId, credentials);
      if (scoped) {
        try {
          const raw = await assertProvider(scoped).ensureMeasured();
          scopedStatus = {
            ok: raw && raw.ok === true,
            code: raw && raw.code ? raw.code : null,
            message: raw && raw.message ? raw.message : '',
            dimensions: raw && raw.dimensions != null ? raw.dimensions : null
          };
        } catch (error) {
          scopedStatus = {
            ok: false,
            code: error && error.code ? error.code : 'provider_not_ready',
            message: error && error.message ? error.message : String(error),
            dimensions: null
          };
        }
      }
    }

    let result;
    try {
      result = await registry.switchTo(targetId, scopedStatus);
    } catch (error) {
      return res.status(503).json({
        status: 'error',
        code: error && error.code ? error.code : 'switch_failed',
        message: redactAddresses(safeRedact(currentProvider(), error && error.message ? error.message : String(error))),
        currentProviderId: currentProvider().describe().providerId
      });
    }

    if (!result.ok) {
      return res.status(503).json({
        status: 'error',
        code: result.code,
        // 已脱敏：不带密钥、不带 host
        message: redactAddresses(result.message || '目标供应商未就绪'),
        providerId: result.providerId,
        previousProviderId: result.previousProviderId,
        currentProviderId: result.currentProviderId
      });
    }

    res.json({
      status: 'ok',
      message: '已切换向量供应商',
      providerId: result.providerId,
      label: result.label,
      model: result.model,
      dimensions: result.dimensions,
      previousProviderId: result.previousProviderId,
      currentProviderId: result.currentProviderId,
      switchedAt: new Date(result.switchedAt).toISOString()
    });
  });

  // ===== POST /api/embedding/test：用「用户自定义凭据」体检（阶段 5.12）=====
  // 请求体：{ customOllamaHost, customOllamaModel }，Header：x-custom-api-key
  // 逐个体检全部已注册供应商（有相关自定义项时用凭据作用域实例，否则用注册表原实例）。
  // 云端体检不发网络请求（只看 Key 是否配置）；本地发一条极短探针测出真实维度。
  // 响应只含标识 / 状态 / 脱敏后的错误说明，绝不包含 Key 或明文凭据。
  app.post('/api/embedding/test', async function (req, res) {
    const credentials = readCustomCredentials(req);
    const currentId = currentProvider().describe().providerId;

    const results = [];
    const ids = registry.ids();
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const provider = affectsProvider(id, credentials)
        ? scopedProviderFor(id, credentials)
        : registry.tryGet(id);
      if (!provider) continue;

      let raw;
      try {
        raw = await provider.ensureMeasured();
      } catch (error) {
        raw = {
          ok: false,
          code: error && error.code ? error.code : 'check_failed',
          message: error && error.message ? error.message : String(error)
        };
      }

      const info = provider.describe();
      const readiness = describeReadiness(provider);
      results.push({
        providerId: info.providerId,
        label: info.label,
        model: info.model,
        isCurrent: info.providerId === currentId,
        ok: raw && raw.ok === true,
        ready: readiness.ready,
        measured: readiness.measured,
        dimensionSource: readiness.dimensionSource,
        dimensions: readiness.dimensions == null ? null : readiness.dimensions,
        usable: raw && raw.ok === true && readiness.usable === true,
        code: raw && raw.code ? raw.code : null,
        // 已脱敏：不带密钥、不带 host 或端口等内部地址
        message: raw && raw.message
          ? redactAddresses(safeRedact(provider, String(raw.message)))
          : null
      });
    }

    res.json({
      status: 'ok',
      service: 'mochi-chat-server',
      timestamp: new Date().toISOString(),
      usingCustomCredentials: hasCustomCredentials(credentials),
      currentProviderId: currentId,
      results: results
    });
  });

  // ===== POST /api/embed：把文本转成向量 =====
  // 请求：{ "texts": ["文本1", "文本2"] }（一次最多 10 条，每条必须是非空字符串）
  // 阶段 5.12：Header 可带 x-custom-api-key，Body 可带 customOllamaHost / customOllamaModel；
  // 全部为空时行为与从前完全一致（回退 .env 默认配置）
  app.post('/api/embed', async function (req, res) {
    // 阶段 5.12：读取自定义凭据。令牌只有散列，进缓存身份但不进日志与响应原文
    const credentials = readCustomCredentials(req);
    const credentialsTokenValue = customCredentialsToken(credentials);

    // 开局快照：本次请求只认这一份供应商与身份，
    // 即便期间发生了切换，这条请求从头到尾也保持一致
    let activeProvider = currentProvider();

    // 阶段 5.12：凭据作用域命中 → 换成「按用户自定义配置」构建的同类型供应商实例。
    // 外部注入供应商（测试场景）不参与凭据覆盖，保持既有行为
    const usingScopedCredentials = !pinnedProvider &&
      affectsProvider(activeProvider.describe().providerId, credentials);
    if (usingScopedCredentials) {
      const scoped = scopedProviderFor(activeProvider.describe().providerId, credentials);
      if (scoped) activeProvider = assertProvider(scoped);
    }

    // 阶段 5.12：本地 + 自定义配置 → 维度未知时先发一次真实探针，
    // 让首条请求就能用（而不是被「尚未测量」闸门挡下再让用户手动体检）。
    // 只对凭据作用域实例生效，注册表原实例保持原有「不测量就拒绝」的行为
    if (usingScopedCredentials &&
      activeProvider.describe().providerId === LOCAL_PROVIDER_ID &&
      describeReadiness(activeProvider).measured !== true &&
      typeof activeProvider.ensureMeasured === 'function') {
      try {
        await activeProvider.ensureMeasured();
      } catch (error) {
        // 探针失败不在这里终结请求，交给下方统一闸门给出人话错误
      }
    }

    const info = activeProvider.describe();
    const model = info.model;
    // 维度只认供应商自己报的值：未测量就是 null，绝不用默认值冒充实测值
    const declaredDimensions = info.dimensions == null ? null : info.dimensions;
    let actualDimensions = declaredDimensions;

    // 缓存身份 = providerId + model + dimensions + 凭据令牌
    // 读缓存与写缓存必须共用这一份身份，否则会串味；
    // 凭据令牌保证不同 Key 产生的向量绝不共用缓存
    const identity = {
      providerId: info.providerId,
      model: model,
      dimensions: declaredDimensions,
      credentials: credentialsTokenValue
    };

    // 阶段 3.3：就绪闸门。未测量（维度未知）的供应商不能处理正式请求，
    // 也不能把 1024 之类的默认值当成维度写进缓存
    const readiness = describeReadiness(activeProvider);
    if (!(declaredDimensions > 0) || readiness.measured !== true) {
      return res.status(503).json({
        status: 'error',
        code: 'provider_not_ready',
        message: readiness.reason === 'not_measured'
          ? '当前向量供应商尚未完成维度测量，请先确认服务可用后再试'
          : '当前向量供应商尚未就绪（维度未知），请先完成可用性检查',
        providerId: info.providerId,
        model: model,
        dimensions: declaredDimensions
      });
    }

    let texts;
    try {
      texts = validateTexts(req.body && req.body.texts, {
        maxCount: info.maxTexts,
        maxLength: info.maxTextLength
      });
    } catch (error) {
      // 输入校验失败：400
      return res.status(400).json({
        status: 'error',
        code: error.code || 'invalid_input',
        message: error.message
      });
    }

    // 先看缓存，只把没命中的文本发给上游
    const embeddings = new Array(texts.length);
    const missing = [];
    texts.forEach(function (text, position) {
      const cached = cache.get(text, identity);
      if (cached === undefined) missing.push({ position: position, text: text });
      else embeddings[position] = cached;
    });

    let fromCache = texts.length - missing.length;

    if (missing.length > 0) {
      try {
        const result = await activeProvider.embedTexts(missing.map(function (item) {
          return item.text;
        }));
        const received = Array.isArray(result && result.embeddings) ? result.embeddings : [];
        let rejected = 0;
        missing.forEach(function (item, index) {
          const vector = received[index];
          embeddings[item.position] = vector;
          // 写入前校验：长度必须与声明维度一致。
          // 不一致说明来源不可信（例如切模型途中），宁可不缓存也不能让脏向量混进来
          if (Array.isArray(vector) && vector.length === declaredDimensions) {
            cache.set(item.text, identity, vector);
          } else {
            rejected++;
          }
        });
        if (rejected > 0) {
          console.error('[api/embed] 有 ' + rejected + ' 条向量维度与声明不一致，已跳过写入缓存'
            + '（声明 ' + declaredDimensions + ' 维）');
        }
        if (result && result.dimensions) actualDimensions = result.dimensions;
      } catch (error) {
        const code = error.code || 'embedding_failed';
        // 二次脱敏后再写日志、再返回给前端，绝不泄露密钥
        const safeMessage = safeRedact(activeProvider, error && error.message ? error.message : '');
        console.error('[api/embed] 调用失败 code=' + code + ' message=' + safeMessage);
        return res.status(statusForEmbedError(code)).json({
          status: 'error',
          code: code,
          message: safeMessage || '调用阿里云百炼失败'
        });
      }
    }

    res.json({
      status: 'ok',
      // 阶段 3.1 新增：告诉前端这批向量来自哪个供应商（旧字段一个不少）
      providerId: info.providerId,
      model: model,
      dimensions: actualDimensions,
      // 阶段 5.12：本次使用的凭据令牌（只有散列，无明文）。
      // 前端把它并进向量身份，不同 Key 的向量绝不共用前端缓存
      credentialsToken: credentialsTokenValue,
      count: embeddings.length,
      embeddings: embeddings,
      cachedCount: fromCache,
      requestedCount: texts.length
    });
  });

  // 未实现的 /api 接口统一返回 404 JSON
  app.use('/api', function (req, res) {
    res.status(404).json({
      status: 'error',
      message: '接口不存在：' + req.method + ' ' + req.originalUrl
    });
  });

  // ===== 静态托管现有页面（不改动任何前端文件）=====
  app.use(express.static(__dirname, {
    index: 'index.html',
    extensions: ['html'],
    dotfiles: 'deny'
  }));

  return app;
}

module.exports = { createApp: createApp, redactAddresses: redactAddresses };

// 直接 node server.js 时才真的监听端口（被 require 时不会启动）
if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  // 默认监听所有网络接口（0.0.0.0），让局域网内的手机 / 其他设备也能访问；
  // 仍可用 HOST 环境变量覆盖（例如 HOST=127.0.0.1 仅本机）
  const HOST = process.env.HOST || '0.0.0.0';

  const server = createApp().listen(PORT, HOST, function () {
    console.log('');
    console.log('  Mochi Chat 已启动');
    console.log('  本机访问：  http://127.0.0.1:' + PORT + '/');
    console.log('  局域网访问： http://<本机局域网 IP>:' + PORT + '/（同 Wi-Fi 下的手机可访问）');
    console.log('  健康检查：  http://' + HOST + ':' + PORT + '/api/health');
    console.log('  停止服务：  在终端里按 Ctrl + C');
    console.log('');
  });

  server.on('error', function (error) {
    if (error.code === 'EADDRINUSE') {
      console.error('端口 ' + PORT + ' 已被占用，请换个端口，例如：PORT=3001 npm start');
    } else {
      console.error('启动失败：', error.message);
    }
    process.exit(1);
  });
}
