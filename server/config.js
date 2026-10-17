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

export const config = {
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
  bitrate: process.env.BITRATE ?? '12M',
  bufsize: process.env.BUFSIZE ?? '1M',
  gop: num(process.env.GOP, 30),
  vaapiDevice: process.env.VAAPI_DEVICE ?? '/dev/dri/renderD128',

  // ---------- Divers ----------
  stereo: (process.env.STEREO ?? 'sbs').toLowerCase(), // sbs | mono
  maxBufferedBytes: num(process.env.MAX_BUFFERED, 2_000_000),
};
