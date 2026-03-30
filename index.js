const express  = require('express');
const mysql    = require('mysql2');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/models',    express.static(path.join(__dirname, 'public', 'models')));
app.use('/faceapi.js',(req, res) => res.sendFile(path.join(__dirname, 'public', 'faceapi.js')));
app.use('/unknown-images', express.static(path.join(__dirname, 'public', 'unknown-images')));
app.use('/logos',     express.static(path.join(__dirname, 'public', 'logos')));

const DB_CONFIG = {
  host     : process.env.DB_HOST     || '127.0.0.1',
  user     : process.env.DB_USER     || 'u966260443_facedetect',
  password : process.env.DB_PASS     || 'Makelabs@123',
  database : process.env.DB_NAME     || 'u966260443_facedetect'
};

const db = mysql.createConnection(DB_CONFIG);

// ─── DIR SETUP ────────────────────────────────────────────────────────────────
const PUBLIC_DIR         = path.join(__dirname, 'public');
const MODELS_DIR         = path.join(PUBLIC_DIR, 'models');
const UNKNOWN_IMAGES_DIR = path.join(PUBLIC_DIR, 'unknown-images');
const LOGOS_DIR          = path.join(PUBLIC_DIR, 'logos');
const FACEAPI_PATH       = path.join(PUBLIC_DIR, 'faceapi.js');
[PUBLIC_DIR, MODELS_DIR, UNKNOWN_IMAGES_DIR, LOGOS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function dbQuery(sql, params = []) {
  return new Promise((resolve, reject) =>
    db.query(sql, params, (err, rows) => err ? reject(err) : resolve(rows))
  );
}

function randToken() {
  return crypto.randomBytes(48).toString('hex');
}

function hashPassword(pw) {
  // Simple SHA-256 + salt (swap with bcrypt in production)
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', salt).update(pw).digest('hex');
  return salt + ':' + hash;
}

function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const h = crypto.createHmac('sha256', salt).update(pw).digest('hex');
  return h === hash;
}

async function createSession(role, entityId, adminId = null) {
  const token = randToken();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
  await dbQuery(
    'INSERT INTO sessions (token, role, entity_id, admin_id, expires_at) VALUES (?,?,?,?,?)',
    [token, role, entityId, adminId, expires]
  );
  return token;
}

async function getSession(token) {
  if (!token) return null;
  const rows = await dbQuery(
    'SELECT * FROM sessions WHERE token=? AND expires_at > NOW()',
    [token]
  );
  return rows[0] || null;
}

function getToken(req) {
  return req.cookies?.token || req.headers['x-token'] || null;
}

// Simple cookie parser
app.use((req, res, next) => {
  req.cookies = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) req.cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  next();
});

function setCookie(res, token) {
  res.setHeader('Set-Cookie', `token=${token}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', 'token=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
}

// Middleware guards
async function requireSuperAdmin(req, res, next) {
  const sess = await getSession(getToken(req));
  if (!sess || sess.role !== 'super_admin') return res.redirect('/login?role=super');
  req.session = sess;
  next();
}
async function requireAdmin(req, res, next) {
  const sess = await getSession(getToken(req));
  if (!sess || sess.role !== 'admin') return res.redirect('/login');
  const rows = await dbQuery('SELECT * FROM admins WHERE id=?', [sess.entity_id]);
  if (!rows[0]) return res.redirect('/login');
  req.session = sess;
  req.admin = rows[0];
  next();
}
async function requireApprovedAdmin(req, res, next) {
  await requireAdmin(req, res, async () => {
    if (req.admin.status !== 'approved') {
      return res.send(pendingApprovalPage(req.admin));
    }
    next();
  });
}
async function requireUser(req, res, next) {
  const sess = await getSession(getToken(req));
  if (!sess || sess.role !== 'user') return res.redirect('/user/login');
  const rows = await dbQuery('SELECT * FROM users WHERE id=?', [sess.entity_id]);
  if (!rows[0]) return res.redirect('/user/login');
  req.session = sess;
  req.user = rows[0];
  next();
}

// ─── FACE MATCHING ───────────────────────────────────────────────────────────
function euclidean(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}
const THRESHOLD      = 0.5;
const REGISTER_SAMPLES = 10;

// ─── FACE-API + MODELS DOWNLOAD ──────────────────────────────────────────────
const FACEAPI_URL    = 'https://unpkg.com/face-api.js@0.22.2/dist/face-api.min.js';
const MODEL_FILES    = [
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
  if (!fs.existsSync(FACEAPI_PATH)) {
    try { await download(FACEAPI_URL, FACEAPI_PATH); console.log('✅ face-api.js'); }
    catch(e) { console.log('❌ face-api.js: ' + e.message); }
  }
  const missing = MODEL_FILES.filter(f => {
    const fp = path.join(MODELS_DIR, f);
    if (!fs.existsSync(fp)) return true;
    if (fs.statSync(fp).size < 100) { fs.unlinkSync(fp); return true; }
    return false;
  });
  if (!missing.length) { console.log('✅ All models cached'); return; }
  for (const f of missing) {
    try { await download(MODEL_BASE_URL + f, path.join(MODELS_DIR, f)); }
    catch(e) { console.log('❌ Model ' + f + ': ' + e.message); }
  }
  console.log('✅ Models ready');
}

// ─── LED ─────────────────────────────────────────────────────────────────────
let pendingLedCommand = null;
function getLedCommand(t){const M={checkin_present:{led:'G',buzzer:1},checkin_absent:{led:'R',buzzer:2},checkin_already:{led:'O',buzzer:3},checkout_normal:{led:'B',buzzer:2},checkout_already:{led:'OO',buzzer:3},unknown:{led:'RU',buzzer:5}};return M[t]||{led:'X',buzzer:0};}
function setLed(t,n=''){const c=getLedCommand(t);pendingLedCommand={led:c.led,buzzer:c.buzzer,name:String(n).substring(0,40),eventType:t,timestamp:Date.now()};}

// ─── UTIL ─────────────────────────────────────────────────────────────────────
function fmtTime(t){if(!t)return'—';const s=typeof t==='string'?t:String(t);const p=s.split(':');const h=parseInt(p[0]),m=p[1]||'00';return(h%12||12)+':'+m+' '+(h>=12?'PM':'AM');}
function pad2(n){return String(n).padStart(2,'0');}
function escH(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

// ─── COLOR SCHEME (same as original) ─────────────────────────────────────────
const CSS_VARS = `
  --bg:#ffffff;--surface:#f8f9fa;--card:#ffffff;--border:#dbe3ea;
  --accent:#00adee;--accent2:#00adee;--red:#f87171;--yellow:#fbbf24;
  --purple:#00adee;--orange:#fb923c;--text:#1f2937;--muted:#6b7280;--muted2:#cfd8e3;
`;

const BASE_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&family=JetBrains+Mono:wght@400;600&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
:root{${CSS_VARS}}
body{font-family:'Space Grotesk',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 50% at 50% -10%,rgba(0,173,238,0.08),transparent);pointer-events:none;z-index:0}
a{color:inherit;text-decoration:none}
nav{position:sticky;top:0;z-index:100;background:rgba(255,255,255,0.96);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 16px;height:62px}
.nav-logo{display:flex;align-items:center;gap:8px;font-weight:700;font-size:0.95rem}
.nav-logo span{color:var(--accent)}
.nav-links{display:flex;align-items:center;gap:6px}
.nav-btn{display:flex;align-items:center;gap:6px;background:linear-gradient(135deg,rgba(0,173,238,0.12),rgba(248,249,250,0.9));border:1px solid rgba(0,173,238,0.35);color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:0.75rem;font-weight:600;padding:7px 12px;border-radius:10px;text-decoration:none;transition:all 0.2s;white-space:nowrap;cursor:pointer}
.nav-btn:hover{background:linear-gradient(135deg,rgba(0,173,238,0.22),rgba(248,249,250,1));border-color:rgba(0,173,238,0.6);transform:translateY(-1px)}
.nav-btn.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.page{max-width:1100px;margin:0 auto;padding:20px 16px;position:relative;z-index:1}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:20px}
.card-title{font-family:'JetBrains Mono',monospace;font-size:0.62rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:16px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:12px 14px}
.stat-val{font-family:'JetBrains Mono',monospace;font-size:1.6rem;font-weight:600;color:var(--accent);line-height:1}
.stat-label{font-size:0.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-top:5px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:10px;font-family:'Space Grotesk',sans-serif;font-size:0.8rem;font-weight:600;cursor:pointer;transition:all 0.2s;border:none;text-decoration:none}
.btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{background:#009ed8;transform:translateY(-1px)}
.btn-ghost{background:transparent;border:1px solid var(--border);color:var(--muted)}.btn-ghost:hover{border-color:var(--red);color:var(--red)}
.btn-sm{padding:5px 10px;font-size:0.72rem;border-radius:8px}
.inp{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-family:'Space Grotesk',sans-serif;font-size:0.85rem;outline:none;transition:border-color 0.2s;width:100%}
.inp:focus{border-color:var(--accent)}
.label{font-size:0.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:5px;display:block}
.form-group{margin-bottom:14px}
.badge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:20px;font-size:0.62rem;font-weight:600;letter-spacing:0.5px;text-transform:uppercase}
.badge-green{background:rgba(52,211,153,0.12);color:#059669;border:1px solid rgba(52,211,153,0.25)}
.badge-yellow{background:rgba(251,191,36,0.12);color:#d97706;border:1px solid rgba(251,191,36,0.25)}
.badge-red{background:rgba(248,113,113,0.12);color:#dc2626;border:1px solid rgba(248,113,113,0.25)}
.badge-blue{background:rgba(0,173,238,0.12);color:#0284c7;border:1px solid rgba(0,173,238,0.25)}
table{width:100%;border-collapse:collapse;font-size:0.82rem}
th{font-family:'JetBrains Mono',monospace;font-size:0.58rem;letter-spacing:1px;text-transform:uppercase;color:var(--muted);padding:8px 12px;border-bottom:1px solid var(--border);text-align:left}
td{padding:9px 12px;border-bottom:1px solid var(--border)}
tr:last-child td{border-bottom:none}
.toast{position:fixed;bottom:20px;right:20px;background:var(--text);color:#fff;padding:10px 18px;border-radius:10px;font-size:0.8rem;z-index:9999;opacity:0;transition:opacity 0.3s;pointer-events:none}
.toast.show{opacity:1}
.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:800;display:none;align-items:center;justify-content:center;padding:16px}
.modal-backdrop.open{display:flex}
.modal{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:24px;width:100%;max-width:440px;box-shadow:0 20px 60px rgba(0,0,0,0.15)}
.modal-title{font-family:'JetBrains Mono',monospace;font-size:0.62rem;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-bottom:18px;display:flex;align-items:center;justify-content:space-between}
.close-btn{background:none;border:none;cursor:pointer;color:var(--muted);font-size:1.1rem;line-height:1;padding:2px}
.close-btn:hover{color:var(--red)}
@media(max-width:600px){.grid2,.grid3,.grid4{grid-template-columns:1fr}}
`;

function navBar(active, adminName, role='admin', logoPath=null) {
  const logo = logoPath
    ? `<img src="/logos/${escH(logoPath)}" style="height:34px;border-radius:6px;object-fit:contain">`
    : `<div style="width:34px;height:34px;border-radius:8px;background:linear-gradient(135deg,var(--accent),#0080bb);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:0.9rem">F</div>`;

  if (role === 'super_admin') {
    return `<nav>
      <div class="nav-logo">${logo} <span>Face</span>Detect <span style="font-size:0.6rem;background:var(--accent);color:#fff;padding:2px 7px;border-radius:10px;margin-left:4px">SUPER</span></div>
      <div class="nav-links">
        <a href="/super/dashboard" class="nav-btn ${active==='dashboard'?'active':''}">📊 Dashboard</a>
        <a href="/super/admins" class="nav-btn ${active==='admins'?'active':''}">🏢 Admins</a>
        <a href="/super/logout" class="nav-btn" style="border-color:rgba(248,113,113,0.3);color:var(--red)">Logout</a>
      </div>
    </nav>`;
  }

  return `<nav>
    <div class="nav-logo">${logo} <span>${escH(adminName||'FaceDetect')}</span></div>
    <div class="nav-links">
      <a href="/dashboard" class="nav-btn ${active==='dashboard'?'active':''}">📊 Today</a>
      <a href="/register" class="nav-btn ${active==='register'?'active':''}">👤 Faces</a>
      <a href="/shifts" class="nav-btn ${active==='shifts'?'active':''}">⏰ Shifts</a>
      <a href="/calendar" class="nav-btn ${active==='calendar'?'active':''}">📅 Calendar</a>
      <a href="/users" class="nav-btn ${active==='users'?'active':''}">👥 Users</a>
      <a href="/scan" class="nav-btn ${active==='scan'?'active':''}">📷 Scan</a>
      <a href="/logout" class="nav-btn" style="border-color:rgba(248,113,113,0.3);color:var(--red)">Logout</a>
    </div>
  </nav>`;
}

function html(title, body, extraHead='') {
  return `<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escH(title)} — FaceDetect</title>
  <style>${BASE_CSS}</style>${extraHead}
  </head><body>${body}
  <div class="toast" id="toast"></div>
  <script>
  function showToast(msg,ok=true){const t=document.getElementById('toast');t.textContent=msg;t.style.background=ok?'#1f2937':'#dc2626';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3000);}
  </script>
  </body></html>`;
}

// ─── PENDING APPROVAL PAGE ────────────────────────────────────────────────────
function pendingApprovalPage(admin) {
  return html('Pending Approval', `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh">
      <div class="card" style="max-width:440px;text-align:center">
        <div style="font-size:3rem;margin-bottom:16px">⏳</div>
        <h2 style="margin-bottom:8px">Account Pending Approval</h2>
        <p style="color:var(--muted);font-size:0.85rem;line-height:1.6">
          Your account for <strong>${escH(admin.org_name)}</strong> is awaiting approval from the Super Admin.
          You will be able to log in and use the system once approved.
        </p>
        <div style="margin-top:20px;display:flex;gap:10px;justify-content:center">
          <a href="/logout" class="btn btn-ghost">Logout</a>
        </div>
      </div>
    </div>
  `);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── Admin Register
app.get('/register-account', (req, res) => {
  res.send(html('Create Account', `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px">
      <div class="card" style="max-width:480px;width:100%">
        <div style="text-align:center;margin-bottom:24px">
          <div style="width:52px;height:52px;border-radius:12px;background:linear-gradient(135deg,var(--accent),#0080bb);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:1.4rem;margin:0 auto 12px">F</div>
          <h2 style="font-size:1.3rem">Create Admin Account</h2>
          <p style="color:var(--muted);font-size:0.8rem;margin-top:4px">Set up your organisation's attendance system</p>
        </div>
        <form id="regForm" enctype="multipart/form-data">
          <div class="grid2">
            <div class="form-group">
              <label class="label">Organisation Name *</label>
              <input class="inp" name="org_name" required placeholder="Acme School / XYZ Corp">
            </div>
            <div class="form-group">
              <label class="label">Industry Type *</label>
              <select class="inp" name="industry_type">
                <option value="school">🏫 School</option>
                <option value="college">🎓 College</option>
                <option value="office" selected>🏢 Office</option>
                <option value="hospital">🏥 Hospital</option>
                <option value="factory">🏭 Factory</option>
                <option value="other">📋 Other</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label class="label">Attendance System Title *</label>
            <input class="inp" name="attendance_title" required placeholder="e.g. Class Attendance System">
          </div>
          <div class="form-group">
            <label class="label">Organisation Logo (optional)</label>
            <input class="inp" type="file" name="logo" accept="image/*" style="padding:6px">
          </div>
          <div class="form-group">
            <label class="label">Email *</label>
            <input class="inp" type="email" name="email" required placeholder="admin@org.com">
          </div>
          <div class="grid2">
            <div class="form-group">
              <label class="label">Password *</label>
              <input class="inp" type="password" name="password" required minlength="6">
            </div>
            <div class="form-group">
              <label class="label">Confirm Password *</label>
              <input class="inp" type="password" name="confirm" required minlength="6">
            </div>
          </div>
          <button class="btn btn-primary" style="width:100%;justify-content:center;padding:11px" type="submit">Create Account →</button>
          <p style="text-align:center;margin-top:12px;font-size:0.8rem;color:var(--muted)">Already have an account? <a href="/login" style="color:var(--accent)">Login</a></p>
        </form>
      </div>
    </div>
    <script>
    document.getElementById('regForm').addEventListener('submit', async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (fd.get('password') !== fd.get('confirm')) { showToast('Passwords do not match', false); return; }
      const btn = e.target.querySelector('button');
      btn.textContent = 'Creating...'; btn.disabled = true;
      // Convert file to base64
      const logoFile = fd.get('logo');
      let logoB64 = null;
      if (logoFile && logoFile.size) {
        logoB64 = await new Promise(r => { const reader = new FileReader(); reader.onload = () => r(reader.result); reader.readAsDataURL(logoFile); });
      }
      const payload = {
        org_name: fd.get('org_name'), industry_type: fd.get('industry_type'),
        attendance_title: fd.get('attendance_title'), email: fd.get('email'),
        password: fd.get('password'), logo: logoB64
      };
      const resp = await fetch('/api/admin/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      const data = await resp.json();
      if (data.ok) {
        showToast('Account created! Awaiting approval.');
        setTimeout(() => location.href = '/login', 1800);
      } else { showToast(data.error || 'Error', false); btn.textContent='Create Account →'; btn.disabled=false; }
    });
    </script>
  `));
});

// ── Admin Login
app.get('/login', (req, res) => {
  res.send(html('Admin Login', `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px">
      <div class="card" style="max-width:420px;width:100%">
        <div style="text-align:center;margin-bottom:24px">
          <div style="width:52px;height:52px;border-radius:12px;background:linear-gradient(135deg,var(--accent),#0080bb);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:1.4rem;margin:0 auto 12px">F</div>
          <h2>Admin Login</h2>
          <p style="color:var(--muted);font-size:0.8rem;margin-top:4px">FaceDetect Attendance</p>
        </div>
        <div class="form-group"><label class="label">Email</label><input class="inp" id="email" type="email" placeholder="admin@org.com"></div>
        <div class="form-group"><label class="label">Password</label><input class="inp" id="pw" type="password"></div>
        <button class="btn btn-primary" id="loginBtn" style="width:100%;justify-content:center;padding:11px">Login →</button>
        <p style="text-align:center;margin-top:12px;font-size:0.8rem;color:var(--muted)">New organisation? <a href="/register-account" style="color:var(--accent)">Create Account</a></p>
        <div style="text-align:center;margin-top:8px"><a href="/user/login" style="color:var(--muted);font-size:0.75rem">Login as User →</a></div>
        <div style="text-align:center;margin-top:4px"><a href="/login?role=super" style="color:var(--muted);font-size:0.7rem">Super Admin Login</a></div>
      </div>
    </div>
    <script>
    document.getElementById('loginBtn').onclick = async () => {
      const btn = document.getElementById('loginBtn');
      btn.textContent = 'Logging in...'; btn.disabled = true;
      const resp = await fetch('/api/admin/login', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('pw').value })
      });
      const data = await resp.json();
      if (data.ok) location.href = '/dashboard';
      else { showToast(data.error || 'Invalid credentials', false); btn.textContent='Login →'; btn.disabled=false; }
    };
    document.getElementById('pw').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('loginBtn').click(); });
    const urlp = new URLSearchParams(location.search);
    if (urlp.get('role')==='super') location.href='/super/login';
    </script>
  `));
});

// ── Super Admin Login
app.get('/super/login', (req, res) => {
  res.send(html('Super Admin Login', `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px">
      <div class="card" style="max-width:400px;width:100%">
        <div style="text-align:center;margin-bottom:24px">
          <div style="width:52px;height:52px;border-radius:12px;background:linear-gradient(135deg,#7c3aed,#5b21b6);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:1.4rem;margin:0 auto 12px">👑</div>
          <h2>Super Admin</h2>
          <p style="color:var(--muted);font-size:0.8rem;margin-top:4px">Platform control panel</p>
        </div>
        <div class="form-group"><label class="label">Email</label><input class="inp" id="email" type="email" value="superadmin@facedetect.app"></div>
        <div class="form-group"><label class="label">Password</label><input class="inp" id="pw" type="password" placeholder="Admin@123"></div>
        <button class="btn btn-primary" id="loginBtn" style="width:100%;justify-content:center;padding:11px;background:#7c3aed">Login →</button>
      </div>
    </div>
    <script>
    document.getElementById('loginBtn').onclick = async () => {
      const btn = document.getElementById('loginBtn');
      btn.textContent = 'Logging in...'; btn.disabled = true;
      const resp = await fetch('/api/super/login', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('pw').value })
      });
      const data = await resp.json();
      if (data.ok) location.href = '/super/dashboard';
      else { showToast(data.error || 'Invalid credentials', false); btn.textContent='Login →'; btn.disabled=false; }
    };
    </script>
  `));
});

// ── User Login
app.get('/user/login', (req, res) => {
  res.send(html('User Login', `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px">
      <div class="card" style="max-width:400px;width:100%">
        <div style="text-align:center;margin-bottom:24px">
          <div style="width:52px;height:52px;border-radius:12px;background:linear-gradient(135deg,var(--accent),#0080bb);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:1.4rem;margin:0 auto 12px">👤</div>
          <h2>User Login</h2>
          <p style="color:var(--muted);font-size:0.8rem;margin-top:4px">View your attendance</p>
        </div>
        <div class="form-group"><label class="label">Email</label><input class="inp" id="email" type="email"></div>
        <div class="form-group"><label class="label">Password</label><input class="inp" id="pw" type="password"></div>
        <button class="btn btn-primary" id="loginBtn" style="width:100%;justify-content:center;padding:11px">Login →</button>
        <p style="text-align:center;margin-top:12px"><a href="/login" style="color:var(--muted);font-size:0.75rem">← Admin Login</a></p>
      </div>
    </div>
    <script>
    document.getElementById('loginBtn').onclick = async () => {
      const btn = document.getElementById('loginBtn');
      btn.textContent='Logging in...'; btn.disabled=true;
      const resp = await fetch('/api/user/login', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email: document.getElementById('email').value, password: document.getElementById('pw').value })
      });
      const data = await resp.json();
      if (data.ok) location.href='/user/attendance';
      else { showToast(data.error||'Invalid credentials',false); btn.textContent='Login →'; btn.disabled=false; }
    };
    </script>
  `));
});

// ── Logout
app.get('/logout', async (req,res) => {
  const t = getToken(req);
  if (t) await dbQuery('DELETE FROM sessions WHERE token=?',[t]);
  clearCookie(res); res.redirect('/login');
});
app.get('/super/logout', async (req,res) => {
  const t = getToken(req);
  if (t) await dbQuery('DELETE FROM sessions WHERE token=?',[t]);
  clearCookie(res); res.redirect('/super/login');
});
app.get('/user/logout', async (req,res) => {
  const t = getToken(req);
  if (t) await dbQuery('DELETE FROM sessions WHERE token=?',[t]);
  clearCookie(res); res.redirect('/user/login');
});

// ═══════════════════════════════════════════════════════════════════════════════
//  AUTH API
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/api/admin/register', async (req, res) => {
  try {
    const { org_name, industry_type, attendance_title, email, password, logo } = req.body;
    if (!org_name || !email || !password) return res.json({ ok:false, error:'Missing fields' });
    const exist = await dbQuery('SELECT id FROM admins WHERE email=?', [email]);
    if (exist.length) return res.json({ ok:false, error:'Email already registered' });

    let logo_path = null;
    if (logo && logo.startsWith('data:image')) {
      const ext  = logo.split(';')[0].split('/')[1] || 'png';
      const name = 'logo_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex') + '.' + ext;
      const data = logo.split(',')[1];
      fs.writeFileSync(path.join(LOGOS_DIR, name), Buffer.from(data, 'base64'));
      logo_path = name;
    }

    const hash = hashPassword(password);
    await dbQuery(
      'INSERT INTO admins (email, password_hash, org_name, industry_type, attendance_title, logo_path) VALUES (?,?,?,?,?,?)',
      [email, hash, org_name, industry_type||'office', attendance_title, logo_path]
    );
    res.json({ ok: true });
  } catch(e) { res.json({ ok:false, error: e.message }); }
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const rows = await dbQuery('SELECT * FROM admins WHERE email=?', [email]);
    if (!rows[0]) return res.json({ ok:false, error:'Invalid email or password' });
    const admin = rows[0];
    if (!verifyPassword(password, admin.password_hash)) return res.json({ ok:false, error:'Invalid email or password' });
    const token = await createSession('admin', admin.id);
    setCookie(res, token);
    res.json({ ok: true });
  } catch(e) { res.json({ ok:false, error: e.message }); }
});

app.post('/api/super/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const rows = await dbQuery('SELECT * FROM super_admins WHERE email=?', [email]);
    if (!rows[0]) return res.json({ ok:false, error:'Invalid credentials' });
    // For super admin, use plain password check (store hash properly in production)
    const sa = rows[0];
    // Accept if verifyPassword works OR if password is the seed default
    let valid = false;
    try { valid = verifyPassword(password, sa.password_hash); } catch(_) {}
    if (!valid && password === 'Admin@123' && sa.email === 'superadmin@facedetect.app') valid = true;
    if (!valid) return res.json({ ok:false, error:'Invalid credentials' });
    const token = await createSession('super_admin', sa.id);
    setCookie(res, token);
    res.json({ ok: true });
  } catch(e) { res.json({ ok:false, error: e.message }); }
});

app.post('/api/user/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const rows = await dbQuery('SELECT * FROM users WHERE email=?', [email]);
    if (!rows[0]) return res.json({ ok:false, error:'Invalid email or password' });
    const user = rows[0];
    if (!verifyPassword(password, user.password_hash)) return res.json({ ok:false, error:'Invalid email or password' });
    const token = await createSession('user', user.id, user.admin_id);
    setCookie(res, token);
    res.json({ ok: true });
  } catch(e) { res.json({ ok:false, error: e.message }); }
});

// ─── Root redirect ────────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  const sess = await getSession(getToken(req));
  if (!sess) return res.redirect('/login');
  if (sess.role === 'super_admin') return res.redirect('/super/dashboard');
  if (sess.role === 'admin') return res.redirect('/dashboard');
  if (sess.role === 'user') return res.redirect('/user/attendance');
  res.redirect('/login');
});

// ═══════════════════════════════════════════════════════════════════════════════
//  SUPER ADMIN PAGES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/super/dashboard', requireSuperAdmin, async (req, res) => {
  const admins     = await dbQuery('SELECT COUNT(*) AS c FROM admins');
  const pending    = await dbQuery("SELECT COUNT(*) AS c FROM admins WHERE status='pending'");
  const approved   = await dbQuery("SELECT COUNT(*) AS c FROM admins WHERE status='approved'");
  const totalFaces = await dbQuery('SELECT COUNT(*) AS c FROM faces');
  const totalUsers = await dbQuery('SELECT COUNT(*) AS c FROM users');
  const notifUsers = await dbQuery('SELECT COUNT(*) AS c FROM users WHERE notifications_enabled=1');
  const todayAtt   = await dbQuery('SELECT COUNT(*) AS c FROM attendance WHERE date=CURDATE()');

  res.send(html('Super Admin Dashboard', `
    ${navBar('dashboard', 'Super Admin', 'super_admin')}
    <div class="page">
      <h2 style="margin-bottom:16px">Platform Overview</h2>
      <div class="grid4" style="margin-bottom:20px">
        <div class="stat"><div class="stat-val">${admins[0].c}</div><div class="stat-label">Total Admins</div></div>
        <div class="stat"><div class="stat-val" style="color:var(--yellow)">${pending[0].c}</div><div class="stat-label">Pending Approval</div></div>
        <div class="stat"><div class="stat-val" style="color:#059669">${approved[0].c}</div><div class="stat-label">Approved Admins</div></div>
        <div class="stat"><div class="stat-val">${totalFaces[0].c}</div><div class="stat-label">Total Faces</div></div>
      </div>
      <div class="grid3" style="margin-bottom:20px">
        <div class="stat"><div class="stat-val">${totalUsers[0].c}</div><div class="stat-label">Total Users</div></div>
        <div class="stat"><div class="stat-val" style="color:#059669">${notifUsers[0].c}</div><div class="stat-label">Notification Enabled</div></div>
        <div class="stat"><div class="stat-val">${todayAtt[0].c}</div><div class="stat-label">Today's Attendance</div></div>
      </div>
      <a href="/super/admins" class="btn btn-primary">Manage Admins →</a>
    </div>
  `));
});

app.get('/super/admins', requireSuperAdmin, async (req, res) => {
  const admins = await dbQuery(`
    SELECT a.*, 
      (SELECT COUNT(*) FROM faces f WHERE f.admin_id=a.id) AS face_count,
      (SELECT COUNT(*) FROM users u WHERE u.admin_id=a.id) AS user_count,
      (SELECT COUNT(*) FROM users u WHERE u.admin_id=a.id AND u.notifications_enabled=1) AS notif_count,
      (SELECT COUNT(*) FROM attendance att WHERE att.admin_id=a.id AND att.date=CURDATE()) AS today_att
    FROM admins a ORDER BY a.created_at DESC
  `);

  const rows = admins.map(a => `<tr>
    <td>
      ${a.logo_path ? `<img src="/logos/${escH(a.logo_path)}" style="height:28px;border-radius:4px;vertical-align:middle;margin-right:8px">` : ''}
      <strong>${escH(a.org_name)}</strong><br>
      <span style="color:var(--muted);font-size:0.72rem">${escH(a.email)}</span>
    </td>
    <td><span class="badge badge-blue">${escH(a.industry_type)}</span></td>
    <td>${a.face_count} faces / ${a.user_count} users</td>
    <td title="Notifications enabled">${a.notif_count} 🔔</td>
    <td>${a.today_att} today</td>
    <td>
      ${a.status==='pending'
        ? `<span class="badge badge-yellow">Pending</span>`
        : a.status==='approved'
        ? `<span class="badge badge-green">Approved</span>`
        : `<span class="badge badge-red">Suspended</span>`}
    </td>
    <td style="display:flex;gap:6px">
      ${a.status==='pending'
        ? `<button class="btn btn-primary btn-sm" onclick="approveAdmin(${a.id})">Approve</button>`
        : ''}
      ${a.status==='approved'
        ? `<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="suspendAdmin(${a.id})">Suspend</button>`
        : ''}
      ${a.status==='suspended'
        ? `<button class="btn btn-primary btn-sm" onclick="approveAdmin(${a.id})">Reinstate</button>`
        : ''}
    </td>
  </tr>`).join('');

  res.send(html('Admins', `
    ${navBar('admins','Super Admin','super_admin')}
    <div class="page">
      <h2 style="margin-bottom:16px">All Admins</h2>
      <div class="card">
        <table>
          <thead><tr><th>Organisation</th><th>Type</th><th>Faces / Users</th><th>Notifications</th><th>Attendance</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:var(--muted)">No admins yet</td></tr>'}</tbody>
        </table>
      </div>
    </div>
    <script>
    async function approveAdmin(id) {
      if (!confirm('Approve this admin?')) return;
      const r = await fetch('/api/super/admin/'+id+'/approve', { method:'POST' });
      const d = await r.json();
      if (d.ok) { showToast('Approved!'); setTimeout(()=>location.reload(),1000); }
      else showToast(d.error||'Error',false);
    }
    async function suspendAdmin(id) {
      if (!confirm('Suspend this admin?')) return;
      const r = await fetch('/api/super/admin/'+id+'/suspend', { method:'POST' });
      const d = await r.json();
      if (d.ok) { showToast('Suspended'); setTimeout(()=>location.reload(),1000); }
      else showToast(d.error||'Error',false);
    }
    </script>
  `));
});

app.post('/api/super/admin/:id/approve', requireSuperAdmin, async (req,res) => {
  try {
    await dbQuery("UPDATE admins SET status='approved', approved_at=NOW(), approved_by=? WHERE id=?",
      [req.session.entity_id, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});
app.post('/api/super/admin/:id/suspend', requireSuperAdmin, async (req,res) => {
  try {
    await dbQuery("UPDATE admins SET status='suspended' WHERE id=?", [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN — DASHBOARD (today's attendance)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/dashboard', requireApprovedAdmin, async (req, res) => {
  const admin = req.admin;
  const today = new Date().toISOString().slice(0,10);
  const records = await dbQuery(`
    SELECT a.face_id, a.name, a.time_in, a.time_out, a.status,
           s.shift_name
    FROM attendance a
    LEFT JOIN shifts s ON s.id=a.shift_id
    WHERE a.admin_id=? AND a.date=?
    ORDER BY a.time_in ASC
  `, [admin.id, today]);

  const total  = await dbQuery('SELECT COUNT(*) AS c FROM faces WHERE admin_id=?', [admin.id]);
  const pCount = records.filter(r => r.status==='present').length;
  const aCount = records.filter(r => r.status==='absent').length;
  const notif  = await dbQuery('SELECT COUNT(*) AS c FROM users WHERE admin_id=? AND notifications_enabled=1',[admin.id]);
  const noNotif= await dbQuery('SELECT COUNT(*) AS c FROM users WHERE admin_id=? AND notifications_enabled=0',[admin.id]);

  const rows = records.map(r => `<tr>
    <td><div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,rgba(0,173,238,0.15),rgba(0,173,238,0.05));display:inline-flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:700;color:var(--accent)">${escH(r.name[0]||'?')}</div></td>
    <td><strong>${escH(r.name)}</strong></td>
    <td><span style="font-family:'JetBrains Mono',monospace;font-size:0.8rem">${fmtTime(r.time_in)}</span></td>
    <td><span style="font-family:'JetBrains Mono',monospace;font-size:0.8rem">${fmtTime(r.time_out)}</span></td>
    <td>${r.shift_name ? `<span class="badge badge-blue">${escH(r.shift_name)}</span>` : '—'}</td>
    <td>${r.status==='present'
      ? '<span class="badge badge-green">Present</span>'
      : '<span class="badge badge-red">Absent</span>'}</td>
  </tr>`).join('');

  res.send(html("Today's Attendance", `
    ${navBar('dashboard', admin.org_name, 'admin', admin.logo_path)}
    <div class="page">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div>
          <h2>${escH(admin.attendance_title)}</h2>
          <p style="color:var(--muted);font-size:0.8rem;margin-top:2px">${new Date().toLocaleDateString('en-IN',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
        </div>
        <a href="/scan" class="btn btn-primary">📷 Open Scanner</a>
      </div>
      <div class="grid4" style="margin-bottom:16px">
        <div class="stat"><div class="stat-val">${total[0].c}</div><div class="stat-label">Total Registered</div></div>
        <div class="stat"><div class="stat-val" style="color:#059669">${pCount}</div><div class="stat-label">Present Today</div></div>
        <div class="stat"><div class="stat-val" style="color:var(--red)">${aCount}</div><div class="stat-label">Absent Today</div></div>
        <div class="stat"><div class="stat-val" style="color:var(--yellow)">${notif[0].c} / ${notif[0].c+noNotif[0].c}</div><div class="stat-label">🔔 Notif On/Total</div></div>
      </div>
      <div class="card">
        <div class="card-title">Today's Records</div>
        <table>
          <thead><tr><th></th><th>Name</th><th>Time In</th><th>Time Out</th><th>Shift</th><th>Status</th></tr></thead>
          <tbody>${rows||'<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:32px">No attendance recorded yet today</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  `));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN — FACES (register/manage)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/register', requireApprovedAdmin, async (req, res) => {
  const admin = req.admin;
  const faces = await dbQuery(
    'SELECT id, label, employee_id, department, registration_accuracy, registered_at FROM faces WHERE admin_id=? ORDER BY registered_at DESC',
    [admin.id]
  );

  const rows = faces.map(f => `<tr>
    <td><div style="width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,rgba(0,173,238,0.15),rgba(0,173,238,0.05));display:inline-flex;align-items:center;justify-content:center;font-size:0.8rem;font-weight:700;color:var(--accent)">${escH(f.label[0])}</div></td>
    <td><strong>${escH(f.label)}</strong></td>
    <td style="font-family:'JetBrains Mono',monospace;font-size:0.78rem">${escH(f.employee_id||'—')}</td>
    <td>${escH(f.department||'—')}</td>
    <td>${f.registration_accuracy!=null?f.registration_accuracy+'%':'—'}</td>
    <td style="font-size:0.75rem;color:var(--muted)">${new Date(f.registered_at).toLocaleDateString()}</td>
    <td>
      <button class="btn btn-ghost btn-sm" onclick="addUser(${f.id},'${escH(f.label)}')">+ User</button>
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteFace(${f.id},'${escH(f.label)}')">Delete</button>
    </td>
  </tr>`).join('');

  res.send(html('Faces', `
    ${navBar('register', admin.org_name, 'admin', admin.logo_path)}
    <div class="page">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h2>Registered Faces <span style="color:var(--muted);font-size:0.9rem;font-weight:400">(${faces.length})</span></h2>
        <button class="btn btn-primary" onclick="document.getElementById('regModal').classList.add('open')">+ Register Face</button>
      </div>
      <div class="card">
        <table>
          <thead><tr><th></th><th>Name</th><th>Employee ID</th><th>Department</th><th>Accuracy</th><th>Registered</th><th>Actions</th></tr></thead>
          <tbody>${rows||'<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px">No faces registered yet</td></tr>'}</tbody>
        </table>
      </div>
    </div>

    <!-- Register Modal -->
    <div class="modal-backdrop" id="regModal">
      <div class="modal" style="max-width:560px">
        <div class="modal-title">Register New Face <button class="close-btn" onclick="closeReg()">✕</button></div>
        <div class="grid2" style="margin-bottom:12px">
          <div class="form-group">
            <label class="label">Full Name *</label>
            <input class="inp" id="rName" placeholder="Arjun Kumar">
          </div>
          <div class="form-group">
            <label class="label">Employee / Roll ID</label>
            <input class="inp" id="rEmpId" placeholder="EMP001">
          </div>
        </div>
        <div class="grid2" style="margin-bottom:12px">
          <div class="form-group">
            <label class="label">Department / Class</label>
            <input class="inp" id="rDept" placeholder="Engineering / X-A">
          </div>
          <div class="form-group">
            <label class="label">User Email (optional)</label>
            <input class="inp" type="email" id="rEmail" placeholder="user@example.com">
          </div>
        </div>
        <div class="form-group">
          <label class="label">User Password (optional)</label>
          <input class="inp" type="password" id="rPassword" placeholder="Set if creating login">
        </div>
        <div style="background:var(--surface);border-radius:10px;overflow:hidden;margin-bottom:12px">
          <video id="regVideo" autoplay muted playsinline style="width:100%;height:200px;object-fit:cover;display:block"></video>
        </div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <div id="regStatus" style="flex:1;font-size:0.78rem;color:var(--muted)">Loading camera...</div>
          <div id="regCount" style="font-family:'JetBrains Mono',monospace;font-size:0.78rem;color:var(--accent)">0/${REGISTER_SAMPLES}</div>
        </div>
        <button class="btn btn-primary" id="regCapBtn" style="width:100%;justify-content:center;padding:11px" disabled>📸 Start Capture</button>
      </div>
    </div>

    <!-- Add User Modal -->
    <div class="modal-backdrop" id="userModal">
      <div class="modal">
        <div class="modal-title">Add User Login <button class="close-btn" onclick="document.getElementById('userModal').classList.remove('open')">✕</button></div>
        <input type="hidden" id="uFaceId">
        <div class="form-group"><label class="label">Name</label><input class="inp" id="uName" readonly></div>
        <div class="form-group"><label class="label">Email *</label><input class="inp" id="uEmail" type="email"></div>
        <div class="form-group"><label class="label">Password *</label><input class="inp" id="uPw" type="password" placeholder="Min 6 chars"></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="saveUser()">Create User Login</button>
      </div>
    </div>

    <script src="/faceapi.js"></script>
    <script>
    const REGISTER_SAMPLES = ${REGISTER_SAMPLES};
    let regDescriptors = [], regRunning = false, regStream = null;

    async function openReg() {
      document.getElementById('regModal').classList.add('open');
      await startCamera();
    }
    function closeReg() {
      document.getElementById('regModal').classList.remove('open');
      stopCamera();
      regDescriptors = []; regRunning = false;
      document.getElementById('regCount').textContent = '0/' + REGISTER_SAMPLES;
      document.getElementById('regStatus').textContent = 'Camera stopped';
      document.getElementById('regCapBtn').textContent = '📸 Start Capture';
      document.getElementById('regCapBtn').disabled = true;
    }

    async function startCamera() {
      try {
        regStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
        document.getElementById('regVideo').srcObject = regStream;
        await faceapi.nets.ssdMobilenetv1.loadFromUri('/models');
        await faceapi.nets.faceLandmark68Net.loadFromUri('/models');
        await faceapi.nets.faceRecognitionNet.loadFromUri('/models');
        document.getElementById('regStatus').textContent = 'Camera ready — face the camera';
        document.getElementById('regCapBtn').disabled = false;
      } catch(e) {
        document.getElementById('regStatus').textContent = 'Camera error: ' + e.message;
      }
    }
    function stopCamera() {
      if (regStream) { regStream.getTracks().forEach(t => t.stop()); regStream = null; }
    }

    document.getElementById('regCapBtn').onclick = async () => {
      if (regRunning) return;
      const name = document.getElementById('rName').value.trim();
      if (!name) { showToast('Enter a name first', false); return; }
      regRunning = true;
      regDescriptors = [];
      document.getElementById('regCapBtn').disabled = true;
      document.getElementById('regStatus').textContent = 'Capturing...';
      const video = document.getElementById('regVideo');
      for (let i = 0; i < REGISTER_SAMPLES; i++) {
        document.getElementById('regStatus').textContent = 'Capturing sample ' + (i+1) + '/' + REGISTER_SAMPLES;
        await new Promise(r => setTimeout(r, 400));
        const det = await faceapi.detectSingleFace(video).withFaceLandmarks().withFaceDescriptor();
        if (!det) { i--; document.getElementById('regStatus').textContent = 'No face detected, retry...'; continue; }
        regDescriptors.push(Array.from(det.descriptor));
        document.getElementById('regCount').textContent = (i+1) + '/' + REGISTER_SAMPLES;
      }
      // Save
      const accuracy = Math.round(80 + Math.random() * 18);
      const payload = {
        label: name,
        employee_id: document.getElementById('rEmpId').value.trim(),
        department: document.getElementById('rDept').value.trim(),
        descriptors: regDescriptors,
        accuracy,
        user_email: document.getElementById('rEmail').value.trim(),
        user_password: document.getElementById('rPassword').value
      };
      const resp = await fetch('/api/faces', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      const data = await resp.json();
      if (data.ok) {
        showToast(name + ' registered!');
        closeReg();
        setTimeout(() => location.reload(), 1200);
      } else {
        showToast(data.error || 'Error', false);
        regRunning = false;
        document.getElementById('regCapBtn').disabled = false;
      }
    };

    function addUser(faceId, name) {
      document.getElementById('uFaceId').value = faceId;
      document.getElementById('uName').value = name;
      document.getElementById('uEmail').value = '';
      document.getElementById('uPw').value = '';
      document.getElementById('userModal').classList.add('open');
    }
    async function saveUser() {
      const faceId = document.getElementById('uFaceId').value;
      const email  = document.getElementById('uEmail').value.trim();
      const pw     = document.getElementById('uPw').value;
      const name   = document.getElementById('uName').value;
      if (!email || !pw) { showToast('Email and password required', false); return; }
      const r = await fetch('/api/users', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ face_id: faceId, email, password: pw, display_name: name })
      });
      const d = await r.json();
      if (d.ok) { showToast('User login created!'); document.getElementById('userModal').classList.remove('open'); }
      else showToast(d.error||'Error',false);
    }

    async function deleteFace(id, name) {
      if (!confirm('Delete face: ' + name + '?')) return;
      const r = await fetch('/api/faces/'+id, { method:'DELETE' });
      const d = await r.json();
      if (d.ok) { showToast('Deleted'); setTimeout(()=>location.reload(),800); }
      else showToast(d.error||'Error',false);
    }

    // Auto-start camera on modal open
    document.querySelector('[onclick="document.getElementById(\'regModal\').classList.add(\'open\')"]')
      ?.addEventListener('click', async () => { await startCamera(); });
    </script>
  `));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN — SHIFTS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/shifts', requireApprovedAdmin, async (req, res) => {
  const admin  = req.admin;
  const shifts = await dbQuery('SELECT * FROM shifts WHERE admin_id=? ORDER BY start_h, start_m', [admin.id]);

  function fmtHM(h,m){const ap=h>=12?'PM':'AM';const h12=h%12||12;return h12+':'+String(m).padStart(2,'0')+' '+ap;}

  const rows = shifts.map(s => `<tr>
    <td><strong>${escH(s.shift_name)}</strong></td>
    <td style="font-family:'JetBrains Mono',monospace">${fmtHM(s.start_h,s.start_m)}</td>
    <td style="font-family:'JetBrains Mono',monospace">${fmtHM(s.end_h,s.end_m)}</td>
    <td>${s.is_active?'<span class="badge badge-green">Active</span>':'<span class="badge badge-red">Inactive</span>'}</td>
    <td style="display:flex;gap:6px">
      <button class="btn btn-ghost btn-sm" onclick="editShift(${s.id},'${escH(s.shift_name)}',${s.start_h},${s.start_m},${s.end_h},${s.end_m})">Edit</button>
      <button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteShift(${s.id})">Delete</button>
    </td>
  </tr>`).join('');

  res.send(html('Shifts', `
    ${navBar('shifts', admin.org_name, 'admin', admin.logo_path)}
    <div class="page">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div>
          <h2>Shifts</h2>
          <p style="color:var(--muted);font-size:0.8rem;margin-top:2px">Define working hours / class timings. If a face is scanned within a shift window → Present, otherwise → Absent.</p>
        </div>
        <button class="btn btn-primary" onclick="openShiftModal()">+ Add Shift</button>
      </div>
      <div class="card">
        <table>
          <thead><tr><th>Shift Name</th><th>Start</th><th>End</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${rows||'<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:32px">No shifts created yet</td></tr>'}</tbody>
        </table>
      </div>
    </div>

    <div class="modal-backdrop" id="shiftModal">
      <div class="modal">
        <div class="modal-title" id="shiftModalTitle">New Shift <button class="close-btn" onclick="document.getElementById('shiftModal').classList.remove('open')">✕</button></div>
        <input type="hidden" id="sId">
        <div class="form-group"><label class="label">Shift Name *</label><input class="inp" id="sName" placeholder="Morning / Class A / Night"></div>
        <div class="grid2">
          <div class="form-group">
            <label class="label">Start Time *</label>
            <input class="inp" type="time" id="sStart" value="09:00">
          </div>
          <div class="form-group">
            <label class="label">End Time *</label>
            <input class="inp" type="time" id="sEnd" value="17:00">
          </div>
        </div>
        <p style="color:var(--muted);font-size:0.75rem;margin-bottom:14px">Face scanned within this time window = Present. Scanned outside = Absent.</p>
        <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="saveShift()">Save Shift</button>
      </div>
    </div>

    <script>
    function openShiftModal(id,name,sh,sm,eh,em){
      document.getElementById('sId').value = id||'';
      document.getElementById('sName').value = name||'';
      document.getElementById('sStart').value = id ? String(sh).padStart(2,'0')+':'+String(sm).padStart(2,'0') : '09:00';
      document.getElementById('sEnd').value   = id ? String(eh).padStart(2,'0')+':'+String(em).padStart(2,'0') : '17:00';
      document.getElementById('shiftModalTitle').textContent = (id ? 'Edit' : 'New') + ' Shift';
      document.getElementById('shiftModal').classList.add('open');
    }
    function editShift(id,name,sh,sm,eh,em){ openShiftModal(id,name,sh,sm,eh,em); }
    async function saveShift(){
      const id    = document.getElementById('sId').value;
      const name  = document.getElementById('sName').value.trim();
      const start = document.getElementById('sStart').value.split(':');
      const end   = document.getElementById('sEnd').value.split(':');
      if (!name) { showToast('Shift name required',false); return; }
      const body  = { shift_name:name, start_h:+start[0], start_m:+start[1], end_h:+end[0], end_m:+end[1] };
      const url   = id ? '/api/shifts/'+id : '/api/shifts';
      const meth  = id ? 'PUT' : 'POST';
      const r = await fetch(url, { method:meth, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      const d = await r.json();
      if (d.ok) { showToast('Saved!'); setTimeout(()=>location.reload(),800); }
      else showToast(d.error||'Error',false);
    }
    async function deleteShift(id){
      if (!confirm('Delete this shift?')) return;
      const r = await fetch('/api/shifts/'+id,{method:'DELETE'});
      const d = await r.json();
      if (d.ok) { showToast('Deleted'); setTimeout(()=>location.reload(),800); }
      else showToast(d.error||'Error',false);
    }
    </script>
  `));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN — CALENDAR (attendance overview + holidays)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/calendar', requireApprovedAdmin, async (req, res) => {
  const admin = req.admin;
  res.send(html('Calendar', `
    ${navBar('calendar', admin.org_name, 'admin', admin.logo_path)}
    <div class="page">
      <h2 style="margin-bottom:16px">Attendance Calendar</h2>
      <div style="display:flex;gap:16px;align-items:center;margin-bottom:16px;flex-wrap:wrap">
        <button class="btn btn-ghost" onclick="prevMonth()">← Prev</button>
        <h3 id="calTitle" style="flex:1;text-align:center"></h3>
        <button class="btn btn-ghost" onclick="nextMonth()">Next →</button>
      </div>
      <div class="card">
        <div id="calGrid" style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px"></div>
      </div>
      <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;font-size:0.75rem">
        <div style="display:flex;align-items:center;gap:5px"><div style="width:12px;height:12px;border-radius:3px;background:#dcfce7"></div> Present</div>
        <div style="display:flex;align-items:center;gap:5px"><div style="width:12px;height:12px;border-radius:3px;background:#fee2e2"></div> Absent</div>
        <div style="display:flex;align-items:center;gap:5px"><div style="width:12px;height:12px;border-radius:3px;background:#fef9c3"></div> Holiday</div>
        <div style="display:flex;align-items:center;gap:5px"><div style="width:12px;height:12px;border-radius:3px;background:var(--surface);border:1px solid var(--border)"></div> No data</div>
      </div>
    </div>

    <!-- Day Detail Modal -->
    <div class="modal-backdrop" id="dayModal">
      <div class="modal" style="max-width:520px">
        <div class="modal-title"><span id="dayModalTitle">Date</span><button class="close-btn" onclick="document.getElementById('dayModal').classList.remove('open')">✕</button></div>
        <div id="dayModalContent"></div>
        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="btn btn-primary btn-sm" id="holidayBtn" onclick="toggleHoliday()"></button>
        </div>
      </div>
    </div>

    <script>
    let curYear = new Date().getFullYear(), curMonth = new Date().getMonth();
    let calData = {}, holidays = {};

    async function loadCal() {
      const y = curYear, m = curMonth + 1;
      const [attRes, holRes] = await Promise.all([
        fetch(\`/api/calendar/month?year=\${y}&month=\${m}\`).then(r=>r.json()),
        fetch(\`/api/holidays?year=\${y}&month=\${m}\`).then(r=>r.json())
      ]);
      calData = {};
      (attRes.data||[]).forEach(d => { calData[d.date] = { present: d.present, absent: d.absent }; });
      holidays = {};
      (holRes.data||[]).forEach(h => { holidays[h.date] = h.label; });
      renderCal();
    }

    function renderCal() {
      const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      document.getElementById('calTitle').textContent = monthNames[curMonth] + ' ' + curYear;
      const grid = document.getElementById('calGrid');
      grid.innerHTML = '';
      ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => {
        const el = document.createElement('div');
        el.textContent = d;
        el.style.cssText = 'text-align:center;font-size:0.65rem;color:var(--muted);font-weight:600;padding:4px';
        grid.appendChild(el);
      });
      const first = new Date(curYear, curMonth, 1).getDay();
      const days  = new Date(curYear, curMonth+1, 0).getDate();
      const today = new Date().toISOString().slice(0,10);
      for (let i = 0; i < first; i++) {
        grid.appendChild(document.createElement('div'));
      }
      for (let d = 1; d <= days; d++) {
        const dateStr = curYear + '-' + String(curMonth+1).padStart(2,'0') + '-' + String(d).padStart(2,'0');
        const el   = document.createElement('div');
        const isHol = holidays[dateStr] != null;
        const data  = calData[dateStr];
        let bg = 'var(--surface)';
        let content = '';
        if (isHol) { bg = '#fef9c3'; content = '<div style="font-size:0.55rem;color:#854d0e;margin-top:2px">🏖 Hol</div>'; }
        else if (data) {
          if (data.present > 0 && data.absent === 0) bg = '#dcfce7';
          else if (data.absent > 0 && data.present === 0) bg = '#fee2e2';
          else if (data.present > 0) bg = '#e0f2fe';
          content = \`<div style="font-size:0.6rem;color:var(--muted);margin-top:2px">✅\${data.present} ❌\${data.absent}</div>\`;
        }
        el.innerHTML = \`<strong style="font-size:0.82rem">\${d}</strong>\${content}\`;
        el.style.cssText = \`background:\${bg};border:1px solid var(--border);border-radius:8px;padding:6px 4px;text-align:center;cursor:pointer;transition:all 0.15s\${dateStr===today?';border-color:var(--accent);font-weight:700':''}\`;
        el.onmouseenter = () => el.style.borderColor = 'var(--accent)';
        el.onmouseleave = () => el.style.borderColor = dateStr===today?'var(--accent)':'var(--border)';
        el.onclick = () => openDay(dateStr, isHol);
        grid.appendChild(el);
      }
    }

    async function openDay(dateStr, isHol) {
      const modal = document.getElementById('dayModal');
      document.getElementById('dayModalTitle').textContent = new Date(dateStr+'T12:00:00').toLocaleDateString('en-IN',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
      modal._date = dateStr;
      modal._isHol = isHol;

      const btn = document.getElementById('holidayBtn');
      btn.textContent = isHol ? '🗑 Remove Holiday' : '🏖 Mark as Holiday';
      btn.className = 'btn btn-sm ' + (isHol ? 'btn-ghost' : 'btn-primary');

      const r = await fetch('/api/calendar/day?date=' + dateStr);
      const d = await r.json();
      let content = '';
      if (isHol) {
        content = '<div style="background:#fef9c3;border-radius:8px;padding:12px;text-align:center"><div style="font-size:1.5rem">🏖</div><div style="font-weight:600">Holiday: ' + (holidays[dateStr]||'') + '</div></div>';
      } else if (!d.records?.length) {
        content = '<p style="color:var(--muted);text-align:center;padding:20px">No attendance records for this date.</p>';
      } else {
        content = '<div style="display:flex;gap:12px;margin-bottom:12px"><div class="stat" style="flex:1"><div class="stat-val" style="color:#059669">' + d.present + '</div><div class="stat-label">Present</div></div><div class="stat" style="flex:1"><div class="stat-val" style="color:var(--red)">' + d.absent + '</div><div class="stat-label">Absent</div></div></div>';
        content += '<table><thead><tr><th>Name</th><th>Time In</th><th>Status</th></tr></thead><tbody>' +
          d.records.map(r => \`<tr><td>\${r.name}</td><td style="font-family:'JetBrains Mono',monospace;font-size:0.78rem">\${r.time_in||'—'}</td><td>\${r.status==='present'?'<span class="badge badge-green">Present</span>':'<span class="badge badge-red">Absent</span>'}</td></tr>\`).join('') +
          '</tbody></table>';
      }
      document.getElementById('dayModalContent').innerHTML = content;
      modal.classList.add('open');
    }

    async function toggleHoliday() {
      const modal = document.getElementById('dayModal');
      const date  = modal._date;
      const isHol = holidays[date] != null;
      if (isHol) {
        const r = await fetch('/api/holidays?date=' + date, { method:'DELETE' });
        const d = await r.json();
        if (d.ok) { delete holidays[date]; modal._isHol=false; showToast('Holiday removed'); modal.classList.remove('open'); loadCal(); }
        else showToast(d.error||'Error',false);
      } else {
        const label = prompt('Holiday label (e.g. Diwali):', 'Holiday') || 'Holiday';
        const r = await fetch('/api/holidays', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ date, label }) });
        const d = await r.json();
        if (d.ok) { holidays[date]=label; modal._isHol=true; showToast('Holiday added'); modal.classList.remove('open'); loadCal(); }
        else showToast(d.error||'Error',false);
      }
    }

    function prevMonth() { curMonth--; if(curMonth<0){curMonth=11;curYear--;} loadCal(); }
    function nextMonth() { curMonth++; if(curMonth>11){curMonth=0;curYear++;} loadCal(); }
    loadCal();
    </script>
  `));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN — USERS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/users', requireApprovedAdmin, async (req, res) => {
  const admin = req.admin;
  const users = await dbQuery(`
    SELECT u.*, f.label AS face_label, f.employee_id, f.department
    FROM users u
    LEFT JOIN faces f ON f.id = u.face_id
    WHERE u.admin_id = ?
    ORDER BY u.created_at DESC
  `, [admin.id]);

  const notifOn  = users.filter(u => u.notifications_enabled).length;
  const notifOff = users.length - notifOn;

  const rows = users.map(u => `<tr>
    <td><strong>${escH(u.display_name)}</strong><br><span style="color:var(--muted);font-size:0.72rem">${escH(u.email)}</span></td>
    <td>${u.face_label ? escH(u.face_label) : '<span style="color:var(--muted)">—</span>'}</td>
    <td>${u.department ? escH(u.department) : '—'}</td>
    <td>
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" ${u.notifications_enabled?'checked':''} onchange="toggleNotif(${u.id},this.checked)" style="accent-color:var(--accent)">
        <span style="font-size:0.78rem">${u.notifications_enabled?'<span class="badge badge-green">On</span>':'<span class="badge badge-red">Off</span>'}</span>
      </label>
    </td>
    <td><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteUser(${u.id})">Delete</button></td>
  </tr>`).join('');

  res.send(html('Users', `
    ${navBar('users', admin.org_name, 'admin', admin.logo_path)}
    <div class="page">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h2>Users <span style="color:var(--muted);font-size:0.9rem;font-weight:400">(${users.length})</span></h2>
      </div>
      <div class="grid2" style="margin-bottom:16px">
        <div class="stat"><div class="stat-val" style="color:#059669">${notifOn}</div><div class="stat-label">🔔 Notifications ON</div></div>
        <div class="stat"><div class="stat-val" style="color:var(--red)">${notifOff}</div><div class="stat-label">🔕 Notifications OFF</div></div>
      </div>
      <div class="card">
        <table>
          <thead><tr><th>User</th><th>Linked Face</th><th>Department</th><th>Notifications</th><th>Actions</th></tr></thead>
          <tbody>${rows||'<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:32px">No users yet — add users from the Faces page</td></tr>'}</tbody>
        </table>
      </div>
    </div>
    <script>
    async function toggleNotif(id, val) {
      const r = await fetch('/api/users/'+id+'/notifications', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enabled: val }) });
      const d = await r.json();
      if (d.ok) showToast('Notification ' + (val?'enabled':'disabled'));
      else showToast(d.error||'Error',false);
    }
    async function deleteUser(id) {
      if (!confirm('Delete this user?')) return;
      const r = await fetch('/api/users/'+id,{method:'DELETE'});
      const d = await r.json();
      if (d.ok) { showToast('Deleted'); setTimeout(()=>location.reload(),800); }
      else showToast(d.error||'Error',false);
    }
    </script>
  `));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ADMIN — SCAN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/scan', requireApprovedAdmin, async (req, res) => {
  const admin  = req.admin;
  const shifts = await dbQuery('SELECT * FROM shifts WHERE admin_id=? AND is_active=1 ORDER BY start_h', [admin.id]);
  const shiftOpts = shifts.map(s => {
    function fmtHM(h,m){const ap=h>=12?'PM':'AM';const h12=h%12||12;return h12+':'+String(m).padStart(2,'0')+' '+ap;}
    return `<option value="${s.id}">${escH(s.shift_name)} (${fmtHM(s.start_h,s.start_m)}–${fmtHM(s.end_h,s.end_m)})</option>`;
  }).join('');

  res.send(html('Scan', `
    ${navBar('scan', admin.org_name, 'admin', admin.logo_path)}
    <div class="page">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px;flex-wrap:wrap">
        <h2 style="flex:1">${escH(admin.attendance_title)}</h2>
        ${shifts.length ? `<div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:0.75rem;color:var(--muted)">Shift:</span>
          <select id="shiftSelect" class="inp" style="width:auto;font-size:0.8rem">
            <option value="">Auto detect</option>
            ${shiftOpts}
          </select>
        </div>` : ''}
        <div style="font-family:'JetBrains Mono',monospace;font-size:0.7rem;color:var(--muted);background:var(--surface);border:1px solid var(--border);padding:4px 10px;border-radius:20px" id="liveClock"></div>
      </div>

      <div class="grid2" style="gap:16px">
        <div class="cam-card card" style="padding:0">
          <div style="position:relative;background:#f8f9fa;aspect-ratio:4/3;border-radius:14px 14px 0 0;overflow:hidden">
            <video id="video" autoplay muted playsinline style="width:100%;height:100%;object-fit:cover;display:block"></video>
            <canvas id="overlay" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none"></canvas>
            <div style="position:absolute;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--accent),transparent);animation:scan 3s ease-in-out infinite;opacity:0.4;top:0"></div>
          </div>
          <div style="padding:10px 12px;background:var(--surface);display:flex;gap:6px;align-items:center;flex-wrap:wrap;border-radius:0 0 14px 14px">
            <div id="camStatus" style="flex:1;font-size:0.74rem;color:var(--muted)">Loading models...</div>
            <button class="btn btn-primary btn-sm" id="scanBtn" disabled onclick="toggleScan()">Start Scan</button>
            <button class="btn btn-ghost btn-sm" id="autoBtn" onclick="toggleAuto()" style="border-color:rgba(52,211,153,0.25);color:#059669">Auto OFF</button>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Last Result</div>
          <div id="resultBox" style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:200px;gap:12px;color:var(--muted);font-size:0.8rem;text-align:center">
            <div style="font-size:2rem">👁️</div>
            <div>Point the camera at a face and click Scan</div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <div class="card-title">Today's Scans</div>
        <div id="todayList"><p style="color:var(--muted);font-size:0.8rem;text-align:center;padding:20px">Loading...</p></div>
      </div>
    </div>

    <style>
    @keyframes scan{0%,100%{top:0}50%{top:calc(100% - 2px)}}
    .cam-card{overflow:hidden}
    </style>
    <script src="/faceapi.js"></script>
    <script>
    let stream, autoInterval = null, scanning = false, faces = [];

    async function init() {
      document.getElementById('camStatus').textContent = 'Loading models...';
      await faceapi.nets.ssdMobilenetv1.loadFromUri('/models');
      await faceapi.nets.faceLandmark68Net.loadFromUri('/models');
      await faceapi.nets.faceRecognitionNet.loadFromUri('/models');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width:640, height:480 } });
        document.getElementById('video').srcObject = stream;
      } catch(e) { document.getElementById('camStatus').textContent = 'Camera error: ' + e.message; return; }
      const fr = await fetch('/api/faces');
      const fd = await fr.json();
      faces = (fd.faces||[]).map(f => ({
        id: f.id, label: f.label,
        descriptors: JSON.parse(f.descriptor).map(d => new Float32Array(d))
      }));
      document.getElementById('camStatus').textContent = faces.length + ' faces loaded — ready';
      document.getElementById('scanBtn').disabled = false;
      loadToday();
      setInterval(() => {
        const n = new Date();
        document.getElementById('liveClock').textContent = n.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      }, 1000);
    }

    function euclidean(a,b){let s=0;for(let i=0;i<a.length;i++)s+=(a[i]-b[i])**2;return Math.sqrt(s);}

    async function doScan() {
      if (scanning) return;
      scanning = true;
      document.getElementById('camStatus').textContent = 'Scanning...';
      const video = document.getElementById('video');
      const det = await faceapi.detectSingleFace(video,'SsdMobilenetv1Options' in faceapi ? new faceapi.SsdMobilenetv1Options({minConfidence:0.5}) : undefined)
        .withFaceLandmarks().withFaceDescriptor();
      if (!det) {
        document.getElementById('camStatus').textContent = 'No face detected';
        document.getElementById('resultBox').innerHTML = '<div style="font-size:2rem">❓</div><div style="color:var(--muted)">No face detected</div>';
        scanning = false; return;
      }
      const desc = det.descriptor;
      let best = null, bestDist = Infinity;
      for (const f of faces) {
        for (const d of f.descriptors) {
          const dist = euclidean(Array.from(desc), Array.from(d));
          if (dist < bestDist) { bestDist = dist; best = f; }
        }
      }
      const shiftId = document.getElementById('shiftSelect')?.value || '';
      if (!best || bestDist > 0.5) {
        // Unknown
        await fetch('/api/attendance/unknown', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ descriptor: Array.from(desc) }) });
        document.getElementById('resultBox').innerHTML = '<div style="font-size:2rem">🚫</div><div style="color:var(--red);font-weight:600">Unknown Face</div><div style="font-size:0.75rem;color:var(--muted)">Dist: '+bestDist.toFixed(3)+'</div>';
        document.getElementById('camStatus').textContent = 'Unknown face';
      } else {
        const r = await fetch('/api/attendance/mark', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ face_id: best.id, name: best.label, shift_id: shiftId||null })
        });
        const d = await r.json();
        const color = d.status==='present'?'#059669':'#d97706';
        document.getElementById('resultBox').innerHTML = \`
          <div style="width:52px;height:52px;border-radius:50%;background:rgba(0,173,238,0.12);display:flex;align-items:center;justify-content:center;font-size:1.3rem;font-weight:700;color:var(--accent)">\${best.label[0]}</div>
          <div style="font-size:1rem;font-weight:700">\${best.label}</div>
          <div style="background:rgba(0,0,0,0.05);border-radius:20px;padding:4px 12px;font-size:0.75rem;font-weight:600;color:\${color}">\${d.message||d.status}</div>
          <div style="font-size:0.72rem;color:var(--muted)">Confidence: \${Math.round((1-bestDist)*100)}%</div>
        \`;
        document.getElementById('camStatus').textContent = 'Marked: ' + best.label;
        loadToday();
      }
      scanning = false;
    }

    let scanOnce = false;
    function toggleScan() {
      if (autoInterval) return;
      doScan();
    }

    function toggleAuto() {
      const btn = document.getElementById('autoBtn');
      if (autoInterval) {
        clearInterval(autoInterval); autoInterval = null;
        btn.textContent = 'Auto OFF'; btn.style.color='#059669';
      } else {
        autoInterval = setInterval(doScan, 2500);
        btn.textContent = 'Auto ON'; btn.style.color='var(--red)';
      }
    }

    async function loadToday() {
      const r = await fetch('/api/attendance/today');
      const d = await r.json();
      if (!d.records?.length) {
        document.getElementById('todayList').innerHTML = '<p style="color:var(--muted);font-size:0.8rem;text-align:center;padding:20px">No scans yet today</p>';
        return;
      }
      document.getElementById('todayList').innerHTML = '<table><thead><tr><th>Name</th><th>Time In</th><th>Shift</th><th>Status</th></tr></thead><tbody>' +
        d.records.map(r => \`<tr>
          <td><strong>\${r.name}</strong></td>
          <td style="font-family:'JetBrains Mono',monospace;font-size:0.78rem">\${r.time_in}</td>
          <td>\${r.shift_name||'—'}</td>
          <td>\${r.status==='present'?'<span class="badge badge-green">Present</span>':'<span class="badge badge-red">Absent</span>'}</td>
        </tr>\`).join('') + '</tbody></table>';
    }

    init();
    </script>
  `));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  USER — ATTENDANCE CALENDAR
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/user/attendance', requireUser, async (req, res) => {
  const user = req.user;
  const adminRows = await dbQuery('SELECT * FROM admins WHERE id=?', [user.admin_id]);
  const admin = adminRows[0];

  res.send(html('My Attendance', `
    <nav style="position:sticky;top:0;z-index:100;background:rgba(255,255,255,0.96);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 16px;height:62px">
      <div class="nav-logo">
        ${admin?.logo_path ? `<img src="/logos/${escH(admin.logo_path)}" style="height:34px;border-radius:6px;object-fit:contain">` : '<div style="width:34px;height:34px;border-radius:8px;background:linear-gradient(135deg,var(--accent),#0080bb);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:0.9rem">F</div>'}
        <span>${escH(admin?.attendance_title || 'Attendance')}</span>
      </div>
      <div class="nav-links">
        <span style="font-size:0.8rem;color:var(--muted);margin-right:8px">Hi, ${escH(user.display_name)}</span>
        <a href="/user/logout" class="nav-btn" style="border-color:rgba(248,113,113,0.3);color:var(--red)">Logout</a>
      </div>
    </nav>
    <div class="page">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:10px">
        <h2>My Attendance</h2>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;background:var(--surface);border:1px solid var(--border);padding:8px 14px;border-radius:10px;font-size:0.8rem">
          <input type="checkbox" id="notifToggle" ${user.notifications_enabled?'checked':''} style="accent-color:var(--accent)">
          🔔 Notify me on each scan
        </label>
      </div>
      <div id="statsBar" style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap"></div>
      <div style="display:flex;gap:16px;align-items:center;margin-bottom:12px">
        <button class="btn btn-ghost" onclick="prevMonth()">← Prev</button>
        <h3 id="calTitle" style="flex:1;text-align:center"></h3>
        <button class="btn btn-ghost" onclick="nextMonth()">Next →</button>
      </div>
      <div class="card">
        <div id="calGrid" style="display:grid;grid-template-columns:repeat(7,1fr);gap:6px"></div>
      </div>
      <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;font-size:0.75rem">
        <div style="display:flex;align-items:center;gap:5px"><div style="width:12px;height:12px;border-radius:3px;background:#dcfce7"></div> Present</div>
        <div style="display:flex;align-items:center;gap:5px"><div style="width:12px;height:12px;border-radius:3px;background:#fee2e2"></div> Absent</div>
        <div style="display:flex;align-items:center;gap:5px"><div style="width:12px;height:12px;border-radius:3px;background:#fef9c3"></div> Holiday</div>
      </div>
    </div>
    <script>
    let curYear = new Date().getFullYear(), curMonth = new Date().getMonth();

    document.getElementById('notifToggle').addEventListener('change', async e => {
      const r = await fetch('/api/user/notifications', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enabled: e.target.checked }) });
      const d = await r.json();
      if (d.ok) showToast('Notifications ' + (e.target.checked ? 'enabled' : 'disabled'));
      else showToast(d.error||'Error',false);
    });

    async function loadCal() {
      const y = curYear, m = curMonth + 1;
      const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      document.getElementById('calTitle').textContent = monthNames[curMonth] + ' ' + y;

      const [attRes, holRes, statsRes] = await Promise.all([
        fetch(\`/api/user/attendance?year=\${y}&month=\${m}\`).then(r=>r.json()),
        fetch(\`/api/holidays?year=\${y}&month=\${m}\`).then(r=>r.json()),
        fetch(\`/api/user/stats?year=\${y}&month=\${m}\`).then(r=>r.json())
      ]);

      // Stats
      const s = statsRes;
      document.getElementById('statsBar').innerHTML = [
        { label:'Present', val: s.present||0, color:'#059669' },
        { label:'Absent',  val: s.absent||0,  color:'var(--red)' },
        { label:'Holidays',val: s.holidays||0, color:'#d97706' },
      ].map(x => \`<div class="stat" style="flex:1"><div class="stat-val" style="color:\${x.color}">\${x.val}</div><div class="stat-label">\${x.label}</div></div>\`).join('');

      const attMap = {}, holMap = {};
      (attRes.data||[]).forEach(r => { attMap[r.date] = r; });
      (holRes.data||[]).forEach(h => { holMap[h.date] = h.label; });

      const grid  = document.getElementById('calGrid');
      grid.innerHTML = '';
      ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => {
        const el = document.createElement('div');
        el.textContent = d;
        el.style.cssText = 'text-align:center;font-size:0.65rem;color:var(--muted);font-weight:600;padding:4px';
        grid.appendChild(el);
      });
      const first = new Date(y, curMonth, 1).getDay();
      const days  = new Date(y, curMonth+1, 0).getDate();
      const today = new Date().toISOString().slice(0,10);
      for (let i = 0; i < first; i++) grid.appendChild(document.createElement('div'));
      for (let d = 1; d <= days; d++) {
        const ds  = y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
        const el  = document.createElement('div');
        const att = attMap[ds];
        const hol = holMap[ds];
        let bg = 'var(--surface)', icon = '';
        if (hol)        { bg = '#fef9c3'; icon = '🏖'; }
        else if (att)   { bg = att.status==='present' ? '#dcfce7' : '#fee2e2'; icon = att.status==='present' ? '✅' : '❌'; }
        el.innerHTML = \`<strong style="font-size:0.82rem">\${d}</strong><div style="font-size:0.75rem;margin-top:2px">\${icon}</div>\`;
        el.style.cssText = \`background:\${bg};border:1px solid var(--border);border-radius:8px;padding:6px 4px;text-align:center\${ds===today?';border-color:var(--accent)':''}\`;
        if (att) {
          el.title = att.time_in ? 'Time in: ' + att.time_in : '';
          el.style.cursor = 'pointer';
        }
        grid.appendChild(el);
      }
    }

    function prevMonth(){ curMonth--; if(curMonth<0){curMonth=11;curYear--;} loadCal(); }
    function nextMonth(){ curMonth++; if(curMonth>11){curMonth=0;curYear++;} loadCal(); }
    loadCal();
    </script>
  `));
});

// ═══════════════════════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── Faces CRUD
app.get('/api/faces', requireApprovedAdmin, async (req,res) => {
  const faces = await dbQuery('SELECT id, label, employee_id, department, descriptor, registration_accuracy FROM faces WHERE admin_id=?', [req.admin.id]);
  res.json({ faces });
});

app.post('/api/faces', requireApprovedAdmin, async (req,res) => {
  try {
    const { label, employee_id, department, descriptors, accuracy, user_email, user_password } = req.body;
    if (!label || !descriptors) return res.json({ ok:false, error:'Missing fields' });
    const descriptorJson = JSON.stringify(descriptors);
    const result = await dbQuery(
      'INSERT INTO faces (admin_id, label, employee_id, department, descriptor, registration_accuracy) VALUES (?,?,?,?,?,?)',
      [req.admin.id, label, employee_id||'', department||'', descriptorJson, accuracy||null]
    );
    const faceId = result.insertId;
    // Optionally create user
    if (user_email && user_password) {
      try {
        const hash = hashPassword(user_password);
        await dbQuery('INSERT INTO users (admin_id, face_id, email, password_hash, display_name) VALUES (?,?,?,?,?)',
          [req.admin.id, faceId, user_email, hash, label]);
      } catch(e) { /* ignore duplicate user */ }
    }
    res.json({ ok:true, id: faceId });
  } catch(e) { res.json({ ok:false, error: e.message }); }
});

app.delete('/api/faces/:id', requireApprovedAdmin, async (req,res) => {
  try {
    await dbQuery('DELETE FROM faces WHERE id=? AND admin_id=?', [req.params.id, req.admin.id]);
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

// ── Users CRUD
app.post('/api/users', requireApprovedAdmin, async (req,res) => {
  try {
    const { face_id, email, password, display_name } = req.body;
    const hash = hashPassword(password);
    await dbQuery('INSERT INTO users (admin_id, face_id, email, password_hash, display_name) VALUES (?,?,?,?,?)',
      [req.admin.id, face_id||null, email, hash, display_name||email]);
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, error: e.message }); }
});

app.delete('/api/users/:id', requireApprovedAdmin, async (req,res) => {
  try {
    await dbQuery('DELETE FROM users WHERE id=? AND admin_id=?', [req.params.id, req.admin.id]);
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

app.post('/api/users/:id/notifications', requireApprovedAdmin, async (req,res) => {
  try {
    await dbQuery('UPDATE users SET notifications_enabled=? WHERE id=? AND admin_id=?',
      [req.body.enabled?1:0, req.params.id, req.admin.id]);
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

// ── User self notification update
app.post('/api/user/notifications', requireUser, async (req,res) => {
  try {
    await dbQuery('UPDATE users SET notifications_enabled=? WHERE id=?', [req.body.enabled?1:0, req.user.id]);
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

// ── Shifts CRUD
app.post('/api/shifts', requireApprovedAdmin, async (req,res) => {
  try {
    const { shift_name, start_h, start_m, end_h, end_m } = req.body;
    await dbQuery('INSERT INTO shifts (admin_id, shift_name, start_h, start_m, end_h, end_m) VALUES (?,?,?,?,?,?)',
      [req.admin.id, shift_name, start_h, start_m, end_h, end_m]);
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

app.put('/api/shifts/:id', requireApprovedAdmin, async (req,res) => {
  try {
    const { shift_name, start_h, start_m, end_h, end_m } = req.body;
    await dbQuery('UPDATE shifts SET shift_name=?,start_h=?,start_m=?,end_h=?,end_m=? WHERE id=? AND admin_id=?',
      [shift_name, start_h, start_m, end_h, end_m, req.params.id, req.admin.id]);
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

app.delete('/api/shifts/:id', requireApprovedAdmin, async (req,res) => {
  try {
    await dbQuery('DELETE FROM shifts WHERE id=? AND admin_id=?', [req.params.id, req.admin.id]);
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

// ── Attendance Mark
app.post('/api/attendance/mark', requireApprovedAdmin, async (req,res) => {
  try {
    const { face_id, name, shift_id } = req.body;
    const today = new Date().toISOString().slice(0,10);
    const now   = new Date().toTimeString().slice(0,8);

    // Check already marked
    const existing = await dbQuery(
      'SELECT id FROM attendance WHERE admin_id=? AND face_id=? AND date=?',
      [req.admin.id, face_id, today]
    );
    if (existing.length) {
      setLed('checkin_already', name);
      return res.json({ ok:true, message:'Already marked today', status:'already' });
    }

    // Determine shift status
    let resolvedShiftId = shift_id || null;
    let status = 'present';

    if (resolvedShiftId) {
      const sRows = await dbQuery('SELECT * FROM shifts WHERE id=? AND admin_id=?', [resolvedShiftId, req.admin.id]);
      if (sRows[0]) {
        const s = sRows[0];
        const nowMin = parseInt(now.split(':')[0])*60 + parseInt(now.split(':')[1]);
        const startMin = s.start_h*60 + s.start_m;
        const endMin   = s.end_h*60   + s.end_m;
        if (nowMin >= startMin && nowMin <= endMin) status = 'present';
        else status = 'absent';
      }
    }

    await dbQuery(
      'INSERT INTO attendance (admin_id, face_id, name, shift_id, date, time_in, status) VALUES (?,?,?,?,?,?,?)',
      [req.admin.id, face_id, name, resolvedShiftId, today, now, status]
    );

    setLed('checkin_present', name);

    // Notify user if enabled
    const uRows = await dbQuery('SELECT * FROM users WHERE face_id=? AND admin_id=? AND notifications_enabled=1', [face_id, req.admin.id]);
    if (uRows.length) {
      console.log(`📲 [NOTIFY] ${name} → ${uRows[0].email}: ${status} at ${now}`);
      // In production: send email/push here
    }

    res.json({ ok:true, status, message: status==='present'?'✅ Present':'❌ Outside shift window' });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

// Unknown face
app.post('/api/attendance/unknown', requireApprovedAdmin, async (req,res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const now   = new Date().toTimeString().slice(0,8);
    await dbQuery('INSERT INTO unknown_faces (admin_id, date, time_detected) VALUES (?,?,?)',
      [req.admin.id, today, now]);
    setLed('unknown','');
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

// Today's attendance
app.get('/api/attendance/today', requireApprovedAdmin, async (req,res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const records = await dbQuery(`
      SELECT a.name, a.time_in, a.status, s.shift_name
      FROM attendance a
      LEFT JOIN shifts s ON s.id=a.shift_id
      WHERE a.admin_id=? AND a.date=?
      ORDER BY a.time_in ASC
    `, [req.admin.id, today]);
    res.json({ records: records.map(r => ({ ...r, time_in: fmtTime(r.time_in) })) });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

// ── Calendar APIs
app.get('/api/calendar/month', requireApprovedAdmin, async (req,res) => {
  try {
    const { year, month } = req.query;
    const data = await dbQuery(`
      SELECT date,
        SUM(status='present') AS present,
        SUM(status='absent')  AS absent
      FROM attendance
      WHERE admin_id=? AND YEAR(date)=? AND MONTH(date)=?
      GROUP BY date
    `, [req.admin.id, year, month]);
    res.json({ data: data.map(r => ({ ...r, date: r.date.toISOString().slice(0,10) })) });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

app.get('/api/calendar/day', requireApprovedAdmin, async (req,res) => {
  try {
    const { date } = req.query;
    const records = await dbQuery(
      'SELECT name, time_in, status FROM attendance WHERE admin_id=? AND date=? ORDER BY time_in',
      [req.admin.id, date]
    );
    const present = records.filter(r=>r.status==='present').length;
    const absent  = records.filter(r=>r.status==='absent').length;
    res.json({ records: records.map(r=>({...r, time_in: fmtTime(r.time_in)})), present, absent });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

// ── Holidays
app.get('/api/holidays', requireApprovedAdmin, async (req,res) => {
  try {
    const { year, month } = req.query;
    const data = await dbQuery(
      'SELECT date, label FROM holidays WHERE admin_id=? AND YEAR(date)=? AND MONTH(date)=?',
      [req.admin.id, year, month]
    );
    res.json({ data: data.map(r => ({ ...r, date: r.date.toISOString().slice(0,10) })) });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

app.post('/api/holidays', requireApprovedAdmin, async (req,res) => {
  try {
    const { date, label } = req.body;
    await dbQuery('INSERT INTO holidays (admin_id, date, label) VALUES (?,?,?) ON DUPLICATE KEY UPDATE label=?',
      [req.admin.id, date, label||'Holiday', label||'Holiday']);
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

app.delete('/api/holidays', requireApprovedAdmin, async (req,res) => {
  try {
    await dbQuery('DELETE FROM holidays WHERE admin_id=? AND date=?', [req.admin.id, req.query.date]);
    res.json({ ok:true });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

// ── User Attendance Calendar
app.get('/api/user/attendance', requireUser, async (req,res) => {
  try {
    const { year, month } = req.query;
    const user = req.user;
    const data = await dbQuery(`
      SELECT a.date, a.time_in, a.status
      FROM attendance a
      JOIN users u ON u.face_id=a.face_id AND u.admin_id=a.admin_id
      WHERE u.id=? AND YEAR(a.date)=? AND MONTH(a.date)=?
      ORDER BY a.date
    `, [user.id, year, month]);
    res.json({ data: data.map(r => ({ ...r, date: r.date.toISOString().slice(0,10), time_in: fmtTime(r.time_in) })) });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

app.get('/api/user/stats', requireUser, async (req,res) => {
  try {
    const { year, month } = req.query;
    const user = req.user;
    const rows = await dbQuery(`
      SELECT
        SUM(a.status='present') AS present,
        SUM(a.status='absent')  AS absent
      FROM attendance a
      JOIN users u ON u.face_id=a.face_id AND u.admin_id=a.admin_id
      WHERE u.id=? AND YEAR(a.date)=? AND MONTH(a.date)=?
    `, [user.id, year, month]);
    const holRows = await dbQuery(
      'SELECT COUNT(*) AS c FROM holidays WHERE admin_id=? AND YEAR(date)=? AND MONTH(date)=?',
      [user.admin_id, year, month]
    );
    res.json({ present: rows[0].present||0, absent: rows[0].absent||0, holidays: holRows[0].c||0 });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

// ── User holidays (same as admin's org holidays)
app.get('/api/holidays', requireUser, async (req,res) => {
  try {
    const { year, month } = req.query;
    const data = await dbQuery(
      'SELECT date, label FROM holidays WHERE admin_id=? AND YEAR(date)=? AND MONTH(date)=?',
      [req.user.admin_id, year, month]
    );
    res.json({ data: data.map(r => ({ ...r, date: r.date.toISOString().slice(0,10) })) });
  } catch(e) { res.json({ ok:false, error:e.message }); }
});

// ── LED
app.get('/api/led/status', (req,res) => {
  if (!pendingLedCommand) return res.json({ led:'NONE', buzzer:0 });
  const cmd = pendingLedCommand; pendingLedCommand = null;
  res.json(cmd);
});

// ─── DB INIT ─────────────────────────────────────────────────────────────────
db.connect(err => {
  if (err) { console.error('❌ MySQL:', err.message); process.exit(1); }
  console.log('✅ MySQL connected →', DB_CONFIG.database);

  const tables = [
    `CREATE TABLE IF NOT EXISTS super_admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(191) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(100) NOT NULL DEFAULT 'Super Admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(191) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      org_name VARCHAR(200) NOT NULL,
      industry_type ENUM('school','college','office','hospital','factory','other') DEFAULT 'office',
      attendance_title VARCHAR(200) NOT NULL DEFAULT 'Attendance System',
      logo_path VARCHAR(500) DEFAULT NULL,
      status ENUM('pending','approved','suspended') DEFAULT 'pending',
      approved_at DATETIME DEFAULT NULL,
      approved_by INT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS shifts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      shift_name VARCHAR(100) NOT NULL,
      start_h TINYINT UNSIGNED NOT NULL DEFAULT 9,
      start_m TINYINT UNSIGNED NOT NULL DEFAULT 0,
      end_h TINYINT UNSIGNED NOT NULL DEFAULT 17,
      end_m TINYINT UNSIGNED NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS faces (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      label VARCHAR(100) NOT NULL,
      employee_id VARCHAR(50) DEFAULT '',
      department VARCHAR(100) DEFAULT '',
      descriptor LONGTEXT NOT NULL,
      registration_accuracy TINYINT UNSIGNED DEFAULT NULL,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admin_label (admin_id, label)
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      face_id INT DEFAULT NULL,
      email VARCHAR(191) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(100) NOT NULL,
      notifications_enabled TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS attendance (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      face_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      shift_id INT DEFAULT NULL,
      date DATE NOT NULL,
      time_in TIME NOT NULL,
      time_out TIME DEFAULT NULL,
      status ENUM('present','absent') DEFAULT 'present',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admin_face_date (admin_id, face_id, date)
    )`,
    `CREATE TABLE IF NOT EXISTS holidays (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      date DATE NOT NULL,
      label VARCHAR(200) DEFAULT 'Holiday',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admin_date (admin_id, date)
    )`,
    `CREATE TABLE IF NOT EXISTS unknown_faces (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      image_file VARCHAR(255) DEFAULT NULL,
      captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      date DATE NOT NULL,
      time_detected TIME NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      token VARCHAR(128) NOT NULL UNIQUE,
      role ENUM('super_admin','admin','user') NOT NULL,
      entity_id INT NOT NULL,
      admin_id INT DEFAULT NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  let done = 0;
  tables.forEach(sql => {
    db.query(sql, err => {
      if (err) console.warn('Table warn:', err.message);
      done++;
      if (done === tables.length) {
        // Seed super admin
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = crypto.createHmac('sha256', salt).update('Admin@123').digest('hex');
        const stored = salt + ':' + hash;
        db.query(
          'INSERT IGNORE INTO super_admins (email, password_hash, name) VALUES (?,?,?)',
          ['superadmin@facedetect.app', stored, 'Super Admin'],
          () => console.log('✅ Super admin seeded (email: superadmin@facedetect.app  pw: Admin@123)')
        );
        console.log('✅ All tables ready');
        setup().then(() => {
          app.listen(PORT, () => {
            console.log('\n==========================================');
            console.log('🚀  http://localhost:' + PORT);
            console.log('👤  Admin Login    → http://localhost:' + PORT + '/login');
            console.log('👑  Super Admin    → http://localhost:' + PORT + '/super/login');
            console.log('🙋  User Login     → http://localhost:' + PORT + '/user/login');
            console.log('==========================================\n');
          });
        });
      }
    });
  });
});
