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
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

head_ "Système"
if [ -r /proc/sys/kernel/osrelease ]; then
  KERNEL="$(cat /proc/sys/kernel/osrelease)"
  echo "  noyau : $KERNEL"
  if echo "$KERNEL" | grep -qiE 'microsoft|wsl'; then
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
  ENCS="$(grep -oE '\bh264_(vaapi|nvenc|qsv|amf)\b' <<<"$FFMPEG_ENCODERS" | sort -u | tr '\n' ' ')"
  if grep -q '\blibx264\b' <<<"$FFMPEG_ENCODERS"; then
    echo "    - libx264 (logiciel) — toujours présent, suffisant"
  else
    bad "libx264 absent : c'est l'encodeur de repli, il est indispensable"
    fix "sudo apt install ffmpeg"
  fi
  if [ -n "$ENCS" ]; then
    echo "    - $ENCS(matériel — peut réduire la charge CPU et la latence)"
    fix "testez : ENCODER=h264_vaapi npm start (voir docs/LINUX.md)"
  else
    echo "    (aucun encodeur matériel : normal avec un ffmpeg statique ou un CPU sans iGPU)"
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
