// =======================================================
// Mochi Chat · 服务端向量缓存身份隔离测试（双模型改造 · 阶段 3.1）
// 运行方式： node test/vector-cache.test.js
//
// 目标：证明不同 providerId / model / dimensions 的向量绝不会互相命中缓存。
// 说明：全部使用本地模拟数据与模拟服务端，不联网、不需要密钥、不安装 Ollama。
// =======================================================

'use strict';

const crypto = require('crypto');
const { createEmbeddingCache } = require('../lib/vector.js');
const { createApp } = require('../server.js');

const pass = [];
const fail = [];
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  const line = `${ok ? '通过' : '失败'}  ${name} => 实际: ${actual}` + (ok ? '' : `  期望: ${expected}`);
  (ok ? pass : fail).push(line);
}

function vector(dimensions, seed) {
  const v = new Array(dimensions).fill(0);
  v[seed % dimensions] = 0.5;
  return v;
}
function close(server) {
  return new Promise(function (resolve) { server.close(resolve); });
}
function startApp(options) {
  return new Promise(function (resolve) {
    const s = createApp(options).listen(0, '127.0.0.1', function () {
      resolve({ server: s, base: 'http://127.0.0.1:' + s.address().port });
    });
  });
}
function embed(base, texts) {
  return fetch(base + '/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: texts })
  });
}

// 模拟供应商：identity 决定身份，length 决定实际返回的向量长度
function mockProvider(settings) {
  const config = Object.assign({
    providerId: 'provider-a', model: 'same-model', dimensions: 4, length: 4
  }, settings || {});
  return {
    calls: [],
    describe: function () {
      return {
        providerId: config.providerId,
        label: config.providerId,
        model: config.model,
        dimensions: config.dimensions,
        endpoint: 'http://127.0.0.1/mock',
        maxTexts: 10,
        maxTextLength: 8192,
        timeoutMs: 1000,
        ready: true,
        hasApiKey: false
      };
    },
    embedTexts: async function (texts) {
      this.calls.push(texts.slice());
      return {
        embeddings: texts.map(function (t, i) { return vector(config.length, i + 1); }),
        model: config.model,
        dimensions: config.length,
        usage: null
      };
    },
    redact: function (text) { return String(text); }
  };
}

(async function run() {
  console.log('===== 服务端向量缓存身份隔离测试 =====\n');

  // ============ 一、缓存键：身份隔离 ============
  console.log('【一】身份隔离（providerId / model / dimensions）');
  {
    const cache = createEmbeddingCache({ maxEntries: 100 });

    const idA = { providerId: 'cloud-bailian', model: 'm', dimensions: 1024 };
    const idSameAsA = { providerId: 'cloud-bailian', model: 'm', dimensions: 1024 };
    const idOtherProvider = { providerId: 'local-ollama', model: 'm', dimensions: 1024 };
    const idOtherModel = { providerId: 'cloud-bailian', model: 'm2', dimensions: 1024 };
    const idOtherDims = { providerId: 'cloud-bailian', model: 'm', dimensions: 768 };

    cache.set('你好', idA, [1, 2, 3]);

    check('身份完全相同可命中', JSON.stringify(cache.get('你好', idSameAsA)), JSON.stringify([1, 2, 3]));
    check('providerId 不同则隔离', cache.get('你好', idOtherProvider), 'undefined');
    check('model 不同则隔离', cache.get('你好', idOtherModel), 'undefined');
    check('dimensions 不同则隔离', cache.get('你好', idOtherDims), 'undefined');
    check('has 按身份区分：同身份 true', cache.has('你好', idSameAsA), 'true');
    check('has 按身份区分：异身份 false', cache.has('你好', idOtherProvider), 'false');
    check('文本不同不互相命中', cache.get('再见', idA), 'undefined');
    check('缺 providerId 视为不同身份', cache.get('你好', { model: 'm', dimensions: 1024 }), 'undefined');
  }

  // ============ 二、旧字符串写法保持兼容 ============
  console.log('【二】旧写法（只传模型名字符串）行为不变');
  {
    const legacy = createEmbeddingCache({ maxEntries: 10 });
    legacy.set('你好', 'text-embedding-v4', [0.1, 0.2]);
    check('旧写法仍可命中', JSON.stringify(legacy.get('你好', 'text-embedding-v4')), JSON.stringify([0.1, 0.2]));
    check('旧写法 has 正常', legacy.has('你好', 'text-embedding-v4'), 'true');
    check('旧写法未命中返回 undefined', legacy.get('不存在', 'text-embedding-v4'), 'undefined');

    const expect = crypto.createHash('sha1').update('text-embedding-v4|你好').digest('hex');
    check('旧写法的键公式未变', legacy.keyFor('你好', 'text-embedding-v4'), expect);

    const full = { providerId: 'p', model: 'text-embedding-v4', dimensions: 1024 };
    legacy.set('你好', full, [9]);
    check('新旧写法在同一实例里互不干扰',
      JSON.stringify(legacy.get('你好', 'text-embedding-v4')), JSON.stringify([0.1, 0.2]));
    check('新写法取到自己的值', JSON.stringify(legacy.get('你好', full)), JSON.stringify([9]));
  }

  // ============ 三、过期与淘汰行为不变 ============
  console.log('【三】过期与淘汰行为保持原样');
  {
    let fakeNow = 1000;
    const expiring = createEmbeddingCache({ ttlMs: 100, now: function () { return fakeNow; } });
    const id = { providerId: 'p', model: 'm', dimensions: 8 };
    expiring.set('甲', id, [1]);
    check('未过期可命中', JSON.stringify(expiring.get('甲', id)), JSON.stringify([1]));
    fakeNow = 1200;
    check('过期后不可命中', expiring.get('甲', id), 'undefined');

    const limited = createEmbeddingCache({ maxEntries: 3 });
    const identity = { providerId: 'p', model: 'm', dimensions: 2 };
    ['a', 'b', 'c', 'd'].forEach(function (t) { limited.set(t, identity, [t]); });
    check('容量上限仍然生效', limited.size(), 3);
    check('最早写入的被淘汰', limited.get('a', identity), 'undefined');
    check('较新的仍在', JSON.stringify(limited.get('d', identity)), JSON.stringify(['d']));

    limited.set('d', identity, ['d2']);
    check('同身份重复写会覆盖', JSON.stringify(limited.get('d', identity)), JSON.stringify(['d2']));
    check('覆盖不会增加条目', limited.size(), 3);
  }

  // ============ 四、server：同模型名不同供应商不共享缓存 ============
  console.log('【四】共享缓存实例时，两个供应商不能互相命中');
  {
    const shared = createEmbeddingCache({ maxEntries: 100 });
    const providerA = mockProvider({ providerId: 'provider-a', model: 'same-model', dimensions: 4, length: 4 });
    const providerB = mockProvider({ providerId: 'provider-b', model: 'same-model', dimensions: 4, length: 4 });

    const appA = await startApp({ provider: providerA, cache: shared });
    const appB = await startApp({ provider: providerB, cache: shared });

    try {
      const first = await (await embed(appA.base, ['你好'])).json();
      check('A 首次请求成功', first.status, 'ok');
      check('A 响应新增 providerId', first.providerId, 'provider-a');
      check('A 首次无缓存命中', first.cachedCount, 0);
      check('A 旧字段保留：model', first.model, 'same-model');
      check('A 旧字段保留：dimensions', first.dimensions, 4);
      check('A 旧字段保留：count', first.count, 1);
      check('A 旧字段保留：requestedCount', first.requestedCount, 1);
      check('A 旧字段保留：embeddings 存在', Array.isArray(first.embeddings), 'true');

      const againA = await (await embed(appA.base, ['你好'])).json();
      check('A 再次请求命中自己的缓存', againA.cachedCount, 1);
      check('A 没再调用上游', providerA.calls.length, 1);

      const firstB = await (await embed(appB.base, ['你好'])).json();
      check('B 同模型名同文本，未命中 A 的缓存', firstB.cachedCount, 0);
      check('B 确实调用了上游', providerB.calls.length, 1);
      check('B 响应带自己的 providerId', firstB.providerId, 'provider-b');

      const againB = await (await embed(appB.base, ['你好'])).json();
      check('B 再次请求命中自己的缓存', againB.cachedCount, 1);
      check('两个供应商各自一条缓存', shared.size(), 2);
    } finally {
      await close(appA.server);
      await close(appB.server);
    }
  }

  // ============ 五、server：维度不同必须隔离 ============
  console.log('【五】同供应商同模型、维度不同也要隔离');
  {
    const shared = createEmbeddingCache({ maxEntries: 100 });
    const dims1024 = mockProvider({ providerId: 'p', model: 'm', dimensions: 1024, length: 1024 });
    const dims768 = mockProvider({ providerId: 'p', model: 'm', dimensions: 768, length: 768 });

    const app1024 = await startApp({ provider: dims1024, cache: shared });
    const app768 = await startApp({ provider: dims768, cache: shared });

    try {
      await embed(app1024.base, ['你好']);
      const hit1024 = await (await embed(app1024.base, ['你好'])).json();
      check('1024 维一侧可命中自己', hit1024.cachedCount, 1);
      check('1024 维一侧维度正确', hit1024.dimensions, 1024);

      const other = await (await embed(app768.base, ['你好'])).json();
      check('768 维一侧不会命中 1024 维缓存', other.cachedCount, 0);
      check('768 维一侧维度正确', other.dimensions, 768);
      check('768 维返回的向量长度正确', other.embeddings[0].length, 768);
    } finally {
      await close(app1024.server);
      await close(app768.server);
    }
  }

  // ============ 六、写入前校验：维度不一致不写缓存 ============
  console.log('【六】返回向量与声明维度不一致时，不得写入缓存');
  {
    const shared = createEmbeddingCache({ maxEntries: 100 });
    // 声明 1024，实际返回 768：模拟来源不可信的情况
    const liar = mockProvider({ providerId: 'p', model: 'm', dimensions: 1024, length: 768 });
    const app = await startApp({ provider: liar, cache: shared });

    const originalError = console.error;
    let logs = '';
    console.error = function (text) { logs += String(text); };

    try {
      const first = await (await embed(app.base, ['你好'])).json();
      check('不一致时请求仍然成功', first.status, 'ok');
      check('响应如实报告实际维度', first.dimensions, 768);
      const second = await (await embed(app.base, ['你好'])).json();
      check('不一致的数据没有进缓存', second.cachedCount, 0);
      check('第二次仍然重新请求上游', liar.calls.length, 2);
      check('缓存实例里没有留下条目', shared.size(), 0);
    } finally {
      console.error = originalError;
      await close(app.server);
    }
    check('有留下告警日志', logs.length > 0, 'true');
    check('日志不含向量内容', /0\.5/.test(logs), 'false');
  }

  // ============ 七、默认云端行为回归 ============
  console.log('【七】默认供应商仍是云端百炼');
  {
    const app = await startApp({ env: {} });
    try {
      const health = await (await fetch(app.base + '/api/health')).json();
      check('默认供应商仍是云端', health.provider.id, 'cloud-bailian');
      check('云端模型名不变', health.embedding.model, 'text-embedding-v4');
      check('云端维度不变', health.embedding.dimensions, 1024);
      check('health 顶层旧字段齐全',
        ['cache', 'dashscopeApiKey', 'embedding', 'features', 'message', 'node', 'service', 'status', 'timestamp', 'uptimeSeconds']
          .every(function (k) { return Object.keys(health).indexOf(k) >= 0; }), 'true');

      // 没有密钥时，云端请求按旧行为返回 503
      const res = await embed(app.base, ['你好']);
      check('无密钥时仍按旧行为返回 503', res.status, 503);
      const body = await res.json();
      check('无密钥时错误码不变', body.code, 'missing_api_key');
    } finally {
      await close(app.server);
    }
  }

  console.log('\n' + pass.join('\n'));
  if (fail.length) console.log('\n' + fail.join('\n'));
  console.log('\n共 ' + (pass.length + fail.length) + ' 项，通过 ' + pass.length + ' 项，失败 ' + fail.length + ' 项');
  process.exit(fail.length ? 1 : 0);
})();
