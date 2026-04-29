# Deploy Backend On Amazon Lightsail

This guide deploys the VPauto backend, SQLite database, and screenshot captures
on one Lightsail Ubuntu instance.

## 1. Create The Instance

Recommended starter size:

- Ubuntu 24.04 LTS
- 1 GB RAM / 40 GB disk for a comfortable MVP
- 512 MB RAM / 20 GB disk is OK for a first test, but add swap before building
- Static IP attached
- Firewall open on ports `22`, `80`, `443`

Point a DNS record to the static IP, for example:

```text
api.your-domain.com -> <LIGHTSAIL_STATIC_IP>
```

## 2. Install Server Packages

SSH into the instance, then run:

```bash
sudo apt update
sudo apt install -y git nginx certbot python3-certbot-nginx curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

On the 512 MB plan, add swap before running `npm ci`:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h
```

## 3. Clone And Build

```bash
sudo mkdir -p /var/www
sudo chown -R "$USER":"$USER" /var/www
cd /var/www
git clone https://github.com/Abderrahime/vpauto.git vpauto
cd vpauto
npm ci
npm run db:generate --workspace @vpauto/backend
npm run build --workspace @vpauto/shared
npm run build --workspace @vpauto/backend
```

## 4. Persistent Data

```bash
mkdir -p /var/www/vpauto-data/screenshots
chmod 700 /var/www/vpauto-data
```

Create the backend environment file:

```bash
nano /var/www/vpauto/.env.production
```

Example:

```bash
PORT=3456
DATABASE_URL=file:/var/www/vpauto-data/vpauto.db
VPAUTO_SCREENSHOT_DIR=/var/www/vpauto-data/screenshots
VPAUTO_ADMIN_EMAIL=you@example.com
VPAUTO_ADMIN_PASSWORD=change-me
VPAUTO_ADMIN_TOKEN=change-me-long-random-token
VPAUTO_AUTH_SECRET=change-me-long-random-secret
```

Initialize the database:

```bash
set -a
source /var/www/vpauto/.env.production
set +a
npm run db:push --workspace @vpauto/backend
```

## 5. Run With PM2

```bash
cd /var/www/vpauto
pm2 start "npm run start --workspace @vpauto/backend" --name vpauto-backend --env production
pm2 save
pm2 startup
```

Run the command printed by `pm2 startup`.

## 6. Nginx Reverse Proxy

Create:

```bash
sudo nano /etc/nginx/sites-available/vpauto-api
```

Config:

```nginx
server {
  listen 80;
  server_name api.your-domain.com;

  client_max_body_size 8m;

  location / {
    proxy_pass http://127.0.0.1:3456;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Enable it:

```bash
sudo ln -s /etc/nginx/sites-available/vpauto-api /etc/nginx/sites-enabled/vpauto-api
sudo nginx -t
sudo systemctl reload nginx
```

## 7. HTTPS

```bash
sudo certbot --nginx -d api.your-domain.com
```

Verify:

```bash
curl https://api.your-domain.com/api/health
```

## 8. Build The Public Extension

On your local machine:

```bash
VITE_VPAUTO_API_URL=https://api.your-domain.com npm run build:user --workspace @vpauto/extension
VITE_VPAUTO_API_URL=https://api.your-domain.com npm run zip:user --workspace @vpauto/extension
```

Upload the generated user zip to Chrome Web Store.

## 9. Update The Server

```bash
cd /var/www/vpauto
git pull
npm ci
npm run db:generate --workspace @vpauto/backend
npm run build --workspace @vpauto/shared
npm run build --workspace @vpauto/backend
set -a
source /var/www/vpauto/.env.production
set +a
npm run db:push --workspace @vpauto/backend
pm2 restart vpauto-backend --update-env
```

## 10. Backup

Minimum backup command:

```bash
tar -czf "/var/www/vpauto-backup-$(date +%F).tar.gz" /var/www/vpauto-data
```

Download the backup regularly or sync it to S3/R2.
