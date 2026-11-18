# Argo

*[Leggi in italiano](README.it.md)*

A **local-first multi-camera viewer** for PC and phone. Watch Reolink, Eufy (local P2P, no cloud video), ONVIF and plain RTSP cameras on one screen, with events, alerts, smart search and on-device recognition of people, pets and vehicles. Everything stays on your network.

> The internal service/package is still called `cam-app` (folders, systemd unit `cam-app`, user `camapp`).

## Features

- **Live view** of many cameras (WebRTC through [go2rtc](https://github.com/AlexxIT/go2rtc)), responsive UI for phone and desktop, installable as a home-screen app, 5 languages (it, en, fr, de, es).
- **Brands**: Reolink (direct or through a Home Hub, including battery cameras), Eufy over local P2P (no RTSP needed, battery cameras can be woken on request where the model allows it), ONVIF, generic RTSP/HTTP.
- **Events** (motion, person, vehicle, pet, package, doorbell, fire, flood) with snapshot, clip and a lightweight H.264 preview for playback; the original clip stays at full quality for download.
- **Smart search** in natural language ("white cars last Tuesday evening").
- **Local recognition** (no cloud): faces, individual pets and individual vehicles get their own tab where you name them; new subjects that look like a known one are *suggested* for merging.
- **Red overlay box** that follows the subject in event clips (drawn on top of the video, can be switched off).
- **Fire / flood alerts** (heuristic checks on camera video, per camera, with siren and banner). They are approximate and **do not replace** a smoke or flood detector.
- **Network archive**: move old clips to SMB, WebDAV or a mounted folder while keeping them searchable and playable.
- **Users and permissions**: admin and per-camera *watch* / *control* levels, scrypt passwords, brute-force lockout, CSRF protection.
- Doorbell popup with two-way audio, Home Assistant icons/state (read-only token stored server side), battery level icons, certificate download page for phones.

## Quick start (Windows or Linux, for testing)

Requirements: Node.js 22+, ffmpeg in `PATH`, and the [go2rtc](https://github.com/AlexxIT/go2rtc/releases) binary in `bin/` (`go2rtc.exe` / `go2rtc`).

```bash
npm install
node tools/get-models.mjs   # optional: recognition models (~100 MB)
node server.js              # http://localhost:8780
```

On first start an `admin` user is created with a random password, printed in the log and written to `data/first-run-admin.txt` (deleted after you change it). You can also set `ADMIN_USERNAME` / `ADMIN_PASSWORD` before the first start. `start.bat` launches it on Windows.

## Install on Proxmox (recommended)

You need a Proxmox VE host on the same layer-2 network as the cameras (needed for Eufy discovery) and internet access.

1. Build the package on your PC: `powershell -File deploy\pack.ps1` → `dist\cam-app.tar.gz`
2. Copy the package and the `deploy` folder to the Proxmox host (`scp`).
3. On the host, as root:

   ```bash
   bash deploy/proxmox/create-ct.sh --tarball cam-app.tar.gz --ip dhcp
   # static IP: --ip 192.168.1.90/24 --gw 192.168.1.1     VLAN: --vlan 20
   # other options: --ctid, --cores, --memory, --disk, --storage, --bridge, --pubkey FILE, --with-models, --with-eufy-login
   ```

   It creates an unprivileged Debian container (2 cores, 2 GB RAM, 32 GB disk), installs Node 22, ffmpeg, go2rtc, a self-signed HTTPS certificate and the `cam-app` service, then prints the address.
4. Open `https://CT-IP:8780` (accept the self-signed certificate once; the *Certificate* page helps install it on phones).

**Ports**: `8780/tcp` (UI) and `8555/tcp+udp` (WebRTC). If clients are on another network make sure 8555 is reachable, otherwise video falls back to a heavier HTTP stream. `WEBRTC_CANDIDATES` in `/etc/cam-app.env` must hold the CT address.

**Update**: build a new package, copy it into the container and run `bash /root/install.sh --tarball /root/cam-app.tar.gz`. Data in `/var/lib/cam-app` is kept. Take a Proxmox snapshot first.

**Data and backup**: everything lives in `/var/lib/cam-app` (`cameras.json` with camera credentials, `cam-app.db`, `settings.json`, `eufy-account.json`, `events/`, `models/`). Never share these files.

## Eufy cameras

Eufy video and settings are read locally over P2P. A **one-time cloud login** is needed to read your account id and device keys:

```bash
cd tools/eufy-login && npm install
EUFY_CIPHERS="<serial>=<cipherId>,..." DATA_DIR=/var/lib/cam-app node login.mjs
```

You type the credentials in your terminal; they are not stored. Use `node tools/eufy-discover.js` to find cameras and their cipher IDs on the LAN. Battery cameras (SoloCam) sleep: the app sends discovery packets until they answer and connects immediately; some models (for example the S340) cannot be woken without the Eufy app or motion.

## Configuration (environment variables)

| Variable | Meaning |
|---|---|
| `DATA_DIR` | data folder (default `./data`) |
| `HOST`, `PORT` | listen address/port (defaults `127.0.0.1`, `8780`; `0.0.0.0` in the container) |
| `TLS_CERT`, `TLS_KEY` | certificate and key for HTTPS |
| `TRUST_PROXY=1` | trust `X-Forwarded-*` (behind a reverse proxy; also forward WebSockets) |
| `WEBRTC_CANDIDATES` | `IP:8555` clients use to reach WebRTC |
| `GO2RTC_BIN` | path to go2rtc |
| `INTERNAL_PORT` | loopback port for the Eufy stream (default `PORT+1`) |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | first-start admin |

Microphone (doorbell talk-back) and browser notifications require HTTPS.

## Known limits

- Device error messages are in Italian; the UI itself is translated.
- Camera credentials are stored in clear text (file mode 600): keep cameras and server on a dedicated network.
- Eufy H.265 cameras (S340) need a browser that decodes H.265.
- Fire/flood detection is heuristic; recognition accuracy depends on camera quality and thresholds (adjustable in Settings).

See [SECURITY.md](SECURITY.md) and [THIRD_PARTY.md](THIRD_PARTY.md). Licensed under the [MIT License](LICENSE).
