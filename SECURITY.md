# Security

Argo is meant to run **inside a trusted local network** (typically a Proxmox container or a home server). Do not expose it directly to the internet.

- Secrets are **encrypted at rest** (AES-256-GCM): the `params` (addresses, usernames, passwords, stream URLs) of every camera in `cameras.json`, the Home Assistant token, the archive password and the Eufy account/session/wake files. The key is **not** in the data folder: the Proxmox installer generates `CAMAPP_SECRET_KEY` in `/etc/cam-app.env`; elsewhere set `CAMAPP_SECRET_KEY` (or `CAMAPP_KEY_FILE`), otherwise a `secret.key` file is created next to the data (weaker: a copy of the data folder would include it). **Back the key up**: without it the encrypted secrets cannot be read and cameras must be re-entered. The app refuses to start (without touching the files) if the key does not match. Existing clear-text files are encrypted automatically on first start.
- The go2rtc configuration (which needs the camera URLs in clear) is written only to a private runtime folder (`/run/cam-app`, in memory, with the systemd unit) and deleted as soon as go2rtc has read it; it never stays in the data folder. Credentials are still visible in memory and in the command lines of the processes of the container, so treat anyone with access to the container as an administrator.
- Never commit or share the data folder, and keep the key apart from backups of it.
- Put cameras and server on a dedicated network/VLAN and use HTTPS (self-signed certificate generated at install time, or a reverse proxy with a real certificate).
- Faces, vehicles and pets are processed **locally**; nothing is sent to a cloud service. The only cloud access is the one-time Eufy login (`tools/eufy-login`) that reads your account id and device keys.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository (Security → Report a vulnerability) instead of a public issue.
