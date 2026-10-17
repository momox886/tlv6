#!/usr/bin/env bash
# Récupère le certificat HTTPS délivré par Tailscale (Let's Encrypt) et le place
# dans certs/, là où le serveur l'attend.
#
# Pourquoi Tailscale plutôt qu'un certificat auto-signé : le navigateur du casque
# fait confiance à ce certificat sans aucun avertissement, donc WebXR démarre
# directement. C'est ce qui remplace le `npm run cert` auto-signé.
#
# PRÉ-REQUIS (à faire une seule fois) :
#   1. MagicDNS activé, puis « Enable HTTPS » dans la console d'administration
#      Tailscale (page DNS) ;
#   2. Tailscale connecté : `tailscale up` (ou l'application Windows).
#
# Usage :
#   bash scripts/tailscale-cert.sh            # détecte le nom de la machine
#   bash scripts/tailscale-cert.sh mon-pc.tailXXXX.ts.net
#
# Ensuite : TLS=1 npm start
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p certs

CERT="$PWD/certs/cert.pem"
KEY="$PWD/certs/key.pem"

# --- Localiser Tailscale ----------------------------------------------------
# Deux cas possibles : Tailscale installé dans WSL (recommandé pour un accès
# direct), ou sur l'hôte Windows (atteint depuis WSL via l'interopérabilité).
TS=""
WHERE=""
if command -v tailscale >/dev/null 2>&1; then
  TS="tailscale"
  WHERE="wsl"
elif [ -x "/mnt/c/Program Files/Tailscale/tailscale.exe" ]; then
  TS="/mnt/c/Program Files/Tailscale/tailscale.exe"
  WHERE="windows"
else
  echo "❌ Tailscale est introuvable." >&2
  echo "   Installez-le : https://tailscale.com/download" >&2
  exit 1
fi

echo "Tailscale détecté ($WHERE) : $TS"
echo

# --- Nom complet de la machine dans le tailnet ------------------------------
FQDN="${1:-}"
if [ -z "$FQDN" ]; then
  FQDN="$("$TS" status --json 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try { const j=JSON.parse(s); process.stdout.write(String(j.Self?.DNSName ?? "").replace(/\.$/,"")); }
      catch { process.stdout.write(""); }
    })')"
fi

if [ -z "$FQDN" ]; then
  echo "❌ Impossible de déterminer le nom Tailscale de cette machine." >&2
  echo "   Vérifiez que vous êtes connecté : $TS status" >&2
  echo "   Sinon, indiquez-le à la main : bash scripts/tailscale-cert.sh mon-pc.tailXXXX.ts.net" >&2
  exit 1
fi

echo "Machine  : $FQDN"

# --- Obtention du certificat ------------------------------------------------
if [ "$WHERE" = "wsl" ]; then
  # `tailscale cert` dialogue avec tailscaled, qui tourne en root.
  SUDO=""
  [ "$(id -u)" -ne 0 ] && SUDO="sudo"
  $SUDO "$TS" cert --cert-file="$CERT" --key-file="$KEY" "$FQDN"
else
  # Tailscale tourne sous Windows : les chemins d'arguments doivent être des
  # chemins Windows. On écrit dans un dossier temporaire Windows, puis on copie
  # le résultat dans le projet WSL.
  WINTMP="$(powershell.exe -NoProfile -Command '$env:TEMP' 2>/dev/null | tr -d '\r\n')"
  if [ -z "$WINTMP" ]; then
    echo "❌ Impossible de localiser le dossier temporaire Windows." >&2
    exit 1
  fi
  WSLTMP="/mnt/c$(echo "$WINTMP" | sed 's|^[A-Za-z]:||; s|\\|/|g')"
  mkdir -p "$WSLTMP"
  WIN_CERT="${WINTMP}\\stereo-cert.pem"
  WIN_KEY="${WINTMP}\\stereo-key.pem"

  if ! "$TS" cert --cert-file="$WIN_CERT" --key-file="$WIN_KEY" "$FQDN"; then
    echo >&2
    echo "❌ Échec de « tailscale cert »." >&2
    echo "   Causes fréquentes :" >&2
    echo "     • HTTPS n'est pas activé dans la console Tailscale (page DNS) ;" >&2
    echo "     • la fenêtre n'est pas en administrateur — réessayez dans un" >&2
    echo "       PowerShell « en tant qu'administrateur »." >&2
    exit 1
  fi

  cp "$WSLTMP/stereo-cert.pem" "$CERT"
  cp "$WSLTMP/stereo-key.pem" "$KEY"
  rm -f "$WSLTMP/stereo-cert.pem" "$WSLTMP/stereo-key.pem"
fi

chmod 600 "$CERT" "$KEY"

echo "Certificat installé : certs/cert.pem / certs/key.pem"
echo

# --- Vérification lisible ---------------------------------------------------
if command -v openssl >/dev/null 2>&1; then
  openssl x509 -in "$CERT" -noout -subject -dates -ext subjectAltName 2>/dev/null |
    sed 's/^/  /' || true
  echo
fi

echo "Lancez le serveur en HTTPS :"
echo "  TLS=1 npm start"
echo
echo "Puis, sur le casque :  https://${FQDN}/vr.html"
echo
echo "⚠  Certificat valable 90 jours. Relancez ce script avant expiration :"
echo "     bash scripts/tailscale-cert.sh"
