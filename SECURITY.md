# Security

Argo is meant to run **inside a trusted local network** (typically a Proxmox container or a home server). Do not expose it directly to the internet.

- Camera credentials are stored in clear text in `cameras.json` and `go2rtc.yaml` inside the data folder (file mode 600). Never commit or share the data folder.
- Put cameras and server on a dedicated network/VLAN and use HTTPS (self-signed certificate generated at install time, or a reverse proxy with a real certificate).
- Faces, vehicles and pets are processed **locally**; nothing is sent to a cloud service. The only cloud access is the one-time Eufy login (`tools/eufy-login`) that reads your account id and device keys.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository (Security → Report a vulnerability) instead of a public issue.
