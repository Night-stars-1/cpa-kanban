import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { fetchSnapshot } from './lib/manager.mjs';
import { toDashboardSnapshot, toPublicFailureMessage } from './lib/dashboard.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}


function parseAuthority(value) {
  if (!value) return null;
  try {
    const authority = new URL(`http://${value}`);
    if (authority.username || authority.password || authority.pathname !== '/' || authority.search || authority.hash) return null;
    return authority;
  } catch { return null; }
}

function isSameRequestAuthority(value, host) {
  try {
    const origin = new URL(value);
    // TLS can terminate at a proxy; use the browser scheme to normalize default ports.
    return ['http:', 'https:'].includes(origin.protocol)
      && origin.origin === value
      && origin.host === new URL(`${origin.protocol}//${host}`).host;
  } catch { return false; }
}

export async function createDashboardServer({ production = false, port = 5173 } = {}) {
  const host = process.env.HOST?.trim() || '127.0.0.1';
  const configuration = {
    baseUrl: process.env.CPA_MANAGER_BASE_URL?.trim() || '',
    key: process.env.CPA_MANAGER_ADMIN_KEY?.trim() || '',
  };
  const missingConfiguration = [
    !configuration.baseUrl && 'CPA_MANAGER_BASE_URL',
    !configuration.key && 'CPA_MANAGER_ADMIN_KEY',
  ].filter(Boolean);
  const vite = production ? null : await (await import('vite')).createServer({
    root, configFile: resolve(root, 'vite.config.ts'),
    server: { middlewareMode: true }, appType: 'spa',
  });
  if (production) await readFile(resolve(root, 'dist/index.html'));
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const authority = parseAuthority(req.headers.host);
    if (!authority) return json(res, 400, { error: 'Host 请求头无效。' });
    if (req.headers.origin && !isSameRequestAuthority(req.headers.origin, req.headers.host)) {
      return json(res, 403, { error: '不允许跨站请求。' });
    }
    const pathname = new URL(req.url, authority.origin).pathname;
    if (pathname === '/api/health') return json(res, 200, { service: 'cpa-insight', readOnly: true });
    if (pathname === '/api/snapshot') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return json(res, 405, { error: '仅支持 GET，请在服务端通过环境变量配置数据源。' });
      }
      if (missingConfiguration.length > 0) {
        return json(res, 503, {
          error: `服务端尚未配置 ${missingConfiguration.join('、')}。请设置环境变量或项目根目录 .env 文件后重启服务。`,
        });
      }
      try {
        const snapshot = await fetchSnapshot(configuration);
        return json(res, 200, toDashboardSnapshot(snapshot));
      } catch (error) {
        return json(res, 502, { error: toPublicFailureMessage(error) });
      }
    }
    if (pathname.startsWith('/api/')) return json(res, 404, { error: '接口不存在。' });
    if (vite) {
      vite.middlewares(req, res, () => { if (!res.writableEnded) json(res, 404, { error: '页面不存在。' }); });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '仅支持 GET。' });
    try {
      const dist = resolve(root, 'dist');
      let path = resolve(dist, `.${decodeURIComponent(pathname)}`);
      if (path !== dist && !path.startsWith(dist + sep)) return json(res, 403, { error: '路径无效。' });
      let info;
      try { info = await stat(path); } catch { /* SPA routes resolve to index, missing assets do not. */ }
      if (!info?.isFile()) {
        if (extname(pathname)) return json(res, 404, { error: '资源不存在。' });
        path = resolve(dist, 'index.html');
      }
      res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
      res.setHeader('Cache-Control', extname(path) === '.html' ? 'no-cache' : 'public, max-age=3600');
      if (req.method === 'HEAD') return res.end();
      await pipeline(createReadStream(path), res);
    } catch {
      if (!res.headersSent) json(res, 500, { error: '页面读取失败，请先执行 npm run build。' });
      else res.destroy();
    }
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(port, host, accept);
  });
  const urlHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '[::1]' : host.includes(':') ? `[${host}]` : host;
  return {
    server,
    url: `http://${urlHost}:${server.address().port}`,
    close: async () => {
      await vite?.close();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    loadEnvFile(resolve(root, '.env'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const port = Number(process.env.PORT || 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的整数。');
  const app = await createDashboardServer({ production: process.argv.includes('--production'), port });
  console.log(`CPA Insight ready: ${app.url}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
