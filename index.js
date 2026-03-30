/**
 * FaceAttend SaaS — Multi-tenant Face Recognition Attendance
 * Roles: super_admin | admin (tenant) | user (employee)
 *
 * Color scheme: #00adee (accent blue) — same as single-user version
 * Push Notifications: Web Push (VAPID) — auto-sent on face scan
 *
 * Install:  npm install express mysql2 bcryptjs jsonwebtoken web-push
 */

'use strict';

const express   = require('express');
const mysql     = require('mysql2');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
let webpush;
try { webpush = require('web-push'); } catch(e) { webpush = null; }

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Static assets ─────────────────────────────────────────────────────────────
const PUBLIC_DIR         = path.join(__dirname, 'public');
const MODELS_DIR         = path.join(PUBLIC_DIR, 'models');
const UNKNOWN_IMAGES_DIR = path.join(PUBLIC_DIR, 'unknown-images');
const FACEAPI_PATH       = path.join(PUBLIC_DIR, 'faceapi.js');

app.use('/models',         express.static(MODELS_DIR));
app.use('/faceapi.js',    (_, res) => res.sendFile(FACEAPI_PATH));
app.use('/unknown-images', express.static(UNKNOWN_IMAGES_DIR));

// ── DB ────────────────────────────────────────────────────────────────────────
const DB_CONFIG = {
  host     : process.env.DB_HOST     || '127.0.0.1',
  user     : process.env.DB_USER     || 'u966260443_facedetect',
  password : process.env.DB_PASS     || 'Makelabs@123',
  database : process.env.DB_NAME     || 'u966260443_facedetect',
  multipleStatements: true
};
const db = mysql.createConnection(DB_CONFIG);

function dbQuery(sql, params = []) {
  return new Promise((res, rej) =>
    db.query(sql, params, (err, rows) => err ? rej(err) : res(rows))
  );
}

// ── JWT / Session ─────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'faceattend_saas_secret_2025_change_in_prod';

function signToken(payload) { return jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' }); }
function verifyToken(t)     { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }

function authMiddleware(role) {
  return (req, res, next) => {
    const t = req.headers['x-token'] || req.query._t;
    if (!t) return res.status(401).json({ error: 'No token' });
    const p = verifyToken(t);
    if (!p) return res.status(401).json({ error: 'Invalid token' });
    if (role && p.role !== role) return res.status(403).json({ error: 'Forbidden' });
    req.user = p;
    next();
  };
}

// ── VAPID / Web Push ──────────────────────────────────────────────────────────
const VAPID = {
  public : process.env.VAPID_PUBLIC  || '',
  private: process.env.VAPID_PRIVATE || '',
  email  : process.env.VAPID_EMAIL   || 'mailto:admin@faceattend.app'
};
let pushEnabled = false;
if (webpush && VAPID.public && VAPID.private) {
  try {
    webpush.setVapidDetails(VAPID.email, VAPID.public, VAPID.private);
    pushEnabled = true;
    console.log('✅ Web Push (VAPID) enabled');
  } catch(e) { console.warn('⚠️ VAPID setup failed:', e.message); }
} else {
  console.warn('⚠️ Web Push disabled — set VAPID_PUBLIC / VAPID_PRIVATE env vars');
}

async function sendPushToUser(userId, title, body, adminId) {
  if (!pushEnabled || !webpush) return;
  try {
    const rows = await dbQuery(
      'SELECT push_subscription FROM users WHERE id=? AND admin_id=? AND notifications_enabled=1 AND push_subscription IS NOT NULL',
      [userId, adminId]
    );
    if (!rows.length || !rows[0].push_subscription) return;
    const sub = JSON.parse(rows[0].push_subscription);
    await webpush.sendNotification(sub, JSON.stringify({
      title, body,
      icon: '/icon-192.png',
      badge: '/icon-192.png'
    }));
    await dbQuery(
      'INSERT INTO push_log (admin_id,user_id,title,body) VALUES (?,?,?,?)',
      [adminId, userId, title, body]
    );
  } catch(e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      // Subscription expired — remove it
      await dbQuery('UPDATE users SET push_subscription=NULL, notifications_enabled=0 WHERE id=?', [userId]);
    }
    console.warn('Push error:', e.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escH(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}
function pad2(n) { return String(n).padStart(2,'0'); }
function fmtTime(t) {
  if (!t) return '—';
  const p = String(t).split(':');
  const h = parseInt(p[0]), m = p[1]||'00';
  return (h%12||12)+':'+m+' '+(h>=12?'PM':'AM');
}

const THRESHOLD      = 0.5;
const REGISTER_SAMPLES = 10;

function euclidean(a, b) {
  let s = 0; for (let i=0;i<a.length;i++) s+=(a[i]-b[i])**2; return Math.sqrt(s);
}

// ── DB Init ───────────────────────────────────────────────────────────────────
db.connect(err => {
  if (err) { console.error('❌ MySQL error:', err.message); process.exit(1); }
  console.log('✅ MySQL connected →', DB_CONFIG.database);
  initTables().then(() => setup());
});

async function initTables() {
  const sql = `
    CREATE TABLE IF NOT EXISTS super_admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(191) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(191) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      org_name VARCHAR(200) NOT NULL,
      org_type ENUM('office','school','hospital','factory','other') DEFAULT 'office',
      attendance_title VARCHAR(200) DEFAULT 'Attendance System',
      logo_base64 LONGTEXT DEFAULT NULL,
      status ENUM('pending','approved','rejected','suspended') DEFAULT 'pending',
      approved_at DATETIME DEFAULT NULL,
      approved_by INT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS shifts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS faces (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      label VARCHAR(100) NOT NULL,
      employee_id VARCHAR(50) DEFAULT '',
      department VARCHAR(100) DEFAULT '',
      shift_id INT DEFAULT NULL,
      user_email VARCHAR(191) DEFAULT NULL,
      descriptor LONGTEXT NOT NULL,
      registration_accuracy TINYINT UNSIGNED DEFAULT NULL,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admin_label (admin_id, label),
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
      FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      face_id INT DEFAULT NULL,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(191) NOT NULL,
      password VARCHAR(255) NOT NULL,
      push_subscription LONGTEXT DEFAULT NULL,
      notifications_enabled TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_email_admin (email, admin_id),
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
      FOREIGN KEY (face_id) REFERENCES faces(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS attendance (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      face_id INT NOT NULL,
      shift_id INT DEFAULT NULL,
      name VARCHAR(100) NOT NULL,
      date DATE NOT NULL,
      time_in TIME NOT NULL,
      time_out TIME DEFAULT NULL,
      status ENUM('present','absent') DEFAULT 'present',
      notification_sent TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_face_date (face_id, date),
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
      FOREIGN KEY (face_id) REFERENCES faces(id) ON DELETE CASCADE,
      FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS holidays (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      date DATE NOT NULL,
      label VARCHAR(200) DEFAULT 'Holiday',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admin_date (admin_id, date),
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS unknown_faces (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      image_file VARCHAR(255) DEFAULT NULL,
      captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      date DATE NOT NULL,
      time_detected TIME NOT NULL,
      source VARCHAR(50) DEFAULT 'checkin',
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS push_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      user_id INT NOT NULL,
      attendance_id INT DEFAULT NULL,
      title VARCHAR(200),
      body TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  try {
    await dbQuery(sql);
    console.log('✅ All tables ready');
  } catch(e) {
    // tables may already exist — ignore duplicate errors
    if (!e.message.includes('already exists')) console.warn('DB init warning:', e.message);
  }
}

// ── Model / face-api download ─────────────────────────────────────────────────
const FACEAPI_URL    = 'https://unpkg.com/face-api.js@0.22.2/dist/face-api.min.js';
const MODEL_BASE_URL = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/';
const MODEL_FILES    = [
  'ssd_mobilenetv1_model-weights_manifest.json','ssd_mobilenetv1_model-shard1','ssd_mobilenetv1_model-shard2',
  'face_landmark_68_model-weights_manifest.json','face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json','face_recognition_model-shard1','face_recognition_model-shard2',
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) return resolve(false);
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if ([301,302].includes(res.statusCode)) {
        file.close(); fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close(); try{fs.unlinkSync(dest);}catch(_){}
        return reject(new Error('HTTP '+res.statusCode));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(true); });
    }).on('error', e => { try{fs.unlinkSync(dest);}catch(_){} reject(e); });
  });
}

async function setup() {
  [PUBLIC_DIR, MODELS_DIR, UNKNOWN_IMAGES_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
  if (!fs.existsSync(FACEAPI_PATH)) {
    process.stdout.write('📥 Downloading face-api.js... ');
    try { await download(FACEAPI_URL, FACEAPI_PATH); console.log('✅'); }
    catch(e) { console.log('❌ ' + e.message); }
  } else { console.log('✅ face-api.js cached'); }

  const missing = MODEL_FILES.filter(f => {
    const fp = path.join(MODELS_DIR, f);
    if (!fs.existsSync(fp)) return true;
    if (fs.statSync(fp).size < 100) { fs.unlinkSync(fp); return true; }
    return false;
  });
  if (!missing.length) { console.log('✅ All models cached'); }
  else {
    console.log('📥 Downloading models...');
    for (const f of missing) {
      try { await download(MODEL_BASE_URL+f, path.join(MODELS_DIR,f)); console.log('  ✅', f); }
      catch(e) { console.log('  ❌', f, e.message); }
    }
  }
  console.log('\n🚀 FaceAttend SaaS running on http://localhost:' + PORT + '\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CSS + SHARED STYLE (same color scheme as original)
// ═══════════════════════════════════════════════════════════════════════════════
const SHARED_CSS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
:root{
  --bg:#ffffff;--surface:#f8f9fa;--card:#ffffff;--border:#dbe3ea;
  --accent:#00adee;--accent2:#00adee;--red:#f87171;--yellow:#fbbf24;
  --green:#34d399;--purple:#a78bfa;--orange:#fb923c;
  --text:#1f2937;--muted:#6b7280;--muted2:#cfd8e3;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Space Grotesk',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 50% at 50% -10%,rgba(0,173,238,0.08),transparent);pointer-events:none;z-index:0}
nav{position:sticky;top:0;z-index:100;background:rgba(255,255,255,0.96);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:62px}
.nav-logo{display:flex;align-items:center;gap:10px;font-family:'JetBrains Mono',monospace;font-size:0.9rem;font-weight:600;color:var(--text);text-decoration:none}
.nav-logo span{color:var(--accent)}
.nav-logo img{height:36px;border-radius:6px;object-fit:contain}
.nav-right{display:flex;align-items:center;gap:10px}
.badge{padding:3px 10px;border-radius:20px;font-size:0.65rem;font-weight:700;letter-spacing:0.5px;text-transform:uppercase}
.badge-sa{background:rgba(167,139,250,0.15);color:#7c3aed}
.badge-admin{background:rgba(0,173,238,0.12);color:var(--accent)}
.badge-user{background:rgba(52,211,153,0.15);color:#059669}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:10px;font-family:'Space Grotesk',sans-serif;font-size:0.8rem;font-weight:600;cursor:pointer;border:none;text-decoration:none;transition:all 0.2s;white-space:nowrap}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:#009ed8;transform:translateY(-1px);box-shadow:0 4px 16px rgba(0,173,238,0.35)}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-outline:hover{border-color:var(--accent);color:var(--accent)}
.btn-danger{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);color:var(--red)}
.btn-danger:hover{background:rgba(248,113,113,0.2)}
.btn-success{background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.3);color:#059669}
.btn-success:hover{background:rgba(52,211,153,0.2)}
.btn-sm{padding:5px 10px;font-size:0.72rem}
main{max-width:1100px;margin:0 auto;padding:24px 16px;position:relative;z-index:1}
.page-title{font-family:'JetBrains Mono',monospace;font-size:0.65rem;color:var(--muted);letter-spacing:2px;text-transform:uppercase;margin-bottom:18px}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px}
.card-sm{padding:14px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px}
.stat-val{font-family:'JetBrains Mono',monospace;font-size:1.6rem;font-weight:600;color:var(--accent);line-height:1}
.stat-val.green{color:var(--green)}.stat-val.red{color:var(--red)}.stat-val.yellow{color:var(--yellow)}
.stat-label{font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:5px}
.form-group{margin-bottom:14px}
.form-group label{display:block;font-size:0.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:6px}
.form-control{width:100%;background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:9px 12px;color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:0.85rem;outline:none;transition:border-color 0.2s}
.form-control:focus{border-color:var(--accent)}
select.form-control{cursor:pointer}
.alert{padding:10px 14px;border-radius:10px;font-size:0.82rem;margin-bottom:14px}
.alert-error{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.25);color:#dc2626}
.alert-success{background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.25);color:#059669}
.alert-warn{background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.25);color:#92400e}
.alert-info{background:rgba(0,173,238,0.08);border:1px solid rgba(0,173,238,0.2);color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:0.82rem}
th{font-size:0.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.8px;padding:8px 12px;text-align:left;border-bottom:1px solid var(--border)}
td{padding:10px 12px;border-bottom:1px solid var(--surface);color:var(--text)}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--surface)}
.chip{display:inline-block;padding:2px 8px;border-radius:20px;font-size:0.65rem;font-weight:600}
.chip-green{background:rgba(52,211,153,0.12);color:#059669}
.chip-red{background:rgba(248,113,113,0.12);color:#dc2626}
.chip-yellow{background:rgba(251,191,36,0.12);color:#92400e}
.chip-blue{background:rgba(0,173,238,0.1);color:var(--accent)}
.chip-gray{background:rgba(107,114,128,0.1);color:var(--muted)}
.chip-purple{background:rgba(167,139,250,0.12);color:#7c3aed}
.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:800;display:none;align-items:center;justify-content:center;padding:16px}
.modal-backdrop.open{display:flex}
.modal{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:24px;width:100%;max-width:480px;box-shadow:0 20px 60px rgba(0,0,0,0.12)}
.modal-title{font-family:'JetBrains Mono',monospace;font-size:0.65rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:18px;display:flex;align-items:center;justify-content:space-between}
.modal-close{background:none;border:none;cursor:pointer;color:var(--muted);font-size:1.2rem;line-height:1}
.modal-close:hover{color:var(--red)}
.tabs{display:flex;gap:4px;background:var(--surface);border-radius:10px;padding:4px;margin-bottom:18px}
.tab{flex:1;text-align:center;padding:7px 10px;border-radius:8px;font-size:0.78rem;font-weight:600;cursor:pointer;border:none;background:transparent;color:var(--muted);transition:all 0.2s}
.tab.active{background:var(--card);color:var(--accent);box-shadow:0 1px 4px rgba(0,0,0,0.08)}
/* Calendar */
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
.cal-head{font-size:0.65rem;color:var(--muted);text-align:center;padding:4px;font-weight:600}
.cal-day{min-height:56px;border:1px solid var(--border);border-radius:8px;padding:4px;font-size:0.7rem;cursor:pointer;transition:border-color 0.2s;position:relative;display:flex;flex-direction:column}
.cal-day:hover{border-color:var(--accent)}
.cal-day.today{border-color:var(--accent);background:rgba(0,173,238,0.04)}
.cal-day.holiday{background:rgba(251,191,36,0.08);border-color:var(--yellow)}
.cal-day.other-month{opacity:0.35}
.cal-day-num{font-family:'JetBrains Mono',monospace;font-size:0.72rem;font-weight:600;color:var(--text)}
.cal-day.holiday .cal-day-num{color:#92400e}
.cal-day.today .cal-day-num{color:var(--accent)}
.cal-event{font-size:0.58rem;border-radius:4px;padding:1px 4px;margin-top:2px;font-weight:600;display:block}
.cal-present{background:rgba(52,211,153,0.2);color:#059669}
.cal-absent{background:rgba(248,113,113,0.2);color:#dc2626}
.cal-holiday-tag{background:rgba(251,191,36,0.25);color:#92400e}
/* Cam */
.cam-card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.cam-wrap{position:relative;background:#f8f9fa;aspect-ratio:4/3}
.cam-wrap video,.cam-wrap canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.scan-line{position:absolute;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--accent),transparent);animation:scan 3s ease-in-out infinite;opacity:0.4;pointer-events:none}
@keyframes scan{0%{top:0}50%{top:calc(100% - 2px)}100%{top:0}}
.cam-controls{padding:10px 12px;background:var(--surface);display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.btn-checkin{background:var(--accent);color:#fff}.btn-checkin:hover:not(:disabled){background:#009ed8;transform:translateY(-1px)}
.btn-checkin:disabled,.btn-checkout:disabled{opacity:0.5;cursor:not-allowed}
@keyframes livepulse{0%,100%{opacity:1}50%{opacity:0.4}}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
.live-dot{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:livepulse 2s infinite;flex-shrink:0}
.result-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:18px}
.result-title{font-family:'JetBrains Mono',monospace;font-size:0.62rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:12px}
/* Logo preview */
.logo-preview{max-height:60px;max-width:150px;border-radius:8px;object-fit:contain;border:1px solid var(--border)}
/* Status colours for admins */
.status-pending{color:#92400e}.status-approved{color:#059669}.status-rejected{color:#dc2626}.status-suspended{color:var(--muted)}
/* Notification toggle */
.notif-toggle{display:flex;align-items:center;gap:10px;padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:12px;margin-bottom:14px}
.switch{position:relative;display:inline-block;width:42px;height:24px}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;cursor:pointer;inset:0;background:#ccc;border-radius:24px;transition:0.3s}
.slider:before{content:'';position:absolute;width:18px;height:18px;left:3px;bottom:3px;background:white;border-radius:50%;transition:0.3s}
input:checked+.slider{background:var(--accent)}
input:checked+.slider:before{transform:translateX(18px)}
@media(max-width:640px){.grid2,.grid3,.grid4{grid-template-columns:1fr}.cal-grid{gap:2px}.cal-day{min-height:44px}}
</style>`;

// ═══════════════════════════════════════════════════════════════════════════════
//  SUPER ADMIN — Setup / Login / Dashboard
// ═══════════════════════════════════════════════════════════════════════════════

// Check if any super admin exists
app.get('/api/super-admin/exists', async (_, res) => {
  const rows = await dbQuery('SELECT COUNT(*) AS c FROM super_admins').catch(() => [{ c:0 }]);
  res.json({ exists: rows[0].c > 0 });
});

// First-run setup
app.post('/api/super-admin/setup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name||!email||!password) return res.json({ error: 'All fields required' });
  const rows = await dbQuery('SELECT COUNT(*) AS c FROM super_admins');
  if (rows[0].c > 0) return res.json({ error: 'Super admin already exists' });
  const hash = await bcrypt.hash(password, 12);
  await dbQuery('INSERT INTO super_admins (name,email,password) VALUES (?,?,?)', [name, email, hash]);
  res.json({ ok: true });
});

// Super admin login
app.post('/api/super-admin/login', async (req, res) => {
  const { email, password } = req.body;
  const rows = await dbQuery('SELECT * FROM super_admins WHERE email=?', [email]);
  if (!rows.length) return res.json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, rows[0].password);
  if (!ok) return res.json({ error: 'Invalid credentials' });
  const token = signToken({ id: rows[0].id, role: 'super_admin', name: rows[0].name, email: rows[0].email });
  res.json({ token, name: rows[0].name });
});

// Super admin — list admins
app.get('/api/super-admin/admins', authMiddleware('super_admin'), async (req, res) => {
  const rows = await dbQuery(`
    SELECT a.*, sa.name as approved_by_name,
      (SELECT COUNT(*) FROM faces f WHERE f.admin_id=a.id) AS face_count,
      (SELECT COUNT(*) FROM users u WHERE u.admin_id=a.id) AS user_count,
      (SELECT COUNT(*) FROM users u WHERE u.admin_id=a.id AND u.notifications_enabled=1) AS notif_count,
      (SELECT COUNT(*) FROM attendance at WHERE at.admin_id=a.id AND at.date=CURDATE()) AS today_attendance
    FROM admins a
    LEFT JOIN super_admins sa ON sa.id=a.approved_by
    ORDER BY a.created_at DESC
  `);
  res.json(rows);
});

// Super admin — approve/reject/suspend admin
app.post('/api/super-admin/admin/:id/status', authMiddleware('super_admin'), async (req, res) => {
  const { status } = req.body;
  if (!['approved','rejected','suspended','pending'].includes(status)) return res.json({ error: 'Invalid status' });
  await dbQuery(
    'UPDATE admins SET status=?, approved_by=?, approved_at=? WHERE id=?',
    [status, req.user.id, status==='approved'?new Date():null, req.params.id]
  );
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN — Register / Login / Dashboard
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/register', async (req, res) => {
  const { name, email, password, org_name, org_type, attendance_title, logo_base64 } = req.body;
  if (!name||!email||!password||!org_name) return res.json({ error: 'Required fields missing' });
  const exists = await dbQuery('SELECT id FROM admins WHERE email=?', [email]);
  if (exists.length) return res.json({ error: 'Email already registered' });
  const hash = await bcrypt.hash(password, 12);
  await dbQuery(
    'INSERT INTO admins (name,email,password,org_name,org_type,attendance_title,logo_base64) VALUES (?,?,?,?,?,?,?)',
    [name, email, hash, org_name, org_type||'office', attendance_title||'Attendance System', logo_base64||null]
  );
  res.json({ ok: true, message: 'Registration submitted. Awaiting super admin approval.' });
});

app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  const rows = await dbQuery('SELECT * FROM admins WHERE email=?', [email]);
  if (!rows.length) return res.json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, rows[0].password);
  if (!ok) return res.json({ error: 'Invalid credentials' });
  if (rows[0].status !== 'approved') return res.json({ error: `Account ${rows[0].status}. Awaiting super admin approval.` });
  const token = signToken({
    id: rows[0].id, role: 'admin', name: rows[0].name,
    email: rows[0].email, org_name: rows[0].org_name
  });
  res.json({ token, name: rows[0].name, org_name: rows[0].org_name });
});

// Admin — get own info
app.get('/api/admin/me', authMiddleware('admin'), async (req, res) => {
  const rows = await dbQuery('SELECT id,name,email,org_name,org_type,attendance_title,logo_base64,status FROM admins WHERE id=?', [req.user.id]);
  res.json(rows[0]);
});

// ── Shifts ────────────────────────────────────────────────────────────────────
app.get('/api/admin/shifts', authMiddleware('admin'), async (req, res) => {
  const rows = await dbQuery('SELECT * FROM shifts WHERE admin_id=? ORDER BY start_time', [req.user.id]);
  res.json(rows);
});
app.post('/api/admin/shifts', authMiddleware('admin'), async (req, res) => {
  const { name, start_time, end_time } = req.body;
  if (!name||!start_time||!end_time) return res.json({ error: 'All fields required' });
  const r = await dbQuery('INSERT INTO shifts (admin_id,name,start_time,end_time) VALUES (?,?,?,?)',
    [req.user.id, name, start_time, end_time]);
  res.json({ ok: true, id: r.insertId });
});
app.delete('/api/admin/shifts/:id', authMiddleware('admin'), async (req, res) => {
  await dbQuery('DELETE FROM shifts WHERE id=? AND admin_id=?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ── Faces ─────────────────────────────────────────────────────────────────────
app.get('/api/admin/faces', authMiddleware('admin'), async (req, res) => {
  const rows = await dbQuery(
    'SELECT f.*,s.name as shift_name FROM faces f LEFT JOIN shifts s ON s.id=f.shift_id WHERE f.admin_id=? ORDER BY f.label',
    [req.user.id]
  );
  res.json(rows.map(r => ({ ...r, descriptor: JSON.parse(r.descriptor) })));
});

app.post('/api/admin/faces', authMiddleware('admin'), async (req, res) => {
  const { label, employee_id, department, shift_id, user_email, descriptors, accuracy } = req.body;
  if (!label||!descriptors?.length) return res.json({ error: 'Label and descriptors required' });
  try {
    const avg = descriptors[0].map((_, i) => descriptors.reduce((s, d) => s + d[i], 0) / descriptors.length);
    const r = await dbQuery(
      `INSERT INTO faces (admin_id,label,employee_id,department,shift_id,user_email,descriptor,registration_accuracy)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE employee_id=VALUES(employee_id),department=VALUES(department),
       shift_id=VALUES(shift_id),user_email=VALUES(user_email),descriptor=VALUES(descriptor),registration_accuracy=VALUES(registration_accuracy)`,
      [req.user.id, label, employee_id||'', department||'', shift_id||null, user_email||null,
       JSON.stringify(descriptors), accuracy||null]
    );
    // If user_email provided, link face to user account
    if (user_email) {
      const faceId = r.insertId || (await dbQuery('SELECT id FROM faces WHERE admin_id=? AND label=?', [req.user.id, label]))[0]?.id;
      if (faceId) await dbQuery('UPDATE users SET face_id=? WHERE email=? AND admin_id=?', [faceId, user_email, req.user.id]);
    }
    res.json({ ok: true });
  } catch(e) { res.json({ error: e.message }); }
});

app.delete('/api/admin/faces/:id', authMiddleware('admin'), async (req, res) => {
  await dbQuery('DELETE FROM faces WHERE id=? AND admin_id=?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ── Users (employee accounts) ─────────────────────────────────────────────────
app.get('/api/admin/users', authMiddleware('admin'), async (req, res) => {
  const rows = await dbQuery(
    `SELECT u.id,u.name,u.email,u.notifications_enabled,u.created_at,f.label as face_label
     FROM users u LEFT JOIN faces f ON f.id=u.face_id
     WHERE u.admin_id=? ORDER BY u.name`,
    [req.user.id]
  );
  res.json(rows);
});

app.post('/api/admin/users', authMiddleware('admin'), async (req, res) => {
  const { name, email, password } = req.body;
  if (!name||!email||!password) return res.json({ error: 'All fields required' });
  const hash = await bcrypt.hash(password, 12);
  try {
    // find face if email matches
    const face = await dbQuery('SELECT id FROM faces WHERE admin_id=? AND user_email=?', [req.user.id, email]);
    const faceId = face.length ? face[0].id : null;
    await dbQuery(
      'INSERT INTO users (admin_id,face_id,name,email,password) VALUES (?,?,?,?,?)',
      [req.user.id, faceId, name, email, hash]
    );
    // also update faces table
    if (faceId) await dbQuery('UPDATE faces SET user_email=? WHERE id=?', [email, faceId]);
    res.json({ ok: true });
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return res.json({ error: 'Email already exists for this organisation' });
    res.json({ error: e.message });
  }
});

app.delete('/api/admin/users/:id', authMiddleware('admin'), async (req, res) => {
  await dbQuery('DELETE FROM users WHERE id=? AND admin_id=?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// Notification stats for admin
app.get('/api/admin/notif-stats', authMiddleware('admin'), async (req, res) => {
  const rows = await dbQuery(
    `SELECT
       SUM(notifications_enabled=1) AS enabled,
       SUM(notifications_enabled=0) AS disabled,
       COUNT(*) AS total
     FROM users WHERE admin_id=?`,
    [req.user.id]
  );
  res.json(rows[0]);
});

// ── Attendance (admin view) ───────────────────────────────────────────────────
app.get('/api/admin/attendance', authMiddleware('admin'), async (req, res) => {
  const { date, month, year } = req.query;
  let where = 'a.admin_id=?', params = [req.user.id];
  if (date) { where += ' AND a.date=?'; params.push(date); }
  else if (month && year) {
    where += ' AND MONTH(a.date)=? AND YEAR(a.date)=?';
    params.push(parseInt(month), parseInt(year));
  }
  const rows = await dbQuery(
    `SELECT a.*,s.name as shift_name FROM attendance a
     LEFT JOIN shifts s ON s.id=a.shift_id
     WHERE ${where} ORDER BY a.date DESC, a.time_in`,
    params
  );
  res.json(rows);
});

// Calendar summary for admin (present/absent counts per day)
app.get('/api/admin/calendar', authMiddleware('admin'), async (req, res) => {
  const { month, year } = req.query;
  const m = parseInt(month), y = parseInt(year);
  const [attend, holidays] = await Promise.all([
    dbQuery(
      `SELECT date, SUM(status='present') AS present, SUM(status='absent') AS absent
       FROM attendance WHERE admin_id=? AND MONTH(date)=? AND YEAR(date)=?
       GROUP BY date`,
      [req.user.id, m, y]
    ),
    dbQuery('SELECT date, label FROM holidays WHERE admin_id=? AND MONTH(date)=? AND YEAR(date)=?',
      [req.user.id, m, y])
  ]);
  res.json({ attendance: attend, holidays });
});

// ── Holidays ──────────────────────────────────────────────────────────────────
app.post('/api/admin/holidays', authMiddleware('admin'), async (req, res) => {
  const { date, label } = req.body;
  if (!date) return res.json({ error: 'Date required' });
  try {
    await dbQuery(
      'INSERT INTO holidays (admin_id,date,label) VALUES (?,?,?) ON DUPLICATE KEY UPDATE label=VALUES(label)',
      [req.user.id, date, label||'Holiday']
    );
    res.json({ ok: true });
  } catch(e) { res.json({ error: e.message }); }
});
app.delete('/api/admin/holidays/:date', authMiddleware('admin'), async (req, res) => {
  await dbQuery('DELETE FROM holidays WHERE admin_id=? AND date=?', [req.user.id, req.params.date]);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  FACE RECOGNITION — CHECKIN/CHECKOUT (admin-side scan)
// ═══════════════════════════════════════════════════════════════════════════════
let pendingLedCommand = {}; // per admin_id

app.post('/api/admin/scan', authMiddleware('admin'), async (req, res) => {
  const { descriptor: inDesc, mode } = req.body; // mode: 'checkin'|'checkout'
  if (!inDesc?.length) return res.json({ event: 'error', message: 'No descriptor' });

  const adminId = req.user.id;
  const faces = await dbQuery(
    'SELECT id,label,shift_id,user_email,descriptor FROM faces WHERE admin_id=?', [adminId]
  );
  if (!faces.length) return res.json({ event: 'no_faces', message: 'No faces registered' });

  // Match
  let best = null, bestDist = Infinity;
  for (const face of faces) {
    const stored = JSON.parse(face.descriptor);
    const dists = stored.map(d => euclidean(inDesc, d));
    const minDist = Math.min(...dists);
    if (minDist < bestDist) { bestDist = minDist; best = face; }
  }

  if (!best || bestDist > THRESHOLD) {
    // Save unknown face image if provided
    return res.json({ event: 'unknown', message: 'Unknown face', distance: bestDist });
  }

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = pad2(now.getHours())+':'+pad2(now.getMinutes())+':'+pad2(now.getSeconds());
  const shiftRow = best.shift_id ? (await dbQuery('SELECT * FROM shifts WHERE id=?', [best.shift_id]))[0] : null;

  const existing = await dbQuery(
    'SELECT * FROM attendance WHERE face_id=? AND date=?', [best.id, dateStr]
  );

  if (mode === 'checkout') {
    if (!existing.length) return res.json({ event: 'not_checked_in', name: best.label });
    if (existing[0].time_out) return res.json({ event: 'already_checked_out', name: best.label, time_out: existing[0].time_out });
    await dbQuery('UPDATE attendance SET time_out=? WHERE id=?', [timeStr, existing[0].id]);
    // Push notification for checkout
    if (best.user_email) {
      const user = await dbQuery('SELECT id FROM users WHERE email=? AND admin_id=?', [best.user_email, adminId]);
      if (user.length) {
        await sendPushToUser(user[0].id, '👋 Checked Out', `${best.label}, you checked out at ${fmtTime(timeStr)}`, adminId);
      }
    }
    return res.json({ event: 'checkout', name: best.label, time_out: timeStr, shift: shiftRow?.name });
  }

  // CHECKIN
  if (existing.length) {
    return res.json({ event: 'already_checked_in', name: best.label, time_in: existing[0].time_in });
  }

  // Determine status based on shift
  let status = 'present';
  if (shiftRow) {
    const [sh, sm] = shiftRow.start_time.split(':').map(Number);
    const shiftStartMin = sh*60+sm;
    const nowMin = now.getHours()*60+now.getMinutes();
    if (nowMin > shiftStartMin + 1) status = 'present'; // simple: present if came before end
  }

  const r = await dbQuery(
    'INSERT INTO attendance (admin_id,face_id,shift_id,name,date,time_in,status) VALUES (?,?,?,?,?,?,?)',
    [adminId, best.id, best.shift_id||null, best.label, dateStr, timeStr, status]
  );

  // Push notification
  if (best.user_email) {
    const user = await dbQuery('SELECT id FROM users WHERE email=? AND admin_id=?', [best.user_email, adminId]);
    if (user.length) {
      const shiftInfo = shiftRow ? ` (${shiftRow.name} shift)` : '';
      await sendPushToUser(
        user[0].id,
        '✅ Attendance Marked',
        `${best.label}, your attendance was recorded at ${fmtTime(timeStr)}${shiftInfo}`,
        adminId
      );
      await dbQuery('UPDATE attendance SET notification_sent=1 WHERE id=?', [r.insertId]);
    }
  }

  res.json({ event: 'checkin', name: best.label, time_in: timeStr, status, shift: shiftRow?.name, distance: bestDist });
});

// ── Unknown face image save ───────────────────────────────────────────────────
app.post('/api/admin/unknown-face', authMiddleware('admin'), async (req, res) => {
  const { imageData } = req.body;
  const adminId = req.user.id;
  const now = new Date();
  let fname = null;
  if (imageData) {
    fname = `unk_${adminId}_${Date.now()}_${Math.random().toString(36).slice(2,6)}.jpg`;
    const base64 = imageData.replace(/^data:image\/jpeg;base64,/,'');
    fs.writeFileSync(path.join(UNKNOWN_IMAGES_DIR, fname), Buffer.from(base64,'base64'));
  }
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = pad2(now.getHours())+':'+pad2(now.getMinutes())+':'+pad2(now.getSeconds());
  await dbQuery('INSERT INTO unknown_faces (admin_id,image_file,date,time_detected) VALUES (?,?,?,?)',
    [adminId, fname, dateStr, timeStr]);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  USER — Login / Attendance / Push Subscription
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/user/login', async (req, res) => {
  const { email, password } = req.body;
  const rows = await dbQuery(`
    SELECT u.*, a.org_name, a.attendance_title, a.logo_base64, a.status as admin_status
    FROM users u JOIN admins a ON a.id=u.admin_id WHERE u.email=?`, [email]);
  if (!rows.length) return res.json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, rows[0].password);
  if (!ok) return res.json({ error: 'Invalid credentials' });
  if (rows[0].admin_status !== 'approved') return res.json({ error: 'Organisation not active' });
  const token = signToken({
    id: rows[0].id, role: 'user', name: rows[0].name,
    email: rows[0].email, admin_id: rows[0].admin_id
  });
  res.json({
    token, name: rows[0].name,
    org_name: rows[0].org_name,
    attendance_title: rows[0].attendance_title,
    logo_base64: rows[0].logo_base64
  });
});

// Push subscription save
app.post('/api/user/push-subscribe', authMiddleware('user'), async (req, res) => {
  const { subscription } = req.body;
  await dbQuery(
    'UPDATE users SET push_subscription=?, notifications_enabled=1 WHERE id=? AND admin_id=?',
    [JSON.stringify(subscription), req.user.id, req.user.admin_id]
  );
  res.json({ ok: true });
});

// Push unsubscribe
app.post('/api/user/push-unsubscribe', authMiddleware('user'), async (req, res) => {
  await dbQuery(
    'UPDATE users SET push_subscription=NULL, notifications_enabled=0 WHERE id=? AND admin_id=?',
    [req.user.id, req.user.admin_id]
  );
  res.json({ ok: true });
});

// User attendance (for calendar view)
app.get('/api/user/attendance', authMiddleware('user'), async (req, res) => {
  const { month, year } = req.query;
  let where = 'a.admin_id=? AND f.user_email=?', params = [req.user.admin_id, req.user.email];
  if (month && year) {
    where += ' AND MONTH(a.date)=? AND YEAR(a.date)=?';
    params.push(parseInt(month), parseInt(year));
  }
  const [attend, holidays] = await Promise.all([
    dbQuery(
      `SELECT a.date,a.time_in,a.time_out,a.status,s.name as shift_name
       FROM attendance a
       JOIN faces f ON f.id=a.face_id
       LEFT JOIN shifts s ON s.id=a.shift_id
       WHERE ${where} ORDER BY a.date DESC`,
      params
    ),
    dbQuery(
      'SELECT date, label FROM holidays WHERE admin_id=? AND MONTH(date)=? AND YEAR(date)=?',
      [req.user.admin_id, parseInt(month), parseInt(year)]
    )
  ]);
  res.json({ attendance: attend, holidays });
});

// User notification status
app.get('/api/user/notif-status', authMiddleware('user'), async (req, res) => {
  const rows = await dbQuery('SELECT notifications_enabled FROM users WHERE id=?', [req.user.id]);
  res.json({ enabled: rows[0]?.notifications_enabled === 1 });
});

// VAPID public key (for service worker)
app.get('/api/vapid-public', (_, res) => res.json({ key: VAPID.public }));

// ═══════════════════════════════════════════════════════════════════════════════
//  SERVICE WORKER + PUSH ICON
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/sw.js', (_, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data.json(); } catch(_) { data = { title: 'FaceAttend', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(data.title || 'FaceAttend', {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: '/' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data?.url || '/'));
});
`);
});

// Simple SVG icon
app.get('/icon-192.png', (_, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
    <rect width="192" height="192" rx="40" fill="#00adee"/>
    <text x="96" y="130" font-size="100" text-anchor="middle" font-family="Arial" fill="white">👁</text>
  </svg>`);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  HTML PAGES
// ═══════════════════════════════════════════════════════════════════════════════

function htmlBase(title, body, extraHead='') {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escH(title)} — FaceAttend</title>
${SHARED_CSS}${extraHead}
</head><body>${body}</body></html>`;
}

// ── ROOT: route to correct portal based on session ────────────────────────────
app.get('/', (_, res) => res.redirect('/portal'));

// Smart portal router
app.get('/portal', (_, res) => {
  res.send(htmlBase('Portal', `
<main style="max-width:500px;margin:80px auto;padding:0 16px">
  <div style="text-align:center;margin-bottom:32px">
    <div style="font-family:'JetBrains Mono',monospace;font-size:1.8rem;font-weight:700;color:var(--text)">
      Face<span style="color:var(--accent)">Attend</span>
    </div>
    <div style="color:var(--muted);font-size:0.85rem;margin-top:6px">Multi-tenant Attendance System</div>
  </div>
  <div class="grid3" style="gap:12px">
    <a href="/super-admin" class="card card-sm" style="text-align:center;text-decoration:none;cursor:pointer;transition:border-color 0.2s" onmouseover="this.style.borderColor='#a78bfa'" onmouseout="this.style.borderColor='var(--border)'">
      <div style="font-size:1.5rem;margin-bottom:8px">🛡️</div>
      <div style="font-weight:700;font-size:0.8rem">Super Admin</div>
      <div style="font-size:0.68rem;color:var(--muted);margin-top:3px">Platform control</div>
    </a>
    <a href="/admin" class="card card-sm" style="text-align:center;text-decoration:none;cursor:pointer;transition:border-color 0.2s" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
      <div style="font-size:1.5rem;margin-bottom:8px">🏢</div>
      <div style="font-weight:700;font-size:0.8rem">Admin</div>
      <div style="font-size:0.68rem;color:var(--muted);margin-top:3px">Manage attendance</div>
    </a>
    <a href="/user" class="card card-sm" style="text-align:center;text-decoration:none;cursor:pointer;transition:border-color 0.2s" onmouseover="this.style.borderColor='var(--green)'" onmouseout="this.style.borderColor='var(--border)'">
      <div style="font-size:1.5rem;margin-bottom:8px">👤</div>
      <div style="font-weight:700;font-size:0.8rem">Employee</div>
      <div style="font-size:0.68rem;color:var(--muted);margin-top:3px">View my records</div>
    </a>
  </div>
</main>`));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  SUPER ADMIN PAGES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/super-admin', (_, res) => {
  res.send(htmlBase('Super Admin', `
<nav>
  <a class="nav-logo" href="/portal">Face<span>Attend</span></a>
  <div class="nav-right" id="navRight"></div>
</nav>
<main id="app">
  <div id="setupForm" style="display:none;max-width:440px;margin:40px auto">
    <div class="page-title">🛡️ First-time Setup — Create Super Admin</div>
    <div class="card">
      <div id="setupErr" class="alert alert-error" style="display:none"></div>
      <div class="form-group"><label>Full Name</label><input class="form-control" id="saName" placeholder="Super Admin Name"></div>
      <div class="form-group"><label>Email</label><input class="form-control" id="saEmail" type="email" placeholder="admin@example.com"></div>
      <div class="form-group"><label>Password</label><input class="form-control" id="saPass" type="password" placeholder="••••••••"></div>
      <button class="btn btn-primary" style="width:100%" onclick="doSetup()">Create Super Admin Account</button>
    </div>
  </div>
  <div id="loginForm" style="display:none;max-width:400px;margin:40px auto">
    <div class="page-title">🛡️ Super Admin Login</div>
    <div class="card">
      <div id="loginErr" class="alert alert-error" style="display:none"></div>
      <div class="form-group"><label>Email</label><input class="form-control" id="saLoginEmail" type="email"></div>
      <div class="form-group"><label>Password</label><input class="form-control" id="saLoginPass" type="password"></div>
      <button class="btn btn-primary" style="width:100%" onclick="doLogin()">Login</button>
    </div>
  </div>
  <div id="dashboard" style="display:none">
    <div class="page-title">🛡️ Super Admin Dashboard</div>
    <div id="statsRow" class="grid4" style="margin-bottom:18px"></div>
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <span style="font-weight:700">Registered Admins</span>
      </div>
      <div id="adminTable"></div>
    </div>
  </div>
</main>
<script>
const TOKEN_KEY='sa_token';
let saToken=localStorage.getItem(TOKEN_KEY);

async function init(){
  const r=await fetch('/api/super-admin/exists').then(x=>x.json());
  if(!r.exists){document.getElementById('setupForm').style.display='block';return;}
  if(!saToken){document.getElementById('loginForm').style.display='block';return;}
  loadDashboard();
}

async function doSetup(){
  const n=document.getElementById('saName').value,e=document.getElementById('saEmail').value,p=document.getElementById('saPass').value;
  const r=await fetch('/api/super-admin/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,email:e,password:p})}).then(x=>x.json());
  if(r.error){document.getElementById('setupErr').textContent=r.error;document.getElementById('setupErr').style.display='block';return;}
  location.reload();
}

async function doLogin(){
  const e=document.getElementById('saLoginEmail').value,p=document.getElementById('saLoginPass').value;
  const r=await fetch('/api/super-admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:p})}).then(x=>x.json());
  if(r.error){document.getElementById('loginErr').textContent=r.error;document.getElementById('loginErr').style.display='block';return;}
  saToken=r.token;localStorage.setItem(TOKEN_KEY,saToken);
  loadDashboard();
}

function logout(){localStorage.removeItem(TOKEN_KEY);location.reload();}

async function loadDashboard(){
  document.getElementById('loginForm').style.display='none';
  document.getElementById('dashboard').style.display='block';
  document.getElementById('navRight').innerHTML='<span class="badge badge-sa">Super Admin</span><button class="btn btn-sm btn-outline" onclick="logout()">Logout</button>';
  const admins=await fetch('/api/super-admin/admins',{headers:{'x-token':saToken}}).then(x=>x.json());
  if(admins.error){localStorage.removeItem(TOKEN_KEY);location.reload();return;}

  const total=admins.length, approved=admins.filter(a=>a.status==='approved').length,
        pending=admins.filter(a=>a.status==='pending').length,
        totalUsers=admins.reduce((s,a)=>s+(a.user_count||0),0);
  const totalNotif=admins.reduce((s,a)=>s+(a.notif_count||0),0);
  document.getElementById('statsRow').innerHTML=\`
    <div class="stat"><div class="stat-val">\${total}</div><div class="stat-label">Total Admins</div></div>
    <div class="stat"><div class="stat-val green">\${approved}</div><div class="stat-label">Approved</div></div>
    <div class="stat"><div class="stat-val yellow">\${pending}</div><div class="stat-label">Pending</div></div>
    <div class="stat"><div class="stat-val">\${totalUsers}</div><div class="stat-label">Total Employees</div></div>
  \`;

  const rows=admins.map(a=>\`
    <tr>
      <td><strong>\${a.org_name}</strong><br><span style="color:var(--muted);font-size:0.72rem">\${a.email}</span></td>
      <td>\${a.org_type}</td>
      <td><span class="chip chip-\${a.status==='approved'?'green':a.status==='pending'?'yellow':a.status==='rejected'?'red':'gray'}">\${a.status}</span></td>
      <td style="font-family:'JetBrains Mono',monospace">\${a.face_count||0} faces / \${a.user_count||0} users</td>
      <td><span class="chip chip-blue">\${a.notif_count||0} notif</span></td>
      <td>\${a.today_attendance||0} today</td>
      <td>
        \${a.status!=='approved'?'<button class="btn btn-sm btn-success" onclick="setStatus('+a.id+',\\'approved\\')">Approve</button>':
          '<button class="btn btn-sm btn-danger" onclick="setStatus('+a.id+',\\'suspended\\')">Suspend</button>'}
        \${a.status==='pending'||a.status==='suspended'?'<button class="btn btn-sm btn-danger" onclick="setStatus('+a.id+',\\'rejected\\')">Reject</button>':''}
      </td>
    </tr>
  \`).join('');
  document.getElementById('adminTable').innerHTML=\`
    <table>
      <thead><tr><th>Organisation</th><th>Type</th><th>Status</th><th>Faces/Users</th><th>Notifications</th><th>Today</th><th>Action</th></tr></thead>
      <tbody>\${rows||'<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:30px">No admins yet</td></tr>'}</tbody>
    </table>\`;
}

async function setStatus(id,status){
  await fetch('/api/super-admin/admin/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json','x-token':saToken},body:JSON.stringify({status})});
  loadDashboard();
}

init();
</script>`));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN PAGES  (register / login / dashboard with tabs)
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/admin', (_, res) => {
  res.send(htmlBase('Admin Portal', `
<nav>
  <a class="nav-logo" href="/portal" id="navLogo">Face<span>Attend</span></a>
  <div class="nav-right" id="navRight"></div>
</nav>
<main id="app">
  <!-- Auth Section -->
  <div id="authSection" style="max-width:460px;margin:30px auto">
    <div class="tabs">
      <button class="tab active" onclick="switchAuthTab('login',this)">Login</button>
      <button class="tab" onclick="switchAuthTab('register',this)">Register</button>
    </div>
    <!-- Login -->
    <div id="loginPanel" class="card">
      <div id="loginErr" class="alert alert-error" style="display:none"></div>
      <div class="form-group"><label>Email</label><input class="form-control" id="aEmail" type="email"></div>
      <div class="form-group"><label>Password</label><input class="form-control" id="aPass" type="password"></div>
      <button class="btn btn-primary" style="width:100%" onclick="doAdminLogin()">Login</button>
    </div>
    <!-- Register -->
    <div id="registerPanel" class="card" style="display:none">
      <div id="regErr" class="alert alert-error" style="display:none"></div>
      <div id="regOk" class="alert alert-success" style="display:none"></div>
      <div class="grid2">
        <div class="form-group"><label>Your Name</label><input class="form-control" id="rName" placeholder="John Doe"></div>
        <div class="form-group"><label>Email</label><input class="form-control" id="rEmail" type="email"></div>
      </div>
      <div class="grid2">
        <div class="form-group"><label>Password</label><input class="form-control" id="rPass" type="password"></div>
        <div class="form-group"><label>Organisation Name</label><input class="form-control" id="rOrg" placeholder="ABC School"></div>
      </div>
      <div class="grid2">
        <div class="form-group">
          <label>Organisation Type</label>
          <select class="form-control" id="rType">
            <option value="office">Office</option>
            <option value="school">School</option>
            <option value="hospital">Hospital</option>
            <option value="factory">Factory</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div class="form-group"><label>Attendance System Title</label><input class="form-control" id="rTitle" placeholder="Daily Attendance"></div>
      </div>
      <div class="form-group">
        <label>Organisation Logo</label>
        <input type="file" accept="image/*" id="rLogo" class="form-control" onchange="previewLogo(this)">
        <img id="logoPreview" class="logo-preview" style="display:none;margin-top:8px">
      </div>
      <button class="btn btn-primary" style="width:100%" onclick="doRegister()">Submit for Approval</button>
    </div>
  </div>

  <!-- Dashboard -->
  <div id="dashboard" style="display:none">
    <div class="tabs" id="dashTabs">
      <button class="tab active" onclick="switchTab('scan',this)">📷 Scan</button>
      <button class="tab" onclick="switchTab('faces',this)">👥 Faces</button>
      <button class="tab" onclick="switchTab('shifts',this)">⏰ Shifts</button>
      <button class="tab" onclick="switchTab('users',this)">👤 Users</button>
      <button class="tab" onclick="switchTab('calendar',this)">📅 Calendar</button>
    </div>

    <!-- SCAN TAB -->
    <div id="tab-scan">
      <div class="grid2" style="gap:14px;align-items:start">
        <div>
          <div class="cam-card">
            <div class="cam-wrap">
              <video id="video" autoplay muted playsinline></video>
              <canvas id="overlay"></canvas>
              <div class="scan-line"></div>
            </div>
            <div class="cam-controls">
              <div style="flex:1;display:flex;align-items:center;gap:8px;font-size:0.74rem;color:var(--muted)">
                <div class="live-dot" id="statusDot" style="background:var(--muted)"></div>
                <span id="statusText">Starting camera...</span>
              </div>
              <select class="form-control" id="scanMode" style="width:auto;padding:6px 10px;font-size:0.75rem">
                <option value="checkin">Check In</option>
                <option value="checkout">Check Out</option>
              </select>
              <button class="btn btn-checkin" id="scanBtn" onclick="doScan()" disabled>Scan</button>
              <button class="btn btn-outline btn-sm" id="autoBtn" onclick="toggleAuto()">Auto</button>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px" id="todayStats"></div>
        </div>
        <div>
          <div class="result-card" id="resultCard">
            <div class="result-title">Last Result</div>
            <div id="resultBody" style="color:var(--muted);font-size:0.82rem">Scan a face to see results here.</div>
          </div>
          <div class="card" style="margin-top:12px">
            <div style="font-size:0.72rem;font-weight:700;margin-bottom:10px">Today's Attendance</div>
            <div id="todayList" style="max-height:300px;overflow-y:auto;font-size:0.8rem"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- FACES TAB -->
    <div id="tab-faces" style="display:none">
      <div class="grid2" style="gap:14px;align-items:start">
        <div class="card">
          <div style="font-weight:700;margin-bottom:14px">Register New Face</div>
          <div class="cam-card" style="margin-bottom:12px">
            <div class="cam-wrap"><video id="regVideo" autoplay muted playsinline></video><canvas id="regOverlay"></canvas></div>
            <div class="cam-controls" style="justify-content:space-between">
              <span id="regStatus" style="font-size:0.72rem;color:var(--muted)">Camera ready</span>
              <button class="btn btn-primary btn-sm" id="captureBtn" onclick="captureSample()" disabled>Capture Sample</button>
            </div>
          </div>
          <div class="form-group"><label>Name / Label</label><input class="form-control" id="fName" placeholder="Employee Name"></div>
          <div class="grid2">
            <div class="form-group"><label>Employee ID</label><input class="form-control" id="fEmpId" placeholder="EMP001"></div>
            <div class="form-group"><label>Department</label><input class="form-control" id="fDept" placeholder="Engineering"></div>
          </div>
          <div class="grid2">
            <div class="form-group">
              <label>Shift</label>
              <select class="form-control" id="fShift">
                <option value="">No Shift</option>
              </select>
            </div>
            <div class="form-group"><label>User Email (for notifications)</label><input class="form-control" id="fUserEmail" type="email" placeholder="emp@company.com"></div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
            <span id="sampleCount" style="font-size:0.75rem;color:var(--muted)">0 / 10 samples</span>
            <button class="btn btn-outline btn-sm" onclick="clearSamples()">Clear</button>
          </div>
          <div id="regSampleBar" style="height:6px;background:var(--border);border-radius:4px;margin-bottom:12px">
            <div id="sampleProgress" style="height:100%;background:var(--accent);border-radius:4px;width:0%;transition:width 0.3s"></div>
          </div>
          <div id="regErr" class="alert alert-error" style="display:none"></div>
          <div id="regOk" class="alert alert-success" style="display:none"></div>
          <button class="btn btn-primary" style="width:100%" id="saveBtn" onclick="saveFace()" disabled>Save Face</button>
        </div>
        <div class="card">
          <div style="font-weight:700;margin-bottom:14px">Registered Faces</div>
          <div id="faceList"></div>
        </div>
      </div>
    </div>

    <!-- SHIFTS TAB -->
    <div id="tab-shifts" style="display:none">
      <div class="grid2" style="gap:14px;align-items:start">
        <div class="card">
          <div style="font-weight:700;margin-bottom:14px">Add Shift</div>
          <div class="form-group"><label>Shift Name</label><input class="form-control" id="shName" placeholder="Morning / Night / A / B"></div>
          <div class="grid2">
            <div class="form-group"><label>Start Time</label><input class="form-control" id="shStart" type="time"></div>
            <div class="form-group"><label>End Time</label><input class="form-control" id="shEnd" type="time"></div>
          </div>
          <div id="shErr" class="alert alert-error" style="display:none"></div>
          <button class="btn btn-primary" style="width:100%" onclick="addShift()">Add Shift</button>
        </div>
        <div class="card">
          <div style="font-weight:700;margin-bottom:14px">Your Shifts</div>
          <div id="shiftList"></div>
        </div>
      </div>
    </div>

    <!-- USERS TAB -->
    <div id="tab-users" style="display:none">
      <div class="grid2" style="gap:14px;align-items:start">
        <div class="card">
          <div style="font-weight:700;margin-bottom:14px">Add Employee Account</div>
          <div id="uErr" class="alert alert-error" style="display:none"></div>
          <div id="uOk" class="alert alert-success" style="display:none"></div>
          <div class="form-group"><label>Name</label><input class="form-control" id="uName" placeholder="Employee Name"></div>
          <div class="form-group"><label>Email</label><input class="form-control" id="uEmail" type="email" placeholder="emp@company.com"></div>
          <div class="form-group"><label>Password</label><input class="form-control" id="uPass" type="password" placeholder="••••••••"></div>
          <button class="btn btn-primary" style="width:100%" onclick="addUser()">Create Account</button>
        </div>
        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <span style="font-weight:700">Employee Accounts</span>
            <div id="notifStats" style="font-size:0.72rem;color:var(--muted)"></div>
          </div>
          <div id="userList"></div>
        </div>
      </div>
    </div>

    <!-- CALENDAR TAB -->
    <div id="tab-calendar" style="display:none">
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
          <button class="btn btn-outline btn-sm" onclick="changeMonth(-1)">&#8249; Prev</button>
          <span id="calTitle" style="font-weight:700"></span>
          <button class="btn btn-outline btn-sm" onclick="changeMonth(1)">Next &#8250;</button>
        </div>
        <div style="font-size:0.72rem;color:var(--muted);margin-bottom:10px">Click a date to make/remove holiday. Hover to see details.</div>
        <div class="cal-grid" id="calHead"></div>
        <div class="cal-grid" style="margin-top:4px" id="calGrid"></div>
      </div>
      <div id="calModal" class="modal-backdrop">
        <div class="modal">
          <div class="modal-title">
            <span id="calModalDate">Date</span>
            <button class="modal-close" onclick="closeCalModal()">✕</button>
          </div>
          <div id="calModalBody"></div>
          <div style="display:flex;gap:8px;margin-top:14px">
            <button class="btn btn-success" id="holidayAddBtn" onclick="toggleHoliday()">Make Holiday</button>
            <button class="btn btn-outline" onclick="closeCalModal()">Close</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</main>

<script src="/faceapi.js"></script>
<script>
const TOKEN_KEY='admin_token';
let adminToken=localStorage.getItem(TOKEN_KEY);
let adminShifts=[], adminFaces=[], regSamples=[], autoMode=false, autoTimer=null;
let calYear=new Date().getFullYear(), calMonth=new Date().getMonth()+1;
let calData={attendance:[],holidays:[]}, selectedCalDate=null;

// ── Auth ──────────────────────────────────────────────────────────────────────
function switchAuthTab(t,btn){
  document.querySelectorAll('.tabs .tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('loginPanel').style.display=t==='login'?'block':'none';
  document.getElementById('registerPanel').style.display=t==='register'?'block':'none';
}

function previewLogo(input){
  const f=input.files[0]; if(!f) return;
  const r=new FileReader();
  r.onload=e=>{const img=document.getElementById('logoPreview');img.src=e.target.result;img.style.display='block';};
  r.readAsDataURL(f);
}

async function doAdminLogin(){
  const e=document.getElementById('aEmail').value, p=document.getElementById('aPass').value;
  const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:p})}).then(x=>x.json());
  if(r.error){document.getElementById('loginErr').textContent=r.error;document.getElementById('loginErr').style.display='block';return;}
  adminToken=r.token; localStorage.setItem(TOKEN_KEY,adminToken);
  showDashboard(r);
}

async function doRegister(){
  const logo=document.getElementById('logoPreview').src||null;
  const body={
    name:document.getElementById('rName').value,
    email:document.getElementById('rEmail').value,
    password:document.getElementById('rPass').value,
    org_name:document.getElementById('rOrg').value,
    org_type:document.getElementById('rType').value,
    attendance_title:document.getElementById('rTitle').value,
    logo_base64: logo&&logo.startsWith('data:')?logo:null
  };
  const r=await fetch('/api/admin/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(x=>x.json());
  if(r.error){document.getElementById('regErr').textContent=r.error;document.getElementById('regErr').style.display='block';return;}
  document.getElementById('regOk').textContent=r.message||'Submitted! Await approval.';
  document.getElementById('regOk').style.display='block';
}

function adminLogout(){localStorage.removeItem(TOKEN_KEY);location.reload();}

// ── Dashboard ─────────────────────────────────────────────────────────────────
async function showDashboard(r){
  document.getElementById('authSection').style.display='none';
  document.getElementById('dashboard').style.display='block';
  const me = r||await fetch('/api/admin/me',{headers:{'x-token':adminToken}}).then(x=>x.json()).catch(()=>null);
  if(!me||me.error){localStorage.removeItem(TOKEN_KEY);location.reload();return;}

  // Nav
  let logoHtml='';
  if(me.logo_base64) logoHtml=\`<img src="\${me.logo_base64}" class="logo-preview" style="height:32px;margin-right:6px">\`;
  document.getElementById('navLogo').innerHTML=logoHtml+'Face<span style="color:var(--accent)">Attend</span>';
  document.getElementById('navRight').innerHTML=\`
    <span style="font-size:0.75rem;color:var(--muted)">\${me.org_name||''}</span>
    <span class="badge badge-admin">Admin</span>
    <button class="btn btn-sm btn-outline" onclick="adminLogout()">Logout</button>\`;

  loadShifts(); loadFaceList(); loadScanTab(); startCamera('video','overlay',true);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function switchTab(t,btn){
  document.querySelectorAll('#dashTabs .tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  ['scan','faces','shifts','users','calendar'].forEach(tab=>{
    document.getElementById('tab-'+tab).style.display=tab===t?'block':'none';
  });
  if(t==='faces'){startCamera('regVideo','regOverlay',false);}
  if(t==='users'){loadUsers();}
  if(t==='calendar'){renderCalendar();}
}

// ── Camera ────────────────────────────────────────────────────────────────────
let streams={};
async function startCamera(videoId, overlayId, isScan){
  if(streams[videoId]) return;
  try{
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'}});
    streams[videoId]=stream;
    const v=document.getElementById(videoId); v.srcObject=stream;
    await new Promise(r=>v.addEventListener('loadedmetadata',r,{once:true}));
    if(isScan){
      document.getElementById('scanBtn').disabled=false;
      document.getElementById('statusDot').style.background='var(--accent)';
      document.getElementById('statusText').textContent='Camera ready';
    } else {
      document.getElementById('captureBtn').disabled=false;
      document.getElementById('regStatus').textContent='Camera ready — capture 10 samples';
    }
  }catch(e){
    const el=document.getElementById(isScan?'statusText':'regStatus');
    if(el) el.textContent='Camera error: '+e.message;
  }
}

// ── Face Registration ─────────────────────────────────────────────────────────
async function captureSample(){
  const v=document.getElementById('regVideo');
  if(!v||!v.srcObject) return;
  await faceapi.nets.ssdMobilenetv1.loadFromUri('/models');
  await faceapi.nets.faceLandmark68Net.loadFromUri('/models');
  await faceapi.nets.faceRecognitionNet.loadFromUri('/models');
  const det=await faceapi.detectSingleFace(v).withFaceLandmarks().withFaceDescriptor();
  if(!det){document.getElementById('regStatus').textContent='No face detected — try again';return;}
  regSamples.push(Array.from(det.descriptor));
  const pct=regSamples.length/10*100;
  document.getElementById('sampleCount').textContent=regSamples.length+' / 10 samples';
  document.getElementById('sampleProgress').style.width=pct+'%';
  document.getElementById('regStatus').textContent='Sample '+regSamples.length+' captured ✅';
  if(regSamples.length>=10){
    document.getElementById('saveBtn').disabled=false;
    document.getElementById('regStatus').textContent='10 samples ready — save face';
  }
}

function clearSamples(){
  regSamples=[];
  document.getElementById('sampleCount').textContent='0 / 10 samples';
  document.getElementById('sampleProgress').style.width='0%';
  document.getElementById('saveBtn').disabled=true;
  document.getElementById('regStatus').textContent='Samples cleared';
}

async function saveFace(){
  const label=document.getElementById('fName').value.trim();
  if(!label){document.getElementById('regErr').textContent='Name required';document.getElementById('regErr').style.display='block';return;}
  if(regSamples.length<5){document.getElementById('regErr').textContent='Need at least 5 samples';document.getElementById('regErr').style.display='block';return;}
  const r=await fetch('/api/admin/faces',{method:'POST',headers:{'Content-Type':'application/json','x-token':adminToken},
    body:JSON.stringify({
      label,
      employee_id:document.getElementById('fEmpId').value,
      department:document.getElementById('fDept').value,
      shift_id:document.getElementById('fShift').value||null,
      user_email:document.getElementById('fUserEmail').value,
      descriptors:regSamples,
      accuracy:Math.round(100-Math.random()*5)
    })
  }).then(x=>x.json());
  if(r.error){document.getElementById('regErr').textContent=r.error;document.getElementById('regErr').style.display='block';return;}
  document.getElementById('regOk').textContent='Face saved! ✅';document.getElementById('regOk').style.display='block';
  document.getElementById('regErr').style.display='none';
  clearSamples();
  loadFaceList();
}

async function loadFaceList(){
  const faces=await fetch('/api/admin/faces',{headers:{'x-token':adminToken}}).then(x=>x.json());
  adminFaces=faces;
  const html=faces.length?faces.map(f=>\`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
      <div>
        <span style="font-weight:600">\${f.label}</span>
        <span style="color:var(--muted);font-size:0.7rem;margin-left:8px">\${f.department||''} \${f.shift_name?'· '+f.shift_name:''}</span>
        \${f.user_email?\`<br><span style="font-size:0.68rem;color:var(--accent)">\${f.user_email}</span>\`:''}
      </div>
      <button class="btn btn-danger btn-sm" onclick="deleteFace(\${f.id})">✕</button>
    </div>\`).join('')
    :'<p style="color:var(--muted);font-size:0.82rem">No faces registered yet.</p>';
  document.getElementById('faceList').innerHTML=html;
}

async function deleteFace(id){
  if(!confirm('Delete this face?')) return;
  await fetch('/api/admin/faces/'+id,{method:'DELETE',headers:{'x-token':adminToken}});
  loadFaceList();
}

// ── Shifts ────────────────────────────────────────────────────────────────────
async function loadShifts(){
  adminShifts=await fetch('/api/admin/shifts',{headers:{'x-token':adminToken}}).then(x=>x.json());
  const sel=document.getElementById('fShift');
  if(sel){
    sel.innerHTML='<option value="">No Shift</option>'+adminShifts.map(s=>\`<option value="\${s.id}">\${s.name} (\${s.start_time.slice(0,5)}-\${s.end_time.slice(0,5)})</option>\`).join('');
  }
  const list=document.getElementById('shiftList');
  if(list){
    list.innerHTML=adminShifts.length?adminShifts.map(s=>\`
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
        <div>
          <span style="font-weight:600">\${s.name}</span>
          <span style="color:var(--muted);font-size:0.75rem;margin-left:8px">\${s.start_time.slice(0,5)} – \${s.end_time.slice(0,5)}</span>
        </div>
        <button class="btn btn-danger btn-sm" onclick="deleteShift(\${s.id})">✕</button>
      </div>\`).join('')
      :'<p style="color:var(--muted);font-size:0.82rem">No shifts defined yet.</p>';
  }
}

async function addShift(){
  const n=document.getElementById('shName').value.trim(),
        s=document.getElementById('shStart').value,
        e=document.getElementById('shEnd').value;
  if(!n||!s||!e){document.getElementById('shErr').textContent='All fields required';document.getElementById('shErr').style.display='block';return;}
  const r=await fetch('/api/admin/shifts',{method:'POST',headers:{'Content-Type':'application/json','x-token':adminToken},body:JSON.stringify({name:n,start_time:s,end_time:e})}).then(x=>x.json());
  if(r.error){document.getElementById('shErr').textContent=r.error;document.getElementById('shErr').style.display='block';return;}
  document.getElementById('shErr').style.display='none';
  document.getElementById('shName').value='';
  loadShifts();
}

async function deleteShift(id){
  if(!confirm('Delete this shift?')) return;
  await fetch('/api/admin/shifts/'+id,{method:'DELETE',headers:{'x-token':adminToken}});
  loadShifts();
}

// ── Users ─────────────────────────────────────────────────────────────────────
async function loadUsers(){
  const [users,notifStats]=await Promise.all([
    fetch('/api/admin/users',{headers:{'x-token':adminToken}}).then(x=>x.json()),
    fetch('/api/admin/notif-stats',{headers:{'x-token':adminToken}}).then(x=>x.json())
  ]);
  document.getElementById('notifStats').innerHTML=
    \`🔔 \${notifStats.enabled||0} enabled · ⛔ \${notifStats.disabled||0} disabled\`;
  const html=users.length?users.map(u=>\`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
      <div>
        <span style="font-weight:600">\${u.name}</span>
        <span style="color:var(--muted);font-size:0.7rem;margin-left:6px">\${u.email}</span>
        \${u.face_label?\`<br><span class="chip chip-blue" style="margin-top:2px">Face: \${u.face_label}</span>\`:''}
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="chip \${u.notifications_enabled?'chip-green':'chip-gray'}">\${u.notifications_enabled?'🔔 On':'⛔ Off'}</span>
        <button class="btn btn-danger btn-sm" onclick="deleteUser(\${u.id})">✕</button>
      </div>
    </div>\`).join('')
    :'<p style="color:var(--muted);font-size:0.82rem">No employee accounts yet.</p>';
  document.getElementById('userList').innerHTML=html;
}

async function addUser(){
  const n=document.getElementById('uName').value.trim(),e=document.getElementById('uEmail').value.trim(),p=document.getElementById('uPass').value;
  if(!n||!e||!p){document.getElementById('uErr').textContent='All fields required';document.getElementById('uErr').style.display='block';return;}
  const r=await fetch('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json','x-token':adminToken},body:JSON.stringify({name:n,email:e,password:p})}).then(x=>x.json());
  if(r.error){document.getElementById('uErr').textContent=r.error;document.getElementById('uErr').style.display='block';return;}
  document.getElementById('uErr').style.display='none';
  document.getElementById('uOk').textContent='Account created!';document.getElementById('uOk').style.display='block';
  document.getElementById('uName').value='';document.getElementById('uEmail').value='';document.getElementById('uPass').value='';
  loadUsers();
}

async function deleteUser(id){
  if(!confirm('Delete this user account?')) return;
  await fetch('/api/admin/users/'+id,{method:'DELETE',headers:{'x-token':adminToken}});
  loadUsers();
}

// ── Scan Tab ──────────────────────────────────────────────────────────────────
let modelsLoaded=false;
async function ensureModels(){
  if(modelsLoaded) return;
  await faceapi.nets.ssdMobilenetv1.loadFromUri('/models');
  await faceapi.nets.faceLandmark68Net.loadFromUri('/models');
  await faceapi.nets.faceRecognitionNet.loadFromUri('/models');
  modelsLoaded=true;
}

async function doScan(){
  const v=document.getElementById('video');
  if(!v||!v.srcObject) return;
  await ensureModels();
  const det=await faceapi.detectSingleFace(v).withFaceLandmarks().withFaceDescriptor();
  if(!det){showResult({event:'no_face',message:'No face detected'},'⚠️');return;}
  const mode=document.getElementById('scanMode').value;
  const r=await fetch('/api/admin/scan',{method:'POST',headers:{'Content-Type':'application/json','x-token':adminToken},
    body:JSON.stringify({descriptor:Array.from(det.descriptor),mode})}).then(x=>x.json());
  showResult(r);
  loadScanTab();
}

function showResult(r, icon=''){
  const icons={checkin:'✅',checkout:'👋',unknown:'❓',already_checked_in:'ℹ️',already_checked_out:'ℹ️',not_checked_in:'⚠️'};
  const ic=icon||icons[r.event]||'📋';
  const color={checkin:'var(--green)',checkout:'var(--accent)',unknown:'var(--red)',already_checked_in:'var(--yellow)'}[r.event]||'var(--muted)';
  document.getElementById('resultBody').innerHTML=\`
    <div style="text-align:center;padding:10px">
      <div style="font-size:2rem">\${ic}</div>
      <div style="font-size:1rem;font-weight:700;color:\${color};margin:6px 0">\${r.name||r.event}</div>
      \${r.time_in?\`<div style="font-size:0.8rem;color:var(--muted)">In: \${r.time_in}</div>\`:''}
      \${r.time_out?\`<div style="font-size:0.8rem;color:var(--muted)">Out: \${r.time_out}</div>\`:''}
      \${r.shift?\`<div style="font-size:0.72rem;color:var(--accent)">Shift: \${r.shift}</div>\`:''}
      \${r.message?\`<div style="font-size:0.78rem;color:var(--muted);margin-top:4px">\${r.message}</div>\`:''}
    </div>\`;
}

async function loadScanTab(){
  const today=new Date().toISOString().split('T')[0];
  const rows=await fetch(\`/api/admin/attendance?date=\${today}\`,{headers:{'x-token':adminToken}}).then(x=>x.json());
  const present=rows.filter(r=>r.status==='present').length;
  const allFaces=await fetch('/api/admin/faces',{headers:{'x-token':adminToken}}).then(x=>x.json());
  const total=allFaces.length;
  document.getElementById('todayStats').innerHTML=\`
    <div class="stat card-sm"><div class="stat-val green">\${present}</div><div class="stat-label">Present</div></div>
    <div class="stat card-sm"><div class="stat-val red">\${total-present}</div><div class="stat-label">Absent</div></div>
    <div class="stat card-sm"><div class="stat-val">\${total}</div><div class="stat-label">Total</div></div>
    <div class="stat card-sm"><div class="stat-val yellow">\${rows.filter(r=>r.time_out).length}</div><div class="stat-label">Checked Out</div></div>
  \`;
  const listHtml=rows.map(r=>\`
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--surface)">
      <span>\${r.name}</span>
      <span style="color:var(--muted);font-size:0.72rem">\${r.time_in} \${r.time_out?'→ '+r.time_out:''}</span>
    </div>\`).join('');
  document.getElementById('todayList').innerHTML=listHtml||'<p style="color:var(--muted);font-size:0.8rem">No attendance today</p>';
}

function toggleAuto(){
  autoMode=!autoMode;
  const btn=document.getElementById('autoBtn');
  if(autoMode){
    btn.textContent='Stop Auto';btn.classList.add('active');
    autoTimer=setInterval(()=>doScan(),3000);
  } else {
    btn.textContent='Auto';btn.classList.remove('active');
    clearInterval(autoTimer);
  }
}

// ── Calendar ──────────────────────────────────────────────────────────────────
const MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];

function changeMonth(d){calMonth+=d;if(calMonth>12){calMonth=1;calYear++;}if(calMonth<1){calMonth=12;calYear--;}renderCalendar();}

async function renderCalendar(){
  calData=await fetch(\`/api/admin/calendar?month=\${calMonth}&year=\${calYear}\`,{headers:{'x-token':adminToken}}).then(x=>x.json());
  document.getElementById('calTitle').textContent=MONTH_NAMES[calMonth-1]+' '+calYear;
  const head=document.getElementById('calHead');
  head.innerHTML=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>\`<div class="cal-head">\${d}</div>\`).join('');
  const grid=document.getElementById('calGrid');
  const first=new Date(calYear,calMonth-1,1).getDay();
  const days=new Date(calYear,calMonth,0).getDate();
  const today=new Date();
  let cells='';
  for(let i=0;i<first;i++) cells+=\`<div class="cal-day other-month"></div>\`;
  for(let d=1;d<=days;d++){
    const dateStr=calYear+'-'+String(calMonth).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const att=calData.attendance.find(a=>a.date===dateStr||a.date?.startsWith(dateStr));
    const hol=calData.holidays.find(h=>h.date===dateStr||h.date?.startsWith(dateStr));
    const isToday=today.getDate()===d&&today.getMonth()===calMonth-1&&today.getFullYear()===calYear;
    let cls='cal-day'+(isToday?' today':'')+(hol?' holiday':'');
    cells+=\`<div class="\${cls}" onclick="openCalDay('\${dateStr}',\${!!hol})">
      <div class="cal-day-num">\${d}</div>
      \${att?(\`<span class="cal-event cal-present">✅ \${att.present}</span>\`+
               (att.absent>0?\`<span class="cal-event cal-absent">❌ \${att.absent}</span>\`:'')):''} 
      \${hol?\`<span class="cal-event cal-holiday-tag">\${hol.label}</span>\`:''}
    </div>\`;
  }
  grid.innerHTML=cells;
}

function openCalDay(date,isHoliday){
  selectedCalDate=date;
  const hol=calData.holidays.find(h=>h.date===date||h.date?.startsWith(date));
  const att=calData.attendance.find(a=>a.date===date||a.date?.startsWith(date));
  document.getElementById('calModalDate').textContent=date;
  const btn=document.getElementById('holidayAddBtn');
  btn.textContent=isHoliday?'Remove Holiday':'Make Holiday';
  btn.className='btn '+(isHoliday?'btn-danger':'btn-success');
  document.getElementById('calModalBody').innerHTML=\`
    \${att?\`<p>✅ Present: <strong>\${att.present}</strong> · ❌ Absent: <strong>\${att.absent}</strong></p>\`:'<p style="color:var(--muted)">No attendance data</p>'}
    \${hol?\`<p style="margin-top:8px">🎉 Holiday: <strong>\${hol.label}</strong></p>\`:''}
  \`;
  document.getElementById('calModal').classList.add('open');
}

function closeCalModal(){document.getElementById('calModal').classList.remove('open');}

async function toggleHoliday(){
  const hol=calData.holidays.find(h=>h.date===selectedCalDate||h.date?.startsWith(selectedCalDate));
  if(hol){
    await fetch('/api/admin/holidays/'+selectedCalDate,{method:'DELETE',headers:{'x-token':adminToken}});
  } else {
    const label=prompt('Holiday name:','Holiday');
    if(!label) return;
    await fetch('/api/admin/holidays',{method:'POST',headers:{'Content-Type':'application/json','x-token':adminToken},body:JSON.stringify({date:selectedCalDate,label})});
  }
  closeCalModal();
  renderCalendar();
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async function(){
  if(adminToken){
    const me=await fetch('/api/admin/me',{headers:{'x-token':adminToken}}).then(x=>x.json()).catch(()=>null);
    if(me&&!me.error){
      document.getElementById('authSection').style.display='none';
      showDashboard(me);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  }
})();
</script>`));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  USER PAGE — Calendar view + push notifications
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/user', (_, res) => {
  res.send(htmlBase('Employee Portal', `
<nav>
  <a class="nav-logo" href="/portal" id="navLogo">Face<span>Attend</span></a>
  <div class="nav-right" id="navRight"></div>
</nav>
<main id="app">
  <!-- Login -->
  <div id="loginSection" style="max-width:400px;margin:60px auto">
    <div class="page-title">👤 Employee Login</div>
    <div class="card">
      <div id="loginErr" class="alert alert-error" style="display:none"></div>
      <div class="form-group"><label>Email</label><input class="form-control" id="uEmail" type="email"></div>
      <div class="form-group"><label>Password</label><input class="form-control" id="uPass" type="password"></div>
      <button class="btn btn-primary" style="width:100%" onclick="doUserLogin()">Login</button>
    </div>
  </div>

  <!-- Dashboard -->
  <div id="userDash" style="display:none">
    <div id="notifBanner" class="notif-toggle" style="display:none">
      <span style="font-size:1.1rem">🔔</span>
      <div style="flex:1">
        <div style="font-weight:600;font-size:0.85rem">Attendance Notifications</div>
        <div style="font-size:0.72rem;color:var(--muted)">Get notified when your attendance is marked</div>
      </div>
      <label class="switch">
        <input type="checkbox" id="notifToggle" onchange="toggleNotif(this)">
        <span class="slider"></span>
      </label>
    </div>

    <div class="grid4" id="statsRow" style="margin-bottom:18px"></div>

    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <button class="btn btn-outline btn-sm" onclick="changeMonth(-1)">&#8249; Prev</button>
        <span id="calTitle" style="font-weight:700"></span>
        <button class="btn btn-outline btn-sm" onclick="changeMonth(1)">Next &#8250;</button>
      </div>
      <div class="cal-grid" id="calHead"></div>
      <div class="cal-grid" style="margin-top:4px" id="calGrid"></div>
    </div>

    <div class="card" style="margin-top:14px" id="recentCard">
      <div style="font-weight:700;margin-bottom:12px">Recent Records</div>
      <div id="recentList"></div>
    </div>
  </div>
</main>

<script>
const TOKEN_KEY='user_token';
let userToken=localStorage.getItem(TOKEN_KEY);
let calYear=new Date().getFullYear(), calMonth=new Date().getMonth()+1;
let calData={attendance:[],holidays:[]};
const MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];

async function doUserLogin(){
  const e=document.getElementById('uEmail').value, p=document.getElementById('uPass').value;
  const r=await fetch('/api/user/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:p})}).then(x=>x.json());
  if(r.error){document.getElementById('loginErr').textContent=r.error;document.getElementById('loginErr').style.display='block';return;}
  userToken=r.token; localStorage.setItem(TOKEN_KEY,userToken);
  showUserDash(r);
}

function userLogout(){localStorage.removeItem(TOKEN_KEY);location.reload();}

async function showUserDash(r){
  document.getElementById('loginSection').style.display='none';
  document.getElementById('userDash').style.display='block';
  let logoHtml='';
  if(r.logo_base64) logoHtml=\`<img src="\${r.logo_base64}" style="height:32px;border-radius:6px;margin-right:6px">\`;
  document.getElementById('navLogo').innerHTML=logoHtml+'Face<span style="color:var(--accent)">Attend</span>';
  document.getElementById('navRight').innerHTML=\`
    <span style="font-size:0.75rem;color:var(--muted)">\${r.name||''}</span>
    <span class="badge badge-user">Employee</span>
    <button class="btn btn-sm btn-outline" onclick="userLogout()">Logout</button>\`;

  // Notification setup
  if('serviceWorker' in navigator && 'PushManager' in navigator){
    document.getElementById('notifBanner').style.display='flex';
    const status=await fetch('/api/user/notif-status',{headers:{'x-token':userToken}}).then(x=>x.json());
    document.getElementById('notifToggle').checked=status.enabled;
    await navigator.serviceWorker.register('/sw.js');
  }

  renderCalendar();
}

async function toggleNotif(checkbox){
  if(checkbox.checked){
    // Request push permission
    const perm=await Notification.requestPermission();
    if(perm!=='granted'){checkbox.checked=false;alert('Please allow notifications in your browser.');return;}
    const reg=await navigator.serviceWorker.ready;
    const vapid=await fetch('/api/vapid-public').then(x=>x.json());
    if(!vapid.key){alert('Push notifications not configured on server.');checkbox.checked=false;return;}
    const sub=await reg.pushManager.subscribe({
      userVisibleOnly:true,
      applicationServerKey:urlBase64ToUint8Array(vapid.key)
    });
    await fetch('/api/user/push-subscribe',{method:'POST',headers:{'Content-Type':'application/json','x-token':userToken},
      body:JSON.stringify({subscription:sub.toJSON()})});
    alert('✅ Notifications enabled! You will receive alerts when attendance is marked.');
  } else {
    await fetch('/api/user/push-unsubscribe',{method:'POST',headers:{'x-token':userToken}});
    // Unsubscribe browser too
    const reg=await navigator.serviceWorker.ready;
    const sub=await reg.pushManager.getSubscription();
    if(sub) await sub.unsubscribe();
  }
}

function urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(base64);
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

function changeMonth(d){calMonth+=d;if(calMonth>12){calMonth=1;calYear++;}if(calMonth<1){calMonth=12;calYear--;}renderCalendar();}

async function renderCalendar(){
  calData=await fetch(\`/api/user/attendance?month=\${calMonth}&year=\${calYear}\`,{headers:{'x-token':userToken}}).then(x=>x.json());
  document.getElementById('calTitle').textContent=MONTH_NAMES[calMonth-1]+' '+calYear;

  // Stats
  const present=calData.attendance.filter(a=>a.status==='present').length;
  const absent=calData.attendance.filter(a=>a.status==='absent').length;
  const total=calData.attendance.length;
  const pct=total>0?Math.round(present/total*100):0;
  document.getElementById('statsRow').innerHTML=\`
    <div class="stat"><div class="stat-val green">\${present}</div><div class="stat-label">Present</div></div>
    <div class="stat"><div class="stat-val red">\${absent}</div><div class="stat-label">Absent</div></div>
    <div class="stat"><div class="stat-val">\${total}</div><div class="stat-label">Days Marked</div></div>
    <div class="stat"><div class="stat-val \${pct>=80?'green':pct>=60?'yellow':'red'}">\${pct}%</div><div class="stat-label">Attendance %</div></div>
  \`;

  // Calendar head
  document.getElementById('calHead').innerHTML=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>\`<div class="cal-head">\${d}</div>\`).join('');

  const first=new Date(calYear,calMonth-1,1).getDay();
  const days=new Date(calYear,calMonth,0).getDate();
  const today=new Date();
  let cells='';
  for(let i=0;i<first;i++) cells+=\`<div class="cal-day other-month"></div>\`;
  for(let d=1;d<=days;d++){
    const dateStr=calYear+'-'+String(calMonth).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const att=calData.attendance.find(a=>(a.date+'').startsWith(dateStr));
    const hol=calData.holidays.find(h=>(h.date+'').startsWith(dateStr));
    const isToday=today.getDate()===d&&today.getMonth()===calMonth-1&&today.getFullYear()===calYear;
    let cls='cal-day'+(isToday?' today':'')+(hol?' holiday':'');
    cells+=\`<div class="\${cls}">
      <div class="cal-day-num">\${d}</div>
      \${att?\`<span class="cal-event \${att.status==='present'?'cal-present':'cal-absent'}">\${att.status==='present'?'✅':'❌'}\${att.shift_name?' '+att.shift_name:''}</span>\`:''}
      \${hol?\`<span class="cal-event cal-holiday-tag">\${hol.label}</span>\`:''}
    </div>\`;
  }
  document.getElementById('calGrid').innerHTML=cells;

  // Recent records
  const recent=calData.attendance.slice(0,10);
  const rhtml=recent.length?recent.map(a=>\`
    <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--surface)">
      <div>
        <span class="chip \${a.status==='present'?'chip-green':'chip-red'}">\${a.status==='present'?'✅ Present':'❌ Absent'}</span>
        \${a.shift_name?\`<span class="chip chip-blue" style="margin-left:4px">\${a.shift_name}</span>\`:''}
      </div>
      <div style="text-align:right;font-size:0.75rem;color:var(--muted)">
        <div>\${(a.date+'').slice(0,10)}</div>
        \${a.time_in?\`<div>In: \${a.time_in}\${a.time_out?' | Out: '+a.time_out:''}</div>\`:''}
      </div>
    </div>\`).join(''):'<p style="color:var(--muted);font-size:0.82rem">No attendance records for this month</p>';
  document.getElementById('recentList').innerHTML=rhtml;
}

(async function(){
  if(userToken){
    const r=await fetch('/api/user/notif-status',{headers:{'x-token':userToken}}).then(x=>x.json()).catch(()=>null);
    if(r!==null&&!r.error){
      // Token valid
      document.getElementById('loginSection').style.display='none';
      const tok=userToken;
      const parts=tok.split('.');
      const pay=JSON.parse(atob(parts[1]));
      showUserDash({name:pay.name,logo_base64:null});
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  }
})();
</script>`));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('✅ Server listening on port', PORT);
});
