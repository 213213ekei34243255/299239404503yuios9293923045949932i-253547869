// ════════════════════════════════════════════════════════════════
//  vpn.js — US Proxy ONLY for BBC World Service Radio stream
//  Uses session-level PAC + cert bypass for SOCKS5 SSL interception
// ════════════════════════════════════════════════════════════════

const { session, ipcMain, app } = require('electron');
const net = require('net');

// ── STATUS OBJECT ──
const vpnStatus = {
  active:    false,
  proxy:     null,
  country:   'Unknown',
  checkedAt: null,
  error:     null,
};

// ── EXACT STREAM — only this goes through the proxy ──
const STREAM_HOST = 'n20b-e2.revma.ihrhls.com';
const STREAM_URL  = 'https://n20b-e2.revma.ihrhls.com/zc11554/32_yo98c649dzkw02/playlist.m3u8';

// ── US PROXY LIST ──
const US_PROXIES = [
  { type: 'socks5', host: '72.10.160.90',   port: 29119, label: 'US-SOCKS5-1' },
  { type: 'socks5', host: '72.10.164.178',  port: 46815, label: 'US-SOCKS5-2' },
  { type: 'socks5', host: '72.10.160.171',  port: 13031, label: 'US-SOCKS5-3' },
  { type: 'socks5', host: '198.8.94.170',   port: 4145,  label: 'US-SOCKS5-4' },
  { type: 'socks5', host: '67.201.58.190',  port: 4145,  label: 'US-SOCKS5-5' },
  { type: 'http',   host: '104.207.45.187', port: 8080,  label: 'US-HTTP-1'   },
  { type: 'http',   host: '23.225.72.4',    port: 8080,  label: 'US-HTTP-2'   },
  { type: 'http',   host: '168.138.44.37',  port: 80,    label: 'US-HTTP-3'   },
];

// ── TCP REACHABILITY CHECK ──
function isProxyReachable(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error',   () => finish(false));
    socket.connect(port, host);
  });
}

// ── FIND FIRST WORKING PROXY ──
async function findWorkingProxy() {
  for (const proxy of US_PROXIES) {
    console.log(`[VPN] Testing ${proxy.label} (${proxy.host}:${proxy.port})...`);
    const ok = await isProxyReachable(proxy.host, proxy.port);
    if (ok) { console.log(`[VPN] ✅ ${proxy.label} reachable`); return proxy; }
    console.log(`[VPN] ✗ ${proxy.label} unreachable`);
  }
  return null;
}

// ── BUILD PAC SCRIPT ──
function buildPacScript(proxy) {
  const proxyDirective = proxy.type === 'socks5'
    ? `SOCKS5 ${proxy.host}:${proxy.port}; SOCKS ${proxy.host}:${proxy.port}`
    : `PROXY ${proxy.host}:${proxy.port}`;

  return `function FindProxyForURL(url, host) {
  if (host === "${STREAM_HOST}") {
    return "${proxyDirective}";
  }
  return "DIRECT";
}`;
}

// ── APPLY PROXY VIA PAC SCRIPT ──
async function applyProxy(targetSession, proxy) {
  const pac        = buildPacScript(proxy);
  const pacBase64  = Buffer.from(pac).toString('base64');
  const pacDataUrl = `data:application/x-ns-proxy-autoconfig;base64,${pacBase64}`;

  await targetSession.setProxy({ pacScript: pacDataUrl });

  console.log(`[VPN] ✅ PAC applied`);
  console.log(`[VPN] Stream host "${STREAM_HOST}" → ${proxy.type}://${proxy.host}:${proxy.port}`);
  console.log(`[VPN] Everything else → DIRECT`);
}

// ── CLEAR PROXY ──
async function clearProxy(targetSession) {
  await targetSession.setProxy({ proxyRules: 'direct://' });
  console.log('[VPN] Proxy cleared — all traffic direct');
}

// ── VERIFY PAC IS WORKING ──
async function verifyPac(targetSession) {
  try {
    const resolved = await targetSession.resolveProxy(STREAM_URL);
    console.log(`[VPN] Proxy resolver for stream URL: ${resolved}`);
  } catch (e) {
    console.warn('[VPN] Could not verify PAC:', e.message);
  }
}

// ── INSTALL CERT BYPASS — stream host only ──
// The SOCKS5 proxy does SSL interception and presents its own cert.
// We ignore cert errors ONLY for the stream host — nothing else is affected.
function installCertBypass(targetSession) {
  // Remove any previous handler first to avoid stacking on proxy rotation
  targetSession.setCertificateVerifyProc((request, callback) => {
    if (request.hostname === STREAM_HOST) {
      console.log(`[VPN] 🔓 Cert bypass for ${request.hostname} — proxy SSL interception`);
      callback(0); // 0 = OK, bypass verification
    } else {
      callback(-3); // -3 = use default Chromium verification for everything else
    }
  });
  console.log(`[VPN] Cert bypass installed for "${STREAM_HOST}" only`);
}

// ── REMOVE CERT BYPASS ──
function removeCertBypass(targetSession) {
  // Pass null to restore default cert verification for all hosts
  targetSession.setCertificateVerifyProc(null);
  console.log('[VPN] Cert bypass removed — normal verification restored');
}

// ── MAIN INIT ──
async function init(mainWindow) {
  console.log('[VPN] Initialising — stream-only proxy via PAC...');

  const ses = mainWindow
    ? mainWindow.webContents.session
    : session.defaultSession;

  const proxy = await findWorkingProxy();

  if (!proxy) {
    console.warn('[VPN] ⚠ No working proxy — stream may not play');
    vpnStatus.active    = false;
    vpnStatus.error     = 'No reachable proxy';
    vpnStatus.checkedAt = new Date().toISOString();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vpn-status', vpnStatus);
    }
    return vpnStatus;
  }

  await applyProxy(ses, proxy);
  installCertBypass(ses);          // ← KEY FIX: allow proxy's self-signed cert for stream host

  // Wait 300ms for PAC to settle, then verify
  setTimeout(() => verifyPac(ses), 300);

  vpnStatus.active    = true;
  vpnStatus.proxy     = `${proxy.host}:${proxy.port}`;
  vpnStatus.country   = 'United States 🇺🇸';
  vpnStatus.checkedAt = new Date().toISOString();
  vpnStatus.error     = null;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vpn-status', vpnStatus);
  }

  // ── AUTO-HEAL every 90s ──
  let currentProxy = proxy;
  setInterval(async () => {
    const alive = await isProxyReachable(currentProxy.host, currentProxy.port, 3000);
    if (!alive) {
      console.warn(`[VPN] 🔄 ${currentProxy.label} died — rotating...`);
      const newProxy = await findWorkingProxy();
      if (newProxy) {
        currentProxy = newProxy;
        await applyProxy(ses, newProxy);
        installCertBypass(ses);    // reinstall after proxy rotation
        setTimeout(() => verifyPac(ses), 300);
        vpnStatus.proxy     = `${newProxy.host}:${newProxy.port}`;
        vpnStatus.checkedAt = new Date().toISOString();
        vpnStatus.active    = true;
        vpnStatus.error     = null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('vpn-status', vpnStatus);
        }
        console.log(`[VPN] ✅ Rotated to ${newProxy.label}`);
      } else {
        await clearProxy(ses);
        removeCertBypass(ses);     // restore normal cert checking when no proxy
        vpnStatus.active    = false;
        vpnStatus.error     = 'All proxies dead';
        vpnStatus.checkedAt = new Date().toISOString();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('vpn-status', vpnStatus);
        }
        console.error('[VPN] ❌ All proxies dead — stream will fail');
      }
    }
  }, 90_000);

  return vpnStatus;
}

// ── IPC ──
ipcMain.handle('vpn-get-status', () => vpnStatus);

module.exports = { init, vpnStatus, clearProxy };
