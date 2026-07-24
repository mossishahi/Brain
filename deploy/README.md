# DigitalOcean deployment

Target: Ubuntu at `167.172.170.154`.

## Runtime layout

- repository: `/opt/brain-registry`
- service user: `brain-registry`
- origin: `127.0.0.1:51011`
- public MCP endpoint: `https://167.172.170.154/mcp`
- TLS edge: Caddy 2.10.1+ with Let's Encrypt `shortlived` IP certificates

## First installation

Run as an administrator:

```bash
apt-get update
apt-get install -y ca-certificates curl debian-keyring debian-archive-keyring \
  apt-transport-https git ufw

# Install Node.js 22 LTS using the approved distribution repository.
# Install Caddy 2.10.1+ from Caddy's official Debian repository.

useradd --system --home /opt/brain-registry --shell /usr/sbin/nologin \
  brain-registry
git clone https://github.com/mossishahi/Brain.git /opt/brain-registry
cd /opt/brain-registry
npm ci
npm run build
chown -R brain-registry:brain-registry /opt/brain-registry

install -m 0644 deploy/brain-registry.service \
  /etc/systemd/system/brain-registry.service
install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile

systemctl daemon-reload
systemctl enable --now brain-registry
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw deny 51011/tcp
ufw --force enable
```

Never expose port 51011 publicly. Port 80 exists only for ACME HTTP validation and redirects;
all content traffic uses HTTPS.

## Update

```bash
cd /opt/brain-registry
git fetch origin
git checkout main
git pull --ff-only
npm ci
npm run build
chown -R brain-registry:brain-registry /opt/brain-registry
systemctl restart brain-registry
curl --fail http://127.0.0.1:51011/health
curl --fail https://167.172.170.154/health
```

## Diagnostics

```bash
systemctl status brain-registry caddy
journalctl -u brain-registry -n 200 --no-pager
journalctl -u caddy -n 200 --no-pager
ss -ltnp
ufw status verbose
```
