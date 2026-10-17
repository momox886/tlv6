#!/usr/bin/env bash
# Génère un certificat TLS auto-signé pour servir la page en HTTPS.
#
# Pourquoi HTTPS ? WebXR et WebCodecs ne fonctionnent que dans un « contexte
# sécurisé ». `localhost` en est un ; une adresse IP de réseau local, non. Deux
# solutions :
#   1. HTTPS avec certificat auto-signé (ce script) : le navigateur affiche un
#      avertissement qu'il faut accepter une fois ;
#   2. autoriser l'origine en clair via chrome://flags sur le casque.
#
# Pour un HTTPS SANS aucun avertissement, il faut un certificat réellement
# approuvé : soit Tailscale (scripts/tailscale-cert.sh), soit une autorité locale
# installée dans le magasin de confiance (outil `mkcert`). Voir docs/LINUX.md.
#
# Usage :
#   bash scripts/gen-cert.sh                 # couvre toutes les adresses locales
#   bash scripts/gen-cert.sh 172.16.117.95   # couvre uniquement cette adresse
#
# Le dossier certs/ est ignoré par git : la clé privée ne sera jamais publiée.
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p certs

# --- Adresses à couvrir ----------------------------------------------------
# On prend TOUTES les adresses IPv4 locales par défaut : selon le mode réseau
# (NAT, « mirrored », VPN, plusieurs cartes), l'adresse utile change, et
# régénérer le certificat à chaque bascule est pénible.
IPS=()
if [ "${1:-}" != "" ]; then
  IPS+=("$1")
else
  while IFS= read -r ip; do
    [ -n "$ip" ] && IPS+=("$ip")
  done < <(
    hostname -I 2>/dev/null | tr ' ' '\n' |
      grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' |
      grep -v '^127\.' | grep -v '^169\.254\.' || true
  )
fi

# Le champ subjectAltName (SAN) est ce qui compte : le CN est ignoré par les
# navigateurs depuis 2017. On y met toujours les noms par lesquels on ouvre
# réellement la page : localhost (IPv4 ET IPv6), et le nom de la machine (utile
# en mDNS : http://<machine>.local, et pour Tailscale/MagicDNS).
DNS_NAMES=(localhost)
HOST_SHORT="$(hostname -s 2>/dev/null || true)"
HOST_FQDN="$(hostname -f 2>/dev/null || true)"
[ -n "$HOST_SHORT" ] && DNS_NAMES+=("$HOST_SHORT" "$HOST_SHORT".local)
[ -n "$HOST_FQDN" ] && DNS_NAMES+=("$HOST_FQDN")

SAN=""
for name in "${DNS_NAMES[@]}"; do SAN="${SAN:+$SAN,}DNS:${name}"; done
SAN="${SAN},IP:127.0.0.1,IP:::1"
for ip in "${IPS[@]}"; do SAN="${SAN},IP:${ip}"; done

# --- Génération ------------------------------------------------------------
# Un certificat feuille correct : ce n'est PAS une autorité, il sert uniquement
# au serveur TLS. Les attributs « critical » évitent les surprises selon les
# navigateurs.
echo "Génération du certificat (couvre : ${DNS_NAMES[*]} ${IPS[*]:-})"
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -sha256 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=${DNS_NAMES[0]}" \
  -addext "subjectAltName=${SAN}" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  2>/dev/null

# La clé privée n'appartient qu'à son propriétaire.
chmod 600 certs/key.pem certs/cert.pem

# --- Relecture : on affiche ce que le certificat contient VRAIMENT ----------
# (et pas seulement ce qu'on a demandé : c'est la relecture qui fait foi).
echo ""
echo "Certificat créé : certs/cert.pem / certs/key.pem"
echo ""
echo "Noms réellement couverts :"
openssl x509 -in certs/cert.pem -noout -ext subjectAltName \
  | tail -n +2 | tr ',' '\n' | sed 's/^ *//; s/^/  - /'
echo "Expire le : $(openssl x509 -in certs/cert.pem -noout -enddate | cut -d= -f2)"
echo ""
echo "Lancez ensuite  : TLS=1 npm start"
echo "Sur cet ordinateur : https://localhost:8080/"
for ip in "${IPS[@]}"; do
  echo "Depuis le casque    : https://${ip}:8080/vr.html  (acceptez l'avertissement)"
done
[ ${#IPS[@]} -gt 0 ] || echo "Depuis le casque    : (aucune IP locale détectée — relancez après connexion au réseau)"
