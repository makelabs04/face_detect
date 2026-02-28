const express = require('express');
const mysql   = require('mysql2');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/models',    express.static(path.join(__dirname, 'public', 'models')));
app.use('/faceapi.js',(req, res) => res.sendFile(path.join(__dirname, 'public', 'faceapi.js')));

const DB_CONFIG = {
  host     : '127.0.0.1',
  user     : 'u966260443_facedetect',
  password : 'Makelabs@123',
  database : 'u966260443_facedetect'
};

const db = mysql.createConnection(DB_CONFIG);

db.connect(err => {
  if (err) {
    console.error('\n❌ MySQL connection failed:', err.message);
    process.exit(1);
  }
  console.log('✅ MySQL connected →', DB_CONFIG.database);

  db.query(`
    CREATE TABLE IF NOT EXISTS faces (
      id                    INT AUTO_INCREMENT PRIMARY KEY,
      label                 VARCHAR(100) NOT NULL UNIQUE,
      employee_id           VARCHAR(50)  DEFAULT '',
      department            VARCHAR(100) DEFAULT '',
      descriptor            LONGTEXT NOT NULL,
      registration_accuracy TINYINT UNSIGNED DEFAULT NULL,
      registered_at         DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, err => { if (!err) console.log('✅ faces table ready'); });

  db.query(`
    CREATE TABLE IF NOT EXISTS attendance (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      face_id           INT NOT NULL,
      name              VARCHAR(100) NOT NULL,
      date              DATE NOT NULL,
      time_in           TIME NOT NULL,
      time_out          TIME DEFAULT NULL,
      expected_checkout TIME DEFAULT NULL,
      status            ENUM('present','late','early_leave','late_early_leave','absent') DEFAULT 'present',
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_face_date (face_id, date),
      FOREIGN KEY (face_id) REFERENCES faces(id) ON DELETE CASCADE
    )
  `, err => { if (!err) console.log('✅ attendance table ready'); });
});

// ─── AUTO DOWNLOAD face-api.js + MODELS ──────────────────────────────────────
const PUBLIC_DIR   = path.join(__dirname, 'public');
const MODELS_DIR   = path.join(PUBLIC_DIR, 'models');
const FACEAPI_PATH = path.join(PUBLIC_DIR, 'faceapi.js');
const FACEAPI_URL  = 'https://unpkg.com/face-api.js@0.22.2/dist/face-api.min.js';
const MODEL_FILES  = [
  'ssd_mobilenetv1_model-weights_manifest.json','ssd_mobilenetv1_model-shard1','ssd_mobilenetv1_model-shard2',
  'face_landmark_68_model-weights_manifest.json','face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json','face_recognition_model-shard1','face_recognition_model-shard2',
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
        file.close(); try{fs.unlinkSync(dest);}catch(_){}
        return reject(new Error('HTTP ' + res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(true); });
    }).on('error', e => { try{fs.unlinkSync(dest);}catch(_){} reject(e); });
  });
}

async function setup() {
  if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
  if (!fs.existsSync(FACEAPI_PATH)) {
    process.stdout.write('📥 Downloading face-api.js... ');
    try { await download(FACEAPI_URL, FACEAPI_PATH); console.log('✅'); }
    catch(e) { console.log('❌ ' + e.message); }
  } else { console.log('✅ face-api.js cached'); }
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

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function dbQuery(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows))
  );
}

function euclidean(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

function escH(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])
  );
}

function fmtTime(t) {
  if (!t) return '—';
  const str   = typeof t === 'string' ? t : String(t);
  const parts = str.split(':');
  const h = parseInt(parts[0]), m = parts[1] || '00';
  return (h % 12 || 12) + ':' + m + ' ' + (h >= 12 ? 'PM' : 'AM');
}

// ─── OFFICE TIMING CONFIG ─────────────────────────────────────────────────────
// Office starts 9:30 AM, 10 min grace → late after 9:40 AM
// Office ends 6:10 PM (18:10)
// After 11:00 AM check-in → marked absent
const OFFICE_START   = { h: 9,  m: 30 };
const GRACE_MINUTES  = 10;
const OFFICE_END     = { h: 18, m: 10 };
const ABSENT_AFTER   = { h: 11, m: 0 };   // 11:00 AM → absent
const THRESHOLD      = 0.6;
const REGISTER_SAMPLES = 5;

// Derived thresholds in total minutes
const LATE_AFTER     = OFFICE_START.h * 60 + OFFICE_START.m + GRACE_MINUTES; // 580 = 9:40
const CHECKOUT_FROM  = OFFICE_END.h   * 60 + OFFICE_END.m;                   // 1090 = 18:10
const ABSENT_AFTER_MIN = ABSENT_AFTER.h * 60 + ABSENT_AFTER.m;               // 660 = 11:00

// Calculate expected checkout based on check-in time (min 8h work or office end whichever later)
function calcExpectedCheckout(timeInStr) {
  const parts = timeInStr.split(':');
  const inMin = parseInt(parts[0]) * 60 + parseInt(parts[1]);
  // Must work at least 8 hours OR leave at office end, whichever is later
  const byWorkHours = inMin + 8 * 60;
  const expected = Math.max(byWorkHours, CHECKOUT_FROM);
  const eh = Math.floor(expected / 60);
  const em = String(expected % 60).padStart(2, '0');
  return `${String(eh).padStart(2,'0')}:${em}:00`;
}

function calcWorkingHours(timeIn, timeOut) {
  if (!timeIn || !timeOut) return null;
  const toMin = s => {
    const p = String(s).split(':');
    return parseInt(p[0]) * 60 + parseInt(p[1]);
  };
  const diff = toMin(timeOut) - toMin(timeIn);
  if (diff <= 0) return null;
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  return `${h}h ${m}m`;
}

function calcWorkingMinutes(timeIn, timeOut) {
  if (!timeIn || !timeOut) return 0;
  const toMin = s => { const p = String(s).split(':'); return parseInt(p[0]) * 60 + parseInt(p[1]); };
  const diff = toMin(timeOut) - toMin(timeIn);
  return diff > 0 ? diff : 0;
}

// ─── ATTENDANCE PAGE ──────────────────────────────────────────────────────────
function getAttendanceHTML(todayRecords) {
  const rows = todayRecords.map(r => `
    <tr data-name="${escH(r.name.toLowerCase())}">
      <td><div class="td-name"><div class="td-av">${r.name[0].toUpperCase()}</div>${escH(r.name)}</div></td>
      <td><span class="time-pill">${r.time_in}</span></td>
      <td><span class="time-pill out">${r.time_out}</span></td>
      <td><span class="badge badge-${r.status}">${statusLabel(r.status)}</span></td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Attendance System</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
:root{
  --bg:#050810;--surface:#0a0f1e;--card:#0d1526;--border:#162035;
  --accent:#4f8ef7;--accent2:#34d399;--red:#f87171;--yellow:#fbbf24;
  --purple:#a78bfa;--orange:#fb923c;--text:#e8edf5;--muted:#4b5a72;--muted2:#2a3a54;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Space Grotesk',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 50% at 50% -10%,rgba(79,142,247,0.08),transparent);pointer-events:none;z-index:0}

nav{position:sticky;top:0;z-index:100;background:rgba(5,8,16,0.92);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 32px;height:62px}
.nav-left{display:flex;align-items:center;gap:16px}
.nav-logo{font-family:'JetBrains Mono',monospace;font-size:1.05rem;font-weight:600;letter-spacing:2px}
.nav-logo span{color:var(--accent)}
.nav-date{font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--muted);background:var(--card);border:1px solid var(--border);padding:4px 12px;border-radius:20px}
.nav-right{display:flex;align-items:center;gap:10px}
.reg-btn{display:flex;align-items:center;gap:8px;background:linear-gradient(135deg,rgba(79,142,247,0.15),rgba(52,211,153,0.1));border:1px solid rgba(79,142,247,0.35);color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:0.82rem;font-weight:600;padding:8px 18px;border-radius:10px;text-decoration:none;transition:all 0.2s}
.reg-btn:hover{background:linear-gradient(135deg,rgba(79,142,247,0.3),rgba(52,211,153,0.2));border-color:rgba(79,142,247,0.6);transform:translateY(-1px)}
.live-dot{width:8px;height:8px;border-radius:50%;background:var(--accent2);animation:livepulse 2s infinite}
@keyframes livepulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(1.3)}}

main{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:28px 32px}

/* timing info bar */
.timing-bar{display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:10px 18px;margin-bottom:18px;flex-wrap:wrap}
.timing-item{display:flex;align-items:center;gap:7px;font-size:0.78rem;color:var(--muted)}
.timing-item strong{color:var(--text);font-family:'JetBrains Mono',monospace;font-size:0.8rem}
.timing-sep{color:var(--muted2);font-size:0.9rem}
.timing-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.td-green{background:var(--accent2)}.td-yellow{background:var(--yellow)}.td-orange{background:var(--orange)}.td-purple{background:var(--purple)}

.stats-bar{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:22px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 18px;position:relative;overflow:hidden;transition:border-color 0.2s}
.stat:hover{border-color:var(--muted2)}
.stat-val{font-family:'JetBrains Mono',monospace;font-size:1.9rem;font-weight:600;color:var(--accent);line-height:1}
.stat-val.green{color:var(--accent2)}.stat-val.red{color:var(--red)}.stat-val.yellow{color:var(--yellow)}.stat-val.orange{color:var(--orange)}.stat-val.purple{color:var(--purple)}
.stat-label{font-size:0.67rem;color:var(--muted);text-transform:uppercase;letter-spacing:1.2px;margin-top:6px}

.top-row{display:grid;grid-template-columns:1fr 400px;gap:20px;margin-bottom:22px}

.cam-card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.cam-wrap{position:relative;background:#000;aspect-ratio:4/3}
#video{width:100%;height:100%;object-fit:cover;display:block}
#overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.scan-line{position:absolute;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--accent),transparent);animation:scan 3s ease-in-out infinite;opacity:0.4;pointer-events:none}
@keyframes scan{0%,100%{top:5%;opacity:0}10%{opacity:0.6}90%{opacity:0.6}50%{top:95%}}
.cam-controls{padding:12px 14px;background:var(--surface);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.cam-status{flex:1;display:flex;align-items:center;gap:8px;font-size:0.78rem;color:var(--muted);min-width:120px}
.sled{width:7px;height:7px;border-radius:50%;background:var(--muted);flex-shrink:0;transition:background 0.3s}
.sled.pulse{background:var(--yellow);animation:blink 1s infinite}.sled.ok{background:var(--accent2)}.sled.bad{background:var(--red)}.sled.purple{background:var(--purple)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0.2}}
.btn{padding:9px 16px;border:none;border-radius:9px;font-family:'Space Grotesk',sans-serif;font-size:0.81rem;font-weight:600;cursor:pointer;transition:all 0.18s;white-space:nowrap}
.btn:disabled{opacity:0.3;cursor:not-allowed}
.btn-checkin{background:var(--accent);color:#fff}.btn-checkin:hover:not(:disabled){background:#3b7de8;transform:translateY(-1px);box-shadow:0 4px 16px rgba(79,142,247,0.35)}
.btn-checkout{background:rgba(167,139,250,0.12);border:1px solid rgba(167,139,250,0.3);color:var(--purple)}.btn-checkout:hover:not(:disabled){background:rgba(167,139,250,0.22);transform:translateY(-1px)}
.btn-auto{background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.25);color:var(--accent2)}.btn-auto:hover:not(:disabled){background:rgba(52,211,153,0.2)}
.btn-auto.active{background:rgba(248,113,113,0.1);border-color:rgba(248,113,113,0.3);color:var(--red)}

/* result panel */
.result-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:22px;display:flex;flex-direction:column;gap:16px}
.result-title{font-family:'JetBrains Mono',monospace;font-size:0.65rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase}
.result-idle{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:210px;gap:12px;color:var(--muted);font-size:0.82rem;text-align:center;line-height:1.7}
.result-idle svg{opacity:0.12}
.recognized-box,.unknown-box{display:none;flex-direction:column;gap:14px}
.r-face-row{display:flex;align-items:center;gap:14px}
.r-av{width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#162040,#1e3a6e);display:flex;align-items:center;justify-content:center;font-size:1.3rem;font-weight:700;color:var(--accent);border:1px solid rgba(79,142,247,0.25);flex-shrink:0}
.r-name{font-size:1.25rem;font-weight:700;margin-bottom:5px}
.r-badge{display:inline-flex;align-items:center;gap:5px;padding:4px 12px;border-radius:100px;font-size:0.74rem;font-weight:600}
.rb-present{background:rgba(52,211,153,0.1);color:var(--accent2);border:1px solid rgba(52,211,153,0.2)}
.rb-late{background:rgba(251,191,36,0.1);color:var(--yellow);border:1px solid rgba(251,191,36,0.2)}
.rb-early{background:rgba(251,146,60,0.1);color:var(--orange);border:1px solid rgba(251,146,60,0.2)}
.rb-already{background:rgba(79,142,247,0.1);color:var(--accent);border:1px solid rgba(79,142,247,0.2)}
.rb-checkout{background:rgba(167,139,250,0.1);color:var(--purple);border:1px solid rgba(167,139,250,0.2)}
.rb-unk{background:rgba(248,113,113,0.1);color:var(--red);border:1px solid rgba(248,113,113,0.2)}
.r-grid{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px}
.r-cell{background:var(--surface);border-radius:10px;padding:10px;text-align:center}
.r-cell .rv{font-family:'JetBrains Mono',monospace;font-size:0.92rem;font-weight:600;color:var(--accent)}
.r-cell .rk{font-size:0.6rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:3px}
.conf-bar{height:4px;border-radius:2px;background:var(--muted2);margin-top:6px;overflow:hidden}
.conf-bar-fill{height:100%;border-radius:2px;transition:width 0.4s ease,background 0.4s ease}
.unk-hint{font-size:0.8rem;color:var(--muted);line-height:1.6}
.goto-reg{display:inline-flex;align-items:center;gap:7px;padding:10px 16px;background:linear-gradient(135deg,rgba(167,139,250,0.12),rgba(79,142,247,0.08));border:1px solid rgba(167,139,250,0.25);color:var(--purple);font-size:0.8rem;font-weight:600;border-radius:10px;text-decoration:none;transition:all 0.2s;font-family:'Space Grotesk',sans-serif}
.goto-reg:hover{background:linear-gradient(135deg,rgba(167,139,250,0.22),rgba(79,142,247,0.15));transform:translateY(-1px)}

/* table */
.table-card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.table-head{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border)}
.table-head h3{font-family:'JetBrains Mono',monospace;font-size:0.7rem;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase}
.thr{display:flex;align-items:center;gap:10px}
.cnt-pill{background:rgba(79,142,247,0.1);color:var(--accent);font-size:0.72rem;font-weight:600;padding:3px 10px;border-radius:12px;font-family:'JetBrains Mono',monospace}
.search-inp{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:7px 12px;color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:0.8rem;outline:none;width:170px;transition:border-color 0.2s}
.search-inp:focus{border-color:var(--accent)}.search-inp::placeholder{color:var(--muted)}
.tbl-wrap{overflow-x:auto;max-height:420px;overflow-y:auto}
.tbl-wrap::-webkit-scrollbar{width:3px;height:3px}.tbl-wrap::-webkit-scrollbar-thumb{background:var(--muted2);border-radius:2px}
table{width:100%;border-collapse:collapse}
thead th{padding:10px 16px;text-align:left;font-size:0.65rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:1px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;white-space:nowrap}
tbody tr{border-bottom:1px solid rgba(22,32,53,0.6);transition:background 0.15s}
tbody tr:last-child{border-bottom:none}
tbody tr:hover{background:rgba(79,142,247,0.03)}
td{padding:11px 16px;font-size:0.83rem;vertical-align:middle}
.td-name{display:flex;align-items:center;gap:10px;font-weight:600}
.td-av{width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#162040,#1e3a6e);display:flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:700;color:var(--accent);border:1px solid rgba(79,142,247,0.2);flex-shrink:0}
.time-pill{font-family:'JetBrains Mono',monospace;font-size:0.77rem;background:rgba(79,142,247,0.08);color:var(--accent);padding:3px 10px;border-radius:20px;border:1px solid rgba(79,142,247,0.12)}
.time-pill.out{background:rgba(167,139,250,0.08);color:var(--purple);border-color:rgba(167,139,250,0.12)}
.badge{display:inline-flex;align-items:center;padding:3px 10px;border-radius:20px;font-size:0.68rem;font-weight:600;letter-spacing:0.3px;text-transform:uppercase;white-space:nowrap}
.badge-present{background:rgba(52,211,153,0.08);color:var(--accent2);border:1px solid rgba(52,211,153,0.18)}
.badge-late{background:rgba(251,191,36,0.08);color:var(--yellow);border:1px solid rgba(251,191,36,0.18)}
.badge-early_leave{background:rgba(251,146,60,0.08);color:var(--orange);border:1px solid rgba(251,146,60,0.18)}
.badge-late_early_leave{background:rgba(248,113,113,0.08);color:var(--red);border:1px solid rgba(248,113,113,0.18)}
.badge-absent{background:rgba(248,113,113,0.08);color:var(--red);border:1px solid rgba(248,113,113,0.18)}
.tbl-empty{text-align:center;padding:50px;color:var(--muted);font-size:0.84rem}

#loadOv{position:fixed;inset:0;background:rgba(5,8,16,0.97);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;z-index:999}
#loadOv.gone{display:none}
.spin{width:46px;height:46px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.load-sub{font-family:'JetBrains Mono',monospace;font-size:0.75rem;color:var(--muted);letter-spacing:1px;text-align:center}
.load-h{font-size:1rem;font-weight:600}
.load-err{font-size:0.8rem;color:var(--red);background:rgba(248,113,113,0.07);border:1px solid rgba(248,113,113,0.18);border-radius:10px;padding:12px 18px;max-width:360px;text-align:center;line-height:1.6;display:none}
.load-err.show{display:block}
.toast{position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:12px;font-size:0.82rem;font-weight:600;opacity:0;transform:translateY(10px);transition:all 0.3s;z-index:500;pointer-events:none;max-width:340px}
.toast.show{opacity:1;transform:translateY(0)}
.toast.s{background:rgba(52,211,153,0.93);color:#000}.toast.e{background:rgba(248,113,113,0.93);color:#fff}.toast.i{background:rgba(79,142,247,0.93);color:#fff}.toast.w{background:rgba(251,191,36,0.93);color:#000}.toast.p{background:rgba(167,139,250,0.93);color:#000}

@media(max-width:1000px){.top-row{grid-template-columns:1fr}.stats-bar{grid-template-columns:repeat(3,1fr)}main{padding:16px}}
@media(max-width:600px){.stats-bar{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>

<div id="loadOv">
  <div class="spin"></div>
  <div class="load-h" id="loadTitle">Initializing</div>
  <div class="load-sub" id="loadMsg">Loading face recognition...</div>
  <div class="load-err" id="loadErr"></div>
</div>

<nav>
  <div class="nav-left">
    <div class="nav-logo">ATTEND<span>.</span>AI</div>
    <div class="nav-date" id="navDate">—</div>
  </div>
  <div class="nav-right">
    <div class="live-dot"></div>
    <a class="reg-btn" href="/records" style="background:rgba(167,139,250,0.1);border-color:rgba(167,139,250,0.3);color:var(--purple)">
      📊 Records
    </a>
    <a class="reg-btn" href="/register">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
      Register Face
    </a>
  </div>
</nav>

<main>

  <div class="timing-bar">
    <div class="timing-item"><div class="timing-dot td-green"></div>On Time: before <strong>9:40 AM</strong></div>
    <div class="timing-sep">·</div>
    <div class="timing-item"><div class="timing-dot td-yellow"></div>Late: after <strong>9:40 AM</strong> <span style="font-size:0.7rem;margin-left:4px">(9:30 + 10 min grace)</span></div>
    <div class="timing-sep">·</div>
    <div class="timing-item"><div class="timing-dot td-purple"></div>Check-out from: <strong>6:10 PM</strong></div>
    <div class="timing-sep">·</div>
    <div class="timing-item"><div class="timing-dot td-orange"></div>Early leave: before <strong>6:10 PM</strong></div>
    <div class="timing-sep">·</div>
    <div class="timing-item"><div class="timing-dot" style="background:var(--red)"></div>Absent if check-in after <strong>11:00 AM</strong></div>
  </div>

  <div class="stats-bar">
    <div class="stat"><div class="stat-val green" id="stPresent">0</div><div class="stat-label">Present</div></div>
    <div class="stat"><div class="stat-val yellow" id="stLate">0</div><div class="stat-label">Late</div></div>
    <div class="stat"><div class="stat-val orange" id="stEarly">0</div><div class="stat-label">Early Leave</div></div>
    <div class="stat"><div class="stat-val" id="stTotal">0</div><div class="stat-label">Registered</div></div>
    <div class="stat"><div class="stat-val red" id="stAbsent">0</div><div class="stat-label">Absent</div></div>
  </div>

  <div class="top-row">
    <div class="cam-card">
      <div class="cam-wrap">
        <video id="video" autoplay muted playsinline></video>
        <canvas id="overlay"></canvas>
        <div class="scan-line"></div>
      </div>
      <div class="cam-controls">
        <div class="cam-status">
          <div class="sled pulse" id="sled"></div>
          <span id="st">Loading...</span>
        </div>
        <button class="btn btn-checkin"  id="btnC"  disabled onclick="capture()">📸 Check In</button>
        <button class="btn btn-checkout" id="btnCO" disabled onclick="captureCheckout()">🚪 Check Out</button>
        <button class="btn btn-auto"     id="btnA"  disabled onclick="toggleAuto()">▶ Auto</button>
      </div>
    </div>

    <div class="result-card">
      <div class="result-title">Recognition Result</div>
      <div class="result-idle" id="resultIdle">
        <svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <circle cx="12" cy="8" r="4"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/>
          <path d="M16 3l2 2-4 4M8 3L6 5l4 4" opacity="0.5"/>
        </svg>
        <span>Point camera at a registered face,<br/>then click <strong>Check In</strong> or <strong>Check Out</strong></span>
      </div>
      <div class="recognized-box" id="recognizedBox">
        <div class="r-face-row">
          <div class="r-av" id="rAv">?</div>
          <div>
            <div class="r-name" id="rName">—</div>
            <span class="r-badge rb-present" id="rBadge">✅ Present</span>
          </div>
        </div>
        <div class="r-grid">
          <div class="r-cell"><div class="rv" id="rTimeIn">—</div><div class="rk">Time In</div></div>
          <div class="r-cell"><div class="rv" id="rTimeOut">—</div><div class="rk" id="rTimeOutLabel">Time Out</div></div>
          <div class="r-cell">
            <div class="rv" id="rRegAcc">—</div>
            <div class="rk">Reg. Quality</div>
            <div class="conf-bar"><div class="conf-bar-fill" id="rRegAccBar" style="width:0%"></div></div>
          </div>
          <div class="r-cell">
            <div class="rv" id="rConf">—</div>
            <div class="rk">Live Match</div>
            <div class="conf-bar"><div class="conf-bar-fill" id="rConfBar" style="width:0%"></div></div>
          </div>
        </div>
      </div>
      <div class="unknown-box" id="unknownBox">
        <span class="r-badge rb-unk">❓ Unknown Person</span>
        <div class="unk-hint">Face not found in the system. Register this person first to track attendance.</div>
        <a class="goto-reg" href="/register">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
          Register This Person
        </a>
      </div>
    </div>
  </div>

  <div class="table-card">
    <div class="table-head">
      <h3>Today's Attendance Log</h3>
      <div class="thr">
        <span class="cnt-pill" id="aCnt">0 records</span>
        <input class="search-inp" placeholder="Search name..." oninput="filterTable(this.value)"/>
      </div>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead>
          <tr><th>Name</th><th>Check In</th><th>Check Out</th><th>Status</th></tr>
        </thead>
        <tbody id="attBody">
          ${rows || '<tr><td colspan="4" class="tbl-empty">No attendance marked yet today</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
</main>

<div class="toast" id="toast"></div>

<script>
const MODEL_URL = '/models';
const THRESHOLD = ${THRESHOLD};
let isReady = false, autoOn = false, autoMode = 'checkin';
const video   = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx     = overlay.getContext('2d');

const now = new Date();
document.getElementById('navDate').textContent =
  now.toLocaleDateString('en-US',{weekday:'short',year:'numeric',month:'short',day:'numeric'});

function showErr(msg){
  document.getElementById('loadTitle').textContent='❌ Error';
  document.getElementById('loadMsg').style.display='none';
  document.querySelector('.spin').style.display='none';
  const el=document.getElementById('loadErr');el.textContent=msg;el.classList.add('show');
}
function setLoad(t,m){document.getElementById('loadTitle').textContent=t;document.getElementById('loadMsg').textContent=m;}

setLoad('Loading Library','Fetching face-api.js...');
const sc=document.createElement('script');sc.src='/faceapi.js';
sc.onload=init;sc.onerror=()=>showErr('Could not load face-api.js');
document.head.appendChild(sc);

async function init(){
  try{
    setLoad('Checking Models','Verifying files...');
    const probe=await fetch('/models/ssd_mobilenetv1_model-weights_manifest.json');
    if(!probe.ok){showErr('Models not ready. Wait 30s and refresh.');return;}
    setLoad('Loading Models 1/3','SSD MobileNet...');
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
    setLoad('Loading Models 2/3','Landmark net...');
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    setLoad('Loading Models 3/3','Recognition net...');
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    setLoad('Starting Camera','Requesting access...');
    let stream;
    try{stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'}});}
    catch(e){showErr('Camera denied: '+e.message);return;}
    video.srcObject=stream;
    await new Promise(r=>video.onloadedmetadata=r);
    await video.play();
    await new Promise(r=>setTimeout(r,400));
    overlay.width=video.videoWidth||640;overlay.height=video.videoHeight||480;
    document.getElementById('loadOv').classList.add('gone');
    isReady=true;
    document.getElementById('btnC').disabled=false;
    document.getElementById('btnCO').disabled=false;
    document.getElementById('btnA').disabled=false;
    setSt('Ready — use Check In or Check Out','ok');
    loadStats();loadTable();
  }catch(e){showErr(e.message);}
}

async function detectFace(){
  return faceapi
    .detectSingleFace(video,new faceapi.SsdMobilenetv1Options({minConfidence:0.35}))
    .withFaceLandmarks().withFaceDescriptor();
}

// ── CHECK IN ──────────────────────────────────────────────────
async function capture(){
  if(!isReady)return;
  setSt('Scanning for check-in...','pulse');clearC();
  const det=await detectFace();
  if(!det){setSt('No face detected — look at the camera','bad');showIdle();toast('No face detected','e');return;}

  const{x,y,width,height}=det.detection.box;
  const sx=overlay.width/video.videoWidth,sy=overlay.height/video.videoHeight;
  ctx.strokeStyle='#4f8ef7';ctx.lineWidth=2.5;
  ctx.strokeRect(x*sx,y*sy,width*sx,height*sy);
  ctx.fillStyle='rgba(79,142,247,0.04)';ctx.fillRect(x*sx,y*sy,width*sx,height*sy);

  const res=await fetch('/api/attendance/mark',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({descriptor:Array.from(det.descriptor)})
  });
  const data=await res.json();

  if(data.success && data.recognized){
    if(data.already){
      ctx.fillStyle='#4f8ef7';ctx.font='bold 13px Space Grotesk,sans-serif';
      ctx.fillText(data.name+(data.confidence!=null?' '+data.confidence+'%':''),x*sx+4,y*sy-8);
      setSt('Already checked in: '+data.name,'pulse');
      showResult({...data,mode:'already'});
      toast('⚠️ '+data.name+' already checked in today','w');
    }else{
      const col=data.status==='late'?'#fbbf24':(data.status==='absent'?'#f87171':'#34d399');
      ctx.strokeStyle=col;ctx.strokeRect(x*sx,y*sy,width*sx,height*sy);
      ctx.fillStyle=col;ctx.font='bold 13px Space Grotesk,sans-serif';
      const confTxt = data.confidence!=null?' ('+data.confidence+'%)':'';
      ctx.fillText((data.status==='late'?'⏰ ':(data.status==='absent'?'❌ ':'✓ '))+data.name+confTxt,x*sx+4,y*sy-8);
      let stMsg = (data.status==='late'?'⏰ Late':(data.status==='absent'?'❌ Absent':'✅ Present'))+': '+data.name+' at '+data.time_in+(data.confidence!=null?' | Accuracy: '+data.confidence+'%':'');
      if(data.status==='late'&&data.expected_checkout) stMsg+=' | Expected out: '+data.expected_checkout;
      setSt(stMsg, data.status==='absent'?'bad':(data.status==='late'?'pulse':'ok'));
      showResult({...data,mode:'checkin'});
      loadStats();loadTable();
      let toastMsg = (data.status==='late'?'⏰ Late':(data.status==='absent'?'❌ Marked Absent':'✅ Present'))+': '+data.name+' at '+data.time_in+(data.confidence!=null?' ('+data.confidence+'%)':'');
      if(data.status==='late'&&data.expected_checkout) toastMsg+=' | Checkout by: '+data.expected_checkout;
      toast(toastMsg, data.status==='absent'?'e':(data.status==='late'?'w':'s'));
    }
  }else if(!data.recognized){
    ctx.strokeStyle='#f87171';ctx.lineWidth=2.5;ctx.strokeRect(x*sx,y*sy,width*sx,height*sy);
    ctx.fillStyle='#f87171';ctx.font='bold 13px Space Grotesk,sans-serif';ctx.fillText('Unknown',x*sx+4,y*sy-8);
    setSt('Unknown face — not registered','bad');showUnknown();toast('Unknown — register first','e');
  }else{
    toast(data.error||'Check-in failed','e');
  }
}

// ── CHECK OUT ─────────────────────────────────────────────────
async function captureCheckout(){
  if(!isReady)return;
  setSt('Scanning for check-out...','pulse');clearC();
  const det=await detectFace();
  if(!det){setSt('No face detected — look at the camera','bad');showIdle();toast('No face detected','e');return;}

  const{x,y,width,height}=det.detection.box;
  const sx=overlay.width/video.videoWidth,sy=overlay.height/video.videoHeight;
  ctx.strokeStyle='#a78bfa';ctx.lineWidth=2.5;
  ctx.strokeRect(x*sx,y*sy,width*sx,height*sy);
  ctx.fillStyle='rgba(167,139,250,0.04)';ctx.fillRect(x*sx,y*sy,width*sx,height*sy);

  const res=await fetch('/api/attendance/checkout',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({descriptor:Array.from(det.descriptor)})
  });
  const data=await res.json();

  if(data.success){
    if(data.already_out){
      ctx.fillStyle='#a78bfa';ctx.font='bold 13px Space Grotesk,sans-serif';
      ctx.fillText(data.name+(data.confidence!=null?' '+data.confidence+'%':''),x*sx+4,y*sy-8);
      setSt('Already checked out: '+data.name,'pulse');
      showResult({...data,mode:'already_out'});
      toast('⚠️ '+data.name+' already checked out today','w');
    }else if(data.early){
      ctx.fillStyle='#fb923c';ctx.font='bold 13px Space Grotesk,sans-serif';
      ctx.fillText('⚠ '+data.name+(data.confidence!=null?' '+data.confidence+'%':''),x*sx+4,y*sy-8);
      ctx.strokeStyle='#fb923c';ctx.strokeRect(x*sx,y*sy,width*sx,height*sy);
      setSt('⚠️ Early leave: '+data.name+' at '+data.time_out+(data.confidence!=null?' | Accuracy: '+data.confidence+'%':''),'pulse');
      showResult({...data,mode:'early'});
      loadStats();loadTable();
      toast('⚠️ '+data.name+' left early at '+data.time_out+(data.confidence!=null?' ('+data.confidence+'%)':''),'w');
    }else{
      ctx.fillStyle='#a78bfa';ctx.font='bold 13px Space Grotesk,sans-serif';
      ctx.fillText('✓ '+data.name+(data.confidence!=null?' '+data.confidence+'%':''),x*sx+4,y*sy-8);
      setSt('🚪 Checked out: '+data.name+' at '+data.time_out+(data.confidence!=null?' | Accuracy: '+data.confidence+'%':''),'ok');
      showResult({...data,mode:'checkout'});
      loadStats();loadTable();
      toast('🚪 '+data.name+' checked out at '+data.time_out+(data.confidence!=null?' ('+data.confidence+'%)':''),'p');
    }
  }else if(data.not_checked_in){
    setSt('Not checked in: '+data.name,'bad');
    toast(data.name+' has no check-in today — check in first','e');
  }else if(!data.recognized){
    ctx.strokeStyle='#f87171';ctx.strokeRect(x*sx,y*sy,width*sx,height*sy);
    ctx.fillStyle='#f87171';ctx.font='bold 13px Space Grotesk,sans-serif';ctx.fillText('Unknown',x*sx+4,y*sy-8);
    setSt('Unknown face','bad');showUnknown();toast('Unknown — register first','e');
  }else{
    toast(data.error||'Checkout failed','e');
  }
}

// ── RESULT DISPLAY ────────────────────────────────────────────
function showIdle(){
  document.getElementById('resultIdle').style.display='flex';
  document.getElementById('recognizedBox').style.display='none';
  document.getElementById('unknownBox').style.display='none';
}
function showUnknown(){
  document.getElementById('resultIdle').style.display='none';
  document.getElementById('recognizedBox').style.display='none';
  document.getElementById('unknownBox').style.display='flex';
}
function showResult(d){
  document.getElementById('resultIdle').style.display='none';
  document.getElementById('unknownBox').style.display='none';
  document.getElementById('recognizedBox').style.display='flex';
  document.getElementById('rAv').textContent=d.name[0].toUpperCase();
  document.getElementById('rName').textContent=d.name;
  document.getElementById('rTimeIn').textContent=d.time_in||'—';
  const badge=document.getElementById('rBadge');
  const tOutEl=document.getElementById('rTimeOut');
  const tOutLbl=document.getElementById('rTimeOutLabel');

  // Live match confidence
  const conf = d.confidence != null ? d.confidence : null;
  const confEl = document.getElementById('rConf');
  const confBar = document.getElementById('rConfBar');
  if(conf != null){
    confEl.textContent = conf+'%';
    confBar.style.width = conf+'%';
    const confColor = conf>=85?'var(--accent2)':conf>=65?'var(--yellow)':'var(--orange)';
    confEl.style.color = confColor;
    confBar.style.background = confColor;
  } else {
    confEl.textContent='—'; confBar.style.width='0%'; confEl.style.color='var(--accent)';
  }

  // Registration quality
  const regAcc = d.registered_accuracy != null ? d.registered_accuracy : null;
  const regEl  = document.getElementById('rRegAcc');
  const regBar = document.getElementById('rRegAccBar');
  if(regAcc != null){
    regEl.textContent = regAcc+'%';
    regBar.style.width = regAcc+'%';
    const regColor = regAcc>=85?'var(--accent2)':regAcc>=65?'var(--yellow)':'var(--orange)';
    regEl.style.color = regColor;
    regBar.style.background = regColor;
  } else {
    regEl.textContent='—'; regBar.style.width='0%'; regEl.style.color='var(--muted)';
  }

  if(d.mode==='checkin'){
    tOutEl.textContent=d.status||'—';
    tOutLbl.textContent='Status';
    if(d.status==='absent'){badge.className='r-badge rb-unk';badge.textContent='❌ Absent (late entry)';}
    else if(d.status==='late'){
      badge.className='r-badge rb-late';badge.textContent='⏰ Late';
      if(d.expected_checkout){tOutEl.textContent=d.expected_checkout;tOutLbl.textContent='Expected Checkout';}
    }
    else{badge.className='r-badge rb-present';badge.textContent='✅ Present';}
  }else if(d.mode==='checkout'){
    tOutEl.textContent=d.time_out||'—';
    tOutLbl.textContent='Time Out';
    badge.className='r-badge rb-checkout';badge.textContent='🚪 Checked Out';
  }else if(d.mode==='early'){
    tOutEl.textContent=d.time_out||'—';
    tOutLbl.textContent='Left Early At';
    badge.className='r-badge rb-early';badge.textContent='⚠️ Early Leave';
  }else if(d.mode==='already'){
    tOutEl.textContent=d.status||'—';
    tOutLbl.textContent='Status';
    badge.className='r-badge rb-already';badge.textContent='⚠️ Already Checked In';
  }else if(d.mode==='already_out'){
    tOutEl.textContent=d.time_out||'—';
    tOutLbl.textContent='Time Out';
    badge.className='r-badge rb-already';badge.textContent='⚠️ Already Checked Out';
  }
}

// ── AUTO MODE ─────────────────────────────────────────────────
function toggleAuto(){
  autoOn=!autoOn;
  const b=document.getElementById('btnA');
  if(autoOn){
    b.textContent='⏹ Stop';b.classList.add('active');
    document.getElementById('btnC').disabled=true;
    document.getElementById('btnCO').disabled=true;
    runAuto();toast('Auto scan ON (Check In mode)','i');
  }else{
    b.textContent='▶ Auto';b.classList.remove('active');
    document.getElementById('btnC').disabled=false;
    document.getElementById('btnCO').disabled=false;
    toast('Auto scan OFF','i');
  }
}
async function runAuto(){while(autoOn){await capture();await new Promise(r=>setTimeout(r,3000));}}

// ── DATA ──────────────────────────────────────────────────────
async function loadStats(){
  try{
    const{stats}=await(await fetch('/api/attendance/stats')).json();
    if(!stats)return;
    document.getElementById('stPresent').textContent=stats.present||0;
    document.getElementById('stLate').textContent=stats.late||0;
    document.getElementById('stEarly').textContent=stats.early||0;
    document.getElementById('stTotal').textContent=stats.total||0;
    document.getElementById('stAbsent').textContent=stats.absent||0;
  }catch(e){}
}

async function loadTable(){
  try{
    const{records=[]}=await(await fetch('/api/attendance/today')).json();
    document.getElementById('aCnt').textContent=records.length+' records';
    const body=document.getElementById('attBody');
    if(!records.length){body.innerHTML='<tr><td colspan="4" class="tbl-empty">No attendance marked yet today</td></tr>';return;}
    const labels={'present':'✅ Present','late':'⏰ Late','early_leave':'⚠️ Early Leave','late_early_leave':'🔴 Late + Early Leave','absent':'❌ Absent'};
    body.innerHTML=records.map(r=>
      '<tr data-name="'+esc(r.name.toLowerCase())+'">' +
      '<td><div class="td-name"><div class="td-av">'+r.name[0].toUpperCase()+'</div>'+esc(r.name)+'</div></td>' +
      '<td><span class="time-pill">'+r.time_in+'</span></td>' +
      '<td><span class="time-pill out">'+r.time_out+'</span></td>' +
      '<td><span class="badge badge-'+r.status+'">'+(labels[r.status]||r.status)+'</span></td>' +
      '</tr>'
    ).join('');
  }catch(e){}
}

function filterTable(q){
  document.querySelectorAll('#attBody tr[data-name]').forEach(r=>{
    r.style.display=r.dataset.name.includes(q.toLowerCase())?'':'none';
  });
}

function clearC(){ctx.clearRect(0,0,overlay.width,overlay.height);}
function setSt(t,type){document.getElementById('st').textContent=t;const d=document.getElementById('sled');d.className='sled';if(type)d.classList.add(type);}
function toast(msg,type='i'){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+type+' show';clearTimeout(t._to);t._to=setTimeout(()=>t.classList.remove('show'),4000);}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

loadStats();loadTable();
setInterval(()=>{loadStats();loadTable();},30000);
</script>
</body>
</html>`;
}

// ─── STATUS LABEL HELPER ──────────────────────────────────────────────────────
function statusLabel(s) {
  const map = {
    present:           '✅ Present',
    late:              '⏰ Late',
    early_leave:       '⚠️ Early Leave',
    late_early_leave:  '🔴 Late + Early',
    absent:            '❌ Absent',
  };
  return map[s] || s;
}

// ─── REGISTER PAGE ────────────────────────────────────────────────────────────
function getRegisterHTML(faces) {
  const rows = faces.map(f => {
    const ra = f.registration_accuracy;
    const raColor = ra >= 85 ? '#34d399' : ra >= 65 ? '#fbbf24' : '#fb923c';
    const raBadge = ra != null
      ? `<span style="font-family:monospace;font-size:0.8rem;font-weight:700;color:${raColor}">${ra}%</span><div style="height:3px;border-radius:2px;background:#1a2540;margin-top:4px;width:60px"><div style="height:100%;width:${ra}%;background:${raColor};border-radius:2px"></div></div>`
      : '<span style="color:#4b5a72;font-size:0.75rem">—</span>';
    return `
    <tr id="fr-${f.id}">
      <td><div class="td-name"><div class="td-av">${f.label[0].toUpperCase()}</div>${escH(f.label)}</div></td>
      <td style="font-family:monospace;font-size:0.77rem;color:#4b5a72">#${f.id}</td>
      <td style="font-size:0.75rem;color:#4b5a72">${f.employee_id||'—'}</td>
      <td style="font-size:0.75rem;color:#4b5a72">${f.department||'—'}</td>
      <td>${raBadge}</td>
      <td style="font-size:0.75rem;color:#4b5a72">${new Date(f.registered_at).toLocaleDateString()}</td>
      <td><button class="del-btn" data-id="${f.id}" data-label="${escH(f.label)}" onclick="delFace(this)">Remove</button></td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Register Face — Attendance</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
:root{
  --bg:#050810;--surface:#0a0f1e;--card:#0d1526;--border:#162035;
  --accent:#4f8ef7;--accent2:#34d399;--red:#f87171;--yellow:#fbbf24;
  --purple:#a78bfa;--text:#e8edf5;--muted:#4b5a72;--muted2:#2a3a54;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Space Grotesk',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 60% 40% at 80% 20%,rgba(167,139,250,0.07),transparent),radial-gradient(ellipse 50% 50% at 20% 80%,rgba(79,142,247,0.05),transparent);pointer-events:none;z-index:0}

nav{position:sticky;top:0;z-index:100;background:rgba(5,8,16,0.92);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 32px;height:62px}
.nav-logo{font-family:'JetBrains Mono',monospace;font-size:1.05rem;font-weight:600;letter-spacing:2px}
.nav-logo span{color:var(--purple)}
.nav-logo em{font-style:normal;font-family:'Space Grotesk',sans-serif;font-size:0.65rem;color:var(--muted);letter-spacing:1px;margin-left:8px;font-weight:400}
.back-btn{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--border);color:var(--muted);font-family:'Space Grotesk',sans-serif;font-size:0.82rem;font-weight:500;padding:8px 16px;border-radius:10px;text-decoration:none;transition:all 0.2s}
.back-btn:hover{border-color:var(--accent);color:var(--text)}

main{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:28px 32px;display:grid;grid-template-columns:420px 1fr;gap:24px}

.left-col{display:flex;flex-direction:column;gap:16px}
.cam-card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.cam-wrap{position:relative;background:#000;aspect-ratio:4/3}
#video{width:100%;height:100%;object-fit:cover;display:block}
#overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.corner{position:absolute;width:22px;height:22px;border-color:var(--purple);border-style:solid;opacity:0.6;pointer-events:none}
.corner.tl{top:14px;left:14px;border-width:2px 0 0 2px}
.corner.tr{top:14px;right:14px;border-width:2px 2px 0 0}
.corner.bl{bottom:14px;left:14px;border-width:0 0 2px 2px}
.corner.br{bottom:14px;right:14px;border-width:0 2px 2px 0}
.cam-status{padding:10px 14px;background:var(--surface);border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;font-size:0.78rem;color:var(--muted)}
.sled{width:7px;height:7px;border-radius:50%;background:var(--muted);flex-shrink:0;transition:background 0.3s}
.sled.pulse{background:var(--yellow);animation:blink 1s infinite}.sled.ok{background:var(--accent2)}.sled.bad{background:var(--red)}.sled.purple{background:var(--purple)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0.2}}

.form-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:22px;display:flex;flex-direction:column;gap:15px}
.form-title{font-family:'JetBrains Mono',monospace;font-size:0.67rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase;padding-bottom:10px;border-bottom:1px solid var(--border)}
.field{display:flex;flex-direction:column;gap:6px}
.field label{font-size:0.73rem;color:var(--muted);font-weight:500}
.field label span{color:var(--red)}
.inp{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 14px;color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:0.87rem;outline:none;transition:border-color 0.2s;width:100%}
.inp:focus{border-color:var(--purple)}.inp::placeholder{color:var(--muted)}
.prog-label{font-size:0.72rem;color:var(--muted);font-family:'JetBrains Mono',monospace}
.prog-track{background:var(--surface);border-radius:4px;height:4px;overflow:hidden;margin-top:5px}
.prog-fill{height:100%;background:linear-gradient(90deg,var(--purple),var(--accent));transition:width 0.3s;width:0}
.reg-btn-main{width:100%;padding:12px;background:linear-gradient(135deg,rgba(167,139,250,0.18),rgba(79,142,247,0.12));border:1px solid rgba(167,139,250,0.35);color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:0.88rem;font-weight:700;border-radius:12px;cursor:pointer;transition:all 0.2s;letter-spacing:0.3px;margin-top:2px}
.reg-btn-main:hover:not(:disabled){background:linear-gradient(135deg,rgba(167,139,250,0.32),rgba(79,142,247,0.22));border-color:rgba(167,139,250,0.55);transform:translateY(-1px);box-shadow:0 4px 22px rgba(167,139,250,0.18)}
.reg-btn-main:disabled{opacity:0.3;cursor:not-allowed}

.right-col{}
.list-card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.list-head{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.list-head h3{font-family:'JetBrains Mono',monospace;font-size:0.7rem;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase}
.list-cnt{background:rgba(167,139,250,0.1);color:var(--purple);font-size:0.72rem;font-weight:700;padding:3px 10px;border-radius:12px;font-family:'JetBrains Mono',monospace}
.list-scroll{overflow-y:auto;max-height:600px}
.list-scroll::-webkit-scrollbar{width:3px}.list-scroll::-webkit-scrollbar-thumb{background:var(--muted2);border-radius:2px}
table{width:100%;border-collapse:collapse}
thead th{padding:9px 14px;text-align:left;font-size:0.65rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:1px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0}
tbody tr{border-bottom:1px solid rgba(22,32,53,0.6);transition:background 0.15s}
tbody tr:last-child{border-bottom:none}
tbody tr:hover{background:rgba(167,139,250,0.03)}
td{padding:10px 14px;font-size:0.82rem;vertical-align:middle}
.td-name{display:flex;align-items:center;gap:10px;font-weight:600}
.td-av{width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#1a1640,#2d1a5c);display:flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:700;color:var(--purple);border:1px solid rgba(167,139,250,0.2);flex-shrink:0}
.del-btn{background:rgba(248,113,113,0.07);border:1px solid rgba(248,113,113,0.18);color:var(--red);font-size:0.72rem;font-weight:600;padding:4px 10px;border-radius:7px;cursor:pointer;font-family:'Space Grotesk',sans-serif;transition:all 0.2s}
.del-btn:hover{background:rgba(248,113,113,0.18)}
.list-empty{text-align:center;padding:44px 20px;color:var(--muted);font-size:0.82rem}

#loadOv{position:fixed;inset:0;background:rgba(5,8,16,0.97);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;z-index:999}
#loadOv.gone{display:none}
.spin{width:46px;height:46px;border:2px solid var(--border);border-top-color:var(--purple);border-radius:50%;animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.load-sub{font-family:'JetBrains Mono',monospace;font-size:0.75rem;color:var(--muted);letter-spacing:1px}
.load-h{font-size:1rem;font-weight:600}
.load-err{font-size:0.8rem;color:var(--red);background:rgba(248,113,113,0.07);border:1px solid rgba(248,113,113,0.18);border-radius:10px;padding:12px 18px;max-width:360px;text-align:center;line-height:1.6;display:none}
.load-err.show{display:block}
.toast{position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:12px;font-size:0.82rem;font-weight:600;opacity:0;transform:translateY(10px);transition:all 0.3s;z-index:500;pointer-events:none;max-width:320px}
.toast.show{opacity:1;transform:translateY(0)}
.toast.s{background:rgba(52,211,153,0.93);color:#000}.toast.e{background:rgba(248,113,113,0.93);color:#fff}.toast.i{background:rgba(79,142,247,0.93);color:#fff}

@media(max-width:900px){main{grid-template-columns:1fr}main{padding:16px}}
</style>
</head>
<body>
<div id="loadOv">
  <div class="spin"></div>
  <div class="load-h" id="loadTitle">Loading Models</div>
  <div class="load-sub" id="loadMsg">Initializing face detection...</div>
  <div class="load-err" id="loadErr"></div>
</div>

<nav>
  <div class="nav-logo">ATTEND<span>.</span>AI <em>/ Register</em></div>
  <div style="display:flex;gap:10px">
    <a class="back-btn" href="/records" style="border-color:rgba(167,139,250,0.3);color:var(--purple)">📊 Records</a>
    <a class="back-btn" href="/">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
      Back to Attendance
    </a>
  </div>
</nav>

<main>
  <div class="left-col">
    <div class="cam-card">
      <div class="cam-wrap">
        <video id="video" autoplay muted playsinline></video>
        <canvas id="overlay"></canvas>
        <div class="corner tl"></div><div class="corner tr"></div>
        <div class="corner bl"></div><div class="corner br"></div>
      </div>
      <div class="cam-status">
        <div class="sled pulse" id="sled"></div>
        <span id="st">Loading models...</span>
      </div>
    </div>
    <div class="form-card">
      <div class="form-title">New Face Registration</div>
      <div class="field">
        <label>Full Name <span>*</span></label>
        <input class="inp" id="inp_name" placeholder="e.g. Arjun Sharma" maxlength="100"/>
      </div>
      <div class="field">
        <label>Employee / Student ID</label>
        <input class="inp" id="inp_empid" placeholder="Optional" maxlength="50"/>
      </div>
      <div class="field">
        <label>Department / Class</label>
        <input class="inp" id="inp_dept" placeholder="Optional" maxlength="100"/>
      </div>
      <div>
        <div class="prog-label" id="pL">Fill in name and click the button below</div>
        <div class="prog-track"><div class="prog-fill" id="pB"></div></div>
      </div>
      <button class="reg-btn-main" id="regBtn" disabled onclick="registerFace()">
        📸 Capture &amp; Register Face
      </button>
    </div>
  </div>

  <div class="right-col">
    <div class="list-card">
      <div class="list-head">
        <h3>Registered People</h3>
        <span class="list-cnt" id="listCnt">${faces.length}</span>
      </div>
      <div class="list-scroll">
        <table>
          <thead><tr><th>Name</th><th>DB ID</th><th>Emp ID</th><th>Dept</th><th>Reg. Quality</th><th>Registered</th><th></th></tr></thead>
          <tbody id="facesTbody">
            ${rows || '<tr><td colspan="6" class="list-empty">No faces registered yet.<br/>Use the camera on the left to enroll people.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  </div>
</main>

<div class="toast" id="toast"></div>

<script>
const MODEL_URL   = '/models';
const REG_SAMPLES = ${REGISTER_SAMPLES};
let isReady = false;
const video   = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx     = overlay.getContext('2d');

function showErr(msg){document.getElementById('loadTitle').textContent='❌ Error';document.getElementById('loadMsg').style.display='none';document.querySelector('.spin').style.display='none';const el=document.getElementById('loadErr');el.textContent=msg;el.classList.add('show');}
function setLoad(t,m){document.getElementById('loadTitle').textContent=t;document.getElementById('loadMsg').textContent=m;}

const sc=document.createElement('script');sc.src='/faceapi.js';
sc.onload=init;sc.onerror=()=>showErr('Could not load face-api.js');
document.head.appendChild(sc);

async function init(){
  try{
    setLoad('Loading Models','Starting up...');
    const probe=await fetch('/models/ssd_mobilenetv1_model-weights_manifest.json');
    if(!probe.ok){showErr('Models not ready. Wait and refresh.');return;}
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    let stream;
    try{stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},facingMode:'user'}});}
    catch(e){showErr('Camera denied: '+e.message);return;}
    video.srcObject=stream;
    await new Promise(r=>video.onloadedmetadata=r);
    await video.play();
    await new Promise(r=>setTimeout(r,400));
    overlay.width=video.videoWidth||640;overlay.height=video.videoHeight||480;
    document.getElementById('loadOv').classList.add('gone');
    isReady=true;
    document.getElementById('regBtn').disabled=false;
    setSt('Camera ready — fill details and register','ok');
  }catch(e){showErr(e.message);}
}

async function detectFace(){
  return faceapi
    .detectSingleFace(video,new faceapi.SsdMobilenetv1Options({minConfidence:0.35}))
    .withFaceLandmarks().withFaceDescriptor();
}
function avgDesc(descs){
  const len=descs[0].length,avg=new Float32Array(len);
  for(const d of descs)for(let i=0;i<len;i++)avg[i]+=d[i]/descs.length;
  return Array.from(avg);
}

async function registerFace(){
  const name=document.getElementById('inp_name').value.trim();
  const empid=document.getElementById('inp_empid').value.trim();
  const dept=document.getElementById('inp_dept').value.trim();
  if(!name){toast('Name is required','e');document.getElementById('inp_name').focus();return;}
  if(!isReady)return;
  const btn=document.getElementById('regBtn'),pB=document.getElementById('pB'),pL=document.getElementById('pL');
  btn.disabled=true;btn.textContent='⏳ Capturing...';
  setSt('Capturing samples — hold still...','purple');
  const descs=[];
  const detScores=[];  // face detection confidence scores per sample
  for(let i=0;i<REG_SAMPLES;i++){
    pL.textContent='Sample '+(i+1)+'/'+REG_SAMPLES+' — hold still...';
    pB.style.width=(i/REG_SAMPLES*100)+'%';
    await new Promise(r=>setTimeout(r,400));
    let det=await detectFace();
    if(!det){await new Promise(r=>setTimeout(r,500));det=await detectFace();}
    if(det){
      descs.push(det.descriptor);
      const score = det.detection.score || 0;
      detScores.push(score);
      const{x,y,width,height}=det.detection.box;
      const sx=overlay.width/video.videoWidth,sy=overlay.height/video.videoHeight;
      ctx.clearRect(0,0,overlay.width,overlay.height);
      ctx.strokeStyle='#a78bfa';ctx.lineWidth=2;
      ctx.strokeRect(x*sx,y*sy,width*sx,height*sy);
      // Show per-sample score on canvas
      const pct=Math.round(score*100);
      const col=pct>=85?'#34d399':pct>=65?'#fbbf24':'#fb923c';
      ctx.fillStyle=col;ctx.font='bold 12px Space Grotesk,monospace';
      ctx.fillText('Sample '+(i+1)+': '+pct+'%',x*sx+4,y*sy-8);
      pL.textContent='Sample '+(i+1)+'/'+REG_SAMPLES+' — detected at '+pct+'%';
    } else {
      pL.textContent='Sample '+(i+1)+'/'+REG_SAMPLES+' — face not detected, skipping';
    }
  }
  pB.style.width='100%';
  if(!descs.length){
    toast('No face captured — try again','e');pL.textContent='No face detected — move closer and retry';
    setSt('No face detected','bad');btn.disabled=false;btn.textContent='📸 Capture & Register Face';pB.style.width='0';return;
  }
  // Registration accuracy = average of detection confidence scores
  const avgScore = detScores.reduce((a,b)=>a+b,0)/detScores.length;
  const registration_accuracy = Math.round(avgScore*100);

  pL.textContent='Got '+descs.length+'/'+REG_SAMPLES+' samples | Reg. Quality: '+registration_accuracy+'% — saving...';
  const res=await fetch('/api/register',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({label:name,employee_id:empid,department:dept,descriptor:avgDesc(descs),registration_accuracy})
  });
  const data=await res.json();
  ctx.clearRect(0,0,overlay.width,overlay.height);
  if(res.ok){
    const accColor=registration_accuracy>=85?'#34d399':registration_accuracy>=65?'#fbbf24':'#fb923c';
    toast('✅ "'+name+'" registered! Quality: '+registration_accuracy+'%','s');
    pL.textContent='✅ Registered: '+name+' | Quality: '+registration_accuracy+'%';
    setSt('✅ Registered: '+name+' | Reg. Quality: '+registration_accuracy+'%','ok');
    document.getElementById('inp_name').value='';
    document.getElementById('inp_empid').value='';
    document.getElementById('inp_dept').value='';
    loadFacesList();
  }else{
    toast(data.error||'Registration failed','e');
    pL.textContent='Error: '+(data.error||'Failed');
    setSt('Registration failed','bad');
  }
  btn.disabled=false;btn.textContent='📸 Capture & Register Face';pB.style.width='0';
}

document.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&document.activeElement.classList.contains('inp'))registerFace();
});

async function loadFacesList(){
  const{faces=[]}=await(await fetch('/api/faces')).json();
  document.getElementById('listCnt').textContent=faces.length;
  const tbody=document.getElementById('facesTbody');
  if(!faces.length){tbody.innerHTML='<tr><td colspan="7" class="list-empty">No faces registered yet.</td></tr>';return;}
  tbody.innerHTML=faces.map(f=>{
    const ra=f.registration_accuracy;
    const raColor=ra>=85?'var(--accent2)':ra>=65?'var(--yellow)':'var(--orange)';
    const raBadge=ra!=null
      ? '<span style="font-family:monospace;font-size:0.8rem;font-weight:700;color:'+raColor+'">'+ra+'%</span>'
        +'<div style="height:3px;border-radius:2px;background:#1a2540;margin-top:4px;width:60px"><div style="height:100%;width:'+ra+'%;background:'+raColor+';border-radius:2px"></div></div>'
      : '<span style="color:var(--muted);font-size:0.75rem">—</span>';
    return '<tr id="fr-'+f.id+'">' +
      '<td><div class="td-name"><div class="td-av">'+f.label[0].toUpperCase()+'</div>'+esc(f.label)+'</div></td>' +
      '<td style="font-family:monospace;font-size:0.77rem;color:#4b5a72">#'+f.id+'</td>' +
      '<td style="font-size:0.75rem;color:#4b5a72">'+(f.employee_id||'—')+'</td>' +
      '<td style="font-size:0.75rem;color:#4b5a72">'+(f.department||'—')+'</td>' +
      '<td>'+raBadge+'</td>' +
      '<td style="font-size:0.75rem;color:#4b5a72">'+new Date(f.registered_at).toLocaleDateString()+'</td>' +
      '<td><button class="del-btn" data-id="'+f.id+'" data-label="'+esc(f.label)+'" onclick="delFace(this)">Remove</button></td>' +
      '</tr>';
  }).join('');
}

async function delFace(btn){
  const id=parseInt(btn.dataset.id),label=btn.dataset.label;
  if(!confirm('Remove "'+label+'"? This will also delete all their attendance records.'))return;
  const r=await fetch('/api/faces/'+id,{method:'DELETE'});
  if(r.ok){const row=document.getElementById('fr-'+id);if(row){row.style.transition='all 0.3s';row.style.opacity='0';setTimeout(()=>row.remove(),300);}toast('"'+label+'" removed','i');loadFacesList();}
  else toast('Delete failed','e');
}

function setSt(t,type){document.getElementById('st').textContent=t;const d=document.getElementById('sled');d.className='sled';if(type)d.classList.add(type);}
function toast(msg,type='i'){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+type+' show';clearTimeout(t._to);t._to=setTimeout(()=>t.classList.remove('show'),3500);}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
</script>
</body>
</html>`;
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────

app.get('/api/faces', async (req, res) => {
  try {
    const rows = await dbQuery('SELECT id, label, employee_id, department, registration_accuracy, registered_at FROM faces ORDER BY registered_at DESC');
    res.json({ faces: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/register', async (req, res) => {
  try {
    const { label, employee_id='', department='', descriptor, registration_accuracy=null } = req.body;
    if (!label || !descriptor) return res.status(400).json({ error: 'Name and descriptor required' });
    const result = await dbQuery(
      'INSERT INTO faces (label, employee_id, department, descriptor, registration_accuracy) VALUES (?,?,?,?,?)',
      [label, employee_id, department, JSON.stringify(descriptor), registration_accuracy]
    );
    res.status(201).json({ success: true, id: result.insertId, label, registration_accuracy });
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: '"'+req.body.label+'" is already registered' });
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

// ── CHECK IN ──────────────────────────────────────────────────────────────────
app.post('/api/attendance/mark', async (req, res) => {
  try {
    const { descriptor } = req.body;
    if (!Array.isArray(descriptor)) return res.status(400).json({ error: 'descriptor required' });

    const faces = await dbQuery('SELECT id, label, descriptor, registration_accuracy FROM faces');
    if (!faces.length) return res.json({ success: false, recognized: false });

    let best = null, bestD = Infinity;
    for (const f of faces) {
      const d = euclidean(descriptor, JSON.parse(f.descriptor));
      if (d < bestD) { bestD = d; best = f; }
    }
    if (!best || bestD >= THRESHOLD) return res.json({ success: false, recognized: false });

    const confidence = Math.round(Math.max(0, Math.min(100, (1 - bestD / THRESHOLD) * 100)));
    const registered_accuracy = best.registration_accuracy || null;

    const today    = new Date().toISOString().slice(0, 10);
    const nowDate  = new Date();
    const timeStr  = nowDate.toTimeString().slice(0, 8);
    const totalMin = nowDate.getHours() * 60 + nowDate.getMinutes();

    // After 11:00 AM → absent
    let status = 'present';
    if (totalMin >= ABSENT_AFTER_MIN) {
      status = 'absent';
    } else if (totalMin > LATE_AFTER) {
      status = 'late';
    }

    // Calculate expected checkout for late arrivals
    const expectedCheckout = (status === 'late') ? calcExpectedCheckout(timeStr) : null;

    // Already checked in today?
    const existing = await dbQuery(
      'SELECT id, time_in, status, expected_checkout FROM attendance WHERE face_id=? AND date=?',
      [best.id, today]
    );
    if (existing.length) {
      return res.json({
        success: true, recognized: true, already: true, confidence, registered_accuracy,
        name: best.label, time_in: fmtTime(existing[0].time_in), status: existing[0].status,
        expected_checkout: existing[0].expected_checkout ? fmtTime(existing[0].expected_checkout) : null
      });
    }

    await dbQuery(
      'INSERT INTO attendance (face_id, name, date, time_in, status, expected_checkout) VALUES (?,?,?,?,?,?)',
      [best.id, best.label, today, timeStr, status, expectedCheckout]
    );
    res.json({ success: true, recognized: true, already: false, confidence, registered_accuracy, name: best.label, time_in: fmtTime(timeStr), status, expected_checkout: expectedCheckout ? fmtTime(expectedCheckout) : null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CHECK OUT ─────────────────────────────────────────────────────────────────
app.post('/api/attendance/checkout', async (req, res) => {
  try {
    const { descriptor } = req.body;
    if (!Array.isArray(descriptor)) return res.status(400).json({ error: 'descriptor required' });

    const faces = await dbQuery('SELECT id, label, descriptor, registration_accuracy FROM faces');
    if (!faces.length) return res.json({ success: false, recognized: false });

    let best = null, bestD = Infinity;
    for (const f of faces) {
      const d = euclidean(descriptor, JSON.parse(f.descriptor));
      if (d < bestD) { bestD = d; best = f; }
    }
    if (!best || bestD >= THRESHOLD) return res.json({ success: false, recognized: false });

    const confidence = Math.round(Math.max(0, Math.min(100, (1 - bestD / THRESHOLD) * 100)));
    const registered_accuracy = best.registration_accuracy || null;

    const today    = new Date().toISOString().slice(0, 10);
    const nowDate  = new Date();
    const timeStr  = nowDate.toTimeString().slice(0, 8);
    const totalMin = nowDate.getHours() * 60 + nowDate.getMinutes();
    const isEarly  = totalMin < CHECKOUT_FROM; // before 6:10 PM

    // Must have checked in first
    const existing = await dbQuery(
      'SELECT id, time_in, time_out, status FROM attendance WHERE face_id=? AND date=?',
      [best.id, today]
    );
    if (!existing.length) {
      return res.json({ success: false, not_checked_in: true, name: best.label });
    }

    // Already checked out?
    if (existing[0].time_out) {
      return res.json({
        success: true, already_out: true, confidence, registered_accuracy, name: best.label,
        time_in: fmtTime(existing[0].time_in), time_out: fmtTime(existing[0].time_out),
        status: existing[0].status
      });
    }

    // Determine final status
    // was_late + early_leave → late_early_leave
    const wasLate   = existing[0].status === 'late';
    const newStatus = isEarly
      ? (wasLate ? 'late_early_leave' : 'early_leave')
      : existing[0].status; // keep present/late if on time checkout

    await dbQuery(
      'UPDATE attendance SET time_out=?, status=? WHERE face_id=? AND date=?',
      [timeStr, newStatus, best.id, today]
    );

    res.json({
      success: true, recognized: true, already_out: false, confidence, registered_accuracy,
      name: best.label, time_in: fmtTime(existing[0].time_in),
      time_out: fmtTime(timeStr), early: isEarly, status: newStatus
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TODAY'S RECORDS ───────────────────────────────────────────────────────────
app.get('/api/attendance/today', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const records = await dbQuery(
      `SELECT a.face_id, a.name, a.time_in, a.time_out, a.status,
              f.employee_id, f.department
       FROM attendance a JOIN faces f ON a.face_id=f.id
       WHERE a.date=? ORDER BY a.time_in ASC`, [today]
    );
    res.json({ records: records.map(r => ({
      ...r, time_in: fmtTime(r.time_in), time_out: fmtTime(r.time_out)
    }))});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── STATS ─────────────────────────────────────────────────────────────────────
app.get('/api/attendance/stats', async (req, res) => {
  try {
    const today     = new Date().toISOString().slice(0, 10);
    const totalRows = await dbQuery('SELECT COUNT(*) AS c FROM faces');
    const statusRows = await dbQuery(
      'SELECT status, COUNT(*) AS c FROM attendance WHERE date=? GROUP BY status', [today]
    );
    const by = {};
    for (const r of statusRows) by[r.status] = r.c;
    const totalFaces = totalRows[0].c || 0;
    const present    = (by.present || 0);
    const late       = (by.late    || 0);
    const earlyLeave = (by.early_leave || 0) + (by.late_early_leave || 0);
    const checkedIn  = present + late + earlyLeave;
    const absent     = Math.max(0, totalFaces - checkedIn);
    res.json({ stats: { total: totalFaces, present, late, early: earlyLeave, absent } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RECORDS (date range, filters) ─────────────────────────────────────────────
app.get('/api/attendance/records', async (req, res) => {
  try {
    const { from, to, status, department, name } = req.query;
    let sql = `SELECT a.id, a.face_id, a.name, a.date, a.time_in, a.time_out,
                      a.expected_checkout, a.status, a.created_at,
                      f.employee_id, f.department
               FROM attendance a JOIN faces f ON a.face_id=f.id WHERE 1=1`;
    const params = [];
    if (from)       { sql += ' AND a.date >= ?'; params.push(from); }
    if (to)         { sql += ' AND a.date <= ?'; params.push(to); }
    if (status)     { sql += ' AND a.status = ?'; params.push(status); }
    if (department) { sql += ' AND f.department = ?'; params.push(department); }
    if (name)       { sql += ' AND a.name LIKE ?'; params.push('%'+name+'%'); }
    sql += ' ORDER BY a.date DESC, a.time_in ASC';
    const records = await dbQuery(sql, params);
    // Calculate working hours per record
    const result = records.map(r => {
      const wMin = calcWorkingMinutes(r.time_in, r.time_out);
      return {
        ...r,
        time_in: fmtTime(r.time_in),
        time_out: fmtTime(r.time_out),
        expected_checkout: r.expected_checkout ? fmtTime(r.expected_checkout) : null,
        working_hours: calcWorkingHours(r.time_in, r.time_out),
        working_minutes: wMin
      };
    });
    // Total working minutes across all records
    const totalMin = result.reduce((s, r) => s + r.working_minutes, 0);
    const totalH = Math.floor(totalMin / 60), totalM = totalMin % 60;
    res.json({ records: result, total_working: `${totalH}h ${totalM}m`, total_working_minutes: totalMin });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DEPARTMENTS LIST ──────────────────────────────────────────────────────────
app.get('/api/departments', async (req, res) => {
  try {
    const rows = await dbQuery('SELECT DISTINCT department FROM faces WHERE department != "" ORDER BY department');
    res.json({ departments: rows.map(r => r.department) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── RECORDS PAGE HTML ────────────────────────────────────────────────────────
function getRecordsHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Attendance Records</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
:root{
  --bg:#050810;--surface:#0a0f1e;--card:#0d1526;--border:#162035;
  --accent:#4f8ef7;--accent2:#34d399;--red:#f87171;--yellow:#fbbf24;
  --purple:#a78bfa;--orange:#fb923c;--text:#e8edf5;--muted:#4b5a72;--muted2:#2a3a54;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Space Grotesk',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 50% at 50% -10%,rgba(79,142,247,0.07),transparent);pointer-events:none;z-index:0}

nav{position:sticky;top:0;z-index:100;background:rgba(5,8,16,0.92);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 32px;height:62px}
.nav-left{display:flex;align-items:center;gap:16px}
.nav-logo{font-family:'JetBrains Mono',monospace;font-size:1.05rem;font-weight:600;letter-spacing:2px}
.nav-logo span{color:var(--accent)}
.nav-right{display:flex;align-items:center;gap:10px}
.nav-link{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--border);color:var(--muted);font-family:'Space Grotesk',sans-serif;font-size:0.82rem;font-weight:500;padding:8px 16px;border-radius:10px;text-decoration:none;transition:all 0.2s}
.nav-link:hover{border-color:var(--accent);color:var(--text)}
.nav-link.active{border-color:rgba(79,142,247,0.4);color:var(--accent);background:rgba(79,142,247,0.08)}

main{position:relative;z-index:1;max-width:1500px;margin:0 auto;padding:28px 32px}

/* filter bar */
.filter-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px 20px;margin-bottom:20px}
.filter-title{font-family:'JetBrains Mono',monospace;font-size:0.62rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:14px}
.filter-row{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap}
.filter-group{display:flex;flex-direction:column;gap:5px}
.filter-label{font-size:0.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.8px}
.filter-inp,.filter-sel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:0.82rem;outline:none;transition:border-color 0.2s;min-width:130px}
.filter-inp:focus,.filter-sel:focus{border-color:var(--accent)}
.filter-inp::placeholder{color:var(--muted)}
.filter-sel option{background:var(--card)}
.btn-filter{padding:9px 18px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-family:'Space Grotesk',sans-serif;font-size:0.82rem;font-weight:600;cursor:pointer;transition:all 0.18s}
.btn-filter:hover{background:#3b7de8;transform:translateY(-1px)}
.btn-clear{padding:9px 14px;border:1px solid var(--border);border-radius:9px;background:transparent;color:var(--muted);font-family:'Space Grotesk',sans-serif;font-size:0.82rem;cursor:pointer;transition:all 0.18s}
.btn-clear:hover{border-color:var(--red);color:var(--red)}

/* summary bar */
.summary-bar{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:20px}
.sum-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.sum-val{font-family:'JetBrains Mono',monospace;font-size:1.4rem;font-weight:600;color:var(--accent);line-height:1}
.sum-val.green{color:var(--accent2)}.sum-val.yellow{color:var(--yellow)}.sum-val.orange{color:var(--orange)}.sum-val.red{color:var(--red)}.sum-val.purple{color:var(--purple)}
.sum-lbl{font-size:0.63rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:5px}

/* table */
.table-card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.table-head{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border)}
.table-head h3{font-family:'JetBrains Mono',monospace;font-size:0.7rem;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase}
.cnt-pill{background:rgba(79,142,247,0.1);color:var(--accent);font-size:0.72rem;font-weight:600;padding:3px 10px;border-radius:12px;font-family:'JetBrains Mono',monospace}
.tbl-wrap{overflow-x:auto;max-height:600px;overflow-y:auto}
.tbl-wrap::-webkit-scrollbar{width:3px;height:3px}.tbl-wrap::-webkit-scrollbar-thumb{background:var(--muted2);border-radius:2px}
table{width:100%;border-collapse:collapse}
thead th{padding:10px 14px;text-align:left;font-size:0.63rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:1px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;white-space:nowrap}
tbody tr{border-bottom:1px solid rgba(22,32,53,0.6);transition:background 0.15s}
tbody tr:last-child{border-bottom:none}
tbody tr:hover{background:rgba(79,142,247,0.03)}
td{padding:10px 14px;font-size:0.82rem;vertical-align:middle;white-space:nowrap}
.td-name{display:flex;align-items:center;gap:9px;font-weight:600}
.td-av{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#162040,#1e3a6e);display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700;color:var(--accent);border:1px solid rgba(79,142,247,0.2);flex-shrink:0}
.time-pill{font-family:'JetBrains Mono',monospace;font-size:0.74rem;background:rgba(79,142,247,0.08);color:var(--accent);padding:2px 9px;border-radius:20px;border:1px solid rgba(79,142,247,0.12)}
.time-pill.out{background:rgba(167,139,250,0.08);color:var(--purple);border-color:rgba(167,139,250,0.12)}
.time-pill.exp{background:rgba(251,191,36,0.08);color:var(--yellow);border-color:rgba(251,191,36,0.12)}
.time-pill.work{background:rgba(52,211,153,0.08);color:var(--accent2);border-color:rgba(52,211,153,0.12)}
.badge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:20px;font-size:0.65rem;font-weight:600;letter-spacing:0.3px;text-transform:uppercase;white-space:nowrap}
.badge-present{background:rgba(52,211,153,0.08);color:var(--accent2);border:1px solid rgba(52,211,153,0.18)}
.badge-late{background:rgba(251,191,36,0.08);color:var(--yellow);border:1px solid rgba(251,191,36,0.18)}
.badge-early_leave{background:rgba(251,146,60,0.08);color:var(--orange);border:1px solid rgba(251,146,60,0.18)}
.badge-late_early_leave{background:rgba(248,113,113,0.08);color:var(--red);border:1px solid rgba(248,113,113,0.18)}
.badge-absent{background:rgba(248,113,113,0.08);color:var(--red);border:1px solid rgba(248,113,113,0.18)}
.tbl-empty{text-align:center;padding:60px;color:var(--muted);font-size:0.84rem}
.date-chip{font-family:'JetBrains Mono',monospace;font-size:0.74rem;color:var(--muted);background:var(--surface);padding:2px 9px;border-radius:6px;border:1px solid var(--border)}

/* total bar */
.total-work-bar{display:flex;align-items:center;gap:14px;background:rgba(52,211,153,0.05);border:1px solid rgba(52,211,153,0.12);border-radius:10px;padding:10px 18px;margin-top:12px}
.tw-label{font-size:0.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px}
.tw-val{font-family:'JetBrains Mono',monospace;font-size:1.05rem;font-weight:600;color:var(--accent2)}
.tw-note{font-size:0.72rem;color:var(--muted);margin-left:auto}

.loading-row td{text-align:center;padding:50px;color:var(--muted)}
</style>
</head>
<body>
<nav>
  <div class="nav-left">
    <div class="nav-logo">FACE<span>·</span>ATT <em style="font-size:0.6rem;color:var(--muted);letter-spacing:1px;margin-left:6px;font-weight:400;font-family:'Space Grotesk',sans-serif">RECORDS</em></div>
  </div>
  <div class="nav-right">
    <a href="/" class="nav-link">📋 Today</a>
    <a href="/records" class="nav-link active">📊 Records</a>
    <a href="/register" class="nav-link">👤 Register</a>
  </div>
</nav>
<main>

  <!-- FILTER BAR -->
  <div class="filter-card">
    <div class="filter-title">🔍 Filter Records</div>
    <div class="filter-row">
      <div class="filter-group">
        <div class="filter-label">From Date</div>
        <input type="date" id="fFrom" class="filter-inp" />
      </div>
      <div class="filter-group">
        <div class="filter-label">To Date</div>
        <input type="date" id="fTo" class="filter-inp" />
      </div>
      <div class="filter-group">
        <div class="filter-label">Status</div>
        <select id="fStatus" class="filter-sel">
          <option value="">All Statuses</option>
          <option value="present">✅ Present</option>
          <option value="late">⏰ Late</option>
          <option value="early_leave">⚠️ Early Leave</option>
          <option value="late_early_leave">🔴 Late + Early Leave</option>
          <option value="absent">❌ Absent</option>
        </select>
      </div>
      <div class="filter-group">
        <div class="filter-label">Department</div>
        <select id="fDept" class="filter-sel"><option value="">All Departments</option></select>
      </div>
      <div class="filter-group">
        <div class="filter-label">Name Search</div>
        <input type="text" id="fName" class="filter-inp" placeholder="Search name..." />
      </div>
      <div class="filter-group">
        <div class="filter-label">&nbsp;</div>
        <div style="display:flex;gap:8px">
          <button class="btn-filter" onclick="applyFilters()">🔍 Apply</button>
          <button class="btn-clear" onclick="clearFilters()">✕ Clear</button>
        </div>
      </div>
    </div>
  </div>

  <!-- SUMMARY BAR -->
  <div class="summary-bar">
    <div class="sum-card"><div class="sum-val" id="sumTotal">—</div><div class="sum-lbl">Total Records</div></div>
    <div class="sum-card"><div class="sum-val green" id="sumPresent">—</div><div class="sum-lbl">Present</div></div>
    <div class="sum-card"><div class="sum-val yellow" id="sumLate">—</div><div class="sum-lbl">Late</div></div>
    <div class="sum-card"><div class="sum-val orange" id="sumEarly">—</div><div class="sum-lbl">Early Leave</div></div>
    <div class="sum-card"><div class="sum-val red" id="sumAbsent">—</div><div class="sum-lbl">Absent</div></div>
    <div class="sum-card"><div class="sum-val purple" id="sumWork">—</div><div class="sum-lbl">Total Work Hours</div></div>
  </div>

  <!-- TABLE -->
  <div class="table-card">
    <div class="table-head">
      <h3>📋 Attendance Records</h3>
      <span class="cnt-pill" id="recCnt">loading...</span>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Emp ID</th>
            <th>Department</th>
            <th>Date</th>
            <th>Check In</th>
            <th>Check Out</th>
            <th>Exp. Checkout</th>
            <th>Working Hours</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="recBody">
          <tr class="loading-row"><td colspan="9">Loading records...</td></tr>
        </tbody>
      </table>
    </div>
    <div id="totalWorkBar" class="total-work-bar" style="margin:12px 16px 16px;display:none">
      <span class="tw-label">Total Working Hours (selected range):</span>
      <span class="tw-val" id="totalWorkVal">0h 0m</span>
      <span class="tw-note" id="totalWorkNote"></span>
    </div>
  </div>

</main>

<script>
const statusLabels = {
  present:'✅ Present', late:'⏰ Late', early_leave:'⚠️ Early Leave',
  late_early_leave:'🔴 Late + Early', absent:'❌ Absent'
};

function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function fmt(s){return s||'—';}

// Set default date range to current month
(function setDefaults(){
  const now = new Date();
  const y = now.getFullYear(), m = String(now.getMonth()+1).padStart(2,'0');
  const d = String(now.getDate()).padStart(2,'0');
  document.getElementById('fFrom').value = y+'-'+m+'-01';
  document.getElementById('fTo').value   = y+'-'+m+'-'+d;
})();

// Load departments
(async function loadDepts(){
  try{
    const {departments=[]} = await(await fetch('/api/departments')).json();
    const sel = document.getElementById('fDept');
    departments.forEach(d=>{
      const o=document.createElement('option');o.value=d;o.textContent=d;sel.appendChild(o);
    });
  }catch(e){}
})();

async function applyFilters(){
  const from   = document.getElementById('fFrom').value;
  const to     = document.getElementById('fTo').value;
  const status = document.getElementById('fStatus').value;
  const dept   = document.getElementById('fDept').value;
  const name   = document.getElementById('fName').value.trim();

  const body = document.getElementById('recBody');
  body.innerHTML='<tr class="loading-row"><td colspan="9">Loading...</td></tr>';

  const params = new URLSearchParams();
  if(from)   params.set('from',from);
  if(to)     params.set('to',to);
  if(status) params.set('status',status);
  if(dept)   params.set('department',dept);
  if(name)   params.set('name',name);

  try{
    const {records=[], total_working='0h 0m', total_working_minutes=0} =
      await(await fetch('/api/attendance/records?'+params)).json();

    document.getElementById('recCnt').textContent = records.length+' records';

    // Summary counts
    const counts = {present:0,late:0,early_leave:0,late_early_leave:0,absent:0};
    records.forEach(r=>{if(counts[r.status]!==undefined)counts[r.status]++;});
    document.getElementById('sumTotal').textContent   = records.length;
    document.getElementById('sumPresent').textContent = counts.present;
    document.getElementById('sumLate').textContent    = counts.late;
    document.getElementById('sumEarly').textContent   = counts.early_leave + counts.late_early_leave;
    document.getElementById('sumAbsent').textContent  = counts.absent;
    const th = Math.floor(total_working_minutes/60), tm = total_working_minutes%60;
    document.getElementById('sumWork').textContent    = th+'h '+tm+'m';

    // Total bar
    if(records.length){
      document.getElementById('totalWorkVal').textContent = total_working;
      let note = '';
      if(from && to) note = 'Date range: '+from+' → '+to;
      document.getElementById('totalWorkNote').textContent = note;
      document.getElementById('totalWorkBar').style.display = 'flex';
    } else {
      document.getElementById('totalWorkBar').style.display = 'none';
    }

    if(!records.length){
      body.innerHTML='<tr><td colspan="9" class="tbl-empty">No records found for selected filters</td></tr>';
      return;
    }

    body.innerHTML = records.map(r => {
      const wh = r.working_hours ? '<span class="time-pill work">'+esc(r.working_hours)+'</span>' : '<span style="color:var(--muted)">—</span>';
      const exp = r.expected_checkout
        ? '<span class="time-pill exp">'+esc(r.expected_checkout)+'</span>'
        : '<span style="color:var(--muted)">—</span>';
      return '<tr>'+
        '<td><div class="td-name"><div class="td-av">'+esc(r.name[0].toUpperCase())+'</div>'+esc(r.name)+'</div></td>'+
        '<td style="color:var(--muted);font-family:monospace;font-size:0.75rem">'+(r.employee_id||'—')+'</td>'+
        '<td style="color:var(--muted);font-size:0.75rem">'+(r.department||'—')+'</td>'+
        '<td><span class="date-chip">'+esc(r.date)+'</span></td>'+
        '<td><span class="time-pill">'+esc(r.time_in)+'</span></td>'+
        '<td><span class="time-pill out">'+esc(r.time_out||'—')+'</span></td>'+
        '<td>'+exp+'</td>'+
        '<td>'+wh+'</td>'+
        '<td><span class="badge badge-'+esc(r.status)+'">'+(statusLabels[r.status]||r.status)+'</span></td>'+
        '</tr>';
    }).join('');
  }catch(e){
    body.innerHTML='<tr><td colspan="9" class="tbl-empty" style="color:var(--red)">Error loading records: '+esc(e.message)+'</td></tr>';
  }
}

function clearFilters(){
  document.getElementById('fStatus').value='';
  document.getElementById('fDept').value='';
  document.getElementById('fName').value='';
  const now=new Date();
  const y=now.getFullYear(),m=String(now.getMonth()+1).padStart(2,'0'),d=String(now.getDate()).padStart(2,'0');
  document.getElementById('fFrom').value=y+'-'+m+'-01';
  document.getElementById('fTo').value=y+'-'+m+'-'+d;
  applyFilters();
}

document.getElementById('fName').addEventListener('keydown',e=>{ if(e.key==='Enter') applyFilters(); });

// Auto load on page open
applyFilters();
</script>
</body>
</html>`;
}

// ─── PAGE ROUTES ──────────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const records = await dbQuery(
      `SELECT a.face_id, a.name, a.time_in, a.time_out, a.status
       FROM attendance a WHERE a.date=? ORDER BY a.time_in ASC`, [today]
    );
    res.send(getAttendanceHTML(records.map(r => ({
      ...r, time_in: fmtTime(r.time_in), time_out: fmtTime(r.time_out)
    }))));
  } catch(e) { res.status(500).send('DB error: ' + e.message); }
});

app.get('/register', async (req, res) => {
  try {
    const faces = await dbQuery('SELECT id, label, employee_id, department, registered_at FROM faces ORDER BY registered_at DESC');
    res.send(getRegisterHTML(faces));
  } catch(e) { res.status(500).send('DB error: ' + e.message); }
});

app.get('/records', (req, res) => {
  res.send(getRecordsHTML());
});

// ─── START ────────────────────────────────────────────────────────────────────
setup().then(() => {
  app.listen(PORT, () => {
    console.log('\n==========================================');
    console.log('🚀  http://localhost:' + PORT);
    console.log('📋  Attendance → http://localhost:' + PORT + '/');
    console.log('📊  Records    → http://localhost:' + PORT + '/records');
    console.log('👤  Register   → http://localhost:' + PORT + '/register');
    console.log('⏰  Office: ' + OFFICE_START.h + ':' + String(OFFICE_START.m).padStart(2,'0') +
      ' AM  |  Grace: +' + GRACE_MINUTES + ' min  |  End: ' + OFFICE_END.h + ':' + String(OFFICE_END.m).padStart(2,'0') +
      '  |  Absent after: ' + ABSENT_AFTER.h + ':00 AM');
    console.log('==========================================\n');
  });
});
