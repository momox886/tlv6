# Budget de latence

« Latence » ici = **de l'instant où la caméra capture une image à l'instant où elle
apparaît dans l'œil de l'utilisateur**. Objectif réaliste sur un même réseau Wi-Fi :
**40 à 80 ms**.

## Où passe le temps

| Étape | Ordre de grandeur | Comment la réduire |
|---|---|---|
| Exposition + transfert capteur→USB | 10–30 ms | descendre la résolution, format MJPEG |
| Capture → encodeur | 0–30 ms | `-fflags nobuffer -flags low_delay` |
| Encodage H.264 | 5–20 ms | `-tune zerolatency`, `-bf 0`, look-ahead 0 |
| Réseau (Wi-Fi local) | 3–15 ms | Wi-Fi 5/6, 5 GHz, PC en Ethernet |
| Décodage (WebCodecs) | 3–10 ms | décodage matériel (`prefer-hardware`) |
| Upload texture + rendu VR | 5–15 ms | baisser l'**échelle de rendu**, reprojection |
| **Total** | **~40–80 ms** | |

## Les réglages qui comptent vraiment

### 1. Pas de mise en tampon côté ffmpeg

```bash
-fflags nobuffer -flags low_delay -avioflags direct
-probesize 32 -analyzeduration 0
```

ffmpeg ne doit **jamais** attendre « d'avoir assez de données » avant d'envoyer.

### 2. Encodeur sans avance

```bash
-tune zerolatency
-x264-params rc-lookahead=0:sync-lookahead=0:bframes=0
-bf 0
```

- `look-ahead` : l'encodeur analyse des images **futures** → des images de retard.
- `bframes` : les images B doivent être **réordonnées** → retard structurel.

### 3. Débit lissé sur une courte fenêtre

```bash
-b:v 12M -maxrate 12M -bufsize 1M
```

Un `bufsize` de 1 M ≈ 0,7 s à 12 Mbit/s. Plus il est petit, plus l'encodeur « colle »
au débit instantané (mais plus la qualité est irrégulière).

### 4. Images clés fréquentes

```bash
-g 30            # une image clé par seconde à 30 fps
```

Compromis : une image clé coûte cher en débit, mais permet de **reprendre
instantanément** après une perte. C'est le prix d'un flux « réparable ».

### 5. Côté navigateur

- **`optimizeForLatency: true`** dans `VideoDecoder.configure` : le décodeur rend
  l'image dès qu'elle est prête.
- **Pas de MSE** : MSE gonfle la latence de plusieurs secondes.
- **Échelle de rendu** (`framebufferScaleFactor`) : `1.0` par défaut ; `0.7–0.8`
  réduit sensiblement le temps GPU sur Quest, au prix de la netteté.

## Mesurer

La vue 2D (`/`) affiche en continu :

- **Aller simple** — temps serveur→client, calculé grâce à la synchronisation
  d'horloges (poignée de main `sync`) ;
- **Aller-retour** — RTT réseau pur ;
- **Décodage + affichage** — réception → image décodée prête ;
- **Images sautées** — signe de congestion.

La somme *(aller simple + décodage + affichage)* est la latence « logicielle ».
Il faut y ajouter l'exposition caméra et le temps de balayage de l'écran du casque
(~10–20 ms), non mesurables par logiciel.

### Vérifier au chronomètre

Pour un ordre de grandeur **sans instrumentation** : filmez l'écran du casque avec
la caméra… ou plus simple, faites un aller-retour caméra→casque→écran avec un
téléphone en mode ralenti (240 fps) : comptez les images entre le geste et son
apparition. 12 images à 240 fps = 50 ms.

## Mesures réelles sur cette machine

Relevées avec la caméra **CAM-W2002011HD** (MJPEG 2560×720 = 2 × 1280×720 par œil,
seul mode 30 fps) et un encodage logiciel `libx264`.

Débit maximal (décodage MJPEG + encodage, sans bridage temps réel) :

| Preset | 3 s de vidéo traitées en | Marge | Latence d'encodage par image |
|---|---|---|---|
| `ultrafast` | 445 ms | **6,7× le temps réel** | ~5 ms |
| `superfast` | 563 ms | 5,3× | ~6 ms |
| `veryfast` | 635 ms | 4,7× | ~7 ms |
| `medium` | 1241 ms | 2,4× | ~14 ms |

Conclusion pratique : **la machine a largement de quoi tenir 30 img/s.** On peut donc
monter en qualité presque gratuitement :

- `ultrafast` (défaut) : latence minimale. **Attention : le déblocage est désactivé**
  dans ce preset, ce qui peut produire des blocs visibles — très perceptibles dans un
  casque, où l'image est sous les yeux en grand.
- `superfast` : déblocage **et** CABAC activés. Coût ≈ **+1 à 2 ms** par image pour
  une image nettement plus propre. Bon compromis si `ultrafast` montre des blocs.
- `veryfast` / `medium` : envisageables, mais la latence d'encodage commence à se
  sentir (+2 à +9 ms).

> Dans un casque, il vaut presque toujours mieux payer 2 ms de latence et supprimer
> les artefacts de blocs.

### Changer de résolution si le Wi-Fi souffre

La caméra propose aussi :

| Mode | Usage |
|---|---|
| `2560×720 @ 30` (MJPEG) | **le bon choix** — deux yeux en 1280×720 |
| `1280×480 @ 20` | secours si le réseau ne suit pas (2 × 640×480) |
| `640×480 @ 30` | test rapide, très peu de bande passante |

⚠️ Les modes **YUYV** de cette caméra plafonnent à 5 fps en 2560×720 : gardez
`INPUT_FORMAT=mjpeg`.

## Quand la latence « gonfle » d'un coup

| Symptôme | Cause probable | Action |
|---|---|---|
| La latence monte puis se stabilise haut | un client lent force le tamponnage | vérifier `MAX_BUFFERED`, le Wi-Fi |
| Images sautées en rafale | débit trop haut pour le réseau | baisser `BITRATE` |
| L'image se fige puis repart | perte d'image clé | `requestKeyframe()` (bouton dans l'UI) |
| Latence stable mais élevée (>150 ms) | encodeur CPU saturé | passer en matériel (`ENCODER=h264_nvenc`…) |
| Décalage audio/vidéo | (pas d'audio dans ce projet) | — |
