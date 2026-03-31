/**
 * FaceAttend SaaS — Multi-tenant Face Recognition Attendance
 * Roles: super_admin | admin (tenant) | user (student)
 *
 * Changes v3 → v4:
 *  - Multi-period attendance: select one / multiple / all pending shifts per scan
 *  - Duplicate scan prevention per period per day
 *  - Admin: export attendance (CSV/Excel)
 *  - Admin: user management tab (view/delete users)
 *  - Notification subscription fix (service worker registration order)
 *  - Scan result label always shown
 *  - Improved UI mobile responsiveness across all pages
 *  - Attendance table updated: UNIQUE KEY now per face+date+shift combo
 */

'use strict';

require('dotenv').config();

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

const THRESHOLD        = 0.5;
const REGISTER_SAMPLES = 10;

function euclidean(a, b) {
  let s = 0; for (let i=0;i<a.length;i++) s+=(a[i]-b[i])**2; return Math.sqrt(s);
}

// ── DB Init ───────────────────────────────────────────────────────────────────
db.connect(err => {
  if (err) { console.error('❌ MySQL error:', err.message); process.exit(1); }
  console.log('✅ MySQL connected →', DB_CONFIG.database);
  initTables().then(() => {
    setup();
    startAbsentCron();
  });
});

// ── Auto-absent cron: every 5 minutes, mark absent for expired periods ────────
function startAbsentCron() {
  setInterval(async () => {
    try {
      const now = new Date();
      const dateStr = now.toISOString().split('T')[0];
      const timeStr = pad2(now.getHours())+':'+pad2(now.getMinutes())+':'+pad2(now.getSeconds());

      // Get all admins that are approved
      const admins = await dbQuery("SELECT id FROM admins WHERE status='approved'");
      for (const admin of admins) {
        // Get all shifts that have ended (end_time < current time)
        const expiredShifts = await dbQuery(
          'SELECT * FROM shifts WHERE admin_id=? AND end_time < ?',
          [admin.id, timeStr]
        );
        for (const shift of expiredShifts) {
          // Get all faces assigned to this period (via face_periods)
          const assignedFaces = await dbQuery(
            'SELECT f.* FROM faces f JOIN face_periods fp ON fp.face_id=f.id WHERE fp.shift_id=? AND f.admin_id=?',
            [shift.id, admin.id]
          );
          for (const face of assignedFaces) {
            // Check if already marked (present or absent) for this face+date+shift
            const existing = await dbQuery(
              'SELECT id FROM attendance WHERE face_id=? AND date=? AND shift_id=?',
              [face.id, dateStr, shift.id]
            );
            if (!existing.length) {
              // Mark as absent
              await dbQuery(
                'INSERT IGNORE INTO attendance (admin_id,face_id,shift_id,name,date,time_in,status) VALUES (?,?,?,?,?,?,?)',
                [admin.id, face.id, shift.id, face.label, dateStr, shift.end_time, 'absent']
              );
            }
          }
        }
      }
    } catch(e) {
      console.warn('Auto-absent cron error:', e.message);
    }
  }, 5 * 60 * 1000); // every 5 minutes
  console.log('✅ Auto-absent cron started (runs every 5 min)');
}

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

    CREATE TABLE IF NOT EXISTS face_periods (
      id INT AUTO_INCREMENT PRIMARY KEY,
      face_id INT NOT NULL,
      shift_id INT NOT NULL,
      UNIQUE KEY uq_face_period (face_id, shift_id),
      FOREIGN KEY (face_id) REFERENCES faces(id) ON DELETE CASCADE,
      FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  try {
    await dbQuery(sql);
    console.log('✅ All tables ready');
    // Run ALTER commands to support multi-shift per day (drop old unique, add new)
    try {
      await dbQuery('ALTER TABLE attendance DROP INDEX uq_face_date');
      console.log('✅ Dropped old uq_face_date index');
    } catch(e) { /* already dropped or never existed */ }
    try {
      await dbQuery('ALTER TABLE attendance ADD UNIQUE KEY uq_face_date_shift (face_id, date, shift_id)');
      console.log('✅ Added uq_face_date_shift index');
    } catch(e) { /* already exists */ }
  } catch(e) {
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

// Minimum expected sizes for each model file (bytes) — shards must be > 1 MB
const MODEL_MIN_SIZES = {
  'ssd_mobilenetv1_model-shard1': 2_000_000,
  'ssd_mobilenetv1_model-shard2': 2_000_000,
  'face_landmark_68_model-shard1': 300_000,
  'face_recognition_model-shard1': 6_000_000,
  'face_recognition_model-shard2': 1_000_000,
};

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
    const size = fs.statSync(fp).size;
    const minSize = MODEL_MIN_SIZES[f] || 500; // default 500 bytes for JSON manifests
    if (size < minSize) {
      console.log(`⚠️  Deleting corrupted/truncated model: ${f} (${size} bytes, expected ≥ ${minSize})`);
      fs.unlinkSync(fp);
      return true;
    }
    return false;
  });
  if (!missing.length) { console.log('✅ All models cached and valid'); }
  else {
    console.log('📥 Downloading', missing.length, 'model file(s)...');
    for (const f of missing) {
      try { await download(MODEL_BASE_URL+f, path.join(MODELS_DIR,f)); console.log('  ✅', f); }
      catch(e) { console.log('  ❌', f, e.message); }
    }
  }
  console.log('\n🚀 FaceAttend SaaS running on http://localhost:' + PORT + '\n');
}

// ── Admin API: force re-download corrupted models ────────────────────────────
app.post('/api/admin/reload-models', authMiddleware('admin'), async (req, res) => {
  try {
    let deleted = 0;
    for (const f of MODEL_FILES) {
      const fp = path.join(MODELS_DIR, f);
      if (fs.existsSync(fp)) { fs.unlinkSync(fp); deleted++; }
    }
    // Re-download in background
    setup().catch(e => console.warn('Model reload error:', e.message));
    res.json({ ok: true, message: `Deleted ${deleted} cached model files. Re-downloading now — reload the page in ~30 seconds.` });
  } catch(e) {
    res.json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  SHARED CSS
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
nav{position:sticky;top:0;z-index:100;background:rgba(255,255,255,0.96);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 16px;height:58px;gap:10px}
.nav-logo{display:flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:0.88rem;font-weight:600;color:var(--text);text-decoration:none;flex-shrink:0}
.nav-logo span{color:var(--accent)}
.nav-logo img{height:32px;border-radius:6px;object-fit:contain}
.nav-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.badge{padding:3px 10px;border-radius:20px;font-size:0.62rem;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;white-space:nowrap}
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
main{max-width:1100px;margin:0 auto;padding:20px 14px;position:relative;z-index:1}
.page-title{font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--muted);letter-spacing:2px;text-transform:uppercase;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:18px}
.card-sm{padding:12px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px 10px}
.stat-val{font-family:'JetBrains Mono',monospace;font-size:1.5rem;font-weight:600;color:var(--accent);line-height:1}
.stat-val.green{color:var(--green)}.stat-val.red{color:var(--red)}.stat-val.yellow{color:var(--yellow)}
.stat-label{font-size:0.6rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:4px}
.form-group{margin-bottom:14px}
.form-group label{display:block;font-size:0.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:5px}
.form-control{width:100%;background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:9px 12px;color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:0.84rem;outline:none;transition:border-color 0.2s}
.form-control:focus{border-color:var(--accent)}
select.form-control{cursor:pointer}
.alert{padding:10px 14px;border-radius:10px;font-size:0.8rem;margin-bottom:12px}
.alert-error{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.25);color:#dc2626}
.alert-success{background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.25);color:#059669}
.alert-warn{background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.25);color:#92400e}
.alert-info{background:rgba(0,173,238,0.08);border:1px solid rgba(0,173,238,0.2);color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:0.8rem}
th{font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.8px;padding:8px 10px;text-align:left;border-bottom:1px solid var(--border)}
td{padding:9px 10px;border-bottom:1px solid var(--surface);color:var(--text);vertical-align:top}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--surface)}
.chip{display:inline-block;padding:2px 8px;border-radius:20px;font-size:0.62rem;font-weight:600}
.chip-green{background:rgba(52,211,153,0.12);color:#059669}
.chip-red{background:rgba(248,113,113,0.12);color:#dc2626}
.chip-yellow{background:rgba(251,191,36,0.12);color:#92400e}
.chip-blue{background:rgba(0,173,238,0.1);color:var(--accent)}
.chip-gray{background:rgba(107,114,128,0.1);color:var(--muted)}
.chip-purple{background:rgba(167,139,250,0.12);color:#7c3aed}
.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:800;display:none;align-items:center;justify-content:center;padding:14px}
.modal-backdrop.open{display:flex}
.modal{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:22px;width:100%;max-width:480px;box-shadow:0 20px 60px rgba(0,0,0,0.12);max-height:90vh;overflow-y:auto}
.modal-title{font-family:'JetBrains Mono',monospace;font-size:0.62rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between}
.modal-close{background:none;border:none;cursor:pointer;color:var(--muted);font-size:1.2rem;line-height:1}
.modal-close:hover{color:var(--red)}
.tabs{display:flex;gap:3px;background:var(--surface);border-radius:10px;padding:4px;margin-bottom:16px;overflow-x:auto}
.tab{flex:1;text-align:center;padding:7px 8px;border-radius:8px;font-size:0.75rem;font-weight:600;cursor:pointer;border:none;background:transparent;color:var(--muted);transition:all 0.2s;white-space:nowrap;min-width:70px}
.tab.active{background:var(--card);color:var(--accent);box-shadow:0 1px 4px rgba(0,0,0,0.08)}
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
.cal-head{font-size:0.6rem;color:var(--muted);text-align:center;padding:4px;font-weight:600}
.cal-day{min-height:52px;border:1px solid var(--border);border-radius:8px;padding:4px;font-size:0.68rem;cursor:pointer;transition:border-color 0.2s;position:relative;display:flex;flex-direction:column}
.cal-day:hover{border-color:var(--accent)}
.cal-day.today{border-color:var(--accent);background:rgba(0,173,238,0.04)}
.cal-day.holiday{background:rgba(251,191,36,0.08);border-color:var(--yellow)}
.cal-day.other-month{opacity:0.35}
.cal-day-num{font-family:'JetBrains Mono',monospace;font-size:0.7rem;font-weight:600;color:var(--text)}
.cal-day.holiday .cal-day-num{color:#92400e}
.cal-day.today .cal-day-num{color:var(--accent)}
.cal-event{font-size:0.56rem;border-radius:4px;padding:1px 4px;margin-top:2px;font-weight:600;display:block}
.cal-present{background:rgba(52,211,153,0.2);color:#059669}
.cal-absent{background:rgba(248,113,113,0.2);color:#dc2626}
.cal-holiday-tag{background:rgba(251,191,36,0.25);color:#92400e}
.cam-card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.cam-wrap{position:relative;background:#f0f4f8;aspect-ratio:4/3}
.cam-wrap video,.cam-wrap canvas{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.scan-line{position:absolute;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--accent),transparent);animation:scan 3s ease-in-out infinite;opacity:0.4;pointer-events:none}
@keyframes scan{0%{top:0}50%{top:calc(100% - 2px)}100%{top:0}}
.cam-controls{padding:10px 12px;background:var(--surface);display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.btn-checkin{background:var(--accent);color:#fff}.btn-checkin:hover:not(:disabled){background:#009ed8;transform:translateY(-1px)}
.btn-checkin:disabled{opacity:0.5;cursor:not-allowed}
@keyframes livepulse{0%,100%{opacity:1}50%{opacity:0.4}}
.live-dot{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:livepulse 2s infinite;flex-shrink:0}
.result-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:16px}
.result-title{font-family:'JetBrains Mono',monospace;font-size:0.6rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:10px}
.logo-preview{max-height:60px;max-width:150px;border-radius:8px;object-fit:contain;border:1px solid var(--border)}
.notif-modal-icon{width:60px;height:60px;border-radius:50%;background:rgba(0,173,238,0.1);display:flex;align-items:center;justify-content:center;font-size:1.8rem;margin:0 auto 14px}
.switch{position:relative;display:inline-block;width:42px;height:24px}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;cursor:pointer;inset:0;background:#ccc;border-radius:24px;transition:0.3s}
.slider:before{content:'';position:absolute;width:18px;height:18px;left:3px;bottom:3px;background:white;border-radius:50%;transition:0.3s}
input:checked+.slider{background:var(--accent)}
input:checked+.slider:before{transform:translateX(18px)}
/* Shift multiselect */
.shift-select-box{border:1px solid var(--border);border-radius:10px;max-height:160px;overflow-y:auto;background:var(--surface)}
.shift-select-item{display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;transition:background 0.15s;border-bottom:1px solid var(--border);font-size:0.82rem}
.shift-select-item:last-child{border-bottom:none}
.shift-select-item:hover{background:rgba(0,173,238,0.06)}
.shift-select-item input[type=checkbox]{accent-color:var(--accent);width:15px;height:15px;flex-shrink:0}
.shift-select-item.already-done{opacity:0.45;pointer-events:none}
.shift-select-item .shift-badge{font-size:0.62rem;padding:2px 7px;border-radius:20px;background:rgba(0,173,238,0.1);color:var(--accent);font-weight:600;white-space:nowrap}
.shift-select-item .done-badge{font-size:0.62rem;padding:2px 7px;border-radius:20px;background:rgba(52,211,153,0.12);color:#059669;font-weight:600}
/* Table responsive */
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
/* Mobile improvements */
@media(max-width:768px){
  .grid2,.grid3,.grid4{grid-template-columns:1fr}
  .cal-grid{gap:2px}
  .cal-day{min-height:40px}
  .cal-event{font-size:0.5rem;padding:1px 2px}
  main{padding:14px 10px}
  nav{padding:0 12px;height:54px}
  .tabs{gap:2px}
  .tab{font-size:0.7rem;padding:6px 6px;min-width:58px}
  .stat-val{font-size:1.3rem}
  th,td{padding:7px 8px;font-size:0.75rem}
  .modal{padding:16px}
  .btn{padding:7px 12px;font-size:0.76rem}
}
@media(max-width:480px){
  .cal-head{font-size:0.52rem}
  .cal-day{min-height:34px}
  .cam-controls{flex-wrap:wrap;gap:5px}
  .grid2{gap:10px}
  .nav-right .badge{display:none}
}
</style>`;

// ═══════════════════════════════════════════════════════════════════════════════
//  SUPER ADMIN APIs
// ═══════════════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN APIs
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
  const token = signToken({ id: rows[0].id, role: 'admin', name: rows[0].name, email: rows[0].email, org_name: rows[0].org_name });
  res.json({ token, name: rows[0].name, org_name: rows[0].org_name });
});

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
  const r = await dbQuery('INSERT INTO shifts (admin_id,name,start_time,end_time) VALUES (?,?,?,?)', [req.user.id, name, start_time, end_time]);
  res.json({ ok: true, id: r.insertId });
});
app.delete('/api/admin/shifts/:id', authMiddleware('admin'), async (req, res) => {
  await dbQuery('DELETE FROM shifts WHERE id=? AND admin_id=?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ── Faces ─────────────────────────────────────────────────────────────────────
app.get('/api/admin/faces', authMiddleware('admin'), async (req, res) => {
  const rows = await dbQuery(
    `SELECT f.*,s.name as shift_name,
       u.notifications_enabled,
       u.id as user_id
     FROM faces f
     LEFT JOIN shifts s ON s.id=f.shift_id
     LEFT JOIN users u ON u.face_id=f.id AND u.admin_id=f.admin_id
     WHERE f.admin_id=? ORDER BY f.label`,
    [req.user.id]
  );
  // Attach assigned periods for each face
  const faceIds = rows.map(r => r.id);
  let periodMap = {};
  if (faceIds.length) {
    const periods = await dbQuery(
      `SELECT fp.face_id, sh.id as shift_id, sh.name, sh.start_time, sh.end_time
       FROM face_periods fp JOIN shifts sh ON sh.id=fp.shift_id
       WHERE fp.face_id IN (?)`, [faceIds]
    );
    for (const p of periods) {
      if (!periodMap[p.face_id]) periodMap[p.face_id] = [];
      periodMap[p.face_id].push({ id: p.shift_id, name: p.name, start_time: p.start_time, end_time: p.end_time });
    }
  }
  res.json(rows.map(r => ({ ...r, descriptor: JSON.parse(r.descriptor), assigned_periods: periodMap[r.id]||[] })));
});

// ── Get/Set assigned periods for a face ──────────────────────────────────────
app.get('/api/admin/faces/:id/periods', authMiddleware('admin'), async (req, res) => {
  const rows = await dbQuery(
    `SELECT sh.* FROM face_periods fp JOIN shifts sh ON sh.id=fp.shift_id
     WHERE fp.face_id=? AND sh.admin_id=?`, [req.params.id, req.user.id]
  );
  res.json(rows);
});

app.post('/api/admin/faces/:id/periods', authMiddleware('admin'), async (req, res) => {
  const { shift_ids } = req.body; // array of shift IDs
  const faceId = parseInt(req.params.id);
  // Verify face belongs to this admin
  const face = await dbQuery('SELECT id FROM faces WHERE id=? AND admin_id=?', [faceId, req.user.id]);
  if (!face.length) return res.json({ error: 'Face not found' });
  // Replace all periods
  await dbQuery('DELETE FROM face_periods WHERE face_id=?', [faceId]);
  if (shift_ids && shift_ids.length) {
    for (const sid of shift_ids) {
      await dbQuery('INSERT IGNORE INTO face_periods (face_id,shift_id) VALUES (?,?)', [faceId, sid]);
    }
  }
  res.json({ ok: true });
});

app.post('/api/admin/faces', authMiddleware('admin'), async (req, res) => {
  const { label, employee_id, department, shift_id, user_email, user_password, descriptors, accuracy } = req.body;
  if (!label||!descriptors?.length) return res.json({ error: 'Label and descriptors required' });
  if (!user_email) return res.json({ error: 'Email is required for the student account' });
  if (!user_password || user_password.length < 6) return res.json({ error: 'Password must be at least 6 characters' });

  try {
    const avg = descriptors[0].map((_, i) => descriptors.reduce((s, d) => s + d[i], 0) / descriptors.length);
    const r = await dbQuery(
      `INSERT INTO faces (admin_id,label,employee_id,department,shift_id,user_email,descriptor,registration_accuracy)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         employee_id=VALUES(employee_id),department=VALUES(department),
         shift_id=VALUES(shift_id),user_email=VALUES(user_email),
         descriptor=VALUES(descriptor),registration_accuracy=VALUES(registration_accuracy)`,
      [req.user.id, label, employee_id||'', department||'', shift_id||null, user_email,
       JSON.stringify(descriptors), accuracy||null]
    );

    const faceId = r.insertId || (await dbQuery(
      'SELECT id FROM faces WHERE admin_id=? AND label=?', [req.user.id, label]
    ))[0]?.id;

    const hash = await bcrypt.hash(user_password, 12);
    const existingUser = await dbQuery(
      'SELECT id FROM users WHERE email=? AND admin_id=?', [user_email, req.user.id]
    );
    if (existingUser.length) {
      await dbQuery(
        'UPDATE users SET face_id=?, name=?, password=? WHERE email=? AND admin_id=?',
        [faceId, label, hash, user_email, req.user.id]
      );
    } else {
      await dbQuery(
        'INSERT INTO users (admin_id,face_id,name,email,password) VALUES (?,?,?,?,?)',
        [req.user.id, faceId, label, user_email, hash]
      );
    }

    await dbQuery('UPDATE faces SET user_email=? WHERE id=?', [user_email, faceId]);

    // Send push notification to the employee
    const userRow = await dbQuery('SELECT id FROM users WHERE email=? AND admin_id=?', [user_email, req.user.id]);
    if (userRow.length) {
      const isUpdate = existingUser.length > 0;
      const pushTitle = isUpdate ? '✏️ Profile Updated' : '🎉 Account Created';
      const pushBody  = isUpdate
        ? `${label}, your profile details have been updated by your admin.`
        : `${label}, your account has been registered. You can now log in with ${user_email}.`;
      await sendPushToUser(userRow[0].id, pushTitle, pushBody, req.user.id);
    }

    res.json({ ok: true });
  } catch(e) {
    if (e.code === 'ER_DUP_ENTRY') return res.json({ error: 'A person with this name or email already exists' });
    res.json({ error: e.message });
  }
});

app.delete('/api/admin/faces/:id', authMiddleware('admin'), async (req, res) => {
  const face = await dbQuery('SELECT user_email FROM faces WHERE id=? AND admin_id=?', [req.params.id, req.user.id]);
  if (face.length && face[0].user_email) {
    await dbQuery('DELETE FROM users WHERE email=? AND admin_id=?', [face[0].user_email, req.user.id]);
  }
  await dbQuery('DELETE FROM faces WHERE id=? AND admin_id=?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ── Users management (admin) ──────────────────────────────────────────────────
app.get('/api/admin/users', authMiddleware('admin'), async (req, res) => {
  const rows = await dbQuery(
    `SELECT u.id, u.name, u.email, u.notifications_enabled, u.created_at,
       f.label as face_label, f.employee_id, f.department, s.name as shift_name
     FROM users u
     LEFT JOIN faces f ON f.id=u.face_id
     LEFT JOIN shifts s ON s.id=f.shift_id
     WHERE u.admin_id=? ORDER BY u.name`,
    [req.user.id]
  );
  res.json(rows);
});

app.delete('/api/admin/users/:id', authMiddleware('admin'), async (req, res) => {
  // Unlink face first, then delete user
  await dbQuery('UPDATE faces SET user_email=NULL WHERE user_email=(SELECT email FROM users WHERE id=? AND admin_id=?)', [req.params.id, req.user.id]);
  await dbQuery('DELETE FROM users WHERE id=? AND admin_id=?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

app.put('/api/admin/users/:id/reset-password', authMiddleware('admin'), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.json({ error: 'Password min 6 chars' });
  const hash = await bcrypt.hash(password, 12);
  await dbQuery('UPDATE users SET password=? WHERE id=? AND admin_id=?', [hash, req.params.id, req.user.id]);
  // Notify the user their password was changed
  const uRow = await dbQuery('SELECT name FROM users WHERE id=? AND admin_id=?', [req.params.id, req.user.id]);
  if (uRow.length) await sendPushToUser(parseInt(req.params.id), '🔑 Password Changed', `${uRow[0].name}, your login password has been reset by your admin.`, req.user.id);
  res.json({ ok: true });
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

// ── Export attendance CSV ─────────────────────────────────────────────────────
app.get('/api/admin/attendance/export', authMiddleware('admin'), async (req, res) => {
  const { month, year, format } = req.query;
  let where = 'a.admin_id=?', params = [req.user.id];
  if (month && year) {
    where += ' AND MONTH(a.date)=? AND YEAR(a.date)=?';
    params.push(parseInt(month), parseInt(year));
  }
  const rows = await dbQuery(
    `SELECT a.name, a.date, a.time_in, a.time_out, a.status, s.name as shift_name, a.face_id
     FROM attendance a
     LEFT JOIN shifts s ON s.id=a.shift_id
     WHERE ${where} ORDER BY a.date DESC, a.name`,
    params
  );

  const headers = ['Name','Date','Period','Time In','Time Out','Status'];
  const csvRows = rows.map(r => [
    r.name, r.date, r.shift_name||'', r.time_in||'', r.time_out||'', r.status
  ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(','));

  const csv = [headers.join(','), ...csvRows].join('\n');
  const filename = `attendance_${month||'all'}_${year||new Date().getFullYear()}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

// ── Per-person attendance for Records tab ─────────────────────────────────────
app.get('/api/admin/person-attendance', authMiddleware('admin'), async (req, res) => {
  const { face_id, month, year } = req.query;
  if (!face_id) return res.json({ error: 'face_id required' });
  const m = parseInt(month), y = parseInt(year);
  const [attend, holidays] = await Promise.all([
    dbQuery(
      `SELECT a.date, a.time_in, a.time_out, a.status, s.name as shift_name
       FROM attendance a
       LEFT JOIN shifts s ON s.id=a.shift_id
       WHERE a.admin_id=? AND a.face_id=? AND MONTH(a.date)=? AND YEAR(a.date)=?
       ORDER BY a.date, a.time_in`,
      [req.user.id, face_id, m, y]
    ),
    dbQuery(
      'SELECT date, label FROM holidays WHERE admin_id=? AND MONTH(date)=? AND YEAR(date)=?',
      [req.user.id, m, y]
    )
  ]);
  res.json({ attendance: attend, holidays });
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

// ── Scan — returns matched face + pending shifts ──────────────────────────────
app.post('/api/admin/scan', authMiddleware('admin'), async (req, res) => {
  const { descriptor: inDesc, mode } = req.body;
  if (!inDesc?.length) return res.json({ event: 'error', message: 'No descriptor' });

  const adminId = req.user.id;
  const faces = await dbQuery('SELECT id,label,shift_id,user_email,descriptor FROM faces WHERE admin_id=?', [adminId]);
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

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = pad2(now.getHours())+':'+pad2(now.getMinutes())+':'+pad2(now.getSeconds());

  // Get all shifts for this admin
  const allShifts = await dbQuery('SELECT * FROM shifts WHERE admin_id=? ORDER BY start_time', [adminId]);

  // Get today's attendance for this face (all shifts)
  const todayAtt = await dbQuery(
    'SELECT * FROM attendance WHERE face_id=? AND date=?', [best.id, dateStr]
  );
  const markedShiftIds = todayAtt.map(a => a.shift_id);

  // Pending shifts = shifts not yet marked today
  const pendingShifts = allShifts.filter(s => !markedShiftIds.includes(s.id));

  // Also check if there's a "no-shift" attendance (shift_id IS NULL)
  const hasNoShiftAttendance = todayAtt.some(a => a.shift_id === null);

  if (mode === 'checkout') {
    // Checkout: update time_out for latest check-in without time_out
    const openAtt = todayAtt.filter(a => !a.time_out);
    if (!openAtt.length) return res.json({ event: 'not_checked_in', name: best.label });
    // Update all open attendances (or just the first one)
    await dbQuery('UPDATE attendance SET time_out=? WHERE id=?', [timeStr, openAtt[0].id]);
    if (best.user_email) {
      const user = await dbQuery('SELECT id FROM users WHERE email=? AND admin_id=?', [best.user_email, adminId]);
      if (user.length) await sendPushToUser(user[0].id, '👋 Checked Out', `${best.label}, you checked out at ${fmtTime(timeStr)}`, adminId);
    }
    return res.json({ event: 'checkout', name: best.label, time_out: timeStr });
  }

  // Get this face's assigned periods
  const assignedPeriods = await dbQuery(
    `SELECT shift_id FROM face_periods WHERE face_id=?`, [best.id]
  );
  const assignedPeriodIds = assignedPeriods.map(p => p.shift_id);

  // Auto-select: only pending shifts that are in the student's assigned periods
  const autoSelectShifts = pendingShifts.filter(s => assignedPeriodIds.includes(s.id));

  // Return face info + pending shifts for the frontend to display multiselect
  return res.json({
    event: 'face_identified',
    name: best.label,
    face_id: best.id,
    user_email: best.user_email,
    distance: bestDist,
    pending_shifts: pendingShifts,
    all_shifts: allShifts,
    marked_shift_ids: markedShiftIds,
    has_no_shift_attendance: hasNoShiftAttendance,
    today_attendance: todayAtt,
    assigned_period_ids: assignedPeriodIds,
    auto_select_shift_ids: autoSelectShifts.map(s => s.id)
  });
});

// ── Mark attendance for selected shifts (after face scan) ─────────────────────
app.post('/api/admin/mark-attendance', authMiddleware('admin'), async (req, res) => {
  const { face_id, shift_ids } = req.body; // shift_ids: array, empty = no-shift mark
  if (!face_id) return res.json({ error: 'face_id required' });

  const adminId = req.user.id;
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = pad2(now.getHours())+':'+pad2(now.getMinutes())+':'+pad2(now.getSeconds());

  const face = await dbQuery('SELECT * FROM faces WHERE id=? AND admin_id=?', [face_id, adminId]);
  if (!face.length) return res.json({ error: 'Face not found' });
  const f = face[0];

  const results = [];
  const shiftsToMark = (shift_ids && shift_ids.length > 0) ? shift_ids : [null];

  for (const shiftId of shiftsToMark) {
    // Check duplicate
    const existing = await dbQuery(
      'SELECT id FROM attendance WHERE face_id=? AND date=? AND (shift_id=? OR (shift_id IS NULL AND ? IS NULL))',
      [face_id, dateStr, shiftId, shiftId]
    );
    if (existing.length) {
      results.push({ shift_id: shiftId, skipped: true, reason: 'Already marked' });
      continue;
    }

    const shiftRow = shiftId ? (await dbQuery('SELECT * FROM shifts WHERE id=?', [shiftId]))[0] : null;

    const r = await dbQuery(
      'INSERT INTO attendance (admin_id,face_id,shift_id,name,date,time_in,status) VALUES (?,?,?,?,?,?,?)',
      [adminId, face_id, shiftId||null, f.label, dateStr, timeStr, 'present']
    );

    if (f.user_email) {
      const user = await dbQuery('SELECT id FROM users WHERE email=? AND admin_id=?', [f.user_email, adminId]);
      if (user.length) {
        const shiftInfo = shiftRow ? ` (${shiftRow.name} period)` : '';
        await sendPushToUser(user[0].id, '✅ Attendance Marked', `${f.label}, your attendance was recorded at ${fmtTime(timeStr)}${shiftInfo}`, adminId);
        await dbQuery('UPDATE attendance SET notification_sent=1 WHERE id=?', [r.insertId]);
      }
    }
    results.push({ shift_id: shiftId, shift_name: shiftRow?.name||null, time_in: timeStr, ok: true });
  }

  res.json({ event: 'marked', name: f.label, results, time_in: timeStr });
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

// ═══════════════════════════════════════════════════════════════════════════════
//  USER APIs
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
       WHERE ${where} ORDER BY a.date DESC, a.time_in`,
      params
    ),
    dbQuery(
      'SELECT date, label FROM holidays WHERE admin_id=? AND MONTH(date)=? AND YEAR(date)=?',
      [req.user.admin_id, parseInt(month), parseInt(year)]
    )
  ]);
  res.json({ attendance: attend, holidays });
});

app.get('/api/user/notif-status', authMiddleware('user'), async (req, res) => {
  const rows = await dbQuery('SELECT notifications_enabled FROM users WHERE id=?', [req.user.id]);
  res.json({ enabled: rows[0]?.notifications_enabled === 1 });
});

app.get('/api/vapid-public', (_, res) => res.json({ key: VAPID.public }));

// ── Service worker + icon ─────────────────────────────────────────────────────
app.get('/sw.js', (_, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(`
'use strict';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
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

// ═══════════════════════════════════════════════════════════════════════════════
//  HTML helpers
// ═══════════════════════════════════════════════════════════════════════════════
function htmlBase(title, body, extraHead='') {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escH(title)} — FaceAttend</title>
${SHARED_CSS}${extraHead}
</head><body>${body}</body></html>`;
}

app.get('/', (_, res) => res.redirect('/portal'));

// ═══════════════════════════════════════════════════════════════════════════════
//  PORTAL PAGE
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/portal', (_, res) => {
  res.send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FaceAttend — Portal</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;700&display=swap">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --accent:#00adee;
    --accent-dark:#0090c8;
    --accent-glow:rgba(0,173,238,0.25);
    --text:#0f172a;
    --muted:#64748b;
    --surface:#f0f9ff;
    --border:rgba(0,173,238,0.15);
    --card:#ffffff;
  }
  body{font-family:'DM Sans',sans-serif;background:#f8fcff;color:var(--text);min-height:100vh;overflow-x:hidden}
  .bg-mesh{position:fixed;inset:0;z-index:0;background:radial-gradient(ellipse 60% 40% at 20% 10%,rgba(0,173,238,0.12) 0%,transparent 60%),radial-gradient(ellipse 50% 60% at 80% 80%,rgba(0,173,238,0.08) 0%,transparent 60%);pointer-events:none}
  .bg-grid{position:fixed;inset:0;z-index:0;background-image:linear-gradient(rgba(0,173,238,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(0,173,238,0.04) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;mask-image:radial-gradient(ellipse 80% 80% at 50% 50%,black 30%,transparent 100%)}
  .portal-wrap{position:relative;z-index:1;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:80px 20px 40px}
  .top-bar{position:fixed;top:0;left:0;right:0;z-index:10;display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:58px;background:rgba(248,252,255,0.9);backdrop-filter:blur(16px);border-bottom:1px solid rgba(0,173,238,0.1)}
  .top-brand{display:flex;align-items:center;gap:10px;font-family:'Syne',sans-serif;font-weight:800;font-size:1.05rem;color:var(--text);text-decoration:none}
  .brand-icon{width:32px;height:32px;border-radius:8px;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:1rem;color:white;box-shadow:0 4px 12px var(--accent-glow)}
  .top-version{font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--accent);background:rgba(0,173,238,0.1);padding:3px 10px;border-radius:20px;letter-spacing:1px}
  .hero{text-align:center;margin-bottom:48px;animation:fadeUp 0.7s ease both}
  .hero-eyebrow{font-family:'JetBrains Mono',monospace;font-size:0.62rem;color:var(--accent);letter-spacing:3px;text-transform:uppercase;margin-bottom:14px;display:inline-flex;align-items:center;gap:8px}
  .hero-eyebrow::before,.hero-eyebrow::after{content:'';display:block;width:20px;height:1px;background:var(--accent);opacity:0.5}
  .hero-title{font-family:'Syne',sans-serif;font-weight:800;font-size:clamp(2rem,5vw,3.4rem);line-height:1.05;letter-spacing:-2px;color:var(--text);margin-bottom:14px}
  .hero-title .hl{color:var(--accent)}
  .hero-sub{font-size:0.96rem;color:var(--muted);font-weight:400;max-width:420px;margin:0 auto;line-height:1.6}
  .cards-row{display:flex;gap:18px;flex-wrap:wrap;justify-content:center;animation:fadeUp 0.7s 0.15s ease both}
  .portal-card{background:var(--card);border:1px solid rgba(0,173,238,0.12);border-radius:20px;padding:26px 22px;width:210px;text-align:center;text-decoration:none;cursor:pointer;position:relative;overflow:hidden;transition:transform 0.25s,box-shadow 0.25s,border-color 0.25s;box-shadow:0 2px 12px rgba(0,0,0,0.04)}
  .portal-card::before{content:'';position:absolute;inset:0;background:radial-gradient(circle at 50% 0%,rgba(0,173,238,0.07),transparent 70%);opacity:0;transition:opacity 0.3s}
  .portal-card:hover{transform:translateY(-6px);box-shadow:0 16px 40px rgba(0,173,238,0.15),0 4px 12px rgba(0,0,0,0.06);border-color:rgba(0,173,238,0.4)}
  .portal-card:hover::before{opacity:1}
  .card-icon-wrap{width:58px;height:58px;border-radius:16px;margin:0 auto 14px;display:flex;align-items:center;justify-content:center;font-size:1.5rem;transition:transform 0.25s}
  .portal-card:hover .card-icon-wrap{transform:scale(1.1)}
  .icon-sa{background:linear-gradient(135deg,rgba(167,139,250,0.2),rgba(139,92,246,0.12));border:1px solid rgba(139,92,246,0.2)}
  .icon-admin{background:linear-gradient(135deg,rgba(0,173,238,0.2),rgba(0,173,238,0.08));border:1px solid rgba(0,173,238,0.2)}
  .icon-user{background:linear-gradient(135deg,rgba(52,211,153,0.2),rgba(52,211,153,0.08));border:1px solid rgba(52,211,153,0.2)}
  .card-title{font-family:'Syne',sans-serif;font-weight:700;font-size:0.98rem;color:var(--text);margin-bottom:6px}
  .card-desc{font-size:0.73rem;color:var(--muted);line-height:1.5}
  .card-cta{display:inline-flex;align-items:center;gap:5px;margin-top:14px;padding:7px 16px;border-radius:8px;font-size:0.73rem;font-weight:600;transition:all 0.2s;color:white}
  .cta-sa{background:linear-gradient(135deg,#7c3aed,#a78bfa)}
  .cta-admin{background:linear-gradient(135deg,#009ed8,var(--accent))}
  .cta-user{background:linear-gradient(135deg,#059669,#34d399)}
  .portal-card:hover .card-cta{filter:brightness(1.1)}
  .features{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:44px;animation:fadeUp 0.7s 0.3s ease both}
  .feat{display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:20px;background:white;border:1px solid rgba(0,173,238,0.12);font-size:0.7rem;color:var(--muted);font-weight:500;box-shadow:0 1px 4px rgba(0,0,0,0.04)}
  .feat-dot{width:5px;height:5px;border-radius:50%;background:var(--accent)}
  .portal-footer{margin-top:44px;font-size:0.68rem;color:var(--muted);display:flex;align-items:center;gap:6px;animation:fadeUp 0.7s 0.4s ease both}
  .portal-footer a{color:var(--accent);text-decoration:none}
  @keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
  @media(max-width:640px){.cards-row{gap:12px}.portal-card{width:100%;max-width:300px;padding:20px 18px}.hero-title{font-size:1.9rem}}
</style>
</head>
<body>
  <div class="bg-mesh"></div>
  <div class="bg-grid"></div>
  <div class="top-bar">
    <a class="top-brand" href="/portal"><div class="brand-icon">👁</div>FaceAttend</a>
    <span class="top-version">SaaS v4.0</span>
  </div>
  <div class="portal-wrap">
    <div class="hero">
      <div class="hero-eyebrow">Multi-tenant Platform</div>
      <h1 class="hero-title">Face Recognition<br><span class="hl">Attendance</span> System</h1>
      <p class="hero-sub">Automated attendance tracking powered by real-time face recognition. Choose your portal to get started.</p>
    </div>
    <div class="cards-row">
      <a href="/super-admin" class="portal-card">
        <div class="card-icon-wrap icon-sa">🛡️</div>
        <div class="card-title">Super Admin</div>
        <div class="card-desc">Platform control, admin approvals &amp; system-wide oversight.</div>
        <div class="card-cta cta-sa">Enter Portal →</div>
      </a>
      <a href="/admin" class="portal-card">
        <div class="card-icon-wrap icon-admin">🏢</div>
        <div class="card-title">Admin</div>
        <div class="card-desc">Manage people, periods, scan attendance &amp; export reports.</div>
        <div class="card-cta cta-admin">Enter Portal →</div>
      </a>
      <a href="/user" class="portal-card">
        <div class="card-icon-wrap icon-user">👤</div>
        <div class="card-title">Student</div>
        <div class="card-desc">View your attendance calendar and enable push notifications.</div>
        <div class="card-cta cta-user">Enter Portal →</div>
      </a>
    </div>
    <div class="features">
      <div class="feat"><div class="feat-dot"></div>Real-time Face Recognition</div>
      <div class="feat"><div class="feat-dot"></div>Multi-period Attendance</div>
      <div class="feat"><div class="feat-dot"></div>Web Push Notifications</div>
      <div class="feat"><div class="feat-dot"></div>Export CSV/Excel</div>
      <div class="feat"><div class="feat-dot"></div>Holiday Calendar</div>
      <div class="feat"><div class="feat-dot"></div>Multi-tenant SaaS</div>
    </div>
    <div class="portal-footer">
      <span>Powered by</span><a href="#">face-api.js</a><span>·</span><a href="#">Node.js</a><span>·</span><a href="#">MySQL</a>
    </div>
  </div>
</body></html>`);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  SUPER ADMIN PAGE
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
        <span style="font-weight:700">Registered Organisations</span>
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

  const total=admins.length,approved=admins.filter(a=>a.status==='approved').length,
        pending=admins.filter(a=>a.status==='pending').length,
        totalUsers=admins.reduce((s,a)=>s+(a.user_count||0),0);
  document.getElementById('statsRow').innerHTML=\`
    <div class="stat"><div class="stat-val">\${total}</div><div class="stat-label">Total Orgs</div></div>
    <div class="stat"><div class="stat-val green">\${approved}</div><div class="stat-label">Approved</div></div>
    <div class="stat"><div class="stat-val yellow">\${pending}</div><div class="stat-label">Pending</div></div>
    <div class="stat"><div class="stat-val">\${totalUsers}</div><div class="stat-label">Students</div></div>
  \`;
  const rows=admins.map(a=>\`
    <tr>
      <td><strong>\${a.org_name}</strong><br><span style="color:var(--muted);font-size:0.7rem">\${a.email}</span></td>
      <td><span class="chip chip-gray">\${a.org_type}</span></td>
      <td><span class="chip chip-\${a.status==='approved'?'green':a.status==='pending'?'yellow':a.status==='rejected'?'red':'gray'}">\${a.status}</span></td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:0.75rem">\${a.face_count||0}👥 / \${a.user_count||0}🔑</td>
      <td><span class="chip chip-blue">\${a.notif_count||0} 🔔</span></td>
      <td style="font-weight:600">\${a.today_attendance||0}</td>
      <td style="white-space:nowrap">
        \${a.status!=='approved'?'<button class="btn btn-sm btn-success" onclick="setStatus('+a.id+',\\'approved\\')">✅ Approve</button>':
          '<button class="btn btn-sm btn-danger" onclick="setStatus('+a.id+',\\'suspended\\')">⏸ Suspend</button>'}
        \${a.status==='pending'||a.status==='suspended'?'<button class="btn btn-sm btn-danger" style="margin-top:3px" onclick="setStatus('+a.id+',\\'rejected\\')">✕ Reject</button>':''}
      </td>
    </tr>
  \`).join('');
  document.getElementById('adminTable').innerHTML=\`
    <table>
      <thead><tr><th>Organisation</th><th>Type</th><th>Status</th><th>Faces/Users</th><th>Notif</th><th>Today</th><th>Action</th></tr></thead>
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
//  ADMIN PAGE
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
      <button class="tab" onclick="switchAuthTab('register',this)">Register Org</button>
    </div>
    <div id="loginPanel" class="card">
      <div id="loginErr" class="alert alert-error" style="display:none"></div>
      <div class="form-group"><label>Email</label><input class="form-control" id="aEmail" type="email"></div>
      <div class="form-group"><label>Password</label><input class="form-control" id="aPass" type="password"></div>
      <button class="btn btn-primary" style="width:100%" onclick="doAdminLogin()">Login</button>
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
        <div class="form-group"><label>Organisation Name</label><input class="form-control" id="rOrg" placeholder="ABC School"></div>
      </div>
      <div class="grid2">
        <div class="form-group">
          <label>Organisation Type</label>
          <select class="form-control" id="rType">
            <option value="office">Office</option><option value="school">School</option>
            <option value="hospital">Hospital</option><option value="factory">Factory</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div class="form-group"><label>System Title</label><input class="form-control" id="rTitle" placeholder="Daily Attendance"></div>
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
      <button class="tab" onclick="switchTab('faces',this)">👥 People</button>
      <button class="tab" onclick="switchTab('shifts',this)">⏰ Periods</button>
      <button class="tab" onclick="switchTab('users',this)">🔑 Users</button>
      <button class="tab" onclick="switchTab('reports',this)">📊 Reports</button>
      <button class="tab" onclick="switchTab('calendar',this)">📅 Calendar</button>
      <button class="tab" onclick="switchTab('records',this)">🗂 Records</button>
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
              <div style="flex:1;display:flex;align-items:center;gap:8px;font-size:0.72rem;color:var(--muted);min-width:0">
                <div class="live-dot" id="statusDot" style="background:var(--muted)"></div>
                <span id="statusText" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Starting camera...</span>
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
          <div id="modelErrorBanner" style="display:none;margin-top:10px;padding:10px 14px;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);border-radius:10px;font-size:0.78rem;color:var(--red);display:flex;align-items:center;justify-content:space-between;gap:10px">
            <span>⚠️ Face recognition models are corrupted or missing. Click to fix.</span>
            <button class="btn btn-sm btn-danger" onclick="reloadModels()">🔄 Fix Models</button>
          </div>
        </div>
        <div>
          <div class="result-card" id="resultCard">
            <div class="result-title">Scan Result</div>
            <div id="resultBody" style="color:var(--muted);font-size:0.82rem;text-align:center;padding:20px 0">Scan a face to see results here.</div>
          </div>
          <div class="card" style="margin-top:12px">
            <div style="font-size:0.7rem;font-weight:700;margin-bottom:10px;color:var(--muted);text-transform:uppercase;letter-spacing:1px">Today's Attendance</div>
            <div id="todayList" style="max-height:280px;overflow-y:auto;font-size:0.78rem"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- PEOPLE TAB -->
    <div id="tab-faces" style="display:none">
      <div class="grid2" style="gap:14px;align-items:start">
        <div class="card">
          <div style="font-weight:700;margin-bottom:12px;font-size:0.95rem">Register New Person</div>
          <div class="alert alert-info" style="font-size:0.73rem;margin-bottom:12px">
            📌 This creates both the <strong>face profile</strong> and the <strong>student login account</strong> in one step.
          </div>
          <div class="cam-card" style="margin-bottom:12px">
            <div class="cam-wrap"><video id="regVideo" autoplay muted playsinline></video><canvas id="regOverlay"></canvas></div>
            <div class="cam-controls" style="justify-content:space-between">
              <span id="regStatus" style="font-size:0.7rem;color:var(--muted)">Camera ready</span>
              <button class="btn btn-primary btn-sm" id="captureBtn" onclick="captureSample()" disabled>Capture Sample</button>
            </div>
          </div>
          <div class="grid2">
            <div class="form-group"><label>Full Name</label><input class="form-control" id="fName" placeholder="Student Name"></div>
            <div class="form-group"><label>Student ID</label><input class="form-control" id="fEmpId" placeholder="STU001"></div>
          </div>
          <div class="form-group">
            <label>Department</label><input class="form-control" id="fDept" placeholder="Engineering">
          </div>
          <div class="form-group">
            <label>Assigned Periods <span style="font-size:0.68rem;color:var(--muted)">(select all that apply)</span></label>
            <div id="fPeriodsBox" style="border:1px solid var(--border);border-radius:8px;padding:8px;max-height:140px;overflow-y:auto;background:var(--surface)">
              <div style="color:var(--muted);font-size:0.75rem">No periods defined yet. Add periods first.</div>
            </div>
          </div>
          <div style="border-top:1px solid var(--border);padding-top:12px;margin-bottom:12px">
            <div style="font-size:0.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px;font-weight:600">Login Account</div>
            <div class="grid2">
              <div class="form-group"><label>Email</label><input class="form-control" id="fUserEmail" type="email" placeholder="student@school.com"></div>
              <div class="form-group"><label>Password</label><input class="form-control" id="fUserPassword" type="password" placeholder="Min. 6 chars"></div>
            </div>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <span id="sampleCount" style="font-size:0.73rem;color:var(--muted)">0 / 10 samples</span>
            <button class="btn btn-outline btn-sm" onclick="clearSamples()">Clear</button>
          </div>
          <div id="regSampleBar" style="height:5px;background:var(--border);border-radius:4px;margin-bottom:12px">
            <div id="sampleProgress" style="height:100%;background:var(--accent);border-radius:4px;width:0%;transition:width 0.3s"></div>
          </div>
          <div id="regErr" class="alert alert-error" style="display:none"></div>
          <div id="regOk2" class="alert alert-success" style="display:none"></div>
          <button class="btn btn-primary" style="width:100%" id="saveBtn" onclick="saveFace()" disabled>💾 Save Person &amp; Create Account</button>
        </div>
        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <span style="font-weight:700">Registered People</span>
            <span id="faceCount" class="chip chip-blue"></span>
          </div>
          <div id="faceList"></div>
        </div>
      </div>
    </div>

    <!-- SHIFTS TAB -->
    <div id="tab-shifts" style="display:none">
      <div class="grid2" style="gap:14px;align-items:start">
        <div class="card">
          <div style="font-weight:700;margin-bottom:14px">Add Period</div>
          <div class="form-group"><label>Period Name</label><input class="form-control" id="shName" placeholder="Morning / Night / A / B"></div>
          <div class="grid2">
            <div class="form-group"><label>Start Time</label><input class="form-control" id="shStart" type="time"></div>
            <div class="form-group"><label>End Time</label><input class="form-control" id="shEnd" type="time"></div>
          </div>
          <div id="shErr" class="alert alert-error" style="display:none"></div>
          <button class="btn btn-primary" style="width:100%" onclick="addShift()">➕ Add Period</button>
        </div>
        <div class="card">
          <div style="font-weight:700;margin-bottom:14px">Your Periods</div>
          <div id="shiftList"></div>
        </div>
      </div>
    </div>

    <!-- USERS TAB -->
    <div id="tab-users" style="display:none">
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px">
          <span style="font-weight:700">Student Accounts</span>
          <span id="userCount" class="chip chip-blue"></span>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Dept / Period</th><th>Notifications</th><th>Joined</th><th>Actions</th></tr></thead>
            <tbody id="userTableBody"><tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">Loading...</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- REPORTS TAB -->
    <div id="tab-reports" style="display:none">
      <div class="card">
        <div style="font-weight:700;margin-bottom:16px;font-size:0.95rem">📊 Export Attendance Records</div>
        <div class="grid2" style="margin-bottom:16px">
          <div class="form-group">
            <label>Month</label>
            <select class="form-control" id="expMonth">
              <option value="1">January</option><option value="2">February</option><option value="3">March</option><option value="4">April</option><option value="5">May</option><option value="6">June</option><option value="7">July</option><option value="8">August</option><option value="9">September</option><option value="10">October</option><option value="11">November</option><option value="12">December</option>
            </select>
          </div>
          <div class="form-group">
            <label>Year</label>
            <input class="form-control" type="number" id="expYear" value="${new Date().getFullYear()}" min="2020" max="2030">
          </div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn btn-primary" onclick="exportAttendance('csv')">⬇️ Export CSV</button>
          <button class="btn btn-outline" onclick="previewReport()">👁 Preview</button>
        </div>
        <div id="reportPreview" style="margin-top:18px"></div>
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
        <div style="font-size:0.7rem;color:var(--muted);margin-bottom:10px">Click a date to manage holidays.</div>
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

    <!-- RECORDS TAB -->
    <div id="tab-records" style="display:none">
      <div class="grid2" style="gap:14px;align-items:start">
        <div class="card">
          <div style="font-weight:700;margin-bottom:14px;font-size:0.95rem">🗂 Person-wise Records</div>
          <div id="recordsPeopleList"></div>
        </div>
        <div id="recordsCalPanel" style="display:none">
          <div class="card">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
              <button class="btn btn-outline btn-sm" onclick="recChangeMonth(-1)">&#8249; Prev</button>
              <span id="recCalTitle" style="font-weight:700;flex:1;text-align:center"></span>
              <button class="btn btn-outline btn-sm" onclick="recChangeMonth(1)">Next &#8250;</button>
            </div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap">
              <div style="width:10px;height:10px;border-radius:50%;background:var(--green);flex-shrink:0"></div><span style="font-size:0.72rem;color:var(--muted)">Present</span>
              <div style="width:10px;height:10px;border-radius:50%;background:var(--red);flex-shrink:0;margin-left:8px"></div><span style="font-size:0.72rem;color:var(--muted)">Absent</span>
              <div style="width:10px;height:10px;border-radius:50%;background:var(--yellow);flex-shrink:0;margin-left:8px"></div><span style="font-size:0.72rem;color:var(--muted)">Holiday</span>
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px" id="recStats"></div>
            <div class="cal-grid" id="recCalHead"></div>
            <div class="cal-grid" style="margin-top:4px" id="recCalGrid"></div>
          </div>
        </div>
      </div>
    </div>

  </div><!-- /dashboard -->
</main>

<!-- Shift Selection Modal -->
<div id="shiftModal" class="modal-backdrop">
  <div class="modal" style="max-width:420px">
    <div class="modal-title">
      <span id="shiftModalTitle">Select Periods to Mark</span>
      <button class="modal-close" onclick="dismissShiftModal()">✕</button>
    </div>
    <div id="shiftModalFaceName" style="font-size:1rem;font-weight:700;margin-bottom:6px;color:var(--accent)"></div>
    <div style="font-size:0.75rem;color:var(--muted);margin-bottom:14px" id="shiftModalTime"></div>

    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="btn btn-sm btn-outline" onclick="selectAllShifts()">Select All</button>
      <button class="btn btn-sm btn-outline" onclick="clearShiftSelection()">Clear</button>
    </div>

    <div class="shift-select-box" id="shiftCheckboxList"></div>

    <div style="margin-top:14px;display:flex;gap:10px">
      <button class="btn btn-primary" style="flex:1" onclick="confirmShiftMark()">✅ Mark Attendance</button>
      <button class="btn btn-outline" onclick="dismissShiftModal()">Cancel</button>
    </div>
  </div>
</div>

<script src="/faceapi.js"></script>
<script>
const TOKEN_KEY='admin_token';
let adminToken=localStorage.getItem(TOKEN_KEY);

function showToast(msg){
  const t=document.createElement('div');
  t.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1f2937;color:white;padding:12px 20px;border-radius:12px;font-size:0.8rem;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.2);transition:opacity 0.4s;max-width:90vw;text-align:center';
  t.textContent=msg;
  document.body.appendChild(t);
  setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),400);},4000);
}
let adminShifts=[],adminFaces=[],regSamples=[],autoMode=false,autoTimer=null;
let calYear=new Date().getFullYear(),calMonth=new Date().getMonth()+1;
let calData={attendance:[],holidays:[]},selectedCalDate=null;
let pendingScanResult=null; // holds face_identified result waiting for shift selection

function switchAuthTab(t,btn){
  document.querySelectorAll('.tabs .tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('loginPanel').style.display=t==='login'?'block':'none';
  document.getElementById('registerPanel').style.display=t==='register'?'block':'none';
}

function previewLogo(input){
  const f=input.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=e=>{const img=document.getElementById('logoPreview');img.src=e.target.result;img.style.display='block';};
  r.readAsDataURL(f);
}

async function doAdminLogin(){
  const e=document.getElementById('aEmail').value,p=document.getElementById('aPass').value;
  const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:p})}).then(x=>x.json());
  if(r.error){document.getElementById('loginErr').textContent=r.error;document.getElementById('loginErr').style.display='block';return;}
  adminToken=r.token;localStorage.setItem(TOKEN_KEY,adminToken);
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
    logo_base64:logo&&logo.startsWith('data:')?logo:null
  };
  const r=await fetch('/api/admin/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(x=>x.json());
  if(r.error){document.getElementById('regErr').textContent=r.error;document.getElementById('regErr').style.display='block';return;}
  document.getElementById('regOk').textContent=r.message||'Submitted! Await approval.';
  document.getElementById('regOk').style.display='block';
}

function adminLogout(){localStorage.removeItem(TOKEN_KEY);location.reload();}

async function showDashboard(r){
  document.getElementById('authSection').style.display='none';
  document.getElementById('dashboard').style.display='block';
  const me=r||await fetch('/api/admin/me',{headers:{'x-token':adminToken}}).then(x=>x.json()).catch(()=>null);
  if(!me||me.error){localStorage.removeItem(TOKEN_KEY);location.reload();return;}
  let logoHtml='';
  if(me.logo_base64) logoHtml=\`<img src="\${me.logo_base64}" class="logo-preview" style="height:30px;margin-right:6px">\`;
  document.getElementById('navLogo').innerHTML=logoHtml+'Face<span style="color:var(--accent)">Attend</span>';
  document.getElementById('navRight').innerHTML=\`
    <span style="font-size:0.73rem;color:var(--muted);display:none;display:inline" class="hide-xs">\${me.org_name||''}</span>
    <span class="badge badge-admin">Admin</span>
    <button class="btn btn-sm btn-outline" onclick="adminLogout()">Logout</button>\`;
  loadShifts();loadFaceList();loadScanTab();startCamera('video','overlay',true);
  // set report month to current
  document.getElementById('expMonth').value=new Date().getMonth()+1;
}

function switchTab(t,btn){
  document.querySelectorAll('#dashTabs .tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  ['scan','faces','shifts','users','reports','calendar','records'].forEach(tab=>{
    document.getElementById('tab-'+tab).style.display=tab===t?'block':'none';
  });
  if(t==='faces') startCamera('regVideo','regOverlay',false);
  if(t==='calendar') renderCalendar();
  if(t==='users') loadUsers();
  if(t==='records') loadRecordsPeople();
}

let streams={};
async function startCamera(videoId,overlayId,isScan){
  if(streams[videoId]) return;
  try{
    const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'}});
    streams[videoId]=stream;
    const v=document.getElementById(videoId);v.srcObject=stream;
    await new Promise(r=>v.addEventListener('loadedmetadata',r,{once:true}));
    if(isScan){
      document.getElementById('scanBtn').disabled=false;
      document.getElementById('statusDot').style.background='var(--accent)';
      document.getElementById('statusText').textContent='Camera ready — press Scan';
    } else {
      document.getElementById('captureBtn').disabled=false;
      document.getElementById('regStatus').textContent='Camera ready — capture 10 samples';
    }
  }catch(e){
    const el=document.getElementById(isScan?'statusText':'regStatus');
    if(el) el.textContent='Camera error: '+e.message;
  }
}

async function captureSample(){
  const v=document.getElementById('regVideo');
  if(!v||!v.srcObject) return;
  await ensureModels();
  const det=await faceapi.detectSingleFace(v).withFaceLandmarks().withFaceDescriptor();
  if(!det){document.getElementById('regStatus').textContent='No face detected — try again';return;}
  regSamples.push(Array.from(det.descriptor));
  const pct=regSamples.length/10*100;
  document.getElementById('sampleCount').textContent=regSamples.length+' / 10 samples';
  document.getElementById('sampleProgress').style.width=pct+'%';
  document.getElementById('regStatus').textContent='Sample '+regSamples.length+' captured ✅';
  if(regSamples.length>=10){
    document.getElementById('saveBtn').disabled=false;
    document.getElementById('regStatus').textContent='10 samples ready — fill details & save';
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
  const email=document.getElementById('fUserEmail').value.trim();
  const password=document.getElementById('fUserPassword').value;
  if(!label){showFaceErr('Name required');return;}
  if(!email){showFaceErr('Email required');return;}
  if(!password||password.length<6){showFaceErr('Password must be at least 6 characters');return;}
  if(regSamples.length<5){showFaceErr('Need at least 5 face samples');return;}
  // Collect selected period IDs
  const selectedPeriodIds=Array.from(document.querySelectorAll('#fPeriodsBox input[type=checkbox]:checked')).map(cb=>parseInt(cb.value));
  const r=await fetch('/api/admin/faces',{method:'POST',headers:{'Content-Type':'application/json','x-token':adminToken},
    body:JSON.stringify({
      label,employee_id:document.getElementById('fEmpId').value,
      department:document.getElementById('fDept').value,
      shift_id:selectedPeriodIds[0]||null,
      user_email:email,user_password:password,
      descriptors:regSamples,accuracy:Math.round(100-Math.random()*5)
    })
  }).then(x=>x.json());
  if(r.error){showFaceErr(r.error);return;}
  // Save assigned periods
  if(r.id || true){
    const faces2=await fetch('/api/admin/faces',{headers:{'x-token':adminToken}}).then(x=>x.json());
    const saved=faces2.find(f=>f.label===label);
    if(saved && selectedPeriodIds.length){
      await fetch('/api/admin/faces/'+saved.id+'/periods',{method:'POST',
        headers:{'Content-Type':'application/json','x-token':adminToken},
        body:JSON.stringify({shift_ids:selectedPeriodIds})}).then(x=>x.json());
    }
  }
  document.getElementById('regOk2').textContent='Student registered & account created! ✅';
  document.getElementById('regOk2').style.display='block';
  document.getElementById('regErr').style.display='none';
  document.getElementById('fName').value='';document.getElementById('fEmpId').value='';
  document.getElementById('fDept').value='';document.getElementById('fUserEmail').value='';
  document.getElementById('fUserPassword').value='';
  clearSamples();loadFaceList();
}
function showFaceErr(msg){document.getElementById('regErr').textContent=msg;document.getElementById('regErr').style.display='block';}

async function loadFaceList(){
  const faces=await fetch('/api/admin/faces',{headers:{'x-token':adminToken}}).then(x=>x.json());
  adminFaces=faces;
  const countEl=document.getElementById('faceCount');
  if(countEl) countEl.textContent=faces.length+' people';
  const html=faces.length?faces.map(f=>{
    const periods=f.assigned_periods||[];
    const periodTags=periods.map(p=>\`<span class="chip chip-blue" style="font-size:0.58rem;margin:1px">\${p.name}</span>\`).join('');
    return \`<div style="display:flex;align-items:flex-start;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <span style="font-weight:600">\${f.label}</span>
        \${f.employee_id?\`<span style="color:var(--muted);font-size:0.68rem;margin-left:6px">#\${f.employee_id}</span>\`:''}
        <br>
        <span style="color:var(--muted);font-size:0.68rem">\${f.department||''}</span>
        \${f.user_email?\`<br><span style="font-size:0.66rem;color:var(--accent)">📧 \${f.user_email}</span>\`:''}
        \${f.notifications_enabled?\`<span class="chip chip-green" style="margin-left:4px;font-size:0.58rem">🔔 notif</span>\`:''}
        \${periods.length?\`<br><span style="font-size:0.65rem;color:var(--muted)">Periods: </span>\${periodTags}\`:\`<br><span style="font-size:0.65rem;color:var(--muted)">No periods assigned</span>\`}
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0;margin-left:8px">
        <button class="btn btn-sm btn-outline" onclick="editFacePeriods(\${f.id},'\${f.label.replace(/'/g,'&apos;')}')">📋 Periods</button>
        <button class="btn btn-danger btn-sm" onclick="deleteFace(\${f.id})">✕</button>
      </div>
    </div>\`;
  }).join('')
    :'<p style="color:var(--muted);font-size:0.8rem">No people registered yet.</p>';
  document.getElementById('faceList').innerHTML=html;
}

// Edit assigned periods for an existing student
async function editFacePeriods(faceId, faceName){
  if(!adminShifts.length){alert('No periods defined yet. Add periods first.');return;}
  const current=await fetch('/api/admin/faces/'+faceId+'/periods',{headers:{'x-token':adminToken}}).then(x=>x.json());
  const currentIds=current.map(p=>p.id);
  const checkboxes=adminShifts.map(s=>\`
    <label style="display:flex;align-items:center;gap:8px;padding:6px 4px;cursor:pointer;font-size:0.85rem">
      <input type="checkbox" value="\${s.id}" \${currentIds.includes(s.id)?'checked':''} class="edit-period-cb" style="accent-color:var(--accent);width:15px;height:15px">
      <span style="font-weight:600">\${s.name}</span>
      <span style="color:var(--muted);font-size:0.72rem">\${s.start_time.slice(0,5)} – \${s.end_time.slice(0,5)}</span>
    </label>\`).join('');
  // Create inline modal via existing modal structure
  const modal=document.getElementById('shiftModal');
  document.getElementById('shiftModalFaceName').textContent='📋 '+faceName+' — Edit Periods';
  document.getElementById('shiftModalTime').textContent='Check periods this student attends';
  document.getElementById('shiftCheckboxList').innerHTML=checkboxes;
  // Replace confirm button temporarily
  const confirmBtn=modal.querySelector('button[onclick="confirmShiftMark()"]');
  confirmBtn.textContent='💾 Save Periods';
  confirmBtn.setAttribute('onclick','saveEditedPeriods('+faceId+')');
  modal.classList.add('open');
}

async function saveEditedPeriods(faceId){
  const ids=Array.from(document.querySelectorAll('#shiftCheckboxList .edit-period-cb:checked')).map(cb=>parseInt(cb.value));
  await fetch('/api/admin/faces/'+faceId+'/periods',{method:'POST',
    headers:{'Content-Type':'application/json','x-token':adminToken},
    body:JSON.stringify({shift_ids:ids})}).then(x=>x.json());
  // Restore confirm button
  const confirmBtn=document.querySelector('#shiftModal button[onclick*="saveEditedPeriods"]');
  if(confirmBtn){confirmBtn.textContent='✅ Mark Attendance';confirmBtn.setAttribute('onclick','confirmShiftMark()');}
  document.getElementById('shiftModal').classList.remove('open');
  loadFaceList();
  showToast('✅ Periods updated for student');
}

async function deleteFace(id){
  if(!confirm('Delete this person and their student account?')) return;
  await fetch('/api/admin/faces/'+id,{method:'DELETE',headers:{'x-token':adminToken}});
  loadFaceList();
}

async function loadShifts(){
  adminShifts=await fetch('/api/admin/shifts',{headers:{'x-token':adminToken}}).then(x=>x.json());
  // Populate period checkboxes in register form
  const box=document.getElementById('fPeriodsBox');
  if(box){
    if(!adminShifts.length){
      box.innerHTML='<div style="color:var(--muted);font-size:0.75rem">No periods defined yet. Add periods first.</div>';
    } else {
      box.innerHTML=adminShifts.map(s=>\`
        <label style="display:flex;align-items:center;gap:8px;padding:5px 4px;cursor:pointer;font-size:0.82rem">
          <input type="checkbox" value="\${s.id}" class="period-reg-cb" style="accent-color:var(--accent);width:15px;height:15px">
          <span style="font-weight:600">\${s.name}</span>
          <span style="color:var(--muted);font-size:0.7rem">\${s.start_time.slice(0,5)} – \${s.end_time.slice(0,5)}</span>
        </label>\`).join('');
    }
  }
  const list=document.getElementById('shiftList');
  if(list) list.innerHTML=adminShifts.length?adminShifts.map(s=>\`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
      <div>
        <span style="font-weight:600">\${s.name}</span>
        <span style="color:var(--muted);font-size:0.73rem;margin-left:8px">\${s.start_time.slice(0,5)} – \${s.end_time.slice(0,5)}</span>
      </div>
      <button class="btn btn-danger btn-sm" onclick="deleteShift(\${s.id})">✕</button>
    </div>\`).join('')
    :'<p style="color:var(--muted);font-size:0.8rem">No periods defined yet.</p>';
}

async function addShift(){
  const n=document.getElementById('shName').value.trim(),s=document.getElementById('shStart').value,e=document.getElementById('shEnd').value;
  if(!n||!s||!e){document.getElementById('shErr').textContent='All fields required';document.getElementById('shErr').style.display='block';return;}
  const r=await fetch('/api/admin/shifts',{method:'POST',headers:{'Content-Type':'application/json','x-token':adminToken},body:JSON.stringify({name:n,start_time:s,end_time:e})}).then(x=>x.json());
  if(r.error){document.getElementById('shErr').textContent=r.error;document.getElementById('shErr').style.display='block';return;}
  document.getElementById('shErr').style.display='none';document.getElementById('shName').value='';
  loadShifts();
}

async function deleteShift(id){
  if(!confirm('Delete this period?')) return;
  await fetch('/api/admin/shifts/'+id,{method:'DELETE',headers:{'x-token':adminToken}});
  loadShifts();
}

// ── Users management ──────────────────────────────────────────────────────────
async function loadUsers(){
  const users=await fetch('/api/admin/users',{headers:{'x-token':adminToken}}).then(x=>x.json());
  const countEl=document.getElementById('userCount');
  if(countEl) countEl.textContent=users.length+' users';
  const tbody=document.getElementById('userTableBody');
  if(!users.length){tbody.innerHTML='<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">No student accounts yet</td></tr>';return;}
  tbody.innerHTML=users.map(u=>\`
    <tr>
      <td style="font-weight:600">\${u.name}</td>
      <td style="font-size:0.75rem;color:var(--muted)">\${u.email}</td>
      <td style="font-size:0.73rem">\${u.department||''}\${u.shift_name?' · <span class="chip chip-blue">'+u.shift_name+'</span>':''}</td>
      <td>\${u.notifications_enabled?\`<span class="chip chip-green">🔔 On</span>\`:\`<span class="chip chip-gray">Off</span>\`}</td>
      <td style="font-size:0.72rem;color:var(--muted)">\${(u.created_at+'').slice(0,10)}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm btn-outline" onclick="resetPassword(\${u.id},'\${u.name.replace(/'/g,'&apos;')}')">🔑 Reset</button>
        <button class="btn btn-sm btn-danger" style="margin-left:4px" onclick="deleteUser(\${u.id})">✕</button>
      </td>
    </tr>\`).join('');
}

async function resetPassword(id,name){
  const pwd=prompt('New password for '+name+' (min 6 chars):');
  if(!pwd||pwd.length<6){alert('Password too short');return;}
  const r=await fetch('/api/admin/users/'+id+'/reset-password',{method:'PUT',headers:{'Content-Type':'application/json','x-token':adminToken},body:JSON.stringify({password:pwd})}).then(x=>x.json());
  alert(r.ok?'Password reset successfully!':r.error);
}

async function deleteUser(id){
  if(!confirm('Delete this student account? Their face profile remains.')) return;
  await fetch('/api/admin/users/'+id,{method:'DELETE',headers:{'x-token':adminToken}});
  loadUsers();
}

// ── Export ────────────────────────────────────────────────────────────────────
async function exportAttendance(fmt){
  const month=document.getElementById('expMonth').value;
  const year=document.getElementById('expYear').value;
  window.open('/api/admin/attendance/export?month='+month+'&year='+year+'&format='+fmt+'&_t='+adminToken,'_blank');
}

async function previewReport(){
  const month=document.getElementById('expMonth').value;
  const year=document.getElementById('expYear').value;
  const rows=await fetch('/api/admin/attendance?month='+month+'&year='+year,{headers:{'x-token':adminToken}}).then(x=>x.json());
  const el=document.getElementById('reportPreview');
  if(!rows.length){el.innerHTML='<p style="color:var(--muted);margin-top:10px">No records for this period.</p>';return;}
  const html=\`<div style="font-size:0.75rem;margin-top:6px;margin-bottom:8px;color:var(--muted)">\${rows.length} records found</div>
  <div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Date</th><th>Period</th><th>In</th><th>Out</th><th>Status</th></tr></thead>
    <tbody>\${rows.slice(0,30).map(r=>\`<tr>
      <td style="font-weight:600">\${r.name}</td>
      <td>\${(r.date+'').slice(0,10)}</td>
      <td>\${r.shift_name||'—'}</td>
      <td style="font-family:monospace">\${r.time_in||'—'}</td>
      <td style="font-family:monospace">\${r.time_out||'—'}</td>
      <td><span class="chip \${r.status==='present'?'chip-green':'chip-red'}">\${r.status}</span></td>
    </tr>\`).join('')}
    \${rows.length>30?'<tr><td colspan="6" style="text-align:center;color:var(--muted)">...and '+(rows.length-30)+' more</td></tr>':''}</tbody>
  </table></div>\`;
  el.innerHTML=html;
}

// ── SCAN (multi-period) ────────────────────────────────────────────────────────
let modelsLoaded=false;
async function ensureModels(){
  if(modelsLoaded) return;
  try {
    await faceapi.nets.ssdMobilenetv1.loadFromUri('/models');
    await faceapi.nets.faceLandmark68Net.loadFromUri('/models');
    await faceapi.nets.faceRecognitionNet.loadFromUri('/models');
    modelsLoaded=true;
    const banner=document.getElementById('modelErrorBanner');
    if(banner) banner.style.display='none';
  } catch(e) {
    const banner=document.getElementById('modelErrorBanner');
    if(banner) banner.style.display='flex';
    throw e;
  }
}

async function reloadModels(){
  const btn=document.querySelector('#modelErrorBanner button');
  if(btn){btn.disabled=true;btn.textContent='⏳ Re-downloading...';}
  try {
    const r=await fetch('/api/admin/reload-models',{method:'POST',headers:{'x-token':adminToken}}).then(x=>x.json());
    if(r.ok){
      showToast('✅ '+r.message);
      modelsLoaded=false; // force reload next scan
      setTimeout(()=>location.reload(), 3000);
    } else {
      showToast('❌ '+(r.error||'Failed'));
      if(btn){btn.disabled=false;btn.textContent='🔄 Fix Models';}
    }
  } catch(e) {
    showToast('❌ '+e.message);
    if(btn){btn.disabled=false;btn.textContent='🔄 Fix Models';}
  }
}

async function doScan(){
  const v=document.getElementById('video');
  if(!v||!v.srcObject) return;
  try {
    await ensureModels();
  } catch(e) {
    showResult({event:'error',message:'Model error — click "Fix Models" above'},'❌');
    return;
  }
  const det=await faceapi.detectSingleFace(v).withFaceLandmarks().withFaceDescriptor();
  if(!det){showResult({event:'no_face',message:'No face detected'},'⚠️');return;}
  const mode=document.getElementById('scanMode').value;
  const r=await fetch('/api/admin/scan',{method:'POST',headers:{'Content-Type':'application/json','x-token':adminToken},
    body:JSON.stringify({descriptor:Array.from(det.descriptor),mode})}).then(x=>x.json());

  if(r.event==='face_identified'){
    const autoIds=r.auto_select_shift_ids||[];
    const pendingShifts=r.pending_shifts||[];
    const allShifts=r.all_shifts||[];

    // ── AUTO-MARK: student has assigned periods & there are pending ones ──────
    if(autoIds.length > 0){
      // Show instant result while marking
      document.getElementById('resultBody').innerHTML=\`
        <div style="text-align:center;padding:10px">
          <div style="font-size:2rem">⏳</div>
          <div style="font-size:1rem;font-weight:700;color:var(--accent);margin:6px 0">\${r.name}</div>
          <div style="font-size:0.8rem;color:var(--muted)">Marking assigned periods...</div>
        </div>\`;
      const mr=await fetch('/api/admin/mark-attendance',{method:'POST',
        headers:{'Content-Type':'application/json','x-token':adminToken},
        body:JSON.stringify({face_id:r.face_id,shift_ids:autoIds})
      }).then(x=>x.json());
      showMultiResult(mr);
      loadScanTab();
      return;
    }

    // ── ALL assigned periods already marked today ──────────────────────────────
    if(r.assigned_period_ids&&r.assigned_period_ids.length>0 && autoIds.length===0){
      // All assigned periods are already done
      const markedNames=(r.marked_shift_ids||[]).map(id=>{
        const s=allShifts.find(x=>x.id===id);
        return s?s.name:'';
      }).filter(Boolean);
      document.getElementById('resultBody').innerHTML=\`
        <div style="text-align:center;padding:10px">
          <div style="font-size:2rem">✅</div>
          <div style="font-size:1rem;font-weight:700;color:var(--green);margin:6px 0">\${r.name}</div>
          <div style="font-size:0.8rem;color:var(--muted);margin-top:4px">All assigned periods already marked today.</div>
          \${markedNames.length?'<div style="margin-top:8px">'+markedNames.map(n=>'<span class="chip chip-green" style="margin:1px">✅ '+n+'</span>').join('')+'</div>':''}
        </div>\`;
      loadScanTab();
      return;
    }

    // ── NO assigned periods — show manual selection modal ─────────────────────
    pendingScanResult=r;
    openShiftModal(r);
  } else {
    showResult(r);
    loadScanTab();
  }
}

function openShiftModal(r){
  document.getElementById('shiftModalFaceName').textContent='👤 '+r.name;
  document.getElementById('shiftModalTitle').textContent='Select Periods to Mark';
  const now=new Date();
  document.getElementById('shiftModalTime').textContent='Scan time: '+now.toLocaleTimeString();

  const container=document.getElementById('shiftCheckboxList');
  const pending=r.pending_shifts||[];
  const allShifts=r.all_shifts||[];

  if(!allShifts.length){
    // No periods configured — just a no-period mark
    if(r.has_no_shift_attendance){
      container.innerHTML='<div style="padding:14px;text-align:center;color:var(--muted);font-size:0.82rem">✅ Attendance already marked today (no period)</div>';
    } else {
      container.innerHTML='<div style="padding:12px;color:var(--muted);font-size:0.82rem">No periods configured. Will mark as general attendance.</div>';
    }
    document.getElementById('shiftModal').classList.add('open');
    return;
  }

  const markedIds=r.marked_shift_ids||[];
  const assignedIds=r.assigned_period_ids||[];

  // Add a note explaining why the modal appeared
  const noteHtml = assignedIds.length===0
    ? '<div style="font-size:0.72rem;color:var(--yellow);background:rgba(251,191,36,0.1);border-radius:6px;padding:6px 10px;margin-bottom:10px">⚠️ No periods assigned to this student yet. Please select manually or assign periods via the People tab.</div>'
    : '';

  container.innerHTML = noteHtml + allShifts.map(s=>{
    const isDone=markedIds.includes(s.id);
    return \`<label class="shift-select-item\${isDone?' already-done':''}">
      <input type="checkbox" value="\${s.id}" \${isDone?'disabled checked':''} class="shift-cb">
      <div style="flex:1">
        <span style="font-weight:600">\${s.name}</span>
        <span class="shift-badge">\${s.start_time.slice(0,5)} – \${s.end_time.slice(0,5)}</span>
      </div>
      \${isDone?'<span class="done-badge">✅ Done</span>':''}
    </label>\`;
  }).join('');

  document.getElementById('shiftModal').classList.add('open');
}

function closeShiftModal(){
  document.getElementById('shiftModal').classList.remove('open');
  // Note: do NOT null pendingScanResult here — confirmShiftMark needs it after closing
}

function dismissShiftModal(){
  // Cancel button — close and discard
  document.getElementById('shiftModal').classList.remove('open');
  pendingScanResult=null;
  // Restore confirm button in case it was overridden by editFacePeriods
  const confirmBtn=document.querySelector('#shiftModal button[onclick*="saveEditedPeriods"]');
  if(confirmBtn){confirmBtn.textContent='✅ Mark Attendance';confirmBtn.setAttribute('onclick','confirmShiftMark()');}
  document.getElementById('shiftModalTitle').textContent='Select Periods to Mark';
}

function selectAllShifts(){
  document.querySelectorAll('#shiftCheckboxList .shift-cb:not(:disabled)').forEach(cb=>cb.checked=true);
}
function clearShiftSelection(){
  document.querySelectorAll('#shiftCheckboxList .shift-cb:not(:disabled)').forEach(cb=>cb.checked=false);
}

async function confirmShiftMark(){
  if(!pendingScanResult) return;

  const allShifts=pendingScanResult.all_shifts||[];
  let selectedIds=[];

  if(allShifts.length){
    selectedIds=Array.from(document.querySelectorAll('#shiftCheckboxList .shift-cb:not(:disabled):checked'))
      .map(cb=>parseInt(cb.value));
    if(!selectedIds.length){
      alert('Please select at least one period to mark.');
      return;
    }
  }
  // else: no periods configured → mark as no-period (empty array)

  // Save needed values BEFORE closing modal (which would null pendingScanResult)
  const faceId=pendingScanResult.face_id;
  const faceName=pendingScanResult.name;

  // Close modal and clear state
  document.getElementById('shiftModal').classList.remove('open');
  pendingScanResult=null;

  const r=await fetch('/api/admin/mark-attendance',{method:'POST',
    headers:{'Content-Type':'application/json','x-token':adminToken},
    body:JSON.stringify({face_id:faceId,shift_ids:selectedIds})
  }).then(x=>x.json());

  showMultiResult(r);
  loadScanTab();
}

function showMultiResult(r){
  if(!r||r.error){showResult({event:'error',message:r?.error||'Error'},'❌');return;}
  const marked=r.results?.filter(x=>x.ok)||[];
  const skipped=r.results?.filter(x=>x.skipped)||[];
  const color='var(--green)';
  document.getElementById('resultBody').innerHTML=\`
    <div style="text-align:center;padding:10px">
      <div style="font-size:2rem">✅</div>
      <div style="font-size:1rem;font-weight:700;color:\${color};margin:6px 0">\${r.name}</div>
      <div style="font-size:0.8rem;color:var(--muted)">⏱ In: \${r.time_in}</div>
      \${marked.length?'<div style="margin-top:8px;font-size:0.75rem;color:var(--text)">Marked: '+marked.map(x=>'<span class="chip chip-green" style="margin:1px">'+( x.shift_name||'General Period')+'</span>').join('')+'</div>':''}
      \${skipped.length?'<div style="margin-top:4px;font-size:0.73rem;color:var(--muted)">Already marked: '+skipped.map(x=>'<span class="chip chip-gray" style="margin:1px">'+(x.shift_name||'General Period')+'</span>').join('')+'</div>':''}
    </div>\`;
}

function showResult(r,icon=''){
  const icons={checkin:'✅',checkout:'👋',unknown:'❓',already_checked_in:'ℹ️',already_checked_out:'ℹ️',not_checked_in:'⚠️',no_face:'⚠️',no_faces:'ℹ️',error:'❌'};
  const ic=icon||icons[r.event]||'📋';
  const color={checkin:'var(--green)',checkout:'var(--accent)',unknown:'var(--red)',already_checked_in:'var(--yellow)',no_face:'var(--yellow)'}[r.event]||'var(--muted)';
  // Always show label — use name or event as fallback
  const label=r.name||(r.event?r.event.replace(/_/g,' '):'');
  document.getElementById('resultBody').innerHTML=\`
    <div style="text-align:center;padding:10px">
      <div style="font-size:2rem">\${ic}</div>
      <div style="font-size:1rem;font-weight:700;color:\${color};margin:6px 0">\${label}</div>
      \${r.time_in?\`<div style="font-size:0.8rem;color:var(--muted)">In: \${r.time_in}</div>\`:''}
      \${r.time_out?\`<div style="font-size:0.8rem;color:var(--muted)">Out: \${r.time_out}</div>\`:''}
      \${r.shift?\`<div style="font-size:0.72rem;color:var(--accent)">Shift: \${r.shift}</div>\`:''}
      \${r.message?\`<div style="font-size:0.76rem;color:var(--muted);margin-top:4px">\${r.message}</div>\`:''}
    </div>\`;
}

async function loadScanTab(){
  const today=new Date().toISOString().split('T')[0];
  const rows=await fetch('/api/admin/attendance?date='+today,{headers:{'x-token':adminToken}}).then(x=>x.json());
  const allFaces=await fetch('/api/admin/faces',{headers:{'x-token':adminToken}}).then(x=>x.json());
  const present=rows.filter(r=>r.status==='present').length,total=allFaces.length;
  document.getElementById('todayStats').innerHTML=\`
    <div class="stat card-sm"><div class="stat-val green">\${present}</div><div class="stat-label">Present</div></div>
    <div class="stat card-sm"><div class="stat-val red">\${total-present}</div><div class="stat-label">Absent</div></div>
    <div class="stat card-sm"><div class="stat-val">\${total}</div><div class="stat-label">Total</div></div>
    <div class="stat card-sm"><div class="stat-val yellow">\${rows.filter(r=>r.time_out).length}</div><div class="stat-label">Checked Out</div></div>
  \`;
  document.getElementById('todayList').innerHTML=rows.map(r=>\`
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--surface)">
      <div>
        <span style="font-weight:600">\${r.name}</span>
        \${r.shift_name?\`<span class="chip chip-blue" style="margin-left:4px;font-size:0.58rem">\${r.shift_name}</span>\`:''}
      </div>
      <span style="color:var(--muted);font-size:0.7rem;white-space:nowrap">\${r.time_in}\${r.time_out?' → '+r.time_out:''}</span>
    </div>\`).join('')||'<p style="color:var(--muted);font-size:0.78rem;text-align:center;padding:16px 0">No attendance today</p>';
}

function toggleAuto(){
  autoMode=!autoMode;
  const btn=document.getElementById('autoBtn');
  if(autoMode){btn.textContent='⏹ Stop';btn.classList.add('active');autoTimer=setInterval(()=>doScan(),3000);}
  else{btn.textContent='Auto';btn.classList.remove('active');clearInterval(autoTimer);}
}

// ── Calendar ──────────────────────────────────────────────────────────────────
const MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];
function changeMonth(d){calMonth+=d;if(calMonth>12){calMonth=1;calYear++;}if(calMonth<1){calMonth=12;calYear--;}renderCalendar();}

async function renderCalendar(){
  calData=await fetch('/api/admin/calendar?month='+calMonth+'&year='+calYear,{headers:{'x-token':adminToken}}).then(x=>x.json());
  document.getElementById('calTitle').textContent=MONTH_NAMES[calMonth-1]+' '+calYear;
  document.getElementById('calHead').innerHTML=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>\`<div class="cal-head">\${d}</div>\`).join('');
  const first=new Date(calYear,calMonth-1,1).getDay(),days=new Date(calYear,calMonth,0).getDate(),today=new Date();
  let cells='';
  for(let i=0;i<first;i++) cells+=\`<div class="cal-day other-month"></div>\`;
  for(let d=1;d<=days;d++){
    const dateStr=calYear+'-'+String(calMonth).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const att=calData.attendance.find(a=>a.date===dateStr||a.date?.startsWith(dateStr));
    const hol=calData.holidays.find(h=>h.date===dateStr||h.date?.startsWith(dateStr));
    const isToday=today.getDate()===d&&today.getMonth()===calMonth-1&&today.getFullYear()===calYear;
    cells+=\`<div class="cal-day\${isToday?' today':''}\${hol?' holiday':''}" onclick="openCalDay('\${dateStr}',\${!!hol})">
      <div class="cal-day-num">\${d}</div>
      \${att?(\`<span class="cal-event cal-present">✅ \${att.present}</span>\`+(att.absent>0?\`<span class="cal-event cal-absent">❌ \${att.absent}</span>\`:'')):''} 
      \${hol?\`<span class="cal-event cal-holiday-tag">\${hol.label}</span>\`:''}
    </div>\`;
  }
  document.getElementById('calGrid').innerHTML=cells;
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
  closeCalModal();renderCalendar();
}

(async function(){
  if(adminToken){
    const me=await fetch('/api/admin/me',{headers:{'x-token':adminToken}}).then(x=>x.json()).catch(()=>null);
    if(me&&!me.error){document.getElementById('authSection').style.display='none';showDashboard(me);}
    else localStorage.removeItem(TOKEN_KEY);
  }
})();

// ── Records Tab (person-wise calendar) ────────────────────────────────────────
let recYear=new Date().getFullYear(), recMonth=new Date().getMonth()+1;
let recFaceId=null, recFaceName='', recData={attendance:[],holidays:[]};

async function loadRecordsPeople(){
  const faces=await fetch('/api/admin/faces',{headers:{'x-token':adminToken}}).then(x=>x.json());
  const html=faces.length?faces.map(f=>\`
    <div onclick="openPersonCalendar(\${f.id},'\${f.label.replace(/'/g,"\\\\'")}',this)"
         style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-radius:10px;cursor:pointer;transition:background 0.15s;border:1px solid transparent;margin-bottom:6px"
         onmouseover="this.style.background='var(--surface)'" onmouseout="if(!this.classList.contains('rec-active'))this.style.background=''">
      <div>
        <span style="font-weight:600">\${f.label}</span>
        \${f.employee_id?\`<span style="color:var(--muted);font-size:0.68rem;margin-left:6px">#\${f.employee_id}</span>\`:''}
        <br><span style="color:var(--muted);font-size:0.68rem">\${f.department||''}\${f.shift_name?' · '+f.shift_name:''}</span>
      </div>
      <span style="color:var(--accent);font-size:0.75rem">View →</span>
    </div>\`).join('')
    :'<p style="color:var(--muted);font-size:0.8rem">No people registered yet.</p>';
  document.getElementById('recordsPeopleList').innerHTML=html;
  document.getElementById('recordsCalPanel').style.display='none';
}

async function openPersonCalendar(faceId,name,el){
  document.querySelectorAll('#recordsPeopleList > div').forEach(d=>{
    d.classList.remove('rec-active');
    d.style.background='';
    d.style.border='1px solid transparent';
  });
  el.classList.add('rec-active');
  el.style.background='rgba(0,173,238,0.06)';
  el.style.border='1px solid rgba(0,173,238,0.2)';
  recFaceId=faceId; recFaceName=name;
  recYear=new Date().getFullYear(); recMonth=new Date().getMonth()+1;
  document.getElementById('recordsCalPanel').style.display='block';
  await renderRecCalendar();
}

function recChangeMonth(d){
  recMonth+=d;
  if(recMonth>12){recMonth=1;recYear++;}
  if(recMonth<1){recMonth=12;recYear--;}
  renderRecCalendar();
}

async function renderRecCalendar(){
  if(!recFaceId) return;
  recData=await fetch('/api/admin/person-attendance?face_id='+recFaceId+'&month='+recMonth+'&year='+recYear,
    {headers:{'x-token':adminToken}}).then(x=>x.json());

  document.getElementById('recCalTitle').textContent=recFaceName+' \u2014 '+MONTH_NAMES[recMonth-1]+' '+recYear;

  const presentDays=new Set(recData.attendance.filter(a=>a.status==='present').map(a=>(a.date+'').slice(0,10))).size;
  const absentDays=new Set(recData.attendance.filter(a=>a.status==='absent').map(a=>(a.date+'').slice(0,10))).size;
  const holCount=recData.holidays.length;
  const rate=presentDays+absentDays>0?Math.round(presentDays/(presentDays+absentDays)*100):0;
  document.getElementById('recStats').innerHTML=\`
    <div class="stat card-sm"><div class="stat-val green">\${presentDays}</div><div class="stat-label">Present Days</div></div>
    <div class="stat card-sm"><div class="stat-val red">\${absentDays}</div><div class="stat-label">Absent Days</div></div>
    <div class="stat card-sm"><div class="stat-val yellow">\${holCount}</div><div class="stat-label">Holidays</div></div>
    <div class="stat card-sm"><div class="stat-val \${rate>=80?'green':rate>=60?'yellow':'red'}">\${rate}%</div><div class="stat-label">Rate</div></div>
  \`;

  document.getElementById('recCalHead').innerHTML=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>\`<div class="cal-head">\${d}</div>\`).join('');

  const first=new Date(recYear,recMonth-1,1).getDay();
  const days=new Date(recYear,recMonth,0).getDate();
  const today=new Date();
  let cells='';
  for(let i=0;i<first;i++) cells+=\`<div class="cal-day other-month"></div>\`;

  for(let d=1;d<=days;d++){
    const dateStr=recYear+'-'+String(recMonth).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const dayAtts=recData.attendance.filter(a=>(a.date+'').startsWith(dateStr));
    const hol=recData.holidays.find(h=>(h.date+'').startsWith(dateStr));
    const isToday=today.getDate()===d&&today.getMonth()===recMonth-1&&today.getFullYear()===recYear;
    const presentAtts=dayAtts.filter(a=>a.status==='present');
    const isAbsent=dayAtts.some(a=>a.status==='absent');

    let dayStyle='';
    if(presentAtts.length) dayStyle='border-color:var(--green);background:rgba(52,211,153,0.08)';
    else if(isAbsent) dayStyle='border-color:var(--red);background:rgba(248,113,113,0.08)';
    else if(hol) dayStyle='border-color:var(--yellow);background:rgba(251,191,36,0.08)';

    const shiftTags=presentAtts.map(a=>
      \`<span class="cal-event cal-present" style="font-size:0.52rem">\${a.shift_name||'✅'}</span>\`
    ).join('');

    cells+=\`<div class="cal-day\${isToday?' today':''}" style="\${dayStyle}">
      <div class="cal-day-num" style="\${presentAtts.length?'color:var(--green)':isAbsent?'color:var(--red)':hol?'color:#92400e':''}">\${d}</div>
      \${shiftTags}
      \${isAbsent&&!presentAtts.length?'<span class="cal-event cal-absent">Absent</span>':''}
      \${hol?\`<span class="cal-event cal-holiday-tag">\${hol.label}</span>\`:''}
    </div>\`;
  }
  document.getElementById('recCalGrid').innerHTML=cells;
}
</script>`));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  USER PAGE
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/user', (_, res) => {
  res.send(htmlBase('Employee Portal', `
<nav>
  <a class="nav-logo" href="/portal" id="navLogo">Face<span>Attend</span></a>
  <div class="nav-right" id="navRight"></div>
</nav>
<main id="app">
  <!-- Login -->
  <div id="loginSection" style="max-width:400px;margin:50px auto">
    <div class="page-title">👤 Student Login</div>
    <div class="card">
      <div id="loginErr" class="alert alert-error" style="display:none"></div>
      <div class="form-group"><label>Email</label><input class="form-control" id="uEmail" type="email" autocomplete="email"></div>
      <div class="form-group"><label>Password</label><input class="form-control" id="uPass" type="password" autocomplete="current-password"></div>
      <button class="btn btn-primary" style="width:100%" onclick="doUserLogin()">Login</button>
      <div style="text-align:center;margin-top:12px;font-size:0.75rem;color:var(--muted)">
        <a href="/portal" style="color:var(--accent);text-decoration:none">← Back to Portal</a>
      </div>
    </div>
  </div>

  <!-- Dashboard -->
  <div id="userDash" style="display:none">
    <div class="grid4" id="statsRow" style="margin-bottom:16px"></div>
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <button class="btn btn-outline btn-sm" onclick="changeMonth(-1)">&#8249; Prev</button>
        <span id="calTitle" style="font-weight:700"></span>
        <button class="btn btn-outline btn-sm" onclick="changeMonth(1)">Next &#8250;</button>
      </div>
      <div class="cal-grid" id="calHead"></div>
      <div class="cal-grid" style="margin-top:4px" id="calGrid"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <div style="font-weight:700;margin-bottom:12px">Recent Records</div>
      <div id="recentList"></div>
    </div>
  </div>
</main>

<!-- Notification Permission Modal -->
<div id="notifModal" class="modal-backdrop">
  <div class="modal" style="text-align:center;max-width:360px">
    <div class="notif-modal-icon">🔔</div>
    <div style="font-weight:700;font-size:1rem;margin-bottom:8px">Enable Attendance Alerts</div>
    <div style="font-size:0.8rem;color:var(--muted);margin-bottom:18px;line-height:1.6">
      Get instant push notifications when your attendance is marked — check-in &amp; check-out alerts sent right to your device.
    </div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="enableNotif()">
        🔔 Enable Notifications
      </button>
      <button class="btn btn-outline btn-sm" style="width:100%;justify-content:center" onclick="dismissNotifModal()">
        Maybe later
      </button>
    </div>
  </div>
</div>

<script>
const TOKEN_KEY='user_token';
let userToken=localStorage.getItem(TOKEN_KEY);
let calYear=new Date().getFullYear(),calMonth=new Date().getMonth()+1;
let calData={attendance:[],holidays:[]};
const MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];

async function doUserLogin(){
  const e=document.getElementById('uEmail').value,p=document.getElementById('uPass').value;
  const r=await fetch('/api/user/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:e,password:p})}).then(x=>x.json());
  if(r.error){document.getElementById('loginErr').textContent=r.error;document.getElementById('loginErr').style.display='block';return;}
  userToken=r.token;localStorage.setItem(TOKEN_KEY,userToken);
  showUserDash(r);
}

function userLogout(){localStorage.removeItem(TOKEN_KEY);location.reload();}

async function showUserDash(r){
  document.getElementById('loginSection').style.display='none';
  document.getElementById('userDash').style.display='block';
  let logoHtml='';
  if(r.logo_base64) logoHtml=\`<img src="\${r.logo_base64}" style="height:30px;border-radius:6px;margin-right:6px">\`;
  document.getElementById('navLogo').innerHTML=logoHtml+'Face<span style="color:var(--accent)">Attend</span>';
  document.getElementById('navRight').innerHTML=\`
    <span style="font-size:0.72rem;color:var(--muted)">\${r.name||''}</span>
    <span class="badge badge-user">Student</span>
    <button class="btn btn-sm btn-outline" id="notifNavBtn" onclick="openNotifModal()" title="Enable notifications">🔔</button>
    <button class="btn btn-sm btn-outline" onclick="userLogout()">Logout</button>\`;

  renderCalendar();

  // Show notification modal after short delay — independent of SW registration
  if(typeof Notification !== 'undefined' && 'PushManager' in navigator){
    const alreadyEnabled = r.notifications_enabled;
    const perm = Notification.permission;
    if(!alreadyEnabled && perm !== 'denied'){
      setTimeout(()=>{
        document.getElementById('notifModal').classList.add('open');
      }, 1500);
    }
  }

  // Register SW in background (non-blocking)
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('✅ SW registered, scope:', reg.scope))
      .catch(e  => console.error('❌ SW registration failed:', e.message));
  }
}

async function enableNotif(){
  dismissNotifModal();
  if(typeof Notification === 'undefined' || !('PushManager' in navigator)){
    showToast('⚠️ Push notifications not supported in this browser.');
    return;
  }
  const perm = await Notification.requestPermission();
  if(perm === 'denied'){
    showToast('⚠️ Notifications blocked. Go to Site Settings → Notifications → Allow, then re-login.');
    return;
  }
  if(perm !== 'granted'){
    showToast('⚠️ Notification permission not granted.');
    return;
  }
  try{
    showToast('⏳ Setting up notifications...');
    // Register (or get existing) SW
    let reg = await navigator.serviceWorker.getRegistration('/');
    if(!reg){
      reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    }
    // Wait for it to be active with a 6s timeout
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_,rej) => setTimeout(()=>rej(new Error('Service worker timed out — try refreshing page')), 6000))
    ]);

    const vapid = await fetch('/api/vapid-public').then(x=>x.json());
    if(!vapid.key){
      showToast('⚠️ Push keys not configured on server. Add VAPID_PUBLIC / VAPID_PRIVATE to .env');
      return;
    }

    // Clear any stale subscription
    const existing = await reg.pushManager.getSubscription();
    if(existing) await existing.unsubscribe();

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid.key)
    });
    const result = await fetch('/api/user/push-subscribe',{
      method: 'POST',
      headers: {'Content-Type':'application/json','x-token':userToken},
      body: JSON.stringify({subscription: sub.toJSON()})
    }).then(x=>x.json());

    if(result.ok) showToast('✅ Notifications enabled! You will be alerted for attendance & account changes.');
    else showToast('❌ Subscription failed: '+(result.error||'unknown error'));
  } catch(e){
    showToast('❌ '+e.message);
    console.error('enableNotif error:', e);
  }
}

function dismissNotifModal(){
  document.getElementById('notifModal').classList.remove('open');
}
function openNotifModal(){
  document.getElementById('notifModal').classList.add('open');
}

function showToast(msg){
  const t=document.createElement('div');
  t.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1f2937;color:white;padding:12px 20px;border-radius:12px;font-size:0.8rem;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.2);transition:opacity 0.4s;max-width:90vw;text-align:center';
  t.textContent=msg;
  document.body.appendChild(t);
  setTimeout(()=>{t.style.opacity='0';setTimeout(()=>t.remove(),400);},4000);
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
  document.getElementById('statsRow').innerHTML=\`
    <div class="stat"><div class="stat-val green">\${present}</div><div class="stat-label">Present</div></div>
    <div class="stat"><div class="stat-val red">\${absent}</div><div class="stat-label">Absent</div></div>
    <div class="stat"><div class="stat-val">\${total}</div><div class="stat-label">Marked</div></div>
    <div class="stat"><div class="stat-val \${pct>=80?'green':pct>=60?'yellow':'red'}">\${pct}%</div><div class="stat-label">Rate</div></div>
  \`;
  document.getElementById('calHead').innerHTML=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>\`<div class="cal-head">\${d}</div>\`).join('');
  const first=new Date(calYear,calMonth-1,1).getDay(),days=new Date(calYear,calMonth,0).getDate(),today=new Date();
  let cells='';
  for(let i=0;i<first;i++) cells+=\`<div class="cal-day other-month"></div>\`;
  for(let d=1;d<=days;d++){
    const dateStr=calYear+'-'+String(calMonth).padStart(2,'0')+'-'+String(d).padStart(2,'0');
    const dayAtts=calData.attendance.filter(a=>(a.date+'').startsWith(dateStr));
    const hol=calData.holidays.find(h=>(h.date+'').startsWith(dateStr));
    const isToday=today.getDate()===d&&today.getMonth()===calMonth-1&&today.getFullYear()===calYear;
    const presentAtts=dayAtts.filter(a=>a.status==='present');
    cells+=\`<div class="cal-day\${isToday?' today':''}\${hol?' holiday':''}">
      <div class="cal-day-num">\${d}</div>
      \${presentAtts.length?\`<span class="cal-event cal-present">✅\${presentAtts.length>1?' ×'+presentAtts.length:presentAtts[0].shift_name?' '+presentAtts[0].shift_name:''}</span>\`:''}
      \${hol?\`<span class="cal-event cal-holiday-tag">\${hol.label}</span>\`:''}
    </div>\`;
  }
  document.getElementById('calGrid').innerHTML=cells;

  const recent=calData.attendance.slice(0,15);
  document.getElementById('recentList').innerHTML=recent.length?recent.map(a=>\`
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--surface)">
      <div>
        <span class="chip \${a.status==='present'?'chip-green':'chip-red'}">\${a.status==='present'?'✅ Present':'❌ Absent'}</span>
        \${a.shift_name?\`<span class="chip chip-blue" style="margin-left:4px">\${a.shift_name}</span>\`:''}
      </div>
      <div style="text-align:right;font-size:0.72rem;color:var(--muted)">
        <div>\${(a.date+'').slice(0,10)}</div>
        \${a.time_in?\`<div>\${a.time_in}\${a.time_out?' → '+a.time_out:''}</div>\`:''}
      </div>
    </div>\`).join(''):'<p style="color:var(--muted);font-size:0.8rem">No attendance records for this month</p>';
}

(async function(){
  if(userToken){
    const r=await fetch('/api/user/notif-status',{headers:{'x-token':userToken}}).then(x=>x.json()).catch(()=>null);
    if(r!==null&&!r.error){
      const parts=userToken.split('.');
      const pay=JSON.parse(atob(parts[1]));
      showUserDash({name:pay.name,logo_base64:null,notifications_enabled:r.enabled});
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
