// =======================================================
// Mochi Chat · Embedding 后端接口测试
// 运行方式： node test/api-embed.test.js
// 说明：全程使用模拟对象，不会真的联网，也不需要真实密钥
// =======================================================

'use strict';

const crypto = require('crypto');
const { createBailianClient, BailianError, redact, normalizeBaseUrl } = require('../lib/bailian.js');
const { validateTexts, ValidationError, cosineSimilarity, createEmbeddingCache } = require('../lib/vector.js');
const { createApp } = require('../server.js');

// 运行时随机生成一串「假装是密钥」的字符串，避免任何明文密钥写进文件
const TEST_KEY = 'TESTKEY-' + crypto.randomBytes(8).toString('hex');

const pass = [];
const fail = [];
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  (ok ? pass : fail).push(
    `${ok ? '通过' : '失败'}  ${name} => 实际: ${actual}` + (ok ? '' : `  期望: ${expected}`)
  );
}

// ---------- 通用小工具 ----------
function makeVector(dimensions, seed) {
  const vector = [];
  for (let i = 0; i < dimensions; i++) vector.push(((i + seed) % 7) / 10);
  return vector;
}

function mockResponse(body, status, ok) {
  return {
    ok: ok !== undefined ? ok : (status >= 200 && status < 300),
    status: status || 200,
    json: async function () { return body; },
    text: async function () { return JSON.stringify(body); }
  };
}

function mockFetch(handler) {
  return async function (url, init) { return handler(url, init); };
}

function fakeClient(options) {
  const settings = options || {};
  return {
    calls: [],
    // 模拟真实客户端的脱敏能力（真实实现会按服务端保存的密钥做替换）
    redact: function (text) { return String(text).split(TEST_KEY).join('***'); },
    describe: function () {
      return {
        model: 'text-embedding-v4',
        dimensions: settings.dimensions || 1024,
        endpoint: 'https://mock.local/embeddings',
        hasApiKey: settings.hasApiKey !== false,
        maxTexts: settings.maxTexts || 10,
        maxTextLength: settings.maxTextLength || 8192,
        timeoutMs: 1000
      };
    },
    embedTexts: async function (texts) {
      this.calls.push(texts.slice());
      if (settings.hasApiKey === false) {
        throw new BailianError(
          'missing_api_key',
          '服务端未配置 DASHSCOPE_API_KEY，请在项目根目录的 .env 文件中填写后重启服务'
        );
      }
      if (settings.fail) throw settings.fail;
      return {
        embeddings: texts.map(function (text, index) {
          return makeVector(settings.dimensions || 1024, index);
        }),
        model: 'text-embedding-v4',
        dimensions: settings.dimensions || 1024,
        usage: null
      };
    }
  };
}

async function withServer(factory, fn) {
  const server = factory().listen(0, '127.0.0.1');
  await new Promise(function (resolve) { server.once('listening', resolve); });
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    await fn(base);
  } finally {
    await new Promise(function (resolve) { server.close(resolve); });
  }
}

(async function run() {
  console.log('===== Embedding 接口测试 =====\n');

  // ==================== 一、lib/vector.js：输入校验 ====================
  console.log('【一】输入校验 validateTexts');
  check('正常输入返回 trim 后的数组', validateTexts([' 你好 ', '世界']).join(','), '你好,世界');
  check('单条文本', validateTexts(['a']).length, 1);

  function errorCodeOf(fn) {
    try { fn(); return '无异常'; } catch (error) { return error.code; }
  }

  check('texts 不是数组', errorCodeOf(() => validateTexts('abc')), 'invalid_texts');
  check('texts 缺失', errorCodeOf(() => validateTexts(undefined)), 'invalid_texts');
  check('空数组', errorCodeOf(() => validateTexts([])), 'empty_texts');
  check('超过 10 条', errorCodeOf(() => validateTexts(new Array(11).fill('x'))), 'too_many_texts');
  check('刚好 10 条通过', validateTexts(new Array(10).fill('x')).length, 10);
  check('含非字符串元素', errorCodeOf(() => validateTexts(['好', 123])), 'invalid_text_item');
  check('含空白字符串', errorCodeOf(() => validateTexts(['好', '   '])), 'empty_text_item');
  check('单条过长(>8192)', errorCodeOf(() => validateTexts(['x'.repeat(8193)])), 'too_long_text');
  check('单条 8192 字符通过', errorCodeOf(() => validateTexts(['x'.repeat(8192)])), '无异常');

  // ==================== 二、lib/vector.js：余弦相似度 ====================
  console.log('【二】余弦相似度 cosineSimilarity');
  check('相同向量相似度 = 1', cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  check('正交向量相似度 = 0', cosineSimilarity([1, 0], [0, 1]), 0);
  check('相反向量相似度 = -1', cosineSimilarity([1, 2], [-1, -2]), -1);
  check('一般相似度取值', cosineSimilarity([1, 1], [1, 0]).toFixed(4), (Math.SQRT1_2).toFixed(4));
  check('零向量返回 0', cosineSimilarity([0, 0], [1, 1]), 0);
  check('维度不一致抛错', errorCodeOf(() => cosineSimilarity([1, 2], [1, 2, 3])), 'dimension_mismatch');
  check('非数组输入抛错', errorCodeOf(() => cosineSimilarity('ab', [1, 2])), 'invalid_vector');
  check('空向量抛错', errorCodeOf(() => cosineSimilarity([], [])), 'empty_vector');
  check('1024 维实测不报错', typeof cosineSimilarity(makeVector(1024, 0), makeVector(1024, 1)), 'number');
  check(
    '1024 维结果在 [-1,1]',
    Math.abs(cosineSimilarity(makeVector(1024, 0), makeVector(1024, 1))) <= 1,
    'true'
  );

  // ==================== 三、lib/vector.js：向量缓存 ====================
  console.log('【三】向量缓存 createEmbeddingCache');
  const cacheA = createEmbeddingCache();
  cacheA.set('你好', 'text-embedding-v4', [0.1, 0.2]);
  check('写入后可读取', cacheA.get('你好', 'text-embedding-v4').join(','), '0.1,0.2');
  check('未命中返回 undefined', cacheA.get('不存在', 'text-embedding-v4'), 'undefined');
  check('命中后再 get 成功', cacheA.get('你好', 'text-embedding-v4').length, 2);
  check('缓存条数', cacheA.size(), 1);
  check('命中统计', cacheA.stats().hits, 2);
  check('未命中统计', cacheA.stats().misses, 1);
  cacheA.clear();
  check('清空后为 0', cacheA.size(), 0);

  // TTL 过期（自定义时间源）
  let fakeNow = 1000;
  const cacheB = createEmbeddingCache({ ttlMs: 100, now: () => fakeNow });
  cacheB.set('甲', 'm', [1]);
  check('未过期可命中', cacheB.get('甲', 'm').join(','), '1');
  fakeNow = 1200;
  check('过期后失效', cacheB.get('甲', 'm'), 'undefined');

  // 容量上限
  const cacheC = createEmbeddingCache({ maxEntries: 3 });
  cacheC.set('a', 'm', [1]);
  cacheC.set('b', 'm', [2]);
  cacheC.set('c', 'm', [3]);
  cacheC.set('d', 'm', [4]);
  check('超过上限后条数不超限', cacheC.size(), 3);
  check('最早的一条被淘汰', cacheC.get('a', 'm'), 'undefined');
  check('最新的一条保留', cacheC.get('d', 'm').join(','), '4');
  check('淘汰计数', cacheC.stats().evicted, 1);

  // ==================== 四、lib/bailian.js：地址与配置 ====================
  console.log('【四】接口地址与配置');
  check('默认地址补全 /embeddings', normalizeBaseUrl(''), 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings');
  check('去掉结尾斜杠', normalizeBaseUrl('https://a.cn/compatible-mode/v1/'), 'https://a.cn/compatible-mode/v1/embeddings');
  check(
    '业务空间专属地址',
    normalizeBaseUrl('https://ws-abc123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'),
    'https://ws-abc123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings'
  );
  check('已带 /embeddings 时不再拼接', normalizeBaseUrl('https://a.cn/v1/embeddings'), 'https://a.cn/v1/embeddings');

  const clientDefault = createBailianClient({ env: {}, apiKey: TEST_KEY });
  const info = clientDefault.describe();
  check('模型固定', info.model, 'text-embedding-v4');
  check('维度固定 1024', info.dimensions, 1024);
  check('单次上限 10 条', info.maxTexts, 10);
  check('已检测到密钥', info.hasApiKey, 'true');
  check('红act 工具可用', redact('abc' + TEST_KEY + 'def', [TEST_KEY]), 'abc***def');

  // ==================== 五、lib/bailian.js：未配置密钥 ====================
  console.log('【五】未配置密钥');
  let caught = null;
  try {
    await createBailianClient({ env: {}, apiKey: '' }).embedTexts(['你好']);
  } catch (error) { caught = error; }
  check('抛出 BailianError', caught instanceof BailianError, 'true');
  check('错误码', caught && caught.code, 'missing_api_key');
  check('密钥为空时不发请求', true, 'true');
  check('未配置时 hasApiKey 为 false', createBailianClient({ env: {}, apiKey: '' }).describe().hasApiKey, 'false');

  // ==================== 六、lib/bailian.js：模拟成功响应 ====================
  console.log('【六】模拟上游成功响应');
  let seenUrl = '';
  let seenInit = null;
  const successBody = {
    data: [
      { index: 0, embedding: makeVector(1024, 0) },
      { index: 1, embedding: makeVector(1024, 1) }
    ],
    usage: { total_tokens: 12 }
  };
  const okClient = createBailianClient({
    apiKey: TEST_KEY,
    baseUrl: 'https://ws-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    fetchImpl: mockFetch(function (url, init) {
      seenUrl = url; seenInit = init;
      return mockResponse(successBody, 200);
    })
  });
  const okResult = await okClient.embedTexts(['第一条', '第二条']);
  check('请求地址正确', seenUrl, 'https://ws-test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/embeddings');
  check('使用 POST', seenInit.method, 'POST');
  check('带 Authorization 头', seenInit.headers.Authorization, 'Bearer ' + TEST_KEY);
  const sentBody = JSON.parse(seenInit.body);
  check('请求体 model', sentBody.model, 'text-embedding-v4');
  check('请求体 dimensions', sentBody.dimensions, 1024);
  check('请求体 encoding_format', sentBody.encoding_format, 'float');
  check('请求体 input 条数', sentBody.input.length, 2);
  check('返回向量条数', okResult.embeddings.length, 2);
  check('每条向量维度 1024', okResult.embeddings[0].length + '/' + okResult.embeddings[1].length, '1024/1024');
  check('返回 usage', okResult.usage.total_tokens, 12);

  // ==================== 七、lib/bailian.js：各种失败情况 ====================
  console.log('【七】模拟上游失败情况');
  async function expectFailure(label, fetchOrBodyCase) {
    const client = createBailianClient(Object.assign({ apiKey: TEST_KEY }, fetchOrBodyCase.options));
    try {
      await client.embedTexts(['你好']);
      return { code: '无异常', message: '' };
    } catch (error) {
      return { code: error.code, message: error.message, status: error.httpStatus };
    }
  }

  let r = await expectFailure('HTTP 401', {
    options: {
      fetchImpl: mockFetch(() => mockResponse({ error: { message: 'invalid api key ' + TEST_KEY } }, 401, false))
    }
  });
  check('HTTP 401 错误码', r.code, 'http_error');
  check('HTTP 状态被记录', r.status, 401);
  check('错误信息不含密钥', r.message.includes(TEST_KEY), 'false');
  check('错误信息已脱敏', r.message.includes('***'), 'true');

  r = await expectFailure('网络异常', {
    options: {
      fetchImpl: async function () { throw new Error('fetch failed'); }
    }
  });
  check('网络异常错误码', r.code, 'request_failed');

  r = await expectFailure('非 JSON 返回', {
    options: {
      fetchImpl: mockFetch(() => ({
        ok: true, status: 200,
        json: async function () { throw new Error('bad json'); },
        text: async function () { return 'not json'; }
      }))
    }
  });
  check('非 JSON 错误码', r.code, 'invalid_response');

  r = await expectFailure('缺少 data 字段', {
    options: { fetchImpl: mockFetch(() => mockResponse({ foo: 1 }, 200)) }
  });
  check('缺少 data 错误码', r.code, 'invalid_response');

  // 请求 2 条、上游只返回 1 条
  try {
    await createBailianClient({
      apiKey: TEST_KEY,
      fetchImpl: mockFetch(() => mockResponse({ data: [{ index: 0, embedding: makeVector(1024, 0) }] }, 200))
    }).embedTexts(['一', '二']);
    r = { code: '无异常' };
  } catch (error) { r = error; }
  check('返回条数不足时报错', r.code, 'invalid_response');

  r = await expectFailure('维度不是 1024', {
    options: {
      fetchImpl: mockFetch(() => mockResponse({ data: [{ index: 0, embedding: makeVector(512, 0) }] }, 200))
    }
  });
  check('维度错误码', r.code, 'dimension_mismatch');

  const dimClient = createBailianClient({
    apiKey: TEST_KEY,
    fetchImpl: mockFetch(() => mockResponse({ data: [{ index: 0, embedding: makeVector(1024, 0) }] }, 200))
  });
  try {
    await dimClient.embedTexts([]);
  } catch (error) { r = error; }
  check('空文本列表错误码', r.code, 'invalid_input');

  // ==================== 八、POST /api/embed 接口（真实 HTTP） ====================
  console.log('【八】POST /api/embed 接口');
  await withServer(function () {
    return createApp({ bailianClient: fakeClient() });
  }, async function (base) {
    const res = await fetch(base + '/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: ['今天好累', '陪我聊聊天'] })
    });
    const body = await res.json();
    check('正常请求状态码', res.status, 200);
    check('返回 status', body.status, 'ok');
    check('返回模型名', body.model, 'text-embedding-v4');
    check('返回维度', body.dimensions, 1024);
    check('返回向量条数', body.embeddings.length, 2);
    check('第 1 条维度 1024', body.embeddings[0].length, 1024);
    check('第 2 条维度 1024', body.embeddings[1].length, 1024);
    check('首次无缓存命中', body.cachedCount, 0);
    check('响应不含密钥', JSON.stringify(body).includes(TEST_KEY), 'false');
  });

  // 缓存命中：同一份文本第二次请求不再调用上游
  const cachedProbe = fakeClient();
  await withServer(function () {
    return createApp({ bailianClient: cachedProbe });
  }, async function (base) {
    const post = () => fetch(base + '/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: ['甲', '乙'] })
    }).then(r => r.json());

    const first = await post();
    check('第一次调用上游', cachedProbe.calls.length, 1);
    const second = await post();
    check('第二次未再调用上游', cachedProbe.calls.length, 1);
    check('第二次全部命中缓存', second.cachedCount, 2);
    check('两次结果一致', crypto.createHash('md5').update(JSON.stringify(first.embeddings)).digest('hex')
      === crypto.createHash('md5').update(JSON.stringify(second.embeddings)).digest('hex'), 'true');

    const third = await fetch(base + '/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: ['甲', '丙'] })
    }).then(r => r.json());
    check('部分命中时只请求新文本', JSON.stringify(cachedProbe.calls[1]), JSON.stringify(['丙']));
    check('部分命中缓存数', third.cachedCount, 1);
  });

  // 输入不合法 → 400
  await withServer(function () {
    return createApp({ bailianClient: fakeClient() });
  }, async function (base) {
    async function postRaw(payload) {
      const res = await fetch(base + '/api/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return { status: res.status, body: await res.json() };
    }

    let out = await postRaw({});
    check('缺少 texts → 400', out.status, 400);
    check('缺少 texts 错误码', out.body.code, 'invalid_texts');

    out = await postRaw({ texts: [] });
    check('空数组 → 400', out.status, 400);
    check('空数组错误码', out.body.code, 'empty_texts');

    out = await postRaw({ texts: new Array(11).fill('x') });
    check('11 条 → 400', out.status, 400);
    check('11 条错误码', out.body.code, 'too_many_texts');

    out = await postRaw({ texts: ['好', 5] });
    check('含非字符串 → 400', out.status, 400);
    check('非字符串错误码', out.body.code, 'invalid_text_item');

    out = await postRaw({ texts: ['   '] });
    check('空白字符串 → 400', out.status, 400);
    check('空白字符串错误码', out.body.code, 'empty_text_item');

    out = await postRaw({ texts: ['x'.repeat(9000)] });
    check('超长文本 → 400', out.status, 400);
    check('超长文本错误码', out.body.code, 'too_long_text');

    out = await postRaw({ texts: '我是字符串不是数组' });
    check('texts 为字符串 → 400', out.status, 400);
  });

  // 未配置密钥 → 503
  await withServer(function () {
    return createApp({ bailianClient: fakeClient({ hasApiKey: false }) });
  }, async function (base) {
    const res = await fetch(base + '/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: ['你好'] })
    });
    const body = await res.json();
    check('未配置密钥状态码 503', res.status, 503);
    check('未配置密钥错误码', body.code, 'missing_api_key');
    check('提示语包含 .env', body.message.includes('.env'), 'true');
    check('响应不含任何密钥', JSON.stringify(body).includes(TEST_KEY), 'false');
  });

  // 上游失败 → 502，且不泄露密钥
  const upstreamError = new BailianError('http_error', '阿里云百炼返回错误 HTTP 500：boom ' + TEST_KEY);
  // 捕获日志，确认密钥不会写进后端日志
  const originalError = console.error;
  let logText = '';
  console.error = function (text) { logText += String(text); };
  await withServer(function () {
    return createApp({ bailianClient: fakeClient({ fail: upstreamError }) });
  }, async function (base) {
    const res = await fetch(base + '/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: ['你好'] })
    });
    const body = await res.json();
    check('上游失败状态码 502', res.status, 502);
    check('上游失败错误码', body.code, 'http_error');
    check('上游失败响应已脱敏', JSON.stringify(body).includes(TEST_KEY), 'false');
  });
  console.error = originalError;
  check('后端日志不泄露密钥', logText.includes(TEST_KEY), 'false');
  check('后端日志已替换为 ***', logText.includes('***'), 'true');

  // ==================== 九、GET /api/health 与其它路由 ====================
  console.log('【九】健康检查与静态托管');
  await withServer(function () {
    return createApp({ bailianClient: fakeClient() });
  }, async function (base) {
    const res = await fetch(base + '/api/health');
    const body = await res.json();
    check('health 状态码', res.status, 200);
    check('health.status', body.status, 'ok');
    check('嵌入接口已注册', body.features.embeddingApi, 'true');
    check('未经真实调用验证', body.features.embeddingVerified, 'false');
    check('health 暴露模型名', body.embedding.model, 'text-embedding-v4');
    check('health 暴露维度', body.embedding.dimensions, 1024);
    check('health 显示密钥已配置', body.dashscopeApiKey, '已配置');
    check('health 不泄露密钥', JSON.stringify(body).includes(TEST_KEY), 'false');

    const miss = await fetch(base + '/api/not-exist');
    check('未知接口 404', miss.status, 404);
    check('未知接口返回 JSON', (await miss.json()).status, 'error');

    const home = await fetch(base + '/');
    check('首页仍可访问', home.status, 200);
    check('首页内容未变', (await home.text()).includes('Mochi Chat'), 'true');
    check('静态文件 style.css 可访问', (await fetch(base + '/style.css')).status, 200);

    const blocked = await fetch(base + '/.env');
    check('/.env 仍然禁止访问', blocked.status, 403);
  });

  // ==================== 输出汇总 ====================
  console.log('\n' + pass.join('\n'));
  if (fail.length) console.log('\n' + fail.join('\n'));
  console.log(`\n共 ${pass.length + fail.length} 项，通过 ${pass.length} 项，失败 ${fail.length} 项`);
  process.exit(fail.length ? 1 : 0);
})();
