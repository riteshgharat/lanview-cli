#!/usr/bin/env node

import os from 'os';
import fs from 'fs';
import path from 'path';
import http from 'http';
import net from 'net';
import crypto from 'crypto';
import { spawn } from 'child_process';
import httpProxy from 'http-proxy';
import qrcode from 'qrcode-terminal';
import pc from 'picocolors';
import { program } from 'commander';

// Define CLI options
program
  .name('lanview')
  .description('Instantly preview full-stack web applications OR static sites on mobile devices using your local network (LAN)')
  .version('1.0.1')
  .option('-f, --frontend <port>', 'Port of the frontend server (proxy mode)', '3000')
  .option('-b, --backend <port>', 'Port of the backend server (proxy mode)', '5000')
  .option('-g, --gateway <port>', 'Port of the proxy gateway / static server', '8080')
  .option('-p, --api-prefix <path>', 'URL prefix to forward to the backend (use "none" to disable)', '/api')
  .option('-h, --host <ip>', 'Manually specify your host IP instead of auto-discovery')
  .option('-s, --static [dir]', 'Serve static files from directory (Live Server mode). Disables proxy mode')
  .option('--spa', 'SPA fallback: serve index.html for unknown paths (only with --static)')
  .option('--no-reload', 'Disable live reload in static mode (reload is on by default)')
  .option('-o, --open', 'Auto-open the gateway URL in your default browser on start')
  .parse(process.argv);

const options = program.opts();

// Resolve mode
const staticMode = !!options.static;
let rootDir = null;
let rootReal = null;
if (staticMode) {
  const dirArg = options.static === true ? '.' : options.static;
  rootDir = path.resolve(dirArg);
  try {
    if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
      throw new Error('not a directory');
    }
    rootReal = fs.realpathSync(rootDir);
  } catch {
    console.error(pc.red(`Error: Static directory not found: ${rootDir}`));
    process.exit(1);
  }
}

if (options.spa && !staticMode) {
  console.warn(pc.yellow('Warning: --spa only applies in --static mode, ignored.'));
}

// Validate --host is a real IP (prevents cmd-injection via win32 `start` + metachars)
if (options.host && net.isIP(options.host) === 0) {
  console.error(pc.red(`Error: Invalid host IP "${options.host}". Must be a valid IPv4 or IPv6 address.`));
  process.exit(1);
}

// Parse and validate ports
const frontendPort = parseInt(options.frontend, 10);
const backendPort = parseInt(options.backend, 10);
const gatewayPort = parseInt(options.gateway, 10);
const apiPrefix = options.apiPrefix;
const hasBackend = !staticMode && apiPrefix && apiPrefix.toLowerCase() !== 'none';

function validatePort(port, name) {
  if (isNaN(port) || port <= 0 || port > 65535) {
    console.error(pc.red(`Error: Invalid ${name} port "${port}". Port must be a number between 1 and 65535.`));
    process.exit(1);
  }
}

validatePort(gatewayPort, 'gateway');
if (!staticMode) {
  validatePort(frontendPort, 'frontend');
  if (hasBackend) {
    validatePort(backendPort, 'backend');
  }
}

const reloadEnabled = staticMode && options.reload !== false;

// Discover active local IPv4 address
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(interfaces)) {
    const nameLower = name.toLowerCase();

    // Determine interface score
    let score = 1; // Default/unknown type

    if (/wi-fi|wifi|wlan|wireless/i.test(nameLower)) {
      score = 3; // Wireless connections (best for mobile previewing)
    } else if (/ethernet|eth|en/i.test(nameLower)) {
      score = 2; // Physical wired connections
    }

    // Deprioritize known virtual / VPN / loopback adapters
    if (/virtual|box|vmware|docker|vbox|wsl|vpn|adapter/i.test(nameLower)) {
      score = 0;
    }

    for (const netInterface of interfaces[name]) {
      if (netInterface.family === 'IPv4' && !netInterface.internal) {
        candidates.push({
          address: netInterface.address,
          name: name,
          score: score
        });
      }
    }
  }

  // Sort descending by score
  candidates.sort((a, b) => b.score - a.score);

  return candidates.length > 0 ? candidates[0].address : '127.0.0.1';
}

const hostIp = options.host || getLocalIp();
const gatewayUrl = `http://${hostIp}:${gatewayPort}`;

// Open default browser (cross-platform)
function openBrowser(url) {
  let cmd, args;
  switch (process.platform) {
    case 'win32':  cmd = 'cmd';     args = ['/c', 'start', '""', url]; break;
    case 'darwin': cmd = 'open';   args = [url]; break;
    default:       cmd = 'xdg-open'; args = [url]; break;
  }
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {
      console.error(pc.yellow(`[Warning] Could not open browser. Visit ${url} manually.`));
    });
  } catch {
    console.error(pc.yellow(`[Warning] Could not open browser. Visit ${url} manually.`));
  }
}

// --- Static mode helpers --------------------------------------------------

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.map':  'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/plain; charset=utf-8',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.pdf':  'application/pdf',
  '.wasm': 'application/wasm',
};

function mimeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

const RELOAD_SCRIPT = `<script>(()=>{const ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host);ws.onmessage=()=>location.reload();ws.onclose=()=>setTimeout(()=>location.reload(),1000);})();</script>`;

function injectReload(html) {
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, RELOAD_SCRIPT + '</body>');
  }
  return html + RELOAD_SCRIPT;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function dirListing(dir, reqPath) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return '<!DOCTYPE html><html><body>500 Internal Server Error</body></html>';
  }
  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Index of ${escapeHtml(reqPath)}</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem}h1{font-weight:600}a{display:block;padding:.3rem 0;color:#0a7;text-decoration:none}a:hover{text-decoration:underline}</style></head><body><h1>Index of ${escapeHtml(reqPath)}</h1>`;
  if (reqPath !== '/') {
    html += `<a href="../">../</a>`;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const safeName = encodeURIComponent(e.name) + (e.isDirectory() ? '/' : '');
    html += `<a href="${path.posix.join(reqPath, safeName)}">${escapeHtml(e.name)}${e.isDirectory() ? '/' : ''}</a>`;
  }
  html += '</body></html>';
  return reloadEnabled ? injectReload(html) : html;
}

const MAX_INJECT_SIZE = 1024 * 1024; // 1MB cap for reload-script injection (avoid buffering huge files)

function serveFile(req, res, filePath, allowInject) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('500 Internal Server Error');
      return;
    }
    const ct = mimeFor(filePath);
    const wantInject = allowInject && reloadEnabled && ct.startsWith('text/html') && stats.size <= MAX_INJECT_SIZE;

    // Small HTML: buffer + inject reload script
    if (wantInject) {
      fs.readFile(filePath, (e, data) => {
        if (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('500 Internal Server Error');
          return;
        }
        try {
          data = Buffer.from(injectReload(data.toString('utf8')));
        } catch {}
        res.writeHead(200, { 'Content-Type': ct, 'Content-Length': data.length });
        res.end(data);
      });
      return;
    }

    // Stream with HTTP Range support (video seeking, partial downloads)
    const total = stats.size;
    const range = req.headers.range || req.headers.Range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : total - 1;
        if (isNaN(start)) start = 0;
        if (isNaN(end) || end >= total) end = total - 1;
        if (start > end || start >= total) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Content-Type': ct });
          res.end();
          return;
        }
        res.writeHead(206, {
          'Content-Type': ct,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function serveStatic(req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  let urlPath;
  try { urlPath = decodeURIComponent(parsed.pathname); }
  catch { urlPath = parsed.pathname; }

  // C1: reject null bytes / control chars (would crash fs.* synchronously)
  if (urlPath.indexOf('\0') !== -1 || /[\x01-\x1f\x7f]/.test(urlPath)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('400 Bad Request');
    return;
  }

  const resolved = path.resolve(rootDir, '.' + urlPath);

  // Path traversal guard (logical path)
  if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  // H1: resolve symlinks, verify real path stays within root
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (e) {
    if (e.code === 'ENOENT') {
      if (options.spa) {
        const idx = path.join(rootDir, 'index.html');
        try {
          const idxReal = fs.realpathSync(idx);
          if (idxReal === rootReal || idxReal.startsWith(rootReal + path.sep)) {
            return serveFile(req, res, idx, true);
          }
        } catch {}
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('500 Internal Server Error');
    return;
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(real, (err, stats) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('500 Internal Server Error');
      return;
    }
    if (stats.isDirectory()) {
      const idx = path.join(real, 'index.html');
      fs.stat(idx, (e2, st2) => {
        if (!e2 && st2.isFile()) return serveFile(req, res, idx, true);
        try {
          const html = dirListing(real, urlPath);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('500 Internal Server Error');
        }
      });
      return;
    }
    serveFile(req, res, real, true);
  });
}

// --- Native WebSocket reload server (zero-dep) ----------------------------

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const reloadSockets = new Set();

function handleReloadUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n');
  try {
    socket.write(headers);
  } catch {
    socket.destroy();
    return;
  }
  reloadSockets.add(socket);
  socket.on('close', () => reloadSockets.delete(socket));
  socket.on('error', () => reloadSockets.delete(socket));
}

function broadcastReload() {
  if (reloadSockets.size === 0) return;
  const payload = Buffer.from(JSON.stringify({ type: 'reload' }));
  // Server->client text frame, unmasked. Payload < 126 bytes.
  const frame = Buffer.alloc(2 + payload.length);
  frame[0] = 0x81; // FIN + text opcode
  frame[1] = payload.length;
  payload.copy(frame, 2);
  for (const s of reloadSockets) {
    try { s.write(frame); } catch {}
  }
}

// --- File watcher ---------------------------------------------------------

let watcher = null;
let reloadTimer = null;

function shouldIgnoreWatch(filename) {
  if (!filename) return true;
  const segs = filename.split(/[\\/]/);
  return segs.some((p) => p === 'node_modules' || p === '.git' || (p.startsWith('.') && p.length > 1));
}

if (staticMode && reloadEnabled) {
  try {
    watcher = fs.watch(rootDir, { recursive: true }, (eventType, filename) => {
      if (shouldIgnoreWatch(filename)) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(broadcastReload, 100);
    });
    watcher.on('error', () => {
      // Watcher may close on watched dir removal; silently tolerate.
    });
  } catch (e) {
    console.warn(pc.yellow(`[Warning] File watcher failed: ${e.message}. Live reload disabled.`));
  }
}

// --- Create server --------------------------------------------------------

let server;

if (staticMode) {
  server = http.createServer(serveStatic);
  if (reloadEnabled) {
    server.on('upgrade', handleReloadUpgrade);
  }
} else {
  // Proxy mode (unchanged)
  const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    ws: true,
    // Automatically rewrite host headers
    xfwd: true
  });

  // Graceful proxy error handling (e.g. target server is offline)
  proxy.on('error', (err, req, res) => {
    const isApi = hasBackend && req.url.startsWith(apiPrefix);
    const targetPort = isApi ? backendPort : frontendPort;
    const targetName = isApi ? 'Backend' : 'Frontend';

    console.error(pc.yellow(`[Proxy Warning] Error proxying ${req.method} ${req.url} to ${targetName} (port ${targetPort}): ${err.message}`));

    if (res && typeof res.writeHead === 'function') {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Bad Gateway: Lanview proxy failed to reach the ${targetName} server on port ${targetPort}.\n\nIs your ${targetName} server running?`);
    }
  });

  proxy.on('error', (err, req, socket) => {
    // Websocket proxy error handling
    if (socket && typeof socket.destroy === 'function') {
      socket.destroy();
    }
  });

  server = http.createServer((req, res) => {
    // Match path prefix to determine forwarding target
    if (hasBackend && req.url.startsWith(apiPrefix)) {
      proxy.web(req, res, { target: `http://localhost:${backendPort}` });
    } else {
      proxy.web(req, res, { target: `http://localhost:${frontendPort}` });
    }
  });

  // WebSocket upgrading for HMR (Hot Module Replacement)
  server.on('upgrade', (req, socket, head) => {
    if (hasBackend && req.url.startsWith(apiPrefix)) {
      proxy.ws(req, socket, head, { target: `http://localhost:${backendPort}` });
    } else {
      proxy.ws(req, socket, head, { target: `http://localhost:${frontendPort}` });
    }
  });
}

// Start listening and print instructions/QR
server.listen(gatewayPort, '0.0.0.0', () => {
  console.clear();
  console.log(pc.cyan(pc.bold('┌──────────────────────────────────────────────┐')));
  console.log(pc.cyan(pc.bold('│                                              │')));
  console.log(pc.cyan(pc.bold('│   📱 Lanview Active                          │')));
  console.log(pc.cyan(pc.bold('│                                              │')));
  console.log(pc.cyan(pc.bold('└──────────────────────────────────────────────┘')));
  console.log();
  console.log(pc.green(pc.bold('Scan the QR code below on your mobile device:')));
  console.log(pc.dim('(Note: Your mobile device and PC must be on the same Wi-Fi/LAN)'));
  console.log();

  // Render QR Code in terminal
  qrcode.generate(gatewayUrl, { small: true });

  console.log();
  console.log(`${pc.bold('Proxy URL:')}     ${pc.cyan(pc.underline(gatewayUrl))}`);
  if (staticMode) {
    console.log(`${pc.bold('Mode:')}          ${pc.magenta('Static')}`);
    console.log(`${pc.bold('Serving:')}       ${pc.dim(rootDir)}`);
    console.log(`${pc.bold('Live reload:')}   ${reloadEnabled ? pc.green('on') : pc.dim('off')}`);
    if (options.spa) {
      console.log(`${pc.bold('SPA fallback:')}  ${pc.green('on')}`);
    }
  } else {
    console.log(`${pc.bold('Mode:')}          ${pc.magenta('Proxy')}`);
    console.log(`${pc.bold('Frontend:')}      ${pc.dim(`http://localhost:${frontendPort}`)}`);
    if (hasBackend) {
      console.log(`${pc.bold('Backend:')}       ${pc.dim(`http://localhost:${backendPort}`)}`);
      console.log(`${pc.bold('API Prefix:')}    ${pc.dim(apiPrefix)}`);
    }
  }
  console.log();
  console.log(pc.yellow('Press Ctrl+C to terminate.'));

  if (options.open) {
    openBrowser(gatewayUrl);
  }
});

// Handle server startup errors
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(pc.red(`Error: Port ${gatewayPort} is already in use.`));
    console.error(pc.red(`Please choose another gateway port using the -g or --gateway option.`));
    console.error(pc.dim(`Example: lanview -g 9090`));
  } else {
    console.error(pc.red(`Gateway error: ${err.message}`));
  }
  process.exit(1);
});

// Cleanup watcher on exit
function shutdown() {
  if (watcher) {
    try { watcher.close(); } catch {}
  }
  if (reloadTimer) {
    clearTimeout(reloadTimer);
  }
  for (const s of reloadSockets) {
    try { s.destroy(); } catch {}
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
