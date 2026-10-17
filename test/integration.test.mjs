// Test d'intégration bout en bout, autonome :
//   1. démarre le serveur en mode source synthétique (SOURCE=test) ;
//   2. s'y connecte comme le ferait le navigateur ;
//   3. vérifie le protocole WebSocket (entête, sync, images, Annex B) ;
//   4. arrête le serveur.
//
// Lancement : `npm test` (ou `node test/integration.test.mjs`).

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT ?? 8123);
const DURATION = 2500;

// --- 1. Démarrage du serveur ----------------------------------------------
const server = spawn(process.execPath, [join(PROJECT, 'server', 'index.js')], {
  cwd: PROJECT,
  env: {
    ...process.env,
    SOURCE: 'test',
    WIDTH: '640',
    HEIGHT: '480',
    FPS: '30',
    PORT: String(PORT),
    // Ce test parle HTTP : il doit le dire explicitement. Sans cela, un `.env`
    // local avec TLS=1 ferait démarrer le serveur en HTTPS et le test échouerait
    // — un test ne doit jamais dépendre de la configuration du développeur.
    TLS: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
server.stdout.on('data', (d) => (serverOutput += d.toString()));
server.stderr.on('data', (d) => (serverOutput += d.toString()));

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/stats`);
      if (res.ok) return;
    } catch {
      /* pas encore prêt */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Le serveur n\'a pas démarré.\n' + serverOutput);
}

function finish(code) {
  server.kill('SIGTERM');
  setTimeout(() => {
    server.kill('SIGKILL');
    process.exit(code);
  }, 300);
}

// --- 2. Client WebSocket ---------------------------------------------------
function nalTypes(payload) {
  const types = [];
  for (let i = 0; i + 3 <= payload.length; i++) {
    if (payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 1) { types.push(payload[i + 3] & 0x1f); i += 3; }
    else if (i + 4 <= payload.length && payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 0 && payload[i + 3] === 1) { types.push(payload[i + 4] & 0x1f); i += 4; }
  }
  return types;
}

async function runClient(port, duration) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.binaryType = 'arraybuffer';

  const state = {
    hello: null, syncRtt: null, frames: 0, keyframes: 0, bytes: 0,
    lastSeq: -1, seqMonotonic: true, annexbOk: true, firstFrameMs: null,
    framesEarly: 0, start: Date.now(),
  };

  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'sync', t0: Date.now() })));

  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);
      if (msg.type === 'hello') state.hello = msg;
      if (msg.type === 'sync') {
        const t3 = Date.now();
        state.syncRtt = t3 - msg.t0 - (msg.t2 - msg.t1);
      }
      return;
    }
    const buffer = event.data;
    if (state.firstFrameMs === null) state.firstFrameMs = Date.now() - state.start;
    if (Date.now() - state.start <= 500) state.framesEarly++;
    state.frames++;
    state.bytes += buffer.byteLength;

    const view = new DataView(buffer);
    const seq = view.getUint32(0);
    const isKey = view.getUint8(4) === 1;
    const payload = new Uint8Array(buffer, 16);
    if (isKey) state.keyframes++;
    if (seq < state.lastSeq) state.seqMonotonic = false;
    state.lastSeq = seq;

    const types = nalTypes(payload);
    if (types.length === 0 || types[0] !== 9) state.annexbOk = false;
    if (isKey && !types.includes(5)) state.annexbOk = false;
  });

  await new Promise((resolve) => setTimeout(resolve, duration));
  ws.close();
  state.elapsed = (Date.now() - state.start) / 1000;
  return state;
}

// --- 3. Exécution ----------------------------------------------------------
try {
  await waitForServer();

  // Phase 1 : client « à froid », connecté avant même la première image.
  const s = await runClient(PORT, DURATION);

  // Phase 2 : client « à chaud », connecté alors que le flux tourne depuis un
  // moment. C'est le cas réel quand on recharge la page dans le casque : le
  // serveur a une image clé en cache. On vérifie qu'il reçoit bien un FLUX
  // CONTINU (et pas seulement les images clés, une par seconde).
  const late = await runClient(PORT, DURATION);

  const elapsed = s.elapsed;
  // On exclut la période de démarrage de ffmpeg (avant la première image) pour
  // mesurer une cadence représentative du régime établi.
  const steady = Math.max(0.5, elapsed - (s.firstFrameMs ?? 0) / 1000);
  const fps = s.frames / steady;
  const lateElapsed = late.elapsed;
  const lateFps = late.frames / lateElapsed;

  console.log(`  images reçues   : ${s.frames} en ${elapsed.toFixed(2)} s -> ${fps.toFixed(1)} img/s`);
  console.log(`  images clés     : ${s.keyframes}`);
  console.log(`  débit           : ${((s.bytes * 8) / elapsed / 1e6).toFixed(2)} Mbit/s`);
  console.log(`  codec           : ${s.hello?.codec}  ${s.hello?.width}x${s.hello?.height}`);
  console.log(`  1re image après : ${s.firstFrameMs} ms`);
  console.log(`  RTT             : ${s.syncRtt?.toFixed(1)} ms`);
  console.log('');
  console.log(`  [client tardif] ${late.frames} images en ${lateElapsed.toFixed(2)} s -> ${lateFps.toFixed(1)} img/s`);
  console.log(`  [client tardif] ${late.framesEarly} images dans les 500 premiers ms`);
  console.log('');

  const checks = [
    ['entête `hello` reçue', !!s.hello],
    ['codec annoncé valide', /^avc1\.[0-9a-f]{6}$/.test(s.hello?.codec ?? '')],
    ['géométrie annoncée', s.hello?.width > 0 && s.hello?.height > 0],
    ['stéréo annoncée', s.hello?.stereo === 'sbs'],
    ['entête de 16 octets', s.hello?.headerBytes === 16],
    ['poignée de main de synchronisation', s.syncRtt !== null],
    ['première image < 1 s', s.firstFrameMs !== null && s.firstFrameMs < 1000],
    ['images reçues', s.frames > 20],
    ['cadence ~30 img/s', fps > 20 && fps < 45],
    ['au moins une image clé', s.keyframes >= 1],
    ['numéros de séquence croissants', s.seqMonotonic],
    ['flux Annex B conforme', s.annexbOk],
    ['client tardif : démarrage rapide', late.firstFrameMs !== null && late.firstFrameMs < 300],
    ['client tardif : pas de gel au démarrage', late.framesEarly > 5],
    ['client tardif : flux continu (pas seulement les clés)', late.frames > 20],
    ['client tardif : cadence ~30 img/s', lateFps > 20 && lateFps < 45],
  ];

  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? '✅' : '❌'} ${label}`);
    if (!pass) ok = false;
  }
  console.log(ok ? '\n✅ INTÉGRATION OK' : '\n❌ ÉCHEC');
  if (!ok) console.log('\n--- sortie serveur ---\n' + serverOutput);
  finish(ok ? 0 : 1);
} catch (err) {
  console.error(String(err.message ?? err));
  finish(1);
}
