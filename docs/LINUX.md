# Installer sur un hôte Linux natif

Le projet a été développé sous **Windows + WSL2** uniquement parce que le PC
disponible tournait sous Windows. **Aucun code n'est spécifique à Windows** : le
serveur (`server/`) et le client (`public/`) sont du Node.js et du navigateur
ordinaires.

Faire tourner le tout sur un **Linux natif** est donc non seulement possible,
c'est **la meilleure configuration** : plus simple à installer, plus rapide, et
plus faible en latence.

---

## Ce qui disparaît par rapport à l'installation Windows/WSL2

| Contrainte WSL2 | Sur Linux natif |
|---|---|
| `usbipd-win` + `usbipd attach` à refaire à chaque reboot | ❌ inutile — la caméra est un `/dev/video*` normal |
| WSL2 en **NAT** : le casque ne peut pas joindre le serveur | ❌ inutile — le serveur est sur le réseau local |
| `networkingMode=mirrored` dans `.wslconfig` + `wsl --shutdown` | ❌ inutile |
| `scripts/allow-lan.ps1` (pare-feu Windows **et** Hyper-V) | ❌ remplacé par une règle `ufw`/`firewalld` |
| Copie du certificat depuis `/mnt/c/...` | ❌ Tailscale tourne nativement |
| Aller-retour USB/IP vers Windows | ❌ accès direct au périphérique |

Seuls les scripts `*.ps1` de `scripts/` deviennent inutiles. Le reste — serveur,
client WebXR, tests — est **identique**.

---

## 1. Prérequis

```bash
sudo apt update
sudo apt install -y ffmpeg v4l-utils
```

- **ffmpeg** : indispensable. La version des dépôts contient `v4l2`, `libx264` et
  le plus souvent un encodeur matériel (VAAPI).
- **v4l-utils** : fournit `v4l2-ctl`, pour connaître les formats réellement
  supportés par la caméra.

**Node.js 22 LTS** est recommandé (Node 20 fonctionne pour le serveur ; les tests
ont besoin de Node 22, voir plus bas) :

```bash
node -v        # si < 20 :
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

---

## 2. Accès à la caméra

Branchez la caméra, puis :

```bash
lsusb | grep -i -E 'cam|video'
v4l2-ctl --list-devices
```

> ⚠️ Une caméra UVC expose souvent **plusieurs** nœuds : `/dev/video0` **et**
> `/dev/video1`. Le second est fréquemment un nœud « métadonnées » qui ne
> supporte aucune résolution. Si `video0` échoue, essayez `video1`.

Donnez l'accès à votre utilisateur (une seule fois) :

```bash
sudo usermod -aG video $USER
```

Puis **reconnectez-vous** (ou `newgrp video`). Vérifiez sans `sudo` :

```bash
v4l2-ctl --list-formats-ext -d /dev/video0
```

Si cette commande fonctionne **sans `sudo`**, tout est en place.

---

## 3. Installation du projet

```bash
cd ~/stereo-vr-stream
npm install
cp .env.example .env
```

Relevez les formats réellement supportés :

```bash
npm run probe          # ou : v4l2-ctl --list-formats-ext -d /dev/video0
```

Puis renseignez `.env` avec **les valeurs exactes** de la caméra :

```ini
SOURCE=v4l2
DEVICE=/dev/video0
INPUT_FORMAT=mjpeg      # YUYV est presque toujours plafonné à 5 im/s : à éviter
WIDTH=2560              # 1 seule image SBS = 2 × 1280×720
HEIGHT=720
FPS=30
ENCODER=libx264
```

> 💡 `.env` est lu automatiquement au démarrage. Une variable passée dans le shell
> reste prioritaire : `FPS=15 npm start` teste une variante sans rien modifier.

---

## 4. Diagnostic

Un contrôle complet de l'environnement, en lecture seule et **sans `sudo`** :

```bash
npm run doctor
```

Il vérifie Node, ffmpeg (entrée v4l2, encodeurs), l'accès caméra, les groupes
utilisateur, le port 8080, les adresses réseau et Tailscale — et indique la
correction à apporter pour chaque point rouge.

---

## 5. Lancer

```bash
npm start
```

Puis, sur le casque : `https://<IP-du-PC>:8080/vr.html` (voir HTTPS au §7).

Pour tester **sans caméra** (source synthétique) :

```bash
npm run test-source
```

---

## 6. Encodage matériel — le vrai gain du Linux natif

Sous WSL2 la machine virtuelle n'expose ni `/dev/dri` ni le GPU au travers de
ffmpeg : **seul `libx264` (logiciel) est utilisable**. Sur un Linux natif, les
encodeurs matériels deviennent accessibles, ce qui libère le CPU et peut réduire
la latence.

| Encodeur | Matériel | Variable |
|---|---|---|
| `libx264` | CPU (défaut) | `ENCODER=libx264` |
| `h264_vaapi` | iGPU Intel / AMD | `ENCODER=h264_vaapi` |
| `h264_nvenc` | GPU NVIDIA | `ENCODER=h264_nvenc` |
| `h264_qsv` | iGPU Intel (Quick Sync) | `ENCODER=h264_qsv` |

> 💡 **Vous ne savez pas lequel choisir ?** C'est le cas normal. Lancez
> `npm run doctor` : il détecte votre GPU et affiche **la commande exacte** à
> utiliser. Le défaut (`libx264`) convient de toute façon à la plupart des
> machines — vous n'êtes pas obligé d'y toucher.

> ⚠️ **N'inventez pas un nom d'encodeur.** Tout nom non géré par ce projet
> retombe sur `libx264` (logiciel). Ce n'est plus silencieux : le serveur affiche
> un avertissement explicite au démarrage, et donne la liste des encodeurs
> valides. En cas de doute, `npm run doctor`.

Quels encodeurs votre ffmpeg propose-t-il ?

```bash
ffmpeg -hide_banner -encoders | grep 264
```

**VAAPI** (le plus courant) :

```bash
ls -l /dev/dri/                       # doit montrer renderD128
sudo usermod -aG render $USER         # puis reconnectez-vous
ENCODER=h264_vaapi npm start
```

Le code ajoute automatiquement `-vaapi_device /dev/dri/renderD128` et le filtre
`format=nv12,hwupload`. Si votre nœud de rendu est différent :

```bash
VAAPI_DEVICE=/dev/dri/renderD129 ENCODER=h264_vaapi npm start
```

> ⚠️ **Mesurez.** Les réglages des encodeurs matériels de ce projet n'ont pas pu
> être validés sur un GPU réel (aucun n'était disponible dans la VM de
> développement). Comparez la latence affichée sur `http://<PC>:8080/` avec
> `libx264` : sur un CPU récent, l'encodage logiciel est déjà très rapide et peut
> suffire. Un encodeur matériel mal réglé peut au contraire **ajouter** de la
> latence (mise en tampon interne).
>
> Repère : au débit de 2560×720, `libx264 -preset ultrafast` offrait déjà ×6,7 de
> marge sur la machine de développement (voir `docs/LATENCY.md`).

`ultrafast` désactive le filtre anti-blocs : sur une image projetée en grand dans
le casque, un léger « blocking » peut se voir. `superfast` coûte environ
+1,5 ms par image mais améliore nettement le rendu.

---

## 7. HTTPS approuvé (obligatoire pour WebXR)

WebXR **et** WebCodecs exigent un **contexte sécurisé**. Sur un Linux natif,
Tailscale s'installe directement sur la machine — c'est plus simple que sous
Windows et **plus faible en latence**, car le trafic peut rester en pair-à-pair
sur le réseau local au lieu de transiter par un relais.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Activez ensuite **MagicDNS** et **HTTPS Certificates** dans la console
d'administration Tailscale, puis :

```bash
npm run cert:tailscale        # récupère le certificat dans certs/
TLS=1 npm start
```

Sur le casque : `https://<nom-machine>.<votre-tailnet>.ts.net/vr.html`

Le script `scripts/tailscale-cert.sh` détecte automatiquement le binaire natif.
Guide détaillé : **[HTTPS-TAILSCALE.md](HTTPS-TAILSCALE.md)**.

**Sans Tailscale**, deux replis :

```bash
npm run cert                  # certificat auto-signé (avertissement à accepter)
TLS=1 npm start
```

Le certificat auto-signé produit couvre `localhost`, `127.0.0.1`, `::1`, le nom
de la machine (`.local` compris) et toutes les adresses IPv4 locales. Ouvrez donc
`https://localhost:8080/` sur la machine elle-même, et acceptez l'avertissement
sur le casque.

> **Le piège du certificat auto-signé** : il est figé sur les adresses présentes
> au moment de sa création. Si la machine change d'adresse IP, le navigateur
> **refuse** la connexion (ce n'est plus un simple avertissement). Régénérez-le
> avec `npm run cert` — et laissez `npm run doctor` vous prévenir : il vérifie que
> le certificat couvre bien les adresses actuelles et que la clé correspond.

Pour un HTTPS **sans aucun avertissement** en local, il faut une autorité
installée dans le magasin de confiance du système et du navigateur : l'outil
[`mkcert`](https://github.com/FiloSottile/mkcert) le fait très bien
(`mkcert -install` puis `mkcert localhost <ip>`), mais il faut l'installer aussi
sur le casque, ce qui n'est pas toujours possible. Tailscale reste plus simple.

ou, en dépannage, autoriser l'origine en clair dans Chrome :
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`.

---

## 8. Pare-feu

Sur une distribution avec `ufw` :

```bash
sudo ufw allow 8080/tcp
```

Avec `firewalld` :

```bash
sudo firewall-cmd --add-port=8080/tcp --permanent
sudo firewall-cmd --reload
```

Restreignez si possible au réseau local (`sudo ufw allow from 192.168.0.0/16 to any port 8080 proto tcp`)
plutôt qu'à l'Internet entier.

---

## 9. Démarrage automatique (systemd)

Le service est généré automatiquement pour votre utilisateur, avec les bonnes
variables d'environnement et l'accès aux groupes `video`/`render` — sans jamais
tourner en root :

```bash
sudo bash scripts/install-service.sh
```

Pour inspecter l'unité **sans rien installer** :

```bash
bash scripts/install-service.sh --print
```

Gestion :

```bash
systemctl status stereo-vr-stream
systemctl restart stereo-vr-stream
journalctl -u stereo-vr-stream -f      # suivre les journaux
```

Désinstallation :

```bash
sudo bash scripts/install-service.sh --uninstall
```

> 💡 Comme `npm install` a déjà été lancé, le service démarre immédiatement. Le
> serveur gère `SIGTERM` et arrête `ffmpeg` proprement à l'arrêt du service.

---

## 10. Latence : pourquoi c'est mieux

La latence évitée par rapport à la configuration Windows + WSL2 :

| Maillon supprimé | Gain |
|---|---|
| Aller-retour **USB/IP** (`usbipd`) Windows → WSL | le flux USB traverse le réseau virtuel à chaque image |
| **Commutateur virtuel Hyper-V** + NAT WSL | un saut réseau supplémentaire sur chaque paquet |
| Redirection de port / `tailscale serve` | suppression d'un relais dans le chemin |

Le reste de la chaîne (encodage, WebSocket, WebCodecs) est **identique**, donc le
budget de `docs/LATENCY.md` s'applique tel quel, moins ces surcoûts.

---

## 11. Tests

```bash
npm test
```

Cinq suites, sans caméra : découpage H.264, dimensions réelles du SPS, protocole
WebSocket de bout en bout, TLS/WSS, et matrices de projection.

> Les tests utilisent le client WebSocket de Node, disponible **nativement à
> partir de Node 22**. Avec Node 20, le serveur fonctionne normalement mais
> `test/integration.test.mjs` et `test/tls.test.mjs` peuvent échouer — utilisez
> Node 22 ou lancez-les depuis un navigateur.

---

## 12. Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| `Accès refusé` / `Permission denied` sur `/dev/video0` | utilisateur hors du groupe `video` | `sudo usermod -aG video $USER` puis reconnexion |
| `Device or resource busy` | un autre logiciel (navigateur, Cheese, OBS…) occupe la caméra | fermez-le, puis relancez |
| Environ 5 im/s seulement | la caméra est en `YUYV` | `INPUT_FORMAT=mjpeg` dans `.env` |
| `Invalid argument` au démarrage de ffmpeg | résolution/fréquence non supportées | relevez les vraies valeurs avec `npm run probe` |
| Journal : `dimensions réelles du flux : …` ≠ `.env` | la caméra ne délivre pas la taille demandée | recopiez les valeurs du journal dans `WIDTH`/`HEIGHT`, ou choisissez un mode réellement proposé (`npm run probe`) |
| `Codec non supporté : avc1.…` | décodeur H.264 absent du navigateur | utilisez **Google Chrome** ou **Firefox** : certains paquets `chromium` (dont le *snap* d'Ubuntu) sont livrés **sans H.264**, pour des raisons de licence |
| L'image reste figée dans le casque | paquet perdu | bouton « Redemander une image clé » |
| WebXR indisponible / bouton absent | origine non sécurisée | passez en HTTPS (§7) |
| Le casque ne joint pas le serveur | pare-feu | §8 |

> **Le serveur lit-il vraiment ma caméra ?** Depuis peu, le serveur extrait la
> taille **réelle** de l'image du SPS H.264 et l'annonce au navigateur — il ne se
> contente plus de répéter `WIDTH`/`HEIGHT`. Si les deux diffèrent, il le dit :
>
> ```
> [flux] codec H.264 détecté : avc1.42c01f
> [flux] dimensions réelles du flux : 1280×720
> [flux] ⚠ la caméra ne délivre PAS la taille demandée (2560×720).
> ```
>
> C'est un message utile, pas une erreur : il signifie que le mode vidéo choisi
> n'est pas celui que vous croyez.

---

## En résumé

```bash
sudo apt install -y ffmpeg v4l-utils
sudo usermod -aG video $USER          # puis reconnexion
cd ~/stereo-vr-stream && npm install && cp .env.example .env
npm run probe                         # relever les formats, les écrire dans .env
npm run doctor                        # vérifier que tout est vert
npm start                             # ou : sudo bash scripts/install-service.sh
```
