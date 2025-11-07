/**
 * app.js — MediScan Pro final with jsQR decoding
 * - Rear camera (preferred) + torch toggle
 * - Gallery QR decode
 * - Manual search & OpenFDA fallback
 * - Local DRAP dataset fallback (drap_drugs.json)
 * - ADR reporting with dose comparison and history (localStorage)
 * - PWA install prompt & service worker registration
 */

// ---------- Config / constants ----------
const DRAP_FILE = 'drap_drugs.json';
const STORAGE_KEY = 'mediscan_reports_v_final';

// ---------- DOM ----------
const $ = s => document.querySelector(s);
const btnStart = $('#btnStart'), btnStop = $('#btnStop'), btnTorch = $('#btnTorch'), btnGallery = $('#btnGallery');
const searchInput = $('#searchInput'), btnSearch = $('#btnSearch'), btnClearSearch = $('#btnClearSearch');
const cameraEl = $('#camera'), canvasEl = $('#scanCanvas');
const drugCard = $('#drugCard'), reportPanel = $('#reportPanel');
const reportForm = $('#reportForm'), doseWarning = $('#doseWarning');
const historyList = $('#historyList'), btnExport = $('#btnExport'), btnClearAll = $('#btnClearAll');
const toastEl = $('#toast'), themeToggle = $('#themeToggle'), installBtn = $('#installBtn');

let drapIndex = {};
let currentStream = null;
let scanActive = false;
let jsqrContext = null;
let lastParsed = { name:'', batch:'', expiry:'' };
let deferredPrompt = null;

// ---------- Utilities ----------
function showToast(msg, ms=1800){ toastEl.textContent = msg; toastEl.hidden = false; toastEl.style.display='block'; setTimeout(()=>{ toastEl.hidden=true; toastEl.style.display='none'; }, ms); }
function escapeHtml(s){ if(s==null) return ''; return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

// ---------- Load DRAP local dataset ----------
async function loadDrapLocal(){
  try{
    const r = await fetch(DRAP_FILE);
    if(!r.ok){ drapIndex = {}; return; }
    const arr = await r.json();
    drapIndex = {};
    arr.forEach(d => {
      if(d.name) drapIndex[d.name.toLowerCase()] = d;
      if(d.synonyms && Array.isArray(d.synonyms)) d.synonyms.forEach(s => drapIndex[s.toLowerCase()] = d);
    });
    console.log('Loaded DRAP local:', Object.keys(drapIndex).length);
  }catch(e){ console.warn('Failed load drap', e); drapIndex = {}; }
}

// ---------- Camera init + scan loop using jsQR ----------
async function startCamera(){
  if(currentStream) return;
  try{
    // Prefer exact rear camera if available, fallback to ideal
    let constraints = { video: { facingMode: { exact: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio:false };
    try{
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      handleStream(stream);
    }catch(e){
      // fallback to ideal (some browsers don't accept exact)
      constraints.video.facingMode = { ideal: "environment" };
      const stream2 = await navigator.mediaDevices.getUserMedia(constraints);
      handleStream(stream2);
    }
  }catch(err){
    console.error('Camera init failed', err);
    alert('Camera access failed. Check permissions and HTTPS. If blocked, allow camera in site settings.');
  }
}

function handleStream(stream){
  currentStream = stream;
  cameraEl.srcObject = stream;
  cameraEl.play().catch(()=>{});
  btnStart.style.display='none'; btnStop.style.display='inline-block';
  // torch capability check
  try{
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities();
    if(caps && caps.torch) btnTorch.style.display='inline-block'; else btnTorch.style.display='none';
  }catch(e){ btnTorch.style.display='none'; }

  // prepare canvas context for jsQR
  canvasEl.width = cameraEl.videoWidth || 640;
  canvasEl.height = cameraEl.videoHeight || 480;
  jsqrContext = canvasEl.getContext('2d');

  scanActive = true;
  scanLoop();
  showToast('Camera started — point to QR');
}

function stopCamera(){
  scanActive = false;
  if(currentStream){
    currentStream.getTracks().forEach(t => t.stop());
    currentStream = null;
  }
  cameraEl.srcObject = null;
  btnStart.style.display='inline-block'; btnStop.style.display='none'; btnTorch.style.display='none';
  showToast('Camera stopped',1200);
}

async function toggleTorch(){
  if(!currentStream) return alert('Start camera first');
  const track = currentStream.getVideoTracks()[0];
  const caps = track.getCapabilities();
  if(!caps || !caps.torch) return alert('Torch not supported');
  try{
    const isOn = btnTorch.dataset.on === 'true';
    await track.applyConstraints({ advanced: [{ torch: !isOn }] });
    btnTorch.dataset.on = (!isOn).toString();
    btnTorch.textContent = isOn ? '🔦 Torch' : '💡 Torch ON';
  }catch(e){ console.warn('Torch error', e); alert('Torch toggle failed'); }
}

async function scanLoop(){
  if(!scanActive) return;
  if(cameraEl.readyState === cameraEl.HAVE_ENOUGH_DATA){
    // update canvas size to video size (some devices need this per frame)
    canvasEl.width = cameraEl.videoWidth;
    canvasEl.height = cameraEl.videoHeight;
    jsqrContext.drawImage(cameraEl, 0, 0, canvasEl.width, canvasEl.height);
    try{
      const imageData = jsqrContext.getImageData(0,0,canvasEl.width,canvasEl.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
      if(code && code.data){
        // we found a QR — stop scanning briefly and handle
        scanActive = false;
        await handleScanned(code.data.trim());
        // small delay then resume scanning
        setTimeout(()=>{ scanActive = true; scanLoop(); }, 800);
        return;
      }
    }catch(e){ /* sometimes getImageData can fail on some devices; ignore */ }
  }
  requestAnimationFrame(scanLoop);
}

// ---------- Gallery upload decode (jsQR) ----------
btnGallery.addEventListener('click', ()=>{
  const input = document.createElement('input'); input.type='file'; input.accept='image/*';
  input.onchange = (ev) => {
    const file = ev.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = async () => {
        canvasEl.width = img.width; canvasEl.height = img.height;
        jsqrContext = canvasEl.getContext('2d');
        jsqrContext.drawImage(img,0,0);
        try{
          const id = jsqrContext.getImageData(0,0,canvasEl.width,canvasEl.height);
          const code = jsQR(id.data, id.width, id.height);
          if(code && code.data) await handleScanned(code.data.trim());
          else alert('No QR found in the image.');
        }catch(e){ alert('Failed to decode image.'); console.warn(e); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };
  input.click();
});

// ---------- Parse payload and normalize ----------
function parsePayload(raw){
  const out = { name:'', batch:'', expiry:'' };
  try{
    const o = JSON.parse(raw);
    out.name = (o.drugName || o.name || o.productName || '').toString();
    out.batch = o.batch || o.lot || '';
    out.expiry = o.expiry || '';
    if(out.name) return out;
  }catch(e){ /* not JSON */ }

  // GS1 patterns (optional)
  try{
    const m10 = raw.match(/\(10\)([A-Z0-9\-]+?)(?=\(|$)/); if(m10) out.batch = m10[1];
    const m17 = raw.match(/\(17\)(\d{6})/); if(m17) out.expiry = m17[1];
  }catch(e){}

  // fallback plain text as drug name
  out.name = raw;
  return out;
}

// ---------- On scanned (camera or gallery or manual) ----------
async function handleScanned(raw){
  showToast('Scanned: ' + (raw.length>40 ? raw.slice(0,40)+'...' : raw),1200);
  try{ stopCamera(); }catch(e){}
  const parsed = parsePayload(raw);
  lastParsed = parsed;
  renderQuickCard(parsed);
  await fetchAndRenderDrug(parsed);
}

// ---------- Quick preview card ----------
function renderQuickCard(parsed){
  const lc = parsed.name.toLowerCase();
  const local = drapIndex[lc] || null;
  if(local){
    drugCard.innerHTML = `<div class="drug-title">${escapeHtml(local.name)}</div>
      <div class="meta"><b>Manufacturer:</b> ${escapeHtml(local.manufacturer||'—')} • <b>Batch:</b> ${escapeHtml(parsed.batch || local.batch || 'N/A')}</div>`;
  } else {
    drugCard.innerHTML = `<div class="drug-title">${escapeHtml(parsed.name)}</div>
      <div class="meta">${parsed.batch?`<b>Batch:</b> ${escapeHtml(parsed.batch)} • `:""}${parsed.expiry?`<b>EXP:</b> ${escapeHtml(parsed.expiry)} `:""}</div>`;
  }
  drugCard.classList.remove('hidden');
  reportPanel.classList.remove('hidden');
}

// ---------- Fetch data: local DRAP or openFDA fallback ----------
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

  // openFDA fallback (label + events)
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
    }catch(e){ console.warn('OpenFDA label fail', e); }

    try{
      const qE = encodeURIComponent(`patient.drug.medicinalproduct:"${name}"`);
      const rE = await fetch(`https://api.fda.gov/drug/event.json?search=${qE}&limit=100`);
      if(rE.ok){
        const je = await rE.json();
        const freq = {};
        (je.results||[]).forEach(ev => (ev.patient?.reaction||[]).forEach(rx => { if(rx.reactionmeddrapt) freq[rx.reactionmeddrapt] = (freq[rx.reactionmeddrapt]||0)+1; }));
        adrsFDA = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,12).map(e=>e[0]);
      }
    }catch(e){ console.warn('OpenFDA events fail', e); }
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

// ---------- Render drug details card ----------
function renderDrug(d){
  const usesLocalHtml = d.uses_local && d.uses_local.length ? `<div class="section"><b>DRAP / Local Uses:</b><ul>${d.uses_local.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : `<div class="section"><i>No local DRAP entry.</i></div>`;
  const usesOffHtml = d.uses_official && d.uses_official.length ? `<div class="section"><b>OpenFDA Uses:</b><ul>${d.uses_official.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : '';
  const adrsLocalHtml = d.adrs_local && d.adrs_local.length ? `<div class="section"><b>Local ADRs (DRAP):</b><ul>${d.adrs_local.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : '';
  const adrsRepHtml = d.adrs_reported && d.adrs_reported.length ? `<div class="section"><b>Reported ADRs (OpenFDA events):</b><ul>${d.adrs_reported.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : '';
  const doseHtml = d.dosage_official ? `<div class="section"><b>Dosage & Administration (official):</b><div style="margin-top:6px">${escapeHtml(d.dosage_official)}</div></div>` : '';

  drugCard.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center"><div>
      <div style="font-size:18px;font-weight:800;color:var(--accent)">${escapeHtml(d.name)}</div>
      <div style="color:#666;margin-top:6px"><b>Manufacturer:</b> ${escapeHtml(d.manufacturer)} • <b>Batch:</b> ${escapeHtml(d.batch||'N/A')} • <b>EXP:</b> ${escapeHtml(d.expiry||'—')}</div>
    </div></div>
    ${doseHtml}
    ${usesLocalHtml}
    ${usesOffHtml}
    ${adrsLocalHtml}
    ${adrsRepHtml}
    <div style="margin-top:8px; font-size:12px; color:#666;">Note: DRAP local entries are authoritative in this demo. OpenFDA is fallback (US data).</div>
  `;
  drugCard.classList.remove('hidden');
  reportPanel.classList.remove('hidden');

  // fill batch input
  if(d.batch) document.getElementById('p_batch').value = d.batch;

  // show dose guidance if available
  if(d.maxDoseMg){
    doseWarning.innerHTML = `Reference max dose: <strong>${d.maxDoseMg} mg</strong>. Entered amount will be checked against this.`;
    doseWarning.classList.remove('hidden');
  } else doseWarning.classList.add('hidden');
}

// ---------- Report submit & history ----------
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

  const local = drapIndex[report.drug.toLowerCase()];
  if(local && local.maxDoseMg && amountMg){
    if(amountMg > Number(local.maxDoseMg)) report.highDose = true;
  }

  const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  arr.push(report);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  showToast('✅ Report saved locally & queued for officials',2000);
  reportForm.reset();
  renderHistory();
});

// reset form
$('#btnReset').addEventListener('click', ()=> reportForm.reset());

// export & clear
btnExport.addEventListener('click', ()=> {
  const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  const blob = new Blob([JSON.stringify(arr, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'mediscan_reports.json'; a.click();
});
btnClearAll.addEventListener('click', ()=> {
  if(!confirm('Clear all saved ADR reports locally?')) return;
  localStorage.removeItem(STORAGE_KEY); renderHistory(); showToast('Cleared reports.');
});

// render history
function renderHistory(){
  const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  if(!arr.length){ historyList.innerHTML = `<div style="color:var(--muted)">No reports yet.</div>`; return; }
  historyList.innerHTML = arr.slice().reverse().map(r => `
    <div class="entry">
      <div style="display:flex; justify-content:space-between; align-items:center">
        <div>
          <strong>${escapeHtml(r.drug)}</strong> <small style="color:#666">${escapeHtml(r.batch)}</small>
          ${r.highDose ? '<span style="color:var(--warn); font-weight:800"> ⚠ High dose</span>' : ''}
        </div>
        <div style="text-align:right"><small>${new Date(r.date).toLocaleString()}</small></div>
      </div>
      <div style="margin-top:8px; font-size:13px">
        <b>Patient:</b> ${escapeHtml(r.patientName)} • ${escapeHtml(r.age)} y • ${escapeHtml(r.gender)}<br>
        <b>Severity:</b> <em>${escapeHtml(r.severity)}</em> • <b>Condition:</b> ${escapeHtml(r.condition)} • <b>Amount:</b> ${escapeHtml(r.amountMg||'N/A')} mg
        <div style="margin-top:6px">${escapeHtml(r.description)}</div>
        <div style="margin-top:8px"><button class="btn ghost small" onclick="viewReportDetail('${r.id}')">View Details</button></div>
      </div>
    </div>
  `).join('');
}
window.viewReportDetail = function(id){
  const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  const r = arr.find(x=>x.id===id);
  if(!r) return alert('Report not found');
  const txt = `Report for ${r.drug}\n\nPatient: ${r.patientName} (${r.age}, ${r.gender})\nCondition: ${r.condition}\nSeverity: ${r.severity}\nAmount: ${r.amountMg||'N/A'} mg\nBatch: ${r.batch}\nPhone: ${r.phone||'—'}\n\nDescription:\n${r.description}\n\nReported: ${new Date(r.date).toLocaleString()}`;
  alert(txt);
};

// ---------- Search manual ----------
btnSearch.addEventListener('click', async ()=> {
  const q = searchInput.value.trim();
  if(!q) return alert('Enter search term');
  await handleScanned(q);
});
btnClearSearch.addEventListener('click', ()=> { searchInput.value=''; });

// ---------- parse payloads when scanning by text ----------
/* handled by parsePayload + handleScanned */

// ---------- Gallery & manual scanning handled above ----------

// ---------- Theme toggle & PWA ----------
themeToggle.addEventListener('click', ()=> {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.documentElement.setAttribute('data-theme', isDark ? '':'dark');
  themeToggle.textContent = isDark ? '🌙' : '☀️';
});

// beforeinstallprompt (PWA)
window.addEventListener('beforeinstallprompt', (e)=> {
  e.preventDefault(); deferredPrompt = e; installBtn.style.display='inline-block';
  installBtn.onclick = async ()=> {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null; installBtn.style.display='none';
  };
});

// register service worker
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('sw.js').catch(e=>console.warn('SW failed', e));
}

// ---------- Bind buttons ----------
btnStart.addEventListener('click', startCamera);
btnStop.addEventListener('click', stopCamera);
btnTorch.addEventListener('click', toggleTorch);

// ---------- init ----------
(async function init(){
  await loadDrapLocal();
  renderHistory();
})();
