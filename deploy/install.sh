#!/usr/bin/env bash
# Argo — installazione (o aggiornamento) su Debian/Ubuntu. Pensata per un CT Proxmox,
# va lanciata come root DENTRO il contenitore.
#
#   bash install.sh --env-only                       solo l'ambiente (Node, ffmpeg, go2rtc, utente, servizio)
#   bash install.sh --tarball cam-app.tar.gz         ambiente + app (anche per aggiornare: i dati restano)
#   opzioni:  --with-models        scarica i modelli del riconoscimento volti/mezzi (~75 MB)
#             --with-eufy-login    installa lo strumento di accesso Eufy (tools/eufy-login)
#             --no-tls             non crea il certificato HTTPS autofirmato (es. dietro un reverse proxy)
#
# Variabili: APP_DIR (/opt/cam-app), DATA_DIR (/var/lib/cam-app), NODE_MAJOR (22), GO2RTC_VERSION (1.9.15)
set -euo pipefail

# Dentro un CT, "pct exec" parte con un PATH ridotto e senza lingua: si impostano a mano.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export LC_ALL=C.UTF-8 LANG=C.UTF-8

APP_DIR="${APP_DIR:-/opt/cam-app}"
DATA_DIR="${DATA_DIR:-/var/lib/cam-app}"
CONF_DIR=/etc/cam-app
ENV_FILE=/etc/cam-app.env
SVC_USER=camapp
NODE_MAJOR="${NODE_MAJOR:-22}"
GO2RTC_VERSION="${GO2RTC_VERSION:-1.9.15}"

TARBALL=""
ENV_ONLY=0
WITH_MODELS=0
WITH_EUFY=0
TLS=1

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mErrore:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --tarball) TARBALL="${2:?manca il file}"; shift 2 ;;
    --env-only) ENV_ONLY=1; shift ;;
    --with-models) WITH_MODELS=1; shift ;;
    --with-eufy-login) WITH_EUFY=1; shift ;;
    --no-tls) TLS=0; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "opzione sconosciuta: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "va eseguito come root"
command -v apt-get >/dev/null || die "serve un sistema Debian/Ubuntu (apt)"
[ -z "$TARBALL" ] || [ -f "$TARBALL" ] || die "file non trovato: $TARBALL"
[ -n "$TARBALL" ] || ENV_ONLY=1

case "$(uname -m)" in
  x86_64) NODE_ARCH=x64; GO_ARCH=amd64 ;;
  aarch64) NODE_ARCH=arm64; GO_ARCH=arm64 ;;
  *) die "architettura non supportata: $(uname -m)" ;;
esac

# ---------- 1. pacchetti ----------
log "Pacchetti di sistema (ffmpeg, openssl, curl…)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils ffmpeg openssl tar procps iproute2 smbclient >/dev/null

# ---------- 2. Node.js (serve la versione con node:sqlite senza opzioni: >= 22.13) ----------
node_ok() {
  command -v node >/dev/null || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null
}
if node_ok; then
  log "Node.js già presente: $(node -v)"
else
  log "Scarico Node.js ${NODE_MAJOR}.x da nodejs.org (verifica SHA-256)"
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  sums="$(curl -fsSL "$base/SHASUMS256.txt")"
  line="$(printf '%s\n' "$sums" | grep -E " node-v[0-9.]+-linux-${NODE_ARCH}\.tar\.xz$" | head -n1)"
  [ -n "$line" ] || die "pacchetto Node.js non trovato in $base"
  sha="${line%% *}"; file="${line##* }"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/$file" "$base/$file"
  (cd "$tmp" && printf '%s  %s\n' "$sha" "$file" | sha256sum -c - >/dev/null) || die "SHA-256 di Node.js non corrisponde"
  tar -xJf "$tmp/$file" -C /usr/local --strip-components=1 --no-same-owner --exclude='*.md' --exclude='LICENSE'
  rm -rf "$tmp"
  node_ok || die "installazione di Node.js non riuscita"
  log "Node.js installato: $(node -v)"
fi

# ---------- 3. utente di servizio e cartelle ----------
if ! id "$SVC_USER" >/dev/null 2>&1; then
  log "Creo l'utente di servizio '$SVC_USER'"
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SVC_USER"
fi
mkdir -p "$APP_DIR/bin" "$DATA_DIR" "$CONF_DIR"
chown "$SVC_USER":"$SVC_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# ---------- 4. go2rtc ----------
go2rtc_version() { "$APP_DIR/bin/go2rtc" -version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true; }
if [ -x "$APP_DIR/bin/go2rtc" ] && [ "$(go2rtc_version)" = "$GO2RTC_VERSION" ]; then
  log "go2rtc ${GO2RTC_VERSION} già presente"
else
  log "Scarico go2rtc ${GO2RTC_VERSION} da GitHub"
  url="https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/go2rtc_linux_${GO_ARCH}"
  tmp="$(mktemp)"
  curl -fsSL -o "$tmp" "$url"
  # Se GitHub pubblica l'impronta del file, la si controlla.
  want="$(curl -fsSL "https://api.github.com/repos/AlexxIT/go2rtc/releases/tags/v${GO2RTC_VERSION}" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s).assets.find(x=>x.name===process.argv[1]);console.log((a&&a.digest||"").replace("sha256:",""))}catch{console.log("")}})' "go2rtc_linux_${GO_ARCH}" || true)"
  got="$(sha256sum "$tmp" | cut -d' ' -f1)"
  if [ -n "$want" ] && [ "$want" != "$got" ]; then rm -f "$tmp"; die "SHA-256 di go2rtc non corrisponde"; fi
  [ -n "$want" ] || warn "impronta di go2rtc non verificabile (GitHub non l'ha fornita): sha256 = $got"
  install -m 0755 "$tmp" "$APP_DIR/bin/go2rtc"
  rm -f "$tmp"
  log "go2rtc installato (sha256 $got)"
fi

# ---------- 5. app ----------
if [ "$ENV_ONLY" -eq 0 ]; then
  log "Installo l'app da $TARBALL"
  systemctl stop cam-app 2>/dev/null || true
  for item in lib public tools deploy server.js package.json package-lock.json; do rm -rf "${APP_DIR:?}/$item"; done
  tar -xzf "$TARBALL" -C "$APP_DIR"
  (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
  if [ "$WITH_EUFY" -eq 1 ] && [ -f "$APP_DIR/tools/eufy-login/package.json" ]; then
    log "Installo lo strumento di accesso Eufy"
    (cd "$APP_DIR/tools/eufy-login" && npm install --omit=dev --no-audit --no-fund --loglevel=error)
  fi
  chown -R root:root "$APP_DIR"
  chmod 755 "$APP_DIR/bin/go2rtc"
  # Dati di installazioni precedenti: solo il proprietario li legge (database, credenziali delle telecamere).
  find "$DATA_DIR" -maxdepth 1 -type f -exec chmod 600 {} + 2>/dev/null || true
  if [ "$WITH_MODELS" -eq 1 ]; then
    log "Scarico i modelli di riconoscimento (~75 MB, SHA-256 verificato)"
    runuser -u "$SVC_USER" -- env DATA_DIR="$DATA_DIR" node "$APP_DIR/tools/get-models.mjs"
  fi
fi

# ---------- 6. indirizzo del contenitore e HTTPS ----------
IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
[ -n "$IP" ] || IP="$(hostname -I | awk '{print $1}')"

if [ "$TLS" -eq 1 ]; then
  # Autorità locale (10 anni, da installare una volta sui dispositivi) + certificato del server (800 giorni, con
  # serverAuth e SAN: è ciò che iPhone/iPad e Chrome richiedono). Lo script gira anche a ogni avvio del servizio e
  # rinnova il certificato del server se sta per scadere o se l'indirizzo IP è cambiato.
  cat > /usr/local/bin/cam-app-certs <<'CERTS'
#!/bin/bash
set -e
CONF=/etc/cam-app
SVC=camapp
mkdir -p "$CONF"; cd "$CONF"
if [ ! -f ca.crt ] || [ ! -f ca.key ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Cam App CA" -sha256 \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -keyout ca.key -out ca.crt 2>/dev/null
  chmod 600 ca.key
fi
ips="$(hostname -I | tr ' ' '\n' | grep -E '^[0-9]+\.' || true)"
san="DNS:$(hostname),DNS:cam-app,DNS:localhost,IP:127.0.0.1"
for a in $ips; do san="$san,IP:$a"; done
need=0
[ -f tls.crt ] && [ -f tls.key ] || need=1
if [ $need -eq 0 ]; then
  openssl x509 -checkend $((30*86400)) -noout -in tls.crt >/dev/null || need=1
  openssl verify -CAfile ca.crt tls.crt >/dev/null 2>&1 || need=1
  for a in $ips; do openssl x509 -in tls.crt -noout -ext subjectAltName 2>/dev/null | grep -q "$a" || need=1; done
fi
if [ $need -eq 1 ]; then
  openssl req -newkey rsa:2048 -nodes -subj "/CN=cam-app" -keyout tls.key -out tls.csr 2>/dev/null
  printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n' "$san" > ext.cnf
  openssl x509 -req -in tls.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 800 -sha256 -extfile ext.cnf -out tls.crt 2>/dev/null
  rm -f tls.csr ext.cnf ca.srl
fi
chown root:"$SVC" tls.key tls.crt ca.crt
chmod 640 tls.key; chmod 644 tls.crt ca.crt
CERTS
  chmod 755 /usr/local/bin/cam-app-certs
  log "Preparo i certificati HTTPS (autorità locale + server)"
  /usr/local/bin/cam-app-certs
fi

# ---------- 7. configurazione ----------
if [ ! -f "$ENV_FILE" ]; then
  log "Scrivo $ENV_FILE"
  {
    echo "NODE_ENV=production"
    echo "HOST=0.0.0.0"
    echo "PORT=8780"
    echo "DATA_DIR=$DATA_DIR"
    echo "GO2RTC_BIN=$APP_DIR/bin/go2rtc"
    echo "# Indirizzo con cui i client raggiungono il video WebRTC (UDP/TCP 8555). Cambialo se l'IP cambia."
    echo "WEBRTC_CANDIDATES=$IP:8555"
    if [ -f "$CONF_DIR/tls.crt" ]; then
      echo "TLS_CERT=$CONF_DIR/tls.crt"
      echo "TLS_KEY=$CONF_DIR/tls.key"
    fi
    echo "# Dietro un reverse proxy che inoltra X-Forwarded-*: TRUST_PROXY=1"
    echo "#TRUST_PROXY=1"
  } > "$ENV_FILE"
  chmod 640 "$ENV_FILE"; chown root:"$SVC_USER" "$ENV_FILE"
fi

# Chiave con cui l'app cifra i segreti a riposo (credenziali delle telecamere, token): sta qui, fuori dalla cartella dei
# dati, così una copia dei dati da sola non basta per leggerli. Non perderla: senza, le telecamere vanno reinserite.
if ! grep -q '^CAMAPP_SECRET_KEY=' "$ENV_FILE"; then
  log "Genero la chiave per cifrare i segreti in $ENV_FILE"
  echo "CAMAPP_SECRET_KEY=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> "$ENV_FILE"
fi

# Con HTTPS: certificato da scaricare = autorità locale; la porta 80 reindirizza a https (chi scrive solo l'indirizzo).
if [ -f "$CONF_DIR/tls.crt" ]; then
  grep -q '^CERT_DOWNLOAD=' "$ENV_FILE" || echo "CERT_DOWNLOAD=$CONF_DIR/ca.crt" >> "$ENV_FILE"
  grep -q '^HTTP_REDIRECT_PORT=' "$ENV_FILE" || echo "HTTP_REDIRECT_PORT=80" >> "$ENV_FILE"
fi

# Riavvio del sistema richiesto dall'app (solo amministratore): l'app, che non ha privilegi, crea un file; questa unità,
# che gira come root, lo vede, lo cancella e riavvia il contenitore.
grep -q '^REBOOT_HELPER=' "$ENV_FILE" || echo "REBOOT_HELPER=1" >> "$ENV_FILE"
cat > /etc/systemd/system/cam-app-reboot.path <<EOF
[Unit]
Description=Richiesta di riavvio del sistema da Argo

[Path]
PathExists=$DATA_DIR/reboot-request

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/cam-app-reboot.service <<EOF
[Unit]
Description=Riavvio del sistema richiesto da Argo

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'rm -f $DATA_DIR/reboot-request; sleep 2; exec /usr/bin/systemctl reboot'
EOF

PRE_LINES=""
[ -x /usr/local/bin/cam-app-certs ] && PRE_LINES="ExecStartPre=+/usr/local/bin/cam-app-certs"
cat > /etc/systemd/system/cam-app.service <<EOF
[Unit]
Description=Argo (telecamere, eventi, accessi)
After=network-online.target
Wants=network-online.target

[Service]
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
# Cartella di lavoro in memoria (/run/cam-app): ci va la configurazione di go2rtc, con le credenziali, solo per l'avvio.
RuntimeDirectory=cam-app
RuntimeDirectoryMode=0700
$PRE_LINES
AmbientCapabilities=CAP_NET_BIND_SERVICE
ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning server.js
Restart=on-failure
RestartSec=5
KillMode=control-group
NoNewPrivileges=yes
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable cam-app >/dev/null 2>&1
systemctl enable --now cam-app-reboot.path >/dev/null 2>&1

if [ -f "$APP_DIR/server.js" ]; then
  log "Avvio il servizio"
  systemctl restart cam-app
  sleep 3
  systemctl is-active --quiet cam-app && log "Servizio attivo" || warn "il servizio non è partito: journalctl -u cam-app -n 50"
else
  log "Ambiente pronto. Il servizio partirà dopo l'installazione dell'app (--tarball)."
fi

scheme=http; [ -f "$CONF_DIR/tls.crt" ] && grep -q '^TLS_CERT=' "$ENV_FILE" && scheme=https
echo
echo "================ Argo ================"
echo " Indirizzo:        $scheme://$IP:8780"
echo " Dati:             $DATA_DIR   (cameras.json, cam-app.db, eventi, modelli)"
echo " Configurazione:   $ENV_FILE"
echo " Log:              journalctl -u cam-app -f"
if [ "$ENV_ONLY" -eq 0 ]; then
  echo " Primo accesso:    utente 'admin'; la password iniziale è in $DATA_DIR/first-run-admin.txt"
  echo "                   (viene chiesto di cambiarla al primo ingresso)"
fi
echo " Porte da aprire:  8780/tcp (interfaccia) e 8555/tcp+udp (video WebRTC)"
echo "========================================="
