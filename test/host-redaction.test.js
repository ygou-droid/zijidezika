// =======================================================
// Mochi Chat · 阶段 3.6 验收缺陷修复测试（最小追加）
// 运行方式： node test/host-redaction.test.js
//
// 只验证两件事：
//   1. normalizeHost：无协议 host:port 自动补 http://，
//      已带协议保持不变，configToken 走规范化后的值
//   2. redactAddresses：无协议 host:port 不再外泄，
//      且不误伤错误码、维度数字、时间格式
// 不联网、不需要密钥、不安装 Ollama。
// =======================================================

'use strict';

const net = require('net');
const { createApp } = require('../server.js');
// 阶段 8：后端已剥离，本测试依赖 Node.js 后端代理，默认隐藏（set MOCHI_RUN_BACKEND_TESTS=1 可强行运行）
if (process.env.MOCHI_RUN_BACKEND_TESTS !== '1') {
  console.log('（跳过）' + __filename.split(/[\\/]/).pop() + '：依赖已废弃的 Node.js 后端，已隐藏。');
  return;
}
const { redactAddresses } = require('../server.js');
const { createOllamaProvider } = require('../lib/embedding/local-ollama.js');

// 取一个当前确实空闲的端口：本机可能真的装了 Ollama，不能写死 11434
function freePort() {
  return new Promise(function (resolve) {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', function () {
      const port = probe.address().port;
      probe.close(function () { resolve(port); });
    });
  });
}

const pass = [];
const fail = [];
function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  (ok ? pass : fail).push(`${ok ? '通过' : '失败'}  ${name} => 实际: ${actual}` + (ok ? '' : `  期望: ${expected}`));
}
const wait = ms => new Promise(r => setTimeout(r, ms));
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

(async function run() {
  console.log('===== host 规范化与地址脱敏修复测试 =====\n');

  // ============ 一、normalizeHost：补协议与不变语义 ============
  console.log('【一】normalizeHost 补协议');
  const deadPort = await freePort();
  {
    // 无协议 host:port → 自动补 http://
    const plain = createOllamaProvider({ host: '127.0.0.1:' + deadPort, model: 'm', timeoutMs: 300 });
    check('IPv4 无协议补 http', plain.describe().endpoint, 'http://127.0.0.1:' + deadPort + '/api/embed');

    const localhost = createOllamaProvider({ host: 'localhost:' + deadPort, model: 'm', timeoutMs: 300 });
    check('localhost 无协议补 http', localhost.describe().endpoint, 'http://localhost:' + deadPort + '/api/embed');

    const wildcard = createOllamaProvider({ host: '0.0.0.0:' + deadPort, model: 'm', timeoutMs: 300 });
    check('0.0.0.0 无协议补 http', wildcard.describe().endpoint, 'http://0.0.0.0:' + deadPort + '/api/embed');

    const noPort = createOllamaProvider({ host: 'myhost', model: 'm', timeoutMs: 300 });
    check('无端口也补协议', noPort.describe().endpoint, 'http://myhost/api/embed');

    // 已带协议 → 保持不变
    const withHttp = createOllamaProvider({ host: 'http://127.0.0.1:11434', model: 'm', timeoutMs: 300 });
    check('已有 http 保持不变', withHttp.describe().endpoint, 'http://127.0.0.1:11434/api/embed');

    const withHttps = createOllamaProvider({ host: 'https://ollama.example.com', model: 'm', timeoutMs: 300 });
    check('已有 https 保持不变', withHttps.describe().endpoint, 'https://ollama.example.com/api/embed');

    const trailingSlash = createOllamaProvider({ host: 'http://127.0.0.1:11434/', model: 'm', timeoutMs: 300 });
    check('结尾斜杠仍被剪掉', trailingSlash.describe().endpoint, 'http://127.0.0.1:11434/api/embed');

    // configToken 走规范化后的值：同一配置只产生一个身份
    const a = createOllamaProvider({ host: '127.0.0.1:' + deadPort, model: 'm', timeoutMs: 300 });
    const b = createOllamaProvider({ host: 'http://127.0.0.1:' + deadPort, model: 'm', timeoutMs: 300 });
    check('补协议后两种写法 endpoint 一致',
      a.describe().endpoint === b.describe().endpoint, 'true');

    // 未就绪时的失败语义是真实连接失败，不是 URL 解析错误
    const result = await a.ensureMeasured();
    check('无协议 host 也能得到连接失败语义', result.code, 'local_unavailable');
    check('错误不再是 Failed to parse URL',
      String(result.message).includes('Failed to parse URL'), 'false');
    check('错误信息里出现的是规范化后的地址',
      String(result.message).includes('http://127.0.0.1:' + deadPort), 'true');
  }

  // ============ 二、redactAddresses：纯函数级 ============
  console.log('【二】redactAddresses 脱敏');
  {
    check('带协议 URL 被抹掉',
      redactAddresses('无法连接本地 Ollama（http://127.0.0.1:11434）：fetch failed').includes('127.0.0.1'), 'false');
    check('无协议 IPv4:port 被抹掉',
      redactAddresses('无法连接本地 Ollama（127.0.0.1:11434）：x').includes('127.0.0.1'), 'false');
    check('localhost:port 被抹掉',
      redactAddresses('无法连接本地 Ollama（localhost:11434）：x').includes('localhost'), 'false');
    check('0.0.0.0:port 被抹掉',
      redactAddresses('无法连接本地 Ollama（0.0.0.0:11434）：x').includes('0.0.0.0'), 'false');
    check('单字母端口也能被抹掉',
      redactAddresses('Failed to parse URL from 127.0.0.1:1/api/embed').includes('127.0.0.1'), 'false');
    check('域名:port 被抹掉',
      redactAddresses('无法连接（ollama.internal:11434）').includes('ollama.internal'), 'false');

    // 不误伤
    check('错误码不受影响',
      redactAddresses('local_unavailable, provider_not_ready, local_model_missing'),
      'local_unavailable, provider_not_ready, local_model_missing');
    check('维度数字不受影响', redactAddresses('维度 1024 与实测 768'), '维度 1024 与实测 768');
    check('ISO 时间戳不被误伤',
      redactAddresses('上次检查 2026-11-02T15:50:59.123Z'),
      '上次检查 2026-11-02T15:50:59.123Z');
    check('纯时间不被误伤', redactAddresses('at 15:50:59 after 09:01'), 'at 15:50:59 after 09:01');
    check('日期范围不被误伤', redactAddresses('2026-11-02 15:50 至 2026-11-03'), '2026-11-02 15:50 至 2026-11-03');
    check('null 输入返回空串', redactAddresses(null), '');
  }

  // ============ 三、接口级：三个接口都不外泄 host:port ============
  console.log('【三】接口级脱敏');
  {
    // 用无协议 host 指向确认空闲的端口，模拟用户只写 host:port 的真实场景
    const app = await startApp({
      env: { OLLAMA_HOST: '127.0.0.1:' + deadPort, OLLAMA_MODEL: 'm', OLLAMA_TIMEOUT_MS: '300' },
      fetchImpl: function (url, init) { return fetch(url, init); }
    });
    try {
      const status = await (await fetch(app.base + '/api/embedding/status')).json();
      const providers = await (await fetch(app.base + '/api/embedding/providers')).json();
      const switched = await fetch(app.base + '/api/embedding/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: 'local-ollama' })
      });
      const switchBody = await switched.json();

      const localStatus = (status.providers || []).find(function (p) { return p.providerId === 'local-ollama'; });
      const localList = (providers.providers || []).find(function (p) { return p.providerId === 'local-ollama'; });

      // 状态本身
      check('status：本地仍未就绪', localStatus && localStatus.usable, 'false');
      check('status：错误码真实', localStatus && localStatus.lastErrorCode, 'local_unavailable');
      check('providers：错误码真实', localList && localList.lastErrorCode, 'local_unavailable');
      check('switch：切换被拒绝', switchBody.code, 'local_unavailable');

      // 三个接口的文案都不含 host:port / Failed to parse URL
      const all = JSON.stringify([status, providers, switchBody]);
      check('接口文案不含 127.0.0.1', all.includes('127.0.0.1'), 'false');
      check('接口文案不含端口 :1', /127\.0\.0\.1:\d/.test(all), 'false');
      check('接口文案不再是 Failed to parse URL', all.includes('Failed to parse URL'), 'false');
      check('接口文案保留了失败语义', all.includes('无法连接本地 Ollama'), 'true');
      check('接口文案不含密钥形态', /sk-[A-Za-z0-9]{4,}/.test(all), 'false');

      // 原供应商保持不变
      check('拒绝切换后仍是云端', switchBody.currentProviderId, 'cloud-bailian');
      check('服务身份未变', status.current.providerId, 'cloud-bailian');
    } finally {
      await close(app.server);
    }
  }

  console.log('\n' + pass.join('\n'));
  if (fail.length) console.log('\n' + fail.join('\n'));
  console.log(`\n共 ${pass.length + fail.length} 项，通过 ${pass.length} 项，失败 ${fail.length} 项`);
  process.exit(fail.length ? 1 : 0);
})();
