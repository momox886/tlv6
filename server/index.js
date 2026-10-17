// Point d'entrée du serveur.
//
//  1. Sert les fichiers statiques de `public/` (l'interface web).
//  2. Écoute les clients WebSocket sur /ws.
//  3. Lance ffmpeg et pousse chaque image encodée vers tous les clients.
//
// Lancement : `npm start` (ou `SOURCE=test npm start` pour tester sans caméra).

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { config } from './config.js';
import { startCapture } from './capture.js';
import { Hub } from './hub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const HEADER_BYTES = 16;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);

  // Petit point d'API : état du serveur (pratique pour diagnostiquer).
  if (urlPath === '/stats') {
    const uptime = (Date.now() - hub.stats.startedAt) / 1000;
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end(
      JSON.stringify(
        {
          uptimeSeconds: Math.round(uptime),
          clients: hub.clients.size,
          codec: hub.codec,
          width: hub.width,
          height: hub.height,
          fps: hub.fps,
          stereo: hub.stereo,
          source: config.source,
          frames: hub.stats.frames,
          dropped: hub.stats.dropped,
          bitrateMbps: +(((hub.stats.bytes * 8) / uptime) / 1e6).toFixed(2),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const relative = path.normalize(urlPath).replace(/^([/\\])+/, '');
  const file = path.join(PUBLIC_DIR, relative);

  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Interdit');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Introuvable');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

function createServer() {
  if (config.tls) {
    try {
      const options = {
        cert: fs.readFileSync(config.tlsCert),
        key: fs.readFileSync(config.tlsKey),
      };
      return https.createServer(options, serveStatic);
    } catch (err) {
      console.error(`[tls] impossible de lire le certificat (${err.message}).`);
      console.error(`[tls] chemins essayés : ${config.tlsCert} et ${config.tlsKey}`);
      console.error('[tls] certificat approuvé par le casque (Tailscale) : bash scripts/tailscale-cert.sh');
      console.error('[tls] certificat auto-signé (avertissement à accepter) : bash scripts/gen-cert.sh');
      console.error('[tls] ou lancez sans TLS (TLS=0).');
      process.exit(1);
    }
  }
  return http.createServer(serveStatic);
}

const hub = new Hub({ maxBufferedBytes: config.maxBufferedBytes, stereo: config.stereo });
hub.setGeometry({ width: config.width, height: config.height, fps: config.fps });

const server = createServer();
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => hub.add(ws));

// Erreur de port déjà pris : cas très courant (un « npm start » précédent encore
// actif). Le message brut de Node est une pile d'appels illisible ; on explique.
function onListenError(err) {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[serveur] le port ${config.port} est déjà utilisé.`);
    console.error('[serveur] Un autre « npm start » tourne probablement déjà (ou une autre application).');
    console.error('[serveur] Arrêtez-le, ou choisissez un autre port :  PORT=8081 npm start');
    process.exit(1);
  }
  throw err;
}
server.on('error', onListenError);
wss.on('error', onListenError);

// Démarrage de la capture vidéo.
//
// On journalise la détection du codec et la toute première image : sans cela, un
// écran noir dans le navigateur ne laisse AUCUNE trace côté serveur, et il devient
// impossible de savoir si le problème vient de ffmpeg ou du navigateur.
let loggedCodec = null;
const capture = startCapture(config, {
  onCodec: (codec) => {
    if (codec !== loggedCodec) {
      loggedCodec = codec;
      console.log(`[flux] codec H.264 détecté : ${codec}`);
    }
    hub.setCodec(codec);
  },
  onAccessUnit: (au, isKey) => {
    if (hub.stats.frames === 0) {
      console.log(`[flux] première image encodée reçue (${au.length} octets) — le flux est vivant.`);
      console.log(`[flux] ouvrez ${config.tls ? 'https' : 'http'}://localhost:${config.port}/ dans un navigateur.`);
    }
    hub.broadcast(au, isKey);
  },
});

// Chaque interface IPv4 utilisable, avec son nom et la longueur de son préfixe.
// On écarte le loopback et les adresses lien-local 169.254.* (auto-configuration
// échouée, inexploitables depuis le réseau).
function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue;
      out.push({ name, address: net.address, prefix: prefixLength(net.netmask) });
    }
  }
  return out;
}

function prefixLength(mask) {
  if (!mask) return 32;
  return mask
    .split('.')
    .reduce((bits, octet) => bits + ((Number(octet) >>> 0).toString(2).match(/1/g)?.length ?? 0), 0);
}

// Sommes-nous dans WSL ? On lit la version du noyau, qui contient toujours
// « microsoft » sous WSL2 (ex. « 6.18.54.1-microsoft-standard-WSL2 »).
// Indispensable pour ne pas confondre un vrai réseau 172.16/12 (fréquent en
// entreprise et chez les fournisseurs) avec le NAT interne de WSL.
function isWsl() {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft|wsl/i.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8'));
  } catch {
    return false;
  }
}

// Le commutateur virtuel de WSL2 en mode NAT utilise toujours un /20 à l'intérieur
// de 172.16.0.0/12 — une adresse qui n'existe que derrière Windows et que le casque
// ne peut donc pas joindre.
//
// On se fie au « /20 » et pas seulement au préfixe 172.16/12 : de vrais réseaux
// locaux utilisent aussi 172.16.0.0/12, et s'y fier produirait une fausse alerte.
function looksLikeWslNat({ address, prefix }) {
  const [a, b] = address.split('.').map(Number);
  return prefix === 20 && a === 172 && b >= 16 && b <= 31;
}

server.listen(config.port, config.host, () => {
  const scheme = config.tls ? 'https' : 'http';
  const addrs = localAddresses();
  // Sur un Linux natif (ou macOS), ce diagnostic n'a aucun sens : le serveur est
  // directement sur le réseau local.
  const onWsl = isWsl();
  const isWslNat = (addr) => onWsl && looksLikeWslNat(addr);

  console.log('');
  console.log('  Flux stéréo faible latence');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  Source    : ${config.source}  ${config.source === 'v4l2' ? config.device : ''}`.trimEnd());
  console.log(`  Encodage  : ${config.encoder}  ${config.width}x${config.height}@${config.fps}  ${config.bitrate}`);
  console.log('');
  console.log(`  Vue 2D    : ${scheme}://localhost:${config.port}/`);
  console.log(`  Vue VR    : ${scheme}://localhost:${config.port}/vr.html`);
  for (const addr of addrs) {
    const note = isWslNat(addr)
      ? '   ← réseau interne WSL2, injoignable depuis le casque'
      : `   (${addr.name})`;
    console.log(`  Casque    : ${scheme}://${addr.address}:${config.port}/vr.html${note}`);
  }
  if (addrs.some(isWslNat)) {
    console.log('');
    console.log('  ⚠  WSL2 est en réseau NAT : aucune adresse du réseau local n\'est');
    console.log('     disponible, le casque ne peut pas joindre le serveur même sur le');
    console.log('     même Wi-Fi.');
    console.log('     → mode réseau « mirrored » (README, « Le casque ne se connecte pas »).');
  }
  if (!config.tls) {
    console.log('');
    console.log('  ℹ  Sans TLS, WebXR/WebCodecs exigent une origine de confiance sur le');
    console.log('     casque (certificat auto-signé avec TLS=1, ou indicateur Chrome).');
  }
  console.log('');
});

function shutdown() {
  console.log('\nArrêt…');
  capture.stop();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
