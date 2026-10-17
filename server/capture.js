// Lance ffmpeg, lit son stdout et en extrait les access units (images) H.264.
// Redémarre automatiquement ffmpeg s'il s'arrête (caméra débranchée, erreur…).

import { spawn } from 'node:child_process';
import { buildFfmpegArgs } from './ffmpeg.js';
import { AnnexBSplitter, scanAccessUnit } from './annexb.js';

export function startCapture(cfg, { onAccessUnit, onCodec, onGeometry, log = console } = {}) {
  let proc = null;
  let stopped = false;
  let restartDelay = 500;
  let permissionHinted = false;

  const splitter = new AnnexBSplitter((au) => {
    const { isKey, codec, width, height } = scanAccessUnit(au);
    if (codec) onCodec(codec);
    if (width && height) onGeometry?.(width, height);
    onAccessUnit(au, isKey);
  });

  function launch() {
    if (stopped) return;
    const args = buildFfmpegArgs(cfg);
    log.info('[capture] ffmpeg ' + args.join(' '));
    proc = spawn(cfg.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', (data) => {
      // ffmpeg produit des données : la capture fonctionne, on remet le délai
      // de redémarrage à sa valeur minimale (sinon un incident passager
      // laisserait un backoff de 10 s pour toutes les erreurs suivantes).
      restartDelay = 500;
      try {
        splitter.push(data);
      } catch (err) {
        log.error('[capture] erreur de découpage : ' + err.message);
      }
    });

    proc.stderr.on('data', (data) => {
      const text = data.toString().trim();
      if (!text) return;
      log.warn('[ffmpeg] ' + text);

      // Erreur très fréquente au premier lancement : le périphérique vidéo
      // appartient à root:video et l'utilisateur n'est pas dans le groupe.
      if (!permissionHinted && /permission denied/i.test(text)) {
        permissionHinted = true;
        log.error('');
        log.error('[capture] Accès refusé à la caméra.');
        log.error('[capture] Ajoutez votre utilisateur au groupe « video » :');
        log.error('[capture]   sudo usermod -aG video $USER');
        log.error('[capture] puis reconnectez-vous (ou lancez « newgrp video ») et relancez npm start.');
        log.error('');
      }
    });

    proc.on('error', (err) => {
      log.error(`[capture] impossible de lancer ffmpeg (${cfg.ffmpegPath}) : ${err.message}`);
    });

    proc.on('exit', (code, signal) => {
      if (stopped) return;
      log.warn(`[capture] ffmpeg s'est arrêté (code=${code} signal=${signal}) — redémarrage dans ${restartDelay} ms`);
      setTimeout(launch, restartDelay);
      restartDelay = Math.min(restartDelay * 2, 10_000);
    });
  }

  launch();

  return {
    stop() {
      stopped = true;
      if (proc && !proc.killed) proc.kill('SIGTERM');
    },
  };
}
