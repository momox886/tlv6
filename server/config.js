// Configuration centralisée.
//
// Les valeurs viennent, par ordre de priorité :
//   1. des variables d'environnement du shell ;
//   2. du fichier `.env` à la racine du projet (s'il existe) ;
//   3. des valeurs par défaut ci-dessous.
// Voir .env.example pour la documentation de chaque champ.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Charge un fichier `.env` (syntaxe `CLE=valeur`, `#` pour les commentaires).
 * Volontairement minimaliste : aucune dépendance externe. Les variables déjà
 * présentes dans l'environnement ne sont JAMAIS écrasées, pour que
 * `SOURCE=test npm start` reste prioritaire sur le fichier.
 */
// Variables présentes dans l'environnement du SHELL, relevées AVANT la lecture de
// `.env`. Elles doivent toujours gagner — y compris sur le profil de qualité
// (voir PROFILES ci-dessous) : un réglage tapé sur la ligne de commande est une
// intention explicite et immédiate.
const SHELL_ENV = new Set(Object.keys(process.env));

function loadDotEnv() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (!fs.existsSync(file)) return;

  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    let value = rawValue.trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // Commentaire en fin de ligne non citée : « valeur # commentaire ».
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    process.env[key] = value;
  }
}

loadDotEnv();

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Profils de qualité
//
// Traverser Tailscale change la nature du lien : quand le trafic est relayé (par
// un DERP) ou passe par un lien faible, 12 Mbit/s ne « passent » pas. Or le
// transport est en TCP : l'excédent ne se perd pas, il s'empile — et la latence
// explose. Réduire le débit est donc LE levier principal, et il améliore à la
// fois la latence et la fluidité (moins d'images jetées).
//
// Priorité des réglages, du plus fort au plus faible :
//   1. variable d'environnement du shell   BITRATE=2M npm start
//   2. profil de qualité                   PROFILE=tailscale
//   3. fichier `.env`
//   4. valeur par défaut du code
//
// Le profil passe donc AVANT `.env` : c'est ce qui lui permet de corriger des
// valeurs déjà écrites dans le fichier. Le shell reste maître pour affiner.
// ---------------------------------------------------------------------------
const PROFILES = {
  lan: {
    description: "réseau local — le débit n'est pas la contrainte",
  },
  tailscale: {
    description: "flux tunnelisé — débit réduit pour éviter la file d'attente",
    // Les clés sont les mêmes que celles de l'environnement : on voit d'un coup
    // d'œil exactement quels réglages le profil remplace.
    //
    // 4 Mbit/s : tient sur un lien relayé, largement assez en connexion directe.
    // Pour affiner : BITRATE=2M PROFILE=tailscale npm start
    BITRATE: '4M',
    // Images clés un peu plus espacées : elles coûtent cher en débit. Sans danger
    // ici, le WebSocket étant en TCP (pas de perte, donc pas d'artefacts).
    GOP: 45,
    // 250 ko ≈ 0,5 s de file à 4 Mbit/s. Le hub préfère JETER une image
    // différentielle que de laisser cette file grandir : la latence prime.
    MAX_BUFFERED: 250_000,
  },
};

const profileName = (process.env.PROFILE ?? 'lan').toLowerCase();
const profile = PROFILES[profileName];

if (!profile) {
  console.warn(
    `[config] PROFILE="${profileName}" est inconnu : profil « lan » appliqué.\n` +
      `         Profils valides : ${Object.keys(PROFILES).join(', ')}`,
  );
}

/** Résout un réglage : shell > profil > .env > défaut du code. */
function pick(key, fallback) {
  if (SHELL_ENV.has(key)) return process.env[key];
  const fromProfile = profile?.[key];
  if (fromProfile !== undefined) return String(fromProfile);
  return process.env[key] ?? fallback;
}

export const config = {
  // ---------- Profil de qualité ----------
  profile: profile ? profileName : 'lan',
  profileDescription: (profile ?? PROFILES.lan).description,

  // ---------- Serveur HTTP/WS ----------
  host: process.env.HOST ?? '0.0.0.0',
  port: num(process.env.PORT, 8080),
  tls: process.env.TLS === '1' || process.env.TLS === 'true',
  tlsCert: process.env.TLS_CERT ?? './certs/cert.pem',
  tlsKey: process.env.TLS_KEY ?? './certs/key.pem',

  // ---------- Source ----------
  source: (process.env.SOURCE ?? 'v4l2').toLowerCase(), // v4l2 | dshow | rtsp | stdin | test
  device: process.env.DEVICE ?? '/dev/video0',
  dshowName: process.env.DSHOW_NAME ?? 'USB Camera',
  rtspUrl: process.env.RTSP_URL ?? '',
  inputFormat: process.env.INPUT_FORMAT ?? 'mjpeg', // '' pour ne pas forcer
  ffmpegPath: process.env.FFMPEG ?? 'ffmpeg',

  // ---------- Géométrie ----------
  // 2560×720 = les deux yeux côte à côte (2 × 1280×720), la seule résolution
  // 30 fps de cette caméra. Ajustez après `npm run probe`.
  width: num(process.env.WIDTH, 2560),
  height: num(process.env.HEIGHT, 720),
  fps: num(process.env.FPS, 30),

  // ---------- Encodage ----------
  encoder: process.env.ENCODER ?? 'libx264',
  // Preset x264 : ultrafast = latence minimale ; superfast/veryfast = meilleure
  // qualité (déblocage + CABAC activés) pour quelques ms de plus.
  preset: process.env.PRESET ?? 'ultrafast',
  bitrate: pick('BITRATE', '12M'),
  bufsize: process.env.BUFSIZE ?? '1M',
  gop: num(pick('GOP'), 30),
  vaapiDevice: process.env.VAAPI_DEVICE ?? '/dev/dri/renderD128',

  // ---------- Divers ----------
  stereo: (process.env.STEREO ?? 'sbs').toLowerCase(), // sbs | mono
  maxBufferedBytes: num(pick('MAX_BUFFERED'), 2_000_000),
};
