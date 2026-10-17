# Architecture

## Vue d'ensemble

Trois processus/acteurs :

1. **ffmpeg** — lit la caméra, encode en H.264, écrit du **H.264 brut « Annex B »**
   sur sa sortie standard.
2. **Serveur Node** — lit la sortie de ffmpeg, redécoupe le flux en **images**,
   puis diffuse chaque image à tous les clients WebSocket.
3. **Navigateur (PC ou casque)** — reçoit l'image, la décode avec **WebCodecs** et
   l'affiche (canvas 2D, ou texture WebGL dans une **session WebXR**).

```
ffmpeg ──stdout(H.264 Annex B)──> capture.js ──AU──> hub.js ──WS──> player.js ──> WebCodecs ──> WebGL/WebXR
```

## Le format « Annex B » et les *access units*

ffmpeg produit un **flux d'octets continu**. Un décodeur, lui, veut des **images**
une par une. Entre les deux, deux notions H.264 :

- **NAL** (Network Abstraction Layer) : une « brique » de données, préfixée par un
  *start code* (`00 00 01` ou `00 00 00 01`). Types utiles :
  - `7` SPS, `8` PPS — paramètres du flux (profil, dimensions…) ;
  - `9` AUD — délimiteur d'image (`aud=1` dans la config ffmpeg) ;
  - `5` IDR — tranche d'une **image clé** (décodable sans aucune autre) ;
  - `1` — tranche « différentielle » (dépend des images précédentes).
- **Access unit (AU)** : l'ensemble des NAL qui composent **une image**.

`server/annexb.js` fait cette transformation :

1. Il accumule les octets et repère les start codes (`findStartCodes`).
2. Un NAL n'est émis que lorsqu'on a trouvé le start code **suivant** — donc le
   dernier NAL du buffer est toujours conservé : il est peut-être incomplet.
3. À chaque `AUD` (ou, en secours, à chaque nouvelle tranche `first_mb_in_slice == 0`),
   les NAL accumulés forment une AU et sont envoyés.

C'est ce découpage qui permet d'envoyer **une image = un message WebSocket**, sans
aucun décodeur de conteneur (MP4) côté serveur.

## Le protocole WebSocket

Deux types de trames circulent.

**Texte (JSON) — contrôle :**

```jsonc
// serveur -> client, à la connexion et à chaque changement
{ "type": "hello", "codec": "avc1.4d4028", "width": 2560, "height": 960,
  "fps": 30, "stereo": "sbs", "headerBytes": 16 }

// synchronisation d'horloges (type NTP), initiée par le client
{ "type": "sync", "t0": 1712345678901 }                       // client -> serveur
{ "type": "sync", "t0": ..., "t1": ..., "t2": ... }            // serveur -> client

// le client réclame une image clé (reprise après gel)
{ "type": "resync" }
```

**Binaire — les images.** Chaque message = un en-tête de **16 octets** suivi de
l'AU en Annex B :

| Offset | Taille | Champ |
|---|---|---|
| 0 | 4 | numéro de séquence (uint32, big-endian) |
| 4 | 1 | `1` si image clé, sinon `0` |
| 5 | 3 | réservé (alignement) |
| 8 | 8 | horodatage d'envoi serveur (float64, ms epoch) |
| 16 | … | l'image H.264 (Annex B) |

L'horodatage + la synchronisation d'horloges permettent au navigateur d'afficher la
**latence réelle** (et non une estimation).

## La chaîne de décodage côté navigateur

`public/player.js` :

```js
const decoder = new VideoDecoder({
  output: (frame) => { /* VideoFrame prêt */ },
  error: (e) => this.requestKeyframe(),
});
decoder.configure({
  codec: "avc1.4d4028",
  hardwareAcceleration: "prefer-hardware",
  optimizeForLatency: true,
  avc: { format: "annexb" },   // pas besoin de `description` avcC : SPS/PPS sont dans le flux
});
```

`avc.format = "annexb"` est la clé : le flux arrivant est déjà au format Annex B
avec ses SPS/PPS répétés (`repeat-headers=1`), donc **aucun muxage supplémentaire**.
On alimente le décodeur avec un `EncodedVideoChunk` par image.

Le même `VideoFrame` est ensuite :
- soit dessiné dans un `<canvas 2D>` (vue diagnostic) ;
- soit envoyé dans une **texture WebGL** (`texImage2D(..., frame)`) pour le rendu VR.

## Rendu stéréo (le « 3D »)

`public/vr-renderer.js` dessine **une seule fois la texture**, mais avec une fenêtre
d'échantillonnage différente par œil :

```glsl
vec2 uv = uWindow.xy + vUv * uWindow.zw;
// œil gauche : uWindow = (0.0, 0, 0.5, 1)
// œil droit  : uWindow = (0.5, 0, 0.5, 1)
```

Deux géométries :

- **`screen`** : un quad placé `distance` mètres devant vous, dont la taille est
  calculée pour couvrir `vfovDeg` verticalement.
- **`vr180`** : un dôme de 180° × 90° avec une projection **équirectangulaire**
  (l'UV est assimilé longitudes/latitudes). On peut tourner la tête librement.

Dans une session `immersive-vr`, la boucle WebXR fournit la **matrice de vue** de
chaque œil (`view.transform.matrix`) et sa **matrice de projection** : le rendu
suivent donc exactement les mouvements de tête, image par image.

### Améliorer le rendu 3D

Le rendu actuel prend l'image brute. Pour un vrai VR180 :

1. **Calibration** : estimer les paramètres intrinsèques (focale, distorsion
   radiale) et extrinsèques (rotation, translation) de chaque objectif — OpenCV
   `stereoCalibrate`. Corriger les distorsions avec une **carte de remap** dans le
   shader.
2. **Rectification** : aligner les deux images pour que les lignes horizontales
   correspondent — indispensable pour un relief confortable.
3. **Projection** : si les objectifs sont des **fisheye**, convertir
   fisheye → équirectangulaire (l'usage « VR180 » standard).

C'est un travail à part entière ; l'étape actuelle donne déjà un relief net pour
des objets à distance moyenne.

## Anti-congestion

`server/hub.js` surveille `ws.bufferedAmount` (octets pas encore partis sur le
réseau). Au-delà de `MAX_BUFFERED`, il :

- **cesse** d'envoyer les images différentielles ;
- **attend** la prochaine image clé pour repartir (le client est marqué
  `_waitingKey`).

Pour que cette reprise soit rapide, on garde un `GOP` court (30 images = 1 s).
Sans cela, un client lent accumulerait du retard à l'infini : c'est le
*bufferbloat*.

Côté client, `player.js` fait de même sur la file du décodeur
(`decoder.decodeQueueSize`) : au-delà de 3 images en attente, on saute les
différentielles.
