/**
 * velixir-xray — run xray (VLESS + WebSocket) as a plain Node.js app.
 *
 * How it works:
 *  - On start, download the xray binary (linux-64) if missing, write
 *    config.json, and spawn xray listening on 127.0.0.1:XRAY_PORT.
 *  - The Node HTTP server listens on $PORT (Velixir sets it), serves
 *    /, /health, /sub, /qr, and relays WS upgrades on WS_PATH to xray
 *    as a raw TCP passthrough (xray does the WS handshake itself).
 *  - TLS is terminated at the Velixir edge, so xray uses security none.
 *
 * Env vars (set in the Velixir dashboard; never commit secrets here):
 *  - UUID         VLESS client UUID (random fallback; changes on restart)
 *  - WS_PATH      WebSocket path, e.g. /ws-xxxx (default /vless)
 *  - XRAY_VERSION xray-core release tag (default v26.3.27)
 *  - NODE_NAME    display name for the subscription link
 *  - XRAY_PORT    local xray listen port (default 10000)
 */
'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

let AdmZip, QRCode;
try { AdmZip = require('adm-zip'); } catch (e) { console.error('[boot] adm-zip missing, run npm install'); process.exit(1); }
try { QRCode = require('qrcode'); } catch (e) { console.error('[boot] qrcode missing, run npm install'); process.exit(1); }

const PORT = parseInt(process.env.PORT || '3000', 10);
const XRAY_PORT = parseInt(process.env.XRAY_PORT || '10000', 10);
const XRAY_VERSION = process.env.XRAY_VERSION || 'v26.3.27';
const WS_PATH = (process.env.WS_PATH || '/vless').trim() || '/vless';
const NODE_NAME = process.env.NODE_NAME || 'Velixir-1';
const UUID = process.env.UUID || crypto.randomUUID();

if (!process.env.UUID) {
  console.warn('[boot] WARNING: UUID env var not set, using random UUID ' + UUID +
    ' (it will change on every cold start — set UUID in the dashboard)');
}

const ROOT = __dirname;
const XRAY_DIR = path.join(ROOT, 'xray-core');
const XRAY_BIN = path.join(XRAY_DIR, 'xray');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const ZIP_PATH = path.join(ROOT, 'xray-core.zip');
const XRAY_URL = `https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-64.zip`;

let xrayProc = null;
let xrayReady = false;

function downloadFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'velixir-xray/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, dest, redirects + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`download failed: HTTP ${res.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureXray() {
  if (fs.existsSync(XRAY_BIN)) {
    console.log('[boot] xray binary already present');
    return;
  }
  console.log('[boot] downloading xray ' + XRAY_VERSION + ' ...');
  fs.mkdirSync(XRAY_DIR, { recursive: true });
  await downloadFile(XRAY_URL, ZIP_PATH);
  const zip = new AdmZip(ZIP_PATH);
  zip.extractAllTo(XRAY_DIR, true);
  fs.chmodSync(XRAY_BIN, 0o755);
  fs.unlinkSync(ZIP_PATH);
  console.log('[boot] xray downloaded: ' + XRAY_BIN);
}

function writeConfig() {
  const config = {
    log: { loglevel: 'warning' },
    inbounds: [{
      listen: '127.0.0.1',
      port: XRAY_PORT,
      protocol: 'vless',
      settings: {
        clients: [{ id: UUID }],
        decryption: 'none',
      },
      streamSettings: {
        network: 'ws',
        wsSettings: { path: WS_PATH },
      },
    }],
    outbounds: [{ protocol: 'freedom' }],
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log('[boot] config written (WS path ' + WS_PATH + ')');
}

function startXray() {
  xrayProc = spawn(XRAY_BIN, ['-c', CONFIG_PATH], { stdio: ['ignore', 'pipe', 'pipe'] });
  xrayProc.stdout.on('data', (d) => process.stdout.write('[xray] ' + d));
  xrayProc.stderr.on('data', (d) => process.stderr.write('[xray] ' + d));
  xrayProc.on('exit', (code, signal) => {
    xrayReady = false;
    console.error(`[xray] exited code=${code} signal=${signal}, restarting in 3s`);
    setTimeout(() => { writeConfig(); startXray(); }, 3000);
  });
  // xray binds fast; mark ready after a short delay if still alive
  setTimeout(() => { if (xrayProc && !xrayProc.killed) xrayReady = true; }, 1500);
  console.log('[boot] xray spawned, pid ' + xrayProc.pid);
}

function publicHost(host) {
  // Velixir's edge reaches the app under an internal host like
  // <app>-eu.velixir.run, but that host only serves an edge placeholder
  // page (WS upgrade answers 200, not 101). The real public host is
  // <app>.velixir.run — strip the -<region> infix for generated links.
  return host.replace(/-[a-z]{2}\.velixir\.run$/, '.velixir.run');
}

function vlessLink(host) {
  host = publicHost(host);
  const encPath = encodeURIComponent(WS_PATH);
  return `vless://${UUID}@${host}:443?encryption=none&security=tls&type=ws&host=${host}&path=${encPath}#${encodeURIComponent(NODE_NAME)}`;
}

function statusPage(host) {
  const link = vlessLink(host);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${NODE_NAME}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px">
<h1>${NODE_NAME}</h1>
<p>Status: <b>${xrayReady ? 'xray running' : 'xray starting…'}</b> · VLESS + WS + TLS · path ${WS_PATH}</p>
<p><img src="/qr" alt="subscription QR code" width="240" height="240"></p>
<p>Subscription link (import into Shadowrocket / Loon / V2Ray):</p>
<pre style="word-break:break-all;white-space:pre-wrap;background:#f4f4f4;padding:12px">${link}</pre>
<p><a href="/sub">/sub</a> — base64 subscription endpoint · <a href="/health">/health</a></p>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const host = (req.headers.host || '').split(':')[0] || 'localhost';
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    } else if (url.pathname === '/sub') {
      const b64 = Buffer.from(vlessLink(host) + '\n', 'utf8').toString('base64');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(b64);
    } else if (url.pathname === '/qr') {
      const png = await QRCode.toBuffer(vlessLink(host), { width: 480, margin: 1 });
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(png);
    } else if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(statusPage(host));
    } else if (url.pathname === WS_PATH) {
      // Plain GET on the WS path: 400 means xray is alive behind the relay
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad request');
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  } catch (e) {
    console.error('[http] error', e);
    res.writeHead(500);
    res.end('error');
  }
});

// Raw TCP passthrough for WS upgrades: xray does the WS handshake.
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== WS_PATH) { socket.destroy(); return; }
  const target = net.connect(XRAY_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    target.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) target.write(head);
    socket.pipe(target);
    target.pipe(socket);
  });
  target.on('error', () => { try { socket.destroy(); } catch (e) {} });
  socket.on('error', () => { try { target.destroy(); } catch (e) {} });
});

(async () => {
  try {
    await ensureXray();
    writeConfig();
    startXray();
    server.listen(PORT, () => {
      console.log(`[boot] listening on :${PORT}, WS path ${WS_PATH}, xray on 127.0.0.1:${XRAY_PORT}`);
    });
  } catch (e) {
    console.error('[boot] fatal', e);
    process.exit(1);
  }
})();
