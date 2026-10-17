#!/usr/bin/env bash
# Installe (ou désinstalle) le flux comme service systemd.
#
#   sudo bash scripts/install-service.sh              # installer et démarrer
#   sudo bash scripts/install-service.sh --uninstall  # arrêter et supprimer
#   bash scripts/install-service.sh --print           # afficher l'unité, sans rien modifier
#
# Le service tourne en tant que VOTRE utilisateur (pas root) et reçoit en plus
# les groupes « video »/« render » : c'est ce qui donne l'accès à la caméra et,
# le cas échéant, au moteur d'encodage matériel — sans avoir à se reconnecter.
set -euo pipefail

SERVICE_NAME="stereo-vr-stream"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

info() { printf '  %s\n' "$1" >&2; }
die()  { printf '\033[31mErreur : %s\033[0m\n' "$1" >&2; exit 1; }

MODE="${1:-install}"
case "$MODE" in
  install|--uninstall|--print) ;;
  *) die "option inconnue : $MODE (attendu : --uninstall ou --print)" ;;
esac

# `--print` ne modifie rien : il ne requiert donc pas root.
[ "$MODE" = "--print" ] || [ "$(id -u)" -eq 0 ] || \
  die "ce script a besoin des droits root : sudo bash scripts/install-service.sh"

# --- Désinstallation --------------------------------------------------------
if [ "$MODE" = "--uninstall" ]; then
  info "Arrêt et suppression du service ${SERVICE_NAME}…"
  systemctl disable --now "${SERVICE_NAME}.service" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl daemon-reload
  systemctl reset-failed 2>/dev/null || true
  printf '\n\033[32mService supprimé.\033[0m Les fichiers du projet sont intacts.\n\n'
  exit 0
fi

# --- Détection de l'utilisateur et de Node ----------------------------------
# Sous sudo, $USER vaut root : on récupère l'utilisateur qui a lancé la commande.
RUN_USER="${SUDO_USER:-$(id -un)}"
[ "$RUN_USER" = "root" ] && die "lancez avec sudo depuis votre compte (pas depuis un shell root)"

RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
[ -n "$RUN_HOME" ] || die "répertoire personnel de $RUN_USER introuvable"

# On cherche node dans le PATH de l'utilisateur, puis aux emplacements habituels.
# `sudo -u` n'est tenté que si l'on est déjà root : sinon il demanderait un mot
# de passe, ce qui casserait le mode --print.
NODE_FROM_PATH=""
if [ "$(id -u)" -eq 0 ]; then
  NODE_FROM_PATH="$(sudo -u "$RUN_USER" bash -lc 'command -v node' 2>/dev/null || true)"
else
  NODE_FROM_PATH="$(command -v node 2>/dev/null || true)"
fi

NODE_BIN=""
for candidate in \
  "$NODE_FROM_PATH" \
  "$RUN_HOME/.local/node/bin/node" \
  /usr/local/bin/node \
  /usr/bin/node
do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
done
[ -n "$NODE_BIN" ] || die "node introuvable : installez Node.js 22 (https://nodejs.org/)"
info "node : $NODE_BIN ($("$NODE_BIN" -p 'process.versions.node'))"

[ -f "$PROJECT_DIR/server/index.js" ] || die "server/index.js introuvable dans $PROJECT_DIR"
[ -d "$PROJECT_DIR/node_modules" ] || info "⚠  node_modules absent → lancez d'abord « npm install » (dans $PROJECT_DIR)"

# --- Groupes supplémentaires réellement présents ----------------------------
# Les lister à l'aveugle ferait échouer le démarrage : systemd refuse un groupe
# qui n'existe pas.
EXTRA_GROUPS=()
for g in video render; do
  if getent group "$g" >/dev/null 2>&1; then EXTRA_GROUPS+=("$g"); fi
done
GROUPS_LINE=""
if [ ${#EXTRA_GROUPS[@]} -gt 0 ]; then
  GROUPS_LINE="SupplementaryGroups=${EXTRA_GROUPS[*]}"
fi
info "groupes supplémentaires : ${EXTRA_GROUPS[*]:-aucun}"

# --- Contenu de l'unité -----------------------------------------------------
UNIT_CONTENT="$(cat <<UNIT
[Unit]
Description=Flux stéréo VR faible latence (stereo-vr-stream)
Documentation=file://${PROJECT_DIR}/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=$(id -gn "$RUN_USER")
${GROUPS_LINE}
WorkingDirectory=${PROJECT_DIR}
ExecStart=${NODE_BIN} server/index.js
Restart=always
RestartSec=2

# Le serveur gère SIGTERM et arrête ffmpeg proprement : on lui laisse le temps.
TimeoutStopSec=10

# Le fichier .env est déjà lu par le serveur lui-même. Décommentez la ligne
# ci-dessous pour exposer en plus ces variables au service (systemctl show) :
#EnvironmentFile=-${PROJECT_DIR}/.env

# Journalisation : tout part dans le journal systemd (journalctl -u).
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
UNIT
)"

if [ "$MODE" = "--print" ]; then
  printf '%s\n' "$UNIT_CONTENT"
  exit 0
fi

info "écriture de $UNIT_PATH"
printf '%s\n' "$UNIT_CONTENT" > "$UNIT_PATH"

# --- Activation -------------------------------------------------------------
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"

sleep 1
printf '\n'
if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
  printf '\033[32mService démarré.\033[0m\n\n'
  systemctl status "${SERVICE_NAME}.service" --no-pager --lines=12 || true
  printf '\nCommandes utiles :\n'
  info "systemctl status ${SERVICE_NAME}"
  info "systemctl restart ${SERVICE_NAME}"
  info "journalctl -u ${SERVICE_NAME} -f     # suivre les journaux"
else
  printf '\033[31mLe service n'"'"'a pas démarré.\033[0m\n\n'
  journalctl -u "${SERVICE_NAME}.service" --no-pager --lines=30 || true
  exit 1
fi
printf '\n'
