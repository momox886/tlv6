// Récepteur basse latence : WebSocket binaire -> WebCodecs VideoDecoder.
//
// Pourquoi WebCodecs et pas MSE (Media Source Extensions) ?
//   MSE est conçu pour la lecture « fluide » : il met en tampon plusieurs secondes
//   pour absorber les à-coups réseau. Ici on veut l'inverse : décoder chaque image
//   dès sa réception et l'afficher immédiatement. WebCodecs expose exactement ce
//   contrôle image par image.

const HEADER_BYTES = 16;

const AVC_RE = /^avc1\.([0-9a-f]{2})[0-9a-f]{2}([0-9a-f]{2})$/i;

/**
 * Chaînes de codec à essayer, de la plus fidèle à la plus permissive.
 *
 * Le niveau (`level_idc`) déclaré dans le SPS est parfois trop BAS pour la
 * résolution réelle du flux (encodeur logiciel, caméra approximative). Le
 * navigateur refuse alors de configurer le décodeur et on lit « Codec non
 * supporté » alors que le H.264 est parfaitement lisible. On réessaie donc en
 * annonçant un niveau plus élevé.
 */
function codecCandidates(codec) {
  const out = [];
  if (codec) out.push(codec);
  const m = codec ? AVC_RE.exec(codec) : null;
  if (m) {
    const profile = m[1];
    for (const level of ['28', '33', '34']) out.push(`avc1.${profile}00${level}`);
    out.push('avc1.4d0028'); // profil Main
    out.push('avc1.640028'); // profil High
  }
  out.push('avc1.42E01E'); // Baseline 3.1 : la combinaison la plus universelle
  return [...new Set(out)];
}

/** Configurations complètes à tester, dans l'ordre de préférence. */
function attemptConfigs(hello) {
  const hasDims = Boolean(hello.width && hello.height);
  const out = [];
  const seen = new Set();
  const push = (cfg) => {
    const key = JSON.stringify(cfg);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(cfg);
    }
  };

  for (const codec of codecCandidates(hello.codec)) {
    const base = { codec, optimizeForLatency: true };
    if (hasDims) {
      push({
        ...base,
        codedWidth: hello.width,
        codedHeight: hello.height,
        avc: { format: 'annexb' },
        hardwareAcceleration: 'prefer-hardware',
      });
      push({ ...base, codedWidth: hello.width, codedHeight: hello.height, avc: { format: 'annexb' } });
    }
    // Sans dimensions : le SPS les porte déjà. C'est le plus tolérant, et cela
    // évite qu'un désaccord sur la taille fasse échouer la configuration.
    push({ ...base, avc: { format: 'annexb' } });
    push({ ...base });
  }
  return out;
}

export class LowLatencyPlayer extends EventTarget {
  constructor(url, options = {}) {
    super();
    this.url = url;
    this.options = options;

    this.info = null;         // métadonnées envoyées par le serveur
    this.decoder = null;
    this._codecString = null; // codec actuellement configuré
    this._dims = null;        // dimensions de la configuration courante

    this.framesDecoded = 0;
    this.framesDropped = 0;
    this.decodeErrors = 0;
    this.fps = 0;

    this.rttMs = 0;           // aller-retour réseau mesuré
    this.clockOffsetMs = 0;   // (heure serveur) - (heure client)
    this.oneWayMs = 0;        // latence serveur -> client de la dernière image
    this.presentMs = 0;       // réception -> image décodée prête à afficher

    this._syncTimer = null;
    this._lastRecvAt = 0;
    this._pendingFrame = null;
    this._fpsCount = 0;
    this._fpsWindowStart = performance.now();

    // Diagnostic de « rien ne s'affiche » : on mémorise depuis quand on est
    // connecté et si une image est déjà arrivée, pour pouvoir expliquer l'écran
    // noir au lieu de le laisser muet.
    this._openedAt = 0;
    this._stallTimer = null;
    this._stallReported = false;
  }

  async connect() {
    if (!('VideoDecoder' in window)) {
      // Le cas n°1, de très loin : la page n'est pas servie en HTTPS et n'est pas
      // sur localhost. WebCodecs est alors totalement absent — inutile de chercher
      // plus loin. On le dit explicitement plutôt que de laisser « erreur ».
      const why = window.isSecureContext
        ? "votre navigateur ne fournit pas WebCodecs (utilisez Chrome ou Edge récent)"
        : `l'origine « ${location.origin} » n'est pas un contexte sécurisé — ` +
          'WebCodecs exige HTTPS, sauf sur http://localhost';
      throw new Error(`WebCodecs (VideoDecoder) indisponible : ${why}.`);
    }

    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this._openedAt = performance.now();
      this.dispatchEvent(new Event('open'));
      this._sync();
      this._syncTimer = setInterval(() => this._sync(), 2000);
      this._stallTimer = setInterval(() => this._checkStall(), 1000);
    };
    this.ws.onmessage = (event) => this._onMessage(event);
    this.ws.onclose = () => {
      clearInterval(this._syncTimer);
      clearInterval(this._stallTimer);
      this.dispatchEvent(new Event('close'));
    };
    this.ws.onerror = () => this.dispatchEvent(new Event('error'));
  }

  close() {
    clearInterval(this._syncTimer);
    clearInterval(this._stallTimer);
    this.ws?.close();
    try {
      this.decoder?.close();
    } catch {
      /* déjà fermé */
    }
    this._pendingFrame?.close();
  }

  requestKeyframe() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'resync' }));
    }
  }

  _sync() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'sync', t0: Date.now() }));
    }
  }

  _onMessage(event) {
    if (typeof event.data === 'string') {
      this._onControl(JSON.parse(event.data));
      return;
    }

    const buffer = event.data;
    const view = new DataView(buffer);
    const seq = view.getUint32(0);
    const isKey = view.getUint8(4) === 1;
    const sendTime = view.getFloat64(8);
    const payload = new Uint8Array(buffer, HEADER_BYTES);

    this._lastRecvAt = performance.now();
    this.oneWayMs = Date.now() + this.clockOffsetMs - sendTime;

    if (!this.decoder || this.decoder.state !== 'configured') return;

    // Anti-embouteillage côté décodeur : si la file est pleine, on préfère sauter
    // une image différentielle (on attendra la prochaine image clé pour repartir).
    if (!isKey && this.decoder.decodeQueueSize > (this.options.maxQueueSize ?? 3)) {
      this.framesDropped++;
      this.dispatchEvent(new CustomEvent('drop'));
      return;
    }

    const frameDurationUs = Math.round(1e6 / (this.info?.fps || 30));
    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
          timestamp: Math.round(seq * frameDurationUs),
          duration: frameDurationUs,
          data: payload,
        }),
      );
    } catch (err) {
      this.decodeErrors++;
      this.dispatchEvent(new CustomEvent('decodeerror', { detail: err }));
    }
  }

  _onControl(msg) {
    if (msg.type === 'hello') {
      this._configure(msg);
    } else if (msg.type === 'sync') {
      const t3 = Date.now();
      this.rttMs = t3 - msg.t0 - (msg.t2 - msg.t1);
      this.clockOffsetMs = (msg.t1 - msg.t0 + (msg.t2 - t3)) / 2;
    }
  }

  async _configure(hello) {
    // Une reconfiguration implique un nouveau flux : on repart sur une image clé.
    this.info = hello;
    if (!hello.codec) return;

    // Les dimensions font partie de l'identité de la configuration : si le
    // serveur a corrigé la taille réelle du flux entre-temps, il faut bel et bien
    // reconfigurer (sinon on garderait un décodeur réglé sur une taille fausse,
    // ce qui coupe l'image en deux de travers).
    const dims = hello.width && hello.height ? `${hello.width}x${hello.height}` : '?';
    if (
      this._codecString === hello.codec &&
      this._dims === dims &&
      this.decoder?.state === 'configured'
    ) {
      this.dispatchEvent(new CustomEvent('configured', { detail: hello }));
      return;
    }

    // On note l'identité AVANT les `await` : si un second « hello » arrive
    // pendant que celui-ci est encore en cours de validation, il repartira
    // aussitôt au lieu de configurer un second décodeur en parallèle.
    this._codecString = hello.codec;
    this._dims = dims;

    try {
      this.decoder?.close();
    } catch {
      /* ignore */
    }

    // On ne mise pas tout sur une seule chaîne de codec : on essaie une série de
    // configurations de la plus fidèle à la plus permissive. C'est ce qui évite
    // le « Codec non supporté » quand le niveau déclaré ne colle pas à la taille.
    let chosen = null;
    const tried = [];
    for (const config of attemptConfigs(hello)) {
      tried.push(config.codec + (config.avc ? ' [annexb]' : ''));
      let supported = false;
      try {
        supported = (await VideoDecoder.isConfigSupported(config)).supported;
      } catch {
        supported = false; // configuration rejetée : on passe à la suivante
      }
      if (supported) {
        chosen = config;
        break;
      }
    }

    if (!chosen) {
      this._codecString = null;
      this._dims = null;
      this.dispatchEvent(new CustomEvent('fatal', { detail: `Codec non supporté : ${hello.codec}` }));
      this.dispatchEvent(new CustomEvent('unsupported', { detail: { codec: hello.codec, tried } }));
      return;
    }

    this.decoder = new VideoDecoder({
      output: (frame) => this._onDecoded(frame),
      error: (err) => {
        this.decodeErrors++;
        this.dispatchEvent(new CustomEvent('decodeerror', { detail: err }));
        this.requestKeyframe();
      },
    });
    this.decoder.configure(chosen);
    this.requestKeyframe();
    this.dispatchEvent(new CustomEvent('configured', { detail: hello }));
  }

  /**
   * Si la connexion est établie mais qu'aucune image n'arrive, on explique
   * POURQUOI au lieu de laisser un écran noir muet. Le diagnostic traverse
   * toute la chaîne : hello -> codec -> décodeur -> image décodée.
   */
  _checkStall() {
    if (!this._openedAt) return;
    if (performance.now() - this._openedAt < 3000) return; // on laisse 3 s au démarrage

    if (this.framesDecoded > 0) {
      this._stallReported = false; // tout va bien, on réarme l'alerte
      return;
    }

    let reason;
    if (!this.info) {
      reason = "le serveur n'a envoyé aucun message « hello »";
    } else if (!this.info.codec) {
      reason =
        "le serveur n'a pas encore identifié le codec H.264 : " +
        'aucune image exploitable ne lui parvient (voir la sortie ffmpeg ci-dessus)';
    } else if (!this.decoder || this.decoder.state !== 'configured') {
      reason = `le décodeur n'a pas pu être configuré pour ${this.info.codec}`;
    } else if (this.decodeErrors > 0) {
      reason = `${this.decodeErrors} erreur(s) de décodage sur ${this.info.codec}`;
    } else {
      reason = "le décodeur est configuré mais aucune image n'a été décodée";
    }

    if (!this._stallReported) {
      this._stallReported = true;
      this.dispatchEvent(new CustomEvent('stalled', { detail: reason }));
    }
  }

  _onDecoded(frame) {
    const now = performance.now();
    this.presentMs = now - this._lastRecvAt;
    this.framesDecoded++;

    // On ne garde que la dernière image : l'interface consomme immédiatement.
    this._pendingFrame?.close();
    this._pendingFrame = frame;

    this._fpsCount++;
    if (now - this._fpsWindowStart >= 500) {
      this.fps = (this._fpsCount * 1000) / (now - this._fpsWindowStart);
      this._fpsCount = 0;
      this._fpsWindowStart = now;
    }

    // L'image est prêtée au consommateur : il ne doit PAS la fermer lui-même.
    this.options.onFrame?.(frame);
    this.dispatchEvent(new CustomEvent('frame', { detail: frame }));
  }
}
