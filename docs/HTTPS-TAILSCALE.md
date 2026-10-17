# HTTPS approuvé pour le casque, via Tailscale

Objectif : charger `vr.html` sur le Quest en **HTTPS avec un certificat
réellement approuvé**, donc **sans aucun avertissement à accepter** — condition
pour que WebXR et WebCodecs s'activent immédiatement.

Tailscale résout deux problèmes d'un coup :

| Problème | Sans Tailscale | Avec Tailscale |
|---|---|---|
| Contexte sécurisé (HTTPS) | certificat auto-signé + avertissement | certificat Let's Encrypt, approuvé |
| Le casque atteint le serveur | WSL2 est derrière un NAT, injoignable | adresse `100.x` dans le tailnet |

---

## ⚠️ À lire avant de commencer : ne PAS utiliser `tailscale serve`

La solution évidente serait `tailscale serve 8080`, qui expose un port local en
HTTPS avec certificat automatique. **Elle est à éviter ici.**

`tailscale serve` est un proxy inverse, et le relais des **WebSocket y est
défaillant** : le bug [#18827](https://github.com/tailscale/tailscale/issues/18827)
décrit des coupures « **toutes les 10 à 40 s**, code 1001 (Going Away) » — et
l'environnement du rapport est précisément le nôtre : *hôte Windows, backend
WSL2, serveur WebSocket Node.js*. Un flux vidéo qui se coupe toutes les 20 s est
inutilisable.

**Notre approche** : Tailscale fournit uniquement le **certificat**, et c'est
notre serveur Node qui termine le TLS lui-même. Le WebSocket va donc de bout en
bout, sans intermédiaire.

---

## Où installer Tailscale ?

**Sur l'hôte Windows** — et non dans WSL.

Raison : Tailscale établit une connexion *directe* entre deux appareils du même
réseau local, mais retombe sur un **relais** (`DERP`) quand ça échoue — ce qui
ajoute de la latence. Installé sous Windows, il possède une adresse réellement
présente sur votre Wi-Fi (`172.16.117.95`) et joint donc le casque en direct.
Installé dans WSL, il serait derrière le NAT de Windows et risquerait le relais,
au détriment de la priorité n°1 du projet.

Le serveur, lui, reste dans WSL (il a besoin de la caméra via `usbipd`). Le mode
réseau **mirrored**, déjà configuré dans `.wslconfig`, fait partager à WSL les
interfaces de Windows — l'interface Tailscale comprise : le serveur devient donc
joignable à l'adresse `100.x` du PC.

---

## Mise en place

### 1. Installer Tailscale sur Windows

<https://tailscale.com/download> → connexion avec votre compte.

Vérification, depuis WSL :

```bash
"/mnt/c/Program Files/Tailscale/tailscale.exe" status
```

### 2. Activer MagicDNS puis HTTPS

Dans la **console d'administration** Tailscale (<https://login.tailscale.com/admin>) :

1. page **DNS** → activer **MagicDNS** ;
2. même page → **HTTPS Certificates** → **Enable HTTPS**.

> 🔓 Vous devrez confirmer que les noms de vos machines et votre nom de tailnet
> seront publiés dans un registre public. Seuls les noms le sont — aucun contenu.

### 3. Installer Tailscale sur le casque

Tailscale n'est **pas** sur le store Meta : il faut passer par un sideload.

1. Sur le Quest : **mode développeur** (application Meta Quest → Menu → Appareils
   → votre casque → Paramètres du casque → Mode développeur), puis redémarrer ;
2. télécharger l'APK Android sur <https://pkgs.tailscale.com/stable/#android>
   (**uniquement** depuis le site officiel) ;
3. l'installer avec [SideQuest](https://sidequestvr.com) (bouton
   *Install APK from folder*) ou en ligne de commande :
   ```bash
   adb install -r tailscale-android.apk
   ```
4. ouvrir l'application dans le casque et se connecter au même compte.

> 💡 Astuce : dans le Quest, autorisez le VPN Tailscale de façon permanente.
> L'application demande l'autorisation d'établir une connexion VPN.

### 4. Récupérer le certificat et lancer le serveur

```bash
cd ~/stereo-vr-stream
bash scripts/tailscale-cert.sh          # télécharge certs/cert.pem + certs/key.pem
TLS=1 npm start
```

Le script détecte si Tailscale tourne sous Windows ou dans WSL, récupère le nom
complet de la machine, et affiche les dates de validité.

### 5. Ouvrir sur le casque

```
https://<nom-machine>.<votre-tailnet>.ts.net/vr.html
```

Aucun avertissement, aucun port à préciser, et **« Entrer en VR »** s'affiche
immédiatement.

---

## Vérifier la latence du lien

C'est le point à contrôler : une connexion *relayée* ajouterait des dizaines de
millisecondes. Depuis Windows (PowerShell) :

```powershell
& 'C:\Program Files\Tailscale\tailscale.exe' ping <nom-du-quest>
```

- **`via 172.16.117.x:41641`** (une adresse du réseau local) → liaison **directe**,
  c'est ce qu'on veut ;
- **`via DERP(...)`** → la connexion passe par un relais : la latence sera
  nettement plus élevée. Dans ce cas, vérifiez que les deux appareils sont bien
  sur le même Wi-Fi et qu'aucun VPN concurrent (NordVPN) ne détourne le trafic.

---

## Points de vigilance

**Certificat valable 90 jours.** Relancez `bash scripts/tailscale-cert.sh` avant
expiration, puis redémarrez le serveur. Pensez à le refaire au moins une fois tous
les trois mois — ou automatisez-le (`cron`, tâche planifiée Windows).

**Feuille de route alternative.** Si le mode mirrored ne rendait pas le serveur
joignable sur l'adresse Tailscale, l'accès reste possible par redirection TCP —
voir « Solution B » dans le README. Un `portproxy` est purement TCP, donc les
WebSocket y passent parfaitement (contrairement à `tailscale serve`).

**VPN concurrents.** NordVPN est actif sur cette machine : deux clients WireGuard
(NordLynx + Tailscale) qui se disputent le routage, c'est le meilleur moyen
d'obtenir des chemins relayés, voire une absence totale de connexion. Si le
`tailscale ping` indique `DERP`, commencez par là.

**Ne pas exposer cela sur Internet.** `tailscale serve --funnel` publierait votre
flux vidéo en clair sur le Web. On n'utilise que le tailnet privé ici.
