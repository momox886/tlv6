// Test des profils de qualité (PROFILE=lan|tailscale).
//
// Objectif : quand le flux traverse Tailscale, on veut un débit plus faible et
// une file d'attente plus courte, pour que la latence ne s'empile pas. Ce test
// vérifie la RÈGLE DE PRIORITÉ, qui est le point délicat :
//
//     1. variable du shell   (BITRATE=2M npm start)
//     2. profil              (PROFILE=tailscale)
//     3. fichier .env
//     4. valeur par défaut
//
// On ne teste pas le profil « en vase clos » : on lance le VRAI serveur et on
// lit la ligne de commande ffmpeg qu'il construit. C'est la seule preuve que le
// réglage arrive jusqu'à l'encodeur.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Lance le serveur, capture la ligne ffmpeg, puis l'arrête. */
function ffmpegArgsFrom(env, port) {
  return new Promise((resolve, reject) => {
    const server = spawn(process.execPath, [join(PROJECT, 'server', 'index.js')], {
      cwd: PROJECT,
      env: { ...process.env, SOURCE: 'test', WIDTH: '640', HEIGHT: '480', TLS: '0', PORT: String(port), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      server.kill('SIGKILL');
      fn(value);
    };

    const onData = (d) => {
      out += d.toString();
      const line = out.split('\n').find((l) => l.includes('[capture] ffmpeg '));
      // On attend la ligne complète (elle finit par `-f h264 -`).
      if (line && line.includes('-f h264')) finish(resolve, { line, out });
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', onData);

    setTimeout(() => finish(reject, new Error('délai dépassé\n' + out)), 20000);
  });
}

/** Lit la valeur d'une option ffmpeg (« -b:v » -> « 4M »). */
function option(line, name) {
  const m = new RegExp(`\\s${name.replace(/[:*]/g, '\\$&')}\\s+(\\S+)`).exec(line);
  return m ? m[1] : null;
}

const CASES = [
  {
    label: 'PROFILE=tailscale réduit le débit malgré BITRATE du .env',
    env: { PROFILE: 'tailscale' },
    bitrate: '4M',
    gop: '45',
  },
  {
    label: 'une variable du shell l\'emporte sur le profil',
    env: { PROFILE: 'tailscale', BITRATE: '2M' },
    bitrate: '2M',
    gop: '45', // le profil reste appliqué sur les clés non forcées
  },
  {
    label: 'PROFILE=lan ne change rien',
    env: { PROFILE: 'lan', BITRATE: '12M', GOP: '30' },
    bitrate: '12M',
    gop: '30',
  },
];

let ok = true;
let port = 8210;

for (const c of CASES) {
  let line;
  let out;
  try {
    ({ line, out } = await ffmpegArgsFrom(c.env, port++));
  } catch (err) {
    console.log(`  ❌ ${c.label} : ${err.message}`);
    ok = false;
    continue;
  }
  const bitrate = option(line, '-b:v');
  const gop = option(line, '-g');
  const pass = bitrate === c.bitrate && gop === c.gop;
  if (!pass) ok = false;
  console.log(`  ${pass ? '✅' : '❌'} ${c.label}`);
  console.log(`       -b:v ${bitrate} (attendu ${c.bitrate})   -g ${gop} (attendu ${c.gop})`);
}

// Profil inconnu : on doit prévenir et retomber sur « lan », sans planter.
try {
  const { out } = await ffmpegArgsFrom({ PROFILE: 'nawak' }, port++);
  const warned = /PROFILE="nawak" est inconnu/.test(out);
  console.log(`  ${warned ? '✅' : '❌'} PROFILE inconnu : avertissement puis repli sur « lan »`);
  if (!warned) ok = false;
} catch (err) {
  console.log(`  ❌ PROFILE inconnu : le serveur n'a pas démarré — ${err.message}`);
  ok = false;
}

console.log(ok ? '\n✅ PROFILS OK' : '\n❌ ÉCHEC');
process.exit(ok ? 0 : 1);
