# 🥽 stereo-vr-stream — flux vidéo stéréo ultra-faible latence

Transmettre l'image d'une **caméra USB stéréo** (double objectif) vers un **casque
Meta Quest**, en **WebSocket**, avec le **minimum de latence**, pour une **immersion
en 3D** dans le navigateur du casque — **sans compiler la moindre application**.

> 🐧 **Windows n'est pas obligatoire.** Le projet tourne aussi sur un hôte **Linux
> natif** — où il est plus simple à installer, plus rapide, et plus faible en
> latence. Voir [docs/LINUX.md](docs/LINUX.md).

```
  ┌─────────────────┐   USB    ┌──────────────────────────┐
  │ Caméra stéréo    │─────────>│ PC (Windows + WSL2)      │
  │ 1 image SBS      │          │                          │
  │ 2560×720         │          │  ffmpeg → H.264          │
  └─────────────────┘          │  (zerolatency, pas d'B)  │
                               └────────────┬─────────────┘
                                            │ WebSocket binaire
                                  Wi-Fi/LAN │ (1 image = 1 message)
                                            ▼
                               ┌──────────────────────────┐
                               │ Meta Quest (navigateur)   │
                               │  WebCodecs → texture GL   │
                               │  WebXR : œil G = moitié G │
                               │          œil D = moitié D │
                               └──────────────────────────┘
```

---

## ⚡ Pourquoi c'est (vraiment) peu latence

Chaque maillon a été choisi pour **ne rien mettre en tampon** :

| Maillon | Choix | Ce qu'on évite |
|---|---|---|
| Encodage | H.264 `-tune zerolatency`, **pas d'images B**, file d'attente nulle | les 2–5 s de retard d'une chaîne HLS classique |
| Transport | **WebSocket binaire**, 1 image = 1 message | le réordonnancement/tampon d'un lecteur vidéo |
| Décodage | **WebCodecs `VideoDecoder`**, image par image | le tampon de plusieurs secondes de *Media Source Extensions* |
| Congestion | si un client traîne, on **saute des images** jusqu'à la prochaine image clé | l'effet « boule de neige » du bufferbloat |
| Rendu | texture WebGL mise à jour à chaque image, **WebXR** | la composition tardive de `<video>` |

Résultat attendu sur le même Wi-Fi : **~40–80 ms** de bout en bout (encodage compris).
Voir [`docs/LATENCY.md`](docs/LATENCY.md) pour le budget détaillé.

---

## 🚀 Démarrage rapide

### 1. Tester **sans caméra** (source synthétique)

```bash
cd stereo-vr-stream
npm install
npm run test-source       # équivalent à : SOURCE=test npm start
```

Ouvrez `http://localhost:8080/` : vous devez voir une mire animée côte à côte.

### 2. Brancher la vraie caméra (Windows → WSL2)

Dans un **PowerShell administrateur** sur Windows :

```powershell
winget install usbipd          # une seule fois
powershell -ExecutionPolicy Bypass -File scripts\attach-camera.ps1
```

Puis dans WSL :

```bash
sudo apt update && sudo apt install -y v4l-utils ffmpeg
bash scripts/probe-camera.sh          # affiche les résolutions/fréquences réelles
```

`probe-camera.sh` vous donne les valeurs exactes à reporter dans `.env`
(`WIDTH`, `HEIGHT`, `FPS`, `INPUT_FORMAT`) :

```bash
cp .env.example .env
# ajustez WIDTH/HEIGHT/FPS selon la sortie de probe-camera.sh
npm start
```

> 💡 Le fichier `.env` est lu **automatiquement** au démarrage. Les variables
> passées dans le shell restent prioritaires (pratique pour tester une variante :
> `FPS=15 npm start`).

> 💡 Si `probe-camera.sh` a dû être lancé avec `sudo`, c'est que votre utilisateur
> n'a pas accès au périphérique. Corrigez une bonne fois :
> `sudo usermod -aG video $USER`, puis **reconnectez-vous** (ou `newgrp video`).
> Sinon ffmpeg aura besoin de `sudo` lui aussi.

> ⚠️ Si WSL ne voit toujours pas `/dev/video*` (noyau sans pilote UVC), utilisez le
> **plan B** : capture côté Windows. Voir [`scripts/dshow-list.ps1`](scripts/dshow-list.ps1).

### 3. Passer sur le casque

WebXR **et** WebCodecs exigent un **contexte sécurisé** (HTTPS). Trois options,
de la meilleure à la plus dégradée :

**Option A — Tailscale : certificat approuvé, aucun avertissement** (recommandé)

Tailscale délivre un vrai certificat Let's Encrypt *et* fait le pont réseau vers
le casque, ce qui règle aussi le problème de NAT. C'est la seule option sans
compromis. Guide complet : **[docs/HTTPS-TAILSCALE.md](docs/HTTPS-TAILSCALE.md)**.

```bash
bash scripts/tailscale-cert.sh        # certificat Tailscale -> certs/
TLS=1 npm start
```

Sur le casque : `https://<nom-machine>.<votre-tailnet>.ts.net/vr.html`

**Option B — certificat auto-signé** (repli, sans Tailscale)

```bash
npm run cert                          # crée certs/cert.pem + certs/key.pem
TLS=1 npm start
```

Le certificat couvre `localhost`, `127.0.0.1`, `::1`, le nom de la machine et
**toutes les adresses IPv4 locales** — vous pouvez donc ouvrir
`https://localhost:8080/` sur le PC *et* `https://<IP-du-PC>:8080/vr.html` sur le
casque.

Sur le casque, **acceptez l'avertissement** de certificat. Cela reste un contexte
sécurisé valide : WebXR fonctionnera, mais l'avertissement reviendra à chaque
visite. `certs/` est ignoré par git : la clé privée n'est jamais publiée.

> ⚠️ Un certificat auto-signé est lié aux adresses qu'il contient. **Si l'adresse
> IP de la machine change** (bail DHCP, autre réseau), il ne couvre plus rien et
> le navigateur *refuse* la connexion au lieu de se contenter d'avertir. Dans ce
> cas : `npm run cert`, puis rechargez. `npm run doctor` détecte ce cas.

**Option C — autoriser l'origine en clair** (dépannage rapide, aucun certificat)

Sur le casque : `chrome://flags/#unsafely-treat-insecure-origin-as-secure` →
ajoutez `http://<IP-du-PC>:8080` → *Enabled* → relancez le navigateur.
Puis ouvrez `http://<IP-du-PC>:8080/vr.html`.

Cliquez sur **« Entrer en VR »**. Vous êtes dans l'image, en relief. 🎉

> ⚠️ **`<IP-du-PC>` n'est presque jamais l'adresse affichée par le serveur.**
> Voir la section suivante — c'est le piège numéro un.

---

## 🐧 Linux natif (recommandé si vous n'êtes pas obligé d'utiliser Windows)

**Aucun code n'est spécifique à Windows.** Le serveur et le client sont du Node.js
et du navigateur ordinaires : ce projet tourne tel quel sur un Linux natif — et
c'est la **meilleure** configuration.

En Linux natif, on **supprime d'un coup** : `usbipd` (et son aller-retour USB/IP),
le NAT de WSL2, le mode `mirrored`, le pare-feu Hyper-V, et les copies de
certificat depuis `/mnt/c`. On **gagne** aussi l'accès aux encodeurs matériels
(VAAPI / NVENC / QSV), inutilisables depuis WSL2 — donc moins de CPU et souvent
moins de latence.

```bash
sudo apt install -y ffmpeg v4l-utils
sudo usermod -aG video $USER          # puis reconnectez-vous
cd stereo-vr-stream && npm install && cp .env.example .env
npm run probe                         # relever les formats réels de la caméra
npm run doctor                        # vérifier que tout est vert
npm start                             # ou : sudo bash scripts/install-service.sh
```

➡️ Guide complet : **[docs/LINUX.md](docs/LINUX.md)** (accès caméra, encodage
matériel, pare-feu, Tailscale natif, service systemd, dépannage).

> Le reste de ce README décrit la configuration **Windows + WSL2**, qui est celle
> pour laquelle le projet a été écrit à l'origine. Si vous êtes sous Linux, les
> sections sur `usbipd`, le NAT et les scripts `*.ps1` **ne vous concernent pas**.

---

## 🚧 Le casque ne se connecte pas (WSL2 en NAT)

Par défaut, WSL2 crée un **réseau privé derrière Windows** : la machine virtuelle
reçoit une adresse du type `172.x.x.x` qui n'existe pas sur votre Wi-Fi. Le serveur
affiche donc une adresse que **le casque ne peut pas atteindre**, même si tout
fonctionne en localhost.

Vous êtes dans ce cas si le serveur affiche `réseau interne WSL2, injoignable`
à côté de l'adresse « Casque », et un avertissement `WSL2 est en réseau NAT`.

### Solution A — mode réseau « mirrored » (recommandé)

WSL partage alors directement les interfaces réseau de Windows : l'adresse affichée
par le serveur devient la **vraie** adresse du PC, et le casque y accède sans
redirection. Nécessite Windows 11 22H2 ou plus récent.

**1. Activer le mode mirrored.** Dans **PowerShell** (pas besoin d'être
administrateur) :

```powershell
notepad $env:USERPROFILE\.wslconfig
```

Contenu du fichier `C:\Users\<vous>\.wslconfig` :

```ini
[wsl2]
networkingMode=mirrored
dnsTunneling=true
autoProxy=true
```

**2. Autoriser le port dans le pare-feu.** Dans un **PowerShell en
administrateur** :

```powershell
powershell -ExecutionPolicy Bypass -File \\wsl.localhost\Debian\home\momo\stereo-vr-stream\scripts\allow-lan.ps1
```

> Le script vit dans WSL, d'où le chemin `\\wsl.localhost\…`. Si vous préférez un
> chemin classique, copiez d'abord le fichier côté Windows :
> `copy \\wsl.localhost\Debian\home\momo\stereo-vr-stream\scripts\allow-lan.ps1 $env:USERPROFILE\`

> ⚠️ Cette étape est **indispensable**, et c'est celle qu'on oublie. En mode
> mirrored, le trafic entrant vers WSL2 n'est plus filtré par le pare-feu Windows
> habituel mais par le **pare-feu Hyper-V**, dont la politique entrante est
> « bloque par défaut ». Sans cette règle, le serveur écoute, `localhost`
> fonctionne, et le casque reste pourtant muet.
>
> Le script ouvre le port TCP 8080 dans **les deux** pare-feux et affiche
> l'adresse exacte à saisir sur le casque.

**3. Redémarrer WSL.** Toujours dans PowerShell :

```powershell
wsl --shutdown
```

Relancez WSL (`wsl`), **rattachez la caméra** (`usbipd attach --wsl --busid …`),
puis `npm start`. L'adresse annoncée est maintenant celle de votre PC sur le
Wi-Fi — utilisez-la sur le casque.

> 💡 Le mode mirrored est **compatible usbipd-win 4.0.0+** (testé ici en 5.3.0).

> 💡 **VPN.** NordVPN (ou tout autre VPN) peut bloquer le trafic du réseau local.
> Si le casque ne voit toujours rien, désactivez temporairement le pare-feu /
> « Threat Protection » du VPN, ou activez son option « autoriser le trafic LAN ».
> Le même symptôme peut venir des adaptateurs VMware : votre PC en a plusieurs,
> le script les écarte volontairement de la liste des adresses à essayer.

### Solution B — redirection de port (Windows 10, ou si mirrored pose problème)

On demande à Windows de relayer le port 8080 vers WSL. Dans **PowerShell en
administrateur** :

```powershell
# 1. Relever l'adresse IP actuelle de WSL (à chaque redémarrage elle peut changer)
wsl hostname -I

# 2. Rediriger le port 8080 de Windows vers WSL (remplacez l'adresse)
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8080 `
  connectaddress=172.18.41.106 connectport=8080

# 3. Autoriser le port dans le pare-feu Windows
netsh advfirewall firewall add rule name="Stereo VR 8080" dir=in action=allow `
  protocol=TCP localport=8080
```

Sur le casque, utilisez cette fois l'adresse **Wi-Fi de votre PC** (visible avec
`ipconfig` sous Windows), pas celle de WSL.

> 🔁 L'adresse de WSL change à chaque redémarrage : si la connexion cesse de
> fonctionner après un reboot, relancez l'étape 2 avec la nouvelle adresse, ou
> supprimez la règle et recréez-la :
> `netsh interface portproxy delete v4tov4 listenport=8080 listenaddress=0.0.0.0`
>
> Le mode **mirrored** (solution A) évite entièrement ce problème.

### Solution C — Tailscale (contourne le problème par construction)

Tailscale fait communiquer le casque et le PC directement, sans se soucier du NAT
de WSL2, **et** fournit au passage un certificat HTTPS approuvé. C'est la solution
retenue si vous voulez du HTTPS sans avertissement :

👉 **[docs/HTTPS-TAILSCALE.md](docs/HTTPS-TAILSCALE.md)**

---

## 🎛️ Réglages utiles

| Variable | Défaut | Rôle |
|---|---|---|
| `SOURCE` | `v4l2` | `v4l2` (WSL/Linux), `dshow` (Windows), `test`, `rtsp`, `stdin` |
| `WIDTH`×`HEIGHT` | `2560×720` | résolution **native** de la caméra (image fusionnée des 2 yeux) |
| `FPS` | `30` | fréquence |
| `INPUT_FORMAT` | `mjpeg` | `mjpeg` permet les hautes résolutions sur USB 2.0 |
| `ENCODER` | `libx264` | `h264_nvenc` (NVIDIA), `h264_qsv` (Intel), `h264_amf` (AMD), `h264_vaapi` (Linux) |
| `PRESET` | `ultrafast` | preset x264 : `ultrafast` = latence mini, `superfast`/`veryfast` = meilleure image |
| `BITRATE` | `12M` | débit cible — le levier principal qualité/latence |
| `GOP` | `30` | intervalle entre images clés ; **plus petit = reprise plus rapide** |
| `TLS` | `0` | passer à `1` pour HTTPS |

Dans l'interface VR : géométrie **écran plan** ou **dôme VR180**, champ de vision,
distance, mode stéréo, et **échelle de rendu** (baisser = moins de GPU = moins de latence).

---

## 🔧 Diagnostic

Un contrôle automatique de l'environnement (Node, ffmpeg, caméra, groupes,
port, réseau, Tailscale) — en lecture seule et **sans `sudo`** :

```bash
npm run doctor
```

Il indique la correction à apporter pour chaque point rouge.

Ensuite, dans le navigateur :

- `http://<PC>:8080/` — vue 2D avec **mesure de latence** (aller simple, aller-retour,
  décodage, images/s, images sautées).
- `http://<PC>:8080/stats` — état JSON du serveur (clients, codec, débit réel).
- Bouton **« Redemander une image clé »** si l'image reste figée.

### Tests

```bash
npm test
```

Cinq vérifications, sans caméra (elles utilisent la source synthétique) :

| Test | Ce qu'il valide |
|---|---|
| `test/annexb.test.mjs` | découpage H.264 → images, détection des images clés et du codec |
| `test/sps.test.mjs` | lecture des dimensions **réelles** dans le SPS (dont le recadrage 1080p) |
| `test/integration.test.mjs` | démarre le serveur, se connecte en WebSocket, valide tout le protocole |
| `test/tls.test.mjs` | HTTPS + WSS de bout en bout (le « contexte sécurisé » exigé par WebXR) |
| `test/math.test.mjs` | matrices de projection (une erreur = image invisible dans le casque) |

À relancer après tout changement de configuration : ils attrapent les régressions
« silencieuses » (cadence, gel au démarrage, flux non conforme).

---

## 📁 Structure

```
stereo-vr-stream/
├── server/
│   ├── index.js        # serveur HTTP/HTTPS + WebSocket
│   ├── config.js       # lecture des variables d'environnement
│   ├── ffmpeg.js       # construction de la ligne de commande ffmpeg
│   ├── capture.js      # lance ffmpeg, découpe le flux en images
│   ├── annexb.js       # analyse du H.264 « Annex B » → access units
│   └── hub.js          # diffusion, horodatage, anti-embouteillage
├── public/
│   ├── index.html      # vue 2D (diagnostic)
│   ├── player.js       # réception : WebSocket → WebCodecs
│   ├── vr.html / vr.js # vue WebXR (casque)
│   ├── vr-renderer.js  # rendu stéréo WebGL (écran plan / dôme 180°)
│   └── xr-math.js      # petites matrices 4×4
├── scripts/
│   ├── doctor.sh           # diagnostic complet de l'environnement (tous OS)
│   ├── install-service.sh  # service systemd (Linux natif)
│   ├── attach-camera.ps1   # usbipd : caméra Windows → WSL2
│   ├── probe-camera.sh     # formats supportés par la caméra
│   ├── allow-lan.ps1       # pare-feu Windows + Hyper-V (accès du casque)
│   ├── tailscale-cert.sh   # certificat HTTPS approuvé (Tailscale)
│   ├── gen-cert.sh         # repli : certificat HTTPS auto-signé
│   └── dshow-list.ps1      # plan B : caméra lue sous Windows
├── test/
│   ├── annexb.test.mjs       # découpage H.264
│   ├── sps.test.mjs          # dimensions réelles lues dans le SPS
│   ├── integration.test.mjs  # serveur + client WebSocket de bout en bout
│   ├── tls.test.mjs          # HTTPS + WSS (contexte sécurisé WebXR)
│   └── math.test.mjs         # matrices de projection
└── docs/
    ├── ARCHITECTURE.md     # comment ça marche, en détail
    ├── LATENCY.md          # budget de latence et réglages
    ├── LINUX.md            # installation sur un hôte Linux natif
    ├── HTTPS-TAILSCALE.md  # HTTPS approuvé sans avertissement
    └── ROADMAP-WEBRTC.md   # l'étape suivante : WebRTC
```

---

## 🎥 À propos de la stéréo

La caméra délivre **une seule image** contenant les deux yeux côte à côte
(par ex. 2560×720 = 2 × 1280×720). Le serveur la transmet telle quelle — **un seul
flux, un seul décodage** — et le shader envoie la moitié gauche à l'œil gauche et la
moitié droite à l'œil droit. C'est le chemin le plus court : aucune synchronisation
entre deux flux à gérer.

Si le relief paraît inversé (« rentré »), cochez **« Inverser les yeux »** dans
l'interface VR : l'ordre des deux images dépend du fabricant.

➡️ **Pour aller plus loin** (calibration, correction des distorsions, VR180 réel),
voir [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#améliorer-le-rendu-3d).

---

## ⚠️ Limites connues

- Ce projet est **une étape** : WebSocket est excellent sur un LAN, mais **WebRTC
  fera mieux** dès qu'il y aura du jitter ou des pertes. Voir
  [`docs/ROADMAP-WEBRTC.md`](docs/ROADMAP-WEBRTC.md).
- Pas de son (la caméra peut avoir un micro : `-f dshow -i audio=...` ou ALSA).
- Le relief brut (sans calibration) est correct mais pas parfait : les deux objectifs
  ne sont jamais parfaitement alignés.
- WebCodecs est requis : tout navigateur Chromium récent fait l'affaire (le
  navigateur du Quest, oui). **Attention au H.264** : certains paquets `chromium`
  sont livrés *sans* décodeur H.264 (c'est le cas du *snap* d'Ubuntu, pour des
  raisons de licence) et répondent alors `Codec non supporté`. Utilisez **Google
  Chrome** ou **Firefox** sur ces machines.
- Le serveur annonce la taille **réelle** du flux (lue dans le SPS), pas celle de
  `.env`. Si la caméra négocie un autre mode, le journal le signale — utile pour
  repérer un mode vidéo qui n'est pas celui attendu.
