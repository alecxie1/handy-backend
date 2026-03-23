/**
 * handy-backend — Minimal yft-design compatible backend
 *
 * Replaces Kevin's backend for local development.
 * Handles: font registration, template CRUD, static file serving.
 * Complex ops (PDF export, PSD parse) are proxied to yft.design public API.
 *
 * Port: 8789 (matches yft-design frontend proxy config)
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { nanoid } = require('nanoid');

const app = express();
const PORT = 8789;

// ── Directories ──────────────────────────────────────────────────────────────
const FONTS_DIR = path.join(__dirname, 'fonts');
const TEMPLATES_DIR = path.join(__dirname, 'templates_store');
const STATIC_DIR = path.join(__dirname, 'static');
[FONTS_DIR, TEMPLATES_DIR, STATIC_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/static', express.static(STATIC_DIR));
app.use('/fonts', express.static(FONTS_DIR));

// Request logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString().slice(11,19)} ${req.method} ${req.path}${req.query && Object.keys(req.query).length ? ' ?' + new URLSearchParams(req.query).toString() : ''}`);
  next();
});

// CORS for local development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Font Storage ──────────────────────────────────────────────────────────────
const fontUpload = multer({
  storage: multer.diskStorage({
    destination: FONTS_DIR,
    filename: (req, file, cb) => cb(null, file.originalname),
  }),
  fileFilter: (req, file, cb) => {
    const ok = /\.(otf|ttf|woff|woff2)$/i.test(file.originalname);
    cb(null, ok);
  },
});

// GET /api/design/font/info — list all registered fonts
app.get('/api/design/font/info', (req, res) => {
  const fontFiles = fs.readdirSync(FONTS_DIR).filter(f => /\.(otf|ttf|woff|woff2)$/i.test(f));
  const fonts = fontFiles.map(filename => {
    const name = path.parse(filename).name;
    const ext = path.extname(filename).slice(1).toLowerCase();
    const formatMap = { otf: 'opentype', ttf: 'truetype', woff: 'woff', woff2: 'woff2' };
    return {
      font_family: name,
      file_url: `/fonts/${filename}`,
      font_format: formatMap[ext] || 'opentype',
      filename,
    };
  });
  res.json({ code: 0, data: fonts, msg: '' });
});

// POST /api/design/font/upload — upload a font file
app.post('/api/design/font/upload', fontUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ code: 400, msg: 'No font file uploaded' });
  const name = path.parse(req.file.originalname).name;
  const ext = path.extname(req.file.originalname).slice(1).toLowerCase();
  const formatMap = { otf: 'opentype', ttf: 'truetype', woff: 'woff', woff2: 'woff2' };
  res.json({
    code: 200,
    msg: 'Font uploaded',
    data: {
      font_family: name,
      file_url: `/fonts/${req.file.originalname}`,
      font_format: formatMap[ext] || 'opentype',
    },
  });
});

// DELETE /api/design/font/:filename — remove a font
app.delete('/api/design/font/:filename', (req, res) => {
  const filePath = path.join(FONTS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ code: 404, msg: 'Font not found' });
  fs.unlinkSync(filePath);
  res.json({ code: 200, msg: 'Font deleted' });
});

// ── Template CRUD ─────────────────────────────────────────────────────────────

function loadTemplate(id) {
  const p = path.join(TEMPLATES_DIR, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function saveTemplate(id, data) {
  fs.writeFileSync(path.join(TEMPLATES_DIR, `${id}.json`), JSON.stringify(data, null, 2));
}

// POST /admin/template — create a new template record
app.post('/admin/template', (req, res) => {
  const { name, width, height, format_key } = req.body;
  if (!name) return res.status(400).json({ code: 400, msg: 'name is required' });

  const id = nanoid(10);
  const template = {
    id,
    name,
    width: width || 900,
    height: height || 500,
    format_key: format_key || 'custom',
    created_at: new Date().toISOString(),
    pages: [],  // canvas JSON pages live here
  };
  saveTemplate(id, template);
  res.json({ code: 200, msg: 'Template created', data: { id, name } });
});

// GET /admin/template — list all templates
app.get('/admin/template', (req, res) => {
  const templates = fs.readdirSync(TEMPLATES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const t = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf-8'));
      return { id: t.id, name: t.name, width: t.width, height: t.height, format_key: t.format_key };
    });
  res.json({ code: 0, data: templates, msg: '' });
});

// GET /admin/template/:id — get a single template
app.get('/admin/template/:id', (req, res) => {
  const t = loadTemplate(req.params.id);
  if (!t) return res.status(404).json({ code: 404, msg: 'Template not found' });
  res.json({ code: 0, data: t, msg: '' });
});

// PUT /admin/template/:id/pages — update template pages (our Flask app calls this)
// Accepts gzip+base64 compressed canvas JSON (pako format from our Python backend)
app.put('/admin/template/:id/pages', (req, res) => {
  const t = loadTemplate(req.params.id);
  if (!t) return res.status(404).json({ code: 404, msg: 'Template not found' });

  let pages = req.body.pages;

  // Handle gzip+base64 compressed payload (from our Python backend)
  if (req.body.data) {
    try {
      const pako = require('pako');
      const compressed = Buffer.from(req.body.data, 'base64');
      const decompressed = pako.inflate(compressed, { to: 'string' });
      pages = JSON.parse(decompressed);
    } catch (e) {
      // Try plain JSON fallback
      try {
        pages = JSON.parse(req.body.data);
      } catch (e2) {
        return res.status(400).json({ code: 400, msg: 'Could not parse pages data' });
      }
    }
  }

  // Always store as array of canvas pages
  const pagesData = pages || [];
  t.pages = Array.isArray(pagesData) ? pagesData : [pagesData];
  t.updated_at = new Date().toISOString();
  saveTemplate(t.id, t);
  res.json({ code: 200, msg: 'Pages updated', data: { id: t.id } });
});

// DELETE /admin/template/:id — delete a template
app.delete('/admin/template/:id', (req, res) => {
  const p = path.join(TEMPLATES_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(p)) return res.status(404).json({ code: 404, msg: 'Template not found' });
  fs.unlinkSync(p);
  res.json({ code: 200, msg: 'Template deleted' });
});

// GET /api/template/:id — template metadata (pages index, dimensions)
// Called first by loadTemplateAll to get page list
app.get('/api/template/:id', (req, res) => {
  const t = loadTemplate(req.params.id);
  if (!t) return res.status(404).json({ code: 404, msg: 'Template not found' });

  // Normalize: pages may be stored as a raw canvas object (dict) or as an array
  const rawPages = t.pages || [];
  const storedPages = Array.isArray(rawPages) ? rawPages : [rawPages];
  const pages = storedPages.map((_, i) => ({
    id: `${t.id}_page${i}`,
    sort: i,
    thumb: '',
  }));

  // Wrap in { code: 0, data: <payload> } for axios interceptor
  res.json({
    code: 0,
    data: {
      id: t.id,
      name: t.name,
      page_width: t.width,
      page_height: t.height,
      format_key: t.format_key,
      pages,
      ver: '1',
    }
  });
});

// GET /api/template/:id/pages — static asset info (page_static prefix)
app.get('/api/template/:id/pages', (req, res) => {
  const t = loadTemplate(req.params.id);
  if (!t) return res.status(404).json({ code: 404, msg: 'Template not found' });
  res.json({ code: 0, data: { page_static: '' } });
});

// GET /api/template/:id/page/:page_id — canvas JSON compressed as gzip+base64
// Frontend calls unzip(response) → pako.inflate(base64decode(data)) → JSON.parse
app.get('/api/template/:id/page/:page_id', (req, res) => {
  const zlib = require('zlib');
  const t = loadTemplate(req.params.id);
  if (!t) return res.status(404).json({ code: 404, msg: 'Template not found' });

  const rawPages2 = t.pages || [];
  const storedPages = Array.isArray(rawPages2) ? rawPages2 : [rawPages2];
  // Parse index from page_id: "{templateId}_page{index}"
  const pageIdStr = req.params.page_id;
  const match = pageIdStr.match(/_page(\d+)$/);
  const pageIndex = match ? parseInt(match[1]) : 0;

  const canvasData = storedPages[pageIndex];
  if (!canvasData) return res.status(404).json({ code: 404, msg: 'Page not found' });

  // Compress: gzip → base64 (matches frontend zip/unzip in src/utils/crypto.ts)
  // Wrap in { code: 0, data: <b64> } to satisfy the axios response interceptor
  const jsonStr = JSON.stringify(canvasData);
  zlib.gzip(Buffer.from(jsonStr, 'utf-8'), (err, compressed) => {
    if (err) return res.status(500).json({ code: 500, msg: 'Compression failed' });
    const b64 = compressed.toString('base64');
    res.json({ code: 0, data: b64 });
  });
});

// ── Static assets with !WxH suffix handling ───────────────────────────────────
// Handles: /static/assets/foo.png  AND  /static/assets/foo.png!900x160
app.get(/^\/static\/assets\/(.+)$/, (req, res) => {
  // Strip CDN-style resize suffix e.g. !900x160
  const filename = req.params[0].replace(/![0-9]+x[0-9]+$/, '');
  const filepath = path.join(__dirname, 'static', 'assets', filename);
  if (fs.existsSync(filepath)) {
    res.sendFile(filepath);
  } else {
    res.status(404).send('Asset not found: ' + filename);
  }
});

// ── Proxy /generated/ images from Flask, stripping !WxH suffix ───────────────
app.get(/^\/generated\/(.+)$/, (req, res) => {
  const http = require('http');
  const filename = req.params[0].replace(/![0-9]+x[0-9]+$/, '');
  const options = { host: 'localhost', port: 5000, path: '/generated/' + filename };
  http.get(options, (upstream) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(res);
  }).on('error', () => res.status(502).send('Flask unreachable'));
});

// ── h5/mobile path aliases (handleApi() returns '' in mobile mode) ───────────
// Mirror all /api/template routes at /template for h5 mode

app.get('/template/:id/pages', (req, res) => {
  req.params = { id: req.params.id };
  const t = loadTemplate(req.params.id);
  if (!t) return res.status(404).json({ code: 404, msg: 'Template not found' });
  res.json({ code: 0, data: { page_static: '', fonts: [] } });
});

app.get('/template/:id/page/:page_id', (req, res) => {
  const zlib = require('zlib');
  const t = loadTemplate(req.params.id);
  if (!t) return res.status(404).json({ code: 404, msg: 'Template not found' });
  const rawPages = t.pages || [];
  const storedPages = Array.isArray(rawPages) ? rawPages : [rawPages];
  const match = req.params.page_id.match(/_page(\d+)$/);
  const pageIndex = match ? parseInt(match[1]) : 0;
  const canvasData = storedPages[pageIndex];
  if (!canvasData) return res.status(404).json({ code: 404, msg: 'Page not found' });
  const jsonStr = JSON.stringify(canvasData);
  zlib.gzip(Buffer.from(jsonStr, 'utf-8'), (err, compressed) => {
    if (err) return res.status(500).json({ code: 500, msg: 'Compression failed' });
    res.json({ code: 0, data: compressed.toString('base64') });
  });
});

app.get('/template/:id', (req, res) => {
  const t = loadTemplate(req.params.id);
  if (!t) return res.status(404).json({ code: 404, msg: 'Template not found' });
  const rawPages = t.pages || [];
  const storedPages = Array.isArray(rawPages) ? rawPages : [rawPages];
  const pages = storedPages.map((_, i) => ({ id: `${t.id}_page${i}`, sort: i, thumb: '' }));
  res.json({ code: 0, data: { id: t.id, name: t.name, page_width: t.width, page_height: t.height, format_key: t.format_key, pages, ver: '1' } });
});

// h5 font info
app.get('/design/font/info', (req, res) => {
  const fontFiles = fs.readdirSync(FONTS_DIR).filter(f => /\.(otf|ttf|woff|woff2)$/i.test(f));
  const fonts = fontFiles.map(filename => {
    const name = path.parse(filename).name;
    const ext = path.extname(filename).slice(1).toLowerCase();
    const formatMap = { otf: 'opentype', ttf: 'truetype', woff: 'woff', woff2: 'woff2' };
    return { font_family: name, file_url: `/fonts/${filename}`, font_format: formatMap[ext] || 'opentype', filename };
  });
  res.json({ code: 0, data: fonts, msg: '' });
});

// ── Proxy complex ops to yft.design public API ────────────────────────────────
// PDF export, PSD parse, background removal — we don't need to reimplement these
const yftProxy = createProxyMiddleware({
  target: 'https://yft.design',
  changeOrigin: true,
  on: {
    error: (err, req, res) => {
      console.error('Proxy error:', err.message);
      res.status(502).json({ code: 502, msg: 'Upstream API error: ' + err.message });
    },
  },
});

app.use('/api/design/upload', yftProxy);
app.use('/api/design/export', yftProxy);
app.use('/api/design/matting', yftProxy);

// ── Serve built frontend (handy-design dist) ─────────────────────────────────
const DIST_DIR = path.join(__dirname, '../handy-design/dist');
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  // SPA fallback — let Vue Router handle all non-API routes
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/admin') ||
        req.path.startsWith('/static') || req.path.startsWith('/fonts') ||
        req.path.startsWith('/health') || req.path.startsWith('/template') ||
        req.path.startsWith('/design')) return next();
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
  console.log(`   Frontend:      http://localhost:${PORT}/`);
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const fonts = fs.readdirSync(FONTS_DIR).filter(f => /\.(otf|ttf|woff|woff2)$/i.test(f));
  const templates = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
  res.json({
    status: 'ok',
    fonts: fonts.length,
    templates: templates.length,
    font_list: fonts,
    template_ids: templates.map(f => path.parse(f).name),
  });
});

app.listen(PORT, () => {
  console.log(`\n✅ handy-backend running on http://localhost:${PORT}`);
  console.log(`   Fonts dir:     ${FONTS_DIR}`);
  console.log(`   Templates dir: ${TEMPLATES_DIR}`);
  console.log(`   Health check:  http://localhost:${PORT}/health\n`);
});
