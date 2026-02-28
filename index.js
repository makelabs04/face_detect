const express = require('express');
const mysql   = require('mysql2');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── STATIC FILES (models + faceapi.js) ──────────────────────────────────────
app.use('/models',   express.static(path.join(__dirname, 'public', 'models')));
app.use('/faceapi.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'faceapi.js')));

// ─── MYSQL ────────────────────────────────────────────────────────────────────
// ⚠️  Change these to your MySQL credentials
// Hostinger: get from hPanel → Databases → MySQL Databases
const DB_CONFIG = {
  host     : 'localhost',
  port     : 3306,
  user     : 'root',
  password : '',
  database : 'face_recognition'
};

const db = mysql.createConnection(DB_CONFIG);

db.connect(err => {
  if (err) {
    console.error('\n❌ MySQL connection failed!');
    console.error('   Error   :', err.message);
    console.error('   HOW TO FIX:');
    console.error('   1. Start MySQL (XAMPP/WAMP/MySQL service)');
    console.error('   2. Run: CREATE DATABASE face_recognition;');
    console.error('   3. Update DB_CONFIG in index.js\n');
    process.exit(1);
  }
  console.log('✅ MySQL connected →', DB_CONFIG.database);
  db.query(`
    CREATE TABLE IF NOT EXISTS faces (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      label       VARCHAR(100) NOT NULL UNIQUE,
      descriptor  LONGTEXT NOT NULL,
      visit_count INT DEFAULT 1,
      first_seen  DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_seen   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `, err => { if (!err) console.log('✅ faces table ready'); });
});

// ─── AUTO DOWNLOAD face-api.js BROWSER BUILD + MODELS ─────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');
const MODELS_DIR = path.join(PUBLIC_DIR, 'models');
const FACEAPI_PATH = path.join(PUBLIC_DIR, 'faceapi.js');

// Browser-compatible UMD build from unpkg (downloaded ONCE, saved locally)
const FACEAPI_URL = 'https://unpkg.com/face-api.js@0.22.2/dist/face-api.min.js';

const MODEL_FILES = [
  'ssd_mobilenetv1_model-weights_manifest.json',
  'ssd_mobilenetv1_model-shard1',
  'ssd_mobilenetv1_model-shard2',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model-shard1',
  'face_recognition_model-shard2',
];
const MODEL_BASE_URL = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) return resolve(false);
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close(); fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(); try { fs.unlinkSync(dest); } catch(_) {}
        return reject(new Error('HTTP ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(true); });
    }).on('error', e => { try { fs.unlinkSync(dest); } catch(_) {} reject(e); });
  });
}

async function setup() {
  if (!fs.existsSync(PUBLIC_DIR))  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  if (!fs.existsSync(MODELS_DIR))  fs.mkdirSync(MODELS_DIR, { recursive: true });

  // Download face-api.js browser UMD build
  if (!fs.existsSync(FACEAPI_PATH)) {
    process.stdout.write('📥 Downloading face-api.js browser build... ');
    try { await download(FACEAPI_URL, FACEAPI_PATH); console.log('✅'); }
    catch(e) { console.log('❌ ' + e.message); }
  } else {
    console.log('✅ face-api.js cached');
  }

  // Download model weight files
  const missing = MODEL_FILES.filter(f => !fs.existsSync(path.join(MODELS_DIR, f)));
  if (!missing.length) { console.log('✅ All models cached'); return; }
  console.log('📥 Downloading ' + missing.length + ' model files...');
  for (const f of missing) {
    process.stdout.write('   ' + f + ' ... ');
    try { await download(MODEL_BASE_URL + f, path.join(MODELS_DIR, f)); console.log('✅'); }
    catch(e) { console.log('❌ ' + e.message); }
  }
  console.log('✅ Models ready');
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function dbQuery(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows))
  );
}

function timeAgo(ds) {
  const diff = (Date.now() - new Date(ds)) / 1000;
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function euclidean(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

function escH(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])
  );
}

const THRESHOLD        = 0.6;
const REGISTER_SAMPLES = 5;

// ─── HTML ─────────────────────────────────────────────────────────────────────
function getHTML(faces) {
  const cards = faces.map(f => `
    <div class="face-card" id="fc-${f.id}" data-name="${escH(f.label.toLowerCase())}">
      <div class="face-top">
        <div class="face-avatar">${f.label[0].toUpperCase()}</div>
        <div class="face-info">
          <div class="face-name">${escH(f.label)}</div>
          <div class="face-meta">ID #${f.id} &middot; ${timeAgo(f.last_seen)}</div>
        </div>
        <button class="del-btn" data-id="${f.id}" data-label="${escH(f.label)}" onclick="delFaceBtn(this)">Delete</button>
      </div>
      <div class="face-stats">
        <div class="fstat"><span>${f.visit_count}</span>Visits</div>
        <div class="fstat"><span>${timeAgo(f.first_seen)}</span>Registered</div>
        <div class="fstat"><span>${timeAgo(f.last_seen)}</span>Last Seen</div>
      </div>
    </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Face Recognition</title>
<style>
:root{--bg:#080c14;--surface:#0e1420;--card:#131c2e;--border:#1e2d45;--accent:#3b82f6;--accent2:#06b6d4;--green:#10b981;--red:#ef4444;--yellow:#f59e0b;--text:#e2e8f0;--muted:#4a5568}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Tahoma,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
nav{background:rgba(8,12,20,0.97);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 28px;height:58px;position:sticky;top:0;z-index:50}
.nav-brand{font-family:monospace;font-size:1rem;font-weight:700;letter-spacing:2px}.nav-brand span{color:var(--accent)}
.nav-tabs{display:flex;gap:4px}
.nav-tab{padding:7px 18px;border-radius:8px;font-size:0.82rem;font-weight:600;cursor:pointer;border:none;background:transparent;color:var(--muted);transition:all 0.2s;font-family:inherit}
.nav-tab:hover,.nav-tab.active{background:var(--card);color:var(--text)}.nav-tab.active{color:var(--accent)}
.nav-dot{font-family:monospace;font-size:0.7rem;color:var(--muted)}
.page{display:none;max-width:1280px;margin:0 auto;padding:24px}.page.show{display:block}
.cam-layout{display:grid;grid-template-columns:1fr 340px;gap:18px}
.main-col{display:flex;flex-direction:column;gap:14px}
.video-card{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden}
.video-wrap{position:relative;background:#000;min-height:180px}
#video{width:100%;display:block}
#overlay{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none}
.status-strip{background:rgba(0,0,0,0.88);display:flex;align-items:center;gap:10px;padding:10px 16px;font-size:0.8rem}
.sled{width:7px;height:7px;border-radius:50%;background:var(--muted);flex-shrink:0;transition:background 0.3s}
.sled.pulse{background:var(--yellow);animation:blink 1s infinite}.sled.ok{background:var(--green)}.sled.bad{background:var(--red)}
.vid-btns{display:flex;gap:10px;padding:12px 14px;background:var(--surface)}
.btn{flex:1;padding:11px 14px;border:none;border-radius:10px;font-family:inherit;font-size:0.85rem;font-weight:600;cursor:pointer;transition:all 0.18s}
.btn:disabled{opacity:0.3;cursor:not-allowed}
.btn-blue{background:var(--accent);color:#fff}.btn-blue:hover:not(:disabled){background:#2563eb;transform:translateY(-1px)}
.btn-cyan{background:var(--accent2);color:#000}.btn-cyan:hover:not(:disabled){background:#0891b2;transform:translateY(-1px)}
.btn-red{background:var(--red);color:#fff}
.debug-bar{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 14px;font-family:monospace;font-size:0.69rem;color:var(--muted);display:flex;gap:14px;flex-wrap:wrap}
.debug-bar span{color:var(--accent2)}
.rc{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;display:none}.rc.show{display:block}
.rc-title{font-family:monospace;font-size:0.67rem;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase;margin-bottom:10px}
.r-badge{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:100px;font-size:0.85rem;font-weight:700;margin-bottom:10px}
.r-badge.ok{background:rgba(16,185,129,0.12);color:var(--green);border:1px solid rgba(16,185,129,0.25)}
.r-badge.unk{background:rgba(239,68,68,0.12);color:var(--red);border:1px solid rgba(239,68,68,0.25)}
.r-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
.r-mi{background:var(--surface);border-radius:8px;padding:9px;text-align:center}
.r-mi .v{font-family:monospace;font-size:1.1rem;font-weight:700;color:var(--accent)}
.r-mi .k{font-size:0.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:2px}
.reg-form{display:flex;gap:8px;margin-top:8px}
.reg-inp{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-family:inherit;font-size:0.85rem;outline:none;transition:border-color 0.2s}
.reg-inp:focus{border-color:var(--accent)}.reg-inp::placeholder{color:var(--muted)}
.reg-btn{padding:9px 14px;background:var(--green);color:#000;border:none;border-radius:8px;font-weight:700;font-size:0.8rem;cursor:pointer;font-family:inherit}
.reg-btn:hover{background:#059669}
.prog-label{font-size:0.72rem;color:var(--muted);margin-bottom:4px}
.prog-wrap{background:var(--surface);border-radius:4px;height:4px;margin-bottom:8px;overflow:hidden}
.prog-bar{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));transition:width 0.3s;width:0}
.sidebar{display:flex;flex-direction:column;gap:14px}
.s-card{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.s-head{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
.s-head h3{font-family:monospace;font-size:0.7rem;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase}
.s-badge{background:rgba(59,130,246,0.15);color:var(--accent);font-size:0.7rem;font-weight:700;padding:2px 8px;border-radius:20px}
.stats-row{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border)}
.stat-box{background:var(--card);padding:14px;text-align:center}
.stat-box .sv{font-family:monospace;font-size:1.6rem;font-weight:700;color:var(--accent)}
.stat-box .sk{font-size:0.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:2px}
.faces-scroll{max-height:330px;overflow-y:auto}
.faces-scroll::-webkit-scrollbar{width:3px}
.faces-scroll::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.mini-face{display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid rgba(30,45,69,0.5);gap:10px}
.mini-face:last-child{border-bottom:none}
.mini-av{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#1e3a5f,#2d5a8e);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.85rem;color:var(--accent);flex-shrink:0}
.mini-info{flex:1;min-width:0}
.mini-name{font-weight:600;font-size:0.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mini-sub{font-size:0.67rem;color:var(--muted);margin-top:1px}
.mini-badge{font-family:monospace;font-size:0.7rem;color:var(--accent);background:rgba(59,130,246,0.1);padding:2px 7px;border-radius:10px;white-space:nowrap}
.mini-del{background:transparent;border:none;color:var(--muted);cursor:pointer;padding:3px 6px;border-radius:4px;font-size:0.85rem}
.mini-del:hover{color:var(--red);background:rgba(239,68,68,0.1)}
.s-empty{padding:30px 16px;text-align:center;color:var(--muted);font-size:0.82rem}
.fp-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px}
.fp-header h2{font-family:monospace;font-size:0.95rem;letter-spacing:1px}
.search-wrap{position:relative}
.search-wrap::before{content:'⌕';position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:1rem;pointer-events:none}
.search-inp{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:9px 16px 9px 36px;color:var(--text);font-family:inherit;font-size:0.84rem;outline:none;width:230px;transition:border-color 0.2s}
.search-inp:focus{border-color:var(--accent)}
.fp-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:22px}
.fp-stat{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center}
.fp-stat .sv{font-family:monospace;font-size:1.8rem;font-weight:700;color:var(--accent)}
.fp-stat .sk{font-size:0.67rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:3px}
.faces-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:12px}
.face-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;transition:border-color 0.2s}
.face-card:hover{border-color:rgba(59,130,246,0.4)}
.face-top{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.face-avatar{width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#1e3a5f,#2d5a8e);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1.1rem;color:var(--accent);flex-shrink:0;border:1px solid rgba(59,130,246,0.3)}
.face-info{flex:1;min-width:0}
.face-name{font-weight:700;font-size:0.92rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.face-meta{font-size:0.68rem;color:var(--muted);margin-top:2px;font-family:monospace}
.del-btn{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);color:var(--red);font-size:0.74rem;font-weight:700;padding:5px 10px;border-radius:7px;cursor:pointer;font-family:inherit}
.del-btn:hover{background:rgba(239,68,68,0.25);color:#fff}
.face-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.fstat{background:var(--surface);border-radius:7px;padding:8px 4px;text-align:center;font-size:0.6rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px}
.fstat span{display:block;font-family:monospace;font-size:0.85rem;font-weight:700;color:var(--accent);margin-bottom:2px}
.faces-empty{grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--muted);font-size:0.9rem}
#loadOv{position:fixed;inset:0;background:rgba(8,12,20,0.97);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;z-index:200}
#loadOv.gone{display:none}
.spin{width:44px;height:44px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.75s linear infinite}
.load-title{font-family:monospace;font-size:0.92rem;color:var(--text);font-weight:700}
.load-msg{font-size:0.78rem;color:var(--muted);max-width:320px;text-align:center;line-height:1.7}
.load-err{font-size:0.8rem;color:var(--red);max-width:340px;text-align:center;line-height:1.7;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);border-radius:8px;padding:12px 16px;display:none;white-space:pre-line}
.load-err.show{display:block}
.toast{position:fixed;bottom:24px;right:24px;padding:11px 18px;border-radius:10px;font-size:0.83rem;font-weight:600;opacity:0;transform:translateY(12px);transition:all 0.3s;z-index:300;pointer-events:none}
.toast.show{opacity:1;transform:translateY(0)}.toast.s{background:#10b981;color:#000}.toast.e{background:#ef4444;color:#fff}.toast.i{background:#3b82f6;color:#fff}
@keyframes spin{to{transform:rotate(360deg)}}@keyframes blink{0%,100%{opacity:1}50%{opacity:0.25}}
@media(max-width:800px){.cam-layout{grid-template-columns:1fr}.sidebar{order:-1}.fp-stats{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>

<div id="loadOv">
  <div class="spin"></div>
  <div class="load-title" id="loadTitle">Loading</div>
  <div class="load-msg"  id="loadMsg">Starting face recognition...</div>
  <div class="load-err"  id="loadErr"></div>
</div>

<nav>
  <div class="nav-brand">FACE<span>.</span>ID</div>
  <div class="nav-tabs">
    <button class="nav-tab active" onclick="showPage('cam',this)">📷 Camera</button>
    <button class="nav-tab" onclick="showPage('faces',this)">👥 Faces</button>
  </div>
  <div class="nav-dot" id="navDot">● offline</div>
</nav>

<div class="page show" id="page-cam">
  <div class="cam-layout">
    <div class="main-col">
      <div class="video-card">
        <div class="video-wrap">
          <video id="video" autoplay muted playsinline></video>
          <canvas id="overlay"></canvas>
          <div class="status-strip">
            <div class="sled" id="sled"></div>
            <span id="st">Initializing...</span>
          </div>
        </div>
        <div class="vid-btns">
          <button class="btn btn-blue" id="btnC" disabled onclick="capture()">📸 Capture & Recognize</button>
          <button class="btn btn-cyan" id="btnA" disabled onclick="toggleAuto()">▶ Auto</button>
        </div>
      </div>
      <div class="debug-bar">
        Library:<span id="dLib">—</span>
        Models:<span id="dMod">—</span>
        Camera:<span id="dCam">—</span>
        Score:<span id="dScore">—</span>
        Dist:<span id="dDist">—</span>
      </div>
      <div class="rc" id="rc">
        <div class="rc-title">Recognition Result</div>
        <div id="rb"></div>
        <div class="r-meta" id="rm"></div>
        <div id="rs"></div>
      </div>
    </div>
    <div class="sidebar">
      <div class="s-card">
        <div class="stats-row">
          <div class="stat-box"><div class="sv" id="sT">0</div><div class="sk">Registered</div></div>
          <div class="stat-box"><div class="sv" id="sV">0</div><div class="sk">Visits</div></div>
        </div>
      </div>
      <div class="s-card">
        <div class="s-head"><h3>Registered Faces</h3><span class="s-badge" id="sCnt">0</span></div>
        <div class="faces-scroll" id="sideList"><div class="s-empty">No faces yet</div></div>
      </div>
    </div>
  </div>
</div>

<div class="page" id="page-faces">
  <div class="fp-header">
    <h2>REGISTERED_FACES</h2>
    <div class="search-wrap">
      <input class="search-inp" id="searchInp" placeholder="Search name..." oninput="filterFaces(this.value)"/>
    </div>
  </div>
  <div class="fp-stats">
    <div class="fp-stat"><div class="sv" id="fpT">0</div><div class="sk">Total Faces</div></div>
    <div class="fp-stat"><div class="sv" id="fpV">0</div><div class="sk">Total Visits</div></div>
    <div class="fp-stat"><div class="sv" id="fpTop" style="font-size:1rem">—</div><div class="sk">Top Visitor</div></div>
  </div>
  <div class="faces-grid" id="facesGrid">
    ${cards || '<div class="faces-empty">No faces registered yet.</div>'}
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
// ── Globals ───────────────────────────────────────────────────────────────────
const MODEL_URL = '/models';
const THRESHOLD = ${THRESHOLD};
const REG_SAMPLES = ${REGISTER_SAMPLES};
let isReady = false, autoOn = false;
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');

// ── Error display ─────────────────────────────────────────────────────────────
function showErr(msg) {
  document.getElementById('loadTitle').textContent = '❌ Error';
  document.getElementById('loadMsg').style.display = 'none';
  document.querySelector('.spin').style.display = 'none';
  const el = document.getElementById('loadErr');
  el.textContent = msg; el.classList.add('show');
}

function setLoad(title, msg) {
  document.getElementById('loadTitle').textContent = title;
  document.getElementById('loadMsg').textContent = msg;
}

// ── Load face-api.js then start ───────────────────────────────────────────────
setLoad('Loading Library', 'Loading face-api.js from server...');
const script = document.createElement('script');
script.src = '/faceapi.js';
script.onload = function() {
  document.getElementById('dLib').textContent = '✅';
  init();
};
script.onerror = function() {
  showErr('Could not load face-api.js. Make sure npm install was done.');
};
document.head.appendChild(script);

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    // Check model files available
    setLoad('Checking Models', 'Verifying model files...');
    const probe = await fetch('/models/ssd_mobilenetv1_model-weights_manifest.json');
    if (!probe.ok) {
      showErr('Model files not ready yet. Wait 30 seconds then refresh.');
      return;
    }

    setLoad('Loading Models (1/3)', 'SSD MobileNet face detector...');
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);

    setLoad('Loading Models (2/3)', 'Face landmark detector...');
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);

    setLoad('Loading Models (3/3)', 'Face recognition net...');
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    document.getElementById('dMod').textContent = '✅ all 3 loaded';

    setLoad('Starting Camera', 'Requesting camera access...');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
      });
    } catch(e) {
      showErr('Camera access denied: ' + e.message + '. Allow camera in browser and refresh.');
      return;
    }

    video.srcObject = stream;
    await new Promise(r => video.onloadedmetadata = r);
    await video.play();
    await new Promise(r => setTimeout(r, 400));

    overlay.width  = video.videoWidth  || 640;
    overlay.height = video.videoHeight || 480;
    document.getElementById('dCam').textContent = overlay.width + 'x' + overlay.height;
    document.getElementById('navDot').textContent = '● online';
    document.getElementById('navDot').style.color = '#10b981';
    document.getElementById('loadOv').classList.add('gone');

    isReady = true;
    document.getElementById('btnC').disabled = false;
    document.getElementById('btnA').disabled = false;
    setSt('Ready — click Capture or Auto', 'pulse');
    loadSidebar(); loadFacesPage();

  } catch(e) {
    showErr(e.message);
    console.error(e);
  }
}

// ── Detect ────────────────────────────────────────────────────────────────────
async function detectFace() {
  return faceapi
    .detectSingleFace(video, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.35 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
}

function avgDesc(descs) {
  const len = descs[0].length, avg = new Float32Array(len);
  for (const d of descs) for (let i = 0; i < len; i++) avg[i] += d[i] / descs.length;
  return Array.from(avg);
}

// ── Capture ───────────────────────────────────────────────────────────────────
async function capture() {
  if (!isReady) return;
  setSt('Detecting...', 'pulse'); clearC();
  const det = await detectFace();
  if (!det) {
    const raw = await faceapi.detectSingleFace(video, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.05 }));
    document.getElementById('dScore').textContent = raw ? raw.score.toFixed(3) + ' (low)' : 'none';
    setSt(raw ? 'Score too low — better lighting or move closer' : 'No face — look directly at camera', 'bad');
    toast('No face detected', 'e');
    document.getElementById('rc').classList.remove('show');
    return;
  }

  document.getElementById('dScore').textContent = det.detection.score.toFixed(3) + ' ✅';
  const { x, y, width, height } = det.detection.box;
  const sx = overlay.width / video.videoWidth, sy = overlay.height / video.videoHeight;
  ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2.5;
  ctx.strokeRect(x*sx, y*sy, width*sx, height*sy);
  ctx.fillStyle = 'rgba(59,130,246,0.06)';
  ctx.fillRect(x*sx, y*sy, width*sx, height*sy);

  const desc = Array.from(det.descriptor);
  const res  = await fetch('/api/recognize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ descriptor: desc }) });
  const data = await res.json();
  document.getElementById('dDist').textContent = data.distance ? data.distance + (data.recognized ? ' ✅' : ' ❌') : '—';

  if (data.recognized) {
    setSt('✅ ' + data.label + '  •  Visit #' + data.visit_count, 'ok');
    ctx.fillStyle = '#3b82f6'; ctx.font = 'bold 14px Segoe UI';
    ctx.fillText(data.label, x*sx + 4, y*sy - 9);
    showKnown(data); loadSidebar(); loadFacesPage();
  } else {
    setSt('Unknown — enter name to register', 'bad');
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2.5;
    ctx.strokeRect(x*sx, y*sy, width*sx, height*sy);
    ctx.fillStyle = '#ef4444'; ctx.font = 'bold 14px Segoe UI';
    ctx.fillText('Unknown', x*sx + 4, y*sy - 9);
    showUnknown(data);
  }
}

function showKnown(d) {
  const rc = document.getElementById('rc'); rc.classList.add('show');
  document.getElementById('rb').innerHTML = '<span class="r-badge ok">✅ Recognized</span>';
  document.getElementById('rm').innerHTML = '<div class="r-mi"><div class="v">' + esc(d.label) + '</div><div class="k">Name</div></div><div class="r-mi"><div class="v">' + d.visit_count + '</div><div class="k">Visit #</div></div>';
  document.getElementById('rs').innerHTML = '';
}

function showUnknown(d) {
  const rc = document.getElementById('rc'); rc.classList.add('show');
  document.getElementById('rb').innerHTML = '<span class="r-badge unk">❓ Unknown</span>';
  document.getElementById('rm').innerHTML = '<div class="r-mi"><div class="v" style="color:var(--red)">New</div><div class="k">Status</div></div><div class="r-mi"><div class="v" style="font-size:0.8rem;color:var(--muted)">' + (d.distance||'—') + '</div><div class="k">Distance</div></div>';
  document.getElementById('rs').innerHTML = '<p style="font-size:0.73rem;color:var(--muted);margin-bottom:6px">Captures ' + REG_SAMPLES + ' samples for angle tolerance:</p>' +
    '<div class="prog-label" id="pL">Ready to register</div>' +
    '<div class="prog-wrap"><div class="prog-bar" id="pB"></div></div>' +
    '<div class="reg-form"><input class="reg-inp" id="ni" placeholder="Enter name" maxlength="50"/><button class="reg-btn" id="rB" onclick="registerFace()">💾 Save</button></div>';
  setTimeout(() => { const n = document.getElementById('ni'); if(n) n.focus(); }, 80);
}

// ── Register ──────────────────────────────────────────────────────────────────
async function registerFace() {
  const ni = document.getElementById('ni');
  const label = ni ? ni.value.trim() : '';
  if (!label) { toast('Enter a name', 'e'); return; }
  const rB = document.getElementById('rB'), pB = document.getElementById('pB'), pL = document.getElementById('pL');
  rB.disabled = true; rB.textContent = '⏳';
  const descs = [];
  for (let i = 0; i < REG_SAMPLES; i++) {
    pL.textContent = 'Sample ' + (i+1) + '/' + REG_SAMPLES + ' — hold still...';
    pB.style.width = (i / REG_SAMPLES * 100) + '%';
    await new Promise(r => setTimeout(r, 300));
    const det = await detectFace();
    if (det) descs.push(det.descriptor);
    else { await new Promise(r => setTimeout(r, 400)); const d2 = await detectFace(); if(d2) descs.push(d2.descriptor); }
  }
  pB.style.width = '100%';
  if (!descs.length) { toast('No face captured — try again', 'e'); rB.disabled = false; rB.textContent = '💾 Save'; return; }
  pL.textContent = 'Got ' + descs.length + '/' + REG_SAMPLES + ' samples — saving...';
  const res  = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, descriptor: avgDesc(descs) }) });
  const data = await res.json();
  if (res.ok) {
    toast('✅ "' + label + '" registered!', 's');
    loadSidebar(); loadFacesPage();
    document.getElementById('rc').classList.remove('show');
    setSt('Registered: ' + label, 'ok');
  } else {
    toast(data.error || 'Registration failed', 'e');
    rB.disabled = false; rB.textContent = '💾 Save';
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.activeElement === document.getElementById('ni')) registerFace();
});

// ── Auto mode ─────────────────────────────────────────────────────────────────
function toggleAuto() {
  autoOn = !autoOn;
  const b = document.getElementById('btnA');
  if (autoOn) {
    b.textContent = '⏹ Stop'; b.classList.replace('btn-cyan','btn-red');
    document.getElementById('btnC').disabled = true;
    runAuto(); toast('Auto detection ON','i');
  } else {
    b.textContent = '▶ Auto'; b.classList.replace('btn-red','btn-cyan');
    document.getElementById('btnC').disabled = false;
    toast('Auto detection OFF','i');
  }
}
async function runAuto() { while(autoOn) { await capture(); await new Promise(r => setTimeout(r, 2500)); } }

// ── Lists ─────────────────────────────────────────────────────────────────────
async function loadSidebar() {
  const { faces = [] } = await (await fetch('/api/faces')).json();
  document.getElementById('sCnt').textContent = faces.length;
  document.getElementById('sT').textContent   = faces.length;
  document.getElementById('sV').textContent   = faces.reduce((s,f) => s + f.visit_count, 0);
  const list = document.getElementById('sideList');
  if (!faces.length) { list.innerHTML = '<div class="s-empty">No faces registered yet</div>'; return; }
  list.innerHTML = faces.map(f =>
    '<div class="mini-face" id="mf-' + f.id + '">' +
    '<div class="mini-av">' + f.label[0].toUpperCase() + '</div>' +
    '<div class="mini-info"><div class="mini-name">' + esc(f.label) + '</div><div class="mini-sub">' + f.visit_count + ' visits</div></div>' +
    '<span class="mini-badge">' + f.visit_count + 'x</span>' +
    '<button class="mini-del" data-id="' + f.id + '" data-label="' + esc(f.label) + '" onclick="delFaceBtn(this)">✕</button>' +
    '</div>').join('');
}

async function loadFacesPage() {
  const { faces = [] } = await (await fetch('/api/faces')).json();
  document.getElementById('fpT').textContent   = faces.length;
  document.getElementById('fpV').textContent   = faces.reduce((s,f) => s + f.visit_count, 0);
  const top = faces.length ? faces.reduce((a,b) => b.visit_count > a.visit_count ? b : a) : null;
  document.getElementById('fpTop').textContent = top ? top.label : '—';
  const grid = document.getElementById('facesGrid');
  if (!faces.length) { grid.innerHTML = '<div class="faces-empty">No faces registered yet.<br>Go to Camera tab to register.</div>'; return; }
  grid.innerHTML = faces.map(f =>
    '<div class="face-card" id="fc-' + f.id + '" data-name="' + esc(f.label.toLowerCase()) + '">' +
    '<div class="face-top"><div class="face-avatar">' + f.label[0].toUpperCase() + '</div>' +
    '<div class="face-info"><div class="face-name">' + esc(f.label) + '</div><div class="face-meta">ID #' + f.id + '</div></div>' +
    '<button class="del-btn" data-id="' + f.id + '" data-label="' + esc(f.label) + '" onclick="delFaceBtn(this)">Delete</button></div>' +
    '<div class="face-stats">' +
    '<div class="fstat"><span>' + f.visit_count + '</span>Visits</div>' +
    '<div class="fstat"><span style="font-size:0.6rem">' + ago(f.first_seen) + '</span>Registered</div>' +
    '<div class="fstat"><span style="font-size:0.6rem">' + ago(f.last_seen) + '</span>Last Seen</div>' +
    '</div></div>').join('');
}

function filterFaces(q) {
  document.querySelectorAll('.face-card').forEach(c => {
    c.style.display = c.dataset.name.includes(q.toLowerCase()) ? '' : 'none';
  });
}

function delFaceBtn(btn) {
  delFace(parseInt(btn.dataset.id), btn.dataset.label);
}

async function delFace(id, label) {
  if (!confirm('Remove "' + label + '" from database?')) return;
  const r = await fetch('/api/faces/' + id, { method: 'DELETE' });
  if (r.ok) {
    ['fc-','mf-'].forEach(pre => {
      const el = document.getElementById(pre + id);
      if (el) { el.style.transition='all 0.3s'; el.style.opacity='0'; el.style.transform='scale(0.9)'; setTimeout(()=>el.remove(),300); }
    });
    toast('"' + label + '" deleted', 'i');
    setTimeout(() => { loadSidebar(); loadFacesPage(); }, 350);
  } else toast('Delete failed', 'e');
}

// ── Page nav ──────────────────────────────────────────────────────────────────
function showPage(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('show'));
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('show');
  btn.classList.add('active');
  if (name === 'faces') loadFacesPage();
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function clearC() { ctx.clearRect(0, 0, overlay.width, overlay.height); }
function setSt(t, type) { document.getElementById('st').textContent=t; const d=document.getElementById('sled'); d.className='sled'; if(type) d.classList.add(type); }
function toast(msg, type='i') { const t=document.getElementById('toast'); t.textContent=msg; t.className='toast '+type+' show'; setTimeout(()=>t.classList.remove('show'),3000); }
function esc(s) { return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function ago(ds) { const d=new Date(ds),diff=(Date.now()-d)/1000; if(diff<60)return'just now'; if(diff<3600)return Math.floor(diff/60)+'m ago'; if(diff<86400)return Math.floor(diff/3600)+'h ago'; return Math.floor(diff/86400)+'d ago'; }
</script>
</body>
</html>`;
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.get('/api/faces', async (req, res) => {
  try {
    const rows = await dbQuery('SELECT id, label, visit_count, first_seen, last_seen FROM faces ORDER BY last_seen DESC');
    res.json({ faces: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/recognize', async (req, res) => {
  try {
    const { descriptor } = req.body;
    if (!Array.isArray(descriptor)) return res.status(400).json({ error: 'descriptor required' });
    const rows = await dbQuery('SELECT id, label, visit_count, descriptor FROM faces');
    let best = null, bestD = Infinity;
    for (const r of rows) {
      const d = euclidean(descriptor, JSON.parse(r.descriptor));
      if (d < bestD) { bestD = d; best = r; }
    }
    if (best && bestD < THRESHOLD) {
      await dbQuery('UPDATE faces SET visit_count = visit_count + 1, last_seen = NOW() WHERE id = ?', [best.id]);
      res.json({ recognized: true, id: best.id, label: best.label, visit_count: best.visit_count + 1, distance: bestD.toFixed(4) });
    } else {
      res.json({ recognized: false, distance: bestD < Infinity ? bestD.toFixed(4) : null });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/register', async (req, res) => {
  try {
    const { label, descriptor } = req.body;
    if (!label || !descriptor) return res.status(400).json({ error: 'label and descriptor required' });
    const result = await dbQuery('INSERT INTO faces (label, descriptor) VALUES (?, ?)', [label, JSON.stringify(descriptor)]);
    res.status(201).json({ success: true, id: result.insertId, label });
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '"' + req.body.label + '" is already registered' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/faces/:id', async (req, res) => {
  try {
    const result = await dbQuery('DELETE FROM faces WHERE id = ?', [parseInt(req.params.id)]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  try {
    const faces = await dbQuery('SELECT id, label, visit_count, first_seen, last_seen FROM faces ORDER BY last_seen DESC');
    res.send(getHTML(faces));
  } catch(e) { res.status(500).send('DB error: ' + e.message); }
});

// ─── START ────────────────────────────────────────────────────────────────────
setup().then(() => {
  app.listen(PORT, () => {
    console.log('\n==========================================');
    console.log('🚀  http://localhost:' + PORT);
    console.log('🗄️   MySQL → ' + DB_CONFIG.host + '/' + DB_CONFIG.database);
    console.log('📦  Express.js server');
    console.log('🤖  face-api.js → public/faceapi.js (auto-downloaded)');
    console.log('==========================================\n');
  });
});
