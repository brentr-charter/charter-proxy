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

app.get('/debug/join', async (req, res) => {
  const { projectId, period, task, costCode } = req.query;
  const user = req.headers['x-acumatica-user'];
  const pass = req.headers['x-acumatica-pass'];
  const auth = { 'Authorization': 'Basic ' + Buffer.from(user + ':' + pass).toString('base64'), 'Accept': 'application/json' };

  const txRes = await fetch(`${ACUMATICA_BASE_URL}/odata/${ACUMATICA_TENANT}/Project%20Transactions%20Inquiry?$filter=Project eq '${projectId}'&$select=ProjectTask,CostCode`, { headers: auth });
  const txData = await txRes.json();

  const charCodes = (s) => [...s].map(c => c.charCodeAt(0));

  // Unique trimmed task values and their char codes
  const uniqueTasks = [...new Set(txData.value.map(r => r.ProjectTask))];
  const gcRows = txData.value.filter(r => r.ProjectTask.includes('GC'));
  const l1510Rows = txData.value.filter(r => r.CostCode.includes('L1510'));

  res.json({
    uniqueTasksSample: uniqueTasks.slice(0, 5).map(t => ({ raw: t, trimmed: t.trim(), chars: charCodes(t.trim()) })),
    gcRowCount: gcRows.length,
    gcSample: gcRows[0] ? { task: gcRows[0].ProjectTask, chars: charCodes(gcRows[0].ProjectTask.trim()) } : null,
    l1510RowCount: l1510Rows.length,
    l1510Sample: l1510Rows[0] ? { costCode: l1510Rows[0].CostCode, chars: charCodes(l1510Rows[0].CostCode.trim()) } : null,
  });
});

app.get('/snapshot/costlines', async (req, res) => {
  const { projectId, period } = req.query;
  const user = req.headers['x-acumatica-user'];
  const pass = req.headers['x-acumatica-pass'];

  if (!projectId || !period) {
    return res.status(400).json({ error: 'projectId and period are required' });
  }

  // Convert MM-YYYY to MMYYYY for FinPeriod filter
  const finPeriod = period.replace('-', '');
  const authHeaders = { 'x-acumatica-user': user, 'x-acumatica-pass': pass };

  try {
    // ── 1. Fetch PMBudget (budget fields) ──────────────────────────────
    const budgetRes = await fetch(
      `${ACUMATICA_BASE_URL}/odata/${ACUMATICA_TENANT}/PMBudget` +
      `?$filter=ProjectID eq '${projectId}' and Type eq 'Expense'` +
      `&$select=ProjectTask,CostCode,Description,OriginalBudgetedAmount,RevisedBudgetedAmount,PotentialRevisedAmount`,
      {
  headers: {
    'Authorization': `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
    'Accept': 'application/json'
  }
}
    );
    if (!budgetRes.ok) throw new Error(`PMBudget failed: ${budgetRes.status}`);
    const budgetData = await budgetRes.json();

    // Group and sum by Task|CostCode
    const budgetMap = new Map();
    for (const row of budgetData.value) {
      const key = `${row.ProjectTask.trim()}|${row.CostCode.trim()}`;
      const existing = budgetMap.get(key);
      const original  = parseFloat(row.OriginalBudgetedAmount)  || 0;
      const revised   = parseFloat(row.RevisedBudgetedAmount)   || 0;
      const potential = parseFloat(row.PotentialRevisedAmount)  || 0;
      if (existing) {
        existing.originalBudget += original;
        existing.revisedBudget  += revised;
        existing.pendingBudget  += potential;
      } else {
        budgetMap.set(key, {
          task:           row.ProjectTask.trim(),
          costCode:       row.CostCode.trim(),
          description:    row.Description,
          originalBudget: original,
          revisedBudget:  revised,
          pendingBudget:  potential,
        });
      }
    }

    // Fallback: if pendingBudget summed to 0, use revisedBudget
    for (const [, line] of budgetMap) {
      if (line.pendingBudget === 0) line.pendingBudget = line.revisedBudget;
    }

    // ── 2. Fetch Transactions (actual + history) ───────────────────────
    const txRes = await fetch(
      `${ACUMATICA_BASE_URL}/odata/${ACUMATICA_TENANT}/Project%20Transactions%20Inquiry` +
      `?$filter=Project eq '${projectId}'` +
      `&$select=ProjectTask,CostCode,Amount,FinPeriod`,
      {
  headers: {
    'Authorization': `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`,
    'Accept': 'application/json'
  }
}
    );
    if (!txRes.ok) throw new Error(`Transactions failed: ${txRes.status}`);
    const txData = await txRes.json();

    // Sum by Task|CostCode for actual, and by Task|CostCode|FinPeriod for history
    const actualMap  = new Map(); // key -> total actual
    const periodMap  = new Map(); // key -> { period -> amount }

    for (const row of txData.value) {
  const toYYYYMM = (mmyyyy) => mmyyyy.slice(2) + mmyyyy.slice(0, 2);

  if (row.CostCode.trim() === 'L1510' && row.ProjectTask.trim() === 'GC') {
    console.log('L1510 raw:', row.FinPeriod, toYYYYMM(row.FinPeriod), 'vs', finPeriod, toYYYYMM(finPeriod));
  }

  if (toYYYYMM(row.FinPeriod) > toYYYYMM(finPeriod)) continue;; // skip future periods
  
      const key    = `${row.ProjectTask.trim()}|${row.CostCode.trim()}`;
      const amount = parseFloat(row.Amount) || 0;
      const fp     = row.FinPeriod; // MMYYYY
      
      // Actual
      actualMap.set(key, (actualMap.get(key) || 0) + amount);

      // Period buckets
      if (!periodMap.has(key)) periodMap.set(key, new Map());
      const buckets = periodMap.get(key);
      buckets.set(fp, (buckets.get(fp) || 0) + amount);
    }

    // ── 3. Join and build costLines ────────────────────────────────────
    const costLines = [];
    for (const [key, budget] of budgetMap) {
      const actual   = actualMap.get(key) || 0;
      const buckets  = periodMap.get(key) || new Map();

      // Sort periods descending, take 3 most recent, then reverse to oldest-first
      const history = [...buckets.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 3)
        .reverse()
        .map(([fp, spent]) => ({
          period: fp.slice(0, 2) + '-' + fp.slice(2), // MMYYYY -> MM-YYYY
          spent:  Math.round(spent),
        }));

      costLines.push({
        id:             `${projectId}|${budget.task.trim()}|${budget.costCode.trim()}`,
        task:           budget.task.trim(),
        costCode:       budget.costCode.trim(),
        description:    budget.description,
        originalBudget: Math.round(budget.originalBudget),
        revisedBudget:  Math.round(budget.revisedBudget),
        pendingBudget:  Math.round(budget.pendingBudget),
        actual:         Math.round(actual),
        history,
      });
    }

    // Filter out all-zero lines
    const filtered = costLines.filter(l =>
      l.originalBudget || l.revisedBudget || l.pendingBudget || l.actual
    );

    res.json({ costLines: filtered });

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
