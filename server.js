}

// ── 2. Fetch Transactions (actual + history) ───────────────────────
    // Single fetch to PM-Cost Detail GI — one call for the whole project,
    // paginated in case row count exceeds PAGE_SIZE.
    const actualMap = new Map();
    const periodMap = new Map();
    const toYYYYMM  = (s) => s.slice(2) + s.slice(0, 2);

    const authHeader = {
      'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
      'Accept': 'application/json'
    };

    const PAGE_SIZE = 5000;
    let allTxRows   = [];
    let skip        = 0;

    while (true) {
      const txRes = await fetch(
        `${ACUMATICA_BASE_URL}/odata/${ACUMATICA_TENANT}/PM-Cost%20Detail` +
        `?$filter=ProjectID eq '${projectId}'` +
        `&$top=${PAGE_SIZE}&$skip=${skip}`,
        { headers: authHeader }
      );
      if (!txRes.ok) throw new Error(`PM-Cost Detail fetch failed: ${txRes.status}`);
      const txData = await txRes.json();
      const rows   = txData.value ?? [];
      allTxRows    = allTxRows.concat(rows);
      if (rows.length < PAGE_SIZE) break;
      skip += PAGE_SIZE;
    }

    for (const row of allTxRows) {
      if (toYYYYMM(row.FinPeriod) > toYYYYMM(finPeriod)) continue;

      const key    = `${row.ProjectTask.trim()}|${row.CostCode.trim()}`;
      const amount = parseFloat(row.PMTran_amount) || 0;
      const fp     = row.FinPeriod;

      actualMap.set(key, (actualMap.get(key) || 0) + amount);

      if (!periodMap.has(key)) periodMap.set(key, new Map());
      periodMap.get(key).set(fp, (periodMap.get(key).get(fp) || 0) + amount);
const actualMap = new Map();
const periodMap = new Map();
const toYYYYMM  = (s) => s.slice(2) + s.slice(0, 2);

const uniqueCostCodes = [...new Set([...budgetMap.keys()].map(k => k.split('|')[1]))];

const authHeader = { 
  'Authorization': 'Basic ' + Buffer.from(user + ':' + pass).toString('base64'), 
  'Accept': 'application/json' 
};

const txResults = await Promise.all(
  uniqueCostCodes.map(cc =>
    fetch(
      `${ACUMATICA_BASE_URL}/odata/${ACUMATICA_TENANT}/PM-Cost%20Detail` +
      `?$filter=Project eq '${projectId} ' and CostCode eq '${cc} '` +
      `&$top=10000` +
      `&$select=ProjectTask,CostCode,PMTran_amount,FinPeriod,AccountGroup,Quantity,UOM,Date,AccountName,Description`,
      { headers: authHeader }
    )
    .then(r => r.ok ? r.json() : { value: [] })
    .catch(() => ({ value: [] }))
  )
);

const txMap = new Map(); // key -> current-period transaction rows

for (const txData of txResults) {
  for (const row of (txData.value ?? [])) {
    const ag = (row.AccountGroup || '').trim();
    if (ag === 'REV') continue;
    if (toYYYYMM(row.FinPeriod) > toYYYYMM(finPeriod)) continue;

    const key    = `${row.ProjectTask.trim()}|${row.CostCode.trim()}`;
    const amount = parseFloat(row.PMTran_amount) || 0;
    const fp     = row.FinPeriod;

    actualMap.set(key, (actualMap.get(key) || 0) + amount);

    if (!periodMap.has(key)) periodMap.set(key, new Map());
    periodMap.get(key).set(fp, (periodMap.get(key).get(fp) || 0) + amount);

    // Capture current-period rows for transaction detail
    if (fp === finPeriod) {
      if (!txMap.has(key)) txMap.set(key, []);
      txMap.get(key).push({
        date:         row.Date ? row.Date.split('T')[0] : null,
        accountGroup: ag,
        vendor:       row.AccountName ? row.AccountName.trim() : null,
        description:  row.Description ? row.Description.trim() : null,
        amount,
        qty:          parseFloat(row.Quantity) || 0,
        uom:          (row.UOM || '').trim(),
      });
}
  }
}
// ── 3. Join and build costLines ────────────────────────────────────
const costLines = [];
for (const [key, budget] of budgetMap) {
@@ -248,7 +262,7 @@ app.get('/snapshot/costlines', async (req, res) => {

// Sort periods descending, take 3 most recent, then reverse to oldest-first
const history = [...buckets.entries()]
        .sort((a, b) => toYYYYMM(b[0]).localeCompare(toYYYYMM(a[0])))
        .sort((a, b) => b[0].localeCompare(a[0]))
.slice(0, 3)
.reverse()
.map(([fp, spent]) => ({
@@ -266,6 +280,7 @@ app.get('/snapshot/costlines', async (req, res) => {
pendingBudget:  Math.round(budget.pendingBudget),
actual:         Math.round(actual),
history,
        transactions:   (txMap.get(key) || []).sort((a, b) => (a.date || '').localeCompare(b.date || '')),
});
}
