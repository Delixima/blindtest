# Blindtest

Blindtest multijoueur en temps réel. Les joueurs s'affrontent dans des salles, devinent titre et/ou artiste d'extraits de 30 s fournis par l'API publique Deezer, et grimpent dans un classement.

Stack : Node.js + Express, Socket.IO, SQLite (better-sqlite3), frontend HTML/CSS/JS vanilla.

## Fonctionnalités

- Jeu en invité (pseudo seul) ou avec un compte (bcrypt) pour garder historique et stats.
- Salles publiques ou privées, code à 5 caractères, 2 à 20 joueurs, transfert d'hôte automatique.
- Sources : top Deezer, genre, artiste (avec suggestions), playlist (URL ou ID).
- 5 à 50 manches, 10 à 30 s par manche, modes titre / artiste / les deux, extrait au début, au milieu ou aléatoire.
- Audio synchronisé : le serveur fixe l'heure de départ, chaque client corrige son horloge par ping.
- Validation côté serveur uniquement, tolérante (accents, ponctuation, feat., remaster, fautes de frappe).
- Points, bonus de rapidité, de série et du premier à trouver, réglables dans `server/config.js`.
- Classement live, écran final avec podium, classement global (semaine, mois, toujours), profils.
- Reconnexion en cours de partie (60 s de grâce), pistes mortes sautées, salles inactives nettoyées.
- Chat texte dans la salle (les messages qui contiennent la réponse sont bloqués pendant la manche).

## Installation locale

Prérequis : Node.js 20 ou plus.

```bash
git clone https://github.com/Delixima/blindtest.git
```

```bash
cd blindtest && npm install
```

```bash
cp .env.example .env
```

Édite `.env` (au minimum `COOKIE_SECRET`, et `SECURE_COOKIES=false` si tu testes en HTTP local), puis :

```bash
npm start
```

Le site tourne sur `http://localhost:3000`. Pour tester seul en local, mets `MIN_PLAYERS_TO_START=1` dans `.env`.

Tests :

```bash
npm test
```

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port HTTP |
| `HOST` | `0.0.0.0` | Adresse d'écoute (`127.0.0.1` derrière nginx) |
| `DB_PATH` | `./data/blindtest.db` | Fichier SQLite |
| `COOKIE_SECRET` | - | Secret de signature des cookies, obligatoire en prod |
| `SECURE_COOKIES` | `false` | `true` en HTTPS (Cloudflare) |
| `TRUST_PROXY` | `true` | Lit l'IP client transmise par le proxy local |
| `MIN_PLAYERS_TO_START` | `2` | Joueurs connectés requis pour lancer |

Points, durées et limites (anti-spam, délai de reconnexion, timeout des salles, throttling Deezer) sont dans `server/config.js`.

## Déploiement sur Raspberry Pi (Ubuntu)

### 1. Node.js et outils de compilation

`better-sqlite3` et `bcrypt` compilent un module natif si aucun binaire ARM n'est disponible.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
```

```bash
sudo apt install -y nodejs build-essential python3 nginx
```

### 2. Application

```bash
sudo useradd --system --create-home --home-dir /opt/blindtest blindtest
```

```bash
sudo -u blindtest git clone https://github.com/Delixima/blindtest.git /opt/blindtest
```

```bash
cd /opt/blindtest && sudo -u blindtest npm ci --omit=dev
```

```bash
sudo -u blindtest cp .env.example .env && sudo -u blindtest mkdir -p data
```

Dans `/opt/blindtest/.env` : `HOST=127.0.0.1`, `SECURE_COOKIES=true`, et un vrai secret :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Service systemd

```bash
sudo cp /opt/blindtest/deploy/blindtest.service /etc/systemd/system/
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now blindtest
```

Logs :

```bash
journalctl -u blindtest -f
```

### 4. nginx

`nginx.conf.example` gère le WebSocket (headers `Upgrade` et `Connection`), le streaming audio sans tampon, et récupère la vraie IP via `CF-Connecting-IP`. Remplace `server_name` par ton domaine.

```bash
sudo cp /opt/blindtest/nginx.conf.example /etc/nginx/sites-available/blindtest
```

```bash
sudo ln -s /etc/nginx/sites-available/blindtest /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
```

### 5. Cloudflare Tunnel

Installe `cloudflared` (paquet `.deb` arm64 sur la page releases de Cloudflare), puis :

```bash
cloudflared tunnel login
```

```bash
cloudflared tunnel create blindtest
```

```bash
cloudflared tunnel route dns blindtest blindtest.ton-domaine.fr
```

Copie `deploy/cloudflared-config.yml.example` vers `/etc/cloudflared/config.yml`, remplace l'ID du tunnel et le hostname, puis :

```bash
sudo cloudflared service install && sudo systemctl enable --now cloudflared
```

Les WebSockets passent par défaut dans Cloudflare Tunnel, rien à activer côté dashboard.

### Mise à jour

```bash
cd /opt/blindtest && sudo -u blindtest git pull && sudo -u blindtest npm ci --omit=dev && sudo systemctl restart blindtest
```

## Architecture

```
server/
  index.js        Express + Socket.IO, routes, nettoyage périodique
  config.js       points, durées, limites
  db.js           schéma SQLite et requêtes
  deezer.js       client API : file d'attente (45 req / 5 s), cache mémoire + SQLite
  game.js         salles, manches, scores, reconnexion
  validate.js     normalisation et comparaison des réponses
  identity.js     identité joueur (cookies signés)
  sockets.js      événements Socket.IO
  routes/         auth, classement, profil, salles + proxy audio
public/           pages et assets
tests/            validate.test.js, game.test.js
deploy/           service systemd, exemple cloudflared
```

### Choix notables

- **Proxy audio** : le navigateur ne reçoit jamais l'URL Deezer (qui permettrait d'identifier la piste) mais `/audio/CODE/JETON`, valable uniquement pendant la manche et pour les joueurs de la salle. Coût : environ 500 Ko par joueur et par manche qui transitent par le Pi.
- **URLs preview** : jamais stockées. Seuls les ID de pistes sont en cache, un `/track/{id}` frais est fait juste avant chaque manche.
- **Pochette** : envoyée seulement à la fin de la manche. Pendant la manche, un visuel générique flouté la remplace.
- **Identité** : un cookie signé donne un ID stable à chaque invité (`g:...`) ou compte (`u:...`), ce qui permet la reconnexion.
- **Mode titre + artiste** : chaque catégorie se valide séparément, ou les deux d'un coup avec « artiste - titre ».

### Points (par défaut)

| Règle | Points |
|---|---|
| Titre correct | 100 |
| Artiste correct | 100 |
| Rapidité, par catégorie trouvée | 0 à 100, linéaire sur la durée de la manche |
| Série (manches réussies d'affilée avant celle-ci) | +10 par manche, plafonné à +50 |
| Premier à trouver une catégorie | +25 |
