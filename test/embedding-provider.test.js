// =======================================================
// Mochi Chat · 向量供应商接口测试（双模型改造 · 阶段 1）
// 运行方式： node test/embedding-provider.test.js
// 说明：全部使用假对象与本地服务，不联网、不需要密钥、不调用真实 API
// =======================================================

'use strict';

const crypto = require('crypto');
const { createApp } = require('../server.js');
const { assertProvider, safeRedact, PROVIDER_INTERFACE_VERSION } = require('../lib/embedding/provider-contract.js');
const { createCloudBailianProvider, PROVIDER_ID, PROVIDER_LABEL } = require('../lib/embedding/cloud-bailian.js');

const pass = [];
const fail = [];
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  (ok ? pass : fail).push(`${ok ? '通过' : '失败'}  ${name} => 实际: ${actual}` + (ok ? '' : `  期望: ${expected}`));
}

// 测试专用字符串，绝不是真实密钥
const FAKE_KEY = 'sk-test-not-a-real-key';

function startApp(options) {
  return new Promise(function (resolve) {
    const server = createApp(options).listen(0, '127.0.0.1', function () {
      resolve({ server: server, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}
function close(server) {
  return new Promise(function (resolve) { server.close(resolve); });
}

function makeVector(dimensions, seed) {
  const v = new Array(dimensions).fill(0);
  v[seed % dimensions] = 1;
  return v;
}

// 一个满足统一接口的假供应商
function fakeProvider(options) {
  const settings = options || {};
  const dimensions = settings.dimensions || 1024;
  return {
    calls: [],
    describe: function () {
      return {
        providerId: settings.providerId || 'fake-provider',
        label: settings.label || '假供应商',
        model: settings.model || 'fake-model',
        dimensions: dimensions,
        endpoint: 'http://127.0.0.1/mock',
        maxTexts: settings.maxTexts || 10,
        maxTextLength: 8192,
        timeoutMs: 1000,
        ready: settings.ready !== false
      };
    },
    embedTexts: async function (texts) {
      this.calls.push(texts.slice());
      if (settings.fail) throw settings.fail;
      return {
        embeddings: texts.map((t, i) => makeVector(dimensions, i + 1)),
        model: settings.model || 'fake-model',
        dimensions: dimensions,
        usage: null
      };
    },
    redact: function (text) { return String(text).split(FAKE_KEY).join('***'); }
  };
}

(async function run() {
  console.log('===== 向量供应商接口测试 =====\n');

  // ---------- 一、assertProvider 校验 ----------
  console.log('【一】接口校验 assertProvider');
  {
    check('接口版本号已知', PROVIDER_INTERFACE_VERSION, 1);

    const good = fakeProvider();
    check('合法供应商通过校验', assertProvider(good) === good, 'true');

    const throws = function (provider) {
      try { assertProvider(provider); return '未抛出异常'; }
      catch (error) { return error instanceof TypeError ? error.message : '非 TypeError'; }
    };

    check('null 被拒绝', /必须是一个对象/.test(throws(null)), 'true');
    check('字符串被拒绝', /必须是一个对象/.test(throws('x')), 'true');
    check('缺少 describe 被拒绝', /缺少方法 describe/.test(throws({ embedTexts: function () {}, redact: function () {} })), 'true');
    check('缺少 embedTexts 被拒绝', /缺少方法 embedTexts/.test(throws({ describe: function () { return {}; }, redact: function () {} })), 'true');
    check('缺少 redact 被拒绝', /缺少方法 redact/.test(throws({ describe: function () { return {}; }, embedTexts: function () {} })), 'true');

    const base = { providerId: 'p', label: 'l', model: 'm', dimensions: 1024, maxTexts: 10, maxTextLength: 8192, ready: true };
    check('describe 返回非对象被拒绝',
      /describe\(\) 必须返回一个对象/.test(throws({ describe: function () { return null; }, embedTexts: function () {}, redact: function () {} })), 'true');

    const missingWhich = function (field) {
      const info = Object.assign({}, base);
      delete info[field];
      return throws({ describe: function () { return info; }, embedTexts: function () {}, redact: function () {} });
    };
    check('缺少 providerId 被拒绝', /providerId/.test(missingWhich('providerId')), 'true');
    check('缺少 label 被拒绝', /label/.test(missingWhich('label')), 'true');
    check('缺少 model 被拒绝', /model/.test(missingWhich('model')), 'true');
    check('缺少 maxTexts 被拒绝', /maxTexts/.test(missingWhich('maxTexts')), 'true');

    const wrongType = function (field, value) {
      const info = Object.assign({}, base);
      info[field] = value;
      return throws({ describe: function () { return info; }, embedTexts: function () {}, redact: function () {} });
    };
    check('providerId 非字符串被拒绝', /providerId 应为 string/.test(wrongType('providerId', 123)), 'true');
    check('model 为空字符串被拒绝', /model 不能为空字符串/.test(wrongType('model', '')), 'true');
    check('dimensions 非数字被拒绝', /dimensions 应为 number/.test(wrongType('dimensions', '1024')), 'true');
    check('dimensions 为 0 被拒绝', /dimensions 必须是正数/.test(wrongType('dimensions', 0)), 'true');
    check('ready 非布尔被拒绝', /ready 应为 boolean/.test(wrongType('ready', 'yes')), 'true');

    // 可选方法缺失不影响
    check('缺少可选方法也合法', assertProvider(fakeProvider()) !== null, 'true');
  }

  // ---------- 二、云端供应商薄包装 ----------
  console.log('【二】云端供应商（薄包装 lib/bailian.js）');
  {
    const fakeBailian = {
      describe: function () {
        return { model: 'text-embedding-v4', dimensions: 1024, endpoint: 'http://x/v1', hasApiKey: true, maxTexts: 10, maxTextLength: 8192, timeoutMs: 8000 };
      },
      embedTexts: async function (texts) {
        return { embeddings: texts.map((t, i) => makeVector(1024, i)), model: 'text-embedding-v4', dimensions: 1024, usage: null };
      },
      redact: function (text) { return String(text).split(FAKE_KEY).join('***'); }
    };

    const provider = createCloudBailianProvider({ client: fakeBailian });
    check('providerId 正确', provider.describe().providerId, PROVIDER_ID);
    check('label 正确', provider.describe().label, PROVIDER_LABEL);
    check('通过接口校验', assertProvider(provider) === provider, 'true');
    check('保留原模型名', provider.describe().model, 'text-embedding-v4');
    check('保留原维度', provider.describe().dimensions, 1024);
    check('保留单次批量上限', provider.describe().maxTexts, 10);
    check('保留单条长度上限', provider.describe().maxTextLength, 8192);
    check('ready 映射自 hasApiKey', provider.describe().ready, 'true');
    check('兼容字段 hasApiKey 仍存在', provider.describe().hasApiKey, 'true');
    check('unwrap 能拿到原始客户端', provider.unwrap() === fakeBailian, 'true');

    const result = await provider.embedTexts(['甲', '乙']);
    check('embedTexts 原样透传', result.embeddings.length, 2);
    check('embedTexts 维度正确', result.embeddings[0].length, 1024);
    check('redact 会遮掉测试用密钥', provider.redact('错误内容 ' + FAKE_KEY), '错误内容 ***');
    check('checkAvailable 就绪', provider.checkAvailable().ok, 'true');

    const noKey = createCloudBailianProvider({
      client: { describe: function () { return { hasApiKey: false }; }, embedTexts: async function () { return null; } }
    });
    check('无密钥时 ready 为 false', noKey.describe().ready, 'false');
    check('无密钥时接口校验仍通过', assertProvider(noKey) === noKey, 'true');
    check('无密钥时 checkAvailable 给出缺密钥码', noKey.checkAvailable().code, 'missing_api_key');

    const bare = createCloudBailianProvider({ client: {} });
    check('客户端缺 describe 也不崩（用默认值）', bare.describe().model, 'text-embedding-v4');
    check('客户端缺 describe 时 ready 为 false', bare.describe().ready, 'false');

    // 从环境变量创建、且没有密钥：不应发起任何网络请求
    const fromEnv = createCloudBailianProvider({ env: {} });
    check('按 env 创建：未配置密钥', fromEnv.describe().ready, 'false');
    let envError = null;
    try { await fromEnv.embedTexts(['你好']); } catch (error) { envError = error; }
    check('按 env 创建：未配置密钥时报错', envError && envError.code, 'missing_api_key');
  }

  // ---------- 三、safeRedact 容错 ----------
  console.log('【三】脱敏容错 safeRedact');
  {
    check('有 redact 时使用它的结果', safeRedact(fakeProvider(), 'x ' + FAKE_KEY), 'x ***');
    check('没有 redact 也不崩', safeRedact({}, '原文'), '原文');
    check('空值不崩', safeRedact(fakeProvider(), null), '');
  }

  // ---------- 四、server 通过统一接口工作 ----------
  console.log('【四】server 改用统一接口后的行为');
  {
    const provider = fakeProvider();
    const { server, base } = await startApp({ provider: provider });
    try {
      const embed = async function (texts) {
        const res = await fetch(base + '/api/embed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texts: texts })
        });
        return { status: res.status, body: await res.json() };
      };

      const first = await embed(['甲', '乙']);
      check('新写法注入 provider：接口可用', first.status, 200);
      check('返回 model 取自 provider', first.body.model, 'fake-model');
      check('返回 embeddings 数量正确', first.body.embeddings.length, 2);
      check('首次全部未命中缓存', first.body.cachedCount, 0);
      check('首次请求条数正确', first.body.requestedCount, 2);

      const second = await embed(['甲']);
      check('第二次命中缓存', second.body.cachedCount, 1);
      check('不再重复调用 provider', provider.calls.length, 1);

      const bad = await fetch(base + '/api/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: [] })
      });
      const badBody = await bad.json();
      check('空数组仍按旧行为返回 400', bad.status, 400);
      check('空数组错误码不变', badBody.code, 'empty_texts');

      const healthRes = await fetch(base + '/api/health');
      const health = await healthRes.json();
      check('health 仍能用', health.status, 'ok');
      check('health 字段 dashscopeApiKey 保持不变', health.dashscopeApiKey, '已配置');
      check('health.embedding.model 取自 provider', health.embedding.model, 'fake-model');
      check('health.embedding.maxTextsPerRequest 取自 provider', health.embedding.maxTextsPerRequest, 10);
      check('health.features.embeddingApi 保持 true', health.features.embeddingApi, 'true');
      check('health.features.embeddingVerified 保持 false', health.features.embeddingVerified, 'false');
      // 阶段 1 起锁定的旧十个顶层字段，必须一个不少（逐字段存在性检查）
      const keys = Object.keys(health);
      const oldFields = [
        'cache', 'dashscopeApiKey', 'embedding', 'features', 'message',
        'node', 'service', 'status', 'timestamp', 'uptimeSeconds'
      ];
      const missingOld = oldFields.filter(function (k) { return keys.indexOf(k) < 0; });
      check('health 原有十个字段全部保留', missingOld.length ? missingOld.join(',') : '无缺失', '无缺失');

      // 阶段 2 新增的通用供应商信息，单独检查
      check('health 新增 provider 字段', keys.indexOf('provider') >= 0, 'true');
      check('health 新增 availableProviders 字段', keys.indexOf('availableProviders') >= 0, 'true');
      check('health.provider.id 取自当前供应商', health.provider.id, 'fake-provider');
      check('health.provider.label 取自当前供应商', health.provider.label, '假供应商');
      check('health.availableProviders 列出全部已注册供应商',
        (health.availableProviders || []).map(p => p.providerId).join(','), 'cloud-bailian,local-ollama');
      check('默认供应商仍是云端百炼',
        (health.availableProviders || []).findIndex(p => p.providerId === 'cloud-bailian') === 0, 'true');
    } finally {
      await close(server);
    }
  }

  // ---------- 五、旧注入方式必须仍然有效 ----------
  console.log('【五】旧写法 bailianClient 注入保持兼容');
  {
    const legacy = {
      describe: function () {
        return { model: 'text-embedding-v4', dimensions: 1024, endpoint: 'mock', hasApiKey: true, maxTexts: 10, maxTextLength: 8192, timeoutMs: 1000 };
      },
      embedTexts: async function (texts) {
        return { embeddings: texts.map((t, i) => makeVector(1024, i + 1)), model: 'text-embedding-v4', dimensions: 1024, usage: null };
      },
      redact: function (t) { return String(t); }
    };
    const { server, base } = await startApp({ bailianClient: legacy });
    try {
      const res = await fetch(base + '/api/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: ['你好'] })
      });
      const body = await res.json();
      check('旧注入方式仍返回 200', res.status, 200);
      check('旧注入方式模型名不变', body.model, 'text-embedding-v4');
      check('旧注入方式维度不变', body.embeddings[0].length, 1024);

      const health = await (await fetch(base + '/api/health')).json();
      check('旧注入方式 health 判定为已配置', health.dashscopeApiKey, '已配置');

      const unconfigured = {
        describe: function () { return { model: 'text-embedding-v4', dimensions: 1024, hasApiKey: false, maxTexts: 10, maxTextLength: 8192 }; },
        embedTexts: async function () { throw new Error('不应被调用'); },
        redact: function (t) { return String(t); }
      };
      const s2 = await startApp({ bailianClient: unconfigured });
      try {
        const h2 = await (await fetch(s2.base + '/api/health')).json();
        check('旧注入方式未配置密钥时不乱说', h2.dashscopeApiKey, '未配置');
        check('旧注入方式 apiKeyConfigured 为 false', h2.embedding.apiKeyConfigured, 'false');
      } finally {
        await close(s2.server);
      }
    } finally {
      await close(server);
    }
  }

  // ---------- 六、错误路径仍走 provider 的脱敏 ----------
  console.log('【六】失败时仍经 provider 脱敏');
  {
    const upstreamError = Object.assign(new Error('上游异常 ' + FAKE_KEY), { code: 'http_error' });
    const provider = fakeProvider({ fail: upstreamError });
    const { server, base } = await startApp({ provider: provider });

    const originalError = console.error;
    let logText = '';
    console.error = function (text) { logText += String(text); };
    try {
      const res = await fetch(base + '/api/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: ['你好'] })
      });
      const body = await res.json();
      check('上游失败状态码 502', res.status, 502);
      check('上游失败错误码不变', body.code, 'http_error');
      check('响应已脱敏', body.message.includes(FAKE_KEY), 'false');
    } finally {
      console.error = originalError;
      await close(server);
    }
    check('后端日志不泄露测试用密钥', logText.includes(FAKE_KEY), 'false');
    check('日志里出现脱敏标记', logText.includes('***'), 'true');
  }

  console.log('\n' + pass.join('\n'));
  if (fail.length) console.log('\n' + fail.join('\n'));
  console.log(`\n共 ${pass.length + fail.length} 项，通过 ${pass.length} 项，失败 ${fail.length} 项`);
  process.exit(fail.length ? 1 : 0);
})();
