require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();

const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(cors({
  origin: allowedOrigin
}));

const { ACUMATICA_BASE_URL, ACUMATICA_TENANT, PORT } = process.env;

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

const port = PORT || 3001;
app.listen(port, () => console.log(`Proxy running on port ${port}`));
