/**
 * app.js — Final MediScan Pro
 * - Robust camera start (html5-qrcode with rear preference)
 * - Separate getUserMedia track for torch support
 * - Theme toggle with persistence
 * - DRAP local + openFDA fallback
 * - Dose comparison, ADR reporting, chart, PWA support
 */

const DRAP_FILE = 'drap_drugs.json';
const STORAGE_KEY = 'mediscan_reports_final_v1';

/* ----------------- DOM helpers ----------------- */
const $ = s => document.querySelector(s);
const showToast = (msg, time=2000) => {
  const el = $('#toast'); el.textContent = msg; el.hidden=false; el.style.display='block';
  setTimeout(()=>{ el.hidden=true; el.style.display='none'; }, time);
};

/* ----------------- state ----------------- */
let drapIndex = {};
let html5QrCode = null;
let lastTrack = null;
let lastParsed = { name:'', batch:'', expiry:'' };
let severityChart = null;

/* ----------------- DOM refs ----------------- */
const btnStart = $('#btnStart'), btnStop = $('#btnStop'), btnTorch = $('#btnTorch');
const btnGallery = $('#btnGallery'), btnManual = $('#btnManual');
const scannerFallback = $('#scannerFallback'), qrReader = $('#qr-reader');
const drugCard = $('#drugCard'), reportPanel = $('#reportPanel'), reportForm = $('#reportForm');
const historyList = $('#historyList'), btnSearch = $('#btnSearch'), searchInput = $('#searchInput');
const btnExport = $('#btnExport'), btnClearAll = $('#btnClearAll'), doseWarning = $('#doseWarning');
const themeToggle = $('#themeToggle'), installBtn = $('#installBtn');

/* ----------------- Load local DRAP dataset ----------------- */
async function loadDrapLocal(){
  try{
    const res = await fetch(DRAP_FILE);
    if(!res.ok){ drapIndex = {}; console.warn('DRAP file missing'); return; }
    const arr = await res.json();
    drapIndex = {};
    arr.forEach(d => {
      if(d.name) drapIndex[d.name.toLowerCase()] = d;
      if(d.synonyms && Array.isArray(d.synonyms)) d.synonyms.forEach(s => drapIndex[s.toLowerCase()] = d);
    });
    console.log('DRAP loaded:', Object.keys(drapIndex).length);
  }catch(e){ console.warn('DRAP load error', e); drapIndex = {}; }
}

/* ----------------- Camera & scanning (html5-qrcode) ----------------- */
async function startCameraScan(){
  try{ await stopCameraScan(); } catch(e){}
  if(!html5QrCode) html5QrCode = new Html5Qrcode("qr-reader", { verbose:false });

  try{
    const devices = await Html5Qrcode.getCameras();
    if(!devices || devices.length === 0){ alert('No camera found'); return; }
    // prefer a rear camera (match label)
    const back = devices.find(d => /back|rear|environment/i.test(d.label)) || devices[0];
    const deviceId = back.id;

    scannerFallback.style.display = 'none';

    await html5QrCode.start(
      { deviceId: { exact: deviceId } },
      { fps: 10, qrbox: { width: 280, height: 280 } },
      async decodedText => { await onScanned(decodedText); },
      err => { /* scanning */ }
    );

    // open a separate stream to get the MediaStreamTrack for torch
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
      lastTrack = stream.getVideoTracks()[0];
      const caps = lastTrack.getCapabilities();
      if(caps && caps.torch) btnTorch.style.display = 'inline-block'; else btnTorch.style.display = 'none';
    }catch(e){ lastTrack = null; btnTorch.style.display = 'none'; }

    btnStart.style.display = 'none'; btnStop.style.display = 'inline-block';
    showToast('Camera started — point to QR');
  }catch(err){
    console.error('startCameraScan error', err);
    alert('Camera start failed: ' + (err.message || err));
    scannerFallback.style.display = 'block';
  }
}

async function stopCameraScan(){
  try{ if(html5QrCode) await html5QrCode.stop(); }catch(e){ console.warn(e); }
  if(lastTrack){ try{ lastTrack.stop(); }catch(e){} lastTrack = null; }
  scannerFallback.style.display = 'block';
  btnStart.style.display = 'inline-block'; btnStop.style.display = 'none'; btnTorch.style.display = 'none';
}

let torchOn = false;
async function toggleTorch(){
  if(!lastTrack) return alert('Torch unavailable on this device/browser.');
  try{
    const caps = lastTrack.getCapabilities();
    if(!caps.torch) return alert('Torch not supported.');
    torchOn = !torchOn;
    await lastTrack.applyConstraints({ advanced: [{ torch: torchOn }]});
    showToast(torchOn ? 'Torch ON' : 'Torch OFF');
  }catch(e){ console.warn('toggleTorch', e); alert('Torch control failed'); }
}

/* ----------------- Gallery decode (jsQR) ----------------- */
btnGallery.addEventListener('click', () => {
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
  input.onchange = (ev) => {
    const file = ev.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
        try{
          const id = ctx.getImageData(0,0,canvas.width,canvas.height);
          const code = jsQR(id.data, id.width, id.height, { inversionAttempts: 'attemptBoth' });
          if(code && code.data) onScanned(code.data.trim());
          else alert('No QR code detected in the image.');
        }catch(e){ alert('Image decode error.'); console.warn(e); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };
  input.click();
});

/* ----------------- Manual input & search ----------------- */
btnManual.addEventListener('click', () => {
  const q = prompt('Enter drug name or JSON payload (e.g., {"drugName":"Augmentin","batch":"A1","expiry":"12/2026"})');
  if(q) onScanned(q.trim());
});
btnSearch.addEventListener('click', () => {
  const q = searchInput.value.trim();
  if(!q) return alert('Type a drug name to search.');
  onScanned(q);
});

/* ----------------- Parse scanned payload ----------------- */
function parsePayload(raw){
  const out = { name:'', batch:'', expiry:'' };
  try{
    const o = JSON.parse(raw);
    out.name = (o.drugName || o.name || o.productName || '').toString();
    out.batch = o.batch || o.lot || '';
    out.expiry = o.expiry || '';
    if(out.name) return out;
  }catch(e){}
  try{
    const m10 = raw.match(/\(10\)([A-Z0-9\-]+?)(?=\(|$)/); if(m10) out.batch = m10[1];
    const m17 = raw.match(/\(17\)(\d{6})/); if(m17) out.expiry = m17[1];
  }catch(e){}
  if(!out.name) out.name = raw;
  return out;
}

/* ----------------- On scanned result ----------------- */
async function onScanned(raw){
  showToast('Scanned: ' + (raw.length>40 ? raw.slice(0,40) + '...' : raw), 1200);
  try{ await stopCameraScan(); }catch(e){}
  const parsed = parsePayload(raw);
  lastParsed = parsed;
  renderQuickCard(parsed);
  await fetchAndRenderDrug(parsed);
  reportPanel.classList.remove('hidden');
}

/* ----------------- Render quick card ----------------- */
function renderQuickCard(parsed){
  const lc = (parsed.name||'').toLowerCase();
  const local = drapIndex[lc] || null;
  if(local){
    drugCard.innerHTML = `<div class="drug-title">${escapeHtml(local.name)}</div>
      <div class="meta"><b>Manufacturer:</b> ${escapeHtml(local.manufacturer||'—')} • <b>Batch:</b> ${escapeHtml(parsed.batch || local.batch || 'N/A')}</div>`;
  } else {
    drugCard.innerHTML = `<div class="drug-title">${escapeHtml(parsed.name)}</div>
      <div class="meta">${parsed.batch?`<b>Batch:</b> ${escapeHtml(parsed.batch)} • `:""}${parsed.expiry?`<b>EXP:</b> ${escapeHtml(parsed.expiry)} `:""}</div>`;
  }
  drugCard.classList.remove('hidden');
}

/* ----------------- Fetch & merge data (local DRAP or OpenFDA fallback) ----------------- */
async function fetchAndRenderDrug(parsed){
  const name = (parsed.name||'').trim();
  if(!name){ drugCard.innerHTML = '<div>No drug name detected.</div>'; return; }

  // local lookup
  let local = drapIndex[name.toLowerCase()] || null;
  if(!local){
    for(const k in drapIndex){
      if(k.includes(name.toLowerCase()) || (drapIndex[k].synonyms && drapIndex[k].synonyms.join(' ').toLowerCase().includes(name.toLowerCase()))) { local = drapIndex[k]; break; }
    }
  }

  // OpenFDA fallback
  let usesFDA = [], adrsFDA = [], doseFDA = '';
  if(!local){
    try{
      const q = encodeURIComponent(`openfda.brand_name:"${name}"`);
      const r = await fetch(`https://api.fda.gov/drug/label.json?search=${q}&limit=1`);
      if(r.ok){
        const j = await r.json();
        const ind = j.results?.[0]?.indications_and_usage || j.results?.[0]?.purpose || j.results?.[0]?.description || [];
        usesFDA = Array.isArray(ind) ? ind.slice(0,6) : (typeof ind==='string' ? [ind] : []);
        const dosage = j.results?.[0]?.dosage_and_administration || j.results?.[0]?.how_supplied || '';
        doseFDA = Array.isArray(dosage) ? dosage.slice(0,2).join(' ') : String(dosage || '');
      }
    }catch(e){ console.warn('OpenFDA label error', e); }

    try{
      const qE = encodeURIComponent(`patient.drug.medicinalproduct:"${name}"`);
      const rE = await fetch(`https://api.fda.gov/drug/event.json?search=${qE}&limit=100`);
      if(rE.ok){
        const je = await rE.json();
        const freq = {};
        (je.results||[]).forEach(ev => (ev.patient?.reaction||[]).forEach(rx => { if(rx.reactionmeddrapt) freq[rx.reactionmeddrapt] = (freq[rx.reactionmeddrapt]||0)+1; }));
        adrsFDA = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,12).map(e=>e[0]);
      }
    }catch(e){ console.warn('OpenFDA event error', e); }
  }

  const merged = {
    name: local?.name || name,
    manufacturer: local?.manufacturer || 'Unknown',
    batch: parsed.batch || local?.batch || '',
    expiry: parsed.expiry || local?.expiry || '',
    uses_local: local?.uses || [],
    adrs_local: local?.adrs || [],
    uses_official: usesFDA,
    adrs_reported: adrsFDA,
    dosage_official: local?.dosage || doseFDA || '',
    maxDoseMg: local?.maxDoseMg || null
  };

  renderDrug(merged);
}

/* ----------------- Render full drug card ----------------- */
function renderDrug(d){
  const usesLocalHtml = d.uses_local && d.uses_local.length ? `<div class="section"><b>DRAP / Local Uses:</b><ul>${d.uses_local.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : `<div class="section"><i>No local DRAP entry.</i></div>`;
  const usesOffHtml = d.uses_official && d.uses_official.length ? `<div class="section"><b>OpenFDA Uses:</b><ul>${d.uses_official.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : '';
  const adrsLocalHtml = d.adrs_local && d.adrs_local.length ? `<div class="section"><b>Local ADRs (DRAP):</b><ul>${d.adrs_local.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : '';
  const adrsRepHtml = d.adrs_reported && d.adrs_reported.length ? `<div class="section"><b>Reported ADRs (OpenFDA events):</b><ul>${d.adrs_reported.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : '';
  const doseHtml = d.dosage_official ? `<div class="section"><b>Dosage & Administration (official):</b><div style="margin-top:6px">${escapeHtml(d.dosage_official)}</div></div>` : '';

  drugCard.innerHTML = `
    <div class="drug-title">${escapeHtml(d.name)}</div>
    <div class="meta"><b>Manufacturer:</b> ${escapeHtml(d.manufacturer)} • <b>Batch:</b> ${escapeHtml(d.batch||'N/A')} • <b>EXP:</b> ${escapeHtml(d.expiry||'—')}</div>
    ${doseHtml}
    ${usesLocalHtml}
    ${usesOffHtml}
    ${adrsLocalHtml}
    ${adrsRepHtml}
    <div style="margin-top:8px; font-size:12px; color:#666;">Note: DRAP local entries are authoritative. OpenFDA is fallback and shows reported events.</div>
  `;
  drugCard.classList.remove('hidden');
  reportPanel.classList.remove('hidden');

  if(d.batch) document.getElementById('p_batch').value = d.batch;
  if(d.maxDoseMg){
    doseWarning.innerHTML = `Reference max dose: <strong>${d.maxDoseMg} mg</strong>. Entered amount will be checked against this.`;
    doseWarning.classList.remove('hidden');
  } else doseWarning.classList.add('hidden');
}

/* ----------------- ADR Reporting ----------------- */
reportForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const amountMg = Number(document.getElementById('p_amount_mg').value || 0);
  const report = {
    id: 'r_'+Date.now(),
    drug: (drugCard.querySelector('.drug-title')?.textContent || lastParsed.name || 'Unknown'),
    batch: document.getElementById('p_batch').value || lastParsed.batch || '',
    patientName: document.getElementById('p_name').value.trim(),
    age: document.getElementById('p_age').value.trim(),
    gender: document.getElementById('p_gender').value.trim(),
    phone: document.getElementById('p_phone').value.trim(),
    condition: document.getElementById('p_condition').value.trim(),
    severity: document.getElementById('p_severity').value.trim(),
    amountMg: amountMg,
    description: document.getElementById('p_desc').value.trim(),
    date: new Date().toISOString(),
    highDose: false
  };

  if(!report.patientName || !report.age || !report.gender || !report.condition || !report.severity || !report.description){
    alert('Please fill required fields.');
    return;
  }

  // high dose check
  const local = drapIndex[report.drug.toLowerCase()];
  if(local && local.maxDoseMg && amountMg) {
    if(amountMg > Number(local.maxDoseMg)) report.highDose = true;
  }

  const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  arr.push(report);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  showToast('✅ Report saved locally & submitted (demo).', 2000);
  reportForm.reset();
  renderHistory();
  updateChart();
});

/* ----------------- Export & Clear ----------------- */
$('#btnClear').addEventListener('click', ()=> reportForm.reset());
btnExport.addEventListener('click', ()=> {
  const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  const blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'mediscan_reports.json'; a.click();
});
btnClearAll.addEventListener('click', ()=> {
  if(!confirm('Clear all saved ADR reports locally?')) return;
  localStorage.removeItem(STORAGE_KEY);
  renderHistory();
  updateChart();
  showToast('Cleared reports.');
});

/* ----------------- History & details ----------------- */
function renderHistory(){
  const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  if(!arr.length){ historyList.innerHTML = `<div style="color:var(--muted)">No reports yet.</div>`; return; }
  historyList.innerHTML = arr.slice().reverse().map(r => `
    <div class="entry">
      <div style="display:flex; justify-content:space-between; align-items:center">
        <div>
          <strong>${escapeHtml(r.drug)}</strong> <small style="color:#666">${escapeHtml(r.batch)}</small>
          ${r.highDose ? '<span class="dose-flag"> ⚠ High dose</span>' : ''}
        </div>
        <div style="text-align:right"><small>${new Date(r.date).toLocaleString()}</small></div>
      </div>
      <div style="margin-top:8px; font-size:13px">
        <b>Patient:</b> ${escapeHtml(r.patientName)} • ${escapeHtml(r.age)} y • ${escapeHtml(r.gender)}<br>
        <b>Severity:</b> <span class="${r.severity==='Severe' ? 'dose-flag' : (r.severity==='Moderate' ? 'pill' : '')}">${escapeHtml(r.severity)}</span> • <b>Condition:</b> ${escapeHtml(r.condition)} • <b>Amount:</b> ${escapeHtml(r.amountMg||'N/A')} mg
        <div style="margin-top:6px">${escapeHtml(r.description)}</div>
        <div style="margin-top:8px"><button class="btn ghost small" onclick="viewReportDetail('${r.id}')">View Details</button></div>
      </div>
    </div>
  `).join('');
}

window.viewReportDetail = function(id){
  const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  const r = arr.find(x => x.id === id);
  if(!r) return alert('Report not found');
  const txt = `Report for ${r.drug}\n\nPatient: ${r.patientName} (${r.age}, ${r.gender})\nCondition: ${r.condition}\nSeverity: ${r.severity}\nAmount: ${r.amountMg||'N/A'} mg\nBatch: ${r.batch}\nPhone: ${r.phone||'—'}\n\nDescription:\n${r.description}\n\nReported: ${new Date(r.date).toLocaleString()}`;
  alert(txt);
};

/* ----------------- Chart ----------------- */
function updateChart(){
  const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  const counts = { Mild:0, Moderate:0, Severe:0 };
  arr.forEach(r => { if(r.severity in counts) counts[r.severity]++; });
  const data = [counts.Mild, counts.Moderate, counts.Severe];
  if(!severityChart){
    const ctx = document.getElementById('severityChart').getContext('2d');
    severityChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Mild','Moderate','Severe'],
        datasets: [{ data, backgroundColor: ['#60a5fa','#f59e0b','#ef4444'] }]
      },
      options: { plugins:{ legend:{ position:'bottom' } } }
    });
  } else {
    severityChart.data.datasets[0].data = data;
    severityChart.update();
  }
}

/* ----------------- Theme toggle ----------------- */
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
}

themeToggle.addEventListener('click', () => {
  const cur = localStorage.getItem('theme') || 'light';
  applyTheme(cur === 'light' ? 'dark' : 'light');
});

/* ----------------- Utilities ----------------- */
function escapeHtml(s){ if(!s && s!==0) return ''; return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

/* ----------------- Bindings ----------------- */
btnStart.addEventListener('click', startCameraScan);
btnStop.addEventListener('click', stopCameraScan);
btnTorch.addEventListener('click', toggleTorch);

/* ----------------- PWA install handling ----------------- */
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.style.display = 'inline-block';
  installBtn.onclick = async () => {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installBtn.style.display = 'none';
  };
});

/* ----------------- init ----------------- */
(async function init(){
  // set theme from localStorage
  const saved = localStorage.getItem('theme') || 'light';
  applyTheme(saved);

  await loadDrapLocal();
  renderHistory();
  updateChart();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e=>console.warn('SW failed', e));
})();
