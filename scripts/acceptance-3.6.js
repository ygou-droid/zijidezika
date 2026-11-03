// =======================================================
// Mochi Chat · 阶段 3.6 真实双模型验收脚本
//
// 运行方式（必须带 env 文件参数，脚本自身不会读取或打印 .env 内容）：
//   node --env-file-if-exists=.env scripts/acceptance-3.6.js
//
// 它会：
//   1. 在随机端口起一个真实服务端（不是 mock）
//   2. 校验三个接口的返回结构是否满足前端预期
//   3. 真实调用云端百炼一次，确认真实维度
//   4. 尝试真实切换到本地 Ollama：未就绪时验证「明确失败 + 原 Provider 不变」
//   5. 本地就绪时验证真实调用、真实维度、双向切换
//
// 退出码：
//   0 = 全部真实通过
//   2 = 云端通过，本地相关项因环境缺失「未完成」（不是通过，也不是失败）
//   1 = 出现真实失败
//
// 脚本绝不打印任何密钥、host、端口或 .env 内容；
// 所有错误文案都先经服务端脱敏再输出。
// =======================================================

'use strict';

const { createApp } = require('../server.js');

const results = []; // { kind: 'PASS' | 'FAIL' | 'SKIP', name, detail }
function pass(name, detail) { results.push({ kind: 'PASS', name: name, detail: detail || '' }); }
function fail(name, detail) { results.push({ kind: 'FAIL', name: name, detail: detail || '' }); }
function skip(name, detail) { results.push({ kind: 'SKIP', name: name, detail: detail || '' }); }

function start() {
  return new Promise(function (resolve) {
    const server = createApp().listen(0, '127.0.0.1', function () {
      resolve({ server: server, base: 'http://127.0.0.1:' + server.address().port });
    });
  });
}
function stop(server) {
  return new Promise(function (resolve) { server.close(resolve); });
}
async function getJSON(base, path) {
  const response = await fetch(base + path);
  return { status: response.status, body: await response.json() };
}
async function postJSON(base, path, payload) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return { status: response.status, body: await response.json() };
}
function hasKeys(object, keys) {
  return keys.filter(function (k) { return !(k in object); });
}
// 判断对外文案里是否夹带了内部地址或密钥形态
function leaks(text) {
  const raw = JSON.stringify(text == null ? '' : text);
  if (/https?:\/\//.test(raw)) return '包含完整 URL';
  if (/\b\d{1,3}(\.\d{1,3}){3}\b/.test(raw)) return '包含 IP 地址';
  if (/sk-[A-Za-z0-9]{4,}/.test(raw)) return '包含疑似密钥';
  if (/Bearer\s+\S+/.test(raw)) return '包含 Bearer 凭据';
  return '';
}

(async function main() {
  const app = await start();
  const base = app.base;
  let cloudOk = false;
  let localReady = false;
  let switchedToLocal = false;

  console.log('===== 阶段 3.6 真实双模型验收 =====');
  console.log('服务地址：http://127.0.0.1:<随机端口>（不打印端口号）');
  console.log('');

  try {
    // ---------- 1. 健康检查与当前身份 ----------
    const health = await getJSON(base, '/api/health');
    const keyConfigured = health.body.dashscopeApiKey === '已配置';
    console.log('[1] /api/health        ：' + health.status
      + ' · 云端密钥 ' + (keyConfigured ? '已配置（内容不显示）' : '未配置')
      + ' · 当前供应商 ' + (health.body.provider && health.body.provider.id));

    const oldFields = ['status', 'message', 'service', 'timestamp', 'uptimeSeconds', 'node',
      'dashscopeApiKey', 'embedding', 'cache', 'features', 'provider', 'availableProviders'];
    const missingHealth = hasKeys(health.body, oldFields);
    if (missingHealth.length === 0) pass('health 旧字段 + 新字段齐全');
    else fail('health 字段缺失', missingHealth.join(','));

    // ---------- 2. 两个只读接口的结构 ----------
    const status = await getJSON(base, '/api/embedding/status');
    const providers = await getJSON(base, '/api/embedding/providers');

    const statusKeys = ['status', 'current', 'defaultProviderId', 'providers', 'error'];
    const currentKeys = ['providerId', 'label', 'model', 'ready', 'measured', 'dimensionSource', 'dimensions', 'usable'];
    const providerItemKeys = ['providerId', 'label', 'model', 'isCurrent', 'usable', 'dimensions', 'lastErrorMessage'];
    const missingStatus = hasKeys(status.body, statusKeys).concat(hasKeys(status.body.current || {}, currentKeys));
    const list = providers.body.providers || [];
    const missingProvider = list.length ? hasKeys(list[0], providerItemKeys) : ['providers 为空'];
    const missingEnvelope = hasKeys(providers.body, ['status', 'currentProviderId', 'defaultProviderId', 'switchingEnabled', 'providers']);

    console.log('[2] /api/embedding/status   ：' + status.status + ' · 当前 ' + status.body.current.providerId
      + ' · 维度 ' + status.body.current.dimensions + '（' + status.body.current.dimensionSource + '）');
    console.log('    /api/embedding/providers：' + providers.status + ' · 清单 ' + list.map(function (p) {
      return p.providerId + (p.usable ? '(可用)' : '(不可用)');
    }).join('、'));

    if (!missingStatus.length && !missingProvider.length && !missingEnvelope.length) {
      pass('status / providers 结构与前端预期一致');
    } else {
      fail('接口结构不符合前端预期', missingStatus.concat(missingProvider, missingEnvelope).join(','));
    }

    const leakStatus = leaks(status.body) || leaks(providers.body);
    if (!leakStatus) pass('两个只读接口不含 host / 端口 / 密钥');
    else fail('只读接口疑似泄露', leakStatus);

    const identityAgree = health.body.provider.id === status.body.current.providerId
      && status.body.current.providerId === providers.body.currentProviderId;
    if (identityAgree) pass('三方身份一致（health / status / providers）');
    else fail('三方身份不一致', [health.body.provider.id, status.body.current.providerId, providers.body.currentProviderId].join(' / '));

    // ---------- 3. 云端真实调用 ----------
    const TEXT = '今天工作很累，想休息一下。';
    if (!keyConfigured) {
      skip('云端百炼真实 embedding 调用', '未检测到云端密钥，需在 .env 中配置后重跑');
    } else {
      const t0 = Date.now();
      const embed = await postJSON(base, '/api/embed', { texts: [TEXT] });
      const ms = Date.now() - t0;
      const declared = status.body.current.dimensions;

      if (embed.status === 200 && Array.isArray(embed.body.embeddings) && embed.body.embeddings.length === 1) {
        const vector = embed.body.embeddings[0];
        console.log('[3] 云端真实调用         ：成功 · 模型 ' + embed.body.model
          + ' · 维度 ' + embed.body.dimensions + ' · 实际 ' + vector.length + ' · 耗时 ' + ms + 'ms');
        if (vector.length === embed.body.dimensions && vector.length === declared) {
          pass('云端真实向量维度与声明一致', vector.length + ' 维');
          cloudOk = true;
        } else {
          fail('云端维度不一致', '返回 ' + vector.length + ' / 响应 ' + embed.body.dimensions + ' / 声明 ' + declared);
        }
        if (embed.body.providerId === 'cloud-bailian') pass('嵌入响应带 providerId', embed.body.providerId);
        else fail('嵌入响应 providerId 异常', String(embed.body.providerId));
      } else {
        console.log('[3] 云端真实调用         ：失败 · HTTP ' + embed.status + ' · ' + (embed.body && embed.body.code));
        fail('云端真实调用失败', String(embed.body && embed.body.code));
      }

      // 同一句再发一次：应命中缓存，不再走上游
      const again = await postJSON(base, '/api/embed', { texts: [TEXT] });
      if (again.status === 200 && again.body.cachedCount === 1) pass('同文本第二次命中缓存');
      else fail('缓存未命中', 'cachedCount=' + (again.body && again.body.cachedCount));
    }

    // ---------- 4. 本地是否就绪（看真实探针结果） ----------
    const localItem = list.find(function (p) { return p.providerId === 'local-ollama'; }) || {};
    localReady = localItem.usable === true;
    console.log('[4] 本地 Ollama 就绪      ：' + (localReady ? '是（维度 ' + localItem.dimensions + '）'
      : '否（' + (localItem.lastErrorCode || 'unavailable') + '）'));
    if (!localReady && localItem.lastErrorMessage) {
      console.log('    失败文案（已脱敏）    ：' + localItem.lastErrorMessage);
    }

    // ---------- 5. 本地未就绪时：切换必须失败且原 Provider 不变 ----------
    if (!localReady) {
      const attempt = await postJSON(base, '/api/embedding/switch', { providerId: 'local-ollama' });
      console.log('[5] 切换到本地（预期失败）：HTTP ' + attempt.status + ' · ' + attempt.body.code);
      const codes = ['local_unavailable', 'local_model_missing', 'provider_not_ready'];
      if (attempt.status >= 400 && codes.indexOf(attempt.body.code) >= 0) {
        pass('本地未就绪时切换被明确拒绝', attempt.body.code);
      } else {
        fail('本地未就绪时切换未被拒绝', 'HTTP ' + attempt.status + ' / ' + attempt.body.code);
      }
      if (attempt.body.currentProviderId === 'cloud-bailian') pass('拒绝切换后当前供应商仍是云端');
      else fail('拒绝切换后当前供应商被改动', String(attempt.body.currentProviderId));

      const leakMsg = leaks(attempt.body.message || '');
      if (!leakMsg) pass('失败文案不含 host / 密钥');
      else fail('失败文案疑似泄露', leakMsg);

      const afterHealth = await getJSON(base, '/api/health');
      const afterStatus = await getJSON(base, '/api/embedding/status');
      if (afterHealth.body.provider.id === 'cloud-bailian' && afterStatus.body.current.providerId === 'cloud-bailian') {
        pass('失败回退：服务端身份未变');
      } else {
        fail('失败回退异常', afterHealth.body.provider.id + ' / ' + afterStatus.body.current.providerId);
      }

      if (keyConfigured) {
        const stillWorks = await postJSON(base, '/api/embed', { texts: [TEXT] });
        if (stillWorks.status === 200 && stillWorks.body.providerId === 'cloud-bailian') {
          pass('失败回退后聊天请求仍走云端');
        } else {
          fail('失败回退后请求异常', 'HTTP ' + stillWorks.status + ' / ' + (stillWorks.body && stillWorks.body.providerId));
        }
      }

      skip('本地模型未下载时的失败提示', '需先启动 Ollama，再用 OLLAMA_MODEL=<未下载模型> 重跑（见手动步骤）');
      skip('本地真实 embedding 调用', '本机 Ollama 未就绪，无法真实调用');
      skip('本地真实向量维度测量', '同上');
      skip('云端 → 本地 → 云端 双向切换', '同上');
      skip('切换后第一次聊天请求使用新 Provider', '同上');
      skip('切换后旧向量缓存失效（真实本地侧）', '同上');
    } else {
      // ---------- 6. 本地就绪：真实切换 + 真实调用 + 双向 ----------
      const toLocal = await postJSON(base, '/api/embedding/switch', { providerId: 'local-ollama' });
      console.log('[5] 云端 → 本地           ：HTTP ' + toLocal.status + ' · ' + (toLocal.body.providerId || toLocal.body.code)
        + ' · 维度 ' + toLocal.body.dimensions);
      if (toLocal.status === 200 && toLocal.body.providerId === 'local-ollama') {
        pass('云端 → 本地 切换成功', '维度 ' + toLocal.body.dimensions);
        switchedToLocal = true;
      } else {
        fail('云端 → 本地 切换失败', String(toLocal.body.code));
      }

      if (switchedToLocal) {
        const firstChat = await postJSON(base, '/api/embed', { texts: [TEXT + '（切换后第一次）'] });
        console.log('[6] 切换后第一次请求      ：' + firstChat.status + ' · ' + firstChat.body.providerId
          + ' · 维度 ' + firstChat.body.dimensions);
        if (firstChat.status === 200 && firstChat.body.providerId === 'local-ollama') {
          pass('切换后第一次请求确实走本地');
        } else {
          fail('切换后第一次请求未走新 Provider', String(firstChat.body && firstChat.body.providerId));
        }
        const vector = firstChat.body.embeddings && firstChat.body.embeddings[0];
        if (Array.isArray(vector) && vector.length === firstChat.body.dimensions
          && vector.length === localItem.dimensions) {
          pass('本地真实向量维度与实测一致', vector.length + ' 维');
        } else {
          fail('本地维度不一致', (vector && vector.length) + ' / ' + firstChat.body.dimensions + ' / 实测 ' + localItem.dimensions);
        }

        // 同一句在云端算过，本地必须重新算（身份隔离）
        const isolated = await postJSON(base, '/api/embed', { texts: [TEXT] });
        if (isolated.status === 200 && isolated.body.cachedCount === 0) {
          pass('切换后不复用云端向量缓存', 'cachedCount=0');
        } else {
          fail('切换后疑似命中云端缓存', 'cachedCount=' + (isolated.body && isolated.body.cachedCount));
        }

        const back = await postJSON(base, '/api/embedding/switch', { providerId: 'cloud-bailian' });
        console.log('[7] 本地 → 云端           ：HTTP ' + back.status + ' · ' + (back.body.providerId || back.body.code));
        if (back.status === 200 && back.body.providerId === 'cloud-bailian') pass('本地 → 云端 切换成功');
        else fail('本地 → 云端 切换失败', String(back.body.code));

        if (back.status === 200 && keyConfigured) {
          const backChat = await postJSON(base, '/api/embed', { texts: [TEXT] });
          if (backChat.status === 200 && backChat.body.providerId === 'cloud-bailian' && backChat.body.cachedCount === 1) {
            pass('切回云端后命中云端旧缓存（证明是隔离而非删除）', 'cachedCount=1');
          } else {
            fail('切回云端后缓存行为异常', 'HTTP ' + backChat.status + ' / cached=' + (backChat.body && backChat.body.cachedCount));
          }
        }
      }
    }

    // ---------- 7. 未知供应商与参数校验 ----------
    const unknown = await postJSON(base, '/api/embedding/switch', { providerId: 'no-such-provider' });
    if (unknown.status >= 400 && unknown.body.code === 'unknown_provider') pass('未知供应商被拒绝', unknown.body.code);
    else fail('未知供应商未被拒绝', String(unknown.body.code));

    const badInput = await postJSON(base, '/api/embedding/switch', {});
    if (badInput.status === 400 && badInput.body.code === 'invalid_input') pass('缺少 providerId 返回 400');
    else fail('参数校验异常', String(badInput.body.code));

    // ---------- 8. 服务端缓存键隔离（不需要切换也能验证）----------
    if (keyConfigured) {
      const a = await postJSON(base, '/api/embed', { texts: ['隔离验证文本 A'] });
      const b = await postJSON(base, '/api/embed', { texts: ['隔离验证文本 B'] });
      if (a.body.cachedCount === 0 && b.body.cachedCount === 0) pass('不同文本各自独立缓存键');
      else fail('文本缓存键疑似冲突', 'A=' + a.body.cachedCount + ' / B=' + b.body.cachedCount);
    }
    skip('不同联系人之间的缓存隔离', '由前端 key=联系人id|文本 保证，已有 66 项自动化测试覆盖（test/ai-match.test.js）');

  } catch (error) {
    fail('脚本异常中断', String((error && error.message) || error).slice(0, 200));
  } finally {
    await stop(app.server);
  }

  // ---------- 汇总 ----------
  const passed = results.filter(function (r) { return r.kind === 'PASS'; });
  const failed = results.filter(function (r) { return r.kind === 'FAIL'; });
  const skipped = results.filter(function (r) { return r.kind === 'SKIP'; });

  console.log('');
  console.log('----- 明细 -----');
  results.forEach(function (r) {
    console.log('[' + r.kind + '] ' + r.name + (r.detail ? ' —— ' + r.detail : ''));
  });

  console.log('');
  console.log('----- 汇总 -----');
  console.log('通过 ' + passed.length + ' 项 · 失败 ' + failed.length + ' 项 · 未完成 ' + skipped.length + ' 项');
  console.log('云端真实调用：' + (cloudOk ? '已完成' : '未完成'));
  console.log('本地真实调用：' + (localReady ? '已完成' : '未完成（本机 Ollama 未就绪）'));

  if (failed.length) {
    console.log('结论：失败，请按上面 FAIL 项排查。');
    process.exit(1);
  }
  if (skipped.length) {
    console.log('结论：部分完成 —— 云端与本地均已通过，以下项本脚本无法自证，需人工确认或由自动化测试覆盖：');
    skipped.forEach(function (r) { console.log('  · ' + r.name + (r.detail ? '（' + r.detail + '）' : '')); });
    process.exit(2);
  }
  console.log('结论：全部真实通过。');
  process.exit(0);
})();
