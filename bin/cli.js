#!/usr/bin/env node

import os from 'os';
import http from 'http';
import httpProxy from 'http-proxy';
import qrcode from 'qrcode-terminal';
import pc from 'picocolors';
import { program } from 'commander';

// Define CLI options
program
  .name('lanview')
  .description('Instantly preview full-stack web applications on mobile devices using your local network (LAN)')
  .version('1.0.0')
  .option('-f, --frontend <port>', 'Port of the frontend server', '3000')
  .option('-b, --backend <port>', 'Port of the backend server', '5000')
  .option('-g, --gateway <port>', 'Port of the proxy gateway', '8080')
  .option('-p, --api-prefix <path>', 'URL prefix to forward to the backend (use "none" to disable)', '/api')
  .option('-h, --host <ip>', 'Manually specify your host IP instead of auto-discovery')
  .parse(process.argv);

const options = program.opts();

// Parse and validate ports
const frontendPort = parseInt(options.frontend, 10);
const backendPort = parseInt(options.backend, 10);
const gatewayPort = parseInt(options.gateway, 10);
const apiPrefix = options.apiPrefix;
const hasBackend = apiPrefix && apiPrefix.toLowerCase() !== 'none';

function validatePort(port, name) {
  if (isNaN(port) || port <= 0 || port > 65535) {
    console.error(pc.red(`Error: Invalid ${name} port "${port}". Port must be a number between 1 and 65535.`));
    process.exit(1);
  }
}

validatePort(frontendPort, 'frontend');
if (hasBackend) {
  validatePort(backendPort, 'backend');
}
validatePort(gatewayPort, 'gateway');

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

// Create HTTP proxy instance
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

// Main Gateway HTTP server
const server = http.createServer((req, res) => {
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
  console.log(`${pc.bold('Frontend:')}      ${pc.dim(`http://localhost:${frontendPort}`)}`);
  if (hasBackend) {
    console.log(`${pc.bold('Backend:')}       ${pc.dim(`http://localhost:${backendPort}`)}`);
    console.log(`${pc.bold('API Prefix:')}    ${pc.dim(apiPrefix)}`);
  }
  console.log();
  console.log(pc.yellow('Press Ctrl+C to terminate proxy gateway.'));
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
