const express = require('express');
const mysql   = require('mysql2');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));   // increased for base64 image uploads
app.use(express.urlencoded({ extended: true }));

app.use('/models',    express.static(path.join(__dirname, 'public', 'models')));
app.use('/faceapi.js',(req, res) => res.sendFile(path.join(__dirname, 'public', 'faceapi.js')));

// Serve captured unknown face images
app.use('/unknown-images', express.static(path.join(__dirname, 'public', 'unknown-images')));

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

  // NEW: unknown_faces table for tracking and images
  db.query(`
    CREATE TABLE IF NOT EXISTS unknown_faces (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      image_file   VARCHAR(255) DEFAULT NULL,
      captured_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      date         DATE NOT NULL,
      time         TIME NOT NULL,
      source       VARCHAR(50) DEFAULT 'checkin'
    )
  `, err => { if (!err) console.log('✅ unknown_faces table ready'); });
});

// ─── AUTO DOWNLOAD face-api.js + MODELS ──────────────────────────────────────
const PUBLIC_DIR     = path.join(__dirname, 'public');
const MODELS_DIR     = path.join(PUBLIC_DIR, 'models');
const UNKNOWN_DIR    = path.join(PUBLIC_DIR, 'unknown-images');
const FACEAPI_PATH   = path.join(PUBLIC_DIR, 'faceapi.js');
const FACEAPI_URL    = 'https://unpkg.com/face-api.js@0.22.2/dist/face-api.min.js';
const MODEL_FILES    = [
  'ssd_mobilenetv1_model-weights_manifest.json','ssd_mobilenetv1_model-shard1','ssd_mobilenetv1_model-shard2',
  'face_landmark_68_model-weights_manifest.json','face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json','face_recognition_model-shard1','face_recognition_model-shard2',
  'tiny_face_detector_model-weights_manifest.json','tiny_face_detector_model-shard1',
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
  if (!fs.existsSync(PUBLIC_DIR))   fs.mkdirSync(PUBLIC_DIR,   { recursive: true });
  if (!fs.existsSync(MODELS_DIR))   fs.mkdirSync(MODELS_DIR,   { recursive: true });
  if (!fs.existsSync(UNKNOWN_DIR))  fs.mkdirSync(UNKNOWN_DIR,  { recursive: true });

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

// ─── LED / BUZZER STATE ───────────────────────────────────────────────────────
let pendingLedCommand = null;

function getLedCommand(eventType) {
  const MAP = {
    checkin_present:   { led: 'G',  buzzer: 1 },
    checkin_late:      { led: 'GL', buzzer: 1 },
    checkin_absent:    { led: 'R',  buzzer: 2 },
    checkin_already:   { led: 'O',  buzzer: 3 },
    checkout_normal:   { led: 'B',  buzzer: 2 },
    checkout_early:    { led: 'RL', buzzer: 2 },
    checkout_already:  { led: 'OO', buzzer: 3 },
    unknown:           { led: 'RU', buzzer: 5 },
  };
  return MAP[eventType] || { led: 'X', buzzer: 0 };
}

function setLed(eventType, name = '', status = '') {
  const cmd = getLedCommand(eventType);
  pendingLedCommand = { led: cmd.led, buzzer: cmd.buzzer, name: String(name).substring(0,40), eventType, status, timestamp: Date.now() };
  console.log(`💡 LED → event=${eventType} | led=${cmd.led} | buzzer=${cmd.buzzer} | name=${name}`);
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

// Save base64 image to disk, return filename
function saveUnknownImage(base64Data) {
  try {
    const matches = base64Data.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
    if (!matches) return null;
    const ext      = matches[1] === 'jpeg' ? 'jpg' : matches[1];
    const filename = 'unknown_' + Date.now() + '_' + Math.random().toString(36).slice(2,7) + '.' + ext;
    const filepath = path.join(UNKNOWN_DIR, filename);
    fs.writeFileSync(filepath, Buffer.from(matches[2], 'base64'));
    return filename;
  } catch(e) {
    console.error('Image save error:', e.message);
    return null;
  }
}

// ─── OFFICE TIMING CONFIG ─────────────────────────────────────────────────────
const OFFICE_START   = { h: 9,  m: 30 };
const GRACE_MINUTES  = 10;
const OFFICE_END     = { h: 18, m: 10 };
const ABSENT_AFTER   = { h: 11, m: 0 };
const THRESHOLD      = 0.5;
const REGISTER_SAMPLES = 10;

const LATE_AFTER       = OFFICE_START.h * 60 + OFFICE_START.m + GRACE_MINUTES;
const CHECKOUT_FROM    = OFFICE_END.h   * 60 + OFFICE_END.m;
const ABSENT_AFTER_MIN = ABSENT_AFTER.h * 60 + ABSENT_AFTER.m;

function calcExpectedCheckout(timeInStr) {
  const parts = timeInStr.split(':');
  const inMin = parseInt(parts[0]) * 60 + parseInt(parts[1]);
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

// ─── INLINE JS SHARED BETWEEN PAGES ──────────────────────────────────────────
// This client-side script handles mobile compatibility + multi-face + unknown capture.
// Key fixes for mobile:
//  1. Use TinyFaceDetector as fallback (lighter, works on mobile Safari)
//  2. Force CPU backend if WebGL fails
//  3. Limit canvas/video size on mobile
const CLIENT_SCRIPT = `
// ── BACKEND / MODEL SELECTION ──────────────────────────────────────
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

async function safeLoadModels(modelUrl, statusFn) {
  // Try SSD MobileNet first (best accuracy), fallback to TinyFaceDetector on mobile
  statusFn('Loading recognition models...');
  try {
    await faceapi.nets.faceRecognitionNet.loadFromUri(modelUrl);
    await faceapi.nets.faceLandmark68Net.loadFromUri(modelUrl);
    statusFn('Loading face detector...');
    if (isMobile) {
      // TinyFaceDetector is much smaller — avoids the shard tensor mismatch on mobile
      await faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl);
      window._detectorType = 'tiny';
    } else {
      await faceapi.nets.ssdMobilenetv1.loadFromUri(modelUrl);
      window._detectorType = 'ssd';
    }
    return true;
  } catch(e) {
    // Last resort: try tiny on desktop too
    try {
      await faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl);
      window._detectorType = 'tiny';
      return true;
    } catch(e2) {
      throw new Error('Model load failed: ' + e2.message);
    }
  }
}

function getDetectorOptions() {
  if (window._detectorType === 'tiny') {
    return new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  }
  return new faceapi.SsdMobilenetv1Options({ minConfidence: 0.55 });
}

// Single face detection
async function detectFace(videoEl) {
  return faceapi
    .detectSingleFace(videoEl, getDetectorOptions())
    .withFaceLandmarks().withFaceDescriptor();
}

// Multi-face detection — returns array
async function detectAllFaces(videoEl) {
  return faceapi
    .detectAllFaces(videoEl, getDetectorOptions())
    .withFaceLandmarks().withFaceDescriptors();
}

// ── CANVAS CAPTURE ──────────────────────────────────────────────────
function captureFrameBase64(videoEl, quality) {
  try {
    const c = document.createElement('canvas');
    // Limit size on mobile for performance
    const maxW = isMobile ? 480 : 640;
    const scale = Math.min(1, maxW / (videoEl.videoWidth || 640));
    c.width  = (videoEl.videoWidth  || 640) * scale;
    c.height = (videoEl.videoHeight || 480) * scale;
    c.getContext('2d').drawImage(videoEl, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality || 0.7);
  } catch(e) { return null; }
}

// ── FACE MATCHING ──────────────────────────────────────────────────
function euclidean(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i]-b[i])**2;
  return Math.sqrt(s);
}

// ── DRAW OVERLAY ────────────────────────────────────────────────────
function drawFaceCircle(ctx, overlayW, overlayH, box, videoW, videoH, color, label) {
  const sx = overlayW / (videoW || overlayW);
  const sy = overlayH / (videoH || overlayH);
  const cx = (box.x + box.width/2)  * sx;
  const cy = (box.y + box.height/2) * sy;
  const r  = Math.max(box.width, box.height) * 0.60 * ((sx+sy)/2);
  ctx.beginPath(); ctx.arc(cx, cy, r+4, 0, Math.PI*2);
  ctx.strokeStyle = color+'33'; ctx.lineWidth = 6; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2);
  ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2);
  ctx.save(); ctx.globalAlpha=0.07; ctx.fillStyle=color; ctx.fill(); ctx.restore();
  if (label) {
    const txtY = cy - r - 10;
    ctx.font = 'bold '+(isMobile?'11':'13')+'px Space Grotesk,sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.save(); ctx.globalAlpha=0.8; ctx.fillStyle='#000';
    const rr = ctx.roundRect || ((x,y,w,h,rx)=>{ctx.rect(x,y,w,h);});
    ctx.beginPath(); rr.call(ctx,cx-tw/2-6, txtY-14, tw+12, 20, 5); ctx.fill();
    ctx.restore();
    ctx.fillStyle=color; ctx.textAlign='center';
    ctx.fillText(label, cx, txtY); ctx.textAlign='left';
  }
}

function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function toast(msg,type){const t=document.getElementById('toast');if(!t)return;t.textContent=msg;t.className='toast '+type+' show';clearTimeout(t._to);t._to=setTimeout(()=>t.classList.remove('show'),4500);}
`;

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
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<title>Attendance System</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
:root{
  --bg:#ffffff;--surface:#f8f9fa;--card:#ffffff;--border:#dbe3ea;
  --accent:#00adee;--accent2:#00adee;--red:#f87171;--yellow:#fbbf24;
  --purple:#00adee;--orange:#fb923c;--text:#1f2937;--muted:#6b7280;--muted2:#cfd8e3;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Space Grotesk',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 50% at 50% -10%,rgba(0,173,238,0.08),transparent);pointer-events:none;z-index:0}

nav{position:sticky;top:0;z-index:100;background:rgba(255,255,255,0.96);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 16px;height:56px;gap:8px}
.nav-left{display:flex;align-items:center;gap:10px;min-width:0}
.nav-logo{font-family:'JetBrains Mono',monospace;font-size:0.95rem;font-weight:600;letter-spacing:2px;white-space:nowrap}
.nav-logo span{color:var(--accent)}
.nav-date{font-family:'JetBrains Mono',monospace;font-size:0.68rem;color:var(--muted);background:var(--card);border:1px solid var(--border);padding:3px 9px;border-radius:20px;display:none}
@media(min-width:600px){.nav-date{display:block}}
.nav-right{display:flex;align-items:center;gap:6px;flex-shrink:0}
.reg-btn{display:flex;align-items:center;gap:6px;background:linear-gradient(135deg,rgba(0,173,238,0.12),rgba(248,249,250,0.9));border:1px solid rgba(0,173,238,0.35);color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:0.76rem;font-weight:600;padding:7px 12px;border-radius:10px;text-decoration:none;transition:all 0.2s;white-space:nowrap}
.reg-btn:hover{background:linear-gradient(135deg,rgba(0,173,238,0.22),rgba(248,249,250,1));transform:translateY(-1px)}
.live-dot{width:8px;height:8px;border-radius:50%;background:var(--accent2);animation:livepulse 2s infinite;flex-shrink:0}
@keyframes livepulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(1.3)}}

main{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:16px}

.timing-bar{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:10px 14px;margin-bottom:14px;flex-wrap:wrap}
.timing-item{display:flex;align-items:center;gap:6px;font-size:0.72rem;color:var(--muted)}
.timing-item strong{color:var(--text);font-family:'JetBrains Mono',monospace;font-size:0.74rem}
.timing-sep{color:var(--muted2)}
.timing-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.td-green{background:var(--accent2)}.td-yellow{background:var(--yellow)}.td-orange{background:var(--orange)}.td-purple{background:var(--purple)}

.stats-bar{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:16px}
@media(max-width:600px){.stats-bar{grid-template-columns:repeat(3,1fr)}}
.stat{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
.stat-val{font-family:'JetBrains Mono',monospace;font-size:1.6rem;font-weight:600;color:var(--accent);line-height:1}
.stat-val.green{color:var(--accent2)}.stat-val.red{color:var(--red)}.stat-val.yellow{color:var(--yellow)}.stat-val.orange{color:var(--orange)}.stat-val.purple{color:var(--purple)}
.stat-label{font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:5px}

.top-row{display:grid;grid-template-columns:1fr;gap:16px;margin-bottom:16px}
@media(min-width:900px){.top-row{grid-template-columns:1fr 400px}}

.cam-card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.cam-wrap{position:relative;background:#f8f9fa;aspect-ratio:4/3}
#video{width:100%;height:100%;object-fit:cover;display:block}
#overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.scan-line{position:absolute;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--accent),transparent);animation:scan 3s ease-in-out infinite;opacity:0.4;pointer-events:none}
@keyframes scan{0%,100%{top:5%;opacity:0}10%{opacity:0.6}90%{opacity:0.6}50%{top:95%}}
.cam-controls{padding:10px 12px;background:var(--surface);display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.cam-status{flex:1;display:flex;align-items:center;gap:7px;font-size:0.74rem;color:var(--muted);min-width:100px}
.sled{width:7px;height:7px;border-radius:50%;background:var(--muted);flex-shrink:0;transition:background 0.3s}
.sled.pulse{background:var(--yellow);animation:blink 1s infinite}.sled.ok{background:var(--accent2)}.sled.bad{background:var(--red)}.sled.purple{background:var(--purple)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0.2}}
.btn{padding:8px 14px;border:none;border-radius:9px;font-family:'Space Grotesk',sans-serif;font-size:0.78rem;font-weight:600;cursor:pointer;transition:all 0.18s;white-space:nowrap}
.btn:disabled{opacity:0.3;cursor:not-allowed}
.btn-checkin{background:var(--accent);color:#fff}
.btn-checkin:hover:not(:disabled){background:#009ed8;transform:translateY(-1px);box-shadow:0 4px 16px rgba(0,173,238,0.35)}
.btn-checkout{background:rgba(0,173,238,0.08);border:1px solid rgba(0,173,238,0.25);color:var(--accent)}
.btn-checkout:hover:not(:disabled){background:rgba(0,173,238,0.16);transform:translateY(-1px)}
.btn-auto{background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.25);color:var(--accent2)}
.btn-auto:hover:not(:disabled){background:rgba(52,211,153,0.2)}
.btn-auto.active{background:rgba(248,113,113,0.1);border-color:rgba(248,113,113,0.3);color:var(--red)}
.multi-toggle{background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);color:var(--yellow);font-size:0.72rem}
.multi-toggle.active{background:rgba(251,191,36,0.2)}

/* multi-face badge */
.multi-count{display:none;position:absolute;top:10px;right:10px;background:var(--accent);color:#fff;font-size:0.72rem;font-weight:700;padding:4px 10px;border-radius:20px;font-family:'JetBrains Mono',monospace;z-index:5}

/* result panel */
.result-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:18px;display:flex;flex-direction:column;gap:14px}
.result-title{font-family:'JetBrains Mono',monospace;font-size:0.62rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase}
.result-idle{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:180px;gap:10px;color:var(--muted);font-size:0.78rem;text-align:center;line-height:1.7}
.result-idle svg{opacity:0.12}
.recognized-box,.unknown-box{display:none;flex-direction:column;gap:12px}
.r-face-row{display:flex;align-items:center;gap:12px}
.r-av{width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#f8f9fa,#eef3f8);display:flex;align-items:center;justify-content:center;font-size:1.2rem;font-weight:700;color:var(--accent);border:1px solid rgba(0,173,238,0.25);flex-shrink:0}
.r-name{font-size:1.1rem;font-weight:700;margin-bottom:4px}
.r-badge{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:100px;font-size:0.72rem;font-weight:600}
.rb-present{background:rgba(52,211,153,0.1);color:var(--accent2);border:1px solid rgba(52,211,153,0.2)}
.rb-late{background:rgba(251,191,36,0.1);color:var(--yellow);border:1px solid rgba(251,191,36,0.2)}
.rb-early{background:rgba(251,146,60,0.1);color:var(--orange);border:1px solid rgba(251,146,60,0.2)}
.rb-already{background:rgba(0,173,238,0.1);color:var(--accent);border:1px solid rgba(0,173,238,0.2)}
.rb-checkout{background:rgba(0,173,238,0.1);color:var(--accent);border:1px solid rgba(0,173,238,0.2)}
.rb-unk{background:rgba(248,113,113,0.1);color:var(--red);border:1px solid rgba(248,113,113,0.2)}
.r-grid{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:7px}
.r-cell{background:var(--surface);border-radius:9px;padding:9px;text-align:center}
.r-cell .rv{font-family:'JetBrains Mono',monospace;font-size:0.88rem;font-weight:600;color:var(--accent)}
.r-cell .rk{font-size:0.58rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:3px}
.conf-bar{height:4px;border-radius:2px;background:var(--muted2);margin-top:5px;overflow:hidden}
.conf-bar-fill{height:100%;border-radius:2px;transition:width 0.4s ease,background 0.4s ease}
.unk-hint{font-size:0.78rem;color:var(--muted);line-height:1.6}
.goto-reg{display:inline-flex;align-items:center;gap:6px;padding:9px 14px;background:linear-gradient(135deg,rgba(0,173,238,0.12),rgba(248,249,250,0.9));border:1px solid rgba(0,173,238,0.25);color:var(--accent);font-size:0.78rem;font-weight:600;border-radius:10px;text-decoration:none;transition:all 0.2s;font-family:'Space Grotesk',sans-serif}
.goto-reg:hover{background:linear-gradient(135deg,rgba(0,173,238,0.2),rgba(248,249,250,1));transform:translateY(-1px)}

/* unknown face thumbnail */
.unk-thumb{width:80px;height:80px;object-fit:cover;border-radius:10px;border:2px solid rgba(248,113,113,0.3);margin-top:4px}

/* multi result list */
.multi-results{display:flex;flex-direction:column;gap:8px;max-height:220px;overflow-y:auto}
.multi-result-item{display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--surface);border-radius:10px;font-size:0.78rem}
.multi-av{width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.8rem;flex-shrink:0}
.multi-av.unk{background:var(--red)}

/* table */
.table-card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.table-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:8px}
.table-head h3{font-family:'JetBrains Mono',monospace;font-size:0.66rem;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase}
.thr{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cnt-pill{background:rgba(0,173,238,0.1);color:var(--accent);font-size:0.7rem;font-weight:600;padding:3px 9px;border-radius:12px;font-family:'JetBrains Mono',monospace}
.search-inp{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px 10px;color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:0.78rem;outline:none;width:150px;transition:border-color 0.2s}
.search-inp:focus{border-color:var(--accent)}.search-inp::placeholder{color:var(--muted)}
.tbl-wrap{overflow-x:auto;max-height:400px;overflow-y:auto}
.tbl-wrap::-webkit-scrollbar{width:3px;height:3px}.tbl-wrap::-webkit-scrollbar-thumb{background:var(--muted2);border-radius:2px}
table{width:100%;border-collapse:collapse}
thead th{padding:9px 14px;text-align:left;font-size:0.63rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:1px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;white-space:nowrap}
tbody tr{border-bottom:1px solid rgba(207,216,227,0.8);transition:background 0.15s}
tbody tr:last-child{border-bottom:none}
tbody tr:hover{background:rgba(0,173,238,0.04)}
td{padding:10px 14px;font-size:0.8rem;vertical-align:middle}
.td-name{display:flex;align-items:center;gap:9px;font-weight:600}
.td-av{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#f8f9fa,#eef3f8);display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700;color:var(--accent);border:1px solid rgba(0,173,238,0.2);flex-shrink:0}
.time-pill{font-family:'JetBrains Mono',monospace;font-size:0.74rem;background:rgba(0,173,238,0.08);color:var(--accent);padding:2px 9px;border-radius:20px;border:1px solid rgba(0,173,238,0.12)}
.time-pill.out{background:rgba(0,173,238,0.08);color:var(--accent);border-color:rgba(0,173,238,0.12)}
.badge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:20px;font-size:0.65rem;font-weight:600;letter-spacing:0.3px;text-transform:uppercase;white-space:nowrap}
.badge-present{background:rgba(52,211,153,0.08);color:var(--accent2);border:1px solid rgba(52,211,153,0.18)}
.badge-late{background:rgba(251,191,36,0.08);color:var(--yellow);border:1px solid rgba(251,191,36,0.18)}
.badge-early_leave{background:rgba(251,146,60,0.08);color:var(--orange);border:1px solid rgba(251,146,60,0.18)}
.badge-late_early_leave{background:rgba(248,113,113,0.08);color:var(--red);border:1px solid rgba(248,113,113,0.18)}
.badge-absent{background:rgba(248,113,113,0.08);color:var(--red);border:1px solid rgba(248,113,113,0.18)}
.tbl-empty{text-align:center;padding:40px;color:var(--muted);font-size:0.82rem}

#loadOv{position:fixed;inset:0;background:rgba(255,255,255,0.97);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;z-index:999;padding:20px;text-align:center}
#loadOv.gone{display:none}
.spin{width:42px;height:42px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.load-sub{font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--muted);letter-spacing:1px}
.load-h{font-size:0.95rem;font-weight:600}
.load-err{font-size:0.78rem;color:var(--red);background:rgba(248,113,113,0.07);border:1px solid rgba(248,113,113,0.18);border-radius:10px;padding:12px 16px;max-width:340px;line-height:1.6;display:none}
.load-err.show{display:block}
.toast{position:fixed;bottom:20px;right:16px;left:16px;max-width:360px;margin:0 auto;padding:11px 18px;border-radius:12px;font-size:0.8rem;font-weight:600;opacity:0;transform:translateY(10px);transition:all 0.3s;z-index:500;pointer-events:none}
@media(min-width:480px){.toast{left:auto;margin:0}}
.toast.show{opacity:1;transform:translateY(0)}
.toast.s{background:rgba(52,211,153,0.93);color:#000}.toast.e{background:rgba(248,113,113,0.93);color:#fff}.toast.i{background:rgba(0,173,238,0.93);color:#fff}.toast.w{background:rgba(251,191,36,0.93);color:#000}.toast.p{background:rgba(0,173,238,0.93);color:#fff}
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
    <a class="reg-btn" href="/unknown-faces" style="background:rgba(248,113,113,0.08);border-color:rgba(248,113,113,0.3);color:var(--red)">❓ Unknown</a>
    <a class="reg-btn" href="/records" style="background:rgba(0,173,238,0.1);border-color:rgba(0,173,238,0.3);color:var(--accent)">📊 Records</a>
    <a class="reg-btn" href="/register">+ Register</a>
  </div>
</nav>

<main>

  <div class="timing-bar">
    <div class="timing-item"><div class="timing-dot td-green"></div>On Time: <strong>&lt;9:40 AM</strong></div>
    <div class="timing-sep">·</div>
    <div class="timing-item"><div class="timing-dot td-yellow"></div>Late: <strong>&gt;9:40 AM</strong></div>
    <div class="timing-sep">·</div>
    <div class="timing-item"><div class="timing-dot td-purple"></div>Checkout: <strong>6:10 PM+</strong></div>
    <div class="timing-sep">·</div>
    <div class="timing-item"><div class="timing-dot" style="background:var(--red)"></div>Absent: <strong>&gt;11 AM</strong></div>
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
        <div class="multi-count" id="multiCount">0 faces</div>
      </div>
      <div class="cam-controls">
        <div class="cam-status">
          <div class="sled pulse" id="sled"></div>
          <span id="st">Loading...</span>
        </div>
        <button class="btn btn-checkin"  id="btnC"  disabled onclick="capture()">📸 Check In</button>
        <button class="btn btn-checkout" id="btnCO" disabled onclick="captureCheckout()">🚪 Check Out</button>
        <button class="btn btn-auto"     id="btnA"  disabled onclick="toggleAuto()">▶ Auto</button>
        <button class="btn multi-toggle" id="btnM"  disabled onclick="toggleMulti()">👥 Multi</button>
      </div>
    </div>

    <div class="result-card">
      <div class="result-title">Recognition Result</div>
      <div class="result-idle" id="resultIdle">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <circle cx="12" cy="8" r="4"/><path d="M6 20v-2a6 6 0 0 1 12 0v2"/>
        </svg>
        <span>Point camera at a registered face,<br/>then click <strong>Check In</strong> or <strong>Check Out</strong></span>
      </div>
      <div class="recognized-box" id="recognizedBox">
        <div class="r-face-row">
          <div class="r-av" id="rAv">?</div>
          <div><div class="r-name" id="rName">—</div><span class="r-badge rb-present" id="rBadge">✅ Present</span></div>
        </div>
        <div class="r-grid">
          <div class="r-cell"><div class="rv" id="rTimeIn">—</div><div class="rk">Time In</div></div>
          <div class="r-cell"><div class="rv" id="rTimeOut">—</div><div class="rk" id="rTimeOutLabel">Time Out</div></div>
          <div class="r-cell">
            <div class="rv" id="rRegAcc">—</div><div class="rk">Reg. Quality</div>
            <div class="conf-bar"><div class="conf-bar-fill" id="rRegAccBar" style="width:0%"></div></div>
          </div>
          <div class="r-cell">
            <div class="rv" id="rConf">—</div><div class="rk">Live Match</div>
            <div class="conf-bar"><div class="conf-bar-fill" id="rConfBar" style="width:0%"></div></div>
          </div>
        </div>
      </div>
      <div class="unknown-box" id="unknownBox">
        <span class="r-badge rb-unk">❓ Unknown Person</span>
        <div class="unk-hint">Face not registered. Image captured and saved to Unknown Faces log.</div>
        <img id="unkThumb" class="unk-thumb" src="" style="display:none" alt="Unknown face"/>
        <a class="goto-reg" href="/register">+ Register This Person</a>
        <a class="goto-reg" href="/unknown-faces" style="margin-top:2px">❓ View Unknown Faces</a>
      </div>
      <!-- Multi-face results panel -->
      <div id="multiResultBox" style="display:none;flex-direction:column;gap:10px">
        <div class="result-title" style="margin:0">👥 Multi-Face Results</div>
        <div class="multi-results" id="multiResultList"></div>
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
        <thead><tr><th>Name</th><th>Check In</th><th>Check Out</th><th>Status</th></tr></thead>
        <tbody id="attBody">
          ${rows || '<tr><td colspan="4" class="tbl-empty">No attendance marked yet today</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
</main>

<div class="toast" id="toast"></div>

<script>
${CLIENT_SCRIPT}

const MODEL_URL = '/models';
const THRESHOLD = ${THRESHOLD};
let isReady = false, autoOn = false, multiOn = false;
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
    setLoad('Checking Models','Verifying model files...');
    const probe=await fetch('/models/ssd_mobilenetv1_model-weights_manifest.json');
    if(!probe.ok){showErr('Models not ready. Please wait 30s and refresh.');return;}
    await safeLoadModels(MODEL_URL, msg => setLoad('Loading Models', msg));
    setLoad('Starting Camera','Requesting camera access...');
    let stream;
    try{
      stream=await navigator.mediaDevices.getUserMedia({
        video:{width:{ideal:isMobile?480:640},height:{ideal:isMobile?360:480},facingMode:'user'}
      });
    }catch(e){showErr('Camera access denied: '+e.message);return;}
    video.srcObject=stream;
    await new Promise(r=>video.onloadedmetadata=r);
    await video.play();
    await new Promise(r=>setTimeout(r,500));
    overlay.width=video.videoWidth||640;overlay.height=video.videoHeight||480;
    document.getElementById('loadOv').classList.add('gone');
    isReady=true;
    ['btnC','btnCO','btnA','btnM'].forEach(id=>document.getElementById(id).disabled=false);
    setSt('Ready — use Check In or Check Out','ok');
    loadStats();loadTable();
  }catch(e){showErr(e.message);}
}

// ── SINGLE CHECK IN ────────────────────────────────────────────────
async function capture(){
  if(!isReady||multiOn)return;
  setSt('Scanning for check-in...','pulse');clearC();showIdle();
  const det=await detectFace(video);
  if(!det){setSt('No face detected — look at the camera','bad');toast('No face detected','e');return;}
  const{x,y,width,height}=det.detection.box;
  const res=await fetch('/api/attendance/mark',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({descriptor:Array.from(det.descriptor)})
  });
  const data=await res.json();
  ctx.clearRect(0,0,overlay.width,overlay.height);
  if(data.success&&data.recognized){
    if(data.already){
      drawFaceCircle(ctx,overlay.width,overlay.height,{x,y,width,height},video.videoWidth,video.videoHeight,'#00adee',data.name+' ✓');
      setSt('Already checked in: '+data.name,'pulse');
      showResult({...data,mode:'already'});toast('⚠️ '+data.name+' already checked in','w');
    }else{
      const col=data.status==='late'?'#fbbf24':data.status==='absent'?'#f87171':'#34d399';
      drawFaceCircle(ctx,overlay.width,overlay.height,{x,y,width,height},video.videoWidth,video.videoHeight,col,
        (data.status==='late'?'⏰ ':data.status==='absent'?'❌ ':'✓ ')+data.name+(data.confidence?' '+data.confidence+'%':''));
      setSt((data.status==='late'?'⏰ Late':data.status==='absent'?'❌ Absent':'✅ Present')+': '+data.name,
        data.status==='absent'?'bad':data.status==='late'?'pulse':'ok');
      showResult({...data,mode:'checkin'});loadStats();loadTable();
      toast((data.status==='late'?'⏰ Late':data.status==='absent'?'❌ Absent':'✅ Present')+': '+data.name+(data.confidence?' ('+data.confidence+'%)':''),
        data.status==='absent'?'e':data.status==='late'?'w':'s');
    }
  }else if(!data.recognized){
    drawFaceCircle(ctx,overlay.width,overlay.height,{x,y,width,height},video.videoWidth,video.videoHeight,'#f87171','Unknown');
    setSt('Unknown face — not registered','bad');
    // Capture and upload image
    const imgB64 = captureFrameBase64(video, 0.75);
    let thumbSrc = null;
    if(imgB64){
      const ur = await fetch('/api/unknown-faces/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:imgB64,source:'checkin'})});
      const ud = await ur.json();
      if(ud.image_url) thumbSrc = ud.image_url;
      loadStats();
    }
    showUnknown(thumbSrc);toast('❓ Unknown face — image captured','e');
  }else{toast(data.error||'Check-in failed','e');}
}

// ── SINGLE CHECK OUT ───────────────────────────────────────────────
async function captureCheckout(){
  if(!isReady||multiOn)return;
  setSt('Scanning for check-out...','pulse');clearC();showIdle();
  const det=await detectFace(video);
  if(!det){setSt('No face detected','bad');toast('No face detected','e');return;}
  const{x,y,width,height}=det.detection.box;
  drawFaceCircle(ctx,overlay.width,overlay.height,{x,y,width,height},video.videoWidth,video.videoHeight,'#a78bfa',null);
  const res=await fetch('/api/attendance/checkout',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({descriptor:Array.from(det.descriptor)})
  });
  const data=await res.json();
  ctx.clearRect(0,0,overlay.width,overlay.height);
  if(data.success){
    if(data.already_out){
      drawFaceCircle(ctx,overlay.width,overlay.height,{x,y,width,height},video.videoWidth,video.videoHeight,'#a78bfa',data.name+' already out');
      showResult({...data,mode:'already_out'});toast('⚠️ '+data.name+' already checked out','w');
    }else if(data.early){
      drawFaceCircle(ctx,overlay.width,overlay.height,{x,y,width,height},video.videoWidth,video.videoHeight,'#fb923c','⚠ '+data.name);
      setSt('⚠️ Early leave: '+data.name+' at '+data.time_out,'pulse');
      showResult({...data,mode:'early'});loadStats();loadTable();
      toast('⚠️ '+data.name+' left early at '+data.time_out,'w');
    }else{
      drawFaceCircle(ctx,overlay.width,overlay.height,{x,y,width,height},video.videoWidth,video.videoHeight,'#a78bfa','✓ '+data.name);
      setSt('🚪 Checked out: '+data.name+' at '+data.time_out,'ok');
      showResult({...data,mode:'checkout'});loadStats();loadTable();
      toast('🚪 '+data.name+' checked out at '+data.time_out,'p');
    }
  }else if(data.not_checked_in){
    setSt('Not checked in: '+data.name,'bad');toast(data.name+' has no check-in today','e');
  }else if(!data.recognized){
    drawFaceCircle(ctx,overlay.width,overlay.height,{x,y,width,height},video.videoWidth,video.videoHeight,'#f87171','Unknown');
    setSt('Unknown face','bad');
    const imgB64=captureFrameBase64(video,0.75);
    if(imgB64) await fetch('/api/unknown-faces/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:imgB64,source:'checkout'})});
    showUnknown(null);toast('Unknown face — register first','e');
  }else{toast(data.error||'Checkout failed','e');}
}

// ── MULTI-FACE MODE ────────────────────────────────────────────────
function toggleMulti(){
  multiOn=!multiOn;
  const b=document.getElementById('btnM');
  const mc=document.getElementById('multiCount');
  if(multiOn){
    b.textContent='👥 Stop Multi';b.classList.add('active');
    document.getElementById('btnC').disabled=true;
    document.getElementById('btnCO').disabled=true;
    document.getElementById('btnA').disabled=true;
    mc.style.display='block';
    showMultiBox([]);
    toast('Multi-face scan ON — auto check-in all faces','i');
    runMultiFace();
  }else{
    b.textContent='👥 Multi';b.classList.remove('active');
    ['btnC','btnCO','btnA'].forEach(id=>document.getElementById(id).disabled=false);
    mc.style.display='none';
    clearC();showIdle();
    toast('Multi-face scan OFF','i');
  }
}

async function runMultiFace(){
  while(multiOn){
    await scanMulti();
    await new Promise(r=>setTimeout(r,2500));
  }
}

async function scanMulti(){
  if(!isReady)return;
  ctx.clearRect(0,0,overlay.width,overlay.height);
  const dets=await detectAllFaces(video);
  document.getElementById('multiCount').textContent=dets.length+' face'+(dets.length!==1?'s':'');
  if(!dets.length){setSt('No faces detected in frame','pulse');return;}
  setSt('Found '+dets.length+' face'+(dets.length!==1?'s':'')+'...','pulse');

  const results=[];
  for(const det of dets){
    const{x,y,width,height}=det.detection.box;
    // Match against DB — do client-side match to avoid N round trips
    // Send descriptor to server
    const res=await fetch('/api/attendance/mark',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({descriptor:Array.from(det.descriptor)})
    });
    const data=await res.json();
    if(data.recognized){
      const col=data.already?'#00adee':data.status==='late'?'#fbbf24':data.status==='absent'?'#f87171':'#34d399';
      const lbl=(data.already?'↩ ':'✓ ')+data.name+(data.confidence?' '+data.confidence+'%':'');
      drawFaceCircle(ctx,overlay.width,overlay.height,{x,y,width,height},video.videoWidth,video.videoHeight,col,lbl);
      results.push({name:data.name,status:data.status,already:data.already,confidence:data.confidence,recognized:true});
    }else{
      drawFaceCircle(ctx,overlay.width,overlay.height,{x,y,width,height},video.videoWidth,video.videoHeight,'#f87171','Unknown');
      const imgB64=captureFrameBase64(video,0.65);
      if(imgB64) await fetch('/api/unknown-faces/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:imgB64,source:'multi'})});
      results.push({name:'Unknown',status:'unknown',recognized:false});
    }
  }
  showMultiBox(results);
  if(results.some(r=>!r.already&&r.recognized)){loadStats();loadTable();}
}

// ── RESULT DISPLAY ─────────────────────────────────────────────────
function showIdle(){
  document.getElementById('resultIdle').style.display='flex';
  document.getElementById('recognizedBox').style.display='none';
  document.getElementById('unknownBox').style.display='none';
  document.getElementById('multiResultBox').style.display='none';
}
function showUnknown(thumbSrc){
  document.getElementById('resultIdle').style.display='none';
  document.getElementById('recognizedBox').style.display='none';
  document.getElementById('multiResultBox').style.display='none';
  document.getElementById('unknownBox').style.display='flex';
  const img=document.getElementById('unkThumb');
  if(thumbSrc){img.src=thumbSrc;img.style.display='block';}else{img.style.display='none';}
}
function showMultiBox(results){
  document.getElementById('resultIdle').style.display='none';
  document.getElementById('recognizedBox').style.display='none';
  document.getElementById('unknownBox').style.display='none';
  document.getElementById('multiResultBox').style.display='flex';
  const list=document.getElementById('multiResultList');
  if(!results.length){list.innerHTML='<div style="color:var(--muted);font-size:0.78rem;text-align:center;padding:16px">Scanning for faces...</div>';return;}
  const labels={present:'✅ Present',late:'⏰ Late',absent:'❌ Absent',early_leave:'⚠️ Early',unknown:'❓ Unknown'};
  list.innerHTML=results.map(r=>{
    const col=!r.recognized?'var(--red)':r.already?'var(--accent)':r.status==='late'?'var(--yellow)':r.status==='absent'?'var(--red)':'var(--accent2)';
    return '<div class="multi-result-item">' +
      '<div class="multi-av '+(r.recognized?'':'unk')+'" style="background:'+col+'">'+(r.name?r.name[0].toUpperCase():'?')+'</div>' +
      '<div style="flex:1"><div style="font-weight:600;font-size:0.8rem">'+esc(r.name)+'</div>' +
      '<div style="font-size:0.7rem;color:var(--muted)">'+(r.already?'Already checked in':(labels[r.status]||r.status))+(r.confidence?' · '+r.confidence+'%':'')+'</div>' +
      '</div></div>';
  }).join('');
}
function showResult(d){
  document.getElementById('resultIdle').style.display='none';
  document.getElementById('unknownBox').style.display='none';
  document.getElementById('multiResultBox').style.display='none';
  document.getElementById('recognizedBox').style.display='flex';
  document.getElementById('rAv').textContent=d.name[0].toUpperCase();
  document.getElementById('rName').textContent=d.name;
  document.getElementById('rTimeIn').textContent=d.time_in||'—';
  const badge=document.getElementById('rBadge');
  const tOutEl=document.getElementById('rTimeOut');
  const tOutLbl=document.getElementById('rTimeOutLabel');
  const conf=d.confidence!=null?d.confidence:null;
  const confEl=document.getElementById('rConf'),confBar=document.getElementById('rConfBar');
  if(conf!=null){confEl.textContent=conf+'%';confBar.style.width=conf+'%';const c=conf>=85?'var(--accent2)':conf>=65?'var(--yellow)':'var(--orange)';confEl.style.color=c;confBar.style.background=c;}
  else{confEl.textContent='—';confBar.style.width='0%';confEl.style.color='var(--accent)';}
  const regAcc=d.registered_accuracy!=null?d.registered_accuracy:null;
  const regEl=document.getElementById('rRegAcc'),regBar=document.getElementById('rRegAccBar');
  if(regAcc!=null){regEl.textContent=regAcc+'%';regBar.style.width=regAcc+'%';const c=regAcc>=85?'var(--accent2)':regAcc>=65?'var(--yellow)':'var(--orange)';regEl.style.color=c;regBar.style.background=c;}
  else{regEl.textContent='—';regBar.style.width='0%';}
  if(d.mode==='checkin'){
    tOutEl.textContent=d.status||'—';tOutLbl.textContent='Status';
    if(d.status==='absent'){badge.className='r-badge rb-unk';badge.textContent='❌ Absent';}
    else if(d.status==='late'){badge.className='r-badge rb-late';badge.textContent='⏰ Late';if(d.expected_checkout){tOutEl.textContent=d.expected_checkout;tOutLbl.textContent='Expected Out';}}
    else{badge.className='r-badge rb-present';badge.textContent='✅ Present';}
  }else if(d.mode==='checkout'){
    tOutEl.textContent=d.time_out||'—';tOutLbl.textContent='Time Out';
    badge.className='r-badge rb-checkout';badge.textContent='🚪 Checked Out';
  }else if(d.mode==='early'){
    tOutEl.textContent=d.time_out||'—';tOutLbl.textContent='Left Early';
    badge.className='r-badge rb-early';badge.textContent='⚠️ Early Leave';
  }else if(d.mode==='already'){
    tOutEl.textContent=d.status||'—';tOutLbl.textContent='Status';
    badge.className='r-badge rb-already';badge.textContent='⚠️ Already In';
  }else if(d.mode==='already_out'){
    tOutEl.textContent=d.time_out||'—';tOutLbl.textContent='Time Out';
    badge.className='r-badge rb-already';badge.textContent='⚠️ Already Out';
  }
}

// ── AUTO MODE ──────────────────────────────────────────────────────
function toggleAuto(){
  autoOn=!autoOn;
  const b=document.getElementById('btnA');
  if(autoOn){
    b.textContent='⏹ Stop';b.classList.add('active');
    ['btnC','btnCO','btnM'].forEach(id=>document.getElementById(id).disabled=true);
    runAuto();toast('Auto scan ON','i');
  }else{
    b.textContent='▶ Auto';b.classList.remove('active');
    ['btnC','btnCO','btnM'].forEach(id=>document.getElementById(id).disabled=false);
    toast('Auto scan OFF','i');
  }
}
async function runAuto(){while(autoOn){await capture();await new Promise(r=>setTimeout(r,3000));}}

// ── DATA ───────────────────────────────────────────────────────────
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
    const labels={present:'✅ Present',late:'⏰ Late',early_leave:'⚠️ Early Leave',late_early_leave:'🔴 Late+Early',absent:'❌ Absent'};
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
loadStats();loadTable();
setInterval(()=>{loadStats();loadTable();},30000);
</script>
</body>
</html>`;
}

// ─── UNKNOWN FACES PAGE ───────────────────────────────────────────────────────
function getUnknownFacesHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Unknown Faces — Attendance</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
:root{
  --bg:#ffffff;--surface:#f8f9fa;--card:#ffffff;--border:#dbe3ea;
  --accent:#00adee;--red:#f87171;--yellow:#fbbf24;--text:#1f2937;--muted:#6b7280;--muted2:#cfd8e3;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Space Grotesk',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 50% at 50% -10%,rgba(248,113,113,0.05),transparent);pointer-events:none;z-index:0}
nav{position:sticky;top:0;z-index:100;background:rgba(255,255,255,0.96);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:56px}
.nav-logo{font-family:'JetBrains Mono',monospace;font-size:0.95rem;font-weight:600;letter-spacing:2px}
.nav-logo span{color:var(--red)}
.nav-right{display:flex;gap:8px}
.nav-link{display:flex;align-items:center;gap:6px;border:1px solid var(--border);color:var(--muted);font-family:'Space Grotesk',sans-serif;font-size:0.78rem;font-weight:500;padding:7px 12px;border-radius:10px;text-decoration:none;transition:all 0.2s;background:var(--card)}
.nav-link:hover{border-color:var(--accent);color:var(--text)}
main{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:24px 20px}
.page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px}
.page-title{font-size:1.3rem;font-weight:700;display:flex;align-items:center;gap:10px}
.page-subtitle{font-size:0.78rem;color:var(--muted);margin-top:4px}
.summary-pills{display:flex;gap:10px;flex-wrap:wrap}
.pill{padding:6px 14px;border-radius:20px;font-size:0.75rem;font-weight:600;font-family:'JetBrains Mono',monospace}
.pill-total{background:rgba(248,113,113,0.1);color:var(--red);border:1px solid rgba(248,113,113,0.2)}
.pill-today{background:rgba(251,191,36,0.1);color:var(--yellow);border:1px solid rgba(251,191,36,0.2)}
/* filter */
.filter-bar{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:18px}
.filter-label{font-size:0.66rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:4px}
.filter-inp,.filter-sel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:7px 11px;color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:0.8rem;outline:none}
.filter-inp:focus,.filter-sel:focus{border-color:var(--accent)}
.btn-filter{padding:8px 16px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-family:'Space Grotesk',sans-serif;font-size:0.8rem;font-weight:600;cursor:pointer}
.btn-del-all{padding:8px 16px;border:1px solid rgba(248,113,113,0.3);border-radius:9px;background:rgba(248,113,113,0.08);color:var(--red);font-family:'Space Grotesk',sans-serif;font-size:0.8rem;font-weight:600;cursor:pointer}
/* grid */
.faces-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}
@media(max-width:480px){.faces-grid{grid-template-columns:repeat(2,1fr);gap:10px}}
.face-card{background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden;transition:border-color 0.2s;position:relative}
.face-card:hover{border-color:rgba(248,113,113,0.4)}
.face-img-wrap{position:relative;aspect-ratio:4/3;background:#f8f9fa;overflow:hidden}
.face-img{width:100%;height:100%;object-fit:cover;display:block}
.face-img-placeholder{width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:2.5rem;background:rgba(248,113,113,0.06)}
.face-source{position:absolute;top:8px;left:8px;padding:3px 9px;border-radius:12px;font-size:0.62rem;font-weight:700;background:rgba(0,0,0,0.55);color:#fff;letter-spacing:0.5px;text-transform:uppercase}
.face-del{position:absolute;top:8px;right:8px;background:rgba(248,113,113,0.85);color:#fff;border:none;border-radius:50%;width:26px;height:26px;font-size:0.85rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.2s;flex-shrink:0}
.face-del:hover{background:rgba(239,68,68,0.95)}
.face-info{padding:10px 12px}
.face-time{font-family:'JetBrains Mono',monospace;font-size:0.74rem;color:var(--accent);font-weight:600}
.face-date{font-size:0.7rem;color:var(--muted);margin-top:2px}
.face-id{font-size:0.64rem;color:var(--muted2);margin-top:4px;font-family:'JetBrains Mono',monospace}
.empty-state{text-align:center;padding:70px 20px;color:var(--muted)}
.empty-state .emoji{font-size:3rem;margin-bottom:12px}
.empty-state h3{font-size:1rem;font-weight:600;margin-bottom:6px;color:var(--text)}
.empty-state p{font-size:0.8rem;line-height:1.6}
/* count badge */
.count-badge{display:inline-block;background:rgba(248,113,113,0.12);color:var(--red);font-size:0.72rem;font-weight:700;padding:2px 9px;border-radius:12px;font-family:'JetBrains Mono',monospace;border:1px solid rgba(248,113,113,0.2)}
.toast{position:fixed;bottom:20px;right:16px;padding:11px 18px;border-radius:12px;font-size:0.8rem;font-weight:600;opacity:0;transform:translateY(10px);transition:all 0.3s;z-index:500;pointer-events:none}
.toast.show{opacity:1;transform:translateY(0)}
.toast.s{background:rgba(52,211,153,0.93);color:#000}.toast.e{background:rgba(248,113,113,0.93);color:#fff}.toast.i{background:rgba(0,173,238,0.93);color:#fff}
</style>
</head>
<body>
<nav>
  <div class="nav-logo">ATTEND<span>.</span>AI <em style="font-style:normal;font-family:'Space Grotesk',sans-serif;font-size:0.62rem;color:var(--muted);letter-spacing:1px;margin-left:6px;font-weight:400">/ Unknown Faces</em></div>
  <div class="nav-right">
    <a href="/" class="nav-link">📋 Attendance</a>
    <a href="/records" class="nav-link">📊 Records</a>
    <a href="/register" class="nav-link">+ Register</a>
  </div>
</nav>
<main>
  <div class="page-header">
    <div>
      <div class="page-title">❓ Unknown Faces <span class="count-badge" id="totalCount">—</span></div>
      <div class="page-subtitle">Automatically captured images of unrecognized individuals</div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <div class="summary-pills">
        <span class="pill pill-today" id="todayCount">Today: —</span>
      </div>
      <button class="btn-del-all" onclick="deleteAll()">🗑️ Clear All</button>
    </div>
  </div>

  <!-- Filter -->
  <div class="filter-bar">
    <div>
      <div class="filter-label">From Date</div>
      <input type="date" id="fFrom" class="filter-inp"/>
    </div>
    <div>
      <div class="filter-label">To Date</div>
      <input type="date" id="fTo" class="filter-inp"/>
    </div>
    <div>
      <div class="filter-label">Source</div>
      <select id="fSource" class="filter-sel">
        <option value="">All Sources</option>
        <option value="checkin">Check In</option>
        <option value="checkout">Check Out</option>
        <option value="multi">Multi-Face</option>
      </select>
    </div>
    <button class="btn-filter" onclick="load()">🔍 Filter</button>
  </div>

  <div class="faces-grid" id="grid">
    <div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted)">Loading...</div>
  </div>
</main>

<div class="toast" id="toast"></div>

<script>
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function fmtDateTime(d,t){
  if(!d||!t) return '—';
  const parts=t.split(':');const h=parseInt(parts[0]),m=parts[1]||'00';
  const ampm=(h%12||12)+':'+m+' '+(h>=12?'PM':'AM');
  return d+' · '+ampm;
}
function toast(msg,type){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+type+' show';clearTimeout(t._to);t._to=setTimeout(()=>t.classList.remove('show'),3500);}

(function setDefaults(){
  const now=new Date();
  const y=now.getFullYear(),m=String(now.getMonth()+1).padStart(2,'0'),d=String(now.getDate()).padStart(2,'0');
  document.getElementById('fFrom').value=y+'-'+m+'-01';
  document.getElementById('fTo').value=y+'-'+m+'-'+d;
})();

async function load(){
  const from=document.getElementById('fFrom').value;
  const to=document.getElementById('fTo').value;
  const source=document.getElementById('fSource').value;
  const grid=document.getElementById('grid');
  grid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted)">Loading...</div>';
  const params=new URLSearchParams();
  if(from)params.set('from',from);if(to)params.set('to',to);if(source)params.set('source',source);
  try{
    const {records=[],total=0,today=0}=await(await fetch('/api/unknown-faces?'+params)).json();
    document.getElementById('totalCount').textContent=total+' total';
    document.getElementById('todayCount').textContent='Today: '+today;
    if(!records.length){
      grid.innerHTML='<div class="empty-state" style="grid-column:1/-1"><div class="emoji">👁️</div><h3>No unknown faces found</h3><p>Unknown faces are automatically captured<br/>whenever an unregistered person is scanned.</p></div>';
      return;
    }
    grid.innerHTML=records.map(r=>`
      <div class="face-card" id="fc-\${r.id}">
        <div class="face-img-wrap">
          \${r.image_file
            ? '<img class="face-img" src="/unknown-images/'+esc(r.image_file)+'" alt="Unknown face" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
              '<div class="face-img-placeholder" style="display:none">❓</div>'
            : '<div class="face-img-placeholder">❓</div>'}
          <div class="face-source">\${esc(r.source||'scan')}</div>
          <button class="face-del" onclick="deleteFace(\${r.id})" title="Delete">✕</button>
        </div>
        <div class="face-info">
          <div class="face-time">\${r.time?fmtTime(r.time):'—'}</div>
          <div class="face-date">\${r.date||'—'}</div>
          <div class="face-id">#\${r.id}</div>
        </div>
      </div>
    `).join('');
  }catch(e){
    grid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--red)">Error: '+esc(e.message)+'</div>';
  }
}

function fmtTime(t){const p=String(t).split(':');const h=parseInt(p[0]),m=p[1]||'00';return(h%12||12)+':'+m+' '+(h>=12?'PM':'AM');}

async function deleteFace(id){
  const r=await fetch('/api/unknown-faces/'+id,{method:'DELETE'});
  if(r.ok){
    const el=document.getElementById('fc-'+id);
    if(el){el.style.opacity='0';el.style.transform='scale(0.9)';el.style.transition='all 0.3s';setTimeout(()=>el.remove(),300);}
    toast('Deleted','i');load();
  }else toast('Delete failed','e');
}

async function deleteAll(){
  if(!confirm('Delete ALL unknown face records and images? This cannot be undone.'))return;
  const r=await fetch('/api/unknown-faces/all',{method:'DELETE'});
  if(r.ok){toast('All unknown faces cleared','i');load();}else toast('Failed to clear','e');
}

load();
</script>
</body>
</html>`;
}

// ─── REGISTER PAGE ────────────────────────────────────────────────────────────
function getRegisterHTML(faces) {
  const rows = faces.map(f => {
    const ra = f.registration_accuracy;
    const raColor = ra >= 85 ? '#34d399' : ra >= 65 ? '#fbbf24' : '#fb923c';
    const raBadge = ra != null
      ? `<span style="font-family:monospace;font-size:0.8rem;font-weight:700;color:${raColor}">${ra}%</span><div style="height:3px;border-radius:2px;background:#eef3f8;margin-top:4px;width:60px"><div style="height:100%;width:${ra}%;background:${raColor};border-radius:2px"></div></div>`
      : '<span style="color:var(--muted);font-size:0.75rem">—</span>';
    return `
    <tr id="fr-${f.id}">
      <td><div class="td-name"><div class="td-av">${f.label[0].toUpperCase()}</div>${escH(f.label)}</div></td>
      <td style="font-family:monospace;font-size:0.77rem;color:var(--muted)">#${f.id}</td>
      <td style="font-size:0.75rem;color:var(--muted)">${f.employee_id||'—'}</td>
      <td style="font-size:0.75rem;color:var(--muted)">${f.department||'—'}</td>
      <td>${raBadge}</td>
      <td style="font-size:0.75rem;color:var(--muted)">${new Date(f.registered_at).toLocaleDateString()}</td>
      <td><button class="del-btn" data-id="${f.id}" data-label="${escH(f.label)}" onclick="delFace(this)">Remove</button></td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<title>Register Face — Attendance</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap');
:root{
  --bg:#ffffff;--surface:#f8f9fa;--card:#ffffff;--border:#dbe3ea;
  --accent:#00adee;--accent2:#00adee;--red:#f87171;--yellow:#fbbf24;
  --purple:#00adee;--text:#1f2937;--muted:#6b7280;--muted2:#cfd8e3;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Space Grotesk',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}

nav{position:sticky;top:0;z-index:100;background:rgba(255,255,255,0.96);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:56px}
.nav-logo{font-family:'JetBrains Mono',monospace;font-size:0.95rem;font-weight:600;letter-spacing:2px}
.nav-logo span{color:var(--purple)}
.back-btn{display:flex;align-items:center;gap:7px;background:var(--card);border:1px solid var(--border);color:var(--muted);font-family:'Space Grotesk',sans-serif;font-size:0.8rem;font-weight:500;padding:7px 13px;border-radius:10px;text-decoration:none;transition:all 0.2s}
.back-btn:hover{border-color:var(--accent);color:var(--text)}

main{max-width:1200px;margin:0 auto;padding:20px;display:grid;grid-template-columns:380px 1fr;gap:20px}
@media(max-width:800px){main{grid-template-columns:1fr}}

.cam-card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.cam-wrap{position:relative;background:#f8f9fa;aspect-ratio:4/3}
#video{width:100%;height:100%;object-fit:cover;display:block}
#overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.corner{position:absolute;width:20px;height:20px;border-color:var(--purple);border-style:solid;opacity:0.6}
.corner.tl{top:12px;left:12px;border-width:2px 0 0 2px}
.corner.tr{top:12px;right:12px;border-width:2px 2px 0 0}
.corner.bl{bottom:12px;left:12px;border-width:0 0 2px 2px}
.corner.br{bottom:12px;right:12px;border-width:0 2px 2px 0}
.cam-status{padding:9px 12px;background:var(--surface);border-top:1px solid var(--border);display:flex;align-items:center;gap:7px;font-size:0.75rem;color:var(--muted)}
.sled{width:7px;height:7px;border-radius:50%;background:var(--muted);flex-shrink:0;transition:background 0.3s}
.sled.pulse{background:var(--yellow);animation:blink 1s infinite}.sled.ok{background:var(--accent2)}.sled.bad{background:var(--red)}.sled.purple{background:var(--purple)}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0.2}}

.form-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px;display:flex;flex-direction:column;gap:14px}
.form-title{font-family:'JetBrains Mono',monospace;font-size:0.64rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase;padding-bottom:10px;border-bottom:1px solid var(--border)}
.field{display:flex;flex-direction:column;gap:5px}
.field label{font-size:0.72rem;color:var(--muted);font-weight:500}
.field label span{color:var(--red)}
.inp{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:9px 13px;color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:0.85rem;outline:none;transition:border-color 0.2s;width:100%}
.inp:focus{border-color:var(--purple)}.inp::placeholder{color:var(--muted)}
.prog-label{font-size:0.7rem;color:var(--muted);font-family:'JetBrains Mono',monospace}
.prog-track{background:var(--surface);border-radius:4px;height:4px;overflow:hidden;margin-top:4px}
.prog-fill{height:100%;background:linear-gradient(90deg,var(--purple),var(--accent));transition:width 0.3s;width:0}
.reg-btn-main{width:100%;padding:11px;background:linear-gradient(135deg,rgba(0,173,238,0.14),rgba(248,249,250,0.95));border:1px solid rgba(0,173,238,0.35);color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:0.86rem;font-weight:700;border-radius:12px;cursor:pointer;transition:all 0.2s}
.reg-btn-main:hover:not(:disabled){background:linear-gradient(135deg,rgba(0,173,238,0.24),rgba(248,249,250,1));border-color:rgba(0,173,238,0.55);transform:translateY(-1px);box-shadow:0 4px 20px rgba(0,173,238,0.18)}
.reg-btn-main:disabled{opacity:0.3;cursor:not-allowed}

.list-card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.list-head{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.list-head h3{font-family:'JetBrains Mono',monospace;font-size:0.66rem;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase}
.list-cnt{background:rgba(0,173,238,0.1);color:var(--accent);font-size:0.7rem;font-weight:700;padding:3px 9px;border-radius:12px;font-family:'JetBrains Mono',monospace}
.list-scroll{overflow-y:auto;max-height:580px}
.list-scroll::-webkit-scrollbar{width:3px}.list-scroll::-webkit-scrollbar-thumb{background:var(--muted2);border-radius:2px}
table{width:100%;border-collapse:collapse}
thead th{padding:8px 12px;text-align:left;font-size:0.62rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:1px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0}
tbody tr{border-bottom:1px solid rgba(207,216,227,0.8);transition:background 0.15s}
tbody tr:last-child{border-bottom:none}
tbody tr:hover{background:rgba(0,173,238,0.04)}
td{padding:9px 12px;font-size:0.8rem;vertical-align:middle}
.td-name{display:flex;align-items:center;gap:9px;font-weight:600}
.td-av{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#f8f9fa,#eef3f8);display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700;color:var(--purple);border:1px solid rgba(0,173,238,0.2);flex-shrink:0}
.del-btn{background:rgba(248,113,113,0.07);border:1px solid rgba(248,113,113,0.18);color:var(--red);font-size:0.7rem;font-weight:600;padding:4px 9px;border-radius:7px;cursor:pointer;font-family:'Space Grotesk',sans-serif;transition:all 0.2s}
.del-btn:hover{background:rgba(248,113,113,0.18)}
.list-empty{text-align:center;padding:40px 16px;color:var(--muted);font-size:0.8rem}

#loadOv{position:fixed;inset:0;background:rgba(255,255,255,0.97);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;z-index:999;text-align:center;padding:20px}
#loadOv.gone{display:none}
.spin{width:42px;height:42px;border:2px solid var(--border);border-top-color:var(--purple);border-radius:50%;animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.load-sub{font-family:'JetBrains Mono',monospace;font-size:0.7rem;color:var(--muted);letter-spacing:1px}
.load-h{font-size:0.95rem;font-weight:600}
.load-err{font-size:0.76rem;color:var(--red);background:rgba(248,113,113,0.07);border:1px solid rgba(248,113,113,0.18);border-radius:10px;padding:12px 16px;max-width:340px;line-height:1.6;display:none}
.load-err.show{display:block}
.toast{position:fixed;bottom:20px;right:16px;padding:11px 17px;border-radius:12px;font-size:0.8rem;font-weight:600;opacity:0;transform:translateY(10px);transition:all 0.3s;z-index:500;pointer-events:none;max-width:320px}
.toast.show{opacity:1;transform:translateY(0)}
.toast.s{background:rgba(52,211,153,0.93);color:#000}.toast.e{background:rgba(248,113,113,0.93);color:#fff}.toast.i{background:rgba(0,173,238,0.93);color:#fff}
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
  <div class="nav-logo">ATTEND<span>.</span>AI <em style="font-style:normal;font-family:'Space Grotesk',sans-serif;font-size:0.62rem;color:var(--muted);letter-spacing:1px;margin-left:6px;font-weight:400">/ Register</em></div>
  <div style="display:flex;gap:8px">
    <a class="back-btn" href="/unknown-faces" style="border-color:rgba(248,113,113,0.3);color:var(--red)">❓ Unknown</a>
    <a class="back-btn" href="/records" style="border-color:rgba(0,173,238,0.3);color:var(--accent)">📊 Records</a>
    <a class="back-btn" href="/">← Attendance</a>
  </div>
</nav>

<main>
  <div style="display:flex;flex-direction:column;gap:16px">
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

  <div class="list-card">
    <div class="list-head">
      <h3>Registered People</h3>
      <span class="list-cnt" id="listCnt">${faces.length}</span>
    </div>
    <div class="list-scroll">
      <table>
        <thead><tr><th>Name</th><th>DB ID</th><th>Emp ID</th><th>Dept</th><th>Reg. Quality</th><th>Registered</th><th></th></tr></thead>
        <tbody id="facesTbody">
          ${rows || '<tr><td colspan="7" class="list-empty">No faces registered yet.</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
</main>

<div class="toast" id="toast"></div>

<script>
${CLIENT_SCRIPT}
const MODEL_URL   = '/models';
const REG_SAMPLES = ${REGISTER_SAMPLES};
let isReady = false;
const video   = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx     = overlay.getContext('2d');
const nameInp = document.getElementById('inp_name');
const deptInp = document.getElementById('inp_dept');

// Block digit input in name/dept
function blockDigits(el){
  if(!el)return;
  el.addEventListener('input',()=>{el.value=el.value.replace(/\d+/g,'');});
}
blockDigits(nameInp); blockDigits(deptInp);

function showErr(msg){document.getElementById('loadTitle').textContent='❌ Error';document.getElementById('loadMsg').style.display='none';document.querySelector('.spin').style.display='none';const el=document.getElementById('loadErr');el.textContent=msg;el.classList.add('show');}
function setLoad(t,m){document.getElementById('loadTitle').textContent=t;document.getElementById('loadMsg').textContent=m;}

const sc=document.createElement('script');sc.src='/faceapi.js';
sc.onload=init;sc.onerror=()=>showErr('Could not load face-api.js');
document.head.appendChild(sc);

async function init(){
  try{
    setLoad('Loading Models','Starting up...');
    const probe=await fetch('/models/ssd_mobilenetv1_model-weights_manifest.json');
    if(!probe.ok){showErr('Models not ready. Please refresh in 30s.');return;}
    await safeLoadModels(MODEL_URL, msg=>setLoad('Loading',msg));
    let stream;
    try{stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:isMobile?480:640},height:{ideal:isMobile?360:480},facingMode:'user'}});}
    catch(e){showErr('Camera denied: '+e.message);return;}
    video.srcObject=stream;
    await new Promise(r=>video.onloadedmetadata=r);
    await video.play();
    await new Promise(r=>setTimeout(r,500));
    overlay.width=video.videoWidth||640;overlay.height=video.videoHeight||480;
    document.getElementById('loadOv').classList.add('gone');
    isReady=true;
    document.getElementById('regBtn').disabled=false;
    setSt('Camera ready — fill details and register','ok');
  }catch(e){showErr(e.message);}
}

async function registerFace(){
  const name=nameInp.value.trim();
  const empid=document.getElementById('inp_empid').value.trim();
  const dept=deptInp.value.trim();
  if(!name){toast('Name is required','e');nameInp.focus();return;}
  if(!isReady)return;
  const btn=document.getElementById('regBtn'),pB=document.getElementById('pB'),pL=document.getElementById('pL');
  btn.disabled=true;btn.textContent='⏳ Capturing...';
  setSt('Capturing samples — hold still and look at camera','purple');
  const descs=[],detScores=[];
  for(let i=0;i<REG_SAMPLES;i++){
    pL.textContent='Sample '+(i+1)+'/'+REG_SAMPLES+' — hold still...';
    pB.style.width=(i/REG_SAMPLES*100)+'%';
    await new Promise(r=>setTimeout(r,350));
    let det=await detectFace(video);
    if(!det){await new Promise(r=>setTimeout(r,500));det=await detectFace(video);}
    if(det){
      const score=det.detection.score||0;
      if(score>=0.65){
        descs.push(Array.from(det.descriptor));detScores.push(score);
        const{x,y,width,height}=det.detection.box;
        ctx.clearRect(0,0,overlay.width,overlay.height);
        const pct=Math.round(score*100);
        const col=pct>=85?'#34d399':pct>=65?'#fbbf24':'#fb923c';
        drawFaceCircle(ctx,overlay.width,overlay.height,{x,y,width,height},video.videoWidth,video.videoHeight,col,'Sample '+(i+1)+': '+pct+'%');
        pL.textContent='Sample '+(i+1)+'/'+REG_SAMPLES+' — captured at '+pct+'% ✓';
      }else{i--;await new Promise(r=>setTimeout(r,300));}
    }else{pL.textContent='Sample '+(i+1)+'/'+REG_SAMPLES+' — face not detected, retrying...';}
  }
  pB.style.width='100%';
  if(descs.length<3){
    toast('Only '+descs.length+' samples — move closer and retry','e');
    pL.textContent='Too few samples — ensure good lighting, face camera directly';
    setSt('Not enough samples','bad');btn.disabled=false;btn.textContent='📸 Capture & Register Face';pB.style.width='0';return;
  }
  const avgScore=detScores.reduce((a,b)=>a+b,0)/detScores.length;
  const registration_accuracy=Math.round(avgScore*100);
  pL.textContent='Got '+descs.length+' samples | Quality: '+registration_accuracy+'% — saving...';
  const res=await fetch('/api/register',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({label:name,employee_id:empid,department:dept,descriptors:descs,registration_accuracy})
  });
  const data=await res.json();
  ctx.clearRect(0,0,overlay.width,overlay.height);
  if(res.ok){
    toast('✅ "'+name+'" registered! Quality: '+registration_accuracy+'%','s');
    pL.textContent='✅ Registered: '+name+' | Quality: '+registration_accuracy+'% | Samples: '+descs.length;
    setSt('✅ Registered: '+name,'ok');
    nameInp.value='';document.getElementById('inp_empid').value='';deptInp.value='';
    loadFacesList();
  }else{
    toast(data.error||'Registration failed','e');
    pL.textContent='Error: '+(data.error||'Failed');
    setSt('Registration failed','bad');
  }
  btn.disabled=false;btn.textContent='📸 Capture & Register Face';pB.style.width='0';
}

document.addEventListener('keydown',e=>{if(e.key==='Enter'&&document.activeElement.classList.contains('inp'))registerFace();});

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
        +'<div style="height:3px;border-radius:2px;background:#eef3f8;margin-top:4px;width:60px"><div style="height:100%;width:'+ra+'%;background:'+raColor+';border-radius:2px"></div></div>'
      : '<span style="color:var(--muted);font-size:0.75rem">—</span>';
    return '<tr id="fr-'+f.id+'">' +
      '<td><div class="td-name"><div class="td-av">'+f.label[0].toUpperCase()+'</div>'+esc(f.label)+'</div></td>' +
      '<td style="font-family:monospace;font-size:0.75rem;color:var(--muted)">#'+f.id+'</td>' +
      '<td style="font-size:0.73rem;color:var(--muted)">'+(f.employee_id||'—')+'</td>' +
      '<td style="font-size:0.73rem;color:var(--muted)">'+(f.department||'—')+'</td>' +
      '<td>'+raBadge+'</td>' +
      '<td style="font-size:0.73rem;color:var(--muted)">'+new Date(f.registered_at).toLocaleDateString()+'</td>' +
      '<td><button class="del-btn" data-id="'+f.id+'" data-label="'+esc(f.label)+'" onclick="delFace(this)">Remove</button></td>' +
      '</tr>';
  }).join('');
}

async function delFace(btn){
  const id=parseInt(btn.dataset.id),label=btn.dataset.label;
  if(!confirm('Remove "'+label+'"? All their attendance records will also be deleted.'))return;
  const r=await fetch('/api/faces/'+id,{method:'DELETE'});
  if(r.ok){const row=document.getElementById('fr-'+id);if(row){row.style.transition='all 0.3s';row.style.opacity='0';setTimeout(()=>row.remove(),300);}toast('"'+label+'" removed','i');loadFacesList();}
  else toast('Delete failed','e');
}

function setSt(t,type){document.getElementById('st').textContent=t;const d=document.getElementById('sled');d.className='sled';if(type)d.classList.add(type);}
function toast(msg,type){const t=document.getElementById('toast');t.textContent=msg;t.className='toast '+type+' show';clearTimeout(t._to);t._to=setTimeout(()=>t.classList.remove('show'),3500);}
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
    const { label, employee_id='', department='', descriptor, descriptors, registration_accuracy=null } = req.body;
    const safeLabel = String(label || '').trim();
    const safeDepartment = String(department || '').trim();
    if (!safeLabel) return res.status(400).json({ error: 'Name required' });
    if (/\d/.test(safeLabel)) return res.status(400).json({ error: 'Name cannot contain numbers' });
    if (safeDepartment && /\d/.test(safeDepartment)) return res.status(400).json({ error: 'Department cannot contain numbers' });
    const toStore = descriptors || descriptor;
    if (!toStore) return res.status(400).json({ error: 'Descriptor(s) required' });
    const result = await dbQuery(
      'INSERT INTO faces (label, employee_id, department, descriptor, registration_accuracy) VALUES (?,?,?,?,?)',
      [safeLabel, employee_id, safeDepartment, JSON.stringify(toStore), registration_accuracy]
    );
    res.status(201).json({ success: true, id: result.insertId, label: safeLabel, registration_accuracy });
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

// ── UNKNOWN FACES API ─────────────────────────────────────────────────────────

// Capture + save unknown face image
app.post('/api/unknown-faces/capture', async (req, res) => {
  try {
    const { image, source = 'checkin' } = req.body;
    const nowIST  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const today   = nowIST.getFullYear()+'-'+String(nowIST.getMonth()+1).padStart(2,'0')+'-'+String(nowIST.getDate()).padStart(2,'0');
    const timeStr = String(nowIST.getHours()).padStart(2,'0')+':'+String(nowIST.getMinutes()).padStart(2,'0')+':'+String(nowIST.getSeconds()).padStart(2,'0');

    let filename = null;
    if (image) filename = saveUnknownImage(image);

    const result = await dbQuery(
      'INSERT INTO unknown_faces (image_file, date, time, source) VALUES (?,?,?,?)',
      [filename, today, timeStr, source]
    );
    res.json({
      success: true,
      id: result.insertId,
      image_url: filename ? '/unknown-images/' + filename : null
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// List unknown faces with filters
app.get('/api/unknown-faces', async (req, res) => {
  try {
    const { from, to, source } = req.query;
    let sql = 'SELECT * FROM unknown_faces WHERE 1=1';
    const params = [];
    if (from)   { sql += ' AND date >= ?'; params.push(from); }
    if (to)     { sql += ' AND date <= ?'; params.push(to); }
    if (source) { sql += ' AND source = ?'; params.push(source); }
    sql += ' ORDER BY captured_at DESC';
    const records = await dbQuery(sql, params);

    const today = new Date().toISOString().slice(0,10);
    const totalRows = await dbQuery('SELECT COUNT(*) AS c FROM unknown_faces');
    const todayRows = await dbQuery('SELECT COUNT(*) AS c FROM unknown_faces WHERE date=?', [today]);

    res.json({
      records,
      total: totalRows[0].c,
      today: todayRows[0].c
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete one unknown face record + image file
app.delete('/api/unknown-faces/:id', async (req, res) => {
  try {
    const rows = await dbQuery('SELECT image_file FROM unknown_faces WHERE id=?', [parseInt(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].image_file) {
      const fp = path.join(UNKNOWN_DIR, rows[0].image_file);
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch(_) {}
    }
    await dbQuery('DELETE FROM unknown_faces WHERE id=?', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete ALL unknown faces + images
app.delete('/api/unknown-faces/all', async (req, res) => {
  try {
    const rows = await dbQuery('SELECT image_file FROM unknown_faces WHERE image_file IS NOT NULL');
    for (const r of rows) {
      const fp = path.join(UNKNOWN_DIR, r.image_file);
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch(_) {}
    }
    await dbQuery('DELETE FROM unknown_faces');
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
      const stored = JSON.parse(f.descriptor);
      const descriptorList = Array.isArray(stored[0]) ? stored : [stored];
      const d = Math.min(...descriptorList.map(sd => euclidean(descriptor, sd)));
      if (d < bestD) { bestD = d; best = f; }
    }
    if (!best || bestD >= THRESHOLD) { setLed('unknown'); return res.json({ success: false, recognized: false }); }

    const confidence = Math.round(Math.max(0, Math.min(100, (1 - bestD / THRESHOLD) * 100)));
    const registered_accuracy = best.registration_accuracy || null;

    const nowIST   = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const today    = nowIST.getFullYear()+'-'+String(nowIST.getMonth()+1).padStart(2,'0')+'-'+String(nowIST.getDate()).padStart(2,'0');
    const timeStr  = String(nowIST.getHours()).padStart(2,'0')+':'+String(nowIST.getMinutes()).padStart(2,'0')+':'+String(nowIST.getSeconds()).padStart(2,'0');
    const totalMin = nowIST.getHours() * 60 + nowIST.getMinutes();

    let status = 'present';
    if (totalMin >= ABSENT_AFTER_MIN) status = 'absent';
    else if (totalMin > LATE_AFTER)   status = 'late';

    const expectedCheckout = (status === 'late') ? calcExpectedCheckout(timeStr) : null;

    const existing = await dbQuery(
      'SELECT id, time_in, status, expected_checkout FROM attendance WHERE face_id=? AND date=?',
      [best.id, today]
    );
    if (existing.length) {
      setLed('checkin_already', best.label, existing[0].status);
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
    const evType = status === 'absent' ? 'checkin_absent' : status === 'late' ? 'checkin_late' : 'checkin_present';
    setLed(evType, best.label, status);
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
      const stored = JSON.parse(f.descriptor);
      const descriptorList = Array.isArray(stored[0]) ? stored : [stored];
      const d = Math.min(...descriptorList.map(sd => euclidean(descriptor, sd)));
      if (d < bestD) { bestD = d; best = f; }
    }
    if (!best || bestD >= THRESHOLD) { setLed('unknown'); return res.json({ success: false, recognized: false }); }

    const confidence = Math.round(Math.max(0, Math.min(100, (1 - bestD / THRESHOLD) * 100)));
    const registered_accuracy = best.registration_accuracy || null;

    const nowIST   = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const today    = nowIST.getFullYear()+'-'+String(nowIST.getMonth()+1).padStart(2,'0')+'-'+String(nowIST.getDate()).padStart(2,'0');
    const timeStr  = String(nowIST.getHours()).padStart(2,'0')+':'+String(nowIST.getMinutes()).padStart(2,'0')+':'+String(nowIST.getSeconds()).padStart(2,'0');
    const totalMin = nowIST.getHours() * 60 + nowIST.getMinutes();
    const isEarly  = totalMin < CHECKOUT_FROM;

    const existing = await dbQuery(
      'SELECT id, time_in, time_out, status FROM attendance WHERE face_id=? AND date=?',
      [best.id, today]
    );
    if (!existing.length) {
      setLed('unknown', best.label, 'not_checked_in');
      return res.json({ success: false, not_checked_in: true, name: best.label });
    }
    if (existing[0].time_out) {
      setLed('checkout_already', best.label, existing[0].status);
      return res.json({
        success: true, already_out: true, confidence, registered_accuracy, name: best.label,
        time_in: fmtTime(existing[0].time_in), time_out: fmtTime(existing[0].time_out),
        status: existing[0].status
      });
    }

    const wasLate   = existing[0].status === 'late';
    const newStatus = isEarly ? (wasLate ? 'late_early_leave' : 'early_leave') : existing[0].status;

    await dbQuery(
      'UPDATE attendance SET time_out=?, status=? WHERE face_id=? AND date=?',
      [timeStr, newStatus, best.id, today]
    );

    const coEvType = isEarly ? 'checkout_early' : 'checkout_normal';
    setLed(coEvType, best.label, newStatus);
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
    const today      = new Date().toISOString().slice(0, 10);
    const totalRows  = await dbQuery('SELECT COUNT(*) AS c FROM faces');
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
  --bg:#ffffff;--surface:#f8f9fa;--card:#ffffff;--border:#dbe3ea;
  --accent:#00adee;--accent2:#00adee;--red:#f87171;--yellow:#fbbf24;
  --purple:#00adee;--orange:#fb923c;--text:#1f2937;--muted:#6b7280;--muted2:#cfd8e3;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Space Grotesk',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 50% at 50% -10%,rgba(0,173,238,0.07),transparent);pointer-events:none;z-index:0}

nav{position:sticky;top:0;z-index:100;background:rgba(255,255,255,0.96);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:56px}
.nav-left{display:flex;align-items:center;gap:12px}
.nav-logo{font-family:'JetBrains Mono',monospace;font-size:0.95rem;font-weight:600;letter-spacing:2px}
.nav-logo span{color:var(--accent)}
.nav-right{display:flex;align-items:center;gap:8px}
.nav-link{display:flex;align-items:center;gap:6px;background:var(--card);border:1px solid var(--border);color:var(--muted);font-family:'Space Grotesk',sans-serif;font-size:0.78rem;font-weight:500;padding:7px 12px;border-radius:10px;text-decoration:none;transition:all 0.2s}
.nav-link:hover{border-color:var(--accent);color:var(--text)}
.nav-link.active{border-color:rgba(0,173,238,0.4);color:var(--accent);background:rgba(0,173,238,0.08)}

main{position:relative;z-index:1;max-width:1500px;margin:0 auto;padding:20px}

.filter-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 18px;margin-bottom:18px}
.filter-title{font-family:'JetBrains Mono',monospace;font-size:0.6rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:12px}
.filter-row{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}
.filter-group{display:flex;flex-direction:column;gap:4px}
.filter-label{font-size:0.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.8px}
.filter-inp,.filter-sel{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:7px 11px;color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:0.8rem;outline:none;min-width:120px}
.filter-inp:focus,.filter-sel:focus{border-color:var(--accent)}
.filter-inp::placeholder{color:var(--muted)}
.btn-filter{padding:8px 16px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-family:'Space Grotesk',sans-serif;font-size:0.8rem;font-weight:600;cursor:pointer}
.btn-clear{padding:8px 12px;border:1px solid var(--border);border-radius:9px;background:transparent;color:var(--muted);font-family:'Space Grotesk',sans-serif;font-size:0.8rem;cursor:pointer}

.summary-bar{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:18px}
@media(max-width:700px){.summary-bar{grid-template-columns:repeat(3,1fr)}}
.sum-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px 14px}
.sum-val{font-family:'JetBrains Mono',monospace;font-size:1.3rem;font-weight:600;color:var(--accent);line-height:1}
.sum-val.green{color:var(--accent2)}.sum-val.yellow{color:var(--yellow)}.sum-val.orange{color:var(--orange)}.sum-val.red{color:var(--red)}.sum-val.purple{color:var(--purple)}
.sum-lbl{font-size:0.6rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:4px}

.table-card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.table-head{display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:8px}
.table-head h3{font-family:'JetBrains Mono',monospace;font-size:0.66rem;letter-spacing:1.5px;color:var(--muted);text-transform:uppercase}
.cnt-pill{background:rgba(0,173,238,0.1);color:var(--accent);font-size:0.7rem;font-weight:600;padding:3px 9px;border-radius:12px;font-family:'JetBrains Mono',monospace}
.tbl-wrap{overflow-x:auto;max-height:580px;overflow-y:auto}
.tbl-wrap::-webkit-scrollbar{width:3px;height:3px}.tbl-wrap::-webkit-scrollbar-thumb{background:var(--muted2);border-radius:2px}
table{width:100%;border-collapse:collapse}
thead th{padding:9px 12px;text-align:left;font-size:0.61rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:1px;background:var(--surface);border-bottom:1px solid var(--border);position:sticky;top:0;white-space:nowrap}
tbody tr{border-bottom:1px solid rgba(207,216,227,0.8);transition:background 0.15s}
tbody tr:last-child{border-bottom:none}
tbody tr:hover{background:rgba(0,173,238,0.04)}
td{padding:9px 12px;font-size:0.8rem;vertical-align:middle;white-space:nowrap}
.td-name{display:flex;align-items:center;gap:8px;font-weight:600}
.td-av{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#f8f9fa,#eef3f8);display:flex;align-items:center;justify-content:center;font-size:0.72rem;font-weight:700;color:var(--accent);border:1px solid rgba(0,173,238,0.2);flex-shrink:0}
.time-pill{font-family:'JetBrains Mono',monospace;font-size:0.72rem;background:rgba(0,173,238,0.08);color:var(--accent);padding:2px 8px;border-radius:20px;border:1px solid rgba(0,173,238,0.12)}
.time-pill.out{background:rgba(0,173,238,0.08);color:var(--accent);border-color:rgba(0,173,238,0.12)}
.time-pill.exp{background:rgba(251,191,36,0.08);color:var(--yellow);border-color:rgba(251,191,36,0.12)}
.time-pill.work{background:rgba(52,211,153,0.08);color:var(--accent2);border-color:rgba(52,211,153,0.12)}
.badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:20px;font-size:0.62rem;font-weight:600;text-transform:uppercase;white-space:nowrap}
.badge-present{background:rgba(52,211,153,0.08);color:var(--accent2);border:1px solid rgba(52,211,153,0.18)}
.badge-late{background:rgba(251,191,36,0.08);color:var(--yellow);border:1px solid rgba(251,191,36,0.18)}
.badge-early_leave{background:rgba(251,146,60,0.08);color:var(--orange);border:1px solid rgba(251,146,60,0.18)}
.badge-late_early_leave{background:rgba(248,113,113,0.08);color:var(--red);border:1px solid rgba(248,113,113,0.18)}
.badge-absent{background:rgba(248,113,113,0.08);color:var(--red);border:1px solid rgba(248,113,113,0.18)}
.tbl-empty{text-align:center;padding:50px;color:var(--muted);font-size:0.82rem}
.date-chip{font-family:'JetBrains Mono',monospace;font-size:0.72rem;color:var(--muted);background:var(--surface);padding:2px 8px;border-radius:6px;border:1px solid var(--border)}

.total-work-bar{display:flex;align-items:center;gap:12px;background:rgba(52,211,153,0.05);border:1px solid rgba(52,211,153,0.12);border-radius:10px;padding:10px 16px;margin:10px 16px 14px}
.tw-label{font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px}
.tw-val{font-family:'JetBrains Mono',monospace;font-size:1rem;font-weight:600;color:var(--accent2)}
.tw-note{font-size:0.7rem;color:var(--muted);margin-left:auto}
</style>
</head>
<body>
<nav>
  <div class="nav-left"><div class="nav-logo">ATTEND<span>.</span>AI <em style="font-style:normal;font-family:'Space Grotesk',sans-serif;font-size:0.6rem;color:var(--muted);letter-spacing:1px;margin-left:6px;font-weight:400">RECORDS</em></div></div>
  <div class="nav-right">
    <a href="/" class="nav-link">📋 Today</a>
    <a href="/records" class="nav-link active">📊 Records</a>
    <a href="/unknown-faces" class="nav-link" style="color:var(--red);border-color:rgba(248,113,113,0.2)">❓ Unknown</a>
    <a href="/register" class="nav-link">+ Register</a>
  </div>
</nav>
<main>
  <div class="filter-card">
    <div class="filter-title">🔍 Filter Records</div>
    <div class="filter-row">
      <div class="filter-group"><div class="filter-label">From Date</div><input type="date" id="fFrom" class="filter-inp"/></div>
      <div class="filter-group"><div class="filter-label">To Date</div><input type="date" id="fTo" class="filter-inp"/></div>
      <div class="filter-group"><div class="filter-label">Status</div>
        <select id="fStatus" class="filter-sel">
          <option value="">All Statuses</option>
          <option value="present">✅ Present</option>
          <option value="late">⏰ Late</option>
          <option value="early_leave">⚠️ Early Leave</option>
          <option value="late_early_leave">🔴 Late + Early</option>
          <option value="absent">❌ Absent</option>
        </select>
      </div>
      <div class="filter-group"><div class="filter-label">Department</div><select id="fDept" class="filter-sel"><option value="">All Departments</option></select></div>
      <div class="filter-group"><div class="filter-label">Name</div><input type="text" id="fName" class="filter-inp" placeholder="Search name..."/></div>
      <div class="filter-group"><div class="filter-label">&nbsp;</div>
        <div style="display:flex;gap:7px">
          <button class="btn-filter" onclick="applyFilters()">🔍 Apply</button>
          <button class="btn-clear" onclick="clearFilters()">✕ Clear</button>
        </div>
      </div>
    </div>
  </div>

  <div class="summary-bar">
    <div class="sum-card"><div class="sum-val" id="sumTotal">—</div><div class="sum-lbl">Total</div></div>
    <div class="sum-card"><div class="sum-val green" id="sumPresent">—</div><div class="sum-lbl">Present</div></div>
    <div class="sum-card"><div class="sum-val yellow" id="sumLate">—</div><div class="sum-lbl">Late</div></div>
    <div class="sum-card"><div class="sum-val orange" id="sumEarly">—</div><div class="sum-lbl">Early Leave</div></div>
    <div class="sum-card"><div class="sum-val red" id="sumAbsent">—</div><div class="sum-lbl">Absent</div></div>
    <div class="sum-card"><div class="sum-val purple" id="sumWork">—</div><div class="sum-lbl">Work Hours</div></div>
  </div>

  <div class="table-card">
    <div class="table-head">
      <h3>📋 Attendance Records</h3>
      <span class="cnt-pill" id="recCnt">loading...</span>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>Name</th><th>Emp ID</th><th>Dept</th><th>Date</th><th>In</th><th>Out</th><th>Exp. Out</th><th>Working Hrs</th><th>Status</th></tr></thead>
        <tbody id="recBody"><tr><td colspan="9" class="tbl-empty">Loading records...</td></tr></tbody>
      </table>
    </div>
    <div id="totalWorkBar" class="total-work-bar" style="display:none">
      <span class="tw-label">Total Working Hours:</span>
      <span class="tw-val" id="totalWorkVal">0h 0m</span>
      <span class="tw-note" id="totalWorkNote"></span>
    </div>
  </div>
</main>
<script>
const statusLabels={present:'✅ Present',late:'⏰ Late',early_leave:'⚠️ Early Leave',late_early_leave:'🔴 Late+Early',absent:'❌ Absent'};
function esc(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

(function setDefaults(){
  const now=new Date();const y=now.getFullYear(),m=String(now.getMonth()+1).padStart(2,'0'),d=String(now.getDate()).padStart(2,'0');
  document.getElementById('fFrom').value=y+'-'+m+'-01';document.getElementById('fTo').value=y+'-'+m+'-'+d;
})();

(async function loadDepts(){
  try{const{departments=[]}=await(await fetch('/api/departments')).json();const sel=document.getElementById('fDept');departments.forEach(d=>{const o=document.createElement('option');o.value=d;o.textContent=d;sel.appendChild(o);});}catch(e){}
})();

async function applyFilters(){
  const from=document.getElementById('fFrom').value,to=document.getElementById('fTo').value;
  const status=document.getElementById('fStatus').value,dept=document.getElementById('fDept').value;
  const name=document.getElementById('fName').value.trim();
  const body=document.getElementById('recBody');
  body.innerHTML='<tr><td colspan="9" class="tbl-empty">Loading...</td></tr>';
  const params=new URLSearchParams();
  if(from)params.set('from',from);if(to)params.set('to',to);if(status)params.set('status',status);if(dept)params.set('department',dept);if(name)params.set('name',name);
  try{
    const{records=[],total_working='0h 0m',total_working_minutes=0}=await(await fetch('/api/attendance/records?'+params)).json();
    document.getElementById('recCnt').textContent=records.length+' records';
    const counts={present:0,late:0,early_leave:0,late_early_leave:0,absent:0};
    records.forEach(r=>{if(counts[r.status]!==undefined)counts[r.status]++;});
    document.getElementById('sumTotal').textContent=records.length;
    document.getElementById('sumPresent').textContent=counts.present;
    document.getElementById('sumLate').textContent=counts.late;
    document.getElementById('sumEarly').textContent=counts.early_leave+counts.late_early_leave;
    document.getElementById('sumAbsent').textContent=counts.absent;
    const th=Math.floor(total_working_minutes/60),tm=total_working_minutes%60;
    document.getElementById('sumWork').textContent=th+'h '+tm+'m';
    if(records.length){document.getElementById('totalWorkVal').textContent=total_working;document.getElementById('totalWorkNote').textContent=from&&to?'Range: '+from+' → '+to:'';document.getElementById('totalWorkBar').style.display='flex';}
    else document.getElementById('totalWorkBar').style.display='none';
    if(!records.length){body.innerHTML='<tr><td colspan="9" class="tbl-empty">No records found</td></tr>';return;}
    body.innerHTML=records.map(r=>{
      const wh=r.working_hours?'<span class="time-pill work">'+esc(r.working_hours)+'</span>':'<span style="color:var(--muted)">—</span>';
      const exp=r.expected_checkout?'<span class="time-pill exp">'+esc(r.expected_checkout)+'</span>':'<span style="color:var(--muted)">—</span>';
      return '<tr>'+
        '<td><div class="td-name"><div class="td-av">'+esc(r.name[0].toUpperCase())+'</div>'+esc(r.name)+'</div></td>'+
        '<td style="color:var(--muted);font-family:monospace;font-size:0.72rem">'+(r.employee_id||'—')+'</td>'+
        '<td style="color:var(--muted);font-size:0.72rem">'+(r.department||'—')+'</td>'+
        '<td><span class="date-chip">'+esc(r.date)+'</span></td>'+
        '<td><span class="time-pill">'+esc(r.time_in)+'</span></td>'+
        '<td><span class="time-pill out">'+esc(r.time_out||'—')+'</span></td>'+
        '<td>'+exp+'</td>'+
        '<td>'+wh+'</td>'+
        '<td><span class="badge badge-'+esc(r.status)+'">'+(statusLabels[r.status]||r.status)+'</span></td>'+
        '</tr>';
    }).join('');
  }catch(e){body.innerHTML='<tr><td colspan="9" class="tbl-empty" style="color:var(--red)">Error: '+esc(e.message)+'</td></tr>';}
}

function clearFilters(){
  document.getElementById('fStatus').value='';document.getElementById('fDept').value='';document.getElementById('fName').value='';
  const now=new Date();const y=now.getFullYear(),m=String(now.getMonth()+1).padStart(2,'0'),d=String(now.getDate()).padStart(2,'0');
  document.getElementById('fFrom').value=y+'-'+m+'-01';document.getElementById('fTo').value=y+'-'+m+'-'+d;
  applyFilters();
}
document.getElementById('fName').addEventListener('keydown',e=>{if(e.key==='Enter')applyFilters();});
applyFilters();
</script>
</body>
</html>`;
}

// ─── LED API ROUTES ───────────────────────────────────────────────────────────
app.get('/api/led/status', (req, res) => {
  const cmd = pendingLedCommand || { led: 'X', buzzer: 0, name: '', status: '' };
  pendingLedCommand = null;
  res.set('Content-Type', 'text/plain')
     .send(`LED:${cmd.led};BUZZ:${cmd.buzzer};NAME:${cmd.name};STATUS:${cmd.status}`);
});

app.get('/api/led/status/json', (req, res) => {
  const cmd = pendingLedCommand || { led: 'X', buzzer: 0, name: '', status: '', timestamp: null };
  pendingLedCommand = null;
  res.json(cmd);
});

app.post('/api/led/trigger', (req, res) => {
  const { eventType, name = '', status = '' } = req.body;
  if (!eventType) return res.status(400).json({ error: 'eventType required' });
  setLed(eventType, name, status);
  res.json({ success: true, ...pendingLedCommand });
});

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
    const faces = await dbQuery('SELECT id, label, employee_id, department, registration_accuracy, registered_at FROM faces ORDER BY registered_at DESC');
    res.send(getRegisterHTML(faces));
  } catch(e) { res.status(500).send('DB error: ' + e.message); }
});

app.get('/records', (req, res) => res.send(getRecordsHTML()));

app.get('/unknown-faces', (req, res) => res.send(getUnknownFacesHTML()));

// ─── START ────────────────────────────────────────────────────────────────────
setup().then(() => {
  app.listen(PORT, () => {
    console.log('\n==========================================');
    console.log('🚀  http://localhost:' + PORT);
    console.log('📋  Attendance    → http://localhost:' + PORT + '/');
    console.log('📊  Records       → http://localhost:' + PORT + '/records');
    console.log('👤  Register      → http://localhost:' + PORT + '/register');
    console.log('❓  Unknown Faces → http://localhost:' + PORT + '/unknown-faces');
    console.log('⏰  Office: ' + OFFICE_START.h + ':' + String(OFFICE_START.m).padStart(2,'0') +
      ' AM  |  Grace: +' + GRACE_MINUTES + ' min  |  End: ' + OFFICE_END.h + ':' + String(OFFICE_END.m).padStart(2,'0') +
      '  |  Absent after: ' + ABSENT_AFTER.h + ':00 AM');
    console.log('==========================================\n');
  });
});
