// Le « hub » : gère les clients WebSocket connectés et diffuse les images.
//
// Points clés pour la latence :
//  - Chaque image part dans UN message WebSocket binaire (les frontières de
//    message sont conservées par WebSocket : c'est notre unité de synchronisation).
//  - Chaque message commence par un petit en-tête de 16 octets (voir `header()`)
//    qui transporte le numéro de séquence et l'horodatage serveur : le navigateur
//    peut ainsi afficher la latence réelle.
//  - Anti-« bufferbloat » : si un client traîne (bufferedAmount trop gros), on
//    cesse de lui envoyer les images différentielles et on attend la prochaine
//    image clé. Mieux vaut perdre des images que de prendre du retard.

const HEADER_BYTES = 16;

function header(seq, isKey, sendTimeMs) {
  const h = Buffer.allocUnsafe(HEADER_BYTES);
  h.writeUInt32BE(seq >>> 0, 0);
  h.writeUInt8(isKey ? 1 : 0, 4);
  h.writeUInt8(0, 5);
  h.writeUInt16BE(0, 6);
  h.writeDoubleBE(sendTimeMs, 8);
  return h;
}

export class Hub {
  constructor({ maxBufferedBytes, stereo }) {
    this.clients = new Set();
    this.maxBufferedBytes = maxBufferedBytes;

    this.seq = 0;
    this.codec = null;
    this.fps = 30;
    this.width = 0;
    this.height = 0;
    this.stereo = stereo;

    this.lastKeyframe = null; // { frame, seq, sendTime }
    this.stats = { frames: 0, bytes: 0, dropped: 0, startedAt: Date.now() };
  }

  setGeometry({ width, height, fps }) {
    const nextWidth = width || this.width;
    const nextHeight = height || this.height;
    const nextFps = fps || this.fps;
    // Ne rediffuser que si quelque chose change vraiment : sinon chaque image
    // clé renverrait un « hello » et ferait reconfigurer le décodeur du client.
    if (nextWidth === this.width && nextHeight === this.height && nextFps === this.fps) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.fps = nextFps;
    this.#broadcastControl();
  }

  setCodec(codec) {
    if (this.codec === codec) return;
    this.codec = codec;
    this.#broadcastControl();
  }

  #helloFor() {
    return JSON.stringify({
      type: 'hello',
      codec: this.codec,
      width: this.width,
      height: this.height,
      fps: this.fps,
      stereo: this.stereo,
      headerBytes: HEADER_BYTES,
    });
  }

  #broadcastControl() {
    if (!this.codec) return;
    const payload = this.#helloFor();
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  add(ws) {
    this.clients.add(ws);
    ws._waitingKey = true; // un nouveau client doit démarrer sur une image clé

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'sync') {
        // Poignée de main de type NTP : t0 = départ client, t1/t2 = serveur.
        const t1 = Date.now();
        ws.send(JSON.stringify({ type: 'sync', t0: msg.t0, t1, t2: Date.now() }));
      } else if (msg.type === 'resync') {
        ws._waitingKey = true;
      }
    });

    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));

    // On met tout de suite le client dans l'ambiance : entête puis dernière image clé.
    // L'entête part même si le codec n'est pas encore connu : le client dispose
    // ainsi immédiatement de la géométrie, et recevra un nouvel entête dès que le
    // premier SPS sera analysé.
    //
    // Si on a une image clé en cache, on l'envoie et on lève tout de suite le
    // verrou : sinon le client resterait bloqué jusqu'à la PROCHAINE image clé
    // (jusqu'à une seconde de gel) alors qu'il a déjà de quoi décoder.
    // Nuance : les images qui ont suivi cette clé (encore dans le cache) ne sont
    // pas envoyées ; le décodeur peut donc montrer de brefs artefacts jusqu'à
    // l'image clé suivante. C'est le compromis habituel du « démarrage rapide ».
    ws.send(this.#helloFor());
    if (this.lastKeyframe) {
      ws.send(this.lastKeyframe.frame);
      ws._waitingKey = false;
    }
  }

  broadcast(au, isKey) {
    this.seq = (this.seq + 1) >>> 0;
    const sendTime = Date.now();
    const frame = Buffer.concat([header(this.seq, isKey, sendTime), au]);

    this.stats.frames++;
    this.stats.bytes += frame.length;
    if (isKey) this.lastKeyframe = { frame, seq: this.seq, sendTime };

    for (const ws of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;

      if (ws.bufferedAmount > this.maxBufferedBytes) {
        this.stats.dropped++;
        if (!isKey) {
          ws._waitingKey = true;
          continue;
        }
      }
      if (ws._waitingKey) {
        if (!isKey) continue;
        ws._waitingKey = false;
      }
      ws.send(frame, { binary: true });
    }
  }
}
