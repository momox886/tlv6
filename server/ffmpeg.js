// Construction de la ligne de commande ffmpeg.
//
// Objectif : capturer la caméra, l'encoder en H.264 avec le MINIMUM de latence,
// et écrire le flux brut Annex B sur la sortie standard (récupéré par capture.js).
//
// Les réglages « faible latence » qui comptent vraiment :
//   -tune zerolatency / -rc-lookahead 0 / -sync-lookahead 0  -> aucune image
//        d'avance (pas de look-ahead), l'encodeur ne « retient » rien ;
//   -bf 0                        -> pas d'images B (elles imposent de réordonner) ;
//   -bufsize petit (1M)          -> le débit est lissé sur ~une fraction de seconde ;
//   aud=1                        -> un délimiteur par image : découpage immédiat ;
//   repeat-headers=1             -> SPS/PPS répétés à chaque image clé : un nouveau
//                                   client peut démarrer sur n'importe quelle clé ;
//   -fflags nobuffer / -flags low_delay -> on ne laisse pas ffmpeg accumuler.

/** Options de latence appliquées uniquement aux entrées temps réel. */
function lowLatencyInputFlags(source) {
  if (source === 'v4l2') {
    return ['-fflags', 'nobuffer', '-flags', 'low_delay', '-avioflags', 'direct'];
  }
  if (source === 'rtsp') {
    return ['-fflags', 'nobuffer', '-flags', 'low_delay', '-rtsp_transport', 'tcp'];
  }
  return [];
}

function inputArgs(cfg) {
  const { source, width, height, fps } = cfg;
  switch (source) {
    case 'test': {
      // Source synthétique stéréo : moitié gauche = mire animée, moitié droite = barres.
      // Permet de tester toute la chaîne (serveur + navigateur + casque) sans caméra.
      //
      // `-re` est ESSENTIEL : sans lui, lavfi génère les images aussi vite que le CPU
      // le permet (des centaines d'images/s) au lieu de respecter `rate=`.
      const w = Math.round(width / 2);
      return [
        '-re', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${height}:rate=${fps}`,
        '-re', '-f', 'lavfi', '-i', `smptebars=size=${w}x${height}:rate=${fps}`,
      ];
    }
    case 'dshow':
      return [
        '-f', 'dshow',
        '-video_size', `${width}x${height}`,
        '-framerate', String(fps),
        '-i', `video=${cfg.dshowName}`,
      ];
    case 'rtsp':
      return [...lowLatencyInputFlags('rtsp'), '-i', cfg.rtspUrl];
    case 'stdin':
      return ['-f', 'h264', '-i', 'pipe:0'];
    case 'v4l2':
    default: {
      const args = [...lowLatencyInputFlags('v4l2'), '-f', 'v4l2'];
      // MJPEG est le format qui permet les hautes résolutions / fréquences sur USB 2.0.
      if (cfg.inputFormat) args.push('-input_format', cfg.inputFormat);
      args.push('-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', cfg.device);
      return args;
    }
  }
}

// Encodeurs réellement gérés par encoderArgs() ci-dessous.
//
// Tout autre nom retombe sur le `default` (arguments libx264) : le flux
// fonctionne, mais en LOGICIEL. C'est le piège classique quand on choisit un
// encodeur « au hasard » (ex. h264_v4l2m2m sur un Raspberry Pi) : on croit
// utiliser le matériel et on ne le sait jamais. On prévient donc explicitement.
const SUPPORTED_ENCODERS = new Set([
  'libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi',
]);

let warnedUnknownEncoder = false;

function encoderArgs(cfg) {
  const { encoder, bitrate, bufsize, gop } = cfg;
  switch (encoder) {
    case 'h264_nvenc':
      // `-tune ll` (low latency) est la façon documentée de désactiver l'attente
      // d'images futures côté NVENC.
      return [
        '-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-rc', 'cbr',
        '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bufsize,
        '-g', String(gop), '-bf', '0', '-profile:v', 'main', '-forced-idr', '1',
      ];
    case 'h264_qsv':
      return [
        '-c:v', 'h264_qsv', '-preset', 'veryfast', '-low_power', '1',
        '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bufsize,
        '-g', String(gop), '-bf', '0', '-profile:v', 'main', '-look_ahead', '0',
      ];
    case 'h264_amf':
      return [
        '-c:v', 'h264_amf', '-usage', 'lowlatency', '-quality', 'speed', '-rc', 'cbr',
        '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bufsize,
        '-g', String(gop), '-bf', '0', '-profile:v', 'main',
      ];
    case 'h264_vaapi':
      return [
        '-c:v', 'h264_vaapi', '-rc_mode', 'CBR',
        '-b:v', bitrate, '-maxrate', bitrate, '-bufsize', bufsize,
        '-g', String(gop), '-bf', '0', '-profile:v', 'main',
      ];
    case 'libx264':
    default:
      // On ne force PAS `-profile:v` : x264 choisit le profil minimal compatible
      // avec les réglages (baseline avec `ultrafast`). Forcer « main » alors que
      // `ultrafast` désactive CABAC déclenche un avertissement et un profil
      // incohérent.
      //
      // Et surtout : on ne met PAS `sliced-threads=0`. `-tune zerolatency` active
      // le « sliced threading » (tous les threads sur la MÊME image). Le
      // désactiver ferait basculer x264 en *frame threading*, qui introduit un
      // retard d'une image ou plus — l'inverse du but recherché.
      return [
        '-c:v', 'libx264',
        '-preset', cfg.preset,
        '-tune', 'zerolatency',
        '-pix_fmt', 'yuv420p',
        '-g', String(gop),
        '-keyint_min', String(gop),
        '-sc_threshold', '0',
        '-b:v', bitrate,
        '-maxrate', bitrate,
        '-bufsize', bufsize,
        '-x264-params',
        'aud=1:repeat-headers=1:rc-lookahead=0:sync-lookahead=0:bframes=0',
      ];
  }
}

/** Construit le tableau d'arguments passé à `spawn(ffmpeg, args)`. */
export function buildFfmpegArgs(cfg) {
  if (!SUPPORTED_ENCODERS.has(cfg.encoder) && !warnedUnknownEncoder) {
    warnedUnknownEncoder = true; // une seule fois, même si ffmpeg redémarre
    console.warn(
      `[ffmpeg] ENCODER="${cfg.encoder}" n'est pas géré par ce projet : repli sur ` +
      `libx264 (encodage LOGICIEL).\n` +
      `         Encodeurs valides : ${[...SUPPORTED_ENCODERS].join(', ')}\n` +
      `         Pour connaître celui adapté à cette machine : npm run doctor`
    );
  }

  const args = ['-hide_banner', '-loglevel', 'warning'];

  // VAAPI doit être déclaré avant les entrées.
  if (cfg.encoder === 'h264_vaapi') args.push('-vaapi_device', cfg.vaapiDevice);

  args.push(...inputArgs(cfg));

  // Chaîne de filtres.
  //  - Source de test : deux entrées à assembler -> il FAUT `-filter_complex`.
  //  - Autres sources : une seule entrée -> `-vf` suffit.
  const tail = cfg.encoder === 'h264_vaapi' ? ['format=nv12', 'hwupload'] : ['format=yuv420p'];
  if (cfg.source === 'test') {
    args.push('-filter_complex', `[0:v][1:v]hstack=inputs=2,${tail.join(',')}[v]`, '-map', '[v]');
  } else {
    args.push('-vf', tail.join(','));
  }
  args.push('-an');

  args.push(...encoderArgs(cfg));

  // Sortie : H.264 brut Annex B sur stdout.
  args.push('-f', 'h264', '-');
  return args;
}
