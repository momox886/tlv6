#!/usr/bin/env bash
# Diagnostic de l'environnement : vérifie tout ce qu'il faut pour faire tourner
# le flux stéréo, et dit quoi faire quand quelque chose manque.
#
# Ne modifie RIEN et n'a pas besoin de sudo. À lancer sur la machine cible :
#     bash scripts/doctor.sh
set -uo pipefail

cd "$(dirname "$0")/.."

OK=0; WARN=0; FAIL=0
ok()   { printf '  \033[32m✅\033[0m %s\n' "$1"; OK=$((OK+1)); }
warn() { printf '  \033[33m⚠️ \033[0m %s\n' "$1"; WARN=$((WARN+1)); }
bad()  { printf '  \033[31m❌\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
fix()  { printf '       \033[2m→ %s\033[0m\n' "$1"; }
info() { printf '  %s\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

IS_WSL=0
head_ "Système"
if [ -r /proc/sys/kernel/osrelease ]; then
  KERNEL="$(cat /proc/sys/kernel/osrelease)"
  echo "  noyau : $KERNEL"
  if echo "$KERNEL" | grep -qiE 'microsoft|wsl'; then
    IS_WSL=1
    warn "environnement WSL2 détecté"
    fix "le NAT de WSL2 empêche le casque de joindre le serveur : voir README « Le casque ne se connecte pas »"
  else
    ok "Linux natif : le serveur sera directement sur le réseau local"
  fi
fi

head_ "Node.js"
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -p 'process.versions.node')"
  NODE_MAJOR="${NODE_V%%.*}"
  echo "  version : $NODE_V"
  if [ "$NODE_MAJOR" -ge 22 ]; then
    ok "Node $NODE_V (recommandé)"
  elif [ "$NODE_MAJOR" -ge 20 ]; then
    warn "Node $NODE_V : le serveur fonctionne, mais certaines suites de tests exigent Node 22+"
    fix "recommandé : Node 22 LTS"
  else
    bad "Node $NODE_V est trop ancien (minimum 20)"
    fix "installez Node 22 : https://nodejs.org/ (ou nvm)"
  fi
else
  bad "node introuvable"
  fix "installez Node.js 22 : https://nodejs.org/"
fi

if [ -d node_modules ]; then
  ok "dépendances installées (node_modules présent)"
else
  warn "dépendances non installées"
  fix "lancez : npm install"
fi

head_ "ffmpeg"
if command -v ffmpeg >/dev/null 2>&1; then
  ok "ffmpeg : $(ffmpeg -hide_banner -version 2>/dev/null | head -1 | cut -d' ' -f1-3)"

  # On capture la sortie dans une variable AVANT de chercher dedans.
  # Ne JAMAIS faire ici `ffmpeg ... | grep -q` : avec `set -o pipefail`, grep -q
  # s'arrête au premier succès, ferme le tuyau, ffmpeg meurt sur SIGPIPE, et le
  # pipeline est considéré comme en échec — d'où un faux « libx264 absent ».
  FFMPEG_DEVICES="$(ffmpeg -hide_banner -devices 2>/dev/null || true)"
  FFMPEG_ENCODERS="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"

  if grep -q v4l2 <<<"$FFMPEG_DEVICES"; then
    ok "entrée v4l2 disponible (indispensable pour la caméra USB)"
  else
    bad "ffmpeg ne gère pas l'entrée v4l2"
    fix "installez la version complète : sudo apt install ffmpeg"
  fi

  echo "  encodeurs H.264 disponibles :"
  ENCS="$(grep -oE '\bh264_(vaapi|nvenc|qsv|amf|v4l2m2m)\b' <<<"$FFMPEG_ENCODERS" | sort -u | tr '\n' ' ')"
  if grep -q '\blibx264\b' <<<"$FFMPEG_ENCODERS"; then
    echo "    - libx264 (logiciel) — toujours présent, suffisant"
  else
    bad "libx264 absent : c'est l'encodeur de repli, il est indispensable"
    fix "sudo apt install ffmpeg"
  fi
  for e in $ENCS; do
    case "$e" in
      h264_vaapi)  echo "    - h264_vaapi   (iGPU Intel / AMD)";;
      h264_nvenc)  echo "    - h264_nvenc   (GPU NVIDIA)";;
      h264_qsv)    echo "    - h264_qsv     (iGPU Intel Quick Sync)";;
      h264_amf)    echo "    - h264_amf     (GPU AMD, Windows)";;
      h264_v4l2m2m) echo "    - h264_v4l2m2m (encodeur matériel ARM — voir la note plus bas)";;
    esac
  done
  [ -n "$ENCS" ] || echo "    (aucun encodeur matériel détecté par ffmpeg)"

  # --- Quel encodeur vous convient ? ---------------------------------------
  # L'utilisateur n'a pas à connaître son matériel : on le détecte.
  printf '  matériel détecté : '
  GPU_CLASS="inconnu"
  GPU_LABEL=""
  if command -v lspci >/dev/null 2>&1; then
    GPU_LINE="$(lspci -nn 2>/dev/null | grep -iE 'vga compatible|3d controller|display controller' | head -1 || true)"
    [ -n "$GPU_LINE" ] && GPU_LABEL="${GPU_LINE#*: }"
  fi
  if [ -z "$GPU_LABEL" ] && [ -d /sys/class/drm ]; then
    for vf in /sys/class/drm/card*/device/vendor; do
      [ -r "$vf" ] || continue
      case "$(cat "$vf" 2>/dev/null)" in
        0x10de) GPU_CLASS="nvidia"; GPU_LABEL="GPU NVIDIA";;
        0x8086) GPU_CLASS="intel";  GPU_LABEL="iGPU Intel";;
        0x1002|0x1022) GPU_CLASS="amd"; GPU_LABEL="GPU/iGPU AMD";;
        0x14e4) GPU_CLASS="broadcom"; GPU_LABEL="Broadcom (Raspberry Pi ?)";;
        *) continue;;
      esac
      break
    done
  fi
  case "$GPU_CLASS" in
    nvidia) GPU_CLASS="nvidia";;
    intel)  GPU_CLASS="intel";;
    amd)    GPU_CLASS="amd";;
    broadcom) GPU_CLASS="broadcom";;
    *) if [ -n "$GPU_LABEL" ]; then
         case "$GPU_LABEL" in
           *NVIDIA*) GPU_CLASS="nvidia";;
           *Intel*)  GPU_CLASS="intel";;
           *AMD*|*Radeon*|*ATI*) GPU_CLASS="amd";;
         esac
       fi;;
  esac
  if [ -n "$GPU_LABEL" ]; then echo "$GPU_LABEL"; else echo "aucun GPU identifié (ou lspci absent)"; fi

  RENDER_NODES="$(ls /dev/dri/renderD* 2>/dev/null | tr '\n' ' ' || true)"
  if [ -n "$RENDER_NODES" ] && [ "$IS_WSL" -eq 1 ]; then
    # WSLg expose /dev/dri (GPU « paravirtuel »), mais il ne sert PAS à encoder :
    # ffmpeg n'y trouve pas d'encodeur VAAPI exploitable. Ne pas envoyer
    # l'utilisateur ajouter son compte au groupe « render » pour rien.
    info "nœuds /dev/dri : $RENDER_NODES (fournis par WSLg — inutilisables pour l'encodage)"
  elif [ -n "$RENDER_NODES" ]; then
    info "nœuds de rendu : $RENDER_NODES"
    RENDER_OK=0
    for node in $RENDER_NODES; do [ -r "$node" ] && RENDER_OK=1; done
    if [ "$RENDER_OK" -eq 1 ]; then
      ok "un nœud /dev/dri est accessible en lecture"
    else
      warn "nœuds /dev/dri présents mais non accessibles par $(id -un)"
      fix "sudo usermod -aG render $(id -un)  puis reconnectez-vous"
    fi
  else
    info "aucun nœud /dev/dri (normal sans iGPU, sans GPU, ou depuis WSL2)"
  fi

  # Recommandation : uniquement parmi les encodeurs que le code gère
  # EXPLICITEMENT (les autres retombent silencieusement sur libx264).
  RECO="libx264"
  RECO_WHY="encodeur logiciel, fonctionne partout"
  if [ "$GPU_CLASS" = "nvidia" ] && grep -q '\bh264_nvenc\b' <<<"$FFMPEG_ENCODERS"; then
    RECO="h264_nvenc"; RECO_WHY="GPU NVIDIA détecté"
  elif { [ "$GPU_CLASS" = "intel" ] || [ "$GPU_CLASS" = "amd" ]; } \
       && [ "${RENDER_OK:-0}" -eq 1 ] && grep -q '\bh264_vaapi\b' <<<"$FFMPEG_ENCODERS"; then
    RECO="h264_vaapi"; RECO_WHY="iGPU $GPU_CLASS détecté avec /dev/dri accessible"
  elif [ "$GPU_CLASS" = "intel" ] && grep -q '\bh264_qsv\b' <<<"$FFMPEG_ENCODERS"; then
    RECO="h264_qsv"; RECO_WHY="iGPU Intel détecté (Quick Sync)"
  fi

  printf '  → encodeur recommandé : '
  printf '\033[1m%s\033[0m  (%s)\n' "$RECO" "$RECO_WHY"
  if [ "$RECO" = "libx264" ]; then
    fix "rien à faire : c'est déjà la valeur par défaut. Mesurez d'abord la latence"
    fix "sur http://<PC>:8080/ — si le CPU souffre, cherchez un encodeur matériel."
  else
    fix "essayez : ENCODER=$RECO npm start"
    fix "comparez la latence affichée par la page 2D avec celle de libx264"
  fi

  # La note v4l2m2m ne concerne que les machines ARM : sur x86, cet encodeur est
  # compilé « au cas où » mais n'a aucun matériel derrière.
  ARCH="$(uname -m 2>/dev/null || echo inconnu)"
  if grep -q '\bh264_v4l2m2m\b' <<<"$FFMPEG_ENCODERS" \
     && { [ "$GPU_CLASS" = "broadcom" ] || grep -qE '^(aarch64|armv7l|armv6l)$' <<<"$ARCH"; }; then
    warn "h264_v4l2m2m est disponible ($ARCH) mais N'EST PAS géré par ce projet :"
    fix "il retomberait sur l'encodage logiciel. De plus ces encodeurs ARM sont"
    fix "limités en résolution (souvent 1920 px de large, < 2560 px de ce flux)."
  fi

else
  bad "ffmpeg introuvable"
  fix "sudo apt install ffmpeg"
fi

head_ "Caméra"
shopt -s nullglob
DEVS=(/dev/video*)
shopt -u nullglob
if [ ${#DEVS[@]} -eq 0 ]; then
  bad "aucun périphérique /dev/video*"
  fix "branchez la caméra en USB, puis vérifiez : lsusb ; dmesg | tail"
else
  echo "  périphériques trouvés : ${DEVS[*]}"
  if command -v v4l2-ctl >/dev/null 2>&1; then
    v4l2-ctl --list-devices 2>/dev/null | sed 's/^/    /'
  else
    fix "installez v4l-utils pour lister les formats : sudo apt install v4l-utils"
  fi

  READABLE=0
  for dev in "${DEVS[@]}"; do
    if timeout 5 v4l2-ctl --device="$dev" --get-fmt-video >/dev/null 2>&1 || [ -r "$dev" ]; then
      READABLE=1
      ok "accès en lecture à $dev"
      break
    fi
  done
  if [ "$READABLE" -eq 0 ]; then
    bad "aucun /dev/video* accessible en lecture par $(id -un)"
    fix "sudo usermod -aG video $(id -un)  puis reconnectez-vous (ou 'newgrp video')"
  fi

  if id -nG 2>/dev/null | tr ' ' '\n' | grep -qx video; then
    ok "l'utilisateur $(id -un) est dans le groupe « video »"
  else
    warn "l'utilisateur $(id -un) n'est pas dans le groupe « video »"
    fix "sudo usermod -aG video $(id -un)  puis reconnectez-vous"
  fi
fi

head_ "Configuration"
if [ -f .env ]; then
  ok "fichier .env présent"
  grep -E '^(SOURCE|DEVICE|WIDTH|HEIGHT|FPS|INPUT_FORMAT|ENCODER|TLS)=' .env | sed 's/^/    /'
  if grep -qE '^DEVICE=/dev/video0' .env && [ ! -e /dev/video0 ]; then
    warn "DEVICE=/dev/video0 dans .env, mais ce périphérique n'existe pas"
    fix "corrigez DEVICE= dans .env selon la sortie ci-dessus"
  fi
else
  warn "aucun fichier .env (les valeurs par défaut s'appliquent)"
  fix "cp .env.example .env  puis ajustez WIDTH/HEIGHT/DEVICE"
fi

head_ "HTTPS (certificat)"

TLS_ON=0
if [ -f .env ] && grep -qE '^TLS=(1|true)$' .env; then TLS_ON=1; fi

if ! command -v openssl >/dev/null 2>&1; then
  warn "openssl absent : impossible de vérifier le certificat"
  fix "sudo apt install openssl"
elif [ ! -f certs/cert.pem ]; then
  if [ "$TLS_ON" -eq 1 ]; then
    bad "TLS=1 dans .env mais certs/cert.pem est absent : le serveur refusera de démarrer"
    fix "générez un certificat auto-signé : npm run cert"
  else
    info "aucun certificat (normal tant que TLS=0)"
    fix "pour servir en HTTPS local : npm run cert  puis TLS=1 dans .env"
  fi
else
  ok "certificat présent : certs/cert.pem"

  # La clé privée doit correspondre au certificat, sinon TLS ne démarre pas.
  # On compare les clés PUBLIQUES (indépendant de l'algorithme, RSA ou ECDSA).
  CERT_PUB="$(openssl x509 -in certs/cert.pem -noout -pubkey 2>/dev/null | openssl sha256 2>/dev/null || true)"
  KEY_PUB="$(openssl pkey -in certs/key.pem -pubout 2>/dev/null | openssl sha256 2>/dev/null || true)"
  if [ -f certs/key.pem ] && [ -n "$CERT_PUB" ] && [ "$CERT_PUB" = "$KEY_PUB" ]; then
    ok "certs/key.pem correspond bien au certificat"
  else
    bad "certs/key.pem manquant, ou ne correspond pas au certificat"
    fix "régénérez la paire : npm run cert"
  fi

  SAN="$(openssl x509 -in certs/cert.pem -noout -ext subjectAltName 2>/dev/null | tail -n +2 || true)"

  # Expiration : un certificat périmé provoque un refus, pas seulement un avertissement.
  END="$(openssl x509 -in certs/cert.pem -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
  if [ -n "$END" ]; then
    END_TS="$(date -d "$END" +%s 2>/dev/null || echo 0)"
    DAYS_LEFT=$(( (END_TS - $(date +%s)) / 86400 ))
    if [ "$DAYS_LEFT" -lt 0 ]; then
      bad "le certificat a EXPIRÉ (le $END)"
      fix "régénérez-le : npm run cert"
    elif [ "$DAYS_LEFT" -lt 30 ]; then
      warn "le certificat expire dans $DAYS_LEFT jour(s)"
      fix "régénérez-le : npm run cert"
    else
      ok "valide encore $DAYS_LEFT jours"
    fi
  fi

  # Couverture : le navigateur REFUSE une origine absente du subjectAltName.
  # C'est le piège classique du certificat auto-signé : l'adresse IP change
  # (bail DHCP, autre réseau) et le certificat ne couvre plus rien.
  if grep -q 'DNS:localhost' <<<"$SAN" && grep -q '127\.0\.0\.1' <<<"$SAN"; then
    ok "couvre https://localhost"
  else
    warn "ne couvre pas « localhost »"
    fix "régénérez : npm run cert"
  fi

  MISSING=()
  # Même source que gen-cert.sh (`hostname -I`) : ainsi, si l'on signale une
  # adresse manquante, `npm run cert` la couvrira bien à la régénération.
  # (On écarte le loopback, qui inclut sous WSL2 un alias /32 sans rapport.)
  while IFS= read -r ip; do
    [ -n "$ip" ] || continue
    grep -qF "$ip" <<<"$SAN" || MISSING+=("$ip")
  done < <(
    hostname -I 2>/dev/null | tr ' ' '\n' |
      grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' |
      grep -v '^127\.' | grep -v '^169\.254\.' || true
  )
  if [ ${#MISSING[@]} -eq 0 ]; then
    ok "couvre toutes les adresses IPv4 locales"
  else
    warn "ne couvre pas : ${MISSING[*]}"
    fix "si la machine a changé d'adresse, régénérez : npm run cert"
  fi

  ISSUER="$(openssl x509 -in certs/cert.pem -noout -issuer 2>/dev/null || true)"
  SUBJECT="$(openssl x509 -in certs/cert.pem -noout -subject 2>/dev/null || true)"
  if [ "${ISSUER#issuer=}" = "${SUBJECT#subject=}" ]; then
    info "certificat AUTO-SIGNÉ : le navigateur affichera un avertissement à accepter"
    fix "sans aucun avertissement : Tailscale (docs/HTTPS-TAILSCALE.md)"
  else
    info "certificat émis par une autorité (${ISSUER#issuer=})"
  fi
fi

head_ "Réseau"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo 8080)"
PORT="${PORT:-8080}"
if command -v ss >/dev/null 2>&1; then
  # Même précaution que pour ffmpeg : pas de `| grep -q` sous pipefail.
  LISTENING="$(ss -tln 2>/dev/null || true)"
  if grep -q ":${PORT} " <<<"$LISTENING"; then
    warn "le port $PORT est déjà occupé"
    fix "un autre 'npm start' tourne peut-être déjà"
  else
    ok "port $PORT libre"
  fi
fi

if command -v ip >/dev/null 2>&1; then
  echo "  adresses locales :"
  ip -4 -o addr show scope global 2>/dev/null | awk '{print "    " $2 "  " $4}'
fi

if command -v tailscale >/dev/null 2>&1; then
  if tailscale status >/dev/null 2>&1; then
    FQDN="$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).Self?.DNSName??"").replace(/\.$/,""))}catch{}})')"
    ok "Tailscale connecté${FQDN:+ : $FQDN}"
    if [ -f certs/cert.pem ]; then
      ok "certificat HTTPS présent (certs/cert.pem)"
    else
      fix "obtenez le certificat : bash scripts/tailscale-cert.sh"
    fi
  else
    warn "Tailscale installé mais non connecté"
    fix "sudo tailscale up"
  fi
else
  warn "Tailscale absent (facultatif)"
  fix "nécessaire seulement pour un HTTPS approuvé sans avertissement : docs/HTTPS-TAILSCALE.md"
fi

head_ "Résultat"
printf '  %d vérification(s) OK, %d avertissement(s), %d problème(s)\n\n' "$OK" "$WARN" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  printf '  \033[32mPrêt.\033[0m Lancez : npm start\n'
  printf '  (ou sans caméra, pour tester : npm run test-source)\n\n'
else
  printf '  \033[31mCorrigez les points ❌ ci-dessus, puis relancez ce diagnostic.\033[0m\n\n'
fi
exit 0
