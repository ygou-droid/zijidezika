// =======================================================
// Mochi Chat · Ollama 本地向量供应商（双模型改造 · 阶段 2）
//
// 通过本地 Ollama 服务调用开源 Embedding 模型（例如 Qwen3-Embedding-0.6B）。
// 遵守 lib/embedding/provider-contract.js 的约定。
//
// 重要：向量维度一律以 Ollama 实际返回值为准，绝不在代码里写死某个数字。
// 维度未知的阶段（还没有进行过任何一次调用）用 null 表示，
// 调用过一次后就记录真实维度，供 describe() 与 /api/health 使用。
//
// 本机地址、模型名、超时等全部来自配置（环境变量），不需要密钥即可运行。
// =======================================================

'use strict';

const PROVIDER_ID = 'local-ollama';
const PROVIDER_LABEL = '本地 Ollama';

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen3-embedding:0.6b';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_TEXTS = 10;
const DEFAULT_MAX_TEXT_LENGTH = 8192;

function OllamaError(code, message, extra) {
  const error = new Error(message);
  error.name = 'OllamaError';
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

function normalizeHost(value) {
  let host = String(value == null ? '' : value).trim();
  if (host === '') return DEFAULT_HOST;
  while (host.length > 1 && host.slice(-1) === '/') host = host.slice(0, -1);
  // 只写 host:port 时补上协议：fetch 需要完整 URL，
  // 否则会把「服务未启动」误报成 Failed to parse URL
  if (!/^https?:\/\//i.test(host)) host = 'http://' + host;
  return host;
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function createOllamaProvider(options) {
  const settings = options || {};
  const env = settings.env || {};

  const host = normalizeHost(
    settings.host !== undefined && settings.host !== null ? settings.host : env.OLLAMA_HOST
  );
  const model = String(
    settings.model !== undefined && settings.model !== null ? settings.model : (env.OLLAMA_MODEL || DEFAULT_MODEL)
  ).trim();
  const timeoutMs = Number(settings.timeoutMs || env.OLLAMA_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const maxTexts = positiveInt(settings.maxTexts || env.OLLAMA_MAX_TEXTS) || DEFAULT_MAX_TEXTS;
  const maxTextLength = positiveInt(settings.maxTextLength || env.OLLAMA_MAX_TEXT_LENGTH) || DEFAULT_MAX_TEXT_LENGTH;

  // 可选：极少数情况下 Ollama 前面会挂一层带鉴权的代理
  const apiKey = String(
    settings.apiKey !== undefined && settings.apiKey !== null ? settings.apiKey : (env.OLLAMA_API_KEY || '')
  ).trim();

  // 允许显式声明维度（不声明也能用，首次调用后会自动识别）
  const configuredDimensions = positiveInt(
    settings.dimensions !== undefined && settings.dimensions !== null ? settings.dimensions : env.OLLAMA_DIMENSIONS
  );

  const fetchImpl = settings.fetchImpl || (function (url, init) { return fetch(url, init); });

  const endpoint = host + '/api/embed';
  const legacyEndpoint = host + '/api/embeddings';
  const secrets = apiKey ? [apiKey] : [];

  // 首次调用后写入，之后 describe() 就能报告真实维度
  let measuredDimensions = null;

  // 阶段 3.3：测量状态
  //   measurement → 最近一次成功的测量结果 { dimensions, token, measuredAt }
  //   measuring   → 同一配置下的在途测量（single-flight）
  //   seq         → 单调递增，用来丢弃「晚回来的旧测量」
  let measurement = null;
  let measuring = null;
  let measurementSeq = 0;

  // 配置身份：model / host 任一变化，旧测量结果立即失效
  function configToken() {
    return PROVIDER_ID + '|' + model + '|' + host;
  }

  function knownDimensions() {
    return measuredDimensions || configuredDimensions || null;
  }

  function describe() {
    return {
      providerId: PROVIDER_ID,
      label: PROVIDER_LABEL,
      model: model,
      // null 表示「还没测过」；调用过一次后就是 Ollama 实际返回的维度
      dimensions: knownDimensions(),
      endpoint: endpoint,
      maxTexts: maxTexts,
      maxTextLength: maxTextLength,
      timeoutMs: timeoutMs,
      // 本地服务不需要密钥，只要配了模型就具备运行条件
      ready: model !== '',
      // 兼容字段：server.js 用它判断云端密钥状态，本地模式恒为 false
      hasApiKey: false,
      // 阶段 3.3：维度是不是「真发过探针测出来的」，禁止用声明值冒充实测值
      measured: measuredDimensions !== null,
      dimensionSource: measuredDimensions !== null ? 'measured' : 'unknown'
    };
  }

  function redact(text) {
    let result = String(text == null ? '' : text);
    secrets.forEach(function (secret) {
      if (secret) result = result.split(secret).join('***');
    });
    return result;
  }

  function buildHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    return headers;
  }

  async function request(url, payload) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      // 连不上、被拒绝、超时都归到「本地服务不可用」，绝不中断聊天主流程
      throw OllamaError(
        'local_unavailable',
        '无法连接本地 Ollama（' + host + '）：' + redact(error && error.message ? error.message : String(error))
      );
    }

    const ok = typeof response.ok === 'boolean'
      ? response.ok
      : (response.status >= 200 && response.status < 300);

    if (!ok) {
      let detail = '';
      try {
        detail = redact(String(await response.text() || '').slice(0, 300));
      } catch (error) {
        detail = '无法读取上游返回内容';
      }

      if (response.status === 404) {
        // 404 有两种可能：模型没拉取，或者 Ollama 版本太旧没有 /api/embed
        // 先按「模型缺失」报错并带上 pull 命令，调用方会视情况退回旧接口再试
        throw OllamaError(
          'local_model_missing',
          '本地 Ollama 返回 HTTP 404：' + detail + '（请确认已执行 ollama pull ' + model + '）',
          { httpStatus: 404, detail: detail }
        );
      }

      throw OllamaError('http_error', '本地 Ollama 返回错误 HTTP ' + response.status + '：' + detail, {
        httpStatus: response.status
      });
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw OllamaError('invalid_response', '无法解析本地 Ollama 返回的内容（不是合法 JSON）');
    }
    return data;
  }

  function normalizeEmbeddings(data, expectedLength) {
    let list = null;
    if (data && Array.isArray(data.embeddings)) list = data.embeddings;
    else if (data && Array.isArray(data.embedding)) list = [data.embedding];

    if (!list) {
      throw OllamaError('invalid_response', '本地 Ollama 返回内容中缺少 embeddings 字段');
    }
    if (list.length !== expectedLength) {
      throw OllamaError(
        'invalid_response',
        '返回的向量数量与请求不一致（请求 ' + expectedLength + ' 条，返回 ' + list.length + ' 条）'
      );
    }

    const result = [];
    let detected = null;
    list.forEach(function (vector, position) {
      if (!Array.isArray(vector) || vector.length === 0) {
        throw OllamaError('invalid_response', '第 ' + position + ' 条结果缺少可用的 embedding');
      }
      if (detected === null) detected = vector.length;
      else if (detected !== vector.length) {
        throw OllamaError(
          'dimension_mismatch',
          '第 ' + position + ' 条向量维度为 ' + vector.length + '，与同批其它结果的 ' + detected + ' 不一致',
          { actual: vector.length, expected: detected }
        );
      }
      result.push(vector);
    });

    return { embeddings: result, dimensions: detected };
  }

  // 新版 Ollama：POST /api/embed，body 里 input 可以是数组
  async function embedViaBatch(list) {
    const data = await request(endpoint, { model: model, input: list });
    return normalizeEmbeddings(data, list.length);
  }

  // 旧版 Ollama：只有 POST /api/embeddings，一次只能算一条
  async function embedViaLegacy(list) {
    const embeddings = [];
    for (let i = 0; i < list.length; i++) {
      const data = await request(legacyEndpoint, { model: model, prompt: list[i] });
      const part = normalizeEmbeddings(data, 1);
      embeddings.push(part.embeddings[0]);
    }
    return { embeddings: embeddings, dimensions: embeddings[0] ? embeddings[0].length : null };
  }

  async function embedTexts(texts) {
    const list = Array.isArray(texts) ? texts : [];

    if (list.length === 0) {
      throw OllamaError('invalid_input', '待向量化的文本为空');
    }
    if (list.length > maxTexts) {
      throw OllamaError('invalid_input', '一次最多只能处理 ' + maxTexts + ' 条文本');
    }
    if (model === '') {
      throw OllamaError('local_model_missing', '未配置本地模型名，请在 .env 中设置 OLLAMA_MODEL');
    }

    let result;
    try {
      result = await embedViaBatch(list);
    } catch (error) {
      if (error && error.code === 'local_model_missing' && !/model/i.test(String(error.detail || ''))) {
        // 返回体完全没提到 model，多半是旧版本没有 /api/embed，退回单条接口再试
        result = await embedViaLegacy(list);
      } else {
        throw error;
      }
    }

    if (result.dimensions) measuredDimensions = result.dimensions;

    return {
      embeddings: result.embeddings,
      model: model,
      dimensions: measuredDimensions,
      usage: null
    };
  }

  /**
   * 轻量可用性检查：不到万不得已不抛异常，统一返回结构化结果。
   * 成功时会顺带把真实维度探测出来。
   */
  async function checkAvailable() {
    const status = await ensureMeasured();
    return {
      ok: status.ok === true,
      code: status.code,
      message: status.message,
      dimensions: status.dimensions
    };
  }

  /**
   * 阶段 3.3：通过真实探针取得维度（不是任何写死的数字）。
   *
   * · 同一配置下并发调用只发一次请求（single-flight）
   * · model / host 变化后旧测量结果立即失效（令牌比对）
   * · 晚回来的旧测量不会覆盖新结果（序号比对）
   * · 探针直接调用 embedTexts，不经过服务端的正式 embedding 缓存
   *
   * @returns {{ok, code, message, dimensions, measured, token, stale}}
   */
  async function ensureMeasured(options) {
    const settings = options || {};
    const token = configToken();

    // 已经测过且配置没变 → 直接复用，不再打扰 Ollama
    if (!settings.force && measurement && measurement.token === token) {
      return {
        ok: true, code: null, message: '就绪', dimensions: measurement.dimensions,
        measured: true, token: token, stale: false
      };
    }

    // 同一配置的测量正在进行 → 大家共用这一个 Promise
    if (measuring && measuring.token === token && !settings.force) {
      return await measuring.promise;
    }

    const seq = ++measurementSeq;

    const run = async function () {
      try {
        if (model === '') {
          throw OllamaError('local_model_missing', '未配置本地模型名，请在 .env 中设置 OLLAMA_MODEL');
        }
        // 探针：一条极短的文本，只为拿到真实向量长度
        const probe = await embedTexts(['。']);
        const first = probe && probe.embeddings && probe.embeddings[0];
        const dimensions = Array.isArray(first) ? first.length : null;
        if (!dimensions) {
          throw OllamaError('invalid_response', '本地 Ollama 返回的探针向量不可用');
        }

        // 期间配置变了、或已经有更新的测量 → 本次结果作废，绝不覆盖
        if (seq !== measurementSeq || token !== configToken()) {
          return {
            ok: false, code: 'stale_measurement', message: '测量期间配置已变化，结果作废',
            dimensions: null, measured: false, token: token, stale: true
          };
        }

        measuredDimensions = dimensions;
        measurement = { dimensions: dimensions, token: token, measuredAt: Date.now() };
        return {
          ok: true, code: null, message: '就绪', dimensions: dimensions,
          measured: true, token: token, stale: false
        };
      } catch (error) {
        return {
          ok: false,
          code: error && error.code ? error.code : 'local_unavailable',
          message: redact(error && error.message ? error.message : String(error)),
          dimensions: knownDimensions(),
          measured: knownDimensions() !== null,
          token: token,
          stale: false
        };
      }
    };

    const promise = run();
    measuring = { token: token, promise: promise };
    try {
      return await promise;
    } finally {
      if (measuring && measuring.token === token) measuring = null;
    }
  }

  return {
    describe: describe,
    embedTexts: embedTexts,
    redact: redact,
    checkAvailable: checkAvailable,
    ensureMeasured: ensureMeasured,
    ensureReady: ensureMeasured
  };
}

module.exports = {
  PROVIDER_ID: PROVIDER_ID,
  PROVIDER_LABEL: PROVIDER_LABEL,
  DEFAULT_HOST: DEFAULT_HOST,
  DEFAULT_MODEL: DEFAULT_MODEL,
  createOllamaProvider: createOllamaProvider
};
