#!/usr/bin/env bash
# Liste les formats réellement proposés par la caméra (résolutions, fréquences,
# formats de pixel). C'est LA première commande à lancer : elle donne les valeurs
# exactes à mettre dans WIDTH/HEIGHT/FPS/INPUT_FORMAT.
#
# Prérequis (Debian/Ubuntu) : sudo apt install v4l-utils
set -euo pipefail

DEVICE="${1:-/dev/video0}"

if ! command -v v4l2-ctl >/dev/null 2>&1; then
  echo "v4l2-ctl est absent. Installez-le :" >&2
  echo "  sudo apt update && sudo apt install -y v4l-utils" >&2
  exit 1
fi

if [ ! -e "$DEVICE" ]; then
  echo "Périphérique introuvable : $DEVICE" >&2
  echo "Périphériques disponibles :" >&2
  ls -l /dev/video* 2>/dev/null || echo "  (aucun)" >&2
  echo "" >&2
  echo "Si la caméra est branchée sous Windows, rattachez-la à WSL :" >&2
  echo "  powershell -File scripts/attach-camera.ps1" >&2
  exit 1
fi

echo "== Formats supportés par $DEVICE =="
v4l2-ctl -d "$DEVICE" --list-formats-ext
