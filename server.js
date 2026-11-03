// =======================================================
// Mochi Chat · 本地静态服务器（阶段 8 · 纯前端静态化）
//
// 项目已从全栈应用改造为纯前端静态应用：向量请求由浏览器直接发往
// 阿里云百炼 / 本地 Ollama，不再经过任何 Node.js 后端代理。
// 因此本文件只负责把 index.html 与静态资源托管出来，方便本机或局域网访问。
//
// 启动：node server.js   （默认 http://0.0.0.0:3000，可用 PORT / HOST 覆盖）
// =======================================================

const express = require('express');
const path = require('path');

// 这些路径禁止通过浏览器访问（源码 / 依赖 / 配置），仅作最低限度保护
const BLOCKED_PREFIXES = ['/server.js', '/lib', '/node_modules', '/.env', '/.gitignore', '/package.json', '/package-lock.json'];

function isBlocked(urlPath) {
  const p = urlPath.split('?')[0];
  return BLOCKED_PREFIXES.some(function (prefix) {
    return p === prefix || p.indexOf(prefix + '/') === 0;
  });
}

function createApp() {
  const app = express();

  // 先拦掉不应暴露的文件
  app.use(function (req, res, next) {
    if (isBlocked(req.path)) {
      res.status(403).type('text/plain').send('Forbidden');
      return;
    }
    next();
  });

  app.use(express.static(__dirname, { index: 'index.html' }));

  return app;
}

// 直接 node server.js 时才真的监听端口（被 require 时不会启动）
if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  // 默认监听所有网络接口（0.0.0.0），让局域网内的手机 / 其他设备也能访问；
  // 仍可用 HOST 环境变量覆盖（例如 HOST=127.0.0.1 仅本机）
  const HOST = process.env.HOST || '0.0.0.0';

  const server = createApp().listen(PORT, HOST, function () {
    console.log('');
    console.log('  Mochi Chat 已启动（纯静态托管，向量请求由浏览器直连模型服务）');
    console.log('  本机访问：  http://127.0.0.1:' + PORT + '/');
    console.log('  局域网访问： http://<本机局域网 IP>:' + PORT + '/（同 Wi-Fi 下的手机可访问）');
    console.log('  停止服务：  在终端里按 Ctrl + C');
    console.log('');
  });

  // 优雅退出
  function shutdown() {
    server.close(function () { process.exit(0); });
    setTimeout(function () { process.exit(0); }, 2000);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
