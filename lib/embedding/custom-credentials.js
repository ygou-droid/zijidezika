// =======================================================
// Mochi Chat · 自定义凭据（阶段 5.12）
//
// 前端在请求里携带用户自己的「云端百炼 API Key」与
// 「本地 Ollama 地址 / 模型名」；这里只做三件事：
//   1. 从请求中读取（Key 走 Header，本地配置走 Body）
//   2. 规范化（全部变成「非空字符串或 ''」）
//   3. 生成缓存身份令牌（sha256 前 16 位，绝不存明文）
//
// 安全约定：
//   · 明文 Key 只在请求链路内存在，绝不写日志、不进响应
//   · 缓存身份只放散列：不同 Key 产生的向量绝不共用缓存
//   · 任何字段为空 → 回退 .env 默认配置，行为与从前完全一致
// =======================================================

'use strict';

const crypto = require('crypto');
const { PROVIDER_ID: CLOUD_PROVIDER_ID } = require('./cloud-bailian.js');
const { PROVIDER_ID: LOCAL_PROVIDER_ID } = require('./local-ollama.js');

const CUSTOM_API_KEY_HEADER = 'x-custom-api-key';
const CUSTOM_OLLAMA_HOST_FIELD = 'customOllamaHost';
const CUSTOM_OLLAMA_MODEL_FIELD = 'customOllamaModel';

// 任意值 → 「去掉首尾空白的字符串」，空串表示「没配」
function cleanText(value) {
  const text = String(value == null ? '' : value).trim();
  return text === '' ? '' : text;
}

function normalizeCredentials(raw) {
  const source = raw || {};
  return {
    apiKey: cleanText(source.apiKey),
    ollamaHost: cleanText(source.ollamaHost),
    ollamaModel: cleanText(source.ollamaModel)
  };
}

// 从请求中读取自定义凭据（GET 请求没有 body，只会读到 Header 里的 Key）
function readCustomCredentials(req) {
  const headers = (req && req.headers) || {};
  const body = (req && req.body) || {};
  return normalizeCredentials({
    apiKey: headers[CUSTOM_API_KEY_HEADER],
    ollamaHost: body[CUSTOM_OLLAMA_HOST_FIELD],
    ollamaModel: body[CUSTOM_OLLAMA_MODEL_FIELD]
  });
}

function hasCustomCredentials(credentials) {
  if (!credentials) return false;
  return credentials.apiKey !== '' ||
    credentials.ollamaHost !== '' ||
    credentials.ollamaModel !== '';
}

// 缓存身份令牌：只含散列，不含任何明文。
// 没有自定义凭据时返回 ''，缓存键与改造前完全一致（不破坏既有隔离）。
function customCredentialsToken(credentials) {
  if (!hasCustomCredentials(credentials)) return '';
  const digest = crypto
    .createHash('sha256')
    .update([credentials.apiKey, credentials.ollamaHost, credentials.ollamaModel].join('\n'))
    .digest('hex');
  return 'ck-' + digest.slice(0, 16);
}

// 凭据是否需要替换该供应商的配置：
//   云端只看 Key；本地只看地址 / 模型名；其余供应商一律不受影响
function affectsProvider(providerId, credentials) {
  if (!hasCustomCredentials(credentials)) return false;
  if (providerId === CLOUD_PROVIDER_ID) return credentials.apiKey !== '';
  if (providerId === LOCAL_PROVIDER_ID) {
    return credentials.ollamaHost !== '' || credentials.ollamaModel !== '';
  }
  return false;
}

module.exports = {
  CUSTOM_API_KEY_HEADER: CUSTOM_API_KEY_HEADER,
  CUSTOM_OLLAMA_HOST_FIELD: CUSTOM_OLLAMA_HOST_FIELD,
  CUSTOM_OLLAMA_MODEL_FIELD: CUSTOM_OLLAMA_MODEL_FIELD,
  normalizeCredentials: normalizeCredentials,
  readCustomCredentials: readCustomCredentials,
  hasCustomCredentials: hasCustomCredentials,
  customCredentialsToken: customCredentialsToken,
  affectsProvider: affectsProvider
};
