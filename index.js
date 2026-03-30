// ============================================================
//  FaceAttend SaaS — index.js
//  Three roles: super_admin | admin | user
//  Run: node index.js
// ============================================================
'use strict';
const express    = require('express');
const mysql      = require('mysql2');
const https      = require('https');
const fs         = require('fs');
const path       = require('path');
const crypto     = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Static assets ────────────────────────────────────────────
app.use('/models',         express.static(path.join(__dirname,'public','models')));
app.use('/faceapi.js',     (req,res) => res.sendFile(path.join(__dirname,'public','faceapi.js')));
app.use('/unknown-images', express.static(path.join(__dirname,'public','unknown-images')));
app.use('/logos',          express.static(path.join(__dirname,'public','logos')));

// ── DB ────────────────────────────────────────────────────────
const DB_CONFIG = {
  host    : process.env.DB_HOST     || '127.0.0.1',
  user    : process.env.DB_USER     || 'u966260443_facedetect',
  password: process.env.DB_PASS     || 'Makelabs@123',
  database: process.env.DB_NAME     || 'u966260443_facedetect',
  multipleStatements: true,
};
const db = mysql.createPool(DB_CONFIG);

function dbQuery(sql, params=[]) {
  return new Promise((resolve,reject) =>
    db.query(sql, params, (err,rows) => err ? reject(err) : resolve(rows))
  );
}

// ── Simple session-token store (in-memory, replace with Redis/JWT in prod) ───
const SESSIONS = new Map(); // token → { role, id, admin_id, expires }

function makeToken() { return crypto.randomBytes(32).toString('hex'); }

function createSession(role, id, adminId=null) {
  const token = makeToken();
  SESSIONS.set(token, {
    role, id,
    admin_id: adminId || id,
    expires: Date.now() + 24*60*60*1000   // 24h
  });
  return token;
}

function getSession(req) {
  const auth = req.headers['authorization'] || req.headers['x-token'] || '';
  const token = auth.replace('Bearer ','').trim();
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { SESSIONS.delete(token); return null; }
  return s;
}

function requireRole(...roles) {
  return (req,res,next) => {
    const s = getSession(req);
    if (!s || !roles.includes(s.role)) return res.status(401).json({ok:false,msg:'Unauthorized'});
    req.session = s;
    next();
  };
}

// ── Bcrypt-lite (pure JS) — avoids native dep issues ─────────
// Uses PBKDF2 as a portable password hash
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pw, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const h2 = crypto.pbkdf2Sync(pw, salt, 100000, 64, 'sha512').toString('hex');
    return h2 === hash;
  } catch { return false; }
}

// ── Helpers ───────────────────────────────────────────────────
function pad2(n){return String(n).padStart(2,'0');}
function euclidean(a,b){let s=0;for(let i=0;i<a.length;i++)s+=(a[i]-b[i])**2;return Math.sqrt(s);}
function escH(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function fmtTime(t){if(!t)return'—';const str=typeof t==='string'?t:String(t);const p=str.split(':');const h=parseInt(p[0]),m=p[1]||'00';return(h%12||12)+':'+m+' '+(h>=12?'PM':'AM');}

const THRESHOLD = 0.5;
const REGISTER_SAMPLES = 10;

// ════════════════════════════════════════════════════════════
//  DB INIT — create all tables if not exist
// ════════════════════════════════════════════════════════════
async function initDB() {
  const sqls = [
    `CREATE TABLE IF NOT EXISTS super_admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(150) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      email VARCHAR(150) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      industry_type VARCHAR(100) DEFAULT NULL,
      title VARCHAR(200) DEFAULT NULL,
      logo_url VARCHAR(500) DEFAULT NULL,
      status ENUM('pending','approved','rejected','suspended') DEFAULT 'pending',
      approved_by INT DEFAULT NULL,
      approved_at DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS shifts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      name VARCHAR(100) NOT NULL,
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS faces (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      label VARCHAR(100) NOT NULL,
      employee_id VARCHAR(50) DEFAULT '',
      department VARCHAR(100) DEFAULT '',
      descriptor LONGTEXT NOT NULL,
      registration_accuracy TINYINT UNSIGNED DEFAULT NULL,
      registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admin_label (admin_id, label),
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      face_id INT DEFAULT NULL,
      name VARCHAR(150) NOT NULL,
      email VARCHAR(150) NOT NULL,
      password VARCHAR(255) NOT NULL,
      push_subscription TEXT DEFAULT NULL,
      notify_enabled TINYINT(1) DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admin_email (admin_id, email),
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
      FOREIGN KEY (face_id)  REFERENCES faces(id)  ON DELETE SET NULL
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS attendance (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      face_id INT NOT NULL,
      shift_id INT DEFAULT NULL,
      name VARCHAR(100) NOT NULL,
      date DATE NOT NULL,
      time_in TIME NOT NULL,
      status ENUM('present','absent') DEFAULT 'present',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_face_date_admin (admin_id, face_id, date),
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
      FOREIGN KEY (face_id)  REFERENCES faces(id)  ON DELETE CASCADE,
      FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS holidays (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      date DATE NOT NULL,
      name VARCHAR(200) DEFAULT 'Holiday',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_admin_holiday (admin_id, date),
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS unknown_faces (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      image_file VARCHAR(255) DEFAULT NULL,
      captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      date DATE NOT NULL,
      time_detected TIME NOT NULL,
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`,

    `CREATE TABLE IF NOT EXISTS push_notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      user_id INT NOT NULL,
      face_id INT DEFAULT NULL,
      title VARCHAR(200),
      body TEXT,
      status ENUM('sent','failed') DEFAULT 'sent',
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
    ) ENGINE=InnoDB`,
  ];

  for (const sql of sqls) {
    try { await dbQuery(sql); } catch(e) { console.warn('Table init warning:', e.message.substring(0,80)); }
  }

  // Seed default super admin (password: Admin@123)
  const existing = await dbQuery('SELECT id FROM super_admins LIMIT 1').catch(()=>[]);
  if (!existing.length) {
    const hpw = hashPassword('Admin@123');
    await dbQuery('INSERT IGNORE INTO super_admins (name,email,password) VALUES (?,?,?)',
      ['Super Admin','superadmin@faceattend.com', hpw]);
    console.log('✅ Default super admin created: superadmin@faceattend.com / Admin@123');
  }
  console.log('✅ All tables ready');
}

// ════════════════════════════════════════════════════════════
//  FACE-API MODEL SETUP
// ════════════════════════════════════════════════════════════
const PUBLIC_DIR         = path.join(__dirname,'public');
const MODELS_DIR         = path.join(PUBLIC_DIR,'models');
const UNKNOWN_DIR        = path.join(PUBLIC_DIR,'unknown-images');
const LOGOS_DIR          = path.join(PUBLIC_DIR,'logos');
const FACEAPI_PATH       = path.join(PUBLIC_DIR,'faceapi.js');
const FACEAPI_URL        = 'https://unpkg.com/face-api.js@0.22.2/dist/face-api.min.js';
const MODEL_FILES = [
  'ssd_mobilenetv1_model-weights_manifest.json','ssd_mobilenetv1_model-shard1','ssd_mobilenetv1_model-shard2',
  'face_landmark_68_model-weights_manifest.json','face_landmark_68_model-shard1',
  'face_recognition_model-weights_manifest.json','face_recognition_model-shard1','face_recognition_model-shard2',
];
const MODEL_BASE = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/';

function dlFile(url,dest){
  return new Promise((resolve,reject)=>{
    if(fs.existsSync(dest))return resolve(false);
    const f=fs.createWriteStream(dest);
    https.get(url,res=>{
      if(res.statusCode===301||res.statusCode===302){f.close();fs.unlinkSync(dest);return dlFile(res.headers.location,dest).then(resolve).catch(reject);}
      if(res.statusCode!==200){f.close();try{fs.unlinkSync(dest);}catch(_){}return reject(new Error('HTTP '+res.statusCode));}
      res.pipe(f);f.on('finish',()=>{f.close();resolve(true);});
    }).on('error',e=>{try{fs.unlinkSync(dest);}catch(_){}reject(e);});
  });
}

async function setupAssets() {
  [PUBLIC_DIR,MODELS_DIR,UNKNOWN_DIR,LOGOS_DIR].forEach(d=>{ if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true}); });
  if(!fs.existsSync(FACEAPI_PATH)){
    process.stdout.write('📥 face-api.js... ');
    try{await dlFile(FACEAPI_URL,FACEAPI_PATH);console.log('✅');}catch(e){console.log('❌',e.message);}
  }
  const missing=MODEL_FILES.filter(f=>!fs.existsSync(path.join(MODELS_DIR,f)));
  if(!missing.length){console.log('✅ Models cached');return;}
  console.log('📥 Downloading',missing.length,'model files...');
  for(const f of missing){
    process.stdout.write('  '+f+' ');
    try{await dlFile(MODEL_BASE+f,path.join(MODELS_DIR,f));console.log('✅');}catch(e){console.log('❌',e.message);}
  }
}

// ════════════════════════════════════════════════════════════
//  LED / BUZZER (for IoT device polling)
// ════════════════════════════════════════════════════════════
const adminLedMap = new Map(); // adminId → pendingCmd

function setLed(adminId, eventType, name='') {
  const MAP = {
    checkin_present:{led:'G',buzzer:1}, checkin_absent:{led:'R',buzzer:2},
    checkin_already:{led:'O',buzzer:3}, unknown:{led:'RU',buzzer:5},
  };
  const cmd = MAP[eventType]||{led:'X',buzzer:0};
  adminLedMap.set(adminId, {led:cmd.led,buzzer:cmd.buzzer,name:String(name).slice(0,40),eventType,ts:Date.now()});
}

// ════════════════════════════════════════════════════════════
//  ── AUTH ROUTES ──────────────────────────────────────────
// ════════════════════════════════════════════════════════════

// POST /api/auth/login   body:{email,password,role}  role=super_admin|admin|user
app.post('/api/auth/login', async (req,res) => {
  const {email,password,role} = req.body;
  if(!email||!password||!role) return res.json({ok:false,msg:'Missing fields'});

  try {
    if (role === 'super_admin') {
      const [row] = await dbQuery('SELECT * FROM super_admins WHERE email=?',[email]);
      if (!row) return res.json({ok:false,msg:'Invalid credentials'});
      if (!verifyPassword(password, row.password)) return res.json({ok:false,msg:'Invalid credentials'});
      const token = createSession('super_admin', row.id);
      return res.json({ok:true,token,name:row.name,role:'super_admin'});
    }

    if (role === 'admin') {
      const [row] = await dbQuery('SELECT * FROM admins WHERE email=?',[email]);
      if (!row) return res.json({ok:false,msg:'Invalid credentials'});
      if (!verifyPassword(password, row.password)) return res.json({ok:false,msg:'Invalid credentials'});
      if (row.status !== 'approved') return res.json({ok:false,msg:'Account not yet approved by super admin'});
      const token = createSession('admin', row.id, row.id);
      return res.json({ok:true,token,name:row.name,role:'admin',adminId:row.id,title:row.title,logo:row.logo_url});
    }

    if (role === 'user') {
      const [row] = await dbQuery('SELECT u.*,a.status AS admin_status FROM users u JOIN admins a ON a.id=u.admin_id WHERE u.email=?',[email]);
      if (!row) return res.json({ok:false,msg:'Invalid credentials'});
      if (!verifyPassword(password, row.password)) return res.json({ok:false,msg:'Invalid credentials'});
      if (row.admin_status !== 'approved') return res.json({ok:false,msg:'Your organisation account is not active'});
      const token = createSession('user', row.id, row.admin_id);
      return res.json({ok:true,token,name:row.name,role:'user',userId:row.id,adminId:row.admin_id,faceId:row.face_id});
    }

    res.json({ok:false,msg:'Unknown role'});
  } catch(e) {
    res.status(500).json({ok:false,msg:e.message});
  }
});

// POST /api/auth/register-admin  (public, creates pending admin)
app.post('/api/auth/register-admin', async (req,res) => {
  const {name,email,password,industry_type,title} = req.body;
  if(!name||!email||!password) return res.json({ok:false,msg:'Missing fields'});
  try {
    const hpw = hashPassword(password);
    await dbQuery('INSERT INTO admins (name,email,password,industry_type,title) VALUES (?,?,?,?,?)',
      [name,email,hpw,industry_type||'',title||'']);
    res.json({ok:true,msg:'Account created. Awaiting super admin approval.'});
  } catch(e) {
    if(e.code==='ER_DUP_ENTRY') return res.json({ok:false,msg:'Email already registered'});
    res.status(500).json({ok:false,msg:e.message});
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req,res) => {
  const auth = (req.headers['authorization']||'').replace('Bearer ','').trim();
  if(auth) SESSIONS.delete(auth);
  res.json({ok:true});
});

// GET /api/auth/me
app.get('/api/auth/me', (req,res) => {
  const s = getSession(req);
  if(!s) return res.json({ok:false});
  res.json({ok:true,...s});
});

// ════════════════════════════════════════════════════════════
//  ── SUPER ADMIN ROUTES ───────────────────────────────────
// ════════════════════════════════════════════════════════════

// GET /api/sa/admins   list all admins with stats
app.get('/api/sa/admins', requireRole('super_admin'), async (req,res) => {
  try {
    const rows = await dbQuery(`
      SELECT a.*,
        (SELECT COUNT(*) FROM faces f WHERE f.admin_id=a.id) AS total_faces,
        (SELECT COUNT(*) FROM users u WHERE u.admin_id=a.id) AS total_users,
        (SELECT COUNT(*) FROM users u WHERE u.admin_id=a.id AND u.notify_enabled=1) AS notify_users,
        (SELECT COUNT(*) FROM attendance at WHERE at.admin_id=a.id AND at.date=CURDATE()) AS today_present
      FROM admins a ORDER BY a.created_at DESC
    `);
    res.json({ok:true,data:rows});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// PATCH /api/sa/admins/:id/status  body:{status}
app.patch('/api/sa/admins/:id/status', requireRole('super_admin'), async (req,res) => {
  const {status} = req.body;
  const valid = ['approved','rejected','suspended','pending'];
  if(!valid.includes(status)) return res.json({ok:false,msg:'Invalid status'});
  try {
    await dbQuery('UPDATE admins SET status=?, approved_by=?, approved_at=NOW() WHERE id=?',
      [status, req.session.id, req.params.id]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// GET /api/sa/stats
app.get('/api/sa/stats', requireRole('super_admin'), async (req,res) => {
  try {
    const [[adminsTotal]]    = await dbQuery('SELECT COUNT(*) AS c FROM admins');
    const [[adminsPending]]  = await dbQuery("SELECT COUNT(*) AS c FROM admins WHERE status='pending'");
    const [[adminsApproved]] = await dbQuery("SELECT COUNT(*) AS c FROM admins WHERE status='approved'");
    const [[usersTotal]]     = await dbQuery('SELECT COUNT(*) AS c FROM users');
    const [[notifyTotal]]    = await dbQuery('SELECT COUNT(*) AS c FROM users WHERE notify_enabled=1');
    const [[facesTotal]]     = await dbQuery('SELECT COUNT(*) AS c FROM faces');
    const [[todayPresent]]   = await dbQuery('SELECT COUNT(*) AS c FROM attendance WHERE date=CURDATE()');
    res.json({ok:true,data:{adminsTotal:adminsTotal.c,adminsPending:adminsPending.c,adminsApproved:adminsApproved.c,
      usersTotal:usersTotal.c,notifyTotal:notifyTotal.c,facesTotal:facesTotal.c,todayPresent:todayPresent.c}});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// GET /api/sa/admins/:id/detail
app.get('/api/sa/admins/:id/detail', requireRole('super_admin'), async (req,res) => {
  try {
    const [admin] = await dbQuery('SELECT * FROM admins WHERE id=?',[req.params.id]);
    if(!admin) return res.json({ok:false,msg:'Not found'});
    const users = await dbQuery('SELECT id,name,email,notify_enabled,face_id,created_at FROM users WHERE admin_id=?',[req.params.id]);
    const shifts = await dbQuery('SELECT * FROM shifts WHERE admin_id=?',[req.params.id]);
    const recentAttendance = await dbQuery('SELECT date,COUNT(*) AS cnt FROM attendance WHERE admin_id=? GROUP BY date ORDER BY date DESC LIMIT 14',[req.params.id]);
    res.json({ok:true,data:{admin,users,shifts,recentAttendance}});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// ════════════════════════════════════════════════════════════
//  ── ADMIN ROUTES ─────────────────────────────────────────
// ════════════════════════════════════════════════════════════

// GET /api/admin/profile
app.get('/api/admin/profile', requireRole('admin'), async (req,res) => {
  try {
    const [row] = await dbQuery('SELECT id,name,email,industry_type,title,logo_url,status,created_at FROM admins WHERE id=?',[req.session.id]);
    res.json({ok:true,data:row});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// POST /api/admin/profile  update name/title/industry/logo
app.post('/api/admin/profile', requireRole('admin'), async (req,res) => {
  const {name,title,industry_type,logo_base64} = req.body;
  try {
    let logo_url = null;
    if (logo_base64) {
      const fname = `logo_${req.session.id}_${Date.now()}.png`;
      const fpath = path.join(LOGOS_DIR, fname);
      const data  = logo_base64.replace(/^data:image\/\w+;base64,/,'');
      fs.writeFileSync(fpath, Buffer.from(data,'base64'));
      logo_url = `/logos/${fname}`;
    }
    const fields = ['name=?','title=?','industry_type=?'];
    const vals   = [name,title,industry_type];
    if(logo_url){ fields.push('logo_url=?'); vals.push(logo_url); }
    vals.push(req.session.id);
    await dbQuery(`UPDATE admins SET ${fields.join(',')} WHERE id=?`, vals);
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// ── SHIFTS ───────────────────────────────────────────────────
app.get('/api/admin/shifts', requireRole('admin'), async (req,res) => {
  const rows = await dbQuery('SELECT * FROM shifts WHERE admin_id=? ORDER BY start_time',[req.session.id]).catch(e=>({err:e}));
  if(rows.err) return res.status(500).json({ok:false,msg:rows.err.message});
  res.json({ok:true,data:rows});
});

app.post('/api/admin/shifts', requireRole('admin'), async (req,res) => {
  const {name,start_time,end_time} = req.body;
  if(!name||!start_time||!end_time) return res.json({ok:false,msg:'Missing fields'});
  try {
    const r = await dbQuery('INSERT INTO shifts (admin_id,name,start_time,end_time) VALUES (?,?,?,?)',
      [req.session.id,name,start_time,end_time]);
    res.json({ok:true,id:r.insertId});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

app.put('/api/admin/shifts/:id', requireRole('admin'), async (req,res) => {
  const {name,start_time,end_time} = req.body;
  try {
    await dbQuery('UPDATE shifts SET name=?,start_time=?,end_time=? WHERE id=? AND admin_id=?',
      [name,start_time,end_time,req.params.id,req.session.id]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

app.delete('/api/admin/shifts/:id', requireRole('admin'), async (req,res) => {
  try {
    await dbQuery('DELETE FROM shifts WHERE id=? AND admin_id=?',[req.params.id,req.session.id]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// ── USERS ────────────────────────────────────────────────────
app.get('/api/admin/users', requireRole('admin'), async (req,res) => {
  try {
    const rows = await dbQuery('SELECT u.id,u.name,u.email,u.notify_enabled,u.face_id,u.created_at,f.label AS face_label FROM users u LEFT JOIN faces f ON f.id=u.face_id WHERE u.admin_id=? ORDER BY u.name',[req.session.id]);
    res.json({ok:true,data:rows});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// Create user (admin creates for a face)
app.post('/api/admin/users', requireRole('admin'), async (req,res) => {
  const {name,email,password,face_id} = req.body;
  if(!name||!email||!password) return res.json({ok:false,msg:'Missing fields'});
  try {
    // Verify face belongs to this admin
    if(face_id) {
      const [f] = await dbQuery('SELECT id FROM faces WHERE id=? AND admin_id=?',[face_id,req.session.id]);
      if(!f) return res.json({ok:false,msg:'Face not found'});
    }
    const hpw = hashPassword(password);
    const r = await dbQuery('INSERT INTO users (admin_id,face_id,name,email,password) VALUES (?,?,?,?,?)',
      [req.session.id,face_id||null,name,email,hpw]);
    res.json({ok:true,id:r.insertId});
  } catch(e) {
    if(e.code==='ER_DUP_ENTRY') return res.json({ok:false,msg:'Email already exists'});
    res.status(500).json({ok:false,msg:e.message});
  }
});

// Update user face link
app.put('/api/admin/users/:id', requireRole('admin'), async (req,res) => {
  const {name,email,face_id} = req.body;
  try {
    await dbQuery('UPDATE users SET name=?,email=?,face_id=? WHERE id=? AND admin_id=?',
      [name,email,face_id||null,req.params.id,req.session.id]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

app.delete('/api/admin/users/:id', requireRole('admin'), async (req,res) => {
  try {
    await dbQuery('DELETE FROM users WHERE id=? AND admin_id=?',[req.params.id,req.session.id]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// Notification stats
app.get('/api/admin/notification-stats', requireRole('admin'), async (req,res) => {
  try {
    const [[enabled]]  = await dbQuery('SELECT COUNT(*) AS c FROM users WHERE admin_id=? AND notify_enabled=1',[req.session.id]);
    const [[disabled]] = await dbQuery('SELECT COUNT(*) AS c FROM users WHERE admin_id=? AND notify_enabled=0',[req.session.id]);
    const [[total]]    = await dbQuery('SELECT COUNT(*) AS c FROM users WHERE admin_id=?',[req.session.id]);
    res.json({ok:true,data:{enabled:enabled.c,disabled:disabled.c,total:total.c}});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// ── FACES (admin manages) ─────────────────────────────────────
app.get('/api/admin/faces', requireRole('admin'), async (req,res) => {
  try {
    const rows = await dbQuery('SELECT id,label,employee_id,department,registration_accuracy,registered_at FROM faces WHERE admin_id=? ORDER BY label',[req.session.id]);
    res.json({ok:true,data:rows});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

app.post('/api/admin/faces', requireRole('admin'), async (req,res) => {
  const {label,employee_id,department,descriptors} = req.body;
  if(!label||!descriptors?.length) return res.json({ok:false,msg:'Missing fields'});
  try {
    const arr = descriptors.slice(0,REGISTER_SAMPLES);
    const packed = JSON.stringify(arr);
    const accuracy = Math.round((1 - Math.min(...arr.flatMap((d,i,a)=>a.slice(i+1).map(d2=>euclidean(d,d2)))||[0])/0.6)*100);
    await dbQuery('INSERT INTO faces (admin_id,label,employee_id,department,descriptor,registration_accuracy) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE descriptor=VALUES(descriptor),registration_accuracy=VALUES(registration_accuracy)',
      [req.session.id,label,employee_id||'',department||'',packed,Math.min(100,Math.max(0,accuracy||95))]);
    const [face] = await dbQuery('SELECT id FROM faces WHERE admin_id=? AND label=?',[req.session.id,label]);
    res.json({ok:true,id:face?.id});
  } catch(e) {
    if(e.code==='ER_DUP_ENTRY') return res.json({ok:false,msg:'Label already exists'});
    res.status(500).json({ok:false,msg:e.message});
  }
});

app.delete('/api/admin/faces/:id', requireRole('admin'), async (req,res) => {
  try {
    await dbQuery('DELETE FROM faces WHERE id=? AND admin_id=?',[req.params.id,req.session.id]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// ── HOLIDAYS ──────────────────────────────────────────────────
app.get('/api/admin/holidays', requireRole('admin'), async (req,res) => {
  const {year,month} = req.query;
  try {
    let sql = 'SELECT * FROM holidays WHERE admin_id=?';
    const p = [req.session.id];
    if(year&&month){ sql+=' AND YEAR(date)=? AND MONTH(date)=?'; p.push(year,month); }
    const rows = await dbQuery(sql+' ORDER BY date',p);
    res.json({ok:true,data:rows});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

app.post('/api/admin/holidays', requireRole('admin'), async (req,res) => {
  const {date,name} = req.body;
  if(!date) return res.json({ok:false,msg:'Date required'});
  try {
    await dbQuery('INSERT INTO holidays (admin_id,date,name) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)',
      [req.session.id,date,name||'Holiday']);
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

app.delete('/api/admin/holidays/:date', requireRole('admin'), async (req,res) => {
  try {
    await dbQuery('DELETE FROM holidays WHERE admin_id=? AND date=?',[req.session.id,req.params.date]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// ── ATTENDANCE CALENDAR (admin view) ─────────────────────────
app.get('/api/admin/attendance/calendar', requireRole('admin'), async (req,res) => {
  const {year,month} = req.query;
  if(!year||!month) return res.json({ok:false,msg:'year&month required'});
  try {
    const rows = await dbQuery(`
      SELECT date,
        SUM(status='present') AS present_count,
        SUM(status='absent')  AS absent_count
      FROM attendance WHERE admin_id=? AND YEAR(date)=? AND MONTH(date)=?
      GROUP BY date ORDER BY date
    `,[req.session.id,year,month]);
    const holidays = await dbQuery('SELECT date,name FROM holidays WHERE admin_id=? AND YEAR(date)=? AND MONTH(date)=?',
      [req.session.id,year,month]);
    res.json({ok:true,data:{days:rows,holidays}});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// GET /api/admin/attendance/day?date=YYYY-MM-DD
app.get('/api/admin/attendance/day', requireRole('admin'), async (req,res) => {
  const {date} = req.query;
  if(!date) return res.json({ok:false,msg:'date required'});
  try {
    const rows = await dbQuery(`
      SELECT a.*,s.name AS shift_name,s.start_time,s.end_time
      FROM attendance a LEFT JOIN shifts s ON s.id=a.shift_id
      WHERE a.admin_id=? AND a.date=? ORDER BY a.time_in
    `,[req.session.id,date]);
    res.json({ok:true,data:rows});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// Admin dashboard stats
app.get('/api/admin/stats', requireRole('admin'), async (req,res) => {
  try {
    const [[faces]]  = await dbQuery('SELECT COUNT(*) AS c FROM faces WHERE admin_id=?',[req.session.id]);
    const [[users]]  = await dbQuery('SELECT COUNT(*) AS c FROM users WHERE admin_id=?',[req.session.id]);
    const [[today]]  = await dbQuery("SELECT COUNT(*) AS c FROM attendance WHERE admin_id=? AND date=CURDATE() AND status='present'",[req.session.id]);
    const [[absent]] = await dbQuery("SELECT COUNT(*) AS c FROM attendance WHERE admin_id=? AND date=CURDATE() AND status='absent'",[req.session.id]);
    const [[notify]] = await dbQuery('SELECT COUNT(*) AS c FROM users WHERE admin_id=? AND notify_enabled=1',[req.session.id]);
    const [[shifts]] = await dbQuery('SELECT COUNT(*) AS c FROM shifts WHERE admin_id=?',[req.session.id]);
    res.json({ok:true,data:{faces:faces.c,users:users.c,today_present:today.c,today_absent:absent.c,notify:notify.c,shifts:shifts.c}});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// ════════════════════════════════════════════════════════════
//  ── FACE DETECTION / ATTENDANCE MARKING ─────────────────
//    These routes are called by the camera page (admin panel)
// ════════════════════════════════════════════════════════════

// GET /api/scan/faces?adminId=X  (public for scanner device)
app.get('/api/scan/faces', async (req,res) => {
  const {adminId} = req.query;
  if(!adminId) return res.json({ok:false,msg:'adminId required'});
  try {
    const rows = await dbQuery('SELECT id,label,descriptor FROM faces WHERE admin_id=?',[adminId]);
    res.json({ok:true,data:rows});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// POST /api/scan/mark   body:{adminId, faceId, name, shiftId?, descriptors_raw}
app.post('/api/scan/mark', async (req,res) => {
  const {adminId, faceId, name, shiftId} = req.body;
  if(!adminId||!faceId||!name) return res.json({ok:false,msg:'Missing fields'});
  try {
    // Determine which shift this time falls into (if not provided)
    let resolvedShift = shiftId||null;
    if(!resolvedShift){
      const now = new Date();
      const hhmm = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:00`;
      const shifts = await dbQuery('SELECT * FROM shifts WHERE admin_id=?',[adminId]);
      for(const s of shifts){
        if(hhmm>=s.start_time&&hhmm<=s.end_time){ resolvedShift=s.id; break; }
      }
    }

    const today = new Date().toISOString().slice(0,10);
    const now   = new Date();
    const timeIn= `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;

    // Determine status: present if within shift time, else absent
    let status = 'present';
    if(resolvedShift){
      const [sh] = await dbQuery('SELECT * FROM shifts WHERE id=?',[resolvedShift]);
      if(sh && timeIn > sh.end_time) status = 'absent';
    }

    try {
      await dbQuery('INSERT INTO attendance (admin_id,face_id,shift_id,name,date,time_in,status) VALUES (?,?,?,?,?,?,?)',
        [adminId,faceId,resolvedShift,name,today,timeIn,status]);
    } catch(de) {
      if(de.code==='ER_DUP_ENTRY') {
        setLed(adminId,'checkin_already',name);
        return res.json({ok:true,status:'already_marked',msg:'Already marked today'});
      }
      throw de;
    }

    setLed(adminId, status==='present'?'checkin_present':'checkin_absent', name);

    // Send push notification to user
    const [user] = await dbQuery('SELECT * FROM users WHERE face_id=? AND admin_id=?',[faceId,adminId]);
    if(user&&user.notify_enabled&&user.push_subscription){
      sendPush(user, adminId, faceId, status, name, timeIn).catch(()=>{});
    }

    res.json({ok:true,status,name,timeIn,shiftId:resolvedShift});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// POST /api/scan/unknown  save unknown face image
app.post('/api/scan/unknown', async (req,res) => {
  const {adminId, imageBase64} = req.body;
  if(!adminId) return res.json({ok:false,msg:'adminId required'});
  try {
    const now = new Date();
    const date= now.toISOString().slice(0,10);
    const time= `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    let fname = null;
    if(imageBase64){
      fname = `unk_${adminId}_${Date.now()}_${Math.random().toString(36).slice(2,6)}.jpg`;
      const data = imageBase64.replace(/^data:image\/\w+;base64,/,'');
      fs.writeFileSync(path.join(UNKNOWN_DIR,fname),Buffer.from(data,'base64'));
    }
    await dbQuery('INSERT INTO unknown_faces (admin_id,image_file,date,time_detected) VALUES (?,?,?,?)',
      [adminId,fname,date,time]);
    setLed(adminId,'unknown','Unknown');
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// GET /api/scan/led?adminId=X  (IoT polling)
app.get('/api/scan/led', (req,res) => {
  const {adminId} = req.query;
  const cmd = adminLedMap.get(parseInt(adminId));
  if(!cmd||Date.now()-cmd.ts>10000) return res.json({led:'X',buzzer:0});
  adminLedMap.delete(parseInt(adminId));
  res.json(cmd);
});

// ════════════════════════════════════════════════════════════
//  ── USER ROUTES ──────────────────────────────────────────
// ════════════════════════════════════════════════════════════

// GET /api/user/profile
app.get('/api/user/profile', requireRole('user'), async (req,res) => {
  try {
    const [row] = await dbQuery('SELECT u.id,u.name,u.email,u.notify_enabled,u.face_id,a.title AS org_title,a.logo_url FROM users u JOIN admins a ON a.id=u.admin_id WHERE u.id=?',[req.session.id]);
    res.json({ok:true,data:row});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// GET /api/user/attendance/calendar?year=&month=
app.get('/api/user/attendance/calendar', requireRole('user'), async (req,res) => {
  const {year,month} = req.query;
  if(!year||!month) return res.json({ok:false,msg:'year&month required'});
  try {
    const [user] = await dbQuery('SELECT face_id,admin_id FROM users WHERE id=?',[req.session.id]);
    if(!user?.face_id) return res.json({ok:true,data:{days:[],holidays:[]}});
    const days = await dbQuery(`
      SELECT a.date,a.time_in,a.status,s.name AS shift_name
      FROM attendance a LEFT JOIN shifts s ON s.id=a.shift_id
      WHERE a.face_id=? AND a.admin_id=? AND YEAR(a.date)=? AND MONTH(a.date)=?
      ORDER BY a.date
    `,[user.face_id,user.admin_id,year,month]);
    const holidays = await dbQuery('SELECT date,name FROM holidays WHERE admin_id=? AND YEAR(date)=? AND MONTH(date)=?',
      [user.admin_id,year,month]);
    res.json({ok:true,data:{days,holidays}});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// POST /api/user/push-subscribe  body:{subscription}
app.post('/api/user/push-subscribe', requireRole('user'), async (req,res) => {
  const {subscription} = req.body;
  try {
    const val = subscription ? JSON.stringify(subscription) : null;
    const en  = subscription ? 1 : 0;
    await dbQuery('UPDATE users SET push_subscription=?,notify_enabled=? WHERE id=?',[val,en,req.session.id]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// POST /api/user/push-unsubscribe
app.post('/api/user/push-unsubscribe', requireRole('user'), async (req,res) => {
  try {
    await dbQuery('UPDATE users SET push_subscription=NULL,notify_enabled=0 WHERE id=?',[req.session.id]);
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,msg:e.message}); }
});

// ── Push Notification Sender (no external dep — uses raw Fetch) ─
async function sendPush(user, adminId, faceId, status, name, timeIn) {
  if(!user.push_subscription) return;
  let sub;
  try { sub = JSON.parse(user.push_subscription); } catch{ return; }
  // Log to DB
  await dbQuery('INSERT INTO push_notifications (admin_id,user_id,face_id,title,body,status) VALUES (?,?,?,?,?,?)',
    [adminId,user.id,faceId,
     `Attendance — ${status==='present'?'✅ Present':'❌ Absent'}`,
     `Hi ${name}, your attendance was recorded at ${fmtTime(timeIn)}.`,
     'sent']).catch(()=>{});
  // Note: actual Web Push delivery requires the web-push npm package + VAPID keys.
  // Install: npm install web-push, then configure VAPID keys.
  // Here we log only. See README for Web Push setup.
  console.log(`📬 Push queued for user ${user.id}: ${status} at ${timeIn}`);
}

// ════════════════════════════════════════════════════════════
//  ── HTML PAGES ────────────────────────────────────────────
// ════════════════════════════════════════════════════════════

// Inline helpers for HTML generation
function htmlHead(title, extraCss='') {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escH(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0d14;--bg2:#111520;--bg3:#1a1f2e;
  --border:#2a3045;--border2:#3a4560;
  --text:#e8ecf5;--text2:#8892a8;--text3:#4a5568;
  --accent:#4f9cf9;--accent2:#3b82f6;--accent3:#1d4ed8;
  --green:#22c55e;--red:#ef4444;--yellow:#f59e0b;--purple:#a855f7;
  --card-bg:#131928;--input-bg:#0f1320;
  --radius:10px;--shadow:0 4px 24px rgba(0,0,0,.4);
}
body{background:var(--bg);color:var(--text);font-family:'Space Grotesk',sans-serif;min-height:100vh}
a{color:var(--accent);text-decoration:none}
button{cursor:pointer;font-family:inherit}
input,select,textarea{font-family:inherit}
.mono{font-family:'JetBrains Mono',monospace}
/* Layout */
.page{max-width:1280px;margin:0 auto;padding:24px}
.card{background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin-bottom:20px}
.card-sm{background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:16px}
/* Typography */
h1{font-size:1.8rem;font-weight:700;margin-bottom:4px}
h2{font-size:1.3rem;font-weight:600;margin-bottom:16px}
h3{font-size:1.1rem;font-weight:600;margin-bottom:12px}
.subtitle{color:var(--text2);font-size:.9rem;margin-bottom:24px}
/* Buttons */
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 18px;border-radius:8px;border:none;font-size:.875rem;font-weight:600;transition:all .15s}
.btn-primary{background:var(--accent2);color:#fff}.btn-primary:hover{background:var(--accent3)}
.btn-danger{background:var(--red);color:#fff}.btn-danger:hover{opacity:.85}
.btn-success{background:var(--green);color:#000}.btn-success:hover{opacity:.85}
.btn-ghost{background:transparent;color:var(--text2);border:1px solid var(--border)}.btn-ghost:hover{border-color:var(--border2);color:var(--text)}
.btn-sm{padding:5px 12px;font-size:.8rem}
/* Inputs */
.input{width:100%;padding:10px 14px;background:var(--input-bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:.9rem;outline:none;transition:border .15s}
.input:focus{border-color:var(--accent)}
label{display:block;font-size:.8rem;color:var(--text2);margin-bottom:5px;font-weight:500}
.form-row{margin-bottom:16px}
.form-grid{display:grid;gap:16px}
.fg2{grid-template-columns:1fr 1fr}
.fg3{grid-template-columns:1fr 1fr 1fr}
/* Badges */
.badge{display:inline-flex;align-items:center;padding:3px 10px;border-radius:20px;font-size:.75rem;font-weight:600}
.badge-green{background:rgba(34,197,94,.15);color:var(--green);border:1px solid rgba(34,197,94,.2)}
.badge-red{background:rgba(239,68,68,.15);color:var(--red);border:1px solid rgba(239,68,68,.2)}
.badge-yellow{background:rgba(245,158,11,.15);color:var(--yellow);border:1px solid rgba(245,158,11,.2)}
.badge-blue{background:rgba(79,156,249,.15);color:var(--accent);border:1px solid rgba(79,156,249,.2)}
.badge-purple{background:rgba(168,85,247,.15);color:var(--purple);border:1px solid rgba(168,85,247,.2)}
.badge-gray{background:rgba(74,85,104,.15);color:var(--text3);border:1px solid rgba(74,85,104,.2)}
/* Table */
.tbl{width:100%;border-collapse:collapse}
.tbl th{text-align:left;font-size:.75rem;color:var(--text2);padding:8px 12px;border-bottom:1px solid var(--border);font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.tbl td{padding:10px 12px;border-bottom:1px solid var(--border);font-size:.875rem}
.tbl tr:last-child td{border-bottom:none}
.tbl tr:hover td{background:rgba(255,255,255,.02)}
/* Nav */
.topbar{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 24px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
.topbar-brand{font-size:1.1rem;font-weight:700;color:var(--text);display:flex;align-items:center;gap:10px}
.topbar-nav{display:flex;align-items:center;gap:8px}
.nav-link{padding:6px 14px;border-radius:6px;font-size:.875rem;color:var(--text2);transition:all .15s;font-weight:500}
.nav-link:hover,.nav-link.active{background:rgba(79,156,249,.12);color:var(--accent)}
/* Stat cards */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:16px;margin-bottom:24px}
.stat-card{background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius);padding:20px}
.stat-val{font-size:2rem;font-weight:700;line-height:1;margin-bottom:4px}
.stat-lbl{font-size:.8rem;color:var(--text2);font-weight:500}
/* Alerts */
.alert{padding:12px 16px;border-radius:8px;font-size:.875rem;margin-bottom:16px}
.alert-info{background:rgba(79,156,249,.1);border:1px solid rgba(79,156,249,.2);color:var(--accent)}
.alert-err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.2);color:var(--red)}
.alert-ok{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.2);color:var(--green)}
/* Modal */
.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:1000;align-items:center;justify-content:center}
.modal-bg.open{display:flex}
.modal{background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:28px;width:90%;max-width:500px;max-height:90vh;overflow-y:auto}
.modal-title{font-size:1.1rem;font-weight:700;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between}
/* Calendar */
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.cal-day{aspect-ratio:1;border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:.85rem;cursor:pointer;position:relative;border:1px solid transparent;transition:all .15s}
.cal-day:hover{border-color:var(--border2);background:rgba(255,255,255,.03)}
.cal-day.present{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.2)}
.cal-day.absent{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.2)}
.cal-day.holiday{background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.2)}
.cal-day.today{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.cal-day.other-month{opacity:.3}
.cal-day .day-num{font-weight:600;line-height:1}
.cal-day .day-dot{width:5px;height:5px;border-radius:50%;margin-top:3px}
.day-dot.green{background:var(--green)}.day-dot.red{background:var(--red)}.day-dot.yellow{background:var(--yellow)}
/* Camera */
#video{border-radius:12px;border:2px solid var(--border);width:100%;max-width:640px}
#overlay{position:absolute;top:0;left:0;pointer-events:none;border-radius:12px}
.cam-wrap{position:relative;display:inline-block}
/* Spinner */
.spin{display:inline-block;width:18px;height:18px;border:2px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
/* Toast */
.toast-container{position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px}
.toast{padding:12px 18px;border-radius:8px;font-size:.875rem;font-weight:500;max-width:320px;animation:slideIn .2s ease;display:flex;align-items:center;gap:8px;box-shadow:var(--shadow)}
.toast.ok{background:var(--green);color:#000}.toast.err{background:var(--red);color:#fff}.toast.info{background:var(--accent2);color:#fff}
@keyframes slideIn{from{transform:translateX(50px);opacity:0}to{transform:none;opacity:1}}
/* Responsive */
@media(max-width:768px){.fg2,.fg3{grid-template-columns:1fr}.stat-grid{grid-template-columns:repeat(2,1fr)}}
/* Misc */
.flex{display:flex}.items-center{align-items:center}.justify-between{justify-content:space-between}.gap-2{gap:8px}.gap-3{gap:12px}.gap-4{gap:16px}
.mt-2{margin-top:8px}.mt-3{margin-top:12px}.mt-4{margin-top:16px}.mb-2{margin-bottom:8px}.mb-3{margin-bottom:12px}
.w-full{width:100%}.text-sm{font-size:.875rem}.text-xs{font-size:.75rem}.text-muted{color:var(--text2)}
.divider{border:none;border-top:1px solid var(--border);margin:20px 0}
${extraCss}
</style></head><body>
<div class="toast-container" id="toastContainer"></div>`;
}

function htmlFoot() {
  return `
<script>
function toast(msg,type='info',dur=3000){
  const c=document.getElementById('toastContainer');
  const t=document.createElement('div');
  t.className='toast '+type;
  t.textContent=msg;c.appendChild(t);
  setTimeout(()=>{t.style.opacity='0';t.style.transition='opacity .3s';setTimeout(()=>t.remove(),300);},dur);
}
function $(id){return document.getElementById(id)}
function api(url,opts={}){
  const token=localStorage.getItem('token');
  opts.headers={...opts.headers,'Content-Type':'application/json',Authorization:'Bearer '+token};
  if(opts.body&&typeof opts.body!=='string')opts.body=JSON.stringify(opts.body);
  return fetch(url,opts).then(r=>r.json());
}
async function logout(){
  await api('/api/auth/logout',{method:'POST'}).catch(()=>{});
  localStorage.clear();location.href='/';
}
</script></body></html>`;
}

// ════════════════════════════════════════════════════════════
//  LOGIN PAGE
// ════════════════════════════════════════════════════════════
app.get('/', (req,res) => {
  res.send(htmlHead('FaceAttend — Login','') + `
<style>
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at 20% 50%,rgba(59,130,246,.08) 0%,transparent 60%),var(--bg)}
.login-card{background:var(--card-bg);border:1px solid var(--border);border-radius:16px;padding:40px;width:100%;max-width:420px}
.login-logo{text-align:center;margin-bottom:28px}
.login-logo .icon{font-size:2.5rem}
.login-logo h1{font-size:1.6rem;margin-top:8px}
.login-logo p{color:var(--text2);font-size:.9rem;margin-top:4px}
.role-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:24px;background:var(--bg);border-radius:8px;padding:4px}
.role-tab{padding:8px;text-align:center;border-radius:6px;border:none;background:transparent;color:var(--text2);font-size:.8rem;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit}
.role-tab.active{background:var(--card-bg);color:var(--text);box-shadow:0 1px 4px rgba(0,0,0,.3)}
</style>
<div class="login-wrap">
<div class="login-card">
  <div class="login-logo">
    <div class="icon">🎯</div>
    <h1>FaceAttend</h1>
    <p>AI-Powered Attendance System</p>
  </div>
  <div class="role-tabs">
    <button class="role-tab active" onclick="setRole('admin',this)">Admin</button>
    <button class="role-tab" onclick="setRole('user',this)">User</button>
    <button class="role-tab" onclick="setRole('super_admin',this)">Super Admin</button>
  </div>
  <div id="alert" style="display:none" class="alert"></div>
  <div class="form-row"><label>Email</label><input class="input" id="email" type="email" placeholder="you@example.com"></div>
  <div class="form-row"><label>Password</label><input class="input" id="pass" type="password" placeholder="••••••••"></div>
  <button class="btn btn-primary w-full mt-2" style="justify-content:center" onclick="doLogin()">
    <span id="loginBtn">Sign In</span>
  </button>
  <div class="mt-3 text-sm text-muted" style="text-align:center" id="registerLink">
    New organisation? <a href="/register-admin">Create account</a>
  </div>
</div></div>
<script>
let currentRole='admin';
function setRole(r,el){
  currentRole=r;
  document.querySelectorAll('.role-tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('registerLink').style.display=r==='admin'?'':'none';
}
async function doLogin(){
  const email=$('email').value.trim(),pass=$('pass').value;
  if(!email||!pass){showAlert('Fill all fields','err');return;}
  $('loginBtn').innerHTML='<span class="spin"></span>';
  const r=await api('/api/auth/login',{method:'POST',body:{email,password:pass,role:currentRole}});
  $('loginBtn').textContent='Sign In';
  if(!r.ok){showAlert(r.msg,'err');return;}
  localStorage.setItem('token',r.token);
  localStorage.setItem('role',r.role);
  localStorage.setItem('name',r.name);
  if(r.adminId) localStorage.setItem('adminId',r.adminId);
  if(r.userId)  localStorage.setItem('userId',r.userId);
  if(r.faceId)  localStorage.setItem('faceId',r.faceId||'');
  location.href=r.role==='super_admin'?'/sa':r.role==='admin'?'/admin':'/user';
}
function showAlert(msg,type){
  const a=$('alert');a.textContent=msg;a.className='alert alert-'+(type==='err'?'err':'ok');a.style.display='block';
}
document.getElementById('pass').addEventListener('keypress',e=>{if(e.key==='Enter')doLogin();});
</script>
` + htmlFoot());
});

// ════════════════════════════════════════════════════════════
//  REGISTER ADMIN PAGE
// ════════════════════════════════════════════════════════════
app.get('/register-admin', (req,res) => {
  res.send(htmlHead('Register — FaceAttend') + `
<style>
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center}
.login-card{background:var(--card-bg);border:1px solid var(--border);border-radius:16px;padding:40px;width:100%;max-width:480px}
</style>
<div class="login-wrap"><div class="login-card">
  <h2 style="margin-bottom:20px">🏢 Create Organisation Account</h2>
  <div id="alert" style="display:none" class="alert"></div>
  <div class="form-grid fg2">
    <div class="form-row"><label>Full Name</label><input class="input" id="name" placeholder="Your name"></div>
    <div class="form-row"><label>Email</label><input class="input" id="email" type="email" placeholder="admin@org.com"></div>
    <div class="form-row"><label>Password</label><input class="input" id="pass" type="password" placeholder="••••••••"></div>
    <div class="form-row"><label>Industry Type</label>
      <select class="input" id="industry">
        <option value="school">School / College</option>
        <option value="office">Office / Corporate</option>
        <option value="factory">Factory / Industrial</option>
        <option value="hospital">Hospital / Healthcare</option>
        <option value="other">Other</option>
      </select>
    </div>
  </div>
  <div class="form-row"><label>System Title</label><input class="input" id="title" placeholder="e.g. ABC School Attendance System"></div>
  <button class="btn btn-primary w-full mt-3" style="justify-content:center" onclick="doRegister()">Create Account</button>
  <div class="mt-3 text-sm text-muted" style="text-align:center"><a href="/">← Back to Login</a></div>
</div></div>
<script>
async function doRegister(){
  const name=$('name').value.trim(),email=$('email').value.trim(),pass=$('pass').value,
    industry_type=$('industry').value,title=$('title').value.trim();
  if(!name||!email||!pass){showAlert('Fill all required fields','err');return;}
  const r=await api('/api/auth/register-admin',{method:'POST',body:{name,email,password:pass,industry_type,title}});
  if(!r.ok){showAlert(r.msg,'err');return;}
  showAlert('Account created! Awaiting super admin approval.','ok');
  setTimeout(()=>location.href='/',2500);
}
function showAlert(msg,type){const a=$('alert');a.textContent=msg;a.className='alert alert-'+(type==='err'?'err':'ok');a.style.display='block';}
</script>
` + htmlFoot());
});

// ════════════════════════════════════════════════════════════
//  SUPER ADMIN DASHBOARD
// ════════════════════════════════════════════════════════════
app.get('/sa', (req,res) => {
  res.send(htmlHead('Super Admin — FaceAttend') + `
<div class="topbar">
  <div class="topbar-brand">🎯 FaceAttend <span class="badge badge-purple" style="font-size:.7rem">Super Admin</span></div>
  <div class="topbar-nav">
    <a class="nav-link active" href="/sa">Dashboard</a>
    <button class="btn btn-ghost btn-sm" onclick="logout()">Sign Out</button>
  </div>
</div>
<div class="page" id="saPage">
  <div id="statsGrid" class="stat-grid"></div>
  <div class="card">
    <div class="flex justify-between items-center mb-3">
      <h2 style="margin:0">Organisations</h2>
      <div class="flex gap-2">
        <input class="input" style="width:220px" id="search" placeholder="Search..." oninput="filterAdmins()">
        <select class="input" style="width:140px" id="statusFilter" onchange="filterAdmins()">
          <option value="">All Status</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>
    </div>
    <div id="adminsTable"></div>
  </div>
</div>

<!-- Admin Detail Modal -->
<div class="modal-bg" id="detailModal">
  <div class="modal" style="max-width:700px">
    <div class="modal-title">Organisation Detail <button class="btn btn-ghost btn-sm" onclick="closeModal()">✕</button></div>
    <div id="detailContent"></div>
  </div>
</div>

<script>
let allAdmins=[];
checkAuth();

async function checkAuth(){
  const r=await api('/api/auth/me');
  if(!r.ok||r.role!=='super_admin'){location.href='/';return;}
  loadAll();
}

async function loadAll(){
  const [stats,admins]=await Promise.all([api('/api/sa/stats'),api('/api/sa/admins')]);
  if(stats.ok) renderStats(stats.data);
  if(admins.ok){ allAdmins=admins.data; renderAdmins(allAdmins); }
}

function renderStats(d){
  const g=$('statsGrid');
  const items=[
    {val:d.adminsApproved,lbl:'Active Orgs',color:'var(--green)'},
    {val:d.adminsPending, lbl:'Pending Approval',color:'var(--yellow)'},
    {val:d.usersTotal,    lbl:'Total Users',color:'var(--accent)'},
    {val:d.notifyTotal,   lbl:'Push Enabled',color:'var(--purple)'},
    {val:d.facesTotal,    lbl:'Registered Faces',color:'var(--text)'},
    {val:d.todayPresent,  lbl:"Today's Check-ins",color:'var(--green)'},
  ];
  g.innerHTML=items.map(i=>\`<div class="stat-card"><div class="stat-val" style="color:\${i.color}">\${i.val}</div><div class="stat-lbl">\${i.lbl}</div></div>\`).join('');
}

function filterAdmins(){
  const q=$('search').value.toLowerCase();
  const s=$('statusFilter').value;
  renderAdmins(allAdmins.filter(a=>(a.name+a.email+a.title).toLowerCase().includes(q)&&(!s||a.status===s)));
}

function renderAdmins(admins){
  const statusBadge=s=>({pending:'badge-yellow',approved:'badge-green',rejected:'badge-red',suspended:'badge-gray'}[s]||'badge-gray');
  $('adminsTable').innerHTML=\`<table class="tbl">
    <thead><tr><th>Organisation</th><th>Industry</th><th>Faces</th><th>Users</th><th>Push On</th><th>Today</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>\${admins.map(a=>\`<tr>
      <td><div style="font-weight:600">\${a.name}</div><div class="text-xs text-muted">\${a.email}</div><div class="text-xs text-muted">\${a.title||''}</div></td>
      <td><span class="badge badge-blue">\${a.industry_type||'—'}</span></td>
      <td>\${a.total_faces||0}</td><td>\${a.total_users||0}</td><td>\${a.notify_users||0}</td><td>\${a.today_present||0}</td>
      <td><span class="badge \${statusBadge(a.status)}">\${a.status}</span></td>
      <td><div class="flex gap-2">
        \${a.status!=='approved'?'<button class="btn btn-success btn-sm" onclick="setStatus('+a.id+',\\'approved\\')">Approve</button>':''}
        \${a.status!=='rejected'?'<button class="btn btn-danger btn-sm" onclick="setStatus('+a.id+',\\'rejected\\')">Reject</button>':''}
        \${a.status==='approved'?'<button class="btn btn-ghost btn-sm" onclick="setStatus('+a.id+',\\'suspended\\')">Suspend</button>':''}
        <button class="btn btn-ghost btn-sm" onclick="viewDetail(\${a.id})">View</button>
      </div></td>
    </tr>\`).join('')}</tbody></table>\`;
}

async function setStatus(id,status){
  if(!confirm('Set status to '+status+'?'))return;
  const r=await api('/api/sa/admins/'+id+'/status',{method:'PATCH',body:{status}});
  if(r.ok){toast('Updated','ok');loadAll();}else toast(r.msg,'err');
}

async function viewDetail(id){
  $('detailContent').innerHTML='<div class="text-muted">Loading...</div>';
  $('detailModal').classList.add('open');
  const r=await api('/api/sa/admins/'+id+'/detail');
  if(!r.ok){$('detailContent').innerHTML='Error';return;}
  const {admin,users,shifts,recentAttendance}=r.data;
  const statusBadge=s=>({pending:'badge-yellow',approved:'badge-green',rejected:'badge-red',suspended:'badge-gray'}[s]);
  $('detailContent').innerHTML=\`
    <div class="flex gap-3 mb-3 items-center">
      \${admin.logo_url?'<img src="'+admin.logo_url+'" style="width:56px;height:56px;border-radius:8px;object-fit:cover">':'<div style="width:56px;height:56px;border-radius:8px;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:1.5rem">🏢</div>'}
      <div><div style="font-weight:700;font-size:1.1rem">\${admin.name}</div><div class="text-muted text-sm">\${admin.email}</div>
      <span class="badge \${statusBadge(admin.status)}">\${admin.status}</span></div>
    </div>
    <div class="form-grid fg2 mb-3">
      <div class="card-sm"><div class="text-xs text-muted">Industry</div><div>\${admin.industry_type||'—'}</div></div>
      <div class="card-sm"><div class="text-xs text-muted">Title</div><div>\${admin.title||'—'}</div></div>
      <div class="card-sm"><div class="text-xs text-muted">Registered</div><div>\${new Date(admin.created_at).toLocaleDateString()}</div></div>
      <div class="card-sm"><div class="text-xs text-muted">Shifts Defined</div><div>\${shifts.length}</div></div>
    </div>
    <h3>Users (\${users.length})</h3>
    <table class="tbl mb-3"><thead><tr><th>Name</th><th>Email</th><th>Push</th><th>Face</th></tr></thead>
    <tbody>\${users.map(u=>\`<tr><td>\${u.name}</td><td>\${u.email}</td>
      <td>\${u.notify_enabled?'<span class="badge badge-green">On</span>':'<span class="badge badge-gray">Off</span>'}</td>
      <td>\${u.face_id?'<span class="badge badge-blue">Linked</span>':'<span class="badge badge-yellow">Unlinked</span>'}</td></tr>\`).join('')}</tbody></table>
    <h3>Recent Attendance (14 days)</h3>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
    \${recentAttendance.map(r=>\`<div class="card-sm" style="min-width:80px;text-align:center">
      <div class="text-xs text-muted">\${r.date}</div>
      <div style="color:var(--green);font-weight:700">\${r.cnt}</div></div>\`).join('')}
    </div>
  \`;
}
function closeModal(){$('detailModal').classList.remove('open');}
$('detailModal').addEventListener('click',e=>{if(e.target===$('detailModal'))closeModal();});
</script>
` + htmlFoot());
});

// ════════════════════════════════════════════════════════════
//  ADMIN DASHBOARD
// ════════════════════════════════════════════════════════════
app.get('/admin', (req,res) => {
  res.send(htmlHead('Admin Dashboard — FaceAttend') + `
<div class="topbar" id="topbar">
  <div class="topbar-brand" id="brandArea">🎯 FaceAttend</div>
  <div class="topbar-nav">
    <a class="nav-link active" href="/admin" id="navDash">Dashboard</a>
    <a class="nav-link" href="/admin/scan">Scan</a>
    <a class="nav-link" href="/admin/faces">Faces</a>
    <a class="nav-link" href="/admin/users">Users</a>
    <a class="nav-link" href="/admin/shifts">Shifts</a>
    <a class="nav-link" href="/admin/calendar">Calendar</a>
    <a class="nav-link" href="/admin/settings">Settings</a>
    <button class="btn btn-ghost btn-sm" onclick="logout()">Sign Out</button>
  </div>
</div>
<div class="page" id="adminPage">
  <div id="alertBox" class="alert alert-err" style="display:none"></div>
  <div id="statsGrid" class="stat-grid"></div>

  <div class="form-grid fg2">
    <div class="card">
      <h3>📅 Today's Attendance</h3>
      <div id="todayList" class="text-muted text-sm">Loading...</div>
    </div>
    <div class="card">
      <h3>🔔 Notification Status</h3>
      <div id="notifyStats"></div>
    </div>
  </div>

  <div class="card">
    <h3>👥 Recent Faces</h3>
    <div id="facesList"></div>
    <a href="/admin/faces" class="btn btn-ghost btn-sm mt-3">View All →</a>
  </div>
</div>

<script>
checkAuth();
async function checkAuth(){
  const r=await api('/api/auth/me');
  if(!r.ok||r.role!=='admin'){location.href='/';return;}
  loadDashboard();
}
async function loadDashboard(){
  const [stats,today,notify,faces,profile]=await Promise.all([
    api('/api/admin/stats'), api('/api/admin/attendance/day?date='+new Date().toISOString().slice(0,10)),
    api('/api/admin/notification-stats'), api('/api/admin/faces'), api('/api/admin/profile')
  ]);
  if(profile.ok&&profile.data.logo_url){
    $('brandArea').innerHTML='<img src="'+profile.data.logo_url+'" style="height:32px;border-radius:4px"> '+profile.data.title;
  }
  if(stats.ok) renderStats(stats.data);
  if(today.ok) renderToday(today.data);
  if(notify.ok) renderNotify(notify.data);
  if(faces.ok) renderFaces(faces.data.slice(0,8));
}
function renderStats(d){
  $('statsGrid').innerHTML=[
    {val:d.faces,lbl:'Registered Faces',col:'var(--accent)'},
    {val:d.users,lbl:'Users',col:'var(--text)'},
    {val:d.today_present,lbl:'Present Today',col:'var(--green)'},
    {val:d.today_absent,lbl:'Absent Today',col:'var(--red)'},
    {val:d.notify,lbl:'Push Enabled',col:'var(--purple)'},
    {val:d.shifts,lbl:'Shifts',col:'var(--yellow)'},
  ].map(i=>\`<div class="stat-card"><div class="stat-val" style="color:\${i.col}">\${i.val}</div><div class="stat-lbl">\${i.lbl}</div></div>\`).join('');
}
function renderToday(rows){
  if(!rows.length){$('todayList').innerHTML='<p class="text-muted">No attendance recorded today</p>';return;}
  $('todayList').innerHTML=\`<table class="tbl">\${rows.map(r=>\`<tr><td>\${r.name}</td><td class="mono text-xs">\${r.time_in}</td><td><span class="badge \${r.status==='present'?'badge-green':'badge-red'}">\${r.status}</span></td></tr>\`).join('')}</table>\`;
}
function renderNotify({enabled,disabled,total}){
  const pct=total?Math.round(enabled/total*100):0;
  $('notifyStats').innerHTML=\`
    <div style="margin-bottom:12px">
      <div style="background:var(--bg);border-radius:99px;height:8px;overflow:hidden">
        <div style="width:\${pct}%;height:100%;background:var(--accent);border-radius:99px;transition:width .5s"></div>
      </div>
      <div class="flex justify-between mt-2 text-sm">
        <span style="color:var(--green)">\${enabled} enabled</span>
        <span style="color:var(--red)">\${disabled} disabled</span>
      </div>
    </div>
    <p class="text-sm text-muted">\${pct}% of users have push notifications on</p>\`;
}
function renderFaces(faces){
  $('facesList').innerHTML=faces.length?faces.map(f=>\`<div class="flex justify-between items-center" style="padding:8px 0;border-bottom:1px solid var(--border)">
    <div><div style="font-weight:500">\${f.label}</div><div class="text-xs text-muted">\${f.department||'—'} · ID:\${f.employee_id||'—'}</div></div>
    <span class="badge badge-\${f.registration_accuracy>=90?'green':f.registration_accuracy>=70?'yellow':'red'}">\${f.registration_accuracy}%</span>
  </div>\`).join(''):'<p class="text-muted text-sm">No faces registered yet</p>';
}
</script>
` + htmlFoot());
});

// ════════════════════════════════════════════════════════════
//  ADMIN — FACE SCAN PAGE
// ════════════════════════════════════════════════════════════
app.get('/admin/scan', (req,res) => {
  res.send(htmlHead('Face Scan — FaceAttend') + `
<div class="topbar">
  <div class="topbar-brand">🎯 FaceAttend</div>
  <div class="topbar-nav">
    <a class="nav-link" href="/admin">Dashboard</a>
    <a class="nav-link active" href="/admin/scan">Scan</a>
    <a class="nav-link" href="/admin/faces">Faces</a>
    <a class="nav-link" href="/admin/users">Users</a>
    <a class="nav-link" href="/admin/shifts">Shifts</a>
    <a class="nav-link" href="/admin/calendar">Calendar</a>
    <a class="nav-link" href="/admin/settings">Settings</a>
    <button class="btn btn-ghost btn-sm" onclick="logout()">Sign Out</button>
  </div>
</div>
<div class="page">
  <h1>Face Scanner</h1>
  <p class="subtitle">Real-time face detection and attendance marking</p>
  <div class="form-grid fg2">
    <div>
      <div class="card-sm mb-3">
        <label>Active Shift</label>
        <select class="input" id="shiftSel"><option value="">Auto-detect</option></select>
      </div>
      <div class="cam-wrap" style="display:block">
        <video id="video" autoplay muted playsinline></video>
        <canvas id="overlay"></canvas>
      </div>
      <div class="flex gap-2 mt-3">
        <button class="btn btn-primary" onclick="startCam()">▶ Start Camera</button>
        <button class="btn btn-ghost" onclick="stopCam()">⏹ Stop</button>
      </div>
      <div id="status" class="alert alert-info mt-3" style="display:none"></div>
    </div>
    <div>
      <div class="card">
        <h3>📋 Today's Attendance</h3>
        <div id="attendanceList" style="max-height:400px;overflow-y:auto">
          <p class="text-muted text-sm">Loading...</p>
        </div>
      </div>
      <div class="card mt-3">
        <h3>⚡ Last Detection</h3>
        <div id="lastDetection" class="text-muted text-sm">No detection yet</div>
      </div>
    </div>
  </div>
</div>
<script src="/faceapi.js"></script>
<script>
let adminId=localStorage.getItem('adminId');
let knownFaces=[],shiftId=null,scanInterval=null,videoStream=null;
let modelsLoaded=false;

checkAuth();
async function checkAuth(){
  const r=await api('/api/auth/me');
  if(!r.ok||r.role!=='admin'){location.href='/';return;}
  adminId=r.admin_id;
  localStorage.setItem('adminId',adminId);
  await loadShifts();
  await loadFaces();
  await loadToday();
}

async function loadShifts(){
  const r=await api('/api/admin/shifts');
  if(r.ok&&r.data.length){
    r.data.forEach(s=>{
      const o=document.createElement('option');
      o.value=s.id;o.textContent=s.name+' ('+s.start_time.slice(0,5)+'-'+s.end_time.slice(0,5)+')';
      $('shiftSel').appendChild(o);
    });
  }
}

async function loadFaces(){
  const r=await fetch('/api/scan/faces?adminId='+adminId).then(x=>x.json());
  if(r.ok){
    knownFaces=r.data.map(f=>({id:f.id,label:f.label,descriptors:JSON.parse(f.descriptor).map(d=>new Float32Array(d))}));
    showStatus('✅ '+knownFaces.length+' faces loaded','info');
  }
}

async function loadModels(){
  if(modelsLoaded)return true;
  showStatus('📥 Loading AI models...','info');
  try{
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri('/models'),
      faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
      faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
    ]);
    modelsLoaded=true;
    return true;
  }catch(e){showStatus('❌ Model load failed: '+e.message,'err');return false;}
}

async function startCam(){
  if(!await loadModels())return;
  try{
    videoStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:640,height:480}});
    $('video').srcObject=videoStream;
    await new Promise(r=>$('video').onloadedmetadata=r);
    $('overlay').width=$('video').videoWidth;$('overlay').height=$('video').videoHeight;
    showStatus('📷 Camera active — scanning...','info');
    if(scanInterval)clearInterval(scanInterval);
    scanInterval=setInterval(scanFrame,800);
  }catch(e){showStatus('❌ Camera error: '+e.message,'err');}
}

function stopCam(){
  if(scanInterval){clearInterval(scanInterval);scanInterval=null;}
  if(videoStream){videoStream.getTracks().forEach(t=>t.stop());videoStream=null;}
  $('video').srcObject=null;
  const ctx=$('overlay').getContext('2d');ctx.clearRect(0,0,$('overlay').width,$('overlay').height);
  showStatus('⏹ Camera stopped','info');
}

async function scanFrame(){
  if(!$('video').srcObject)return;
  const detections=await faceapi.detectAllFaces($('video'),new faceapi.SsdMobilenetv1Options({minConfidence:.5}))
    .withFaceLandmarks().withFaceDescriptors();
  const ctx=$('overlay').getContext('2d');
  ctx.clearRect(0,0,$('overlay').width,$('overlay').height);
  const scaleX=$('overlay').width/$('video').videoWidth||1;
  const scaleY=$('overlay').height/$('video').videoHeight||1;

  for(const det of detections){
    const {x,y,width,height}=det.detection.box;
    let bestLabel='Unknown',bestDist=99;
    for(const kf of knownFaces){
      for(const desc of kf.descriptors){
        const d=faceapi.euclideanDistance(det.descriptor,desc);
        if(d<bestDist){bestDist=d;bestLabel=d<0.5?kf.label:'Unknown';}
      }
    }
    const isKnown=bestLabel!=='Unknown';
    ctx.strokeStyle=isKnown?'#22c55e':'#ef4444';ctx.lineWidth=2;
    ctx.strokeRect(x*scaleX,y*scaleY,width*scaleX,height*scaleY);
    ctx.fillStyle=isKnown?'#22c55e':'#ef4444';
    ctx.fillRect(x*scaleX,y*scaleY-22,bestLabel.length*8+12,22);
    ctx.fillStyle='#000';ctx.font='bold 12px monospace';
    ctx.fillText(bestLabel,x*scaleX+6,y*scaleY-6);

    if(isKnown){
      const face=knownFaces.find(f=>f.label===bestLabel);
      await markAttendance(face.id,bestLabel);
    } else if(detections.length&&!isKnown){
      await saveUnknown(det);
    }
  }
}

const recentMarked={};
async function markAttendance(faceId,name){
  const key=faceId+'-'+new Date().toDateString();
  if(recentMarked[key]&&Date.now()-recentMarked[key]<30000)return;
  recentMarked[key]=Date.now();
  const r=await fetch('/api/scan/mark',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({adminId,faceId,name,shiftId:$('shiftSel').value||null})}).then(x=>x.json());
  const msg=r.status==='already_marked'?name+' already marked':(r.status==='present'?'✅ '+name+' — Present':'❌ '+name+' — Absent');
  $('lastDetection').innerHTML='<strong>'+name+'</strong><br><span class="badge badge-'+(r.status==='present'?'green':'red')+'">'+r.status+'</span><br><span class="text-xs text-muted">'+new Date().toLocaleTimeString()+'</span>';
  toast(msg,r.status==='present'?'ok':'err');
  loadToday();
}

const recentUnknown={};
async function saveUnknown(det){
  const key='unk-'+Math.round(det.detection.box.x/50);
  if(recentUnknown[key]&&Date.now()-recentUnknown[key]<60000)return;
  recentUnknown[key]=Date.now();
  const canvas=document.createElement('canvas');canvas.width=det.detection.box.width;canvas.height=det.detection.box.height;
  const ctx2=canvas.getContext('2d');
  ctx2.drawImage($('video'),det.detection.box.x,det.detection.box.y,det.detection.box.width,det.detection.box.height,0,0,canvas.width,canvas.height);
  await fetch('/api/scan/unknown',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({adminId,imageBase64:canvas.toDataURL('image/jpeg',.7)})});
}

async function loadToday(){
  const date=new Date().toISOString().slice(0,10);
  const r=await api('/api/admin/attendance/day?date='+date);
  if(!r.ok)return;
  $('attendanceList').innerHTML=r.data.length?r.data.map(a=>\`<div class="flex justify-between items-center" style="padding:6px 0;border-bottom:1px solid var(--border)">
    <div><div style="font-weight:500;font-size:.875rem">\${a.name}</div><div class="text-xs text-muted">\${a.time_in}\${a.shift_name?' · '+a.shift_name:''}</div></div>
    <span class="badge badge-\${a.status==='present'?'green':'red'}">\${a.status}</span>
  </div>\`).join(''):'<p class="text-muted text-sm">No attendance yet</p>';
}

function showStatus(msg,type){const s=$('status');s.className='alert alert-'+type+' mt-3';s.textContent=msg;s.style.display='block';}
</script>
` + htmlFoot());
});

// ════════════════════════════════════════════════════════════
//  ADMIN — FACES PAGE
// ════════════════════════════════════════════════════════════
app.get('/admin/faces', (req,res) => {
  res.send(htmlHead('Faces — FaceAttend') + `
<div class="topbar">
  <div class="topbar-brand">🎯 FaceAttend</div>
  <div class="topbar-nav">
    <a class="nav-link" href="/admin">Dashboard</a>
    <a class="nav-link" href="/admin/scan">Scan</a>
    <a class="nav-link active" href="/admin/faces">Faces</a>
    <a class="nav-link" href="/admin/users">Users</a>
    <a class="nav-link" href="/admin/shifts">Shifts</a>
    <a class="nav-link" href="/admin/calendar">Calendar</a>
    <a class="nav-link" href="/admin/settings">Settings</a>
    <button class="btn btn-ghost btn-sm" onclick="logout()">Sign Out</button>
  </div>
</div>
<div class="page">
  <div class="flex justify-between items-center mb-3">
    <div><h1>Registered Faces</h1><p class="subtitle">Register and manage face identities</p></div>
    <button class="btn btn-primary" onclick="openModal()">+ Register New Face</button>
  </div>
  <div id="alertBox" style="display:none" class="alert"></div>
  <div class="card">
    <div id="faceTable"></div>
  </div>
</div>

<!-- Register Modal -->
<div class="modal-bg" id="regModal">
<div class="modal" style="max-width:680px">
  <div class="modal-title">Register New Face
    <button class="btn btn-ghost btn-sm" onclick="closeModal()">✕</button>
  </div>
  <div id="regAlert" style="display:none" class="alert"></div>
  <div class="form-grid fg2 mb-3">
    <div class="form-row"><label>Name / Label *</label><input class="input" id="regLabel" placeholder="e.g. John Doe"></div>
    <div class="form-row"><label>Employee ID</label><input class="input" id="regEmpId" placeholder="EMP001"></div>
    <div class="form-row"><label>Department</label><input class="input" id="regDept" placeholder="Engineering"></div>
    <div class="form-row"><label>Email (for user account)</label><input class="input" id="regEmail" type="email" placeholder="john@org.com"></div>
    <div class="form-row"><label>Password (for user login)</label><input class="input" id="regPass" type="password" placeholder="••••••••"></div>
  </div>
  <div style="position:relative;display:inline-block">
    <video id="regVideo" style="border-radius:8px;border:1px solid var(--border);width:320px;height:240px" autoplay muted></video>
    <canvas id="regOverlay" style="position:absolute;top:0;left:0;pointer-events:none"></canvas>
  </div>
  <div class="mt-2 mb-3">
    <div class="flex gap-2">
      <button class="btn btn-ghost" onclick="startRegCam()">▶ Start Camera</button>
      <button class="btn btn-primary" id="captureBtn" onclick="captureDescriptors()" disabled>📸 Capture (0/10)</button>
    </div>
    <div id="captureProgress" style="margin-top:8px;display:none">
      <div style="background:var(--bg);border-radius:99px;height:6px;overflow:hidden">
        <div id="progBar" style="width:0%;height:100%;background:var(--accent);transition:width .3s;border-radius:99px"></div>
      </div>
    </div>
  </div>
  <button class="btn btn-success w-full" onclick="registerFace()" id="regBtn" disabled>✅ Register Face</button>
</div></div>

<script src="/faceapi.js"></script>
<script>
let modelsLoaded=false,regCamStream=null,capturedDescriptors=[],regInterval=null;
checkAuth();
async function checkAuth(){const r=await api('/api/auth/me');if(!r.ok||r.role!=='admin'){location.href='/';return;}loadFaces();}
async function loadFaces(){
  const r=await api('/api/admin/faces');
  if(!r.ok)return;
  $('faceTable').innerHTML=r.data.length?\`<table class="tbl">
    <thead><tr><th>Name</th><th>Emp ID</th><th>Department</th><th>Accuracy</th><th>Registered</th><th>Actions</th></tr></thead>
    <tbody>\${r.data.map(f=>\`<tr>
      <td style="font-weight:500">\${f.label}</td><td class="mono text-sm">\${f.employee_id||'—'}</td>
      <td>\${f.department||'—'}</td>
      <td><span class="badge badge-\${f.registration_accuracy>=90?'green':f.registration_accuracy>=70?'yellow':'red'}">\${f.registration_accuracy}%</span></td>
      <td class="text-sm text-muted">\${new Date(f.registered_at).toLocaleDateString()}</td>
      <td><button class="btn btn-danger btn-sm" onclick="delFace(\${f.id},'\\${f.label}')">Delete</button></td>
    </tr>\`).join('')}</tbody></table>\`:'<p class="text-muted text-sm">No faces registered</p>';
}
async function delFace(id,label){
  if(!confirm('Delete '+label+'? All attendance records will be removed.'))return;
  const r=await api('/api/admin/faces/'+id,{method:'DELETE'});
  if(r.ok){toast('Deleted','ok');loadFaces();}else toast(r.msg,'err');
}
function openModal(){$('regModal').classList.add('open');}
function closeModal(){
  $('regModal').classList.remove('open');
  stopRegCam();capturedDescriptors=[];
  $('captureBtn').textContent='📸 Capture (0/10)';$('captureBtn').disabled=true;
  $('regBtn').disabled=true;$('progBar').style.width='0%';
}
async function startRegCam(){
  if(!modelsLoaded){
    showRegAlert('📥 Loading models...','info');
    await Promise.all([faceapi.nets.ssdMobilenetv1.loadFromUri('/models'),faceapi.nets.faceLandmark68Net.loadFromUri('/models'),faceapi.nets.faceRecognitionNet.loadFromUri('/models')]);
    modelsLoaded=true;showRegAlert('','');
  }
  regCamStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user',width:320,height:240}});
  $('regVideo').srcObject=regCamStream;
  await new Promise(r=>$('regVideo').onloadedmetadata=r);
  $('regOverlay').width=$('regVideo').videoWidth;$('regOverlay').height=$('regVideo').videoHeight;
  $('captureBtn').disabled=false;
  capturedDescriptors=[];
  $('captureProgress').style.display='block';
}
function stopRegCam(){
  if(regCamStream){regCamStream.getTracks().forEach(t=>t.stop());regCamStream=null;}
  $('regVideo').srcObject=null;
  if(regInterval){clearInterval(regInterval);regInterval=null;}
}
async function captureDescriptors(){
  $('captureBtn').disabled=true;
  for(let i=capturedDescriptors.length;i<10;i++){
    await new Promise(r=>setTimeout(r,400));
    const dets=await faceapi.detectSingleFace($('regVideo'),new faceapi.SsdMobilenetv1Options({minConfidence:.5})).withFaceLandmarks().withFaceDescriptor();
    if(dets){capturedDescriptors.push(Array.from(dets.descriptor));}
    const cnt=capturedDescriptors.length;
    $('captureBtn').textContent='📸 Capture ('+cnt+'/10)';
    $('progBar').style.width=(cnt*10)+'%';
    if(cnt>=10){$('regBtn').disabled=false;toast('10 samples captured!','ok');break;}
  }
  $('captureBtn').disabled=false;
}
async function registerFace(){
  const label=$('regLabel').value.trim(),empId=$('regEmpId').value.trim(),dept=$('regDept').value.trim(),
    email=$('regEmail').value.trim(),pass=$('regPass').value;
  if(!label){showRegAlert('Name is required','err');return;}
  if(capturedDescriptors.length<3){showRegAlert('Capture at least 3 face samples','err');return;}
  $('regBtn').textContent='Saving...';$('regBtn').disabled=true;
  const r=await api('/api/admin/faces',{method:'POST',body:{label,employee_id:empId,department:dept,descriptors:capturedDescriptors}});
  if(!r.ok){showRegAlert(r.msg,'err');$('regBtn').textContent='✅ Register Face';$('regBtn').disabled=false;return;}
  // Create user if email provided
  if(email&&pass){
    await api('/api/admin/users',{method:'POST',body:{name:label,email,password:pass,face_id:r.id}});
    toast('Face + user account created!','ok');
  } else {toast('Face registered!','ok');}
  closeModal();loadFaces();
}
function showRegAlert(msg,type){const a=$('regAlert');a.textContent=msg;a.className='alert alert-'+(type||'info');a.style.display=msg?'block':'none';}
</script>
` + htmlFoot());
});

// ════════════════════════════════════════════════════════════
//  ADMIN — USERS PAGE
// ════════════════════════════════════════════════════════════
app.get('/admin/users', (req,res) => {
  res.send(htmlHead('Users — FaceAttend') + `
<div class="topbar">
  <div class="topbar-brand">🎯 FaceAttend</div>
  <div class="topbar-nav">
    <a class="nav-link" href="/admin">Dashboard</a>
    <a class="nav-link" href="/admin/scan">Scan</a>
    <a class="nav-link" href="/admin/faces">Faces</a>
    <a class="nav-link active" href="/admin/users">Users</a>
    <a class="nav-link" href="/admin/shifts">Shifts</a>
    <a class="nav-link" href="/admin/calendar">Calendar</a>
    <a class="nav-link" href="/admin/settings">Settings</a>
    <button class="btn btn-ghost btn-sm" onclick="logout()">Sign Out</button>
  </div>
</div>
<div class="page">
  <div class="flex justify-between items-center mb-3">
    <div><h1>Users</h1><p class="subtitle">Manage user accounts and notification settings</p></div>
    <button class="btn btn-primary" onclick="openModal()">+ Add User</button>
  </div>
  <div id="notifyStats" class="card mb-3 flex gap-4 items-center" style="padding:16px"></div>
  <div class="card"><div id="userTable"></div></div>
</div>

<!-- Add/Edit User Modal -->
<div class="modal-bg" id="modal">
<div class="modal">
  <div class="modal-title"><span id="modalTitle">Add User</span>
    <button class="btn btn-ghost btn-sm" onclick="closeModal()">✕</button>
  </div>
  <div id="modalAlert" style="display:none" class="alert"></div>
  <div class="form-row"><label>Full Name *</label><input class="input" id="mName" placeholder="John Doe"></div>
  <div class="form-row"><label>Email *</label><input class="input" id="mEmail" type="email" placeholder="john@org.com"></div>
  <div class="form-row" id="passRow"><label>Password *</label><input class="input" id="mPass" type="password" placeholder="••••••••"></div>
  <div class="form-row"><label>Link to Face</label><select class="input" id="mFace"><option value="">— None —</option></select></div>
  <div class="flex gap-2 mt-3">
    <button class="btn btn-primary" onclick="saveUser()">Save</button>
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
  </div>
</div></div>

<script>
let faces=[],editId=null;
checkAuth();
async function checkAuth(){const r=await api('/api/auth/me');if(!r.ok||r.role!=='admin'){location.href='/';return;}loadAll();}
async function loadAll(){
  const [users,facesR,notify]=await Promise.all([api('/api/admin/users'),api('/api/admin/faces'),api('/api/admin/notification-stats')]);
  faces=facesR.ok?facesR.data:[];
  if(users.ok)renderUsers(users.data);
  if(notify.ok)renderNotify(notify.data);
}
function renderNotify({enabled,disabled,total}){
  $('notifyStats').innerHTML=\`<div style="font-size:1.5rem;font-weight:700;color:var(--green)">\${enabled}</div><div class="text-muted text-sm">Push Enabled</div>
  <div style="font-size:1.5rem;font-weight:700;color:var(--red);margin-left:16px">\${disabled}</div><div class="text-muted text-sm">Push Disabled</div>
  <div style="font-size:1.5rem;font-weight:700;margin-left:16px">\${total}</div><div class="text-muted text-sm">Total Users</div>\`;
}
function renderUsers(users){
  $('userTable').innerHTML=users.length?\`<table class="tbl">
    <thead><tr><th>Name</th><th>Email</th><th>Face Linked</th><th>Push</th><th>Joined</th><th>Actions</th></tr></thead>
    <tbody>\${users.map(u=>\`<tr>
      <td style="font-weight:500">\${u.name}</td>
      <td class="text-sm">\${u.email}</td>
      <td>\${u.face_label?'<span class="badge badge-blue">'+u.face_label+'</span>':'<span class="badge badge-gray">None</span>'}</td>
      <td>\${u.notify_enabled?'<span class="badge badge-green">ON</span>':'<span class="badge badge-gray">OFF</span>'}</td>
      <td class="text-sm text-muted">\${new Date(u.created_at).toLocaleDateString()}</td>
      <td><div class="flex gap-2">
        <button class="btn btn-ghost btn-sm" onclick="editUser(\${u.id},'\${u.name}','\${u.email}',\${u.face_id||0})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="delUser(\${u.id},'\${u.name}')">Del</button>
      </div></td>
    </tr>\`).join('')}</tbody></table>\`:'<p class="text-muted text-sm">No users yet</p>';
}
function openModal(){
  editId=null;$('modalTitle').textContent='Add User';$('mName').value='';$('mEmail').value='';$('mPass').value='';
  $('passRow').style.display='';$('mFace').innerHTML='<option value="">— None —</option>';
  faces.forEach(f=>{const o=document.createElement('option');o.value=f.id;o.textContent=f.label;$('mFace').appendChild(o);});
  $('modal').classList.add('open');
}
function editUser(id,name,email,faceId){
  editId=id;$('modalTitle').textContent='Edit User';$('mName').value=name;$('mEmail').value=email;$('mPass').value='';
  $('passRow').style.display='none';
  $('mFace').innerHTML='<option value="">— None —</option>';
  faces.forEach(f=>{const o=document.createElement('option');o.value=f.id;o.textContent=f.label;if(f.id===faceId)o.selected=true;$('mFace').appendChild(o);});
  $('modal').classList.add('open');
}
function closeModal(){$('modal').classList.remove('open');}
async function saveUser(){
  const name=$('mName').value.trim(),email=$('mEmail').value.trim(),pass=$('mPass').value,face_id=$('mFace').value;
  if(!name||!email){alert('Name and email required');return;}
  let r;
  if(editId){r=await api('/api/admin/users/'+editId,{method:'PUT',body:{name,email,face_id:face_id||null}});}
  else{if(!pass){alert('Password required');return;}r=await api('/api/admin/users',{method:'POST',body:{name,email,password:pass,face_id:face_id||null}});}
  if(r.ok){toast('Saved','ok');closeModal();loadAll();}else{$('modalAlert').textContent=r.msg;$('modalAlert').className='alert alert-err';$('modalAlert').style.display='block';}
}
async function delUser(id,name){
  if(!confirm('Delete user '+name+'?'))return;
  const r=await api('/api/admin/users/'+id,{method:'DELETE'});
  if(r.ok){toast('Deleted','ok');loadAll();}else toast(r.msg,'err');
}
</script>
` + htmlFoot());
});

// ════════════════════════════════════════════════════════════
//  ADMIN — SHIFTS PAGE
// ════════════════════════════════════════════════════════════
app.get('/admin/shifts', (req,res) => {
  res.send(htmlHead('Shifts — FaceAttend') + `
<div class="topbar">
  <div class="topbar-brand">🎯 FaceAttend</div>
  <div class="topbar-nav">
    <a class="nav-link" href="/admin">Dashboard</a>
    <a class="nav-link" href="/admin/scan">Scan</a>
    <a class="nav-link" href="/admin/faces">Faces</a>
    <a class="nav-link" href="/admin/users">Users</a>
    <a class="nav-link active" href="/admin/shifts">Shifts</a>
    <a class="nav-link" href="/admin/calendar">Calendar</a>
    <a class="nav-link" href="/admin/settings">Settings</a>
    <button class="btn btn-ghost btn-sm" onclick="logout()">Sign Out</button>
  </div>
</div>
<div class="page">
  <div class="flex justify-between items-center mb-3">
    <div><h1>Shift Management</h1><p class="subtitle">Define work shifts. If face scan is within shift time → Present, else → Absent</p></div>
    <button class="btn btn-primary" onclick="openModal()">+ Add Shift</button>
  </div>
  <div class="card"><div id="shiftTable"></div></div>
</div>

<div class="modal-bg" id="modal">
<div class="modal" style="max-width:420px">
  <div class="modal-title"><span id="modalTitle">Add Shift</span>
    <button class="btn btn-ghost btn-sm" onclick="closeModal()">✕</button>
  </div>
  <div class="form-row"><label>Shift Name *</label><input class="input" id="sName" placeholder="e.g. Morning, Evening"></div>
  <div class="form-grid fg2">
    <div class="form-row"><label>Start Time *</label><input class="input" id="sStart" type="time"></div>
    <div class="form-row"><label>End Time *</label><input class="input" id="sEnd" type="time"></div>
  </div>
  <div class="alert alert-info mt-2 text-sm">If a face is scanned after end time, status is marked as Absent</div>
  <div class="flex gap-2 mt-3">
    <button class="btn btn-primary" onclick="saveShift()">Save</button>
    <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
  </div>
</div></div>

<script>
let editId=null;
checkAuth();
async function checkAuth(){const r=await api('/api/auth/me');if(!r.ok||r.role!=='admin'){location.href='/';return;}loadShifts();}
async function loadShifts(){
  const r=await api('/api/admin/shifts');
  if(!r.ok)return;
  $('shiftTable').innerHTML=r.data.length?\`<table class="tbl">
    <thead><tr><th>Shift Name</th><th>Start</th><th>End</th><th>Actions</th></tr></thead>
    <tbody>\${r.data.map(s=>\`<tr>
      <td style="font-weight:600">\${s.name}</td>
      <td class="mono">\${s.start_time.slice(0,5)}</td>
      <td class="mono">\${s.end_time.slice(0,5)}</td>
      <td><div class="flex gap-2">
        <button class="btn btn-ghost btn-sm" onclick="editShift(\${s.id},'\${s.name}','\${s.start_time.slice(0,5)}','\${s.end_time.slice(0,5)}')">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="delShift(\${s.id})">Delete</button>
      </div></td>
    </tr>\`).join('')}</tbody></table>\`:'<p class="text-muted text-sm">No shifts defined. Add shifts to enable attendance tracking.</p>';
}
function openModal(){editId=null;$('modalTitle').textContent='Add Shift';$('sName').value='';$('sStart').value='';$('sEnd').value='';$('modal').classList.add('open');}
function editShift(id,name,start,end){editId=id;$('modalTitle').textContent='Edit Shift';$('sName').value=name;$('sStart').value=start;$('sEnd').value=end;$('modal').classList.add('open');}
function closeModal(){$('modal').classList.remove('open');}
async function saveShift(){
  const name=$('sName').value.trim(),start=$('sStart').value,end=$('sEnd').value;
  if(!name||!start||!end){toast('Fill all fields','err');return;}
  const r=editId?await api('/api/admin/shifts/'+editId,{method:'PUT',body:{name,start_time:start,end_time:end}}):
    await api('/api/admin/shifts',{method:'POST',body:{name,start_time:start,end_time:end}});
  if(r.ok){toast('Saved','ok');closeModal();loadShifts();}else toast(r.msg,'err');
}
async function delShift(id){
  if(!confirm('Delete this shift?'))return;
  const r=await api('/api/admin/shifts/'+id,{method:'DELETE'});
  if(r.ok){toast('Deleted','ok');loadShifts();}else toast(r.msg,'err');
}
</script>
` + htmlFoot());
});

// ════════════════════════════════════════════════════════════
//  ADMIN — CALENDAR PAGE
// ════════════════════════════════════════════════════════════
app.get('/admin/calendar', (req,res) => {
  res.send(htmlHead('Calendar — FaceAttend') + `
<div class="topbar">
  <div class="topbar-brand">🎯 FaceAttend</div>
  <div class="topbar-nav">
    <a class="nav-link" href="/admin">Dashboard</a>
    <a class="nav-link" href="/admin/scan">Scan</a>
    <a class="nav-link" href="/admin/faces">Faces</a>
    <a class="nav-link" href="/admin/users">Users</a>
    <a class="nav-link" href="/admin/shifts">Shifts</a>
    <a class="nav-link active" href="/admin/calendar">Calendar</a>
    <a class="nav-link" href="/admin/settings">Settings</a>
    <button class="btn btn-ghost btn-sm" onclick="logout()">Sign Out</button>
  </div>
</div>
<div class="page">
  <h1>Attendance Calendar</h1>
  <p class="subtitle">View attendance by date. Click any date for details or to mark as holiday.</p>
  <div class="form-grid fg2">
    <div class="card">
      <div class="flex justify-between items-center mb-3">
        <button class="btn btn-ghost btn-sm" onclick="changeMonth(-1)">‹ Prev</button>
        <h3 id="calTitle" style="margin:0"></h3>
        <button class="btn btn-ghost btn-sm" onclick="changeMonth(1)">Next ›</button>
      </div>
      <div class="cal-grid" style="margin-bottom:8px">
        ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<div style="text-align:center;font-size:.7rem;color:var(--text2);font-weight:600;padding:4px">${d}</div>`).join('')}
      </div>
      <div id="calGrid" class="cal-grid"></div>
      <div class="flex gap-3 mt-3 text-xs text-muted flex-wrap">
        <span>🟢 Present</span><span>🔴 Absent</span><span>🟡 Holiday</span>
      </div>
    </div>
    <div>
      <div class="card" id="dayDetail" style="min-height:200px">
        <h3>Select a date</h3>
        <p class="text-muted text-sm">Click on any date to view attendance details</p>
      </div>
    </div>
  </div>
</div>

<script>
let curYear=new Date().getFullYear(),curMonth=new Date().getMonth()+1;
let calData={};let holidayMap={};
checkAuth();
async function checkAuth(){const r=await api('/api/auth/me');if(!r.ok||r.role!=='admin'){location.href='/';return;}loadCal();}
async function loadCal(){
  const r=await api(\`/api/admin/attendance/calendar?year=\${curYear}&month=\${curMonth}\`);
  if(!r.ok)return;
  calData={};holidayMap={};
  r.data.days.forEach(d=>calData[d.date]={present:d.present_count,absent:d.absent_count});
  r.data.holidays.forEach(h=>holidayMap[h.date]=h.name);
  renderCal();
}
function changeMonth(d){curMonth+=d;if(curMonth>12){curMonth=1;curYear++;}if(curMonth<1){curMonth=12;curYear--;}loadCal();}
function renderCal(){
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  $('calTitle').textContent=months[curMonth-1]+' '+curYear;
  const first=new Date(curYear,curMonth-1,1).getDay();
  const days=new Date(curYear,curMonth,0).getDate();
  const today=new Date().toISOString().slice(0,10);
  let html='';
  for(let i=0;i<first;i++) html+='<div class="cal-day other-month"></div>';
  for(let d=1;d<=days;d++){
    const date=\`\${curYear}-\${String(curMonth).padStart(2,'0')}-\${String(d).padStart(2,'0')}\`;
    const data=calData[date]||{present:0,absent:0};
    const isHol=holidayMap[date];
    const isTod=date===today;
    let cls='cal-day'+(isHol?' holiday':data.present>0?' present':data.absent>0?' absent':'')+(isTod?' today':'');
    let dot=isHol?'yellow':data.present>0?'green':data.absent>0?'red':'';
    html+=\`<div class="\${cls}" onclick="selectDay('\${date}')">
      <span class="day-num">\${d}</span>
      \${dot?'<span class="day-dot '+dot+'"></span>':''}
      \${data.present>0?'<span style="font-size:.6rem;color:var(--green)">'+data.present+'</span>':''}
    </div>\`;
  }
  $('calGrid').innerHTML=html;
}
async function selectDay(date){
  const r=await api('/api/admin/attendance/day?date='+date);
  const isHol=holidayMap[date];
  let html=\`<div class="flex justify-between items-center mb-3">
    <h3>\${date}\${isHol?' 🟡 '+isHol:''}</h3>
    <div class="flex gap-2">
      \${isHol?'<button class="btn btn-danger btn-sm" onclick="removeHoliday(\''+date+'\')">Remove Holiday</button>':
      '<button class="btn btn-ghost btn-sm" onclick="makeHoliday(\''+date+'\')">Make Holiday</button>'}
    </div>
  </div>\`;
  if(r.ok&&r.data.length){
    html+=\`<table class="tbl"><thead><tr><th>Name</th><th>Time In</th><th>Shift</th><th>Status</th></tr></thead>
    <tbody>\${r.data.map(a=>\`<tr><td>\${a.name}</td><td class="mono text-sm">\${a.time_in}</td><td>\${a.shift_name||'—'}</td>
    <td><span class="badge badge-\${a.status==='present'?'green':'red'}">\${a.status}</span></td></tr>\`).join('')}</tbody></table>\`;
  } else html+='<p class="text-muted text-sm">No attendance records for this date</p>';
  $('dayDetail').innerHTML=html;
}
async function makeHoliday(date){
  const name=prompt('Holiday name:','Holiday');if(name===null)return;
  const r=await api('/api/admin/holidays',{method:'POST',body:{date,name}});
  if(r.ok){toast('Holiday set','ok');loadCal();selectDay(date);}else toast(r.msg,'err');
}
async function removeHoliday(date){
  if(!confirm('Remove holiday?'))return;
  const r=await api('/api/admin/holidays/'+date,{method:'DELETE'});
  if(r.ok){toast('Removed','ok');loadCal();selectDay(date);}else toast(r.msg,'err');
}
</script>
` + htmlFoot());
});

// ════════════════════════════════════════════════════════════
//  ADMIN — SETTINGS PAGE
// ════════════════════════════════════════════════════════════
app.get('/admin/settings', (req,res) => {
  res.send(htmlHead('Settings — FaceAttend') + `
<div class="topbar">
  <div class="topbar-brand">🎯 FaceAttend</div>
  <div class="topbar-nav">
    <a class="nav-link" href="/admin">Dashboard</a>
    <a class="nav-link" href="/admin/scan">Scan</a>
    <a class="nav-link" href="/admin/faces">Faces</a>
    <a class="nav-link" href="/admin/users">Users</a>
    <a class="nav-link" href="/admin/shifts">Shifts</a>
    <a class="nav-link" href="/admin/calendar">Calendar</a>
    <a class="nav-link active" href="/admin/settings">Settings</a>
    <button class="btn btn-ghost btn-sm" onclick="logout()">Sign Out</button>
  </div>
</div>
<div class="page" style="max-width:600px">
  <h1>Organisation Settings</h1>
  <p class="subtitle">Update your organisation profile</p>
  <div id="alert" style="display:none" class="alert"></div>
  <div class="card">
    <div class="form-row">
      <label>Organisation Name *</label>
      <input class="input" id="sName" placeholder="Your name">
    </div>
    <div class="form-row">
      <label>System Title</label>
      <input class="input" id="sTitle" placeholder="e.g. ABC School Attendance">
    </div>
    <div class="form-row">
      <label>Industry Type</label>
      <select class="input" id="sIndustry">
        <option value="school">School / College</option>
        <option value="office">Office / Corporate</option>
        <option value="factory">Factory / Industrial</option>
        <option value="hospital">Hospital / Healthcare</option>
        <option value="other">Other</option>
      </select>
    </div>
    <div class="form-row">
      <label>Organisation Logo</label>
      <div id="logoPreview" style="margin-bottom:8px"></div>
      <input type="file" id="logoFile" accept="image/*" class="input" onchange="previewLogo(this)">
    </div>
    <div class="flex gap-2 mt-3">
      <button class="btn btn-primary" onclick="saveSettings()">Save Settings</button>
    </div>
  </div>

  <div class="card mt-3">
    <h3>🔑 Scan URL for IoT Device</h3>
    <p class="text-sm text-muted mb-2">Use this URL on your face scanner device. Replace <code>YOUR_SERVER_IP</code>.</p>
    <div id="scanUrl" class="mono" style="background:var(--bg);padding:10px;border-radius:6px;font-size:.8rem;word-break:break-all"></div>
  </div>
</div>

<script>
let logoBase64=null;
checkAuth();
async function checkAuth(){
  const r=await api('/api/auth/me');if(!r.ok||r.role!=='admin'){location.href='/';return;}
  const p=await api('/api/admin/profile');
  if(p.ok){const d=p.data;$('sName').value=d.name||'';$('sTitle').value=d.title||'';$('sIndustry').value=d.industry_type||'other';
  if(d.logo_url) $('logoPreview').innerHTML='<img src="'+d.logo_url+'" style="height:60px;border-radius:6px">';}
  const adminId=r.admin_id;
  $('scanUrl').textContent=window.location.origin+'/admin/scan (adminId='+adminId+')';
}
function previewLogo(input){
  const file=input.files[0];if(!file)return;
  const reader=new FileReader();reader.onload=e=>{logoBase64=e.target.result;$('logoPreview').innerHTML='<img src="'+logoBase64+'" style="height:60px;border-radius:6px">';};
  reader.readAsDataURL(file);
}
async function saveSettings(){
  const r=await api('/api/admin/profile',{method:'POST',body:{name:$('sName').value,title:$('sTitle').value,industry_type:$('sIndustry').value,logo_base64:logoBase64}});
  if(r.ok){showAlert('Settings saved!','ok');}else showAlert(r.msg,'err');
}
function showAlert(msg,type){const a=$('alert');a.textContent=msg;a.className='alert alert-'+(type==='ok'?'ok':'err');a.style.display='block';setTimeout(()=>a.style.display='none',3000);}
</script>
` + htmlFoot());
});

// ════════════════════════════════════════════════════════════
//  USER DASHBOARD
// ════════════════════════════════════════════════════════════
app.get('/user', (req,res) => {
  res.send(htmlHead('My Attendance — FaceAttend') + `
<div class="topbar" id="topbar">
  <div class="topbar-brand" id="brandArea">🎯 FaceAttend</div>
  <div class="topbar-nav">
    <a class="nav-link active" href="/user">My Attendance</a>
    <button id="notifyBtn" class="btn btn-ghost btn-sm" onclick="toggleNotify()">🔔 Enable Notifications</button>
    <button class="btn btn-ghost btn-sm" onclick="logout()">Sign Out</button>
  </div>
</div>
<div class="page">
  <div id="profileCard" class="card mb-4" style="display:flex;align-items:center;gap:16px">
    <div style="width:52px;height:52px;border-radius:50%;background:var(--accent2);display:flex;align-items:center;justify-content:center;font-size:1.4rem">👤</div>
    <div><h2 id="userName" style="margin:0">...</h2><p class="text-muted text-sm" id="orgName">...</p></div>
    <div id="notifyStatus" class="badge badge-gray" style="margin-left:auto">Push: Loading...</div>
  </div>

  <div class="card">
    <div class="flex justify-between items-center mb-3">
      <button class="btn btn-ghost btn-sm" onclick="changeMonth(-1)">‹ Prev</button>
      <h3 id="calTitle" style="margin:0"></h3>
      <button class="btn btn-ghost btn-sm" onclick="changeMonth(1)">Next ›</button>
    </div>
    <div class="cal-grid" style="margin-bottom:8px">
      ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<div style="text-align:center;font-size:.7rem;color:var(--text2);font-weight:600;padding:4px">${d}</div>`).join('')}
    </div>
    <div id="calGrid" class="cal-grid"></div>
    <div class="flex gap-4 mt-3 text-xs text-muted flex-wrap">
      <span>🟢 Present</span><span>🔴 Absent</span><span>🟡 Holiday</span>
    </div>
  </div>

  <div class="form-grid fg2 mt-3">
    <div class="stat-card"><div class="stat-val" id="presentCount" style="color:var(--green)">—</div><div class="stat-lbl">Present Days</div></div>
    <div class="stat-card"><div class="stat-val" id="absentCount" style="color:var(--red)">—</div><div class="stat-lbl">Absent Days</div></div>
  </div>

  <div id="dayCard" class="card mt-3" style="display:none">
    <div id="dayDetail"></div>
  </div>
</div>

<script>
let curYear=new Date().getFullYear(),curMonth=new Date().getMonth()+1;
let calDays={},calHols={};

checkAuth();
async function checkAuth(){
  const r=await api('/api/auth/me');
  if(!r.ok||r.role!=='user'){location.href='/';return;}
  const p=await api('/api/user/profile');
  if(p.ok){
    $('userName').textContent=p.data.name;
    $('orgName').textContent=p.data.org_title||'';
    if(p.data.logo_url)$('brandArea').innerHTML='<img src="'+p.data.logo_url+'" style="height:32px;border-radius:4px"> '+p.data.org_title;
    updateNotifyUI(p.data.notify_enabled);
  }
  loadCal();
}

async function loadCal(){
  const r=await api(\`/api/user/attendance/calendar?year=\${curYear}&month=\${curMonth}\`);
  if(!r.ok)return;
  calDays={};calHols={};
  r.data.days.forEach(d=>calDays[d.date]=d);
  r.data.holidays.forEach(h=>calHols[h.date]=h.name);
  let present=0,absent=0;
  Object.values(calDays).forEach(d=>{if(d.status==='present')present++;else absent++;});
  $('presentCount').textContent=present;$('absentCount').textContent=absent;
  renderCal();
}

function changeMonth(d){curMonth+=d;if(curMonth>12){curMonth=1;curYear++;}if(curMonth<1){curMonth=12;curYear--;}loadCal();}

function renderCal(){
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  $('calTitle').textContent=months[curMonth-1]+' '+curYear;
  const first=new Date(curYear,curMonth-1,1).getDay();
  const days=new Date(curYear,curMonth,0).getDate();
  const today=new Date().toISOString().slice(0,10);
  let html='';
  for(let i=0;i<first;i++) html+='<div class="cal-day other-month"></div>';
  for(let d=1;d<=days;d++){
    const date=\`\${curYear}-\${String(curMonth).padStart(2,'0')}-\${String(d).padStart(2,'0')}\`;
    const data=calDays[date];const isHol=calHols[date];const isTod=date===today;
    let cls='cal-day'+(isHol?' holiday':data?(data.status==='present'?' present':' absent'):'')+(isTod?' today':'');
    html+=\`<div class="\${cls}" onclick="selectDay('\${date}')">
      <span class="day-num">\${d}</span>
      \${isHol?'<span class="day-dot yellow"></span>':data?('<span class="day-dot '+(data.status==='present'?'green':'red')+'"></span>'):''}
    </div>\`;
  }
  $('calGrid').innerHTML=html;
}

function selectDay(date){
  const data=calDays[date];const isHol=calHols[date];
  if(!data&&!isHol){$('dayCard').style.display='none';return;}
  $('dayCard').style.display='block';
  $('dayDetail').innerHTML=\`<h3>\${date}</h3>\`+(isHol?'<span class="badge badge-yellow">🟡 '+isHol+'</span><br>':'')+(data?\`
    <div class="flex gap-3 mt-2">
      <div><div class="text-xs text-muted">Status</div><span class="badge badge-\${data.status==='present'?'green':'red'}">\${data.status}</span></div>
      <div><div class="text-xs text-muted">Time In</div><div class="mono">\${data.time_in}</div></div>
      \${data.shift_name?'<div><div class="text-xs text-muted">Shift</div><div>'+data.shift_name+'</div></div>':''}
    </div>\`:'<p class="text-muted text-sm mt-2">No attendance record</p>');
}

function updateNotifyUI(enabled){
  $('notifyStatus').textContent='Push: '+(enabled?'ON':'OFF');
  $('notifyStatus').className='badge '+(enabled?'badge-green':'badge-gray');
  $('notifyBtn').textContent=enabled?'🔕 Disable Notifications':'🔔 Enable Notifications';
}

async function toggleNotify(){
  const current=$('notifyStatus').textContent.includes('ON');
  if(current){
    const r=await api('/api/user/push-unsubscribe',{method:'POST'});
    if(r.ok){updateNotifyUI(false);toast('Notifications disabled','info');}
    return;
  }
  // Request push permission
  if(!('Notification' in window)){toast('Push notifications not supported','err');return;}
  const perm=await Notification.requestPermission();
  if(perm!=='granted'){toast('Permission denied','err');return;}
  // Register service worker (simplified — stores dummy sub, real impl needs VAPID)
  try{
    if('serviceWorker' in navigator){
      const reg=await navigator.serviceWorker.register('/sw.js').catch(()=>null);
      if(reg){
        const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array('BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjZkAccOVS3vSMqhIXozT1iWGtEXE')}).catch(()=>null);
        if(sub){
          const r=await api('/api/user/push-subscribe',{method:'POST',body:{subscription:sub}});
          if(r.ok){updateNotifyUI(true);toast('Push notifications enabled!','ok');return;}
        }
      }
    }
  }catch(e){}
  // Fallback: enable without actual push sub
  const r=await api('/api/user/push-subscribe',{method:'POST',body:{subscription:{type:'basic'}}});
  if(r.ok){updateNotifyUI(true);toast('Notifications enabled (basic)','ok');}
}

function urlBase64ToUint8Array(b64){
  const p=(b64+'='.repeat((4-b64.length%4)%4)).replace(/-/g,'+').replace(/_/g,'/');
  const raw=window.atob(p);const arr=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)arr[i]=raw.charCodeAt(i);return arr;
}
</script>
` + htmlFoot());
});

// Service Worker stub
app.get('/sw.js', (req,res) => {
  res.setHeader('Content-Type','application/javascript');
  res.send(`
self.addEventListener('push',e=>{
  const d=e.data?e.data.json():{title:'FaceAttend',body:'Attendance update'};
  e.waitUntil(self.registration.showNotification(d.title||'FaceAttend',{body:d.body,icon:'/favicon.ico'}));
});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.openWindow('/user'));});
`);
});

// ════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════
async function start() {
  await setupAssets();
  await initDB();
  app.listen(PORT, () => {
    console.log(`\n🚀 FaceAttend SaaS running → http://localhost:${PORT}`);
    console.log(`   Super Admin:  /  → role: super_admin  |  superadmin@faceattend.com / Admin@123`);
    console.log(`   Admin:        /  → role: admin        |  register at /register-admin`);
    console.log(`   User:         /  → role: user         |  created by admin`);
  });
}

start().catch(e => { console.error('❌ Startup error:', e); process.exit(1); });
