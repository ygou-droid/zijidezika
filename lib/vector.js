// =======================================================
// 向量工具：输入校验、余弦相似度、向量缓存（纯本地计算，不联网）
// =======================================================

'use strict';

const crypto = require('crypto');

class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

// ===== 1. 输入校验：texts 必须是 1~N 条非空字符串 =====
function validateTexts(input, options) {
  const settings = options || {};
  const maxCount = settings.maxCount || 10;
  const maxLength = settings.maxLength || 8192;

  if (!Array.isArray(input)) {
    throw new ValidationError('invalid_texts', 'texts 必须是字符串数组，例如 { "texts": ["你好"] }');
  }
  if (input.length === 0) {
    throw new ValidationError('empty_texts', 'texts 不能为空数组');
  }
  if (input.length > maxCount) {
    throw new ValidationError('too_many_texts', '一次最多只能处理 ' + maxCount + ' 条文本，当前 ' + input.length + ' 条');
  }

  return input.map(function (item, position) {
    if (typeof item !== 'string') {
      throw new ValidationError('invalid_text_item', '第 ' + (position + 1) + ' 条不是字符串');
    }
    const text = item.trim();
    if (text === '') {
      throw new ValidationError('empty_text_item', '第 ' + (position + 1) + ' 条是空白内容');
    }
    if (text.length > maxLength) {
      throw new ValidationError(
        'too_long_text',
        '第 ' + (position + 1) + ' 条过长（' + text.length + ' 字符），单条最多 ' + maxLength + ' 字符'
      );
    }
    return text;
  });
}

// ===== 2. 余弦相似度 =====
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    throw new ValidationError('invalid_vector', '参与计算的必须是数组');
  }
  if (a.length === 0 || b.length === 0) {
    throw new ValidationError('empty_vector', '向量不能为空');
  }
  if (a.length !== b.length) {
    throw new ValidationError(
      'dimension_mismatch',
      '两个向量维度不一致（' + a.length + ' vs ' + b.length + '）'
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  // 零向量没有方向，直接认为不相似
  if (normA === 0 || normB === 0) return 0;

  const value = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  // 修正浮点误差：极接近 ±1 时按 ±1 处理，并把结果限制在 [-1, 1]
  const EPSILON = 1e-12;
  if (value > 1 - EPSILON) return 1;
  if (value < -1 + EPSILON) return -1;
  return value;
}

// ===== 3. 向量缓存 =====
// key = sha1(身份 + '|' + 文本)，避免把原文直接当 key
//
// 「身份」支持两种写法（同一个缓存实例里两套键互不干扰）：
//   旧写法：传模型名字符串 → 身份文本 = model
//   新写法：传身份对象     → 身份文本 = providerId + '|' + model + '|' + dimensions
//
// 双模型改造 · 阶段 3.1：服务端改用新写法，
// 保证不同供应商、不同模型、不同维度生成的向量绝不互相命中。
// 旧的字符串写法继续可用，行为与改造前完全一致。
function createEmbeddingCache(options) {
  const settings = options || {};
  const maxEntries = settings.maxEntries || 500;
  const ttlMs = settings.ttlMs || 10 * 60 * 1000; // 默认 10 分钟
  const now = settings.now || function () { return Date.now(); };

  const map = new Map();
  const stats = { hits: 0, misses: 0, sets: 0, evicted: 0 };

  // 把「身份」统一转成参与散列的字符串：支持对象与旧的字符串两种写法
  function identityText(identity) {
    if (identity && typeof identity === 'object') {
      const providerId = identity.providerId == null ? '' : String(identity.providerId).trim();
      const model = identity.model == null ? '' : String(identity.model).trim();
      const dimensions = identity.dimensions == null ? '' : String(identity.dimensions);
      const base = providerId + '|' + model + '|' + dimensions;
      // 阶段 5.12：凭据令牌（服务端对自定义 Key 的散列）也参与身份，
      // 不同 Key 产生的向量绝不互相命中。
      // 没带 credentials 的旧请求保持原样，散列输入不变，不破坏既有缓存键。
      const credentials = identity.credentials == null ? '' : String(identity.credentials).trim();
      return credentials === '' ? base : base + '|' + credentials;
    }
    return String(identity == null ? '' : identity);
  }

  function keyFor(text, identity) {
    return crypto
      .createHash('sha1')
      .update(identityText(identity) + '|' + String(text == null ? '' : text))
      .digest('hex');
  }

  function prune() {
    const current = now();
    map.forEach(function (value, key) {
      if (value.expiresAt <= current) map.delete(key);
    });
  }

  function get(text, identity) {
    prune();
    const hit = map.get(keyFor(text, identity));
    if (hit) {
      stats.hits++;
      return hit.value;
    }
    stats.misses++;
    return undefined;
  }

  function set(text, identity, value) {
    prune();
    const key = keyFor(text, identity);
    if (map.has(key)) {
      map.set(key, { value: value, expiresAt: now() + ttlMs });
    } else {
      // 超出上限时淘汰最早写入的一条
      if (map.size >= maxEntries) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
        stats.evicted++;
      }
      map.set(key, { value: value, expiresAt: now() + ttlMs });
    }
    stats.sets++;
    return value;
  }

  function has(text, identity) {
    prune();
    return map.has(keyFor(text, identity));
  }

  return {
    get: get,
    set: set,
    has: has,
    // 便于测试直观察看隔离效果：给定文本与身份算出实际使用的键
    keyFor: keyFor,
    prune: prune,
    clear: function () { map.clear(); },
    size: function () { prune(); return map.size; },
    stats: function () { return Object.assign({}, stats); }
  };
}

module.exports = {
  ValidationError: ValidationError,
  validateTexts: validateTexts,
  cosineSimilarity: cosineSimilarity,
  createEmbeddingCache: createEmbeddingCache
};
