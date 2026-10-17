# Étape suivante : WebRTC

## Pourquoi changer ?

WebSocket est **excellent sur un LAN propre** : peu de code, facile à déboguer,
latence comparable à WebRTC. Mais WebSocket est **TCP** : sur un réseau qui perd des
paquets (Wi-Fi chargé), un paquet manquant **bloque toute la suite** (head-of-line
blocking). Résultat : l'image se fige, puis rattrape en rafale.

WebRTC règle cela nativement :

| | WebSocket (actuel) | WebRTC |
|---|---|---|
| Transport | TCP | **SRTP/UDP** (lossy-tolerant) |
| Perte de paquets | gèle puis rattrape | l'image suivante arrive, tant pis |
| Jitter | non géré | **jitter buffer** adaptatif |
| Congestion | nous la gérons à la main | **GCC** + **NACK/FEC** + **VP8/H264 simulcast** |
| Écho à l'encodeur | non | **REMB/TWCC** → débit ajusté automatiquement |
| Latence type (LAN) | 40–80 ms | 30–60 ms |
| Latence type (Wi-Fi chargé) | explose | reste stable |

Bref : **on garde WebSocket comme « plomberie » de contrôle** (synchronisation,
commandes, télémétrie) et on ajoute WebRTC pour **la vidéo**.

## Deux façons d'ajouter WebRTC

### A. Le navigateur du Quest « tire » le flux (recommandé, le plus simple)

Aucune bibliothèque native à installer côté serveur : on utilise un **serveur
WebRTC « offrant » (broadcaster)** qui fabrique une offre SDP à partir du flux
ffmpeg. Le casque se connecte comme un simple pair receveur.

Outils prêts à l'emploi :

- **MediaMTX** (`bluenviron/mediamtx`) — un binaire unique : il ingère un flux
  RTSP/SRT et le republie en **WHEP** (WebRTC HTTP Egress Protocol). Le casque fait
  un `POST /stream/whep` et reçoit la piste. Changement minimal dans ce projet :
  ffmpeg pousse en RTSP au lieu de stdout.

  ```bash
  # ffmpeg pousse vers MediaMTX
  ffmpeg ... -f rtsp rtsp://127.0.0.1:8554/stereo
  ```

  ```js
  // dans le navigateur du casque
  const pc = new RTCPeerConnection();
  pc.addTransceiver("video", { direction: "recvonly" });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const answer = await fetch("https://PC:8889/stereo/whep", {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: offer.sdp,
  }).then((r) => r.text());
  await pc.setRemoteDescription({ type: "answer", sdp: answer });
  video.srcObject = new MediaStream([pc.getReceivers()[0].track]);
  ```

- **LiveKit** — plus complet (SFU, gestion des salles, SDK navigateur soigné),
  si vous voulez plusieurs spectateurs.

### B. Un serveur WebRTC « maison »

- **GStreamer** `webrtcbin` : puissant, mais la courbe d'apprentissage est raide.
- **aiortc** (Python) : idéal pour un prototype, encode en logiciel.
- **mediasoup** (Node) : SFU performant, mais il faut lui fournir la piste déjà
  encodée (via `PlainTransport`), ce qui complique le montage.

Pour ce projet, **MediaMTX/WHEP** offre le meilleur rapport effort/résultat.

## Le point crucial : `RTCRtpSender` et le rendu

En WebRTC, la piste vidéo arrive dans un `<video>` **ou** peut être lue image par
image :

```js
const track = pc.getReceivers()[0].track;
const stream = new MediaStream([track]);
const video = document.createElement("video");
video.srcObject = stream;
await video.play();

// Puis, pour la VR, on ne veut pas d'un <video> mais d'une texture :
video.requestVideoFrameCallback((now, meta) => {
  renderer.updateFrame(video);   // texImage2D accepte aussi un <video>
});
```

> ⚠️ Attention à la latence : un `<video>` avec WebRTC peut mettre **1 à 3 images**
> en tampon. Pour descendre au minimum, réglez `video.playsInline`, évitez
> `playbackRate`, et préférez **WebCodecs** via `MediaStreamTrackProcessor` quand il
> est disponible :

```js
const processor = new MediaStreamTrackProcessor({ track });
const reader = processor.readable.getReader();
while (true) {
  const { value: frame, done } = await reader.read();
  if (done) break;
  renderer.updateFrame(frame); // VideoFrame directement !
  frame.close();
}
```

C'est la voie « zéro copie » qui combine le meilleur des deux mondes :
**transport WebRTC + rendu WebCodecs/WebXR**.

## Plan de migration conseillé

1. **Aujourd'hui** : valider la chaîne complète avec ce projet (WebSocket) — la
   latence LAN est déjà bonne, et vous avez une vue de diagnostic précise.
2. **Étape 1** : installer MediaMTX, faire pousser ffmpeg en RTSP, ajouter un
   **bouton « mode WebRTC »** dans `vr.html` qui bascule sur WHEP. Comparer les
   chiffres de latence des deux modes.
3. **Étape 2** : si la latence reste en cause, passer au rendu par
   `MediaStreamTrackProcessor` (WebCodecs) au lieu du `<video>`.
4. **Étape 3** : WebTransport (QUIC) est une alternative intéressante à WebRTC :
   pas de blaze de signalisation, pas de head-of-line blocking. À surveiller.

## Ce qu'il faudra garder du projet actuel

- L'encodage ffmpeg « zerolatency » : **identique** (WebRTC veut du H.264 baseline/
  main sans B-frames, exactement ce qu'on produit).
- L'analyse Annex B : utile pour **attacher des métadonnées** aux images.
- La vue 2D de diagnostic et le calcul de latence : à conserver, c'est la boussole.
