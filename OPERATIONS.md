# VPauto — Runbook opérationnel

Tout ce qu'il faut savoir pour déployer, mettre à jour, vérifier et débuguer
l'app (backend AWS Lightsail + extension Chrome) sans avoir à demander à
chaque fois. À garder à jour à mesure que l'archi évolue.

---

## 1. Architecture

```
Chrome (extension VPauto Assistant User)
       │ host_permissions: http://51.44.62.115/* + https://*.vpauto.fr/*
       │
       ▼
  http://51.44.62.115        ← AWS Lightsail static IP, instance "vpauto-api"
       │
       ▼ port 80
   nginx (reverse proxy, pas de TLS pour l'instant)
       │ proxy_pass localhost:3456
       ▼
   PM2 process "vpauto-backend"
       │
       ├─ SQLite       /var/www/vpauto-data/vpauto.db
       ├─ Screenshots  /var/www/vpauto-data/screenshots/
       └─ OCR pipeline pdftoppm (poppler) + tesseract (-l fra)
```

### Stack

| Couche | Techno | Version |
|---|---|---|
| OS serveur | Ubuntu 24.04 LTS | sur Lightsail eu-west-3a, plan 512 MB RAM + 2 GB swap |
| Runtime | Node.js | 24.x |
| Framework backend | Hono + Prisma | — |
| DB | SQLite | fichier `/var/www/vpauto-data/vpauto.db` |
| Process manager | PM2 | — |
| Reverse proxy | nginx | port 80 (HTTP) |
| Extension | WXT + pdfjs-dist | manifest v3 |
| OCR | poppler-utils + tesseract-ocr + tesseract-ocr-fra | binaires système |

### Liens et IP

| Quoi | Valeur |
|---|---|
| IP statique Lightsail | `51.44.62.115` |
| Région AWS | `eu-west-3a` (Paris) |
| Repo GitHub | `https://github.com/Abderrahime/vpauto.git` |
| Branche prod | `main` |
| URL API publique | `http://51.44.62.115` |
| Path code serveur | `/var/www/vpauto/` |
| Path data persistante | `/var/www/vpauto-data/` |
| Env file serveur | `/var/www/vpauto/.env.production` |
| User SSH | `ubuntu` |
| Clé SSH | `~/.ssh/LightsailDefaultKey-eu-west-3.pem` |

---

## 2. Setup initial (une seule fois, déjà fait)

À refaire seulement si tu réinstalles le serveur de zéro.

### 2.1 Sur AWS Lightsail
1. **Create instance** → Ubuntu 24.04 LTS, plan 512 MB minimum
2. **Static IP** → attache à l'instance
3. **Firewall** (onglet Networking) : ouvrir TCP 22, 80, 443
4. **Download default key** → `~/.ssh/LightsailDefaultKey-eu-west-3.pem`, `chmod 600`

### 2.2 SSH puis provisioning serveur

```bash
ssh -i ~/.ssh/LightsailDefaultKey-eu-west-3.pem ubuntu@51.44.62.115
```

```bash
# Mises à jour système
sudo apt update && sudo apt upgrade -y

# Swap (2 GB) — critique sur 512 MB de RAM pour faire tourner l'OCR
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Node.js 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs

# Outils
sudo apt install -y git nginx certbot python3-certbot-nginx curl build-essential

# OCR (poppler + tesseract avec français)
sudo apt install -y poppler-utils tesseract-ocr tesseract-ocr-fra

# PM2 global
sudo npm install -g pm2

# Dossier du code
sudo mkdir -p /var/www
sudo chown -R $USER:$USER /var/www
```

### 2.3 Cloner et builder le code

```bash
cd /var/www
git clone https://github.com/Abderrahime/vpauto.git
cd vpauto
npm ci
# IMPORTANT : Prisma client AVANT le build backend, sinon erreurs TS
# (le type `Snapshot` provient du client généré)
npm run db:generate --workspace @vpauto/backend
npm run build --workspace @vpauto/shared
npm run build --workspace @vpauto/backend
```

### 2.4 Préparer DB + secrets

```bash
mkdir -p /var/www/vpauto-data/screenshots
chmod 700 /var/www/vpauto-data

# Génère les secrets
echo "ADMIN_TOKEN=$(openssl rand -hex 32)"
echo "AUTH_SECRET=$(openssl rand -hex 32)"
# Note ces valeurs

nano /var/www/vpauto/.env.production
```

Contenu (remplace les xxx) :
```bash
PORT=3456
DATABASE_URL=file:/var/www/vpauto-data/vpauto.db
VPAUTO_SCREENSHOT_DIR=/var/www/vpauto-data/screenshots
VPAUTO_ADMIN_EMAIL=admin@example.com
VPAUTO_ADMIN_PASSWORD=remplace-par-un-mot-de-passe-fort
VPAUTO_ADMIN_TOKEN=xxx
VPAUTO_AUTH_SECRET=xxx
```

```bash
cd /var/www/vpauto
set -a && source .env.production && set +a
npm run db:push --workspace @vpauto/backend
```

### 2.5 Lancer avec PM2

```bash
cd /var/www/vpauto
pm2 start "npm run start --workspace @vpauto/backend" --name vpauto-backend
pm2 save
pm2 startup    # suit la commande `sudo env...` qu'il imprime
```

### 2.6 nginx proxy HTTP

```bash
sudo nano /etc/nginx/sites-available/vpauto-api
```

```nginx
server {
    listen 80;
    server_name 51.44.62.115 _;

    client_max_body_size 16M;
    proxy_read_timeout 90s;
    proxy_connect_timeout 10s;

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

```bash
sudo ln -s /etc/nginx/sites-available/vpauto-api /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

---

## 3. Workflow de mise à jour (le quotidien)

### 3.1 Sur ton Mac — committer et pusher les changements

```bash
cd "/Users/abderrahim/projets/vpauto extensions"
git status --short
git add -A
git commit -m "Description courte du changement"
git push
git log --oneline -3
```

### 3.2 Sur le serveur AWS — pull, build, restart

```bash
ssh -i ~/.ssh/LightsailDefaultKey-eu-west-3.pem ubuntu@51.44.62.115
```

```bash
cd /var/www/vpauto
git pull
git log --oneline -3                              # vérifier qu'on a bien la nouvelle tête

# Si package.json a bougé (nouvelles deps)
npm ci

# Toujours dans l'ordre : prisma → shared → backend
npm run db:generate --workspace @vpauto/backend
npm run build --workspace @vpauto/shared
npm run build --workspace @vpauto/backend

# Si le schéma Prisma a changé
# npm run db:push --workspace @vpauto/backend

pm2 restart vpauto-backend
pm2 logs vpauto-backend --lines 20 --nostream
```

Attendu : pas d'erreur dans les logs, et `curl http://localhost:3456/api/health` répond `{"success":true,...}`.

---

## 4. Builder l'extension prod et la charger dans Chrome

### 4.1 Build extension pointée sur AWS

Sur ton Mac :
```bash
cd "/Users/abderrahim/projets/vpauto extensions/packages/extension"
VITE_VPAUTO_API_URL=http://51.44.62.115 npm run build:user

# Vérifier que l'IP est bien dans le manifeste
grep "51.44.62.115" .output-user/chrome-mv3/manifest.json
```

Le manifest doit contenir `"host_permissions":[..., "http://51.44.62.115/*", ...]`.

### 4.2 Charger dans Chrome

1. `chrome://extensions` → **désactive** `VPauto Assistant User (Local)` s'il était chargé
2. **Charger l'extension non empaquetée** → sélectionne le dossier
   `/Users/abderrahim/projets/vpauto extensions/packages/extension/.output-user/chrome-mv3`
3. La carte doit afficher **`VPauto Assistant User`** (sans suffixe Local)
4. Va sur `vpauto.fr/vehicule/liste`

### 4.3 Vérifier l'extension consomme bien AWS

F12 sur la page vpauto.fr, console :
```js
chrome.storage.local.get('vpautoSwLog', d => console.table(d.vpautoSwLog.slice(-20)))
```

Tu dois voir des `FETCH_CT_PDF received url=https://cdn.vpauto.fr/...` puis du temps d'OCR. Les appels passent par `http://51.44.62.115/api/vehicles/ct-ocr` (visibles dans l'onglet Network).

---

## 5. Vérifications (à lancer après chaque deploy)

### Côté serveur

```bash
# Stack opérationnelle
node -v                                # v24.x.x
pdftoppm -v 2>&1 | head -1             # poppler 24.x
tesseract --list-langs | grep fra      # fra présent
pm2 status                             # vpauto-backend online

# Mémoire (sur 512 MB, swap consommé attendu pendant l'OCR)
free -h

# Endpoints en local
curl -sS http://localhost:3456/api/health
curl -sS http://localhost/api/health

# DB existante
ls -lh /var/www/vpauto-data/vpauto.db
```

### Côté Mac

```bash
IP=51.44.62.115

# Health via internet
curl -sS http://$IP/api/health

# OCR (1er appel : 5-15s, 2e appel : <50ms par le cache)
time curl -sS -X POST http://$IP/api/vehicles/ct-ocr \
  -H "Content-Type: application/json" \
  -d '{"url":"https://cdn.vpauto.fr/d/AZitKsP_CT.pdf"}' \
  | head -c 200

# Stats du cache OCR
curl -sS http://$IP/api/vehicles/ct-ocr/stats
```

### Côté extension (F12 sur vpauto.fr)

```js
// Logs du SW (background.js)
chrome.storage.local.get('vpautoSwLog', d => console.table(d.vpautoSwLog.slice(-20)))

// Vider le cache des résumés CT si tu veux forcer une re-analyse
chrome.storage.local.remove('vpautoCtPdfSummary.v5')

// Vider le buffer de logs SW
chrome.storage.local.remove('vpautoSwLog')
```

---

## 6. Commandes de debug fréquentes

### Logs

```bash
# Logs PM2 (backend) live
pm2 logs vpauto-backend

# Logs PM2 archivés
ls ~/.pm2/logs/
cat ~/.pm2/logs/vpauto-backend-out.log
cat ~/.pm2/logs/vpauto-backend-error.log

# Logs nginx
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log

# Status
pm2 status
pm2 monit                              # interface live CPU/RAM
sudo systemctl status nginx
free -h                                # mémoire/swap
df -h /var/www                         # espace disque
```

### Restart / reload

```bash
pm2 restart vpauto-backend             # restart backend après build
pm2 reload vpauto-backend              # restart sans downtime
pm2 stop vpauto-backend                # arrêt complet
pm2 delete vpauto-backend              # supprime le process (avant un nouveau pm2 start)

sudo systemctl reload nginx            # recharge config nginx
sudo systemctl restart nginx           # restart complet
sudo nginx -t                          # test syntaxe avant reload
```

### Backup DB

```bash
# Sur le serveur
cp /var/www/vpauto-data/vpauto.db /var/www/vpauto-data/backup-$(date +%F).db
ls -lh /var/www/vpauto-data/

# Depuis ton Mac (download)
scp -i ~/.ssh/LightsailDefaultKey-eu-west-3.pem \
  ubuntu@51.44.62.115:/var/www/vpauto-data/vpauto.db \
  ~/vpauto-backup-$(date +%F).db
```

---

## 7. Troubleshooting

### Backend ne démarre pas (PM2 status "errored")

```bash
pm2 logs vpauto-backend --lines 50 --nostream
```

| Erreur | Cause / fix |
|---|---|
| `ERR_UNKNOWN_FILE_EXTENSION ".ts"` | `@vpauto/shared` pas build. Fais `npm run build --workspace @vpauto/shared` puis `pm2 restart vpauto-backend` |
| `Cannot find module '@prisma/client'` | Prisma pas généré. `npm run db:generate --workspace @vpauto/backend` |
| `EADDRINUSE :3456` | Un autre process écoute déjà. `sudo lsof -i :3456` puis kill |
| OOM (`exited unexpectedly`) répétés | RAM épuisée. Augmente le swap ou passe au plan 2 GB |

### Build TypeScript échoue

| Erreur | Fix |
|---|---|
| `'Snapshot' has no exported member` | `npm run db:generate --workspace @vpauto/backend` avant le build backend |
| 32 erreurs sur scripts | Souvent dépendances Prisma manquantes. Re-run `db:generate` |
| OOM kill pendant `npm ci` (code 137) | Le swap doit être actif (`swapon --show`), sinon faire workspace par workspace |

### OCR retourne une erreur

```bash
# Test direct du binaire
curl -o /tmp/test.pdf "https://cdn.vpauto.fr/d/AZitKsP_CT.pdf"
pdftoppm -jpeg -r 200 /tmp/test.pdf /tmp/test
ls /tmp/test-*.jpg
tesseract /tmp/test-1.jpg - -l fra --psm 4 | head -30
```

| Erreur API | Cause |
|---|---|
| `{"success":false,"error":"pdftoppm_exit_X"}` | poppler cassé. `sudo apt install -y --reinstall poppler-utils` |
| `tesseract_exit_X` | tesseract ou langue manquante. `sudo apt install -y tesseract-ocr-fra` |
| `ocr_timeout` (60s) | OOM kill pendant l'OCR. Vérifie `free -h` pendant l'appel |
| `invalid_ct_pdf_url` | URL ne matche pas `https://cdn.vpauto.fr/d/*_CT.pdf`. Côté code dans `ocr.ts:isAllowedCtPdfUrl` |

### Extension Chrome — badge "CT disponible" sans détail

Cas par cas :
- **Backend offline** ? Tester `curl http://51.44.62.115/api/health`
- **Cache encore une vieille valeur** ? Vider via `chrome.storage.local.remove('vpautoCtPdfSummary.v5')`
- **SW pas réveillé** ? `chrome://extensions` → désactive/réactive l'extension
- **OCR échoue silencieusement** ? Regarde `vpautoSwLog` dans `chrome.storage.local`

### Extension — "background_message_timeout"

- SW pas enregistré (manifest cassé) : regarde la section "Erreurs" sur la carte d'extension dans `chrome://extensions`
- API trop lente : augmente `sendRuntimeMessage` timeout dans `badges.ts` (actuellement 30s)
- nginx timeout : `proxy_read_timeout` actuellement à 90s dans `/etc/nginx/sites-available/vpauto-api`

---

## 8. Choses à savoir / pièges

| Sujet | Détail |
|---|---|
| **Cache OCR** | En mémoire dans le process backend, vidé à chaque `pm2 restart`. Pour persister, à ajouter en DB (TODO) |
| **Premier OCR sur 512 MB** | 5-15 secondes. Les suivants instantanés (cache mémoire). Si OOM > 3 fois → upgrade RAM |
| **Limite OCR** | 1 OCR à la fois (concurrence = 1 côté extension dans `badges.ts:CT_PDF_PARSE_CONCURRENCY`) — sinon 512 MB sature |
| **Cache extension** | Clé storage `vpautoCtPdfSummary.v5`. Si tu changes le format des résumés, **bumper la version** dans `badges.ts:CT_PDF_SUMMARY_STORAGE_KEY` |
| **Permission alarms** | Requise pour le keep-alive du SW MV3. Manifest l'inclut depuis le commit `[ajout alarms keep-alive]` |
| **pdf.worker.js** | Worker pdfjs livré dans `src/public/pdf.worker.js` (2.3 MB), copié à `chrome-mv3/pdf.worker.js` à chaque build. Référencé dans `web_accessible_resources` du manifest |
| **CORS backend** | `index.ts:resolveCorsOrigin` autorise `chrome-extension://*`, `*.vpauto.fr`, `localhost`. Pas l'IP du Mac — si tu veux tester directement depuis le Mac, faut ajouter |
| **Pas d'HTTPS** | Let's Encrypt n'émet pas de cert pour une IP. Soit prendre un domaine, soit utiliser `51-44-62-115.nip.io` (alias DNS gratuit qui résout vers l'IP, accepté par certbot) |
| **Tests parser** | `npm test --workspace @vpauto/extension` lance les 46 tests (parser unitaire + fixtures OCR réelles). À garder vert avant chaque push |

---

## 9. Cheat sheet ultra-condensée

### Update standard (le plus fréquent)

```bash
# Mac
cd "/Users/abderrahim/projets/vpauto extensions"
git add -A && git commit -m "..." && git push

# Serveur
ssh -i ~/.ssh/LightsailDefaultKey-eu-west-3.pem ubuntu@51.44.62.115
cd /var/www/vpauto && git pull && npm ci && \
  npm run db:generate --workspace @vpauto/backend && \
  npm run build --workspace @vpauto/shared && \
  npm run build --workspace @vpauto/backend && \
  pm2 restart vpauto-backend && \
  pm2 logs vpauto-backend --lines 10 --nostream
```

### Rebuild extension prod

```bash
cd "/Users/abderrahim/projets/vpauto extensions/packages/extension"
VITE_VPAUTO_API_URL=http://51.44.62.115 npm run build:user
```

Puis ⟳ sur la carte d'extension dans `chrome://extensions`.

### Tester end-to-end

```bash
curl -sS http://51.44.62.115/api/health
curl -sS -X POST http://51.44.62.115/api/vehicles/ct-ocr \
  -H "Content-Type: application/json" \
  -d '{"url":"https://cdn.vpauto.fr/d/AZitKsP_CT.pdf"}' | head -c 200
```

---

## 10. Évolutions futures (TODO)

- [ ] Domaine custom + HTTPS Let's Encrypt
- [ ] Cache OCR persistant en SQLite (survit aux restart PM2)
- [ ] Backup auto DB en S3 (cron quotidien)
- [ ] Migration vers plan 2 GB si OCR sature trop souvent
- [ ] CI/CD GitHub Actions → SSH deploy auto sur push main
- [ ] Page admin web pour voir les logs en temps réel
- [ ] OCR via API LLM (Anthropic vision) pour les PDFs très dégradés

---

**Dernière mise à jour** : ce fichier doit refléter l'état réel du système.
Quand tu changes l'archi (port, IP, dépendance, etc.), modifie aussi ce
fichier dans le même commit.
