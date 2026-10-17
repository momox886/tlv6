// Vérifie que le serveur fonctionne réellement en HTTPS + WSS (TLS=1).
//
// C'est le mode indispensable pour WebXR sur le casque : le client charge la page
// en https:// puis ouvre le WebSocket en wss://. Le certificat utilisé en
// production est fourni par Tailscale (`bash scripts/tailscale-cert.sh`) ; ici on
// fabrique un certificat jetable dans un dossier temporaire, afin de ne pas
// toucher au dossier `certs/` du projet.
//
// Lancement : `npm test` (ou `node test/tls.test.mjs`).

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_TLS_PORT ?? 8124);
const DURATION = 2000;
const DIR = fs.mkdtempSync(join(os.tmpdir(), 'stereo-tls-'));
const CERT = join(DIR, 'cert.pem');
const KEY = join(DIR, 'key.pem');

// --- 1. Certificat jetable -------------------------------------------------
try {
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', KEY, '-out', CERT,
      '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { stdio: 'ignore' },
  );
} catch (err) {
  console.log('  ⏭  openssl indisponible, test TLS ignoré');
  process.exit(0);
}

// --- 2. Serveur en TLS -----------------------------------------------------
const server = spawn(process.execPath, [join(PROJECT, 'server', 'index.js')], {
  cwd: PROJECT,
  env: {
    ...process.env,
    SOURCE: 'test',
    WIDTH: '640',
    HEIGHT: '480',
    FPS: '30',
    PORT: String(PORT),
    TLS: '1',
    TLS_CERT: CERT,
    TLS_KEY: KEY,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
server.stdout.on('data', (d) => (serverOutput += d.toString()));
server.stderr.on('data', (d) => (serverOutput += d.toString()));

function cleanup(code) {
  server.kill('SIGTERM');
  fs.rmSync(DIR, { recursive: true, force: true });
  setTimeout(() => {
    server.kill('SIGKILL');
    process.exit(code);
  }, 300);
}

// Le certificat est jetable : on ne peut pas le valider, on désactive donc la
// vérification *uniquement pour ce test*. C'est exactement ce que fait le
// navigateur quand l'utilisateur accepte l'avertissement.
function getStats() {
  return new Promise((resolve, reject) => {
    https
      .get({ host: '127.0.0.1', port: PORT, path: '/stats', rejectUnauthorized: false }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await getStats();
      if (res.status === 200) return res;
    } catch {
      /* pas encore prêt */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("le serveur TLS n'a pas démarré.\n" + serverOutput);
}

// --- 3. Client WSS ---------------------------------------------------------
function nalTypes(payload) {
  const types = [];
  for (let i = 0; i + 3 <= payload.length; i++) {
    if (payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 1) { types.push(payload[i + 3] & 0x1f); i += 3; }
    else if (i + 4 <= payload.length && payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 0 && payload[i + 3] === 1) { types.push(payload[i + 4] & 0x1f); i += 4; }
  }
  return types;
}

function runClient(duration) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${PORT}/ws`, { rejectUnauthorized: false });

    const state = {
      hello: null, frames: 0, keyframes: 0, bytes: 0,
      annexbOk: true, firstFrameMs: null, opened: false, start: Date.now(),
    };

    ws.on('open', () => {
      state.opened = true;
      ws.send(JSON.stringify({ type: 'sync', t0: Date.now() }));
    });
    ws.on('error', reject);

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'hello') state.hello = msg;
        return;
      }
      // Selon la version de `ws`, un message binaire arrive en Buffer ou en
      // ArrayBuffer : on normalise pour ne dépendre ni de l'un ni de l'autre.
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (state.firstFrameMs === null) state.firstFrameMs = Date.now() - state.start;
      state.frames++;
      state.bytes += buf.byteLength;

      const isKey = buf.readUInt8(4) === 1;
      if (isKey) state.keyframes++;
      const types = nalTypes(buf.subarray(16));
      if (types.length === 0 || types[0] !== 9) state.annexbOk = false;
    });

    setTimeout(() => {
      ws.close();
      resolve(state);
    }, duration);
  });
}

// --- 4. Exécution ----------------------------------------------------------
try {
  await waitForServer();
  const s = await runClient(DURATION);
  const fps = s.frames / (DURATION / 1000);

  console.log(`  images reçues (WSS) : ${s.frames} en ${(DURATION / 1000).toFixed(1)} s -> ${fps.toFixed(1)} img/s`);
  console.log(`  débit               : ${((s.bytes * 8) / (DURATION / 1000) / 1e6).toFixed(2)} Mbit/s`);
  console.log(`  1re image après     : ${s.firstFrameMs} ms`);
  console.log('');

  const checks = [
    ['connexion WSS établie', s.opened],
    ['entête `hello` reçue', !!s.hello],
    ['images reçues', s.frames > 20],
    ['au moins une image clé', s.keyframes >= 1],
    ['flux Annex B conforme', s.annexbOk],
    ['cadence ~30 img/s', fps > 20 && fps < 45],
  ];

  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? '✅' : '❌'} ${label}`);
    if (!pass) ok = false;
  }
  console.log(ok ? '\n✅ TLS OK' : '\n❌ ÉCHEC');
  if (!ok) console.log('\n--- sortie serveur ---\n' + serverOutput);
  cleanup(ok ? 0 : 1);
} catch (err) {
  console.error(String(err?.message ?? err));
  cleanup(1);
}
