// =======================================================
// Mochi Chat · 阿里云百炼供应商（双模型改造 · 阶段 1）
//
// 这是一个「薄包装」：不重写协议实现，只是把现有的 lib/bailian.js
// 包装成统一的供应商接口（见 ./provider-contract.js）。
// 这样 lib/bailian.js 本身与其 118 项测试都不需要改动。
//
// 将来新增另一种 provider 时，也用同样的思路包装，不要在 server.js 里写厂商分支。
// =======================================================

'use strict';

const {
  createBailianClient,
  MODEL: CLOUD_MODEL,
  DIMENSIONS: CLOUD_DIMENSIONS,
  MAX_TEXTS: CLOUD_MAX_TEXTS,
  MAX_TEXT_LENGTH: CLOUD_MAX_TEXT_LENGTH
} = require('../bailian.js');

const PROVIDER_ID = 'cloud-bailian';
const PROVIDER_LABEL = '阿里云百炼';

/**
 * 创建云端（阿里云百炼）供应商实例。
 *
 * @param {Object} options
 *   options.client  已有的百炼客户端（测试注入用）；不给则由 options.env 自动创建
 *   options.env     环境变量来源，默认 process.env
 *   options.apiKey / options.baseUrl / options.fetchImpl  透传给 createBailianClient
 *
 * 密钥永远只在这条链路内部读取，describe() 只暴露「有没有配置」。
 */
function createCloudBailianProvider(options) {
  const settings = options || {};

  const client = settings.client || createBailianClient({
    env: settings.env,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    fetchImpl: settings.fetchImpl
  });

  /**
   * 把百炼客户端原有的 describe() 归一化成统一格式。
   * 同时保留 hasApiKey 字段，供 server.js 里兼容旧逻辑使用。
   */
  function describe() {
    const raw = (client && typeof client.describe === 'function')
      ? (client.describe() || {})
      : {};

    const hasApiKey = raw.hasApiKey === true;

    return {
      providerId: PROVIDER_ID,
      label: PROVIDER_LABEL,
      model: raw.model || CLOUD_MODEL,
      dimensions: raw.dimensions || CLOUD_DIMENSIONS,
      endpoint: raw.endpoint || '',
      maxTexts: raw.maxTexts || CLOUD_MAX_TEXTS,
      maxTextLength: raw.maxTextLength || CLOUD_MAX_TEXT_LENGTH,
      timeoutMs: raw.timeoutMs || 0,
      ready: hasApiKey,
      // 兼容字段：旧代码与既有测试依赖它判断「密钥是否已配置」
      hasApiKey: hasApiKey,
      // 阶段 3.3：云端维度由官方声明确定（来自 lib/bailian.js），不需要也不允许探测
      measured: true,
      dimensionSource: 'declared'
    };
  }

  function embedTexts(texts) {
    return client.embedTexts(texts);
  }

  function redact(text) {
    if (client && typeof client.redact === 'function') return client.redact(text);
    return String(text == null ? '' : text);
  }

  /**
   * 轻量可用性检查：只做本地判断，不发网络请求。
   * 阶段 2 起这里可以增加更实质的校验。
   */
  function checkAvailable() {
    const info = describe();
    if (!info.ready) {
      return {
        ok: false,
        code: 'missing_api_key',
        message: '服务端未配置 DASHSCOPE_API_KEY，请在项目根目录的 .env 文件中填写后重启服务'
      };
    }
    return { ok: true, code: null, message: '就绪' };
  }

  /**
   * 阶段 3.3：云端不做真实网络探测（避免启动即消耗额度）。
   * 就绪 = 密钥已配置；维度取官方声明值，并标注来源为 declared。
   */
  async function ensureMeasured() {
    const info = describe();
    if (!info.ready) {
      return {
        ok: false,
        code: 'missing_api_key',
        message: '服务端未配置 DASHSCOPE_API_KEY，请在项目根目录的 .env 文件中填写后重启服务',
        dimensions: info.dimensions,
        measured: false,
        token: PROVIDER_ID + '|' + info.model,
        stale: false
      };
    }
    return {
      ok: true,
      code: null,
      message: '就绪',
      dimensions: info.dimensions,
      measured: true,
      token: PROVIDER_ID + '|' + info.model,
      stale: false
    };
  }

  return {
    describe: describe,
    embedTexts: embedTexts,
    redact: redact,
    checkAvailable: checkAvailable,
    ensureMeasured: ensureMeasured,
    ensureReady: ensureMeasured,
    // 便于测试与调试：拿到被包装的原始客户端
    unwrap: function () { return client; }
  };
}

module.exports = {
  PROVIDER_ID: PROVIDER_ID,
  PROVIDER_LABEL: PROVIDER_LABEL,
  createCloudBailianProvider: createCloudBailianProvider
};
