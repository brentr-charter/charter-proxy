require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
app.use(express.json());

const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(cors({ origin: allowedOrigin }));

const { ACUMATICA_BASE_URL, ACUMATICA_TENANT, DROPBOX_TOKEN, PORT } = process.env;

// ── Acumatica OData passthrough ───────────────────────────────────────────────
app.get('/odata/:giName', async (req, res) => {
  const { giName } = req.params;
  const user = req.headers['x-acumatica-user'];
  const pass = req.headers['x-acumatica-pass'];

  if (!user || !pass) {
    return res.status(401).json({ error: 'Missing credentials' });
  }

  const basicAuth = Buffer.from(`${user}:${pass}`).toString('base64');
  const queryString = new URLSearchParams(req.query).toString();
  const url = `${ACUMATICA_BASE_URL}/odata/${ACUMATICA_TENANT}/${giName}?${queryString}`;

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Accept': 'application/json'
      }
    });
    if (response.status === 401) {
      return res.status(401).json({ error: 'Invalid Acumatica credentials' });
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dropbox: save projection file ─────────────────────────────────────────────
// POST /projections/save
// Body: { filename: "26-6590_projection_04-2026.json", content: { ...snapshot } }
app.post('/projections/save', async (req, res) => {
  const { filename, content } = req.body;
  if (!filename || !content) {
    return res.status(400).json({ error: 'Missing filename or content' });
  }

  try {
    const response = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DROPBOX_TOKEN}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path: `/${filename}`,
          mode: 'overwrite',
          autorename: false,
          mute: false
        })
      },
      body: JSON.stringify(content, null, 2)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dropbox: list projection files ───────────────────────────────────────────
// GET /projections/list
app.get('/projections/list', async (req, res) => {
  try {
    const response = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DROPBOX_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ path: '', recursive: false })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dropbox: load a projection file ──────────────────────────────────────────
// GET /projections/load?filename=26-6590_projection_04-2026.json
app.get('/projections/load', async (req, res) => {
  const { filename } = req.query;
  if (!filename) {
    return res.status(400).json({ error: 'Missing filename' });
  }

  try {
    const response = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DROPBOX_TOKEN}`,
        'Dropbox-API-Arg': JSON.stringify({ path: `/${filename}` })
      }
    });
    const text = await response.text();
    res.json(JSON.parse(text));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = PORT || 3001;
app.listen(port, () => console.log(`Proxy running on port ${port}`));
