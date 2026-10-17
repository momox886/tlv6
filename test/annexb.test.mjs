// Test unitaire du découpage H.264 « Annex B ».
//
// Génère un vrai flux avec ffmpeg, le découpe en access units, et vérifie :
//  - le bon nombre d'images ;
//  - la présence d'images clés ;
//  - la détection du codec à partir du SPS ;
//  - la présence de SPS/PPS/IDR dans les images clés.
//
// Le flux est injecté par morceaux de 1500 octets pour simuler des paquets réseau
// qui coupent les start codes en deux.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AnnexBSplitter, scanAccessUnit } from '../server/annexb.js';

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const fps = 30;
const seconds = 2;
const gop = 15;

// --- 1. Génération du flux -------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'annexb-'));
const file = join(dir, 'test.h264');

const args = [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=${fps}`,
  '-frames:v', String(fps * seconds),
  '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
  '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
  '-x264-params', 'aud=1:repeat-headers=1:rc-lookahead=0:sync-lookahead=0:bframes=0',
  '-f', 'h264', file,
];

const res = spawnSync(FFMPEG, args, { encoding: 'utf8' });
if (res.error?.code === 'ENOENT') {
  console.error(`ffmpeg introuvable (« ${FFMPEG} »). Installez-le ou définissez FFMPEG=/chemin/vers/ffmpeg`);
  process.exit(1);
}
if (res.status !== 0) {
  console.error('ffmpeg a échoué :\n' + res.stderr);
  process.exit(1);
}

// --- 2. Découpage ----------------------------------------------------------
const data = readFileSync(file);
const aus = [];
const splitter = new AnnexBSplitter((au) => aus.push(au));
const CHUNK = 1500;
for (let i = 0; i < data.length; i += CHUNK) splitter.push(data.subarray(i, i + CHUNK));
splitter.flush();

let keyframes = 0;
let codec = null;
let totalBytes = 0;
for (const au of aus) {
  const info = scanAccessUnit(au);
  if (info.isKey) keyframes++;
  if (info.codec && !codec) codec = info.codec;
  totalBytes += au.length;
}

// --- 3. Vérifications ------------------------------------------------------
const firstKey = aus.find((au) => scanAccessUnit(au).isKey);
const types = [];
for (let i = 0; i + 3 <= firstKey.length; i++) {
  if (firstKey[i] === 0 && firstKey[i + 1] === 0 && firstKey[i + 2] === 1) { types.push(firstKey[i + 3] & 0x1f); i += 3; }
  else if (i + 4 <= firstKey.length && firstKey[i] === 0 && firstKey[i + 1] === 0 && firstKey[i + 2] === 0 && firstKey[i + 3] === 1) { types.push(firstKey[i + 4] & 0x1f); i += 4; }
}

console.log(`  images attendues : ${fps * seconds}`);
console.log(`  images découpées : ${aus.length}`);
console.log(`  images clés      : ${keyframes}  (GOP=${gop} -> attendu ~4)`);
console.log(`  codec détecté    : ${codec}`);
console.log(`  octets           : ${totalBytes} / fichier ${data.length}`);
console.log(`  NAL 1re image clé: [${types.join(', ')}]  (7=SPS 8=PPS 9=AUD 5=IDR)`);
console.log('');

const checks = [
  ['toutes les images découpées', aus.length === fps * seconds],
  ['images clés détectées', keyframes >= 2],
  ['codec au format avc1.PPCCLL', /^avc1\.[0-9a-f]{6}$/.test(codec ?? '')],
  ['1re image clé = SPS+PPS+IDR', types.includes(7) && types.includes(8) && types.includes(5)],
  ['délimiteur d\'image (AUD) présent', types.includes(9)],
];

let ok = true;
for (const [label, pass] of checks) {
  console.log(`  ${pass ? '✅' : '❌'} ${label}`);
  if (!pass) ok = false;
}
console.log(ok ? '\n✅ ANALYSE ANNEX B OK' : '\n❌ ÉCHEC');
process.exit(ok ? 0 : 1);
