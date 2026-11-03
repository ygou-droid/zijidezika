// =======================================================
// 阿里云百炼 Embedding 客户端（只在 Node 后端使用）
// 密钥只从这里读取，绝不传给前端，也绝不写进日志
// =======================================================

'use strict';

const MODEL = 'text-embedding-v4';
const DIMENSIONS = 1024;
const MAX_TEXTS = 10;            // 单次最多 10 条
const MAX_TEXT_LENGTH = 8192;    // 单条文本最大字符数
const DEFAULT_TIMEOUT_MS = 30000;

// 未配置 DASHSCOPE_BASE_URL 时使用的默认地址。
// 说明：这是阿里云百炼（DashScope）北京地域仍在支持的 OpenAI 兼容地址。
// 若你有「业务空间专属地址」，请把 DASHSCOPE_BASE_URL 设为：
//   https://你的WorkspaceId.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

class BailianError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'BailianError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

// 把任何文本里的密钥替换成 ***，避免出现在错误信息或日志里
function redact(text, secrets) {
  let result = String(text === undefined || text === null ? '' : text);
  (secrets || []).forEach(function (secret) {
    if (secret && String(secret).length >= 4) {
      result = result.split(String(secret)).join('***');
    }
  });
  return result;
}

// 统一 Base URL：去掉结尾斜杠；若没有 /embeddings 则补上
function normalizeBaseUrl(raw) {
  const value = String(raw === undefined || raw === null ? '' : raw).trim();
  if (value === '') return DEFAULT_BASE_URL + '/embeddings';

  const base = value.replace(/\/+$/, '');
  if (/\/embeddings$/i.test(base)) return base;
  return base + '/embeddings';
}

function createBailianClient(options) {
  const settings = options || {};
  const env = settings.env || process.env;
  const fetchImpl = settings.fetchImpl || globalThis.fetch;

  const apiKey = String(
    settings.apiKey !== undefined && settings.apiKey !== null
      ? settings.apiKey
      : (env.DASHSCOPE_API_KEY || '')
  ).trim();

  const endpoint = normalizeBaseUrl(
    settings.baseUrl !== undefined ? settings.baseUrl : env.DASHSCOPE_BASE_URL
  );

  const timeoutMs = settings.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxTexts = settings.maxTexts || MAX_TEXTS;
  const maxTextLength = settings.maxTextLength || MAX_TEXT_LENGTH;

  // 供 /api/health 等地方查看（不暴露密钥本身）
  function describe() {
    return {
      model: MODEL,
      dimensions: DIMENSIONS,
      endpoint: endpoint,
      hasApiKey: apiKey !== '',
      maxTexts: maxTexts,
      maxTextLength: maxTextLength,
      timeoutMs: timeoutMs
    };
  }

  async function embedTexts(texts) {
    const list = Array.isArray(texts) ? texts : [];

    if (list.length === 0) {
      throw new BailianError('invalid_input', '待向量化的文本为空');
    }
    if (list.length > maxTexts) {
      throw new BailianError('invalid_input', '一次最多只能处理 ' + maxTexts + ' 条文本');
    }
    if (apiKey === '') {
      throw new BailianError(
        'missing_api_key',
        '服务端未配置 DASHSCOPE_API_KEY，请在项目根目录的 .env 文件中填写后重启服务'
      );
    }

    const payload = {
      model: MODEL,
      input: list,
      dimensions: DIMENSIONS,
      encoding_format: 'float'
    };

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new BailianError(
        'request_failed',
        '无法连接阿里云百炼：' + redact(error && error.message ? error.message : String(error), [apiKey])
      );
    }

    const ok = typeof response.ok === 'boolean'
      ? response.ok
      : (response.status >= 200 && response.status < 300);

    if (!ok) {
      let detail = '';
      try {
        const body = await response.text();
        detail = redact(String(body || '').slice(0, 300), [apiKey]);
      } catch (error) {
        detail = '无法读取上游返回内容';
      }
      throw new BailianError(
        'http_error',
        '阿里云百炼返回错误 HTTP ' + response.status + '：' + detail,
        { httpStatus: response.status }
      );
    }

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new BailianError('invalid_response', '无法解析阿里云百炼返回的内容（不是合法 JSON）');
    }

    const rows = data && Array.isArray(data.data) ? data.data : null;
    if (!rows) {
      throw new BailianError('invalid_response', '阿里云百炼返回内容中缺少 data 字段');
    }
    if (rows.length !== list.length) {
      throw new BailianError(
        'invalid_response',
        '返回的向量数量与请求不一致（请求 ' + list.length + ' 条，返回 ' + rows.length + ' 条）'
      );
    }

    // 按 index 还原为请求时的顺序
    const sorted = rows.slice().sort(function (a, b) {
      return (a.index || 0) - (b.index || 0);
    });

    const embeddings = sorted.map(function (row, position) {
      const vector = row && row.embedding;
      if (!Array.isArray(vector)) {
        throw new BailianError('invalid_response', '第 ' + position + ' 条结果缺少 embedding 字段');
      }
      if (vector.length !== DIMENSIONS) {
        throw new BailianError(
          'dimension_mismatch',
          '第 ' + position + ' 条向量维度为 ' + vector.length + '，期望 ' + DIMENSIONS,
          { actual: vector.length, expected: DIMENSIONS }
        );
      }
      return vector;
    });

    return {
      embeddings: embeddings,
      model: MODEL,
      dimensions: DIMENSIONS,
      usage: data.usage || null
    };
  }

  return {
    embedTexts: embedTexts,
    describe: describe,
    redact: function (text) {
      return redact(text, [apiKey]);
    },
    constants: {
      MODEL: MODEL,
      DIMENSIONS: DIMENSIONS,
      MAX_TEXTS: MAX_TEXTS,
      MAX_TEXT_LENGTH: MAX_TEXT_LENGTH,
      DEFAULT_BASE_URL: DEFAULT_BASE_URL
    },
    maxTexts: maxTexts,
    maxTextLength: maxTextLength
  };
}

module.exports = {
  MODEL: MODEL,
  DIMENSIONS: DIMENSIONS,
  MAX_TEXTS: MAX_TEXTS,
  MAX_TEXT_LENGTH: MAX_TEXT_LENGTH,
  DEFAULT_BASE_URL: DEFAULT_BASE_URL,
  BailianError: BailianError,
  createBailianClient: createBailianClient,
  normalizeBaseUrl: normalizeBaseUrl,
  redact: redact
};
