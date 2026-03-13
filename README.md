# handy-backend

Minimal yft-design compatible backend for local development. Replaces Kevin's backend so we can self-host and resolve blockers Q3 (fonts) and Q4 (templates) ourselves.

## Setup

```bash
cd ~/projects/handy-backend
npm install
node server.js
```

Runs on **port 8789** (matches yft-design frontend proxy config).

## What It Does

| Feature | Status |
|---|---|
| Font upload + registration | ✅ |
| Font listing (`/api/design/font/info`) | ✅ |
| Template create / read / update / delete | ✅ |
| Canvas JSON handoff (`PUT /admin/template/:id/pages`) | ✅ |
| Template serve to editor (`GET /api/template/:id`) | ✅ |
| PDF export | ✅ (proxied to yft.design) |
| PSD/PDF parse | ✅ (proxied to yft.design) |
| Background removal | ✅ (proxied to yft.design) |

## Registering AIA Fonts

Just drop the font files into `~/projects/handy-backend/fonts/`:

```bash
cp "/mnt/c/Users/Alecx/Downloads/#01 友邦SC/fonts/HYQiHei-50S.otf" ~/projects/handy-backend/fonts/
cp "/mnt/c/Users/Alecx/Downloads/#01 友邦SC/fonts/AIA Everest Regular.otf" ~/projects/handy-backend/fonts/
# ... repeat for each weight
```

Or use the upload API:
```bash
curl -X POST http://localhost:8789/api/design/font/upload \
  -F "file=@/path/to/font.otf"
```

## Creating Templates (Q4)

```bash
# Create the 3 format templates
curl -X POST http://localhost:8789/admin/template \
  -H "Content-Type: application/json" \
  -d '{"name": "WeChat Banner", "width": 900, "height": 500, "format_key": "wechat_banner"}'

curl -X POST http://localhost:8789/admin/template \
  -H "Content-Type: application/json" \
  -d '{"name": "A4 Flyer", "width": 2480, "height": 3508, "format_key": "a4_flyer"}'

curl -X POST http://localhost:8789/admin/template \
  -H "Content-Type: application/json" \
  -d '{"name": "Square Post", "width": 1080, "height": 1080, "format_key": "square_post"}'
```

Each returns a `template_id` — put those in the Flask app's `.env`.

## Health Check

```bash
curl http://localhost:8789/health
```
