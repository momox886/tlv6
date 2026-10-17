// Test de l'extraction des dimensions réelles depuis le SPS.
//
// Pourquoi ce test : le serveur annonçait au navigateur la taille demandée dans
// `.env`, sans jamais vérifier celle que la caméra délivre réellement. Quand les
// deux diffèrent, la chaîne de codec devient incohérente (niveau H.264 trop bas
// pour la taille annoncée) et WebCodecs répond « Codec non supporté ».
//
// On génère de vrais flux H.264 à des tailles connues et on vérifie que
// `parseSps` retrouve exactement ces tailles — y compris le cas 1920x1080, où
// l'image fait 1088 lignes de macroblocs et n'est ramenée à 1080 que par le
// recadrage (frame_cropping). Sans ce recadrage, on annoncerait 1088.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findStartCodes, parseSps, scanAccessUnit } from '../server/annexb.js';

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

// Dimensions attendues. 1920x1080 est le cas piège : hauteur non multiple de 16.
const CASES = [
  { width: 320, height: 240 },
  { width: 1280, height: 720 },
  { width: 2560, height: 720 }, // une seule image côte à côte (SBS)
  { width: 1920, height: 1080 }, // recadrage obligatoire
];

const dir = mkdtempSync(join(tmpdir(), 'sps-'));

/** Encode `w`x`h` et renvoie le premier SPS rencontré. */
function encodeAndFindSps({ width, height }) {
  const file = join(dir, `t-${width}x${height}.h264`);
  const res = spawnSync(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=30`,
      '-frames:v', '5',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p', '-g', '5',
      '-x264-params', 'aud=1:repeat-headers=1:bframes=0',
      '-f', 'h264', file,
    ],
    { encoding: 'utf8' },
  );
  if (res.error?.code === 'ENOENT') {
    console.error(`ffmpeg introuvable (« ${FFMPEG} »). Installez-le ou définissez FFMPEG=/chemin/vers/ffmpeg`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`ffmpeg a échoué pour ${width}x${height} :\n` + res.stderr);
    process.exit(1);
  }

  const data = readFileSync(file);
  for (const { start, codeLen } of findStartCodes(data)) {
    if ((data[start + codeLen] & 0x1f) === 7) {
      // On rend le NAL seul, octet d'en-tête en tête, start code retiré.
      const payload = data.subarray(start + codeLen);
      const next = findStartCodes(payload);
      const end = next.length ? next[0].start : payload.length;
      return payload.subarray(0, end);
    }
  }
  return null;
}

let ok = true;
const rows = [];

for (const c of CASES) {
  const nal = encodeAndFindSps(c);
  if (!nal) {
    console.log(`  ❌ ${c.width}x${c.height} : aucun SPS trouvé dans le flux`);
    ok = false;
    continue;
  }

  const sps = parseSps(nal);
  const au = Buffer.concat([Buffer.from([0, 0, 0, 1]), nal, Buffer.from([0, 0, 1, 0x65])]);
  const scan = scanAccessUnit(au);

  const dimsOk = sps?.width === c.width && sps?.height === c.height;
  const scanOk = scan.width === c.width && scan.height === c.height && /^avc1\.[0-9a-f]{6}$/.test(scan.codec ?? '');
  const keyOk = scan.isKey === true;
  if (!dimsOk || !scanOk || !keyOk) ok = false;

  rows.push({
    attendu: `${c.width}x${c.height}`,
    sps: sps ? `${sps.width}x${sps.height}` : 'échec',
    'profil/niveau': sps ? `${sps.profile}/L${sps.level}` : '—',
    codec: scan.codec ?? '—',
    'scanAccessUnit': dimsOk && scanOk && keyOk ? 'OK' : 'ÉCHEC',
  });
}

console.log('');
for (const r of rows) console.log('  ' + JSON.stringify(r));
console.log('');
console.log(ok ? '✅ DIMENSIONS SPS OK' : '❌ ÉCHEC');
process.exit(ok ? 0 : 1);
