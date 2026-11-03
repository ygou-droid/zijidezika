// =======================================================
// Mochi Chat · 向量供应商统一接口（双模型改造 · 阶段 1）
//
// 这个文件只做「接口约定」和「合法性校验」，不含任何具体厂商逻辑。
// 阶段 2 加入本地 Ollama 时，只要新供应商满足这里的约定，
// server.js 无需再改动一行。
// =======================================================

'use strict';

// 接口版本：将来接口不兼容升级时用来自查
const PROVIDER_INTERFACE_VERSION = 1;

// 必须实现的方法
const REQUIRED_METHODS = ['describe', 'embedTexts', 'redact'];

// describe() 返回对象中必须包含的字段及其类型
const REQUIRED_DESCRIBE_FIELDS = {
  providerId: 'string',   // 稳定标识，例如 'cloud-bailian' / 'local-ollama'（用作缓存隔离的一级）
  label: 'string',        // 给用户看的名字，例如 '阿里云百炼'
  model: 'string',        // 模型名，例如 'text-embedding-v4'
  dimensions: 'number',   // 该模型实际输出的维度（不同模型可能不同，禁止调用方写死）
  maxTexts: 'number',     // 单次批量上限
  maxTextLength: 'number',// 单条文本长度上限
  ready: 'boolean'        // 是否具备运行条件（云端看有没有密钥，本地看有没有配模型）
};

// 双模型改造 · 阶段 3.3：结构校验与就绪校验分离
//
// 结构校验（assertProvider）回答「这个对象长得对不对」：
//   dimensions 允许为 null —— 那表示「还没测量过」，是合法状态；
//   但 0、负数、字符串、NaN 等仍然是结构错误，照样拒绝。
// 就绪校验（isUsable / assertUsable）回答「现在能不能真的出向量」：
//   要求 ready === true 且 dimensions 是正数；
//   供应商若主动上报 measured，则必须为 true（禁止用声明值冒充实测值）。
//
// 这样未测量的本地供应商可以被安全注册、查询、体检，
// 但绝无可能通过正式 embedding 请求。
const NULLABLE_DESCRIBE_FIELDS = ['dimensions'];

// 就绪状态里的维度来源：声明（云端官方值）/ 实测（本地探针）/ 未知
const DIMENSION_SOURCE = {
  DECLARED: 'declared',
  MEASURED: 'measured',
  UNKNOWN: 'unknown'
};

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * 校验一个对象是否符合「向量供应商」接口。
 * 合法时原样返回该对象，非法时抛出带明确原因的 TypeError。
 * 目的：将来新增供应商时，配置错了会在启动阶段就报错，
 * 而不是等到用户发消息时才出现难以理解的行为。
 */
function assertProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new TypeError('供应商无效：必须是一个对象，实际是 ' + typeOf(provider));
  }

  const missingMethods = REQUIRED_METHODS.filter(function (name) {
    return typeof provider[name] !== 'function';
  });
  if (missingMethods.length > 0) {
    throw new TypeError('供应商无效：缺少方法 ' + missingMethods.join('、'));
  }

  const info = provider.describe();
  if (!info || typeof info !== 'object') {
    throw new TypeError('供应商无效：describe() 必须返回一个对象，实际是 ' + typeOf(info));
  }

  Object.keys(REQUIRED_DESCRIBE_FIELDS).forEach(function (name) {
    const expected = REQUIRED_DESCRIBE_FIELDS[name];
    const actual = typeOf(info[name]);
    // 未测量（null）是合法状态：跳过类型与取值校验，交给就绪校验把关
    if (actual === 'null' && NULLABLE_DESCRIBE_FIELDS.indexOf(name) >= 0) return;
    if (actual !== expected) {
      throw new TypeError(
        '供应商无效：describe().' + name + ' 应为 ' + expected + ' 类型，实际是 ' + actual
      );
    }
    if (expected === 'string' && info[name] === '') {
      throw new TypeError('供应商无效：describe().' + name + ' 不能为空字符串');
    }
    if (name === 'dimensions' && !(info[name] > 0)) {
      throw new TypeError('供应商无效：describe().dimensions 必须是正数，实际是 ' + info[name]);
    }
  });

  return provider;
}

/**
 * 就绪校验（与结构校验分离）。
 * 结构合法 ≠ 现在能用：未测量的供应商结构完全合法，但不能出向量。
 *
 * @returns {{usable: boolean, ready: boolean, measured: boolean, dimensions: number|null,
 *            dimensionSource: string, reason: string|null}}
 */
function describeReadiness(provider) {
  if (!provider || typeof provider.describe !== 'function') {
    return {
      usable: false, ready: false, measured: false, dimensions: null,
      dimensionSource: DIMENSION_SOURCE.UNKNOWN, reason: 'invalid_provider'
    };
  }
  const info = provider.describe() || {};
  const dimensions = typeof info.dimensions === 'number' && info.dimensions > 0 ? info.dimensions : null;
  // 供应商主动上报 measured 时，必须真的测过；没上报就按「有维度即可用」处理
  const measured = info.measured === undefined ? dimensions !== null : info.measured === true;
  const source = info.dimensionSource || (dimensions === null ? DIMENSION_SOURCE.UNKNOWN : DIMENSION_SOURCE.DECLARED);
  const ready = info.ready === true;

  let reason = null;
  if (!ready) reason = 'provider_not_ready';
  else if (dimensions === null) reason = 'dimensions_unknown';
  else if (info.measured === false) reason = 'not_measured';

  return {
    usable: reason === null,
    ready: ready,
    measured: measured,
    dimensions: dimensions,
    dimensionSource: source,
    reason: reason
  };
}

function isUsable(provider) {
  return describeReadiness(provider).usable === true;
}

/**
 * 正式使用前的最后一道闸：未就绪就抛错，错误码统一为 provider_not_ready。
 * 绝不允许用 1024 或任何默认值把未知维度蒙混过去。
 */
function assertUsable(provider) {
  const status = describeReadiness(provider);
  if (!status.usable) {
    const error = new Error(
      '供应商尚未就绪，不能处理正式请求：' + (status.reason || 'unknown')
      + '（providerId=' + ((provider && provider.describe && provider.describe().providerId) || '未知') + '）'
    );
    error.name = 'ProviderNotReadyError';
    error.code = 'provider_not_ready';
    error.reason = status.reason;
    throw error;
  }
  return provider;
}

/**
 * 安全脱敏：即使某个供应商忘了实现 redact，也不会把原文原样抛出去。
 */
function safeRedact(provider, text) {
  if (provider && typeof provider.redact === 'function') {
    return String(provider.redact(text == null ? '' : String(text)) || '');
  }
  return text == null ? '' : String(text);
}

module.exports = {
  PROVIDER_INTERFACE_VERSION: PROVIDER_INTERFACE_VERSION,
  REQUIRED_METHODS: REQUIRED_METHODS.slice(),
  REQUIRED_DESCRIBE_FIELDS: Object.assign({}, REQUIRED_DESCRIBE_FIELDS),
  NULLABLE_DESCRIBE_FIELDS: NULLABLE_DESCRIBE_FIELDS.slice(),
  DIMENSION_SOURCE: DIMENSION_SOURCE,
  assertProvider: assertProvider,
  describeReadiness: describeReadiness,
  isUsable: isUsable,
  assertUsable: assertUsable,
  safeRedact: safeRedact
};
