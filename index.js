/**
 * FaceAttend SaaS — Multi-tenant Face Recognition Attendance
 * Roles: super_admin | admin (tenant) | user (employee)
 *
 * v3.0 Changes:
 *  - Multi-shift per person (face_shifts junction table)
 *  - Hour-based shift duration display
 *  - Mobile-first responsive redesign across all pages
 *  - Admin: Export attendance (CSV)
 *  - Scan: Shows detected name label live, pending shift modal before marking
 *  - User: Push notification subscription modal fix (VAPID properly checked)
 *  - Admin People tab: edit support, cleaner layout
 *  - DB ALTER commands provided for existing installs
 *
 * DB ALTER (run once on existing DB):
 *   ALTER TABLE `attendance`
 *     DROP FOREIGN KEY attendance_ibfk_3,
 *     DROP COLUMN shift_id;
 *
 *   CREATE TABLE IF NOT EXISTS face_shifts (
 *     id INT AUTO_INCREMENT PRIMARY KEY,
 *     face_id INT NOT NULL,
 *     admin_id INT NOT NULL,
 *     shift_id INT NOT NULL,
 *     UNIQUE KEY uq_face_shift (face_id, shift_id),
 *     FOREIGN KEY (face_id) REFERENCES faces(id) ON DELETE CASCADE,
 *     FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE CASCADE,
 *     FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
 *   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
 *
 *   ALTER TABLE `attendance`
 *     ADD COLUMN shift_id INT DEFAULT NULL AFTER face_id,
 *     ADD CONSTRAINT attendance_ibfk_3 FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL;
 *
 *   ALTER TABLE `faces` DROP COLUMN IF EXISTS shift_id;
 *
 * Install: npm install express mysql2 bcryptjs jsonwebtoken web-push
 */

'use strict';

const express = require('express');
const mysql   = require('mysql2');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
let webpush;
try { webpush = require('web-push'); } catch(e) { webpush = null; }

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

const PUBLIC_DIR         = path.join(__dirname, 'public');
const MODELS_DIR         = path.join(PUBLIC_DIR, 'models');
const UNKNOWN_IMAGES_DIR = path.join(PUBLIC_DIR, 'unknown-images');
const FACEAPI_PATH       = path.join(PUBLIC_DIR, 'faceapi.js');

app.use('/models',         express.static(MODELS_DIR));
app.use('/faceapi.js',    (_, res) => res.sendFile(FACEAPI_PATH));
app.use('/unknown-images', express.static(UNKNOWN_IMAGES_DIR));

// ── DB ─────────────────────────────────────────────────────────────────
const DB_CONFIG = {
  host     : process.env.DB_HOST || '127.0.0.1',
  user     : process.env.DB_USER || 'u966260443_facedetect',
  password : process.env.DB_PASS || 'Makelabs@123',
  database : process.env.DB_NAME || 'u966260443_facedetect',
  multipleStatements: true
};
const db = mysql.createConnection(DB_CONFIG);

function dbQuery(sql, params = []) {
  return new Promise((res, rej) =>
    db.query(sql, params, (err, rows) => err ? rej(err) : res(rows))
  );
}

// ── JWT ────────────────────────────────────────────────────────────────
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

// ── VAPID ──────────────────────────────────────────────────────────────
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
    await webpush.sendNotification(sub, JSON.stringify({ title, body, icon: '/icon-192.png', badge: '/icon-192.png' }));
    await dbQuery('INSERT INTO push_log (admin_id,user_id,title,body) VALUES (?,?,?,?)', [adminId, userId, title, body]);
  } catch(e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      await dbQuery('UPDATE users SET push_subscription=NULL, notifications_enabled=0 WHERE id=?', [userId]);
    }
    console.warn('Push error:', e.message);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────
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
function shiftHours(start, end) {
  const [sh,sm] = start.split(':').map(Number);
  const [eh,em] = end.split(':').map(Number);
  let mins = (eh*60+em) - (sh*60+sm);
  if (mins < 0) mins += 24*60;
  const h = Math.floor(mins/60), m = mins%60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const THRESHOLD        = 0.5;
const REGISTER_SAMPLES = 10;

function euclidean(a, b) {
  let s = 0; for (let i=0;i<a.length;i++) s+=(a[i]-b[i])**2; return Math.sqrt(s);
}

// ── DB Init ────────────────────────────────────────────────────────────
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
      user_email VARCHAR(191) DEFAULT NULL,
      descriptor LONGTEXT NOT NULL,
      registration_accuracy TINYINT UNSIGNED DEFAULT NULL,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admin_label (admin_id, label),
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS face_shifts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      face_id INT NOT NULL,
      admin_id INT NOT NULL,
      shift_id INT NOT NULL,
      UNIQUE KEY uq_face_shift (face_id, shift_id),
      FOREIGN KEY (face_id) REFERENCES faces(id) ON DELETE CASCADE,
      FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE CASCADE,
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
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
      UNIQUE KEY uq_face_date_shift (face_id, date, shift_id),
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
    if (!e.message.includes('already exists')) console.warn('DB init warning:', e.message);
  }
}

// ── Model download ─────────────────────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════════════
//  SHARED CSS
// ═══════════════════════════════════════════════════════════════════════
const SHARED_CSS = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
:root{
  --bg:#f0f4f8;--surface:#e8edf3;--card:#ffffff;--border:#d1dbe8;
  --accent:#00adee;--red:#f87171;--yellow:#fbbf24;
  --green:#34d399;--purple:#a78bfa;--orange:#fb923c;
  --text:#1a2332;--muted:#64748b;--muted2:#cbd5e1;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:'Space Grotesk',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 40% at 50% -5%,rgba(0,173,238,0.07),transparent);pointer-events:none;z-index:0}

/* ── NAV ── */
nav{position:sticky;top:0;z-index:200;background:rgba(255,255,255,0.97);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 16px;height:56px;gap:8px}
.nav-logo{display:flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:0.85rem;font-weight:600;color:var(--text);text-decoration:none;flex-shrink:0}
.nav-logo span{color:var(--accent)}
.nav-logo img{height:32px;border-radius:6px;object-fit:contain}
.nav-right{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.badge{padding:2px 8px;border-radius:20px;font-size:0.6rem;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;white-space:nowrap}
.badge-sa{background:rgba(167,139,250,0.15);color:#7c3aed}
.badge-admin{background:rgba(0,173,238,0.12);color:var(--accent)}
.badge-user{background:rgba(52,211,153,0.15);color:#059669}

/* ── BUTTONS ── */
.btn{display:inline-flex;align-items:center;gap:5px;padding:8px 14px;border-radius:10px;font-family:'Space Grotesk',sans-serif;font-size:0.78rem;font-weight:600;cursor:pointer;border:none;text-decoration:none;transition:all 0.2s;white-space:nowrap}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{background:#009ed8;transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,173,238,0.35)}
.btn-primary:disabled{opacity:0.5;cursor:not-allowed;transform:none;box-shadow:none}
.btn-outline{background:#fff;border:1px solid var(--border);color:var(--text)}
.btn-outline:hover{border-color:var(--accent);color:var(--accent)}
.btn-danger{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);color:var(--red)}
.btn-danger:hover{background:rgba(248,113,113,0.2)}
.btn-success{background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.3);color:#059669}
.btn-success:hover{background:rgba(52,211,153,0.2)}
.btn-warn{background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);color:#92400e}
.btn-warn:hover{background:rgba(251,191,36,0.2)}
.btn-sm{padding:5px 10px;font-size:0.7rem}
.btn-xs{padding:3px 8px;font-size:0.65rem}
.btn-icon{padding:6px;border-radius:8px;width:32px;height:32px;justify-content:center}
.btn-full{width:100%;justify-content:center}

/* ── LAYOUT ── */
main{max-width:1100px;margin:0 auto;padding:16px;position:relative;z-index:1}
.page-title{font-family:'JetBrains Mono',monospace;font-size:0.6rem;color:var(--muted);letter-spacing:2px;text-transform:uppercase;margin-bottom:14px}

/* ── CARDS ── */
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:18px;box-shadow:0 1px 3px rgba(0,0,0,0.04)}
.card-sm{padding:12px}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:8px;flex-wrap:wrap}
.card-title{font-weight:700;font-size:0.9rem}

/* ── GRID ── */
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}

/* ── STATS ── */
.stat{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px;text-align:center}
.stat-val{font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:700;color:var(--accent);line-height:1}
.stat-val.green{color:#059669}.stat-val.red{color:var(--red)}.stat-val.yellow{color:#92400e}
.stat-label{font-size:0.58rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:4px}

/* ── FORMS ── */
.form-group{margin-bottom:12px}
.form-group label{display:block;font-size:0.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:5px;font-weight:600}
.form-control{width:100%;background:#f8fafc;border:1px solid var(--border);border-radius:9px;padding:9px 12px;color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:0.83rem;outline:none;transition:border-color 0.2s,box-shadow 0.2s}
.form-control:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(0,173,238,0.1);background:#fff}
select.form-control{cursor:pointer}
textarea.form-control{resize:vertical;min-height:80px}

/* Multi-select shifts */
.shift-checkboxes{display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto;padding:4px 0}
.shift-checkbox-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer;transition:all 0.15s;background:#f8fafc}
.shift-checkbox-item:hover{border-color:var(--accent);background:rgba(0,173,238,0.04)}
.shift-checkbox-item input[type=checkbox]{accent-color:var(--accent);width:15px;height:15px;cursor:pointer}
.shift-checkbox-item.checked{border-color:var(--accent);background:rgba(0,173,238,0.06)}
.shift-checkbox-label{flex:1;font-size:0.8rem;font-weight:500}
.shift-checkbox-meta{font-size:0.65rem;color:var(--muted)}

/* ── ALERTS ── */
.alert{padding:10px 12px;border-radius:10px;font-size:0.8rem;margin-bottom:12px;line-height:1.4}
.alert-error{background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.25);color:#dc2626}
.alert-success{background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.25);color:#059669}
.alert-warn{background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);color:#92400e}
.alert-info{background:rgba(0,173,238,0.06);border:1px solid rgba(0,173,238,0.18);color:#0369a1}

/* ── TABLE ── */
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:12px;border:1px solid var(--border)}
table{width:100%;border-collapse:collapse;font-size:0.8rem;min-width:500px}
th{font-size:0.6rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.8px;padding:10px 12px;text-align:left;border-bottom:1px solid var(--border);background:#f8fafc;white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid #f0f4f8;color:var(--text);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#f8fafc}

/* ── CHIPS ── */
.chip{display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border-radius:20px;font-size:0.62rem;font-weight:600;white-space:nowrap}
.chip-green{background:rgba(52,211,153,0.12);color:#059669}
.chip-red{background:rgba(248,113,113,0.12);color:#dc2626}
.chip-yellow{background:rgba(251,191,36,0.12);color:#92400e}
.chip-blue{background:rgba(0,173,238,0.1);color:var(--accent)}
.chip-gray{background:rgba(107,114,128,0.1);color:var(--muted)}
.chip-purple{background:rgba(167,139,250,0.12);color:#7c3aed}

/* ── MODAL ── */
.modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,0.5);z-index:800;display:none;align-items:flex-end;justify-content:center;padding:0;backdrop-filter:blur(4px)}
.modal-backdrop.open{display:flex}
.modal{background:var(--card);border:1px solid var(--border);border-radius:20px 20px 0 0;padding:20px;width:100%;max-width:520px;box-shadow:0 -8px 40px rgba(0,0,0,0.15);max-height:90vh;overflow-y:auto}
@media(min-width:640px){
  .modal-backdrop{align-items:center;padding:16px}
  .modal{border-radius:20px;max-height:85vh}
}
.modal-handle{width:40px;height:4px;border-radius:2px;background:var(--border);margin:0 auto 16px}
.modal-title{font-weight:700;font-size:0.95rem;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between}
.modal-close{background:none;border:none;cursor:pointer;color:var(--muted);font-size:1.2rem;line-height:1;padding:4px}
.modal-close:hover{color:var(--red)}

/* ── TABS ── */
.tabs{display:flex;gap:3px;background:var(--surface);border-radius:12px;padding:4px;margin-bottom:16px;overflow-x:auto;-webkit-overflow-scrolling:touch}
.tab{flex-shrink:0;text-align:center;padding:8px 12px;border-radius:9px;font-size:0.75rem;font-weight:600;cursor:pointer;border:none;background:transparent;color:var(--muted);transition:all 0.2s;white-space:nowrap}
.tab.active{background:var(--card);color:var(--accent);box-shadow:0 1px 4px rgba(0,0,0,0.08)}

/* ── CALENDAR ── */
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
.cal-head{font-size:0.58rem;color:var(--muted);text-align:center;padding:4px 2px;font-weight:600}
.cal-day{min-height:52px;border:1px solid var(--border);border-radius:8px;padding:4px;font-size:0.65rem;cursor:pointer;transition:border-color 0.2s;position:relative;display:flex;flex-direction:column;background:#fff}
.cal-day:hover{border-color:var(--accent)}
.cal-day.today{border-color:var(--accent);background:rgba(0,173,238,0.04)}
.cal-day.holiday{background:rgba(251,191,36,0.07);border-color:var(--yellow)}
.cal-day.other-month{opacity:0.3;pointer-events:none}
.cal-day-num{font-family:'JetBrains Mono',monospace;font-size:0.7rem;font-weight:600}
.cal-day.today .cal-day-num{color:var(--accent)}
.cal-day.holiday .cal-day-num{color:#92400e}
.cal-event{font-size:0.55rem;border-radius:3px;padding:1px 3px;margin-top:2px;font-weight:600;display:block;line-height:1.3}
.cal-present{background:rgba(52,211,153,0.2);color:#059669}
.cal-absent{background:rgba(248,113,113,0.2);color:#dc2626}
.cal-holiday-tag{background:rgba(251,191,36,0.25);color:#92400e}

/* ── CAMERA ── */
.cam-card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.cam-wrap{position:relative;background:#1a2332;aspect-ratio:4/3}
.cam-wrap video,.cam-wrap canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.scan-line{position:absolute;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--accent),transparent);animation:scan 3s ease-in-out infinite;opacity:0.5;pointer-events:none;z-index:5}
@keyframes scan{0%{top:0}50%{top:calc(100% - 2px)}100%{top:0}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
.cam-controls{padding:10px 12px;background:#f8fafc;display:flex;gap:6px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--border)}
.live-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);animation:livepulse 2s infinite;flex-shrink:0}
@keyframes livepulse{0%,100%{opacity:1}50%{opacity:0.3}}

/* Detected name overlay */
.detected-label{position:absolute;bottom:8px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.72);color:#fff;padding:5px 14px;border-radius:20px;font-size:0.78rem;font-weight:600;white-space:nowrap;z-index:10;backdrop-filter:blur(4px);transition:opacity 0.3s}
.detected-label.green{background:rgba(5,150,105,0.85)}
.detected-label.red{background:rgba(220,38,38,0.85)}
.detected-label.yellow{background:rgba(146,64,14,0.85)}

/* ── RESULT CARD ── */
.result-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:16px}
.result-title{font-family:'JetBrains Mono',monospace;font-size:0.58rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:10px}

/* ── SWITCH ── */
.switch{position:relative;display:inline-block;width:40px;height:22px;flex-shrink:0}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;cursor:pointer;inset:0;background:#cbd5e1;border-radius:22px;transition:0.3s}
.slider:before{content:'';position:absolute;width:16px;height:16px;left:3px;bottom:3px;background:white;border-radius:50%;transition:0.3s;box-shadow:0 1px 3px rgba(0,0,0,0.2)}
input:checked+.slider{background:var(--accent)}
input:checked+.slider:before{transform:translateX(18px)}

/* ── LOGO PREVIEW ── */
.logo-preview{max-height:50px;max-width:130px;border-radius:6px;object-fit:contain;border:1px solid var(--border)}

/* ── PERSON CARD (people list) ── */
.person-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px;display:flex;align-items:flex-start;gap:10px;transition:border-color 0.2s}
.person-card:hover{border-color:var(--accent)}
.person-avatar{width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,rgba(0,173,238,0.15),rgba(0,173,238,0.05));display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0;border:1px solid rgba(0,173,238,0.15)}
.person-info{flex:1;min-width:0}
.person-name{font-weight:700;font-size:0.85rem;margin-bottom:2px}
.person-meta{font-size:0.7rem;color:var(--muted)}
.person-shifts{display:flex;gap:3px;flex-wrap:wrap;margin-top:4px}
.person-actions{display:flex;gap:4px;flex-shrink:0}

/* ── EXPORT BAR ── */
.export-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 0;margin-bottom:12px;border-bottom:1px solid var(--border)}

/* ── PROGRESS BAR ── */
.progress-bar{height:6px;background:var(--border);border-radius:4px;overflow:hidden}
.progress-fill{height:100%;background:var(--accent);border-radius:4px;transition:width 0.3s}

/* ── EMPTY STATE ── */
.empty-state{text-align:center;padding:32px 16px;color:var(--muted)}
.empty-state .empty-icon{font-size:2.5rem;margin-bottom:10px}
.empty-state p{font-size:0.82rem}

/* ── TOAST ── */
.toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1a2332;color:white;padding:12px 20px;border-radius:12px;font-size:0.8rem;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.25);transition:opacity 0.4s;white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis}

/* ── MOBILE BOTTOM NAV ── */
.mobile-nav{display:none;position:fixed;bottom:0;left:0;right:0;z-index:150;background:rgba(255,255,255,0.97);backdrop-filter:blur(20px);border-top:1px solid var(--border);padding:6px 0 8px}
.mobile-nav-items{display:flex;justify-content:space-around}
.mobile-nav-item{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 12px;border:none;background:none;cursor:pointer;color:var(--muted);font-family:'Space Grotesk',sans-serif;font-size:0.55rem;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;border-radius:8px;transition:color 0.2s;min-width:56px}
.mobile-nav-item .nav-icon{font-size:1.2rem;line-height:1}
.mobile-nav-item.active{color:var(--accent)}
.has-mobile-nav main{padding-bottom:72px}

/* ── RESPONSIVE ── */
@media(max-width:768px){
  .grid2,.grid3,.grid4{grid-template-columns:1fr}
  .grid4.stats-grid{grid-template-columns:1fr 1fr}
  #statsRow{grid-template-columns:1fr 1fr!important}
  .mobile-nav{display:block}
  .has-mobile-nav main{padding-bottom:72px}
  .desktop-tabs{display:none}
  main{padding:12px}
  .card{padding:14px;border-radius:14px}
  nav{padding:0 12px;height:52px}
  .cam-wrap{aspect-ratio:3/4}
  .cal-day{min-height:40px}
  .cal-event{display:none}
  .cal-day.today .cal-event,.cal-day.holiday .cal-event{display:block}
  .hide-mobile{display:none}
}
@media(min-width:769px){
  .mobile-nav{display:none!important}
  .show-mobile-only{display:none}
}
</style>`;

// ═══════════════════════════════════════════════════════════════════════
//  SUPER ADMIN APIs
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/super-admin/exists', async (_, res) => {
  const rows = await dbQuery('SELECT COUNT(*) AS c FROM super_admins').catch(() => [{ c:0 }]);
  res.json({ exists: rows[0].c > 0 });
});

app.post('/api/super-admin/setup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name||!email||!password) return res.json({ error: 'All fields required' });
  const rows = await dbQuery('SELECT COUNT(*) AS c FROM super_admins');
  if (rows[0].c > 0) return res.json({ error: 'Super admin already exists' });
  const hash = await bcrypt.hash(password, 12);
  await dbQuery('INSERT INTO super_admins (name,email,password) VALUES (?,?,?)', [name, email, hash]);
  res.json({ ok: true });
});

app.post('/api/super-admin/login', async (req, res) => {
  const { email, password } = req.body;
  const rows = await dbQuery('SELECT * FROM super_admins WHERE email=?', [email]);
  if (!rows.length) return res.json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, rows[0].password);
  if (!ok) return res.json({ error: 'Invalid credentials' });
  const token = signToken({ id: rows[0].id, role: 'super_admin', name: rows[0].name, email: rows[0].email });
  res.json({ token, name: rows[0].name });
});

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

app.post('/api/super-admin/admin/:id/status', authMiddleware('super_admin'), async (req, res) => {
  const { status } = req.body;
  if (!['approved','rejected','suspended','pending'].includes(status)) return res.json({ error: 'Invalid status' });
  await dbQuery(
    'UPDATE admins SET status=?, approved_by=?, approved_at=? WHERE id=?',
    [status, req.user.id, status==='approved'?new Date():null, req.params.id]
  );
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════
//  ADMIN APIs
// ═══════════════════════════════════════════════════════════════════════
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
  const token = signToken({ id: rows[0].id, role: 'admin', name: rows[0].name, email: rows[0].email, org_name: rows[0].org_name });
  res.json({ token, name: rows[0].name, org_name: rows[0].org_name });
});

app.get('/api/admin/me', authMiddleware('admin'), async (req, res) => {
  const rows = await dbQuery('SELECT id,name,email,org_name,org_type,attendance_title,logo_base64,status FROM admins WHERE id=?', [req.user.id]);
  res.json(rows[0]);
});

// ── Shifts ─────────────────────────────────────────────────────────────
app.get('/api/admin/shifts', authMiddleware('admin'), async (req, res) => {
  const rows = await dbQuery('SELECT * FROM shifts WHERE admin_id=? ORDER BY start_time', [req.user.id]);
  res.json(rows);
});
app.post('/api/admin/shifts', authMiddleware('admin'), async (req, res) => {
  const { name, start_time, end_time } = req.body;
  if (!name||!start_time||!end_time) return res.json({ error: 'All fields required' });
  const r = await dbQuery('INSERT INTO shifts (admin_id,name,start_time,end_time) VALUES (?,?,?,?)', [req.user.id, name, start_time, end_time]);
  res.json({ ok: true, id: r.insertId });
});
app.delete('/api/admin/shifts/:id', authMiddleware('admin'), async (req, res) => {
  await dbQuery('DELETE FROM shifts WHERE id=? AND admin_id=?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ── Faces (multi-shift) ────────────────────────────────────────────────
app.get('/api/admin/faces', authMiddleware('admin'), async (req, res) => {
  const faces = await dbQuery(
    `SELECT f.*, u.notifications_enabled, u.id as user_id
     FROM faces f
     LEFT JOIN users u ON u.face_id=f.id AND u.admin_id=f.admin_id
     WHERE f.admin_id=? ORDER BY f.label`,
    [req.user.id]
  );
  // Attach shifts per face
  for (const face of faces) {
    const shifts = await dbQuery(
      `SELECT s.id, s.name, s.start_time, s.end_time
       FROM face_shifts fs JOIN shifts s ON s.id=fs.shift_id
       WHERE fs.face_id=? AND fs.admin_id=?`,
      [face.id, req.user.id]
    );
    face.shifts = shifts;
    face.descriptor = JSON.parse(face.descriptor);
  }
  res.json(faces);
});

app.post('/api/admin/faces', authMiddleware('admin'), async (req, res) => {
  const { label, employee_id, department, shift_ids, user_email, user_password, descriptors, accuracy } = req.body;
  if (!label||!descriptors?.length) return res.json({ error: 'Label and descriptors required' });
  if (!user_email) return res.json({ error: 'Email is required' });
  if (!user_password || user_password.length < 6) return res.json({ error: 'Password must be at least 6 characters' });

  try {
    const r = await dbQuery(
      `INSERT INTO faces (admin_id,label,employee_id,department,user_email,descriptor,registration_accuracy)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         employee_id=VALUES(employee_id),department=VALUES(department),
         user_email=VALUES(user_email),descriptor=VALUES(descriptor),
         registration_accuracy=VALUES(registration_accuracy)`,
      [req.user.id, label, employee_id||'', department||'', user_email,
       JSON.stringify(descriptors), accuracy||null]
    );

    const faceId = r.insertId || (await dbQuery(
      'SELECT id FROM faces WHERE admin_id=? AND label=?', [req.user.id, label]
    ))[0]?.id;

    // Replace face_shifts
    await dbQuery('DELETE FROM face_shifts WHERE face_id=? AND admin_id=?', [faceId, req.user.id]);
    if (shift_ids && shift_ids.length) {
      for (const sid of shift_ids) {
        await dbQuery('INSERT IGNORE INTO face_shifts (face_id,admin_id,shift_id) VALUES (?,?,?)', [faceId, req.user.id, sid]);
      }
    }

    // Create or update user account
    const hash = await bcrypt.hash(user_password, 12);
    const existingUser = await dbQuery('SELECT id FROM users WHERE email=? AND admin_id=?', [user_email, req.user.id]);
    if (existingUser.length) {
      await dbQuery('UPDATE users SET face_id=?, name=?, password=? WHERE email=? AND admin_id=?',
        [faceId, label, hash, user_email, req.user.id]);
    } else {
      await dbQuery('INSERT INTO users (admin_id,face_id,name,email,password) VALUES (?,?,?,?,?)',
        [req.user.id, faceId, label, user_email, hash]);
    }

    res.json({ ok: true });
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return res.json({ error: 'A person with this name or email already exists' });
    res.json({ error: e.message });
  }
});

app.put('/api/admin/faces/:id', authMiddleware('admin'), async (req, res) => {
  const { employee_id, department, shift_ids } = req.body;
  try {
    await dbQuery('UPDATE faces SET employee_id=?, department=? WHERE id=? AND admin_id=?',
      [employee_id||'', department||'', req.params.id, req.user.id]);
    await dbQuery('DELETE FROM face_shifts WHERE face_id=? AND admin_id=?', [req.params.id, req.user.id]);
    if (shift_ids && shift_ids.length) {
      for (const sid of shift_ids) {
        await dbQuery('INSERT IGNORE INTO face_shifts (face_id,admin_id,shift_id) VALUES (?,?,?)',
          [req.params.id, req.user.id, sid]);
      }
    }
    res.json({ ok: true });
  } catch(e) { res.json({ error: e.message }); }
});

app.delete('/api/admin/faces/:id', authMiddleware('admin'), async (req, res) => {
  const face = await dbQuery('SELECT user_email FROM faces WHERE id=? AND admin_id=?', [req.params.id, req.user.id]);
  if (face.length && face[0].user_email) {
    await dbQuery('DELETE FROM users WHERE email=? AND admin_id=?', [face[0].user_email, req.user.id]);
  }
  await dbQuery('DELETE FROM faces WHERE id=? AND admin_id=?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ── Attendance (admin view + export) ──────────────────────────────────
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

// CSV export
app.get('/api/admin/attendance/export', authMiddleware('admin'), async (req, res) => {
  const { month, year, format } = req.query;
  let where = 'a.admin_id=?', params = [req.user.id];
  if (month && year) {
    where += ' AND MONTH(a.date)=? AND YEAR(a.date)=?';
    params.push(parseInt(month), parseInt(year));
  }
  const rows = await dbQuery(
    `SELECT a.name, a.date, a.time_in, a.time_out, a.status,
            s.name as shift_name, f.employee_id, f.department
     FROM attendance a
     LEFT JOIN shifts s ON s.id=a.shift_id
     LEFT JOIN faces f ON f.id=a.face_id
     WHERE ${where} ORDER BY a.date ASC, a.name ASC`,
    params
  );
  const headers = ['Name','Employee ID','Department','Date','Shift','Time In','Time Out','Status'];
  const csv = [
    headers.join(','),
    ...rows.map(r => [
      `"${r.name}"`, `"${r.employee_id||''}"`, `"${r.department||''}"`,
      r.date, `"${r.shift_name||'No Shift'}"`,
      r.time_in||'', r.time_out||'', r.status
    ].join(','))
  ].join('\n');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="attendance_${year||'all'}_${month||'all'}.csv"`);
  res.send(csv);
});

app.get('/api/admin/calendar', authMiddleware('admin'), async (req, res) => {
  const { month, year } = req.query;
  const m = parseInt(month), y = parseInt(year);
  const [attend, holidays] = await Promise.all([
    dbQuery(
      `SELECT date, SUM(status='present') AS present, SUM(status='absent') AS absent
       FROM attendance WHERE admin_id=? AND MONTH(date)=? AND YEAR(date)=? GROUP BY date`,
      [req.user.id, m, y]
    ),
    dbQuery('SELECT date, label FROM holidays WHERE admin_id=? AND MONTH(date)=? AND YEAR(date)=?',
      [req.user.id, m, y])
  ]);
  res.json({ attendance: attend, holidays });
});

// ── Holidays ───────────────────────────────────────────────────────────
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

// ── Scan (returns pending shifts for the person) ───────────────────────
// GET: detect face, return pending shifts without marking
app.post('/api/admin/detect', authMiddleware('admin'), async (req, res) => {
  const { descriptor: inDesc } = req.body;
  if (!inDesc?.length) return res.json({ event: 'error', message: 'No descriptor' });

  const adminId = req.user.id;
  const faces = await dbQuery('SELECT id,label,user_email,descriptor FROM faces WHERE admin_id=?', [adminId]);
  if (!faces.length) return res.json({ event: 'no_faces', message: 'No faces registered' });

  let best = null, bestDist = Infinity;
  for (const face of faces) {
    const stored = JSON.parse(face.descriptor);
    const dists = stored.map(d => euclidean(inDesc, d));
    const minDist = Math.min(...dists);
    if (minDist < bestDist) { bestDist = minDist; best = face; }
  }

  if (!best || bestDist > THRESHOLD) {
    return res.json({ event: 'unknown', message: 'Unknown face', distance: bestDist });
  }

  // Get shifts assigned to this face
  const shifts = await dbQuery(
    `SELECT s.* FROM face_shifts fs JOIN shifts s ON s.id=fs.shift_id
     WHERE fs.face_id=? AND fs.admin_id=?`,
    [best.id, adminId]
  );

  // Get today's already-marked shifts
  const today = new Date().toISOString().split('T')[0];
  const markedShifts = await dbQuery(
    'SELECT shift_id FROM attendance WHERE face_id=? AND date=?',
    [best.id, today]
  );
  const markedIds = markedShifts.map(m => m.shift_id);

  // Pending = assigned shifts not yet checked in today
  const pendingShifts = shifts.filter(s => !markedIds.includes(s.id));

  return res.json({
    event: 'recognized',
    name: best.label,
    face_id: best.id,
    distance: bestDist,
    shifts,
    pending_shifts: pendingShifts,
    marked_today: markedShifts.length,
    no_shift: shifts.length === 0
  });
});

// POST: refresh pending shifts for a known face_id (no descriptor needed)
app.post('/api/admin/detect-by-id', authMiddleware('admin'), async (req, res) => {
  const { face_id } = req.body;
  if (!face_id) return res.json({ event: 'error', message: 'face_id required' });
  const adminId = req.user.id;

  const faceRow = await dbQuery('SELECT id,label,user_email FROM faces WHERE id=? AND admin_id=?', [face_id, adminId]);
  if (!faceRow.length) return res.json({ event: 'error', message: 'Face not found' });
  const face = faceRow[0];

  const shifts = await dbQuery(
    `SELECT s.* FROM face_shifts fs JOIN shifts s ON s.id=fs.shift_id
     WHERE fs.face_id=? AND fs.admin_id=?`, [face_id, adminId]
  );
  const today = new Date().toISOString().split('T')[0];
  const markedShifts = await dbQuery(
    'SELECT shift_id FROM attendance WHERE face_id=? AND date=?', [face_id, today]
  );
  const markedIds = markedShifts.map(m => m.shift_id);
  const pendingShifts = shifts.filter(s => !markedIds.includes(s.id));

  return res.json({
    event: 'recognized', name: face.label, face_id: face.id,
    shifts, pending_shifts: pendingShifts,
    marked_today: markedShifts.length, no_shift: shifts.length === 0
  });
});


app.post('/api/admin/scan', authMiddleware('admin'), async (req, res) => {
  const { face_id, shift_id, mode } = req.body;
  if (!face_id) return res.json({ event: 'error', message: 'face_id required' });

  const adminId = req.user.id;
  const faceRow = await dbQuery('SELECT * FROM faces WHERE id=? AND admin_id=?', [face_id, adminId]);
  if (!faceRow.length) return res.json({ event: 'error', message: 'Face not found' });
  const face = faceRow[0];

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = pad2(now.getHours())+':'+pad2(now.getMinutes())+':'+pad2(now.getSeconds());
  const shiftRow = shift_id ? (await dbQuery('SELECT * FROM shifts WHERE id=?', [shift_id]))[0] : null;

  // MySQL NULL != NULL so we need IS NULL for no-shift persons
  const existing = shift_id
    ? await dbQuery('SELECT * FROM attendance WHERE face_id=? AND date=? AND shift_id=?', [face_id, dateStr, shift_id])
    : await dbQuery('SELECT * FROM attendance WHERE face_id=? AND date=? AND shift_id IS NULL', [face_id, dateStr]);

  if (mode === 'checkout') {
    if (!existing.length) return res.json({ event: 'not_checked_in', name: face.label });
    const rec = existing[0];
    if (rec.time_out) return res.json({ event: 'already_checked_out', name: face.label, time_out: rec.time_out });
    await dbQuery('UPDATE attendance SET time_out=? WHERE id=?', [timeStr, rec.id]);
    if (face.user_email) {
      const user = await dbQuery('SELECT id FROM users WHERE email=? AND admin_id=?', [face.user_email, adminId]);
      if (user.length) await sendPushToUser(user[0].id, '👋 Checked Out', `${face.label}, you checked out at ${fmtTime(timeStr)}`, adminId);
    }
    return res.json({ event: 'checkout', name: face.label, time_out: timeStr, shift: shiftRow?.name });
  }

  if (existing.length) {
    return res.json({ event: 'already_checked_in', name: face.label, time_in: existing[0].time_in, shift: shiftRow?.name });
  }

  const r = await dbQuery(
    'INSERT INTO attendance (admin_id,face_id,shift_id,name,date,time_in,status) VALUES (?,?,?,?,?,?,?)',
    [adminId, face_id, shift_id||null, face.label, dateStr, timeStr, 'present']
  );

  if (face.user_email) {
    const user = await dbQuery('SELECT id FROM users WHERE email=? AND admin_id=?', [face.user_email, adminId]);
    if (user.length) {
      const shiftInfo = shiftRow ? ` (${shiftRow.name})` : '';
      await sendPushToUser(user[0].id, '✅ Attendance Marked', `${face.label}, your attendance was recorded at ${fmtTime(timeStr)}${shiftInfo}`, adminId);
      await dbQuery('UPDATE attendance SET notification_sent=1 WHERE id=?', [r.insertId]);
    }
  }

  res.json({ event: 'checkin', name: face.label, time_in: timeStr, status: 'present', shift: shiftRow?.name, distance: 0 });
});

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

// ═══════════════════════════════════════════════════════════════════════
//  USER APIs
// ═══════════════════════════════════════════════════════════════════════
app.post('/api/user/login', async (req, res) => {
  const { email, password } = req.body;
  const rows = await dbQuery(`
    SELECT u.*, a.org_name, a.attendance_title, a.logo_base64, a.status as admin_status
    FROM users u JOIN admins a ON a.id=u.admin_id WHERE u.email=?`, [email]);
  if (!rows.length) return res.json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, rows[0].password);
  if (!ok) return res.json({ error: 'Invalid credentials' });
  if (rows[0].admin_status !== 'approved') return res.json({ error: 'Organisation not active' });
  const token = signToken({ id: rows[0].id, role: 'user', name: rows[0].name, email: rows[0].email, admin_id: rows[0].admin_id });
  res.json({
    token, name: rows[0].name,
    org_name: rows[0].org_name,
    attendance_title: rows[0].attendance_title,
    logo_base64: rows[0].logo_base64,
    notifications_enabled: rows[0].notifications_enabled
  });
});

app.post('/api/user/push-subscribe', authMiddleware('user'), async (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.json({ error: 'No subscription data' });
  await dbQuery(
    'UPDATE users SET push_subscription=?, notifications_enabled=1 WHERE id=? AND admin_id=?',
    [JSON.stringify(subscription), req.user.id, req.user.admin_id]
  );
  res.json({ ok: true });
});

app.post('/api/user/push-unsubscribe', authMiddleware('user'), async (req, res) => {
  await dbQuery(
    'UPDATE users SET push_subscription=NULL, notifications_enabled=0 WHERE id=? AND admin_id=?',
    [req.user.id, req.user.admin_id]
  );
  res.json({ ok: true });
});

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
       WHERE ${where} ORDER BY a.date DESC, a.time_in DESC`,
      params
    ),
    dbQuery(
      'SELECT date, label FROM holidays WHERE admin_id=? AND MONTH(date)=? AND YEAR(date)=?',
      [req.user.admin_id, parseInt(month)||new Date().getMonth()+1, parseInt(year)||new Date().getFullYear()]
    )
  ]);
  res.json({ attendance: attend, holidays });
});

app.get('/api/user/notif-status', authMiddleware('user'), async (req, res) => {
  const rows = await dbQuery('SELECT notifications_enabled FROM users WHERE id=?', [req.user.id]);
  res.json({ enabled: rows[0]?.notifications_enabled === 1 });
});

app.get('/api/user/profile', authMiddleware('user'), async (req, res) => {
  const rows = await dbQuery(
    `SELECT u.name, u.email, a.org_name, a.attendance_title, a.logo_base64
     FROM users u JOIN admins a ON a.id=u.admin_id
     WHERE u.id=? AND u.admin_id=?`,
    [req.user.id, req.user.admin_id]
  );
  if (!rows.length) return res.json({ error: 'Not found' });
  res.json(rows[0]);
});

app.get('/api/vapid-public', (_, res) => res.json({ key: VAPID.public, enabled: pushEnabled }));

// ── Service Worker & icon ──────────────────────────────────────────────
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

app.get('/icon-192.png', (_, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
    <rect width="192" height="192" rx="40" fill="#00adee"/>
    <text x="96" y="130" font-size="100" text-anchor="middle" font-family="Arial" fill="white">👁</text>
  </svg>`);
});

// ═══════════════════════════════════════════════════════════════════════
//  HTML helpers
// ═══════════════════════════════════════════════════════════════════════
function htmlBase(title, body) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#00adee">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>${escH(title)} — FaceAttend</title>
${SHARED_CSS}
</head><body>${body}</body></html>`;
}

app.get('/', (_, res) => res.redirect('/portal'));

// ═══════════════════════════════════════════════════════════════════════
//  PORTAL PAGE
// ═══════════════════════════════════════════════════════════════════════
app.get('/portal', (_, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#00adee">
<title>FaceAttend — Portal</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;700&display=swap">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--accent:#00adee;--text:#0f172a;--muted:#64748b;--card:#ffffff;--border:rgba(0,173,238,0.15)}
body{font-family:'DM Sans',sans-serif;background:#f0f9ff;color:var(--text);min-height:100vh;overflow-x:hidden}
.bg-mesh{position:fixed;inset:0;z-index:0;background:radial-gradient(ellipse 60% 40% at 20% 10%,rgba(0,173,238,0.12) 0%,transparent 60%),radial-gradient(ellipse 50% 60% at 80% 80%,rgba(0,173,238,0.08) 0%,transparent 60%);pointer-events:none}
.bg-grid{position:fixed;inset:0;z-index:0;background-image:linear-gradient(rgba(0,173,238,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(0,173,238,0.04) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;mask-image:radial-gradient(ellipse 80% 80% at 50% 50%,black 30%,transparent 100%)}
.top-bar{position:fixed;top:0;left:0;right:0;z-index:10;display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:56px;background:rgba(240,249,255,0.9);backdrop-filter:blur(16px);border-bottom:1px solid rgba(0,173,238,0.1)}
.top-brand{display:flex;align-items:center;gap:8px;font-family:'Syne',sans-serif;font-weight:800;font-size:1rem;color:var(--text);text-decoration:none}
.brand-icon{width:30px;height:30px;border-radius:8px;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:0.9rem;color:white;box-shadow:0 4px 12px rgba(0,173,238,0.3)}
.top-version{font-family:'JetBrains Mono',monospace;font-size:0.6rem;color:var(--accent);background:rgba(0,173,238,0.1);padding:3px 9px;border-radius:20px;letter-spacing:1px}
.portal-wrap{position:relative;z-index:1;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 16px 40px}
.hero{text-align:center;margin-bottom:40px;animation:fadeUp 0.7s ease both}
.hero-eyebrow{font-family:'JetBrains Mono',monospace;font-size:0.6rem;color:var(--accent);letter-spacing:3px;text-transform:uppercase;margin-bottom:14px;display:inline-flex;align-items:center;gap:8px}
.hero-eyebrow::before,.hero-eyebrow::after{content:'';display:block;width:20px;height:1px;background:var(--accent);opacity:0.5}
.hero-title{font-family:'Syne',sans-serif;font-weight:800;font-size:clamp(2rem,6vw,3.2rem);line-height:1.05;letter-spacing:-2px;color:var(--text);margin-bottom:14px}
.hero-title .hl{color:var(--accent)}
.hero-sub{font-size:0.9rem;color:var(--muted);max-width:380px;margin:0 auto;line-height:1.6}
.cards-row{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;animation:fadeUp 0.7s 0.15s ease both}
.portal-card{background:var(--card);border:1px solid rgba(0,173,238,0.12);border-radius:18px;padding:24px 20px;width:200px;text-align:center;text-decoration:none;cursor:pointer;position:relative;overflow:hidden;transition:transform 0.25s,box-shadow 0.25s,border-color 0.25s;box-shadow:0 2px 12px rgba(0,0,0,0.04)}
.portal-card:hover{transform:translateY(-5px);box-shadow:0 14px 36px rgba(0,173,238,0.14),0 4px 12px rgba(0,0,0,0.06);border-color:rgba(0,173,238,0.4)}
.card-icon-wrap{width:56px;height:56px;border-radius:14px;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;font-size:1.5rem;transition:transform 0.25s}
.portal-card:hover .card-icon-wrap{transform:scale(1.1)}
.icon-sa{background:linear-gradient(135deg,rgba(167,139,250,0.2),rgba(139,92,246,0.12));border:1px solid rgba(139,92,246,0.2)}
.icon-admin{background:linear-gradient(135deg,rgba(0,173,238,0.2),rgba(0,173,238,0.08));border:1px solid rgba(0,173,238,0.2)}
.icon-user{background:linear-gradient(135deg,rgba(52,211,153,0.2),rgba(52,211,153,0.08));border:1px solid rgba(52,211,153,0.2)}
.card-title{font-family:'Syne',sans-serif;font-weight:700;font-size:0.95rem;color:var(--text);margin-bottom:5px}
.card-desc{font-size:0.7rem;color:var(--muted);line-height:1.5}
.card-cta{display:inline-flex;align-items:center;gap:4px;margin-top:14px;padding:6px 14px;border-radius:8px;font-size:0.7rem;font-weight:600;transition:all 0.2s;color:white}
.cta-sa{background:linear-gradient(135deg,#7c3aed,#a78bfa)}
.cta-admin{background:linear-gradient(135deg,#009ed8,var(--accent))}
.cta-user{background:linear-gradient(135deg,#059669,#34d399)}
.features{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:36px;animation:fadeUp 0.7s 0.3s ease both}
.feat{display:flex;align-items:center;gap:5px;padding:5px 12px;border-radius:20px;background:white;border:1px solid rgba(0,173,238,0.12);font-size:0.68rem;color:var(--muted);font-weight:500}
.feat-dot{width:5px;height:5px;border-radius:50%;background:var(--accent)}
.portal-footer{margin-top:36px;font-size:0.68rem;color:var(--muted);display:flex;align-items:center;gap:5px;animation:fadeUp 0.7s 0.4s ease both}
.portal-footer a{color:var(--accent);text-decoration:none}
@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
@media(max-width:480px){.cards-row{flex-direction:column;align-items:center}.portal-card{width:100%;max-width:300px}.hero-title{font-size:2rem}}
</style>
</head>
<body>
<div class="bg-mesh"></div>
<div class="bg-grid"></div>
<div class="top-bar">
  <a class="top-brand" href="/portal"><div class="brand-icon">👁</div>FaceAttend</a>
  <span class="top-version">SaaS v3.0</span>
</div>
<div class="portal-wrap">
  <div class="hero">
    <div class="hero-eyebrow">Multi-tenant Platform</div>
    <h1 class="hero-title">Face Recognition<br><span class="hl">Attendance</span> System</h1>
    <p class="hero-sub">Automated attendance tracking with real-time face recognition. Choose your portal below.</p>
  </div>
  <div class="cards-row">
    <a href="/super-admin" class="portal-card">
      <div class="card-icon-wrap icon-sa">🛡️</div>
      <div class="card-title">Super Admin</div>
      <div class="card-desc">Platform control, admin approvals &amp; oversight.</div>
      <div class="card-cta cta-sa">Enter →</div>
    </a>
    <a href="/admin" class="portal-card">
      <div class="card-icon-wrap icon-admin">🏢</div>
      <div class="card-title">Admin</div>
      <div class="card-desc">Manage faces, shifts, scan attendance &amp; calendar.</div>
      <div class="card-cta cta-admin">Enter →</div>
    </a>
    <a href="/user" class="portal-card">
      <div class="card-icon-wrap icon-user">👤</div>
      <div class="card-title">Employee</div>
      <div class="card-desc">View your attendance calendar &amp; notifications.</div>
      <div class="card-cta cta-user">Enter →</div>
    </a>
  </div>
  <div class="features">
    <div class="feat"><div class="feat-dot"></div>Real-time Face Recognition</div>
    <div class="feat"><div class="feat-dot"></div>Multi-Shift Support</div>
    <div class="feat"><div class="feat-dot"></div>Push Notifications</div>
    <div class="feat"><div class="feat-dot"></div>CSV Export</div>
    <div class="feat"><div class="feat-dot"></div>Holiday Calendar</div>
  </div>
  <div class="portal-footer">
    <span>Powered by</span><a href="#">face-api.js</a><span>·</span><a href="#">Node.js</a><span>·</span><a href="#">MySQL</a>
  </div>
</div>
</body></html>`);
});

// ═══════════════════════════════════════════════════════════════════════
//  SUPER ADMIN PAGE
// ═══════════════════════════════════════════════════════════════════════
app.get('/super-admin', (_, res) => {
  res.send(htmlBase('Super Admin', `
<nav>
  <a class="nav-logo" href="/portal">Face<span>Attend</span></a>
  <div class="nav-right" id="navRight"></div>
</nav>
<main id="app">
  <div id="setupForm" style="display:none;max-width:420px;margin:40px auto">
    <div class="page-title">🛡️ First-time Setup</div>
    <div class="card">
      <div id="setupErr" class="alert alert-error" style="display:none"></div>
      <div class="form-group"><label>Full Name</label><input class="form-control" id="saName" placeholder="Super Admin Name"></div>
      <div class="form-group"><label>Email</label><input class="form-control" id="saEmail" type="email" placeholder="admin@example.com"></div>
      <div class="form-group"><label>Password</label><input class="form-control" id="saPass" type="password" placeholder="••••••••"></div>
      <button class="btn btn-primary btn-full" onclick="doSetup()">Create Super Admin</button>
    </div>
  </div>
  <div id="loginForm" style="display:none;max-width:380px;margin:40px auto">
    <div class="page-title">🛡️ Super Admin Login</div>
    <div class="card">
      <div id="loginErr" class="alert alert-error" style="display:none"></div>
      <div class="form-group"><label>Email</label><input class="form-control" id="saLoginEmail" type="email"></div>
      <div class="form-group"><label>Password</label><input class="form-control" id="saLoginPass" type="password"></div>
      <button class="btn btn-primary btn-full" onclick="doLogin()">Login</button>
    </div>
  </div>
  <div id="dashboard" style="display:none">
    <div class="page-title">🛡️ Super Admin Dashboard</div>
    <div id="statsRow" style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:16px"></div>
    <div class="card">
      <div class="card-header">
        <span class="card-title">Registered Organisations</span>
      </div>
      <div class="table-wrap" id="adminTable"></div>
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
  if(r.error){showErr('setupErr',r.error);return;}
  location.reload();
}

async function doLogin(){
  const e=document.getElementById('saLoginEmail').value,p=document.getElementById('saLoginPass').value;
  const r=await fetch('/api/super-admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:p})}).then(x=>x.json());
  if(r.error){showErr('loginErr',r.error);return;}
  saToken=r.token;localStorage.setItem(TOKEN_KEY,saToken);loadDashboard();
}

function showErr(id,msg){const el=document.getElementById(id);el.textContent=msg;el.style.display='block';}
function logout(){localStorage.removeItem(TOKEN_KEY);location.reload();}

async function loadDashboard(){
  document.getElementById('loginForm').style.display='none';
  document.getElementById('dashboard').style.display='block';
  document.getElementById('navRight').innerHTML='<span class="badge badge-sa">Super Admin</span><button class="btn btn-sm btn-outline" onclick="logout()">Logout</button>';
  const admins=await fetch('/api/super-admin/admins',{headers:{'x-token':saToken}}).then(x=>x.json());
  if(admins.error){localStorage.removeItem(TOKEN_KEY);location.reload();return;}
  const total=admins.length,approved=admins.filter(a=>a.status==='approved').length,
    pending=admins.filter(a=>a.status==='pending').length,
    suspended=admins.filter(a=>a.status==='suspended').length,
    totalUsers=admins.reduce((s,a)=>s+(a.user_count||0),0);
  // Show pending badge in nav
  document.getElementById('navRight').innerHTML=
    (pending>0?'<span class="chip chip-yellow" style="animation:pulse 2s infinite">⏳ '+pending+' Pending</span>':'')+
    '<span class="badge badge-sa">Super Admin</span>'+
    '<button class="btn btn-sm btn-outline" onclick="logout()">Logout</button>';
  document.getElementById('statsRow').innerHTML=
    '<div class="stat"><div class="stat-val">'+total+'</div><div class="stat-label">Total Orgs</div></div>'+
    '<div class="stat"><div class="stat-val green">'+approved+'</div><div class="stat-label">Approved</div></div>'+
    '<div class="stat"><div class="stat-val yellow">'+pending+'</div><div class="stat-label">Pending</div></div>'+
    '<div class="stat"><div class="stat-val red">'+suspended+'</div><div class="stat-label">Suspended</div></div>'+
    '<div class="stat"><div class="stat-val">'+totalUsers+'</div><div class="stat-label">Total Employees</div></div>';
  const rows=admins.map(a=>'<tr>'+
    '<td><strong>'+a.org_name+'</strong><br><span style="color:var(--muted);font-size:0.7rem">'+a.email+'</span></td>'+
    '<td class="hide-mobile">'+a.org_type+'</td>'+
    '<td><span class="chip chip-'+(a.status==='approved'?'green':a.status==='pending'?'yellow':a.status==='rejected'?'red':'gray')+'">'+a.status+'</span></td>'+
    '<td class="hide-mobile" style="font-family:\'JetBrains Mono\',monospace;font-size:0.75rem">'+(a.face_count||0)+' faces / '+(a.user_count||0)+' users</td>'+
    '<td><span class="chip chip-blue">'+(a.today_attendance||0)+' today</span></td>'+
    '<td style="white-space:nowrap">'+
      (a.status!=='approved'?'<button class="btn btn-xs btn-success" onclick="setStatus('+a.id+',\'approved\')">✓ Approve</button> ':
        '<button class="btn btn-xs btn-warn" onclick="setStatus('+a.id+',\'suspended\')">Suspend</button> ')+
      (a.status==='pending'||a.status==='suspended'?'<button class="btn btn-xs btn-danger" onclick="setStatus('+a.id+',\'rejected\')">✕ Reject</button>':
        (a.status==='rejected'?'<button class="btn btn-xs btn-success" onclick="setStatus('+a.id+',\'approved\')">Re-approve</button>':''))+
    '</td></tr>').join('');
  document.getElementById('adminTable').innerHTML=
    '<table><thead><tr><th>Organisation</th><th class="hide-mobile">Type</th><th>Status</th><th class="hide-mobile">Faces/Users</th><th>Today</th><th>Action</th></tr></thead>'+
    '<tbody>'+(rows||'<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:30px">No admins yet</td></tr>')+'</tbody></table>';
}

async function setStatus(id,status){
  await fetch('/api/super-admin/admin/'+id+'/status',{method:'POST',headers:{'Content-Type':'application/json','x-token':saToken},body:JSON.stringify({status})});
  loadDashboard();
}

init();
</script>`));
});

// ═══════════════════════════════════════════════════════════════════════
//  ADMIN PAGE
// ═══════════════════════════════════════════════════════════════════════
app.get('/admin', (_, res) => {
  res.send(htmlBase('Admin Portal', `
<nav>
  <a class="nav-logo" href="/portal" id="navLogo">Face<span>Attend</span></a>
  <div class="nav-right" id="navRight"></div>
</nav>
<main id="app">

  <!-- AUTH -->
  <div id="authSection" style="max-width:460px;margin:24px auto">
    <div class="tabs">
      <button class="tab active" onclick="switchAuthTab('login',this)">Login</button>
      <button class="tab" onclick="switchAuthTab('register',this)">Register Org</button>
    </div>
    <div id="loginPanel" class="card">
      <div id="loginErr" class="alert alert-error" style="display:none"></div>
      <div class="form-group"><label>Email</label><input class="form-control" id="aEmail" type="email"></div>
      <div class="form-group"><label>Password</label><input class="form-control" id="aPass" type="password" onkeydown="if(event.key==='Enter')doAdminLogin()"></div>
      <button class="btn btn-primary btn-full" onclick="doAdminLogin()">Login</button>
    </div>
    <div id="registerPanel" class="card" style="display:none">
      <div id="regErr" class="alert alert-error" style="display:none"></div>
      <div id="regOk" class="alert alert-success" style="display:none"></div>
      <div class="grid2">
        <div class="form-group"><label>Your Name</label><input class="form-control" id="rName" placeholder="John Doe"></div>
        <div class="form-group"><label>Email</label><input class="form-control" id="rEmail" type="email"></div>
      </div>
      <div class="grid2">
        <div class="form-group"><label>Password</label><input class="form-control" id="rPass" type="password"></div>
        <div class="form-group"><label>Organisation</label><input class="form-control" id="rOrg" placeholder="ABC School"></div>
      </div>
      <div class="grid2">
        <div class="form-group"><label>Org Type</label>
          <select class="form-control" id="rType">
            <option value="office">Office</option><option value="school">School</option>
            <option value="hospital">Hospital</option><option value="factory">Factory</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div class="form-group"><label>System Title</label><input class="form-control" id="rTitle" placeholder="Daily Attendance"></div>
      </div>
      <div class="form-group">
        <label>Logo</label>
        <input type="file" accept="image/*" id="rLogo" class="form-control" onchange="previewLogo(this)">
        <img id="logoPreview" class="logo-preview" style="display:none;margin-top:8px">
      </div>
      <button class="btn btn-primary btn-full" onclick="doRegister()">Submit for Approval</button>
    </div>
  </div>

  <!-- DASHBOARD -->
  <div id="dashboard" style="display:none">
    <!-- Desktop tabs -->
    <div class="tabs desktop-tabs" id="dashTabs">
      <button class="tab active" onclick="switchTab('scan',this)">📷 Scan</button>
      <button class="tab" onclick="switchTab('people',this)">👥 People</button>
      <button class="tab" onclick="switchTab('shifts',this)">⏰ Shifts</button>
      <button class="tab" onclick="switchTab('attendance',this)">📋 Records</button>
      <button class="tab" onclick="switchTab('calendar',this)">📅 Calendar</button>
    </div>

    <!-- SCAN TAB -->
    <div id="tab-scan">
      <div class="grid2" style="align-items:start">
        <div>
          <div class="cam-card">
            <div class="cam-wrap" id="scanCamWrap">
              <video id="video" autoplay muted playsinline></video>
              <canvas id="overlay"></canvas>
              <div class="scan-line"></div>
              <div class="detected-label" id="detectedLabel" style="display:none"></div>
            </div>
            <div class="cam-controls">
              <div style="flex:1;display:flex;align-items:center;gap:6px;font-size:0.72rem;color:var(--muted)">
                <div class="live-dot" id="statusDot" style="background:var(--muted2)"></div>
                <span id="statusText">Starting camera...</span>
              </div>
              <select class="form-control" id="scanMode" style="width:auto;padding:6px 10px;font-size:0.73rem">
                <option value="checkin">Check In</option>
                <option value="checkout">Check Out</option>
              </select>
              <button class="btn btn-primary btn-sm" id="detectBtn" onclick="doDetect()" disabled>Detect</button>
              <button class="btn btn-outline btn-sm" id="autoBtn" onclick="toggleAuto()" title="Auto scan every 3s">Auto</button>
            </div>
          </div>
          <div class="grid4 stats-grid" style="margin-top:10px" id="todayStats"></div>
        </div>

        <!-- Pending shift + result -->
        <div>
          <!-- Shift selection card (shown after detect) -->
          <div class="card" id="shiftSelectCard" style="display:none;margin-bottom:12px">
            <div class="card-title" style="margin-bottom:4px" id="detectedName"></div>
            <div style="font-size:0.72rem;color:var(--muted);margin-bottom:10px" id="detectedMeta"></div>
            <div id="pendingShiftsList"></div>
            <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap" id="shiftActionBtns"></div>
          </div>

          <div class="result-card" id="resultCard">
            <div class="result-title">Last Result</div>
            <div id="resultBody" style="color:var(--muted);font-size:0.82rem;text-align:center;padding:16px">
              <div style="font-size:2rem;margin-bottom:6px">📷</div>
              Scan a face to see results.
            </div>
          </div>
          <div class="card" style="margin-top:12px">
            <div class="card-header" style="margin-bottom:10px">
              <span style="font-weight:700;font-size:0.85rem">Today's Attendance</span>
              <span id="todayCount" class="chip chip-blue"></span>
            </div>
            <div id="todayList" style="max-height:260px;overflow-y:auto"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- PEOPLE TAB -->
    <div id="tab-people" style="display:none">
      <div class="grid2" style="align-items:start">
        <!-- Register form -->
        <div class="card">
          <div class="card-header">
            <span class="card-title">Register Person</span>
            <span id="regModeLabel" class="chip chip-blue">New</span>
          </div>
          <div class="alert alert-info" style="font-size:0.73rem;margin-bottom:12px">
            📌 Registers face profile + creates employee login in one step.
          </div>
          <div class="cam-card" style="margin-bottom:10px">
            <div class="cam-wrap"><video id="regVideo" autoplay muted playsinline></video><canvas id="regOverlay"></canvas></div>
            <div class="cam-controls" style="justify-content:space-between">
              <span id="regStatus" style="font-size:0.7rem;color:var(--muted)">Camera ready</span>
              <button class="btn btn-primary btn-sm" id="captureBtn" onclick="captureSample()" disabled>Capture</button>
            </div>
          </div>
          <div class="grid2">
            <div class="form-group"><label>Full Name *</label><input class="form-control" id="fName" placeholder="Employee Name"></div>
            <div class="form-group"><label>Employee ID</label><input class="form-control" id="fEmpId" placeholder="EMP001"></div>
          </div>
          <div class="form-group"><label>Department</label><input class="form-control" id="fDept" placeholder="Engineering"></div>

          <div class="form-group">
            <label>Assign Shifts (select one or more)</label>
            <div class="shift-checkboxes" id="fShiftCheckboxes">
              <div style="color:var(--muted);font-size:0.78rem;padding:8px">No shifts created yet. Add shifts first.</div>
            </div>
          </div>

          <div style="border-top:1px solid var(--border);padding-top:12px;margin:4px 0 12px">
            <div style="font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px;font-weight:600">Employee Login Account</div>
            <div class="grid2">
              <div class="form-group"><label>Email *</label><input class="form-control" id="fUserEmail" type="email" placeholder="emp@company.com"></div>
              <div class="form-group"><label>Password *</label><input class="form-control" id="fUserPassword" type="password" placeholder="Min 6 chars"></div>
            </div>
          </div>

          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
            <span id="sampleCount" style="font-size:0.73rem;color:var(--muted)">0 / 10 samples</span>
            <button class="btn btn-outline btn-xs" onclick="clearSamples()">Clear</button>
          </div>
          <div class="progress-bar" style="margin-bottom:10px"><div class="progress-fill" id="sampleProgress" style="width:0%"></div></div>
          <div id="regErr" class="alert alert-error" style="display:none"></div>
          <div id="regOk2" class="alert alert-success" style="display:none"></div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-outline" id="cancelEditBtn" style="display:none" onclick="cancelEdit()">Cancel</button>
            <button class="btn btn-primary" style="flex:1" id="saveBtn" onclick="saveFace()" disabled>Save Person &amp; Create Account</button>
          </div>
        </div>

        <!-- People list -->
        <div class="card">
          <div class="card-header">
            <span class="card-title">Registered People</span>
            <span id="faceCount" class="chip chip-blue">0</span>
          </div>
          <input class="form-control" id="peopleSearch" placeholder="🔍 Search by name, email, dept..." oninput="filterPeople()" style="margin-bottom:10px">
          <div id="faceList"></div>
        </div>
      </div>
    </div>

    <!-- SHIFTS TAB -->
    <div id="tab-shifts" style="display:none">
      <div class="grid2" style="align-items:start">
        <div class="card">
          <div class="card-title" style="margin-bottom:14px">Add Shift</div>
          <div class="form-group"><label>Shift Name</label><input class="form-control" id="shName" placeholder="Morning / Night / A-Shift"></div>
          <div class="grid2">
            <div class="form-group"><label>Start Time</label><input class="form-control" id="shStart" type="time"></div>
            <div class="form-group"><label>End Time</label><input class="form-control" id="shEnd" type="time"></div>
          </div>
          <div id="shErr" class="alert alert-error" style="display:none"></div>
          <button class="btn btn-primary btn-full" onclick="addShift()">Add Shift</button>
        </div>
        <div class="card">
          <div class="card-title" style="margin-bottom:14px">Your Shifts</div>
          <div id="shiftList"></div>
        </div>
      </div>
    </div>

    <!-- ATTENDANCE RECORDS TAB -->
    <div id="tab-attendance" style="display:none">
      <div class="card">
        <div class="card-header">
          <span class="card-title">Attendance Records</span>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <select class="form-control" id="expMonth" style="width:auto;padding:6px 10px;font-size:0.75rem"></select>
            <select class="form-control" id="expYear" style="width:auto;padding:6px 10px;font-size:0.75rem"></select>
            <button class="btn btn-success btn-sm" onclick="loadAttendanceRecords()">Load</button>
            <button class="btn btn-outline btn-sm" onclick="exportCSV()">⬇️ Export CSV</button>
          </div>
        </div>
        <div id="attendanceSummary" style="margin-bottom:12px"></div>
        <div class="table-wrap" id="attendanceTable"></div>
      </div>
    </div>

    <!-- CALENDAR TAB -->
    <div id="tab-calendar" style="display:none">
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:10px">
          <button class="btn btn-outline btn-sm" onclick="changeMonth(-1)">&#8249; Prev</button>
          <span id="calTitle" style="font-weight:700"></span>
          <button class="btn btn-outline btn-sm" onclick="changeMonth(1)">Next &#8250;</button>
        </div>
        <div style="font-size:0.7rem;color:var(--muted);margin-bottom:8px">Tap a date to add/remove holidays.</div>
        <div class="cal-grid" id="calHead"></div>
        <div class="cal-grid" style="margin-top:3px" id="calGrid"></div>
      </div>
    </div>
  </div>
</main>

<!-- Calendar Modal -->
<div id="calModal" class="modal-backdrop">
  <div class="modal">
    <div class="modal-handle"></div>
    <div class="modal-title">
      <span id="calModalDate">Date</span>
      <button class="modal-close" onclick="closeCalModal()">✕</button>
    </div>
    <div id="calModalBody"></div>
    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
      <button class="btn btn-success" id="holidayAddBtn" onclick="toggleHoliday()">Make Holiday</button>
      <button class="btn btn-outline" onclick="closeCalModal()">Close</button>
    </div>
  </div>
</div>

<!-- Mobile Bottom Nav -->
<nav class="mobile-nav" id="mobileNav" style="display:none">
  <div class="mobile-nav-items">
    <button class="mobile-nav-item active" onclick="mobileTab('scan',this)"><span class="nav-icon">📷</span>Scan</button>
    <button class="mobile-nav-item" onclick="mobileTab('people',this)"><span class="nav-icon">👥</span>People</button>
    <button class="mobile-nav-item" onclick="mobileTab('shifts',this)"><span class="nav-icon">⏰</span>Shifts</button>
    <button class="mobile-nav-item" onclick="mobileTab('attendance',this)"><span class="nav-icon">📋</span>Records</button>
    <button class="mobile-nav-item" onclick="mobileTab('calendar',this)"><span class="nav-icon">📅</span>Calendar</button>
  </div>
</nav>

<script src="/faceapi.js"></script>
<script>
const TOKEN_KEY='admin_token';
let adminToken=localStorage.getItem(TOKEN_KEY);
let adminShifts=[],adminFaces=[],regSamples=[],autoMode=false,autoTimer=null;
let calYear=new Date().getFullYear(),calMonth=new Date().getMonth()+1;
let calData={attendance:[],holidays:[]},selectedCalDate=null;
let editingFaceId=null,detectedFace=null;
let allFacesCache=[];

// ── Auth tab switch ──
function switchAuthTab(t,btn){
  document.querySelectorAll('#authSection .tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('loginPanel').style.display=t==='login'?'block':'none';
  document.getElementById('registerPanel').style.display=t==='register'?'block':'none';
}

function previewLogo(input){
  const f=input.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=e=>{const img=document.getElementById('logoPreview');img.src=e.target.result;img.style.display='block'};
  r.readAsDataURL(f);
}

async function doAdminLogin(){
  const e=document.getElementById('aEmail').value,p=document.getElementById('aPass').value;
  const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:p})}).then(x=>x.json());
  if(r.error){showMsg('loginErr','error',r.error);return;}
  adminToken=r.token;localStorage.setItem(TOKEN_KEY,adminToken);showDashboard(r);
}

async function doRegister(){
  const logo=document.getElementById('logoPreview').src||null;
  const body={name:document.getElementById('rName').value,email:document.getElementById('rEmail').value,
    password:document.getElementById('rPass').value,org_name:document.getElementById('rOrg').value,
    org_type:document.getElementById('rType').value,attendance_title:document.getElementById('rTitle').value,
    logo_base64:logo&&logo.startsWith('data:')?logo:null};
  const r=await fetch('/api/admin/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(x=>x.json());
  if(r.error){showMsg('regErr','error',r.error);return;}
  showMsg('regOk','success',r.message||'Submitted! Await approval.');
}

function adminLogout(){localStorage.removeItem(TOKEN_KEY);location.reload();}

function showMsg(id,type,msg){
  const el=document.getElementById(id);if(!el)return;
  el.className='alert alert-'+type;el.textContent=msg;el.style.display='block';
  if(type==='success') setTimeout(()=>el.style.display='none',4000);
}

function showToast(msg,type='info'){
  const t=document.createElement('div');
  t.className='toast';
  const colors={info:'#1a2332',success:'#059669',error:'#dc2626',warn:'#92400e'};
  t.style.background=colors[type]||colors.info;
  t.textContent=msg;document.body.appendChild(t);
  setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),400)},3500);
}

async function showDashboard(r){
  document.getElementById('authSection').style.display='none';
  document.getElementById('dashboard').style.display='block';
  document.getElementById('mobileNav').style.display='block';
  document.body.classList.add('has-mobile-nav');
  const me=r||await fetch('/api/admin/me',{headers:{'x-token':adminToken}}).then(x=>x.json()).catch(()=>null);
  if(!me||me.error){localStorage.removeItem(TOKEN_KEY);location.reload();return;}
  let logoHtml='';
  if(me.logo_base64) logoHtml='<img src="'+me.logo_base64+'" style="height:28px;border-radius:5px;margin-right:6px">';
  document.getElementById('navLogo').innerHTML=logoHtml+'Face<span style="color:var(--accent)">Attend</span>';
  document.getElementById('navRight').innerHTML=
    '<span style="font-size:0.72rem;color:var(--muted);max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+(me.org_name||'')+'</span>'+
    '<span class="badge badge-admin">Admin</span>'+
    '<button class="btn btn-sm btn-outline" onclick="adminLogout()">Logout</button>';
  // Show scan tab by default
  switchTab('scan', document.querySelector('#dashTabs .tab'));
  await loadShifts();
  await loadFaceList();
  loadScanTab();
  startCamera('video','overlay',true);
}

// ── Tab switching ──
function switchTab(t,btn){
  document.querySelectorAll('#dashTabs .tab').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  else {
    // activate matching desktop tab by index
    const tabMap={scan:0,people:1,shifts:2,attendance:3,calendar:4};
    const tabs=document.querySelectorAll('#dashTabs .tab');
    if(tabs[tabMap[t]]) tabs[tabMap[t]].classList.add('active');
  }
  ['scan','people','shifts','attendance','calendar'].forEach(tab=>{
    const el=document.getElementById('tab-'+tab);
    if(el) el.style.display=tab===t?'block':'none';
  });
  if(t==='people') startCamera('regVideo','regOverlay',false);
  if(t==='calendar') renderCalendar();
  if(t==='attendance'){ populateExportMonthYear(); loadAttendanceRecords(); }
}

function mobileTab(t,btn){
  document.querySelectorAll('.mobile-nav-item').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  switchTab(t,null);
}

// ── Camera ──
let streams={};
async function startCamera(videoId,overlayId,isScan){
  if(streams[videoId]) return;
  try{
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:{ideal:640},height:{ideal:480}}});
    streams[videoId]=stream;
    const v=document.getElementById(videoId);
    if(!v)return;
    v.srcObject=stream;
    await new Promise(r=>v.addEventListener('loadedmetadata',r,{once:true}));
    if(isScan){
      document.getElementById('detectBtn').disabled=false;
      document.getElementById('statusDot').style.background='var(--accent)';
      document.getElementById('statusText').textContent='Camera ready — tap Detect';
    } else {
      const btn=document.getElementById('captureBtn');
      if(btn) btn.disabled=false;
      const st=document.getElementById('regStatus');
      if(st) st.textContent='Ready — capture 10 samples';
    }
  }catch(e){
    const el=document.getElementById(isScan?'statusText':'regStatus');
    if(el) el.textContent='Camera error: '+e.message;
  }
}

// ── Detect face (no mark yet) ──
let detectCooldown=false;
async function doDetect(){
  if(detectCooldown) return;
  detectCooldown=true;
  setTimeout(()=>detectCooldown=false,1500);

  const v=document.getElementById('video');
  if(!v||!v.srcObject) return;
  await ensureModels();

  const lbl=document.getElementById('detectedLabel');
  lbl.textContent='🔍 Detecting...';lbl.style.display='block';lbl.className='detected-label';

  const det=await faceapi.detectSingleFace(v).withFaceLandmarks().withFaceDescriptor();
  if(!det){
    lbl.textContent='❌ No face detected';lbl.className='detected-label red';
    setTimeout(()=>lbl.style.display='none',2000);
    showResult({event:'no_face',message:'No face detected'},'⚠️');
    return;
  }

  const r=await fetch('/api/admin/detect',{method:'POST',
    headers:{'Content-Type':'application/json','x-token':adminToken},
    body:JSON.stringify({descriptor:Array.from(det.descriptor)})}).then(x=>x.json());

  if(r.event==='unknown'){
    lbl.textContent='❓ Unknown face';lbl.className='detected-label red';
    setTimeout(()=>lbl.style.display='none',3000);
    showResult({event:'unknown',message:'Unknown face — not registered'},'❓');
    document.getElementById('shiftSelectCard').style.display='none';
    return;
  }

  if(r.event==='recognized'){
    detectedFace=r;
    detectedFace._descriptor=Array.from(det.descriptor); // cache for re-detect
    lbl.textContent='✅ '+r.name;lbl.className='detected-label green';

    const mode=document.getElementById('scanMode').value;
    const card=document.getElementById('shiftSelectCard');

    if(mode==='checkout'){
      // For checkout — just show shifts that are checked-in today
      const markedShifts=r.shifts.filter(s=>!r.pending_shifts.find(p=>p.id===s.id));
      document.getElementById('detectedName').textContent=r.name;
      document.getElementById('detectedMeta').textContent='Select shift to check out:';
      let html='';
      if(r.no_shift){
        html='<div style="font-size:0.8rem;color:var(--muted);padding:6px">No-shift person — checking out directly.</div>';
        document.getElementById('shiftActionBtns').innerHTML=
          '<button class="btn btn-primary btn-sm" onclick="markAttendance(null)">Check Out</button>';
      } else if(markedShifts.length===0){
        html='<div style="font-size:0.8rem;color:var(--muted);padding:6px">Not checked in for any shift today.</div>';
        document.getElementById('shiftActionBtns').innerHTML='';
      } else {
        markedShifts.forEach(s=>{
          html+='<button class="btn btn-outline btn-sm" style="margin:3px" onclick="markAttendance('+s.id+')">'+
            s.name+' ('+fmtT(s.start_time)+' – '+fmtT(s.end_time)+')</button>';
        });
        document.getElementById('shiftActionBtns').innerHTML='';
      }
      document.getElementById('pendingShiftsList').innerHTML=html;
      card.style.display='block';
    } else {
      // Check-in mode
      if(r.no_shift){
        card.style.display='none';
        markAttendance(null);
        return;
      }
      if(r.pending_shifts.length===0){
        document.getElementById('detectedName').textContent=r.name;
        document.getElementById('detectedMeta').textContent='All shifts already marked today ✅';
        document.getElementById('pendingShiftsList').innerHTML='<div class="chip chip-green" style="font-size:0.78rem">All '+r.shifts.length+' shift(s) marked</div>';
        document.getElementById('shiftActionBtns').innerHTML='';
        card.style.display='block';
        showResult({event:'already_checked_in',name:r.name,time_in:'All shifts done'},'ℹ️');
        return;
      }
      document.getElementById('detectedName').textContent=r.name;
      const s=r.pending_shifts;
      document.getElementById('detectedMeta').textContent=s.length+' pending shift'+(s.length>1?'s':'')+' — tap to mark:';
      let html='';
      s.forEach(sh=>{
        html+='<button class="btn btn-success btn-sm" style="margin:3px;display:inline-flex;flex-direction:column;align-items:flex-start;height:auto;padding:8px 12px" onclick="markAttendance('+sh.id+')">'+
          '<span style="font-weight:700">'+sh.name+'</span>'+
          '<span style="font-size:0.65rem;opacity:0.8">'+fmtT(sh.start_time)+' – '+fmtT(sh.end_time)+'</span>'+
          '</button>';
      });
      if(s.length>1){
        html+='<button class="btn btn-primary btn-sm" style="margin:3px" onclick="markAllShifts()">✅ Mark All ('+s.length+')</button>';
      }
      document.getElementById('pendingShiftsList').innerHTML=html;
      document.getElementById('shiftActionBtns').innerHTML='';
      card.style.display='block';
    }
    showResult({event:'recognized',name:r.name,message:'Select shift below to mark attendance'},'👤');
  }
}

async function markAttendance(shiftId){
  if(!detectedFace) return;
  const mode=document.getElementById('scanMode').value;
  const r=await fetch('/api/admin/scan',{method:'POST',
    headers:{'Content-Type':'application/json','x-token':adminToken},
    body:JSON.stringify({face_id:detectedFace.face_id,shift_id:shiftId,mode})}).then(x=>x.json());
  showResult(r);
  loadScanTab();
  if(r.event==='checkin'){
    showToast('✅ '+r.name+' marked'+(r.shift?' ['+r.shift+']':''),'success');
    // Refresh pending shifts from server using face_id directly
    const updated=await fetch('/api/admin/detect-by-id',{method:'POST',
      headers:{'Content-Type':'application/json','x-token':adminToken},
      body:JSON.stringify({face_id:detectedFace.face_id})}).then(x=>x.json()).catch(()=>null);
    // If we have cached detect result, update from server
    if(updated&&updated.event==='recognized'){
      detectedFace=updated;
      if(updated.pending_shifts.length===0){
        document.getElementById('shiftSelectCard').style.display='none';
        showToast('✅ All shifts marked for '+r.name,'success');
      } else {
        // Re-render pending
        const s=updated.pending_shifts;
        document.getElementById('detectedMeta').textContent=s.length+' shift'+(s.length>1?'s':'')+' remaining:';
        let html='';
        s.forEach(sh=>{
          html+='<button class="btn btn-success btn-sm" style="margin:3px;display:inline-flex;flex-direction:column;align-items:flex-start;height:auto;padding:8px 12px" onclick="markAttendance('+sh.id+')">'+
            '<span style="font-weight:700">'+sh.name+'</span>'+
            '<span style="font-size:0.65rem;opacity:0.8">'+fmtT(sh.start_time)+' – '+fmtT(sh.end_time)+'</span>'+
            '</button>';
        });
        if(s.length>1) html+='<button class="btn btn-primary btn-sm" style="margin:3px" onclick="markAllShifts()">✅ Mark All ('+s.length+')</button>';
        document.getElementById('pendingShiftsList').innerHTML=html;
      }
    } else {
      document.getElementById('shiftSelectCard').style.display='none';
    }
  }
  if(r.event==='checkout') showToast('👋 '+r.name+' checked out'+(r.shift?' ['+r.shift+']':''),'info');
}

async function markAllShifts(){
  if(!detectedFace||!detectedFace.pending_shifts) return;
  for(const s of detectedFace.pending_shifts){
    await fetch('/api/admin/scan',{method:'POST',
      headers:{'Content-Type':'application/json','x-token':adminToken},
      body:JSON.stringify({face_id:detectedFace.face_id,shift_id:s.id,mode:'checkin'})}).then(x=>x.json());
  }
  showToast('✅ All shifts marked for '+detectedFace.name,'success');
  document.getElementById('shiftSelectCard').style.display='none';
  loadScanTab();
  showResult({event:'checkin',name:detectedFace.name,message:'All '+detectedFace.pending_shifts.length+' shifts marked'});
}



function showResult(r,icon=''){
  const icons={checkin:'✅',checkout:'👋',unknown:'❓',already_checked_in:'ℹ️',already_checked_out:'ℹ️',not_checked_in:'⚠️',recognized:'👤',no_face:'⚠️'};
  const ic=icon||icons[r.event]||'📋';
  const colors={checkin:'#059669',checkout:'var(--accent)',unknown:'var(--red)',already_checked_in:'#92400e',recognized:'var(--accent)'};
  const color=colors[r.event]||'var(--muted)';
  document.getElementById('resultBody').innerHTML=
    '<div style="text-align:center;padding:10px">'+
    '<div style="font-size:2rem">'+ic+'</div>'+
    '<div style="font-size:1rem;font-weight:700;color:'+color+';margin:6px 0">'+(r.name||r.event)+'</div>'+
    (r.time_in?'<div style="font-size:0.78rem;color:var(--muted)">In: '+r.time_in+'</div>':'')+
    (r.time_out?'<div style="font-size:0.78rem;color:var(--muted)">Out: '+r.time_out+'</div>':'')+
    (r.shift?'<div style="font-size:0.7rem;color:var(--accent);margin-top:2px">Shift: '+r.shift+'</div>':'')+
    (r.message?'<div style="font-size:0.75rem;color:var(--muted);margin-top:4px">'+r.message+'</div>':'')+
    '</div>';
}

async function loadScanTab(){
  const today=new Date().toISOString().split('T')[0];
  const [rows,allFaces]=await Promise.all([
    fetch('/api/admin/attendance?date='+today,{headers:{'x-token':adminToken}}).then(x=>x.json()),
    fetch('/api/admin/faces',{headers:{'x-token':adminToken}}).then(x=>x.json())
  ]);
  const uniquePresent=new Set(rows.filter(r=>r.status==='present').map(r=>r.face_id)).size;
  const total=allFaces.length;
  document.getElementById('todayStats').innerHTML=
    '<div class="stat"><div class="stat-val green">'+uniquePresent+'</div><div class="stat-label">Present</div></div>'+
    '<div class="stat"><div class="stat-val red">'+(total-uniquePresent)+'</div><div class="stat-label">Absent</div></div>'+
    '<div class="stat"><div class="stat-val">'+total+'</div><div class="stat-label">Total</div></div>'+
    '<div class="stat"><div class="stat-val yellow">'+rows.filter(r=>r.time_out).length+'</div><div class="stat-label">Out</div></div>';
  const todayCount=document.getElementById('todayCount');
  if(todayCount) todayCount.textContent=rows.length+' records';
  document.getElementById('todayList').innerHTML=rows.length?
    rows.map(r=>'<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--surface)">'+
      '<div><span style="font-weight:600;font-size:0.82rem">'+r.name+'</span>'+
      (r.shift_name?'<span class="chip chip-blue" style="margin-left:4px">'+r.shift_name+'</span>':'')+
      '</div>'+
      '<div style="text-align:right;font-size:0.7rem;color:var(--muted)">'+r.time_in+(r.time_out?' → '+r.time_out:'')+'</div>'+
    '</div>').join('')
    :'<div class="empty-state"><div class="empty-icon">📋</div><p>No attendance today</p></div>';
}

function toggleAuto(){
  autoMode=!autoMode;
  const btn=document.getElementById('autoBtn');
  if(autoMode){btn.textContent='⏹ Stop';btn.classList.add('active');btn.style.background='var(--accent)';btn.style.color='#fff';autoTimer=setInterval(()=>doDetect(),3500);}
  else{btn.textContent='Auto';btn.classList.remove('active');btn.style.background='';btn.style.color='';clearInterval(autoTimer);}
}

// ── People / Face registration ──
let modelsLoaded=false;
async function ensureModels(){
  if(modelsLoaded) return;
  await faceapi.nets.ssdMobilenetv1.loadFromUri('/models');
  await faceapi.nets.faceLandmark68Net.loadFromUri('/models');
  await faceapi.nets.faceRecognitionNet.loadFromUri('/models');
  modelsLoaded=true;
}

async function captureSample(){
  const v=document.getElementById('regVideo');
  if(!v||!v.srcObject) return;
  await ensureModels();
  const st=document.getElementById('regStatus');
  st.textContent='Processing...';
  const det=await faceapi.detectSingleFace(v).withFaceLandmarks().withFaceDescriptor();
  if(!det){st.textContent='❌ No face — try again';return;}
  regSamples.push(Array.from(det.descriptor));
  const pct=regSamples.length/10*100;
  document.getElementById('sampleCount').textContent=regSamples.length+' / 10 samples';
  document.getElementById('sampleProgress').style.width=pct+'%';
  st.textContent='✅ Sample '+regSamples.length+' captured';
  if(regSamples.length>=10){
    document.getElementById('saveBtn').disabled=false;
    st.textContent='🎉 10 samples ready — fill details & save!';
  }
}

function clearSamples(){
  regSamples=[];
  document.getElementById('sampleCount').textContent='0 / 10 samples';
  document.getElementById('sampleProgress').style.width='0%';
  document.getElementById('saveBtn').disabled=editingFaceId?false:true;
  document.getElementById('regStatus').textContent='Samples cleared';
}

function renderShiftCheckboxes(selectedIds=[]){
  const container=document.getElementById('fShiftCheckboxes');
  if(!adminShifts.length){
    container.innerHTML='<div style="color:var(--muted);font-size:0.78rem;padding:8px">No shifts yet. Create shifts first.</div>';
    return;
  }
  container.innerHTML=adminShifts.map(s=>{
    const checked=selectedIds.includes(s.id);
    const dur=shiftHoursJS(s.start_time,s.end_time);
    return '<label class="shift-checkbox-item'+(checked?' checked':'')+'">'+
      '<input type="checkbox" value="'+s.id+'"'+(checked?' checked':'')+' onchange="this.closest(\'.shift-checkbox-item\').classList.toggle(\'checked\',this.checked)">'+
      '<div style="flex:1"><div class="shift-checkbox-label">'+s.name+'</div>'+
      '<div class="shift-checkbox-meta">'+fmtT(s.start_time)+' – '+fmtT(s.end_time)+' · '+dur+'</div></div>'+
      '</label>';
  }).join('');
}

function shiftHoursJS(start,end){
  // MySQL TIME returns HH:MM:SS — take only first two parts
  const sp=String(start).split(':'),ep=String(end).split(':');
  const sh=+sp[0],sm=+sp[1]||0,eh=+ep[0],em=+ep[1]||0;
  let mins=(eh*60+em)-(sh*60+sm);if(mins<0)mins+=24*60;
  const h=Math.floor(mins/60),m=mins%60;
  return m?h+'h '+m+'m':h+'h';
}
function fmtT(t){
  if(!t)return'';
  const p=String(t).split(':');
  const h=parseInt(p[0]),m=p[1]||'00';
  return(h%12||12)+':'+m+(h>=12?' PM':' AM');
}

function getSelectedShiftIds(){
  return Array.from(document.querySelectorAll('#fShiftCheckboxes input[type=checkbox]:checked')).map(c=>parseInt(c.value));
}

async function saveFace(){
  const label=document.getElementById('fName').value.trim();
  const email=document.getElementById('fUserEmail').value.trim();
  const password=document.getElementById('fUserPassword').value;
  if(!label){showMsg('regErr','error','Name required');return;}
  if(!email){showMsg('regErr','error','Email required');return;}
  if(!editingFaceId&&(!password||password.length<6)){showMsg('regErr','error','Password min 6 chars');return;}
  if(!editingFaceId&&regSamples.length<5){showMsg('regErr','error','Need at least 5 face samples');return;}

  const shift_ids=getSelectedShiftIds();

  if(editingFaceId){
    // Update only metadata & shifts (no re-scan needed)
    const r=await fetch('/api/admin/faces/'+editingFaceId,{method:'PUT',
      headers:{'Content-Type':'application/json','x-token':adminToken},
      body:JSON.stringify({employee_id:document.getElementById('fEmpId').value,
        department:document.getElementById('fDept').value,shift_ids})}).then(x=>x.json());
    if(r.error){showMsg('regErr','error',r.error);return;}
    showMsg('regOk2','success','Updated successfully!');
    cancelEdit();
  } else {
    const r=await fetch('/api/admin/faces',{method:'POST',
      headers:{'Content-Type':'application/json','x-token':adminToken},
      body:JSON.stringify({label,employee_id:document.getElementById('fEmpId').value,
        department:document.getElementById('fDept').value,shift_ids,
        user_email:email,user_password:password,
        descriptors:regSamples,accuracy:Math.round(100-Math.random()*5)})}).then(x=>x.json());
    if(r.error){showMsg('regErr','error',r.error);return;}
    showMsg('regOk2','success','Person registered & account created! ✅');
    document.getElementById('fName').value='';document.getElementById('fEmpId').value='';
    document.getElementById('fDept').value='';document.getElementById('fUserEmail').value='';
    document.getElementById('fUserPassword').value='';
    renderShiftCheckboxes([]);
    clearSamples();
  }
  document.getElementById('regErr').style.display='none';
  loadFaceList();
}

function editFace(id){
  const face=allFacesCache.find(f=>f.id===id);
  if(!face) return;
  editingFaceId=id;
  document.getElementById('fName').value=face.label;
  document.getElementById('fName').disabled=true;
  document.getElementById('fEmpId').value=face.employee_id||'';
  document.getElementById('fDept').value=face.department||'';
  document.getElementById('fUserEmail').value=face.user_email||'';
  document.getElementById('fUserEmail').disabled=true;
  document.getElementById('fUserPassword').placeholder='Leave blank (no change)';
  document.getElementById('saveBtn').disabled=false;
  document.getElementById('saveBtn').textContent='Update Person';
  document.getElementById('cancelEditBtn').style.display='inline-flex';
  document.getElementById('regModeLabel').textContent='Editing';
  document.getElementById('regModeLabel').className='chip chip-yellow';
  const selectedIds=(face.shifts||[]).map(s=>s.id);
  renderShiftCheckboxes(selectedIds);
  switchTab('people',null);
  document.querySelectorAll('.mobile-nav-item').forEach((b,i)=>{b.classList.toggle('active',i===1)});
  window.scrollTo({top:0,behavior:'smooth'});
}

function cancelEdit(){
  editingFaceId=null;
  document.getElementById('fName').disabled=false;
  document.getElementById('fName').value='';
  document.getElementById('fEmpId').value='';
  document.getElementById('fDept').value='';
  document.getElementById('fUserEmail').disabled=false;
  document.getElementById('fUserEmail').value='';
  document.getElementById('fUserPassword').placeholder='Min 6 chars';
  document.getElementById('saveBtn').textContent='Save Person & Create Account';
  document.getElementById('saveBtn').disabled=true;
  document.getElementById('cancelEditBtn').style.display='none';
  document.getElementById('regModeLabel').textContent='New';
  document.getElementById('regModeLabel').className='chip chip-blue';
  renderShiftCheckboxes([]);
  clearSamples();
  document.getElementById('regErr').style.display='none';
  document.getElementById('regOk2').style.display='none';
}

async function loadFaceList(){
  const faces=await fetch('/api/admin/faces',{headers:{'x-token':adminToken}}).then(x=>x.json());
  allFacesCache=faces;
  adminFaces=faces;
  const countEl=document.getElementById('faceCount');
  if(countEl) countEl.textContent=faces.length;
  renderFaceList(faces);
}

function filterPeople(){
  const q=document.getElementById('peopleSearch').value.toLowerCase();
  const filtered=allFacesCache.filter(f=>
    f.label.toLowerCase().includes(q)||
    (f.user_email||'').toLowerCase().includes(q)||
    (f.department||'').toLowerCase().includes(q)||
    (f.employee_id||'').toLowerCase().includes(q)
  );
  renderFaceList(filtered);
}

function renderFaceList(faces){
  const el=document.getElementById('faceList');
  if(!faces.length){
    el.innerHTML='<div class="empty-state"><div class="empty-icon">👥</div><p>No people registered yet.</p></div>';
    return;
  }
  el.innerHTML='<div style="display:flex;flex-direction:column;gap:8px">'+faces.map(f=>{
    const shiftTags=(f.shifts||[]).map(s=>'<span class="chip chip-blue" style="font-size:0.58rem">'+s.name+'</span>').join(' ');
    return '<div class="person-card">'+
      '<div class="person-avatar">'+f.label.charAt(0).toUpperCase()+'</div>'+
      '<div class="person-info">'+
        '<div class="person-name">'+f.label+'</div>'+
        '<div class="person-meta">'+
          (f.employee_id?'#'+f.employee_id+' · ':'')+
          (f.department||'No Dept')+
        '</div>'+
        (f.user_email?'<div style="font-size:0.68rem;color:var(--accent);margin-top:2px">📧 '+f.user_email+'</div>':'')+
        (shiftTags?'<div class="person-shifts" style="margin-top:4px">'+shiftTags+'</div>':
          '<div style="font-size:0.65rem;color:var(--muted);margin-top:3px">No shift assigned</div>')+
        (f.notifications_enabled?'<span class="chip chip-green" style="font-size:0.58rem;margin-top:3px">🔔 Notif on</span>':'')+
      '</div>'+
      '<div class="person-actions">'+
        '<button class="btn btn-outline btn-icon" onclick="editFace('+f.id+')" title="Edit">✏️</button>'+
        '<button class="btn btn-danger btn-icon" onclick="deleteFace('+f.id+')" title="Delete">✕</button>'+
      '</div>'+
    '</div>';
  }).join('')+'</div>';
}

async function deleteFace(id){
  if(!confirm('Delete this person and their login account?')) return;
  await fetch('/api/admin/faces/'+id,{method:'DELETE',headers:{'x-token':adminToken}});
  loadFaceList();
  showToast('Person deleted','warn');
}

// ── Shifts ──
async function loadShifts(){
  adminShifts=await fetch('/api/admin/shifts',{headers:{'x-token':adminToken}}).then(x=>x.json());
  renderShiftCheckboxes([]);
  const list=document.getElementById('shiftList');
  if(list) list.innerHTML=adminShifts.length?
    '<div style="display:flex;flex-direction:column;gap:6px">'+adminShifts.map(s=>{
      const dur=shiftHoursJS(s.start_time,s.end_time);
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">'+
        '<div><span style="font-weight:600">'+s.name+'</span>'+
        '<span style="color:var(--muted);font-size:0.72rem;margin-left:8px">'+
        fmtT(s.start_time)+' – '+fmtT(s.end_time)+'</span>'+
        '<span class="chip chip-blue" style="margin-left:6px">'+dur+'</span></div>'+
        '<button class="btn btn-danger btn-xs" onclick="deleteShift('+s.id+')">✕</button>'+
      '</div>';
    }).join('')+'</div>'
    :'<div class="empty-state"><div class="empty-icon">⏰</div><p>No shifts yet.</p></div>';
}

async function addShift(){
  const n=document.getElementById('shName').value.trim(),s=document.getElementById('shStart').value,e=document.getElementById('shEnd').value;
  if(!n||!s||!e){showMsg('shErr','error','All fields required');return;}
  const r=await fetch('/api/admin/shifts',{method:'POST',headers:{'Content-Type':'application/json','x-token':adminToken},body:JSON.stringify({name:n,start_time:s,end_time:e})}).then(x=>x.json());
  if(r.error){showMsg('shErr','error',r.error);return;}
  document.getElementById('shErr').style.display='none';
  document.getElementById('shName').value='';
  document.getElementById('shStart').value='';
  document.getElementById('shEnd').value='';
  await loadShifts();
  showToast('Shift added!','success');
}

async function deleteShift(id){
  if(!confirm('Delete this shift? Employees assigned will lose this shift.')) return;
  await fetch('/api/admin/shifts/'+id,{method:'DELETE',headers:{'x-token':adminToken}});
  await loadShifts();loadFaceList();
}

// ── Attendance Records ──
let exportPopulated=false;
function populateExportMonthYear(){
  if(exportPopulated) return;
  exportPopulated=true;
  const now=new Date();
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const mSel=document.getElementById('expMonth');
  const ySel=document.getElementById('expYear');
  if(!mSel||!ySel)return;
  mSel.innerHTML=months.map((m,i)=>'<option value="'+(i+1)+'"'+(i+1===now.getMonth()+1?' selected':'')+'>'+m+'</option>').join('');
  const yr=now.getFullYear();
  ySel.innerHTML=[yr-1,yr,yr+1].map(y=>'<option value="'+y+'"'+(y===yr?' selected':'')+'>'+y+'</option>').join('');
}

async function loadAttendanceRecords(){
  const m=document.getElementById('expMonth').value;
  const y=document.getElementById('expYear').value;
  const rows=await fetch('/api/admin/attendance?month='+m+'&year='+y,{headers:{'x-token':adminToken}}).then(x=>x.json());
  const present=rows.filter(r=>r.status==='present').length;
  const absent=rows.filter(r=>r.status==='absent').length;
  document.getElementById('attendanceSummary').innerHTML=
    '<div class="grid4 stats-grid">'+
    '<div class="stat card-sm"><div class="stat-val">'+rows.length+'</div><div class="stat-label">Total Records</div></div>'+
    '<div class="stat card-sm"><div class="stat-val green">'+present+'</div><div class="stat-label">Present</div></div>'+
    '<div class="stat card-sm"><div class="stat-val red">'+absent+'</div><div class="stat-label">Absent</div></div>'+
    '<div class="stat card-sm"><div class="stat-val yellow">'+rows.filter(r=>r.time_out).length+'</div><div class="stat-label">Checked Out</div></div>'+
    '</div>';
  if(!rows.length){
    document.getElementById('attendanceTable').innerHTML='<div class="empty-state"><div class="empty-icon">📋</div><p>No records for this period.</p></div>';
    return;
  }
  const trs=rows.map(r=>'<tr>'+
    '<td><strong>'+r.name+'</strong></td>'+
    '<td>'+String(r.date).slice(0,10)+'</td>'+
    '<td class="hide-mobile">'+(r.shift_name||'—')+'</td>'+
    '<td>'+r.time_in+'</td>'+
    '<td>'+(r.time_out||'—')+'</td>'+
    '<td><span class="chip chip-'+(r.status==='present'?'green':'red')+'">'+r.status+'</span></td>'+
  '</tr>').join('');
  document.getElementById('attendanceTable').innerHTML=
    '<table><thead><tr><th>Name</th><th>Date</th><th class="hide-mobile">Shift</th><th>Time In</th><th>Time Out</th><th>Status</th></tr></thead>'+
    '<tbody>'+trs+'</tbody></table>';
}

function exportCSV(){
  const m=document.getElementById('expMonth').value;
  const y=document.getElementById('expYear').value;
  window.location.href='/api/admin/attendance/export?month='+m+'&year='+y+'&_t='+adminToken;
}

// ── Calendar ──
const MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];
function changeMonth(d){calMonth+=d;if(calMonth>12){calMonth=1;calYear++;}if(calMonth<1){calMonth=12;calYear--;}renderCalendar();}

async function renderCalendar(){
  calData=await fetch('/api/admin/calendar?month='+calMonth+'&year='+calYear,{headers:{'x-token':adminToken}}).then(x=>x.json());
  document.getElementById('calTitle').textContent=MONTH_NAMES[calMonth-1]+' '+calYear;
  document.getElementById('calHead').innerHTML=['S','M','T','W','T','F','S'].map(d=>'<div class="cal-head">'+d+'</div>').join('');
  const first=new Date(calYear,calMonth-1,1).getDay(),days=new Date(calYear,calMonth,0).getDate(),today=new Date();
  let cells='';
  for(let i=0;i<first;i++) cells+='<div class="cal-day other-month"></div>';
  for(let d=1;d<=days;d++){
    const ds=calYear+'-'+String(calMonth).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const att=calData.attendance.find(a=>String(a.date).startsWith(ds));
    const hol=calData.holidays.find(h=>String(h.date).startsWith(ds));
    const isTd=today.getDate()===d&&today.getMonth()===calMonth-1&&today.getFullYear()===calYear;
    cells+='<div class="cal-day'+(isTd?' today':'')+(hol?' holiday':'')+'" onclick="openCalDay(\''+ds+'\','+!!hol+')">'+
      '<div class="cal-day-num">'+d+'</div>'+
      (att?'<span class="cal-event cal-present">✅ '+att.present+'</span>'+(att.absent>0?'<span class="cal-event cal-absent">❌ '+att.absent+'</span>':''):'')+
      (hol?'<span class="cal-event cal-holiday-tag">'+hol.label+'</span>':'')+
    '</div>';
  }
  document.getElementById('calGrid').innerHTML=cells;
}

function openCalDay(date,isHoliday){
  selectedCalDate=date;
  const hol=calData.holidays.find(h=>String(h.date).startsWith(date));
  const att=calData.attendance.find(a=>String(a.date).startsWith(date));
  document.getElementById('calModalDate').textContent=date;
  const btn=document.getElementById('holidayAddBtn');
  btn.textContent=isHoliday?'Remove Holiday':'Make Holiday';
  btn.className='btn '+(isHoliday?'btn-danger':'btn-success');
  document.getElementById('calModalBody').innerHTML=
    (att?'<p style="font-size:0.85rem">✅ Present: <strong>'+att.present+'</strong> · ❌ Absent: <strong>'+att.absent+'</strong></p>':'<p style="color:var(--muted);font-size:0.82rem">No attendance data</p>')+
    (hol?'<p style="margin-top:8px;font-size:0.82rem">🎉 Holiday: <strong>'+hol.label+'</strong></p>':'');
  document.getElementById('calModal').classList.add('open');
}
function closeCalModal(){document.getElementById('calModal').classList.remove('open');}

async function toggleHoliday(){
  const hol=calData.holidays.find(h=>String(h.date).startsWith(selectedCalDate));
  if(hol){
    await fetch('/api/admin/holidays/'+selectedCalDate,{method:'DELETE',headers:{'x-token':adminToken}});
  } else {
    const label=prompt('Holiday name:','Holiday');
    if(!label) return;
    await fetch('/api/admin/holidays',{method:'POST',headers:{'Content-Type':'application/json','x-token':adminToken},body:JSON.stringify({date:selectedCalDate,label})});
  }
  closeCalModal();renderCalendar();
}

// ── Init ──
(async function(){
  if(adminToken){
    const me=await fetch('/api/admin/me',{headers:{'x-token':adminToken}}).then(x=>x.json()).catch(()=>null);
    if(me&&!me.error){document.getElementById('authSection').style.display='none';showDashboard(me);}
    else localStorage.removeItem(TOKEN_KEY);
  }
})();
</script>`));
});

// ═══════════════════════════════════════════════════════════════════════
//  USER PAGE
// ═══════════════════════════════════════════════════════════════════════
app.get('/user', (_, res) => {
  res.send(htmlBase('Employee Portal', `
<nav>
  <a class="nav-logo" href="/portal" id="navLogo">Face<span>Attend</span></a>
  <div class="nav-right" id="navRight"></div>
</nav>
<main id="app">
  <!-- Login -->
  <div id="loginSection" style="max-width:380px;margin:48px auto">
    <div class="page-title">👤 Employee Portal</div>
    <div class="card">
      <div style="font-size:1.1rem;font-weight:700;margin-bottom:14px">Sign In</div>
      <div id="loginErr" class="alert alert-error" style="display:none"></div>
      <div class="form-group"><label>Email</label><input class="form-control" id="uEmail" type="email" autocomplete="email"></div>
      <div class="form-group"><label>Password</label><input class="form-control" id="uPass" type="password" autocomplete="current-password" onkeydown="if(event.key==='Enter')doUserLogin()"></div>
      <button class="btn btn-primary btn-full" onclick="doUserLogin()">Login</button>
    </div>
  </div>

  <!-- Dashboard -->
  <div id="userDash" style="display:none">
    <!-- Notif toggle bar -->
    <div class="card" style="margin-bottom:14px" id="notifBar">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div>
          <div style="font-weight:600;font-size:0.88rem">🔔 Attendance Notifications</div>
          <div style="font-size:0.72rem;color:var(--muted);margin-top:2px" id="notifStatusText">Loading...</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <span id="notifStatusBadge"></span>
          <button class="btn btn-primary btn-sm" id="notifToggleBtn" onclick="toggleNotifications()" style="display:none"></button>
        </div>
      </div>
    </div>

    <div class="grid4 stats-grid" id="statsRow" style="margin-bottom:14px"></div>

    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:10px">
        <button class="btn btn-outline btn-sm" onclick="changeMonth(-1)">&#8249;</button>
        <span id="calTitle" style="font-weight:700"></span>
        <button class="btn btn-outline btn-sm" onclick="changeMonth(1)">&#8250;</button>
      </div>
      <div class="cal-grid" id="calHead"></div>
      <div class="cal-grid" style="margin-top:3px" id="calGrid"></div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-title" style="margin-bottom:12px">Recent Records</div>
      <div id="recentList"></div>
    </div>
  </div>
</main>

<!-- Notification Permission Modal -->
<div id="notifModal" class="modal-backdrop">
  <div class="modal" style="text-align:center">
    <div class="modal-handle"></div>
    <div style="width:60px;height:60px;border-radius:50%;background:rgba(0,173,238,0.1);display:flex;align-items:center;justify-content:center;font-size:2rem;margin:0 auto 14px">🔔</div>
    <div style="font-weight:700;font-size:1rem;margin-bottom:8px">Enable Attendance Alerts</div>
    <div style="font-size:0.8rem;color:var(--muted);margin-bottom:20px;line-height:1.6">
      Get instant push notifications every time your attendance is marked — check-in &amp; check-out alerts sent right to your device.
    </div>
    <div id="notifModalPushStatus" class="alert alert-warn" style="display:none;text-align:left;margin-bottom:12px"></div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <button class="btn btn-primary btn-full" id="notifModalEnableBtn" onclick="enableNotif()">🔔 Enable Notifications</button>
      <button class="btn btn-outline btn-sm btn-full" onclick="dismissNotifModal()">Maybe later</button>
    </div>
  </div>
</div>

<script>
const TOKEN_KEY='user_token';
let userToken=localStorage.getItem(TOKEN_KEY);
let calYear=new Date().getFullYear(),calMonth=new Date().getMonth()+1;
let calData={attendance:[],holidays:[]};
let currentUser=null;
const MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];

function showToast(msg,type='info'){
  const t=document.createElement('div');
  t.className='toast';
  const colors={info:'#1a2332',success:'#059669',error:'#dc2626',warn:'#92400e'};
  t.style.background=colors[type]||colors.info;
  t.textContent=msg;document.body.appendChild(t);
  setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),400)},4000);
}

async function doUserLogin(){
  const e=document.getElementById('uEmail').value,p=document.getElementById('uPass').value;
  const r=await fetch('/api/user/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:p})}).then(x=>x.json());
  if(r.error){const el=document.getElementById('loginErr');el.textContent=r.error;el.style.display='block';return;}
  userToken=r.token;localStorage.setItem(TOKEN_KEY,userToken);
  currentUser=r;showUserDash(r);
}

function userLogout(){localStorage.removeItem(TOKEN_KEY);location.reload();}

async function showUserDash(r){
  document.getElementById('loginSection').style.display='none';
  document.getElementById('userDash').style.display='block';
  let logoHtml='';
  if(r.logo_base64) logoHtml='<img src="'+r.logo_base64+'" style="height:26px;border-radius:5px;margin-right:6px">';
  document.getElementById('navLogo').innerHTML=logoHtml+'Face<span style="color:var(--accent)">Attend</span>';
  document.getElementById('navRight').innerHTML=
    '<span style="font-size:0.72rem;color:var(--muted)">'+r.name+'</span>'+
    '<span class="badge badge-user">Employee</span>'+
    '<button class="btn btn-sm btn-outline" onclick="userLogout()">Logout</button>';

  renderCalendar();

  // Setup service worker & check push status
  await setupPushNotifications(r.notifications_enabled);
}

async function setupPushNotifications(alreadyEnabled){
  const statusText=document.getElementById('notifStatusText');
  const statusBadge=document.getElementById('notifStatusBadge');
  const toggleBtn=document.getElementById('notifToggleBtn');

  if(!('serviceWorker' in navigator)||!('PushManager' in window)){
    statusText.textContent='Push notifications not supported on this browser.';
    document.getElementById('notifBar').style.display='none';
    return;
  }

  // Check VAPID availability
  const vapidResp=await fetch('/api/vapid-public').then(x=>x.json()).catch(()=>({enabled:false}));
  if(!vapidResp.enabled||!vapidResp.key){
    statusText.textContent='Push service not configured on this server.';
    toggleBtn.style.display='none';
    return;
  }

  try{
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  }catch(e){
    statusText.textContent='Service worker error: '+e.message;
    return;
  }

  const perm=Notification.permission;

  if(alreadyEnabled&&perm==='granted'){
    statusText.textContent='You will receive alerts when attendance is marked.';
    statusBadge.innerHTML='<span class="chip chip-green">✅ Active</span>';
    toggleBtn.textContent='Disable';toggleBtn.className='btn btn-danger btn-sm';toggleBtn.style.display='inline-flex';
  } else if(perm==='denied'){
    statusText.textContent='Blocked by browser. Enable in browser settings to receive alerts.';
    statusBadge.innerHTML='<span class="chip chip-red">🚫 Blocked</span>';
    toggleBtn.style.display='none';
  } else {
    statusText.textContent='Enable to get instant check-in/out alerts.';
    statusBadge.innerHTML='<span class="chip chip-gray">○ Off</span>';
    toggleBtn.textContent='Enable';toggleBtn.className='btn btn-primary btn-sm';toggleBtn.style.display='inline-flex';
    // Auto-show modal after 5s if not denied
    if(!alreadyEnabled&&perm!=='denied'){
      setTimeout(()=>document.getElementById('notifModal').classList.add('open'),5000);
    }
  }
}

async function toggleNotifications(){
  const btn=document.getElementById('notifToggleBtn');
  const isEnabled=btn.textContent.includes('Disable');
  if(isEnabled){
    await fetch('/api/user/push-unsubscribe',{method:'POST',headers:{'x-token':userToken}});
    showToast('Notifications disabled','warn');
    await setupPushNotifications(false);
  } else {
    await enableNotif();
  }
}

async function enableNotif(){
  dismissNotifModal();
  const statusEl=document.getElementById('notifModalPushStatus');

  if(Notification.permission==='denied'){
    showToast('Notifications blocked — enable in browser settings','error');
    return;
  }

  const perm=await Notification.requestPermission();
  if(perm!=='granted'){
    showToast('Notification permission denied','error');
    return;
  }

  try{
    const reg=await navigator.serviceWorker.ready;
    const vapid=await fetch('/api/vapid-public').then(x=>x.json());
    if(!vapid.key||!vapid.enabled){
      showToast('Push service not available on this server','error');
      return;
    }
    const existing=await reg.pushManager.getSubscription();
    if(existing) await existing.unsubscribe();
    const sub=await reg.pushManager.subscribe({
      userVisibleOnly:true,
      applicationServerKey:urlBase64ToUint8Array(vapid.key)
    });
    const r=await fetch('/api/user/push-subscribe',{method:'POST',
      headers:{'Content-Type':'application/json','x-token':userToken},
      body:JSON.stringify({subscription:sub.toJSON()})}).then(x=>x.json());
    if(r.error) throw new Error(r.error);
    showToast('✅ Notifications enabled!','success');
    await setupPushNotifications(true);
  }catch(e){
    showToast('Could not enable notifications: '+e.message,'error');
  }
}

function dismissNotifModal(){
  document.getElementById('notifModal').classList.remove('open');
}

function urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(base64);
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

function changeMonth(d){calMonth+=d;if(calMonth>12){calMonth=1;calYear++;}if(calMonth<1){calMonth=12;calYear--;}renderCalendar();}

async function renderCalendar(){
  calData=await fetch('/api/user/attendance?month='+calMonth+'&year='+calYear,{headers:{'x-token':userToken}}).then(x=>x.json());
  document.getElementById('calTitle').textContent=MONTH_NAMES[calMonth-1]+' '+calYear;
  const present=calData.attendance.filter(a=>a.status==='present').length;
  const absent=calData.attendance.filter(a=>a.status==='absent').length;
  const total=calData.attendance.length;
  const pct=total>0?Math.round(present/total*100):0;
  document.getElementById('statsRow').innerHTML=
    '<div class="stat"><div class="stat-val green">'+present+'</div><div class="stat-label">Present</div></div>'+
    '<div class="stat"><div class="stat-val red">'+absent+'</div><div class="stat-label">Absent</div></div>'+
    '<div class="stat"><div class="stat-val">'+total+'</div><div class="stat-label">Marked</div></div>'+
    '<div class="stat"><div class="stat-val '+(pct>=80?'green':pct>=60?'yellow':'red')+'">'+pct+'%</div><div class="stat-label">Rate</div></div>';
  document.getElementById('calHead').innerHTML=['S','M','T','W','T','F','S'].map(d=>'<div class="cal-head">'+d+'</div>').join('');
  const first=new Date(calYear,calMonth-1,1).getDay(),days=new Date(calYear,calMonth,0).getDate(),today=new Date();
  let cells='';
  for(let i=0;i<first;i++) cells+='<div class="cal-day other-month"></div>';
  for(let d=1;d<=days;d++){
    const ds=calYear+'-'+String(calMonth).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const dayAtts=calData.attendance.filter(a=>String(a.date).startsWith(ds));
    const hol=calData.holidays.find(h=>String(h.date).startsWith(ds));
    const isTd=today.getDate()===d&&today.getMonth()===calMonth-1&&today.getFullYear()===calYear;
    const hasPresent=dayAtts.some(a=>a.status==='present');
    const hasAbsent=dayAtts.some(a=>a.status==='absent');
    cells+='<div class="cal-day'+(isTd?' today':'')+(hol?' holiday':'')+'">'+
      '<div class="cal-day-num">'+d+'</div>'+
      (hasPresent?'<span class="cal-event cal-present">✅'+(dayAtts.length>1?' '+dayAtts.filter(a=>a.status==='present').length:'')+'</span>':'')+
      (hasAbsent?'<span class="cal-event cal-absent">❌</span>':'')+
      (hol?'<span class="cal-event cal-holiday-tag">'+hol.label+'</span>':'')+
    '</div>';
  }
  document.getElementById('calGrid').innerHTML=cells;

  const recent=calData.attendance.slice(0,15);
  document.getElementById('recentList').innerHTML=recent.length?
    recent.map(a=>'<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--surface)">'+
      '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">'+
      '<span class="chip '+(a.status==='present'?'chip-green':'chip-red')+'">'+(a.status==='present'?'✅ Present':'❌ Absent')+'</span>'+
      (a.shift_name?'<span class="chip chip-blue">'+a.shift_name+'</span>':'')+
      '</div>'+
      '<div style="text-align:right;font-size:0.72rem;color:var(--muted)">'+
      '<div>'+String(a.date).slice(0,10)+'</div>'+
      (a.time_in?'<div>'+a.time_in+(a.time_out?' → '+a.time_out:'')+'</div>':'')+
      '</div></div>').join('')
    :'<div class="empty-state"><div class="empty-icon">📋</div><p>No records this month.</p></div>';
}

(async function(){
  if(userToken){
    try{
      // Fetch full profile + notif status together
      const [notifR, profileR] = await Promise.all([
        fetch('/api/user/notif-status',{headers:{'x-token':userToken}}).then(x=>x.json()),
        fetch('/api/user/profile',{headers:{'x-token':userToken}}).then(x=>x.json()).catch(()=>null)
      ]);
      if(notifR&&!notifR.error){
        const parts=userToken.split('.');
        const pay=JSON.parse(atob(parts[1]));
        currentUser={
          name:pay.name,
          logo_base64: profileR&&!profileR.error ? profileR.logo_base64 : null,
          org_name: profileR&&!profileR.error ? profileR.org_name : '',
          notifications_enabled: notifR.enabled
        };
        await showUserDash(currentUser);
      } else { localStorage.removeItem(TOKEN_KEY); }
    }catch(e){ localStorage.removeItem(TOKEN_KEY); }
  }
})();
</script>`));
});

// ── Start ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('✅ Server listening on port', PORT);
});
