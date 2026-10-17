#!/usr/bin/env bash
# Génère un certificat TLS auto-signé pour servir la page en HTTPS.
#
# Pourquoi HTTPS ? WebXR et WebCodecs ne fonctionnent que dans un « contexte
# sécurisé ». localhost en est un ; une adresse IP de LAN, non. Deux solutions :
#   1. HTTPS avec certificat auto-signé (ce script) : il faudra accepter
#      l'avertissement dans le navigateur du casque ;
#   2. autoriser l'origine en clair via chrome://flags sur le casque.
#
# Usage :
#   bash scripts/gen-cert.sh                 # couvre toutes les IP locales
#   bash scripts/gen-cert.sh 172.16.117.95   # couvre uniquement cette IP
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p certs

# Adresses à couvrir. On prend TOUTES les adresses IPv4 locales par défaut :
# selon le mode réseau de WSL (NAT ou « mirrored »), l'adresse utile change, et
# régénérer un certificat à chaque bascule de réseau est pénible. Les couvrir
# toutes une fois pour toutes évite ce piège.
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
[ ${#IPS[@]} -eq 0 ] && IPS=("127.0.0.1")

# Le navigateur du casque se connecte par IP : c'est donc le champ
# subjectAltName (SAN) qui compte, pas le CN (ignoré par Chrome depuis 2017).
SAN="DNS:localhost,IP:127.0.0.1"
for ip in "${IPS[@]}"; do
  SAN="${SAN},IP:${ip}"
done

openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=${IPS[0]}" \
  -addext "subjectAltName=${SAN}"

# Clé lisible par l'utilisateur seulement (elle est privée).
chmod 600 certs/key.pem certs/cert.pem

echo "Certificat créé : certs/cert.pem / certs/key.pem"
echo "Adresses couvertes : ${IPS[*]}"
echo "Lancez ensuite   : TLS=1 npm start"
echo "Sur le casque    : https://<une des adresses ci-dessus>:8080/vr.html"
echo "                   (acceptez l'avertissement de certificat)"
