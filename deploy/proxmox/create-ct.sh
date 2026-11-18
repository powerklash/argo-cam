#!/usr/bin/env bash
# Argo — crea il contenitore (CT) su Proxmox VE e vi installa l'ambiente (ed eventualmente l'app).
# Va eseguito come root sull'HOST Proxmox, con install.sh nella stessa cartella (o in ../install.sh).
#
#   bash create-ct.sh                                   CT con valori predefiniti, solo ambiente
#   bash create-ct.sh --tarball cam-app.tar.gz          ... e installa anche l'app
#
# Opzioni (tra parentesi il predefinito):
#   --ctid N          (primo ID libero)        --name NOME   (cam-app)
#   --cores N (2)  --memory MB (2048)  --swap MB (512)  --disk GB (32)
#   --storage NOME    (local-lvm)              --template-storage NOME (local)
#   --bridge NOME     (vmbr0)                  --vlan TAG    (nessuno)
#   --ip dhcp|CIDR    (dhcp)  es. 192.168.1.90/24     --gw IP    --dns IP
#   --pubkey FILE     chiave SSH pubblica da autorizzare per root nel CT
#   --with-models  --with-eufy-login  --no-tls     (passate a install.sh)
set -euo pipefail

CTID="" NAME=cam-app CORES=2 MEMORY=2048 SWAP=512 DISK=32 STORAGE=local-lvm TSTORAGE=local
BRIDGE=vmbr0 VLAN="" IP=dhcp GW="" DNS="" PUBKEY="" TARBALL="" INSTALL_ARGS=()

die() { printf '\033[1;31mErrore:\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ctid) CTID="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --cores) CORES="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    --swap) SWAP="$2"; shift 2 ;;
    --disk) DISK="$2"; shift 2 ;;
    --storage) STORAGE="$2"; shift 2 ;;
    --template-storage) TSTORAGE="$2"; shift 2 ;;
    --bridge) BRIDGE="$2"; shift 2 ;;
    --vlan) VLAN="$2"; shift 2 ;;
    --ip) IP="$2"; shift 2 ;;
    --gw) GW="$2"; shift 2 ;;
    --dns) DNS="$2"; shift 2 ;;
    --pubkey) PUBKEY="$2"; shift 2 ;;
    --tarball) TARBALL="$2"; shift 2 ;;
    --with-models|--with-eufy-login|--no-tls) INSTALL_ARGS+=("$1"); shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) die "opzione sconosciuta: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "va eseguito come root"
command -v pct >/dev/null || die "pct non trovato: questo script va lanciato sull'host Proxmox"
here="$(cd "$(dirname "$0")" && pwd)"
INSTALL="$here/install.sh"; [ -f "$INSTALL" ] || INSTALL="$here/../install.sh"
[ -f "$INSTALL" ] || die "install.sh non trovato accanto allo script"
[ -z "$TARBALL" ] || [ -f "$TARBALL" ] || die "file non trovato: $TARBALL"
[ "$IP" = dhcp ] || [ -n "$GW" ] || die "con un IP fisso serve anche --gw"

[ -n "$CTID" ] || CTID="$(pvesh get /cluster/nextid)"
if pct status "$CTID" >/dev/null 2>&1 || qm status "$CTID" >/dev/null 2>&1; then die "l'ID $CTID è già in uso"; fi

# ---------- modello Debian ----------
TEMPLATE="$(pveam list "$TSTORAGE" 2>/dev/null | awk '{print $1}' | grep -E 'vztmpl/debian-1[23]-standard' | sort -V | tail -n1 | sed 's#.*/##')"
if [ -z "$TEMPLATE" ]; then
  log "Scarico il modello Debian"
  pveam update >/dev/null
  TEMPLATE="$(pveam available --section system | awk '{print $2}' | grep -E '^debian-1[23]-standard' | sort -V | tail -n1)"
  [ -n "$TEMPLATE" ] || die "nessun modello Debian disponibile"
  pveam download "$TSTORAGE" "$TEMPLATE"
fi
log "Modello: $TSTORAGE:vztmpl/$TEMPLATE"

# ---------- rete ----------
NET="name=eth0,bridge=$BRIDGE,firewall=0,ip=$IP"
[ -z "$GW" ] || NET="$NET,gw=$GW"
[ -z "$VLAN" ] || NET="$NET,tag=$VLAN"

args=(--hostname "$NAME" --cores "$CORES" --memory "$MEMORY" --swap "$SWAP" --rootfs "$STORAGE:$DISK"
  --net0 "$NET" --unprivileged 1 --features nesting=1 --onboot 1 --ostype debian --tags camapp)
[ -z "$DNS" ] || args+=(--nameserver "$DNS")
[ -z "$PUBKEY" ] || args+=(--ssh-public-keys "$PUBKEY")

log "Creo il CT $CTID ($NAME): $CORES core, $MEMORY MB RAM, $DISK GB su $STORAGE, rete $NET"
pct create "$CTID" "$TSTORAGE:vztmpl/$TEMPLATE" "${args[@]}"
pct start "$CTID"

log "Attendo la rete del CT"
CT_IP=""
for _ in $(seq 1 60); do
  CT_IP="$(pct exec "$CTID" -- ip -4 -o addr show dev eth0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1 || true)"
  [ -n "$CT_IP" ] && break
  sleep 2
done
[ -n "$CT_IP" ] || die "il CT non ha ottenuto un indirizzo IP (controlla bridge/VLAN/DHCP)"
for _ in $(seq 1 30); do pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break; sleep 2; done
log "Il CT ha l'indirizzo $CT_IP"

# ---------- installazione dentro il CT ----------
pct push "$CTID" "$INSTALL" /root/install.sh --perms 755
run_args=("${INSTALL_ARGS[@]}")
if [ -n "$TARBALL" ]; then
  pct push "$CTID" "$TARBALL" /root/cam-app.tar.gz
  run_args+=(--tarball /root/cam-app.tar.gz)
else
  run_args+=(--env-only)
fi
log "Eseguo install.sh nel CT"
pct exec "$CTID" -- bash /root/install.sh "${run_args[@]}"

echo
echo "CT $CTID pronto, indirizzo $CT_IP."
[ "$IP" != dhcp ] || echo "L'IP arriva dal DHCP: riservalo sul router (MAC: $(pct config "$CTID" | grep -oE 'hwaddr=[0-9A-Fa-f:]+' | cut -d= -f2)) perché non cambi."
