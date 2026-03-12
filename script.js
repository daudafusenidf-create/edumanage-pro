/* ════════════════════════════════════════
   EduManage Pro — GES Edition
   Full Application Logic
════════════════════════════════════════ */

// ════════════════════════════════════════
// MULTI-SCHOOL DATABASE ARCHITECTURE
// Each school gets its own isolated localStorage key
// Registry key stores all registered schools
// ════════════════════════════════════════

const REGISTRY_KEY = 'edumanage_schools_registry'; // list of all schools
let _currentSchoolKey = null;  // active school's storage key

// ── SCHOOL REGISTRY ──
function getRegistry() {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch(e) { return []; }
}

function saveRegistry(schools) {
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(schools));
  // Also push registry to Firebase so other devices see it
  if (window._fbReady && _isOnline) {
    const reg = {}; schools.forEach(s => { reg[s.id] = s; });
    window._fb.set('registry', reg).catch(e => console.warn('[FB] registry save failed:', e));
  }
}

function getSchoolKey(schoolId) {
  return `edumanage_school_${schoolId}`;
}

// ══════════════════════════════════════
// FIREBASE LAYER
// ══════════════════════════════════════

// Runtime state
let _isOnline      = navigator.onLine;
let _fbListener     = null;
let _fbSyncPaused   = false;
let _fbDataLoaded   = false; // true only after we've confirmed our data is in sync with Firebase
let _fbKnownSavedAt = 0;    // savedAt timestamp last seen on Firebase — never push older data than this

window.addEventListener('online',  () => { _isOnline = true;  showSyncStatus('online'); });
window.addEventListener('offline', () => { _isOnline = false; showSyncStatus('offline'); });

function fbSchoolPath(schoolId) {
  return 'schools/' + schoolId + '/data';
}

function showSyncStatus(status) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  if (status === 'online')  { el.innerHTML = '<i class="fas fa-circle" style="color:#22c55e;font-size:8px;"></i> Synced'; el.style.color='#22c55e'; }
  if (status === 'offline') { el.innerHTML = '<i class="fas fa-circle" style="color:#f59e0b;font-size:8px;"></i> Offline'; el.style.color='#f59e0b'; }
  if (status === 'saving')  { el.innerHTML = '<i class="fas fa-spinner fa-spin" style="font-size:9px;"></i> Saving…'; el.style.color='var(--text-muted)'; }
}

function startRealtimeSync(schoolId) {
  stopRealtimeSync(); // Always detach any previous listener first
  if (!window._fbReady) return;
  const dbRef = window._fb.ref(fbSchoolPath(schoolId));
  // In Firebase v10 modular SDK, onValue() returns an UNSUBSCRIBE function.
  // We must store and call THAT — not the ref — to properly detach.
  _fbListener = window._fb.onValue(dbRef, (snap) => {
    if (!snap.exists() || !state.currentUser) return;
    const data = snap.val();
    const localJson = localStorage.getItem(getSchoolKey(schoolId));
    const localSavedAt = localJson ? (JSON.parse(localJson).savedAt || 0) : 0;
    const fbSavedAt = data.savedAt || 0;

    // Always mark as loaded when we receive any Firebase data
    if (!_fbDataLoaded) _fbDataLoaded = true;
    // Track highest savedAt seen from Firebase
    if (fbSavedAt > _fbKnownSavedAt) _fbKnownSavedAt = fbSavedAt;

    if (_fbSyncPaused) return; // We just wrote this ourselves — skip echo
    if (fbSavedAt <= localSavedAt) return; // Local is already up to date

    // Firebase has newer data — apply it
    _fbKnownSavedAt = fbSavedAt;
    _applyDataToState(data);
    localStorage.setItem(getSchoolKey(schoolId), JSON.stringify(data));
    refreshAllViews();
    showToast('🔄 Synced from another device');
    showSyncStatus('online');
  }, (err) => { console.warn('[FB] onValue error:', err); showSyncStatus('offline'); });
}

function stopRealtimeSync() {
  if (_fbListener) {
    try {
      // _fbListener is now the unsubscribe function returned by onValue()
      if (typeof _fbListener === 'function') _fbListener();
    } catch(e) { console.warn('[FB] unsubscribe error:', e); }
    _fbListener = null;
  }
}

function refreshAllViews() {
  try {
    renderStudents(); renderFees(); renderTeachers(); renderClasses();
    renderGallery(); renderSavedReports(); renderWeekly();
    renderAttendance(); renderUsers(); updateDashStats(); updateFeeStats();
    if (typeof renderResources==='function') renderResources();
    if (typeof renderExams==='function') renderExams();
    if (typeof renderTransfers==='function') renderTransfers();
    if (typeof renderAnnouncements==='function') renderAnnouncements();
  } catch(e) {}
}

async function loadRegistryFromFirebase() {
  if (!window._fbReady) return;
  try {
    // Get list of deleted/archived school IDs so we never re-add them
    const deletedIds = new Set();
    const archSnap = await window._fb.get('archives');
    if (archSnap.exists()) Object.keys(archSnap.val()).forEach(id => deletedIds.add(id));

    const psnap = await window._fb.get('pending_schools');
    if (psnap.exists()) {
      Object.values(psnap.val())
        .filter(s => s.status === 'deleted' || s.status === 'rejected')
        .forEach(s => deletedIds.add(s.schoolId));
    }

    const merged = [];

    // Firebase registry is the source of truth — only use schools NOT in deletedIds
    const snap = await window._fb.get('registry');
    if (snap.exists()) {
      Object.values(snap.val()).forEach(s => {
        if (!deletedIds.has(s.id)) merged.push(s);
      });
    }

    // Also add approved schools from pending_schools not already in merged
    if (psnap.exists()) {
      Object.values(psnap.val())
        .filter(s => s.status === 'approved' && !deletedIds.has(s.schoolId))
        .forEach(s => {
          if (!merged.find(m => m.id === s.schoolId)) {
            merged.push({ id: s.schoolId, key: getSchoolKey(s.schoolId), name: s.schoolName, createdAt: s.requestedAt });
          }
        });
    }

    // Always overwrite local registry with the clean Firebase version
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(merged));
  } catch(e) { console.warn('[FB] registry load failed:', e); }
}

async function loadSchoolDataFromFirebase(schoolId) {
  if (!window._fbReady) throw new Error('Firebase not ready');
  const snap = await window._fb.get(fbSchoolPath(schoolId));
  if (!snap.exists()) {
    // Firebase has no data yet — this is a brand new school, safe to push local
    _fbDataLoaded = true;
    throw new Error('No data in Firebase');
  }
  const fbData  = snap.val();
  const localJson = localStorage.getItem(getSchoolKey(schoolId));
  const localSavedAt = localJson ? (JSON.parse(localJson).savedAt || 0) : 0;
  const fbSavedAt    = fbData.savedAt || 0;

  if (fbSavedAt >= localSavedAt) {
    // Firebase is newer or equal — use Firebase as source of truth
    localStorage.setItem(getSchoolKey(schoolId), JSON.stringify(fbData));
    loadSchoolData(getSchoolKey(schoolId));
    _fbKnownSavedAt = fbSavedAt;
    _fbDataLoaded = true;
    return fbData;
  } else {
    // Local is newer — keep local, record FB's timestamp, push on next save
    loadSchoolData(getSchoolKey(schoolId));
    _fbKnownSavedAt = fbSavedAt;
    _fbDataLoaded = true;
    return fbData;
  }
}

function _applyDataToState(data) {
  const merge = (key, def) => { if (data[key] !== undefined) state[key] = data[key]; else if (state[key]===undefined) state[key]=def; };
  merge('students',[]); merge('fees',[]); merge('teachers',[]); merge('classes',[]);
  merge('albums',[]); merge('reports',[]); merge('weeklyRecords',[]); merge('attendance',[]);
  merge('settings',{}); merge('users',[]); merge('admissions',[]); merge('expenditures',[]);
  merge('resources',[]); merge('exams',[]); merge('transfers',[]); merge('announcements',[]);
  merge('parentNotifications',[]); merge('backupHistory',[]);
  merge('nextStudentId',1); merge('nextFeeId',1); merge('nextTeacherId',1);
  merge('nextClassId',1); merge('nextUserId',1); merge('nextResourceId',1);
  merge('nextExamId',1); merge('nextAlbumId',1); merge('nextAttendanceId',1);
  merge('nextWeeklyId',1); merge('nextTransferId',1); merge('nextAnnouncementId',1);
  merge('nextPNId',1); merge('nextAdmissionId',1); merge('nextExpenditureId',1);
  if (data.schoolLogo !== undefined) state.schoolLogo = data.schoolLogo;
}

// ══════════════════════════════════════
// SCHOOL VERIFICATION SYSTEM
// Schools register → status "pending" → you approve → they can log in
// Super Admin code (only you know this)
// ══════════════════════════════════════
const SUPER_ADMIN_CODE = 'EDUMANAGE-GH-2024'; // Change this to something private

function changeMasterPin() {
  const input = document.getElementById('masterPinSetting');
  if (!input) return;
  const newPin = input.value.trim();
  if (!newPin || newPin.length < 4) { showToast('⚠️ PIN must be at least 4 characters.'); return; }
  // Store the new PIN in localStorage for this school session
  localStorage.setItem('edumanage_master_pin_override', newPin);
  input.value = '';
  showToast('✅ Master PIN updated successfully.');
}

async function submitSchoolRegistration(name, adminName, adminUser, adminPass, phone, email) {
  const schoolId  = 'school_' + Date.now();
  const schoolKey = getSchoolKey(schoolId);

  const freshData = {
    students:[], fees:[], teachers:[], classes:[
      {id:1,name:'KG1',level:'Kindergarten',teacher:''},{id:2,name:'KG2',level:'Kindergarten',teacher:''},
      {id:3,name:'P1',level:'Primary',teacher:''},{id:4,name:'P2',level:'Primary',teacher:''},
      {id:5,name:'P3',level:'Primary',teacher:''},{id:6,name:'P4',level:'Primary',teacher:''},
      {id:7,name:'P5',level:'Primary',teacher:''},{id:8,name:'P6',level:'Primary',teacher:''},
      {id:9,name:'JHS1',level:'JHS',teacher:''},{id:10,name:'JHS2',level:'JHS',teacher:''},
      {id:11,name:'JHS3',level:'JHS',teacher:''},
    ],
    albums:[], reports:[], weeklyRecords:[], attendance:[],
    backupHistory:[], schoolLogo:null, driveClientId:'',
    settings:{ schoolName:name, term:'First Term',
      session: new Date().getFullYear()+'/'+(new Date().getFullYear()+1),
      address:'', principal:adminName||'Administrator', district:'', motto:'' },
    users:[{ id:1, username:adminUser, password:adminPass, role:'Admin', name:adminName||adminUser, active:false }],
    nextStudentId:1,nextFeeId:1,nextTeacherId:1,nextClassId:12,
    nextAlbumId:1,nextWeeklyId:1,nextAttendanceId:1,nextUserId:2,
    nextResourceId:1,nextExamId:1,nextTransferId:1,nextAnnouncementId:1,
    nextPNId:1,nextAdmissionId:1,nextExpenditureId:1,
  };

  // Save the request to Firebase under 'pending_schools'
  if (window._fbReady && _isOnline) {
    await window._fb.set('pending_schools/' + schoolId, {
      schoolId, schoolName: name, adminName, adminUser,
      contactPhone: phone || '', contactEmail: email || '',
      requestedAt: new Date().toISOString(),
      status: 'pending',
      schoolData: freshData,
    });
    // Store credentials separately for Super Admin reference
    await window._fb.set('school_credentials/' + schoolId, {
      schoolId, schoolName: name, adminName,
      username: adminUser, password: adminPass,
      contactPhone: phone || '',
      registeredAt: new Date().toISOString(),
      status: 'pending'
    }).catch(()=>{});
  } else {
    // Offline: save locally as pending — user will need internet to get approved
    localStorage.setItem('pending_reg_' + schoolId, JSON.stringify({
      schoolId, schoolName: name, adminUser, status: 'pending', schoolData: freshData
    }));
  }
  return schoolId;
}

async function loadPendingSchools() {
  if (!window._fbReady || !_isOnline) return [];
  try {
    const snap = await window._fb.get('pending_schools');
    if (!snap.exists()) return [];
    return Object.values(snap.val()).filter(s => s.status === 'pending');
  } catch(e) { return []; }
}

async function approveSchool(schoolId) {
  if (!window._fbReady || !_isOnline) { showToast('⚠️ Internet required.'); return; }
  try {
    // Get the pending record
    const snap = await window._fb.get('pending_schools/' + schoolId);
    if (!snap.exists()) { showToast('⚠️ School not found.'); return; }
    const pending = snap.val();
    const data = { ...pending.schoolData, savedAt: Date.now() };

    // Activate the admin user
    data.users = data.users.map(u => ({ ...u, active: true }));

    // Write to live schools path
    await window._fb.set(fbSchoolPath(schoolId), data);

    // Add to registry
    const reg = getRegistry();
    if (!reg.find(s => s.id === schoolId)) {
      reg.push({ id: schoolId, key: getSchoolKey(schoolId), name: pending.schoolName, createdAt: pending.requestedAt });
      saveRegistry(reg);
    }

    // Mark as approved in pending_schools
    await window._fb.update('pending_schools/' + schoolId, { status: 'approved', approvedAt: new Date().toISOString() });
    // Update credential status
    await window._fb.update('school_credentials/' + schoolId, { status: 'approved', approvedAt: new Date().toISOString() }).catch(()=>{});

    showToast(`✅ "${pending.schoolName}" approved! They can now log in.`);
    renderPendingSchoolsList();
    renderSchoolList(); // refresh school selector immediately
  } catch(e) { showToast('❌ Approval failed. Try again.'); console.error(e); }
}

async function rejectSchool(schoolId) {
  if (!window._fbReady || !_isOnline) { showToast('⚠️ Internet required.'); return; }
  try {
    const snap = await window._fb.get('pending_schools/' + schoolId);
    if (!snap.exists()) return;
    const pending = snap.val();
    await window._fb.update('pending_schools/' + schoolId, { status: 'rejected', rejectedAt: new Date().toISOString() });
    showToast(`🗑️ "${pending.schoolName}" registration rejected.`);
    renderPendingSchoolsList();
  } catch(e) { showToast('❌ Failed. Try again.'); }
}

async function renderPendingSchoolsList() {
  const listEl = document.getElementById('pendingSchoolsList');
  if (!listEl) return;
  listEl.innerHTML = '<p style="text-align:center;padding:20px;"><i class="fas fa-spinner fa-spin"></i> Loading…</p>';

  // Load ALL registrations (pending + approved history), not just pending
  let allRegs = [];
  if (window._fbReady && _isOnline) {
    try {
      const snap = await window._fb.get('pending_schools');
      if (snap.exists()) allRegs = Object.values(snap.val()).filter(s => s.status !== 'deleted');
    } catch(e) {}
  }

  const pending  = allRegs.filter(s => s.status === 'pending');
  const approved = allRegs.filter(s => s.status === 'approved');
  const rejected = allRegs.filter(s => s.status === 'rejected');

  if (!allRegs.length) {
    listEl.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;"><i class="fas fa-info-circle"></i> No registrations yet.</p>';
    return;
  }
  // Get passwords from school_credentials
  let credsMap = {};
  try {
    const csnap = await window._fb.get('school_credentials');
    if (csnap.exists()) { Object.values(csnap.val()).forEach(c => { credsMap[c.schoolId] = c; }); }
  } catch(e) {}

  function schoolCard(s, actions) {
    const cred = credsMap[s.schoolId] || {};
    return `
    <div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px;">
      <div style="display:flex;align-items:flex-start;gap:12px;">
        <div style="font-size:28px;">🏫</div>
        <div style="flex:1;">
          <div style="font-weight:700;font-size:15px;">${escHtml(s.schoolName)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">
            Admin: <strong>${escHtml(s.adminName||s.adminUser||'—')}</strong>
          </div>
          ${s.contactPhone ? `<div style="font-size:12px;color:var(--text-muted);">📞 ${escHtml(s.contactPhone)}</div>` : ''}
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Submitted: ${new Date(s.requestedAt).toLocaleString('en-GH')}</div>
          <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:9px 12px;margin-top:10px;font-size:13px;">
            <div><i class="fas fa-user" style="color:#16a34a;width:16px;"></i> <strong>Username:</strong> <code style="background:#dcfce7;padding:2px 8px;border-radius:5px;">${escHtml(cred.username||s.adminUser||'—')}</code></div>
            <div style="margin-top:5px;"><i class="fas fa-lock" style="color:#16a34a;width:16px;"></i> <strong>Password:</strong> <code style="background:#dcfce7;padding:2px 8px;border-radius:5px;">${escHtml(cred.password||'—')}</code></div>
          </div>
        </div>
      </div>
      ${actions}
    </div>`;
  }

  let html = '';

  // Pending registrations
  if (pending.length) {
    html += `<div style="font-size:11px;font-weight:800;color:#d97706;letter-spacing:.5px;margin:4px 0 10px;">⏳ AWAITING APPROVAL (${pending.length})</div>`;
    html += pending.map(s => schoolCard(s, `
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="btn-primary" style="flex:1;font-size:13px;padding:8px;" onclick="approveSchool('${s.schoolId}')"><i class="fas fa-check"></i> Approve</button>
        <button class="btn-ghost" style="flex:1;font-size:13px;padding:8px;color:var(--red);border-color:var(--red);" onclick="rejectSchool('${s.schoolId}')"><i class="fas fa-times"></i> Reject</button>
      </div>`)).join('');
  } else {
    html += `<p style="text-align:center;color:var(--text-muted);padding:10px 0 4px;font-size:13px;"><i class="fas fa-check-circle" style="color:#22c55e;"></i> No pending registrations.</p>`;
  }

  // Approved registrations history
  if (approved.length) {
    html += `<div style="font-size:11px;font-weight:800;color:#16a34a;letter-spacing:.5px;margin:18px 0 10px;">✅ APPROVED (${approved.length})</div>`;
    html += approved.map(s => schoolCard(s, `
      <div style="margin-top:8px;font-size:12px;color:#16a34a;font-weight:600;"><i class="fas fa-check-circle"></i> Approved ${s.approvedAt ? new Date(s.approvedAt).toLocaleDateString('en-GH') : ''}</div>`)).join('');
  }

  // Rejected
  if (rejected.length) {
    html += `<div style="font-size:11px;font-weight:800;color:var(--red);letter-spacing:.5px;margin:18px 0 10px;">❌ REJECTED (${rejected.length})</div>`;
    html += rejected.map(s => schoolCard(s, `
      <div style="margin-top:8px;font-size:12px;color:var(--red);font-weight:600;"><i class="fas fa-times-circle"></i> Rejected</div>`)).join('');
  }

  listEl.innerHTML = html;
}

async function saRegisterSchool() {
  const name      = document.getElementById('saNewSchoolName').value.trim();
  const adminName = document.getElementById('saNewSchoolAdmin').value.trim();
  const adminUser = document.getElementById('saNewSchoolUsername').value.trim().toLowerCase();
  const adminPass = document.getElementById('saNewSchoolPassword').value.trim();
  const phone     = document.getElementById('saNewSchoolPhone')?.value.trim() || '';
  const errEl     = document.getElementById('saRegisterFormError');
  const successEl = document.getElementById('saRegisterSuccess');
  const btn       = document.getElementById('saRegisterBtn');

  errEl.style.display = 'none';
  successEl.style.display = 'none';

  if (!name || !adminUser || !adminPass) {
    errEl.textContent = 'Please fill in School Name, Admin Username and Password.';
    errEl.style.display = 'block'; return;
  }
  if (adminPass.length < 6) {
    errEl.textContent = 'Password must be at least 6 characters.';
    errEl.style.display = 'block'; return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Registering…';

  try {
    const schoolId  = 'school_' + Date.now();
    const schoolKey = getSchoolKey(schoolId);

    const freshData = {
      students:[], fees:[], teachers:[], classes:[
        {id:1,name:'KG1',level:'Kindergarten',teacher:''},{id:2,name:'KG2',level:'Kindergarten',teacher:''},
        {id:3,name:'BS.1',level:'Basic',teacher:''},{id:4,name:'BS.2',level:'Basic',teacher:''},
        {id:5,name:'BS.3',level:'Basic',teacher:''},{id:6,name:'BS.4',level:'Basic',teacher:''},
        {id:7,name:'BS.5',level:'Basic',teacher:''},{id:8,name:'BS.7',level:'Basic',teacher:''},
        {id:9,name:'BS.8',level:'Basic',teacher:''},{id:10,name:'BS.9',level:'Basic',teacher:''},
      ],
      albums:[], reports:[], weeklyRecords:[], attendance:[],
      backupHistory:[], schoolLogo:null, driveClientId:'',
      settings:{ schoolName:name, term:'First Term',
        session: new Date().getFullYear()+'/'+(new Date().getFullYear()+1),
        address:'', principal:adminName||'Administrator', district:'', motto:'' },
      users:[{ id:1, username:adminUser, password:adminPass, role:'Admin', name:adminName||adminUser, active:true }],
      nextStudentId:1,nextFeeId:1,nextTeacherId:1,nextClassId:11,
      nextAlbumId:1,nextWeeklyId:1,nextAttendanceId:1,nextUserId:2,
      nextResourceId:1,nextExamId:1,nextTransferId:1,nextAnnouncementId:1,
      nextPNId:1,nextAdmissionId:1,nextExpenditureId:1,
      savedAt: Date.now()
    };

    if (window._fbReady && _isOnline) {
      // Write school data directly to live path (already approved)
      await window._fb.set(fbSchoolPath(schoolId), freshData);

      // Store in pending_schools as 'approved' (for registration history)
      await window._fb.set('pending_schools/' + schoolId, {
        schoolId, schoolName: name, adminName, adminUser,
        contactPhone: phone, requestedAt: new Date().toISOString(),
        status: 'approved', approvedAt: new Date().toISOString(),
        schoolData: freshData
      });

      // Store credentials
      await window._fb.set('school_credentials/' + schoolId, {
        schoolId, schoolName: name, adminName,
        username: adminUser, password: adminPass,
        contactPhone: phone,
        registeredAt: new Date().toISOString(),
        status: 'approved'
      });
    }

    // Add to local registry
    const reg = getRegistry();
    reg.push({ id: schoolId, key: schoolKey, name, createdAt: new Date().toISOString() });
    saveRegistry(reg);
    localStorage.setItem(schoolKey, JSON.stringify(freshData));

    // Show success
    document.getElementById('saRegisterSuccessMsg').textContent = `"${name}" registered successfully!`;
    successEl.style.display = 'block';

    // Clear form
    ['saNewSchoolName','saNewSchoolAdmin','saNewSchoolUsername','saNewSchoolPassword','saNewSchoolPhone']
      .forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });

    renderSchoolList();
    showToast(`✅ "${name}" is now active!`);
  } catch(e) {
    errEl.textContent = 'Failed to register. Check internet and try again.';
    errEl.style.display = 'block';
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-plus-circle"></i> Register & Activate School';
  }
}

function openSuperAdminPanel() {
  const code = document.getElementById('superAdminCode')?.value?.trim();
  if (code !== SUPER_ADMIN_CODE) {
    document.getElementById('superAdminCodeError').style.display = 'block';
    return;
  }
  document.getElementById('superAdminCodeRow').style.display = 'none';
  document.getElementById('superAdminCodeError').style.display = 'none';
  document.getElementById('superAdminPanelBody').style.display = 'block';
  switchSATab('addSchool');
}

function switchSATab(tab) {
  const tabIds  = { addSchool:'saTabAddSchool', registrations:'saTabRegistrations', recovery:'saTabRecovery', deleteReq:'saTabDeleteReq', credentials:'saTabCredentials' };
  const bodyIds = { addSchool:'saBodyAddSchool', registrations:'saBodyRegistrations', recovery:'saBodyRecovery', deleteReq:'saBodyDeleteReq', credentials:'saBodyCredentials' };
  Object.keys(tabIds).forEach(t => {
    const tEl = document.getElementById(tabIds[t]);
    const bEl = document.getElementById(bodyIds[t]);
    if (tEl) tEl.classList.toggle('active', t===tab);
    if (bEl) bEl.style.display = t===tab ? '' : 'none';
  });
  if (tab === 'recovery')    renderRecoveryRequests();
  if (tab === 'deleteReq')   renderDeleteRequests();
  if (tab === 'credentials') renderAllSchoolCredentials();
  if (tab === 'registrations') renderPendingSchoolsList();
}

async function renderAllSchoolCredentials() {
  const el = document.getElementById('credentialsList');
  if (!el) return;
  el.innerHTML = '<p style="text-align:center;padding:20px;"><i class="fas fa-spinner fa-spin"></i> Loading…</p>';
  if (!window._fbReady || !_isOnline) { el.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;">Internet required.</p>'; return; }
  try {
    const snap = await window._fb.get('school_credentials');
    if (!snap.exists()) { el.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;"><i class="fas fa-info-circle"></i> No schools have registered yet.</p>'; return; }

    // Only show active (approved) and restorable (deleted = in archive) schools
    // Get archive IDs to know which deleted ones can still be restored
    const archSnap = await window._fb.get('archives');
    const archivableIds = new Set(archSnap.exists() ? Object.keys(archSnap.val()) : []);

    const all = Object.values(snap.val())
      .filter(c => c.status === 'approved' || (c.status === 'deleted' && archivableIds.has(c.schoolId)))
      .sort((a,b) => new Date(b.registeredAt) - new Date(a.registeredAt));

    if (!all.length) { el.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;"><i class="fas fa-info-circle"></i> No active or restorable schools.</p>'; return; }

    el.innerHTML = all.map(c => {
      const isArchived = c.status === 'deleted';
      const statusColor  = isArchived ? '#d97706' : '#16a34a';
      const statusBg     = isArchived ? '#fffbeb' : '#f0fdf4';
      const statusBorder = isArchived ? '#fcd34d' : '#86efac';
      const statusLabel  = isArchived ? '🗂️ Archived (Restorable)' : '✅ Active';
      const credBg       = isArchived ? '#fffbeb' : '#f0fdf4';
      const credBorder   = isArchived ? '#fcd34d' : '#86efac';
      const credColor    = isArchived ? '#92400e' : '#15803d';
      const codeBg       = isArchived ? '#fef3c7' : '#dcfce7';
      return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
          <div style="font-size:24px;">${isArchived ? '🗂️' : '🏫'}</div>
          <div style="flex:1;">
            <div style="font-weight:700;font-size:15px;">${escHtml(c.schoolName)}</div>
            <div style="font-size:12px;color:var(--text-muted);">Admin: ${escHtml(c.adminName||'—')}${c.contactPhone ? ' · 📞 '+escHtml(c.contactPhone) : ''}</div>
            <div style="font-size:11px;color:var(--text-muted);">Registered: ${new Date(c.registeredAt).toLocaleString('en-GH')}</div>
          </div>
          <span style="background:${statusBg};border:1px solid ${statusBorder};color:${statusColor};padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;">${statusLabel}</span>
        </div>
        <div style="background:${credBg};border:1px solid ${credBorder};border-radius:8px;padding:10px 14px;display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div>
            <div style="font-size:11px;color:var(--text-muted);font-weight:700;margin-bottom:3px;"><i class="fas fa-user" style="color:${credColor};"></i> USERNAME</div>
            <code style="font-size:14px;font-weight:700;color:${credColor};background:${codeBg};padding:3px 10px;border-radius:6px;display:inline-block;">${escHtml(c.username)}</code>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-muted);font-weight:700;margin-bottom:3px;"><i class="fas fa-lock" style="color:${credColor};"></i> PASSWORD</div>
            <code style="font-size:14px;font-weight:700;color:${credColor};background:${codeBg};padding:3px 10px;border-radius:6px;display:inline-block;">${escHtml(c.password)}</code>
          </div>
        </div>
      </div>`;
    }).join('');
  } catch(e) { el.innerHTML = '<p style="color:var(--red);text-align:center;padding:20px;">Failed to load. Check connection.</p>'; }
}

// ── RECOVERY REQUESTS ──
async function submitRecoveryRequest() {
  const schoolName = document.getElementById('recSchoolName').value.trim();
  const adminName  = document.getElementById('recAdminName').value.trim();
  const phone      = document.getElementById('recPhone').value.trim();
  const type       = document.getElementById('recType').value;
  const errEl      = document.getElementById('recoveryFormError');
  errEl.style.display = 'none';
  if (!schoolName || !adminName || !phone) {
    errEl.textContent = 'Please fill in all required fields.';
    errEl.style.display = 'block';
    return;
  }
  const reqId = 'rec_' + Date.now();
  const payload = { reqId, schoolName, adminName, phone, type, requestedAt: new Date().toISOString(), status: 'pending' };
  if (window._fbReady && _isOnline) {
    await window._fb.set('recovery_requests/' + reqId, payload).catch(()=>{});
  } else {
    try { localStorage.setItem('offline_rec_' + reqId, JSON.stringify(payload)); } catch(e){}
  }
  document.getElementById('recoveryRequestModal').classList.remove('open');
  ['recSchoolName','recAdminName','recPhone'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('recoverySuccessModal').classList.add('open');
}

async function renderRecoveryRequests() {
  const el = document.getElementById('recoveryRequestsList');
  if (!el) return;
  el.innerHTML = '<p style="text-align:center;padding:20px;"><i class="fas fa-spinner fa-spin"></i> Loading…</p>';
  if (!window._fbReady || !_isOnline) { el.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;">Internet required.</p>'; return; }
  try {
    const snap = await window._fb.get('recovery_requests');
    if (!snap.exists()) { el.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;"><i class="fas fa-check-circle" style="color:#22c55e;"></i> No recovery requests.</p>'; return; }
    const all = Object.values(snap.val()).filter(r => r.status === 'pending');
    if (!all.length) { el.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;"><i class="fas fa-check-circle" style="color:#22c55e;"></i> No pending recovery requests.</p>'; return; }
    el.innerHTML = all.map(r => {
      const typeLabel = r.type === 'username' ? 'Username' : r.type === 'password' ? 'Password' : 'Username & Password';
      // Find the matching school in registry to show actual credentials
      const reg = getRegistry();
      const school = reg.find(s => s.name.toLowerCase() === r.schoolName.toLowerCase());
      let credHtml = '';
      if (school) {
        const schoolData = (() => { try { return JSON.parse(localStorage.getItem(getSchoolKey(school.id)) || '{}'); } catch(e){ return {}; } })();
        const adminUser = (schoolData.users || []).find(u => u.role === 'Admin');
        if (adminUser) {
          credHtml = `<div style="background:var(--blue-light);border-radius:8px;padding:10px 12px;margin-top:10px;font-size:13px;">
            <div><i class="fas fa-user" style="color:var(--blue);"></i> Username: <strong>${escHtml(adminUser.username)}</strong></div>
            <div style="margin-top:4px;"><i class="fas fa-lock" style="color:var(--blue);"></i> Password: <strong>${escHtml(adminUser.password)}</strong></div>
          </div>`;
        }
      }
      return `<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px;">
        <div style="display:flex;align-items:flex-start;gap:10px;">
          <div style="font-size:26px;">🔑</div>
          <div style="flex:1;">
            <div style="font-weight:700;">${escHtml(r.schoolName)}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">Admin: <strong>${escHtml(r.adminName)}</strong> · 📞 ${escHtml(r.phone)}</div>
            <div style="font-size:12px;color:var(--text-muted);">Request: <span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:12px;font-weight:700;">${typeLabel}</span></div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Submitted: ${new Date(r.requestedAt).toLocaleString('en-GH')}</div>
            ${credHtml}
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <button class="btn-primary" style="flex:1;font-size:13px;padding:8px;" onclick="resolveRecovery('${r.reqId}')">
            <i class="fas fa-check"></i> Mark as Resolved
          </button>
          <button class="btn-ghost" style="flex:1;font-size:13px;padding:8px;" onclick="dismissRecovery('${r.reqId}')">
            <i class="fas fa-times"></i> Dismiss
          </button>
        </div>
      </div>`;
    }).join('');
  } catch(e) { el.innerHTML = '<p style="color:var(--red);text-align:center;padding:20px;">Failed to load. Check connection.</p>'; }
}

async function resolveRecovery(reqId) {
  if (!window._fbReady || !_isOnline) return;
  await window._fb.update('recovery_requests/' + reqId, { status: 'resolved', resolvedAt: new Date().toISOString() }).catch(()=>{});
  showToast('✅ Recovery request marked as resolved.');
  renderRecoveryRequests();
}

async function dismissRecovery(reqId) {
  if (!window._fbReady || !_isOnline) return;
  await window._fb.update('recovery_requests/' + reqId, { status: 'dismissed' }).catch(()=>{});
  showToast('🗑️ Request dismissed.');
  renderRecoveryRequests();
}

// ── DELETE REQUESTS (for tracking) ──
async function renderDeleteRequests() {
  const el = document.getElementById('deleteRequestsList');
  if (!el) return;
  el.innerHTML = '<p style="text-align:center;padding:20px;"><i class="fas fa-spinner fa-spin"></i> Loading…</p>';
  if (!window._fbReady || !_isOnline) { el.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;">Internet required.</p>'; return; }
  try {
    const snap = await window._fb.get('archives');
    if (!snap.exists()) { el.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;"><i class="fas fa-check-circle" style="color:#22c55e;"></i> No deleted schools in archive.</p>'; return; }
    const now = Date.now();
    const items = Object.values(snap.val()).filter(a => new Date(a.expiresAt).getTime() > now);
    if (!items.length) { el.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;">No recent deletions found.</p>'; return; }
    el.innerHTML = items.map(a => {
      const days = Math.ceil((new Date(a.expiresAt).getTime()-now)/86400000);
      return `<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px;display:flex;align-items:center;gap:12px;">
        <div style="font-size:28px;">🗑️</div>
        <div style="flex:1;">
          <div style="font-weight:700;">${escHtml(a.schoolName)}</div>
          <div style="font-size:12px;color:var(--text-muted);">Deleted ${new Date(a.deletedAt).toLocaleDateString('en-GH')} · <span style="color:var(--red);font-weight:600;">${days} days until permanent deletion</span></div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn-primary" style="font-size:12px;padding:6px 14px;" onclick="restoreSchool('${a.schoolId}')"><i class="fas fa-trash-restore"></i> Restore</button>
          <button class="btn-ghost" style="font-size:12px;padding:6px 14px;color:var(--red);border-color:var(--red);" onclick="permanentDeleteSchool('${a.schoolId}','${escHtml(a.schoolName)}')"><i class="fas fa-trash"></i> Delete Now</button>
        </div>
      </div>`;
    }).join('');
  } catch(e) { el.innerHTML = '<p style="color:var(--red);text-align:center;padding:20px;">Failed to load.</p>'; }
}

// Save current school data to its own key
function saveToDB() {
  if (!_currentSchoolKey) return;
  try {
    const savedAt = Date.now();
    const data = {
      students: state.students,
      fees: state.fees,
      teachers: state.teachers,
      classes: state.classes,
      albums: state.albums.map(a=>({...a, photos:(a.photos||[]).map(p=>({name:p.name,src:p.src&&p.src.length>500000?'[photo-omitted]':p.src}))})),
      reports: state.reports,
      weeklyRecords: state.weeklyRecords,
      attendance: state.attendance,
      settings: state.settings,
      schoolLogo: state.schoolLogo,
      driveClientId: state.driveClientId,
      backupHistory: state.backupHistory,
      users: state.users,
      admissions: state.admissions,
      nextAdmissionId: state.nextAdmissionId,
      nextStudentId: state.nextStudentId,
      nextFeeId: state.nextFeeId,
      nextTeacherId: state.nextTeacherId,
      nextClassId: state.nextClassId,
      nextAlbumId: state.nextAlbumId,
      nextWeeklyId: state.nextWeeklyId,
      nextAttendanceId: state.nextAttendanceId,
      nextUserId: state.nextUserId,
      expenditures: state.expenditures,
      nextExpenditureId: state.nextExpenditureId,
      resources: state.resources,
      nextResourceId: state.nextResourceId,
      exams: state.exams,
      nextExamId: state.nextExamId,
      transfers: state.transfers,
      nextTransferId: state.nextTransferId,
      announcements: state.announcements,
      nextAnnouncementId: state.nextAnnouncementId,
      parentNotifications: state.parentNotifications,
      nextPNId: state.nextPNId,
      appTheme: state.appTheme,
      sidebarStyle: state.sidebarStyle,
      fontSize: state.fontSize,
      savedAt,
    };

    // 1. Always save locally first
    localStorage.setItem(_currentSchoolKey, JSON.stringify(data));

    // 2. Push to Firebase — strict safety checks to prevent overwriting other devices
    //    - _fbDataLoaded: we must have synced from Firebase at least once this session
    //    - savedAt > _fbKnownSavedAt: our data must be NEWER than what Firebase last had
    //      (if equal or older, we have nothing new to push — don't overwrite)
    if (window._fbReady && _isOnline && _fbDataLoaded && savedAt > _fbKnownSavedAt) {
      const schoolId = _currentSchoolKey.replace('edumanage_school_', '');
      showSyncStatus('saving');
      _fbSyncPaused = true; // Block our own onValue echo while we write
      _fbKnownSavedAt = savedAt; // Update our known timestamp immediately
      window._fb.set(fbSchoolPath(schoolId), data)
        .then(() => {
          showSyncStatus('online');
          setTimeout(() => { _fbSyncPaused = false; }, 2000);
        })
        .catch(e => {
          console.warn('[FB] Save to Firebase failed:', e);
          _fbSyncPaused = false;
          _fbKnownSavedAt = savedAt - 1; // Roll back so next save retries
          showSyncStatus('offline');
          showToast('⚠️ Cloud save failed — data saved locally only.');
        });
    }

    // 3. Keep registry entry's displayName in sync
    const reg = getRegistry();
    const entry = reg.find(s => s.key === _currentSchoolKey);
    if (entry) { entry.name = state.settings.schoolName; saveRegistry(reg); }
  } catch(e) { console.warn('Save failed:', e); }
}

// Load a school's data into state
function loadSchoolData(schoolKey) {
  try {
    const raw = localStorage.getItem(schoolKey);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (data.students)      state.students      = data.students;
    if (data.fees)          state.fees          = data.fees;
    if (data.teachers)      state.teachers      = data.teachers;
    if (data.classes)       state.classes       = data.classes;
    if (data.albums)        state.albums        = data.albums;
    if (data.reports)       state.reports       = data.reports;
    if (data.weeklyRecords) state.weeklyRecords = data.weeklyRecords;
    if (data.attendance)    state.attendance    = data.attendance;
    if (data.settings)      Object.assign(state.settings, data.settings);
    if (data.schoolLogo)    state.schoolLogo    = data.schoolLogo;
    if (data.driveClientId) state.driveClientId = data.driveClientId;
    if (data.backupHistory) state.backupHistory = data.backupHistory;
    if (data.users)         state.users         = data.users;
    if (data.expenditures)  state.expenditures  = data.expenditures;
    if (data.resources)     state.resources     = data.resources;
    if (data.nextResourceId) state.nextResourceId = data.nextResourceId;
    if (data.exams)              state.exams              = data.exams;
    if (data.nextExamId)         state.nextExamId         = data.nextExamId;
    if (data.transfers)          state.transfers          = data.transfers;
    if (data.nextTransferId)     state.nextTransferId     = data.nextTransferId;
    if (data.announcements)      state.announcements      = data.announcements;
    if (data.nextAnnouncementId) state.nextAnnouncementId = data.nextAnnouncementId;
    if (data.parentNotifications) state.parentNotifications = data.parentNotifications;
    if (data.nextPNId)           state.nextPNId           = data.nextPNId;
    if (data.appTheme)      state.appTheme      = data.appTheme;
    if (data.sidebarStyle)  state.sidebarStyle  = data.sidebarStyle;
    if (data.fontSize)      state.fontSize      = data.fontSize;
    if (data.admissions)  state.admissions  = data.admissions;
    if (data.nextAdmissionId) state.nextAdmissionId = data.nextAdmissionId;
    if (data.nextStudentId)    state.nextStudentId    = data.nextStudentId;
    if (data.nextFeeId)        state.nextFeeId        = data.nextFeeId;
    if (data.nextTeacherId)    state.nextTeacherId    = data.nextTeacherId;
    if (data.nextClassId)      state.nextClassId      = data.nextClassId;
    if (data.nextAlbumId)      state.nextAlbumId      = data.nextAlbumId;
    if (data.nextWeeklyId)     state.nextWeeklyId     = data.nextWeeklyId;
    if (data.nextAttendanceId) state.nextAttendanceId = data.nextAttendanceId;
    if (data.nextUserId)       state.nextUserId       = data.nextUserId;
    if (data.nextExpenditureId) state.nextExpenditureId = data.nextExpenditureId;
    return true;
  } catch(e) { console.warn('Load failed:', e); return false; }
}

// Legacy single-school migration
function migrateLegacyData() {
  const legacyKey = 'edumanage_pro_data';
  const legacyRaw = localStorage.getItem(legacyKey);
  if (!legacyRaw) return;
  const reg = getRegistry();
  if (reg.length > 0) return; // already migrated
  try {
    const data = JSON.parse(legacyRaw);
    const schoolId = 'school_legacy_' + Date.now();
    const schoolKey = getSchoolKey(schoolId);
    localStorage.setItem(schoolKey, legacyRaw);
    reg.push({ id: schoolId, key: schoolKey, name: (data.settings && data.settings.schoolName) || 'My School', createdAt: new Date().toISOString() });
    saveRegistry(reg);
    localStorage.removeItem(legacyKey);
    console.log('Migrated legacy school data');
  } catch(e) {}
}

// ── UNSAVED CHANGES TRACKING ──
let _unsavedChanges = false;
let _saveTimer = null;

function markUnsaved() {
  _unsavedChanges = true;
  const ind = document.getElementById('autosaveIndicator');
  if (ind) { ind.textContent = '⏳ Saving…'; ind.style.opacity='1'; ind.style.color='var(--yellow)'; }
  const banner = document.getElementById('unsavedBanner');
  if (banner) banner.style.display = 'block';
}

function markSaved() {
  _unsavedChanges = false;
  const ind = document.getElementById('autosaveIndicator');
  if (ind) { ind.textContent = '✅ All saved'; ind.style.opacity='1'; ind.style.color='var(--green)'; setTimeout(()=>{ind.style.opacity='0';},3000); }
  const banner = document.getElementById('unsavedBanner');
  if (banner) banner.style.display = 'none';
}

function autosave() {
  markUnsaved();
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    saveToDB();
    markSaved();
  }, 1200);
}

// Immediate save (used on logout, visibility change, beforeunload)
function saveNow() {
  clearTimeout(_saveTimer);
  saveToDB();
  markSaved();
}

// ── PAGE LEAVE PROTECTION ──
function initPageLeaveProtection() {
  // Warn on refresh / close — always try to save first
  window.addEventListener('beforeunload', (e) => {
    if (_currentSchoolKey) saveNow(); // always attempt to save
    if (_unsavedChanges) {
      const msg = 'EduManage Pro: You have unsaved changes. Are you sure you want to leave?';
      e.preventDefault();
      e.returnValue = msg;
      return msg;
    }
  });

  // Also intercept browser back button
  window.history.pushState(null, '', window.location.href);
  window.addEventListener('popstate', () => {
    if (_unsavedChanges) {
      if (confirm('You have unsaved changes. Leave anyway?')) { saveNow(); }
      else { window.history.pushState(null, '', window.location.href); }
    }
  });

  // Save immediately when tab becomes hidden (phone lock, tab switch)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && _currentSchoolKey) {
      saveNow();
    }
  });

  // Save on window focus loss
  window.addEventListener('blur', () => {
    if (_currentSchoolKey) saveNow();
  });

  // Auto-save + auto-backup every 30 seconds
  setInterval(() => {
    if (!_currentSchoolKey) return;
    saveToDB();
    // Update backup indicator
    const ts = new Date().toLocaleTimeString('en-GH', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const ind = document.getElementById('autoBackupIndicator');
    if (ind) { ind.textContent = '🔄 Auto-saved ' + ts; ind.style.opacity = '1'; setTimeout(()=>{ ind.style.opacity = '0'; }, 4000); }
    // Refresh dashboard if it's the active section
    const dashActive = document.getElementById('sec-dashboard') && document.getElementById('sec-dashboard').classList.contains('active');
    if (dashActive) updateDashStats();
  }, 30000);
}

// ── STATE ──
const state = {
  students: [
    { id:1, first:'Kofi', last:'Mensah', cls:'BS.5', gender:'Male', feeStatus:'Paid', phone:'0244123456', photo:null },
    { id:2, first:'Ama', last:'Owusu', cls:'BS.4', gender:'Female', feeStatus:'Partial', phone:'0201234567', photo:null },
    { id:3, first:'Kwame', last:'Asante', cls:'BS.7', gender:'Male', feeStatus:'Unpaid', phone:'0552345678', photo:null },
    { id:4, first:'Abena', last:'Boateng', cls:'BS.3', gender:'Female', feeStatus:'Paid', phone:'0271234567', photo:null },
    { id:5, first:'Yaw', last:'Darko', cls:'BS.7', gender:'Male', feeStatus:'Paid', phone:'0241234567', photo:null },
    { id:6, first:'Akua', last:'Frimpong', cls:'BS.5', gender:'Female', feeStatus:'Partial', phone:'0231234567', photo:null },
  ],
  fees: [
    { id:1, student:'Kofi Mensah', cls:'BS.5', due:300, paid:300 },
    { id:2, student:'Ama Owusu', cls:'BS.4', due:300, paid:150 },
    { id:3, student:'Kwame Asante', cls:'BS.7', due:450, paid:0 },
    { id:4, student:'Abena Boateng', cls:'BS.3', due:300, paid:300 },
    { id:5, student:'Yaw Darko', cls:'BS.7', due:450, paid:450 },
    { id:6, student:'Akua Frimpong', cls:'BS.5', due:350, paid:200 },
  ],
  teachers: [
    { id:1, first:'Mrs. Abena', last:'Asante', subject:'Mathematics, Science', assigned:'P5, P6', qualification:'B.Ed', phone:'0244000001' },
    { id:2, first:'Mr. Kweku', last:'Darko', subject:'English Language', assigned:'JHS1, JHS2', qualification:'PGDE', phone:'0244000002' },
    { id:3, first:'Ms. Efua', last:'Mensah', subject:'Social Studies, RME', assigned:'P3, P4', qualification:'Diploma in Education', phone:'0244000003' },
    { id:4, first:'Mr. Kofi', last:'Boateng', subject:'ICT, Mathematics', assigned:'JHS3', qualification:'B.Ed', phone:'0244000004' },
  ],
  classes: [
    { id:1, name:'Creche', level:'Creche', teacher:'Mrs. Gifty Adu' },
    { id:2, name:'Nursery 1', level:'Nursery', teacher:'Mrs. Stella Osei' },
    { id:3, name:'Nursery 2', level:'Nursery', teacher:'Mr. Isaac Yeboah' },
    { id:4, name:'KG1', level:'Kindergarten', teacher:'Ms. Patricia Acheampong' },
    { id:5, name:'KG2', level:'Kindergarten', teacher:'Ms. Efua Mensah' },
    { id:6, name:'BS.1', level:'Basic School', teacher:'Mr. Raymond Tetteh' },
    { id:7, name:'BS.2', level:'Basic School', teacher:'Mrs. Abena Asante' },
    { id:8, name:'BS.3', level:'Basic School', teacher:'Mr. Daniel Amoako' },
    { id:9, name:'BS.4', level:'Basic School', teacher:'Mr. Kweku Darko' },
    { id:10, name:'BS.5', level:'Basic School', teacher:'Mr. Kofi Boateng' },
    { id:11, name:'BS.7', level:'Basic School', teacher:'Mrs. Grace Opoku' },
    { id:12, name:'BS.8', level:'Basic School', teacher:'Mr. Kojo Amponsah' },
    { id:13, name:'BS.9', level:'Basic School', teacher:'Mrs. Akua Boadu' },
  ],
  albums: [
    { id:1, name:'Speech & Prize Giving 2025', desc:'Annual awards ceremony', emoji:'🏆', photos:[] },
    { id:2, name:'Independence Day 2025', desc:'Ghana @ 68 celebration', emoji:'🇬🇭', photos:[] },
    { id:3, name:'Science Fair', desc:'Pupil project showcase', emoji:'🔬', photos:[] },
    { id:4, name:'Cultural Day', desc:'Celebrating Ghanaian heritage', emoji:'🎭', photos:[] },
  ],
  reports: [],
  weeklyRecords: [],
  attendance: [],
  users: [
    { id:1, username:'admin', password:'admin123', role:'Admin', name:'Headmaster', active:true },
    { id:2, username:'teacher1', password:'teach123', role:'Teacher', name:'Mrs. Abena Asante', active:true },
  ],
  currentUser: null,
  settings: {
    schoolName: 'Accra Primary School',
    term: 'Second Term',
    session: '2024/2025',
    address: 'Ring Road, Accra',
    principal: 'Mr. Kwesi Appiah',
    district: 'Accra Metro Circuit A',
    motto: 'Excellence in Education',
  },
  schoolLogo: null,
  expenditures: [],
  driveClientId: '',
  driveUser: null,
  backupHistory: [],
  nextStudentId: 7,
  nextExpenditureId: 1, nextFeeId: 7, nextTeacherId: 5, nextClassId: 14, nextAlbumId: 5, nextWeeklyId: 1, nextAttendanceId: 1, nextUserId: 3,
  admissions: [],
  nextAdmissionId: 1,
  resources: [],
  nextResourceId: 1,
  exams: [],
  nextExamId: 1,
  transfers: [],
  nextTransferId: 1,
  announcements: [],
  nextAnnouncementId: 1,
  parentNotifications: [],
  nextPNId: 1,
  appTheme: 'blue',
  sidebarStyle: 'dark',
  fontSize: '15',
};

const GES_SUBJECTS = [
  'English Language','Mathematics','Science','R.M.E','History',
  'Creative Arts','Ghanaian Language','Computing','Literacy','Social Studies',
  'Career Technology','Numeracy','Creative Art','Natural Science',
  'Objects And Colouring','Our World Our People','Writing Skills','Environment Science'
];

const GES_REMARKS = ['Distinction','Excellent','Very Good','Good','Credit','Pass','Fail'];

// ── UTILS ──
function gesGradeFromScore(s) {
  if (s >= 90) return { grade:'1', remark:'Distinction' };
  if (s >= 80) return { grade:'1', remark:'Excellent' };
  if (s >= 70) return { grade:'2', remark:'Very Good' };
  if (s >= 65) return { grade:'3', remark:'Good' };
  if (s >= 60) return { grade:'4', remark:'Credit' };
  if (s >= 50) return { grade:'5', remark:'Credit' };
  if (s >= 45) return { grade:'6', remark:'Credit' };
  if (s >= 40) return { grade:'7', remark:'Pass' };
  if (s >= 35) return { grade:'8', remark:'Pass' };
  return { grade:'9', remark:'Fail' };
}

function showToast(msg, dur=3200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), dur);
}

function fmt(n) { return 'GH₵' + Number(n).toLocaleString(); }
function getStatus(due, paid) { return paid >= due ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid'; }
function statusPill(s) {
  const m = { Paid:'pill-paid', Partial:'pill-partial', Unpaid:'pill-unpaid' };
  return `<span class="status-pill ${m[s]||''}">${s}</span>`;
}


// ════════════════════════════════════════
// LINKED PUPILS SYSTEM
// ════════════════════════════════════════

/** Rebuild all pupil-picker dropdowns across the whole app */
function refreshAllPupilDropdowns() {
  const pupils = [...state.students].sort((a,b) => {
    if (a.cls < b.cls) return -1;
    if (a.cls > b.cls) return 1;
    return `${a.first} ${a.last}`.localeCompare(`${b.first} ${b.last}`);
  });

  const makeOptions = (placeholder = '-- Select Pupil --') => {
    let opts = `<option value="">${placeholder}</option>`;
    let lastCls = '';
    pupils.forEach(p => {
      if (p.cls !== lastCls) {
        if (lastCls) opts += '</optgroup>';
        opts += `<optgroup label="── ${p.cls} ──">`;
        lastCls = p.cls;
      }
      opts += `<option value="${p.id}">${p.first} ${p.last} (${p.cls})</option>`;
    });
    if (lastCls) opts += '</optgroup>';
    return opts;
  };

  // Fee record modal
  const fSel = document.getElementById('fStudentSelect');
  if (fSel) { const v=fSel.value; fSel.innerHTML=makeOptions('-- Search & Select Pupil --'); fSel.value=v; }

  // Fee bill modal
  const bSel = document.getElementById('billStudentSelect');
  if (bSel) { const v=bSel.value; bSel.innerHTML=makeOptions('-- Select Pupil --'); bSel.value=v; }

  // Report modal
  const rSel = document.getElementById('rStudentSelect');
  if (rSel) { const v=rSel.value; rSel.innerHTML=makeOptions('-- Pick from enrolled pupils --'); rSel.value=v; }
}

/** Auto-fill fee modal from pupil selection */
function autoFillFeeFromPupil(pupilId) {
  if (!pupilId) {
    document.getElementById('fStudentName').value = '';
    document.getElementById('fClass').value = '';
    document.getElementById('feeAutoFilledInfo').style.display = 'none';
    document.getElementById('feeExistingWarning').style.display = 'none';
    document.getElementById('fDue').value = '';
    document.getElementById('fPaid').value = '';
    return;
  }
  const p = state.students.find(s => s.id === parseInt(pupilId));
  if (!p) return;

  document.getElementById('fStudentName').value = `${p.first} ${p.last}`;
  document.getElementById('fClass').value = p.cls;
  document.getElementById('feeAutoFilledInfo').style.display = 'flex';

  // Check if a fee record already exists for this pupil
  const existing = state.fees.find(f => f.student === `${p.first} ${p.last}` && f.cls === p.cls);
  if (existing) {
    document.getElementById('fEditId').value = existing.id;
    document.getElementById('fDue').value = existing.due;
    document.getElementById('fPaid').value = existing.paid;
    document.getElementById('feeExistingWarning').style.display = 'block';
  } else {
    document.getElementById('fEditId').value = '';
    document.getElementById('fDue').value = '';
    document.getElementById('fPaid').value = '';
    document.getElementById('feeExistingWarning').style.display = 'none';
  }
}

/** Auto-fill fee bill modal from pupil selection */
function autoFillBillFromPupil(pupilId) {
  if (!pupilId) return;
  const p = state.students.find(s => s.id === parseInt(pupilId));
  if (!p) return;
  document.getElementById('billStudentName').value = `${p.first} ${p.last}`;
  document.getElementById('billClass').value = p.cls;
}

/** Auto-fill report modal from pupil selection */
function autoFillReportFromPupil(pupilId) {
  if (!pupilId) return;
  const p = state.students.find(s => s.id === parseInt(pupilId));
  if (!p) return;
  document.getElementById('rStudentName').value = `${p.first} ${p.last}`;
  document.getElementById('rClass').value = p.cls;
}

/** When a new pupil is saved, auto-create a placeholder fee record */
function autoCreateFeeRecord(pupil) {
  // Only create if no fee record exists yet
  const name = `${pupil.first} ${pupil.last}`;
  const existing = state.fees.find(f => f.student === name);
  if (!existing) {
    state.fees.push({
      id: state.nextFeeId++,
      student: name,
      cls: pupil.cls,
      studentId: pupil.id,
      due: 0,
      paid: 0
    });
  }
}

// ── NAVIGATION ──
function initNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      const sec = item.dataset.section;
      switchSection(sec);
      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      closeSidebar();
    });
  });
}

function switchSection(name) {
  // RBAC GUARD — verify access before showing any section
  if (state.currentUser && !guardSection(name)) return;

  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  const t = document.getElementById('sec-' + name);
  if (t) t.classList.add('active');
  // Refresh pupil-linked dropdowns whenever relevant sections are opened
  if (['fees','reports','sms'].includes(name)) refreshAllPupilDropdowns();
  // Refresh live dashboard every time it's viewed
  if (name === 'dashboard') { updateDashStats(); }
  if (name === 'settings')  { renderThemeSwatches(); }
  if (name === 'resources') { renderResources(); }
  if (name === 'exams')     { renderExams(); }
  if (name === 'transfers') { renderTransfers(); }
  if (name === 'communication') { renderAnnouncements(); renderParentNotifications(); generateSMSReminders2(); }
  const labels = {
    dashboard:'Dashboard', students:'Pupils', reports:'Academic Reports',
    fees:'School Fees', gallery:'Gallery', teachers:'Teachers',
    classes:'Classes', settings:'Settings', backup:'Backup & Drive', resources:'Resources Library',
    exams:'Examinations', transfers:'Transfers & Withdrawals', communication:'Communication Centre',
    weekly:'Weekly Work Output', attendance:'Attendance Register',
    promotion:'Student Promotion', sms:'SMS Fee Reminders', users:'User Management',
    expenditure:'Expenditure', idcards:'ID Card Generator', admissions:'Admissions'
  };
  document.getElementById('breadcrumb').textContent = labels[name] || name;
  if (name === 'idcards') renderIDCards();
  if (name === 'sms')     generateSMSReminders();
}

function initSidebar() {
  document.getElementById('menuToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('overlay').classList.toggle('open');
  });
  document.getElementById('overlay').addEventListener('click', closeSidebar);
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('open');
}

function initDate() {
  const el = document.getElementById('headerDate');
  if (!el) return;
  el.textContent = new Date().toLocaleDateString('en-GH', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
}

// ── DASHBOARD STATS ──
function updateDashStats() {
  const el = id => document.getElementById(id);

  // ── PUPILS ──
  const total = state.students.length;
  const males = state.students.filter(s => s.gender === 'Male').length;
  const females = state.students.filter(s => s.gender === 'Female').length;
  if (el('totalStudents')) el('totalStudents').textContent = total;
  if (el('dashMaleFemaleSplit')) el('dashMaleFemaleSplit').innerHTML =
    `<i class="fas fa-mars" style="color:#3b82f6"></i> ${males} &nbsp;<i class="fas fa-venus" style="color:#ec4899"></i> ${females}`;

  // ── TEACHERS ──
  if (el('totalTeachers')) el('totalTeachers').textContent = state.teachers.length;

  // ── FEES ──
  const totalC = state.fees.reduce((a,f) => a + f.paid, 0);
  const totalP = state.fees.filter(f => getStatus(f.due,f.paid) !== 'Paid').length;
  const totalOutAmt = state.fees.reduce((a,f) => a + Math.max(0, f.due - f.paid), 0);
  const pctPaid = state.fees.length ? Math.round(state.fees.filter(f=>getStatus(f.due,f.paid)==='Paid').length / state.fees.length * 100) : 0;
  if (el('totalCollected')) el('totalCollected').textContent = fmt(totalC);
  if (el('totalOutstanding')) el('totalOutstanding').textContent = fmt(totalOutAmt);
  if (el('feePctDash')) el('feePctDash').innerHTML = `<i class="fas fa-arrow-up"></i> ${pctPaid}% paid`;

  // ── CLASSES ──
  if (el('dashTotalClasses')) el('dashTotalClasses').textContent = state.classes.length;
  if (el('dashActiveClasses')) {
    const withPupils = state.classes.filter(c => state.students.some(s => s.cls === c.name)).length;
    el('dashActiveClasses').textContent = `${withPupils} with pupils`;
  }

  // ── ATTENDANCE RATE (last 7 days of records) ──
  if (el('dashAttToday')) {
    if (state.attendance && state.attendance.length) {
      const present = state.attendance.filter(a => a.status === 'Present').length;
      const rate = Math.round(present / state.attendance.length * 100);
      el('dashAttToday').textContent = rate + '%';
      if (el('dashAttLabel')) el('dashAttLabel').textContent = `${state.attendance.length} records`;
    } else {
      el('dashAttToday').textContent = '—';
      if (el('dashAttLabel')) el('dashAttLabel').textContent = 'No data yet';
    }
  }

  // ── LIVE SUMMARY PANEL ──
  updateDashLiveSummary();

  // ── FEE BARS BY CLASS ──
  updateDashFeeBars();
}

function updateDashLiveSummary() {
  const el = document.getElementById('dashLiveSummary');
  if (!el) return;
  const total = state.students.length;
  const males = state.students.filter(s => s.gender === 'Male').length;
  const females = state.students.filter(s => s.gender === 'Female').length;
  const paid = state.fees.filter(f => getStatus(f.due,f.paid) === 'Paid').length;
  const partial = state.fees.filter(f => getStatus(f.due,f.paid) === 'Partial').length;
  const unpaid = state.fees.filter(f => getStatus(f.due,f.paid) === 'Unpaid').length;
  const feesWithDue = state.fees.filter(f => f.due > 0).length;
  const totalDue = state.fees.reduce((a,f) => a + f.due, 0);
  const totalPaid = state.fees.reduce((a,f) => a + f.paid, 0);
  const totalBal = totalDue - totalPaid;
  const attRecords = (state.attendance || []).length;
  const presentRec = (state.attendance || []).filter(a => a.status === 'Present').length;
  const attRate = attRecords ? Math.round(presentRec / attRecords * 100) : null;
  const reports = (state.reports || []).length;
  const term = state.settings.term || 'Current Term';
  const session = state.settings.session || '—';

  const now = new Date();
  if (document.getElementById('dashLastRefresh')) {
    document.getElementById('dashLastRefresh').textContent = 'Updated ' + now.toLocaleTimeString('en-GH', {hour:'2-digit',minute:'2-digit'});
  }

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div style="background:var(--blue-light);border-radius:10px;padding:12px;">
        <div style="font-size:11px;font-weight:700;color:var(--blue);text-transform:uppercase;margin-bottom:6px;"><i class="fas fa-user-graduate"></i> Pupils</div>
        <div><strong style="font-size:18px;color:var(--blue);">${total}</strong> enrolled</div>
        <div style="font-size:12px;margin-top:3px;"><span style="color:#3b82f6;"><i class="fas fa-mars"></i> ${males} boys</span> &nbsp; <span style="color:#ec4899;"><i class="fas fa-venus"></i> ${females} girls</span></div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${state.classes.length} classes &nbsp;·&nbsp; ${state.teachers.length} teachers</div>
      </div>
      <div style="background:#f0fdf4;border-radius:10px;padding:12px;">
        <div style="font-size:11px;font-weight:700;color:var(--green);text-transform:uppercase;margin-bottom:6px;"><i class="fas fa-coins"></i> Fees — ${term}</div>
        <div><strong style="font-size:18px;color:var(--green);">${fmt(totalPaid)}</strong> collected</div>
        <div style="font-size:12px;margin-top:3px;">
          <span style="color:var(--green);">✅ ${paid} paid</span> &nbsp;
          <span style="color:var(--yellow);">⚠ ${partial} partial</span> &nbsp;
          <span style="color:var(--red);">❌ ${unpaid} unpaid</span>
        </div>
        <div style="font-size:12px;color:var(--red);margin-top:2px;">Outstanding: <strong>${fmt(totalBal)}</strong></div>
      </div>
      <div style="background:#fef3c7;border-radius:10px;padding:12px;">
        <div style="font-size:11px;font-weight:700;color:#d97706;text-transform:uppercase;margin-bottom:6px;"><i class="fas fa-clipboard-check"></i> Attendance</div>
        ${attRecords ? `<div><strong style="font-size:18px;color:#d97706;">${attRate}%</strong> rate</div>
        <div style="font-size:12px;margin-top:3px;">${presentRec} present of ${attRecords} records</div>` : '<div style="color:var(--text-muted);font-size:13px;">No records yet</div>'}
      </div>
      <div style="background:#ede9fe;border-radius:10px;padding:12px;">
        <div style="font-size:11px;font-weight:700;color:#7c3aed;text-transform:uppercase;margin-bottom:6px;"><i class="fas fa-file-alt"></i> Reports</div>
        <div><strong style="font-size:18px;color:#7c3aed;">${reports}</strong> report cards</div>
        <div style="font-size:12px;margin-top:3px;color:var(--text-muted);">Academic year: ${session}</div>
      </div>
    </div>`;
}

function updateDashFeeBars() {
  const feeBarsEl = document.getElementById('feeBars');
  if (!feeBarsEl) return;
  // Group fee records by class
  const classFees = {};
  state.fees.forEach(f => {
    if (!classFees[f.cls]) classFees[f.cls] = { due:0, paid:0, count:0 };
    classFees[f.cls].due += f.due;
    classFees[f.cls].paid += f.paid;
    classFees[f.cls].count++;
  });
  const entries = Object.entries(classFees).filter(([,v]) => v.due > 0);
  if (!entries.length) { feeBarsEl.innerHTML = '<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:16px;">No fee data yet.</p>'; return; }
  const colors = ['var(--blue)','var(--teal)','var(--green)','#7c3aed','#d97706','#ec4899','#f43f5e'];
  feeBarsEl.innerHTML = entries.map(([cls, v], i) => {
    const pct = Math.round(v.paid / v.due * 100);
    const barColor = colors[i % colors.length];
    return `<div class="fee-bar-item">
      <div class="fee-bar-label">
        <span><strong>${cls}</strong> <small style="color:var(--text-muted);">(${v.count} pupils)</small></span>
        <span class="fee-pct" style="color:${barColor};">${pct}%</span>
      </div>
      <div class="fee-bar-track"><div class="fee-bar-fill" style="width:${pct}%;background:${barColor};transition:width .6s ease;"></div></div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${fmt(v.paid)} collected of ${fmt(v.due)}</div>
    </div>`;
  }).join('');
}

// ── QUICK REPORT GENERATOR ──
function initReportGenerator() {
  const input = document.getElementById('reportInput');
  const btn = document.getElementById('generateBtn');
  const counter = document.getElementById('charCount');
  const output = document.getElementById('reportOutput');
  input.addEventListener('input', () => {
    const len = input.value.length;
    counter.textContent = `${len} / 500`;
    counter.style.color = len > 480 ? 'var(--red)' : '';
    if (len > 500) input.value = input.value.slice(0,500);
    output.style.display = 'none';
  });
  btn.addEventListener('click', () => {
    const text = input.value.trim();
    if (!text) { showToast('⚠️ Please enter pupil information first.'); return; }
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating...';
    btn.disabled = true;
    setTimeout(() => {
      const r = analyzeReport(text);
      output.innerHTML = `<h4><i class="fas fa-file-lines"></i> GES Report Summary</h4><p>${r.summary}</p><div class="report-tags">${r.tags.map(t=>`<span class="tag ${t.cls}">${t.label}</span>`).join('')}</div>`;
      output.style.display = 'block';
      btn.innerHTML = '<i class="fas fa-wand-magic-sparkles"></i> Generate Report';
      btn.disabled = false;
    }, 1100);
  });
}

function analyzeReport(text) {
  const scores = [...text.matchAll(/\b(\d{2,3})\b/g)].map(m=>parseInt(m[1])).filter(n=>n<=100&&n>=0);
  const avg = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : null;
  const nameMatch = text.match(/^([A-Z][a-z]+ [A-Z][a-z]+)/);
  const name = nameMatch ? nameMatch[1] : 'The pupil';
  let desc='', tags=[];
  if (avg!==null) {
    if (avg>=80){desc=`with an outstanding average of ${avg}%, demonstrating excellence per GES standards`;tags.push({label:`⭐ Avg: ${avg}%`,cls:'tag-good'},{label:'🏅 Excellent',cls:'tag-good'});}
    else if (avg>=70){desc=`with a very good average of ${avg}%`;tags.push({label:`📊 Avg: ${avg}%`,cls:'tag-good'},{label:'✅ Very Good',cls:'tag-good'});}
    else if (avg>=60){desc=`with a good average of ${avg}%`;tags.push({label:`📊 Avg: ${avg}%`,cls:'tag-info'},{label:'📗 Good',cls:'tag-info'});}
    else if (avg>=50){desc=`with a pass average of ${avg}%, requiring more effort`;tags.push({label:`⚠️ Avg: ${avg}%`,cls:'tag-warn'},{label:'📚 Needs Improvement',cls:'tag-warn'});}
    else{desc=`with a failing average of ${avg}%, requiring urgent intervention`;tags.push({label:`❌ Avg: ${avg}%`,cls:'tag-warn'},{label:'🔴 Failing',cls:'tag-warn'});}
  }
  const strengths=[], concerns=[];
  if (/attentive|focus|participat/i.test(text)) strengths.push('attentive in class');
  if (/excel|outstand|brilliant/i.test(text)) strengths.push('academically strong');
  if (/absent|irregular/i.test(text)){concerns.push('attendance issues');tags.push({label:'🚨 Attendance',cls:'tag-warn'});}
  if (/behav|disciplin/i.test(text)) concerns.push('conduct needs monitoring');
  let summary=`${name} has performed ${desc||'this term'}. `;
  if (strengths.length) summary+=`Strengths: ${strengths.join(', ')}. `;
  if (concerns.length) summary+=`Concerns: ${concerns.join(', ')}. `;
  summary += avg!==null&&avg>=60
    ? `Based on GES assessment standards, the pupil qualifies for promotion. Continued dedication is encouraged.`
    : `The school recommends parental engagement and additional support to meet GES promotion criteria.`;
  if (!tags.length) tags.push({label:'📋 GES Assessment',cls:'tag-info'});
  return {summary,tags};
}

// ── PUPILS ──


// ════════════════════════════════════════
// CSV DOWNLOAD FUNCTIONS
// ════════════════════════════════════════

function downloadCSV(filename, headers, rows) {
  const escape = val => {
    const s = String(val === null || val === undefined ? '' : val);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const csv = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
  showToast('✅ ' + filename + ' downloaded!');
}

function downloadPupilsCSV() {
  const headers = ['#','First Name','Last Name','Class','Gender','Guardian Phone','Fee Status','Enrolled'];
  const rows = state.students.map((s,i) => {
    const name = `${s.first} ${s.last}`;
    const feeRec = state.fees.find(f => f.studentId === s.id || f.student === name);
    const liveStatus = feeRec ? getStatus(feeRec.due, feeRec.paid) : (s.feeStatus || 'Unpaid');
    return [i+1, s.first, s.last, s.cls, s.gender, s.phone||'', liveStatus, s.enrolledDate||''];
  });
  const school = state.settings.schoolName || 'School';
  const term   = state.settings.term || 'Term';
  downloadCSV(`${school}_Pupils_${term}_${new Date().toLocaleDateString('en-GH').replace(/\//g,'-')}.csv`, headers, rows);
}

function downloadFeesCSV() {
  const headers = ['#','Pupil Name','Class','Term','Fee Due (GH₵)','Fee Paid (GH₵)','Balance (GH₵)','Status','Guardian Phone'];
  const rows = state.fees.map((f,i) => {
    const pupil = state.students.find(s => s.id === f.studentId || `${s.first} ${s.last}` === f.student);
    const bal   = f.due - f.paid;
    return [i+1, f.student, pupil ? pupil.cls : f.cls, f.term||'', f.due.toFixed(2), f.paid.toFixed(2), bal.toFixed(2), getStatus(f.due,f.paid), pupil ? (pupil.phone||'') : ''];
  });
  const school = state.settings.schoolName || 'School';
  const term   = state.settings.term || 'Term';
  downloadCSV(`${school}_Fees_${term}_${new Date().toLocaleDateString('en-GH').replace(/\//g,'-')}.csv`, headers, rows);
}

function downloadTeachersCSV() {
  const headers = ['#','First Name','Last Name','Subject(s)','Class(es) Assigned','Qualification','Phone'];
  const rows = state.teachers.map((t,i) => [i+1, t.first, t.last, t.subject||'', t.assigned||'', t.qualification||'', t.phone||'']);
  const school = state.settings.schoolName || 'School';
  downloadCSV(`${school}_Teachers_${new Date().toLocaleDateString('en-GH').replace(/\//g,'-')}.csv`, headers, rows);
}

function downloadAttendanceCSV() {
  const headers = ['#','Class','Week','Total Enrolled','Males Enrolled','Females Enrolled','Total Marked','Present','Absent','Late','Attendance Rate %'];
  const grouped = {};
  state.attendance.forEach(a => {
    const key = `${a.cls}|${a.week}`;
    if (!grouped[key]) grouped[key] = { cls:a.cls, week:a.week, records:[] };
    grouped[key].records.push(a);
  });
  const rows = Object.values(grouped).map((g,i) => {
    const classPupils    = state.students.filter(s => s.cls === g.cls);
    const totalEnrolled  = classPupils.length;
    const maleEnrolled   = classPupils.filter(s => s.gender === 'Male').length;
    const femaleEnrolled = classPupils.filter(s => s.gender === 'Female').length;
    const present = g.records.filter(r=>r.status==='Present').length;
    const absent  = g.records.filter(r=>r.status==='Absent').length;
    const late    = g.records.filter(r=>r.status==='Late').length;
    const total   = g.records.length;
    const rate    = total ? Math.round(present/total*100) : 0;
    return [i+1, g.cls, g.week, totalEnrolled, maleEnrolled, femaleEnrolled, total, present, absent, late, rate+'%'];
  });
  const school = state.settings.schoolName || 'School';
  downloadCSV(`${school}_Attendance_${new Date().toLocaleDateString('en-GH').replace(/\//g,'-')}.csv`, headers, rows);
}


/** Quick-navigate to the fee modal with a specific pupil pre-loaded */
function quickOpenFeeForStudent(studentId) {
  switchSection('fees');
  document.querySelectorAll('.nav-item').forEach(i => {
    i.classList.toggle('active', i.dataset.section === 'fees');
  });
  setTimeout(() => {
    document.getElementById('feeModalTitle').textContent = 'Record Fee Payment';
    document.getElementById('fEditId').value = '';
    document.getElementById('printReceiptBtn').style.display = 'none';
    clearFeeModal();
    refreshAllPupilDropdowns();
    const fTerm = document.getElementById('fTerm');
    if (fTerm) fTerm.value = state.settings.term || 'First Term';
    document.getElementById('fStudentSelect').value = studentId;
    autoFillFeeFromPupil(studentId);
    document.getElementById('feeModal').classList.add('open');
  }, 80);
}

function renderStudents(filter='', cls='') {
  const tbody = document.getElementById('studentTbody');
  let data = state.students;
  if (filter) data = data.filter(s=>`${s.first} ${s.last}`.toLowerCase().includes(filter.toLowerCase()));
  if (cls) data = data.filter(s=>s.cls===cls);
  if (!data.length) { tbody.innerHTML=`<tr><td colspan="7" style="text-align:center;color:var(--text-light);padding:28px;">No pupils found.</td></tr>`; return; }
  tbody.innerHTML = data.map((s,i)=>{
    // Get live fee status from fees array
    const name = `${s.first} ${s.last}`;
    const feeRec = state.fees.find(f => f.studentId === s.id || (f.student === name && f.cls === s.cls));
    const liveFeeStatus = feeRec ? getStatus(feeRec.due, feeRec.paid) : (s.feeStatus || 'Unpaid');
    const feeNote = feeRec && feeRec.due === 0 ? `<small style="color:var(--yellow);display:block;font-size:10px;">⚠ Fee not set</small>` : '';
    const photoHtml = s.photo
      ? `<img src="${s.photo}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;margin-right:8px;vertical-align:middle;border:2px solid var(--border);"/>`
      : `<span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:var(--blue-light);color:var(--blue);font-size:12px;font-weight:700;margin-right:8px;">${s.first.charAt(0)}</span>`;
    return `<tr>
      <td>${i+1}</td>
      <td><div style="display:flex;align-items:center;">${photoHtml}<strong>${name}</strong></div></td>
      <td><span class="status-pill" style="background:var(--blue-light);color:var(--blue);font-size:11px;">${s.cls}</span></td>
      <td>${s.gender}</td>
      <td>${s.phone||'—'}</td>
      <td>${statusPill(liveFeeStatus)}${feeNote}</td>
      <td>
        <button class="tbl-btn" onclick="editStudent(${s.id})" title="Edit Pupil"><i class="fas fa-edit"></i></button>
        <button class="tbl-btn" onclick="quickOpenFeeForStudent(${s.id})" title="Record Fee Payment" style="color:var(--green);"><i class="fas fa-coins"></i></button>
        <button class="tbl-btn danger" onclick="deleteStudent(${s.id})" title="Delete"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`;
  }).join('');
}

function initStudents() {
  renderStudents();
  document.getElementById('studentSearch').addEventListener('input', function(){ renderStudents(this.value, document.getElementById('classFilter').value); });
  document.getElementById('classFilter').addEventListener('change', function(){ renderStudents(document.getElementById('studentSearch').value, this.value); });
  document.getElementById('addStudentBtn').addEventListener('click', ()=>{
    document.getElementById('studentModalTitle').textContent='Add New Pupil';
    document.getElementById('sEditId').value='';
    clearStudentModal();
    document.getElementById('studentModal').classList.add('open');
  });
  document.getElementById('closeStudentModal').addEventListener('click', ()=>{ document.getElementById('studentModal').classList.remove('open'); });
  document.getElementById('cancelStudentModal').addEventListener('click', ()=>{ document.getElementById('studentModal').classList.remove('open'); });
  document.getElementById('saveStudentBtn').addEventListener('click', saveStudent);
}

function saveStudent() {
  const first = document.getElementById('sFirstName').value.trim();
  const last = document.getElementById('sLastName').value.trim();
  const cls = document.getElementById('sClass').value;
  const gender = document.getElementById('sGender').value;
  const phone = document.getElementById('sPhone').value.trim();
  const editId = document.getElementById('sEditId').value;
  const photoData = document.getElementById('sPhotoPreview').dataset.photo || null;
  if (!first||!last) { showToast('⚠️ Please enter pupil\'s full name.'); return; }
  if (editId) {
    const s = state.students.find(s=>s.id===parseInt(editId));
    if (s) { s.first=first; s.last=last; s.cls=cls; s.gender=gender; s.phone=phone; if(photoData) s.photo=photoData; }
    showToast(`✅ ${first} ${last} updated!`);
  } else {
    state.students.push({ id:state.nextStudentId++, first, last, cls, gender, phone, feeStatus:'Unpaid', photo:photoData });
    showToast(`✅ ${first} ${last} enrolled!`);
    // Auto-create Student/Parent user account
    const newPupil = state.students[state.students.length - 1];
    autoCreateStudentUser(newPupil);
  }
  renderStudents();
  updateDashStats();
  refreshAllPupilDropdowns();
  // Auto-create a fee record slot for new pupils
  if (!editId) {
    const newPupil = state.students[state.students.length - 1];
    autoCreateFeeRecord(newPupil);
    renderFees();
  } else {
    // If class changed, update the fee record class too
    const updatedStudent = state.students.find(s => s.id === parseInt(editId));
    if (updatedStudent) {
      const feeRec = state.fees.find(f => f.studentId === updatedStudent.id || f.student === `${updatedStudent.first} ${updatedStudent.last}`);
      if (feeRec) { feeRec.student = `${updatedStudent.first} ${updatedStudent.last}`; feeRec.cls = updatedStudent.cls; feeRec.studentId = updatedStudent.id; renderFees(); }
    }
  }
  autosave();
  document.getElementById('studentModal').classList.remove('open');
  clearStudentModal();
}

function editStudent(id) {
  const s = state.students.find(s=>s.id===id);
  if (!s) return;
  document.getElementById('studentModalTitle').textContent='Edit Pupil';
  document.getElementById('sEditId').value=id;
  document.getElementById('sFirstName').value=s.first;
  document.getElementById('sLastName').value=s.last;
  document.getElementById('sClass').value=s.cls;
  document.getElementById('sGender').value=s.gender;
  document.getElementById('sPhone').value=s.phone||'';
  const prev = document.getElementById('sPhotoPreview');
  if (s.photo) { prev.src=s.photo; prev.style.display='block'; prev.dataset.photo=s.photo; }
  else { prev.src=''; prev.style.display='none'; prev.dataset.photo=''; }
  document.getElementById('studentModal').classList.add('open');
}

function deleteStudent(id) {
  if (!confirm('Remove this pupil record? Their fee record will also be removed.')) return;
  const s = state.students.find(s => s.id === id);
  if (s) {
    const name = `${s.first} ${s.last}`;
    state.fees = state.fees.filter(f => !(f.studentId === id || (f.student === name && f.cls === s.cls)));
  }
  state.students = state.students.filter(s=>s.id!==id);
  renderStudents(); renderFees(); updateDashStats(); refreshAllPupilDropdowns(); autosave();
  showToast('🗑️ Pupil and linked fee record removed.');
}

function clearStudentModal() {
  ['sFirstName','sLastName','sPhone'].forEach(i=>document.getElementById(i).value='');
  const prev = document.getElementById('sPhotoPreview');
  prev.src=''; prev.style.display='none'; prev.dataset.photo='';
  document.getElementById('sPhotoInput').value='';
}

function initStudentPhotoUpload() {
  document.getElementById('sPhotoInput').addEventListener('change', e=>{
    const file = e.target.files[0]; if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('⚠️ Select an image file.'); return; }
    const reader = new FileReader();
    reader.onload = ev => {
      const prev = document.getElementById('sPhotoPreview');
      prev.src = ev.target.result; prev.style.display='block'; prev.dataset.photo=ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── REPORT CARDS ──

const ALL_SUBJECTS = [
  'English Language','Mathematics','Science','R.M.E','History',
  'Creative Arts','Ghanaian Language','Computing','Literacy','Social Studies',
  'Career Technology','Numeracy','Creative Art','Natural Science',
  'Objects And Colouring','Our World Our People','Writing Skills','Environment Science'
];

// Track which subjects have been added to the current form
let _addedSubjects = [];

function getSubjectRowId(sub) {
  return 'subj_' + sub.replace(/[^a-zA-Z0-9]/g, '_');
}

function renderSubjectRows() {
  const grid = document.getElementById('subjectsGrid');
  const hint = document.getElementById('subjectsEmptyHint');
  const countEl = document.getElementById('subjectCount');
  if (!grid) return;

  if (!_addedSubjects.length) {
    grid.innerHTML = '';
    if (hint) hint.style.display = 'block';
    if (countEl) countEl.textContent = '0 subjects';
    return;
  }
  if (hint) hint.style.display = 'none';
  if (countEl) countEl.textContent = _addedSubjects.length + ' subject' + (_addedSubjects.length !== 1 ? 's' : '');

  grid.innerHTML = _addedSubjects.map(sub => {
    const rowId = getSubjectRowId(sub);
    return `<div class="subject-input-item" id="${rowId}" style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;margin-bottom:8px;background:var(--bg-light);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <label style="font-weight:700;font-size:13px;color:var(--text);">${sub}</label>
        <button type="button" class="tbl-btn danger" style="padding:3px 8px;font-size:11px;" onclick="removeSubject('${sub.replace(/'/g,"\\'")}')" title="Remove subject"><i class="fas fa-times"></i></button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:center;">
        <input type="number" min="0" max="50" placeholder="Class Score /50" class="form-input cls-score" data-subject="${sub}" style="font-size:13px;"/>
        <input type="number" min="0" max="50" placeholder="Exam Score /50" class="form-input exam-score" data-subject="${sub}" style="font-size:13px;"/>
        <span id="subj_total_${rowId}" style="font-size:13px;font-weight:700;color:var(--blue);min-width:38px;text-align:center;">—</span>
      </div>
      <div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Class Score (50%) + Exam Score (50%) = Total /100</div>
    </div>`;
  }).join('');

  // Live total calculation per subject
  grid.querySelectorAll('.cls-score, .exam-score').forEach(inp => {
    inp.addEventListener('input', () => {
      const sub = inp.dataset.subject;
      const rowId = getSubjectRowId(sub);
      const cs = parseFloat(grid.querySelector(`.cls-score[data-subject="${sub}"]`)?.value) || 0;
      const es = parseFloat(grid.querySelector(`.exam-score[data-subject="${sub}"]`)?.value) || 0;
      const tot = Math.min(cs,50) + Math.min(es,50);
      const totEl = document.getElementById('subj_total_' + rowId);
      if (totEl) {
        totEl.textContent = (cs > 0 || es > 0) ? tot : '—';
        const g = gesGradeFromScore(tot);
        totEl.style.color = tot >= 80 ? 'var(--green)' : tot >= 50 ? 'var(--blue)' : 'var(--red)';
        totEl.title = `Grade ${g.grade} — ${g.remark}`;
      }
    });
  });

  // Refresh picker — grey out already-added subjects
  refreshSubjectPicker();
}

function refreshSubjectPicker() {
  const picker = document.getElementById('subjectPicker');
  if (!picker) return;
  Array.from(picker.options).forEach(opt => {
    if (!opt.value) return;
    opt.disabled = _addedSubjects.includes(opt.value);
    opt.style.color = opt.disabled ? '#aaa' : '';
    opt.textContent = opt.disabled ? '✓ ' + opt.value : opt.value;
  });
}

function addSubjectFromPicker() {
  const picker = document.getElementById('subjectPicker');
  if (!picker) return;
  const sub = picker.value;
  if (!sub) { showToast('⚠️ Select a subject first.'); return; }
  if (_addedSubjects.includes(sub)) { showToast('⚠️ ' + sub + ' is already added.'); return; }
  _addedSubjects.push(sub);
  picker.value = '';
  renderSubjectRows();
  // Focus the class score input of the newly added subject
  setTimeout(() => {
    const inp = document.querySelector(`.cls-score[data-subject="${sub}"]`);
    if (inp) inp.focus();
  }, 50);
}

function removeSubject(sub) {
  _addedSubjects = _addedSubjects.filter(s => s !== sub);
  renderSubjectRows();
}

function clearAllSubjects() {
  if (_addedSubjects.length && !confirm('Clear all subjects from this report?')) return;
  _addedSubjects = [];
  renderSubjectRows();
}

function initReportSection() {
  _addedSubjects = [];
  renderSubjectRows();

  document.getElementById('addSubjectBtn').addEventListener('click', addSubjectFromPicker);
  document.getElementById('subjectPicker').addEventListener('keydown', e => { if (e.key === 'Enter') addSubjectFromPicker(); });
  document.getElementById('clearAllSubjectsBtn').addEventListener('click', clearAllSubjects);

  document.getElementById('generateReportCard').addEventListener('click', generateGESReportCard);
  document.getElementById('cancelEditReportBtn').addEventListener('click', () => {
    _addedSubjects = [];
    renderSubjectRows();
    document.getElementById('rEditIndex').value = '';
    document.getElementById('generateReportCard').innerHTML = '<i class="fas fa-file-circle-check"></i> Generate GES Report Card';
    document.getElementById('cancelEditReportBtn').style.display = 'none';
    ['rStudentName','rClassSize','rPosition','rDaysPresent','rTotalDays','rNextTerm','rRemark','rHMRemark','rInterest'].forEach(id => document.getElementById(id).value = '');
    showToast('Edit cancelled.');
  });
  renderSavedReports();
  document.getElementById('rYear').value = state.settings.session;
  refreshAllPupilDropdowns();
  initScoreAutoTab();
}

function generateGESReportCard(editIndex) {
  const name = document.getElementById('rStudentName').value.trim();
  if (!name) { showToast('⚠️ Please enter pupil\'s name.'); return; }
  const cls = document.getElementById('rClass').value;
  const term = document.getElementById('rTerm').value;
  const year = document.getElementById('rYear').value || state.settings.session;
  const classSize = document.getElementById('rClassSize').value || '—';
  const position = document.getElementById('rPosition').value || '—';
  const daysPresent = document.getElementById('rDaysPresent').value || '—';
  const totalDays = document.getElementById('rTotalDays').value || '—';
  const nextTerm = document.getElementById('rNextTerm').value || '—';
  const remark = document.getElementById('rRemark').value || 'Keep up the good work!';
  const hmRemark = document.getElementById('rHMRemark').value || 'Promoted to the next class.';
  const interest = document.getElementById('rInterest').value || '—';
  const conduct = document.getElementById('rConduct').value;
  const settings = state.settings;

  const rows = [];
  let totalScore=0, count=0;

  _addedSubjects.forEach(sub => {
    const csInp  = document.querySelector(`.cls-score[data-subject="${sub}"]`);
    const esInp  = document.querySelector(`.exam-score[data-subject="${sub}"]`);
    const clsScore  = csInp  && csInp.value  !== '' ? parseFloat(csInp.value)  : null;
    const examScore = esInp  && esInp.value  !== '' ? parseFloat(esInp.value)  : null;

    if (clsScore !== null || examScore !== null) {
      const cs = Math.min(clsScore  || 0, 50);
      const es = Math.min(examScore || 0, 50);
      const total = Math.round(cs + es);
      const auto  = gesGradeFromScore(total);
      rows.push({ sub, clsScore: cs, examScore: es, total, grade: auto.grade, remark: auto.remark });
      totalScore += total; count++;
    }
  });

  if (!rows.length) { showToast('⚠️ Enter at least one subject score.'); return; }

  const avg = Math.round(totalScore/count);
  const { grade:avgGrade, remark:avgRemark } = gesGradeFromScore(avg);
  const avgCls = avg>=80?'excellent':avg>=65?'good':avg>=40?'fair':'poor';

  const logoHtml = state.schoolLogo
    ? `<img src="${state.schoolLogo}" class="rc-logo" alt="School Logo"/>`
    : `<div class="rc-logo-placeholder">🏫</div>`;

  const tableRows = rows.map(r=>`
    <tr>
      <td>${r.sub}</td>
      <td style="text-align:center;">${r.clsScore}</td>
      <td style="text-align:center;">${r.examScore}</td>
      <td style="text-align:center;font-weight:700;">${r.total}</td>
      <td style="text-align:center;" class="rc-grade grade-${r.grade}">${r.grade}</td>
      <td class="rc-remark-cell">${r.remark}</td>
    </tr>`).join('');

  // auto-compute ranking from saved reports for this class/term/year
  const classReports = state.reports.filter(rep => rep.cls===cls && rep.term===term && rep.year===year);
  const allAvgs = classReports.map(rep=>rep.avg).sort((a,b)=>b-a);
  const computedRank = allAvgs.indexOf(avg)+1 || parseInt(position)||1;
  const totalInClass = Math.max(allAvgs.length, parseInt(classSize)||1);
  const rankDisplay = `${computedRank} / ${totalInClass}`;

  // student photo
  const student = state.students.find(s=>`${s.first} ${s.last}`.toLowerCase()===name.toLowerCase());
  const photoHtml = (student&&student.photo)
    ? `<img src="${student.photo}" class="rc-student-photo" alt="${name}"/>`
    : `<div class="rc-student-photo-placeholder"><i class="fas fa-user"></i></div>`;

  const html = `
    <div class="rc-header">
      <div class="rc-logo-wrap">${logoHtml}</div>
      <div class="rc-school-info">
        <div class="rc-school">${settings.schoolName||'Ghana School'}</div>
        <div class="rc-ges">GHANA EDUCATION SERVICE</div>
        <div class="rc-subtitle">${settings.address||''}</div>
        ${settings.district?`<div class="rc-subtitle">${settings.district}</div>`:''}
        ${settings.motto?`<div class="rc-subtitle" style="font-style:italic;">Motto: ${settings.motto}</div>`:''}
        <div class="rc-term-badge">${term.toUpperCase()} — ${year}</div>
      </div>
      <div class="rc-photo-wrap">${photoHtml}</div>
    </div>
    <hr class="rc-divider"/>
    <div class="rc-student-info">
      <div class="rc-info-item"><strong>${name}</strong>Pupil's Name</div>
      <div class="rc-info-item"><strong>${cls}</strong>Class</div>
      <div class="rc-info-item"><strong>${rankDisplay}</strong>Position / Class Size</div>
      <div class="rc-info-item"><strong>${daysPresent} / ${totalDays}</strong>Attendance</div>
    </div>
    <table class="rc-table">
      <thead><tr>
        <th>Subject</th>
        <th style="text-align:center;">Class Score<br/><span style="font-weight:400;font-size:10px;">(50%)</span></th>
        <th style="text-align:center;">Exam Score<br/><span style="font-weight:400;font-size:10px;">(50%)</span></th>
        <th style="text-align:center;">Total<br/><span style="font-weight:400;font-size:10px;">(100)</span></th>
        <th style="text-align:center;">Grade</th>
        <th>Remark</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
      <tfoot>
        <tr style="background:var(--blue-light);font-weight:700;">
          <td colspan="3" style="padding:7px 10px;">Aggregate / Average</td>
          <td style="text-align:center;padding:7px 10px;">${avg}</td>
          <td style="text-align:center;padding:7px 10px;" class="rc-grade grade-${avgGrade}">${avgGrade}</td>
          <td style="padding:7px 10px;">${avgRemark}</td>
        </tr>
      </tfoot>
    </table>
    <div class="rc-avg-row">
      <span class="rc-avg-pill ${avgCls}"><i class="fas fa-chart-bar"></i> Average: ${avg}/100 — Grade ${avgGrade} · ${avgRemark}</span>
      <span class="rc-rank-pill"><i class="fas fa-trophy"></i> Class Rank: ${rankDisplay}</span>
    </div>
    <div class="rc-conduct-row">
      <div class="rc-conduct-item"><span>Conduct</span><strong>${conduct}</strong></div>
      <div class="rc-conduct-item"><span>Interest / Extra-Curricular</span><strong>${interest}</strong></div>
      <div class="rc-conduct-item"><span>Next Term Begins</span><strong>${nextTerm}</strong></div>
    </div>
    <div class="rc-footer-grid">
      <div class="rc-sign-box">
        <span>Class Teacher's Remark</span>
        <strong style="margin-bottom:6px;font-style:italic;font-weight:400;color:var(--text-muted);">${remark}</strong>
        <div class="rc-sign-line">Class Teacher: _______________________</div>
      </div>
      <div class="rc-sign-box">
        <span>Headmaster's Remark</span>
        <strong style="margin-bottom:6px;font-style:italic;font-weight:400;color:var(--text-muted);">${hmRemark}</strong>
        <div class="rc-sign-line">Headmaster: _______________________</div>
      </div>
    </div>
    <p style="text-align:center;margin-top:12px;font-size:11px;color:var(--text-light);">Issued by EduManage Pro · GES Certified · ${new Date().toLocaleDateString('en-GH')}</p>
  `;

  document.getElementById('reportCardContent').innerHTML=html;
  document.getElementById('reportCardOutput').style.display='block';
  document.getElementById('reportCardOutput').scrollIntoView({behavior:'smooth'});

  // Full data saved for edit capability
  const reportData = {
    name, cls, term, year, classSize, position, daysPresent, totalDays,
    nextTerm, remark, hmRemark, interest, conduct, rows, avg, avgGrade, avgRemark,
    date: new Date().toLocaleDateString('en-GH')
  };

  const editIdx = document.getElementById('rEditIndex').value;
  if (editIdx !== '') {
    state.reports[parseInt(editIdx)] = reportData;
    document.getElementById('rEditIndex').value = '';
    document.getElementById('generateReportCard').innerHTML = '<i class="fas fa-file-circle-check"></i> Generate GES Report Card';
    document.getElementById('cancelEditReportBtn').style.display = 'none';
    showToast(`✅ Report card updated for ${name}!`);
  } else {
    state.reports.push(reportData);
    showToast(`✅ GES Report card saved for ${name}!`);
  }
  autosave();
  renderSavedReports();
}

function renderSavedReports() {
  const c = document.getElementById('savedReportsList');
  if (!state.reports.length) { c.innerHTML=`<p class="empty-state"><i class="fas fa-file-circle-plus"></i> No reports yet.</p>`; return; }
  c.innerHTML = state.reports.map((r,i)=>`
    <div class="saved-report-item">
      <div class="sr-info">
        <span class="sr-name"><i class="fas fa-user-graduate"></i> ${r.name}</span>
        <span class="sr-meta">${r.cls} · ${r.term} · ${r.year} · Avg: ${r.avg}/100 · Grade ${r.avgGrade} — ${r.avgRemark} · ${r.date}</span>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button class="tbl-btn" onclick="editReport(${i})"><i class="fas fa-edit"></i> Edit</button>
        <button class="tbl-btn" onclick="viewReport(${i})"><i class="fas fa-eye"></i> View</button>
        <button class="tbl-btn danger" onclick="deleteReport(${i})"><i class="fas fa-trash"></i></button>
      </div>
    </div>`).join('');
}

function deleteReport(i) { 
  if (!confirm('Delete this report card?')) return;
  state.reports.splice(i,1); renderSavedReports(); showToast('🗑️ Report removed.'); 
}

function viewReport(i) {
  const r = state.reports[i]; if (!r) return;
  // Re-populate form and regenerate display only
  loadReportIntoForm(r, i);
  // Trigger view without re-saving
  _renderReportCardDisplay(r);
  document.getElementById('reportCardOutput').scrollIntoView({behavior:'smooth'});
}

function editReport(i) {
  const r = state.reports[i]; if (!r) return;
  loadReportIntoForm(r, i);
  document.getElementById('cancelEditReportBtn').style.display = 'inline-flex';
  document.getElementById('sec-reports').scrollIntoView({behavior:'smooth'});
  showToast(`✏️ Editing report for ${r.name}. Make changes and click Update to save.`);
}

function loadReportIntoForm(r, idx) {
  document.getElementById('rStudentName').value = r.name || '';
  document.getElementById('rClass').value = r.cls || 'P1';
  document.getElementById('rTerm').value = r.term || 'First Term';
  document.getElementById('rYear').value = r.year || '';
  document.getElementById('rClassSize').value = r.classSize !== '—' ? r.classSize : '';
  document.getElementById('rPosition').value = r.position !== '—' ? r.position : '';
  document.getElementById('rDaysPresent').value = r.daysPresent !== '—' ? r.daysPresent : '';
  document.getElementById('rTotalDays').value = r.totalDays !== '—' ? r.totalDays : '';
  document.getElementById('rNextTerm').value = r.nextTerm !== '—' ? r.nextTerm : '';
  document.getElementById('rRemark').value = r.remark || '';
  document.getElementById('rHMRemark').value = r.hmRemark || '';
  document.getElementById('rInterest').value = r.interest !== '—' ? r.interest : '';
  document.getElementById('rConduct').value = r.conduct || 'Hardworking';
  document.getElementById('rEditIndex').value = idx !== undefined ? idx : '';
  document.getElementById('generateReportCard').innerHTML = '<i class="fas fa-save"></i> Update Report Card';

  // Restore dynamic subject rows from saved data
  _addedSubjects = r.rows ? r.rows.map(row => row.sub) : [];
  renderSubjectRows();

  // Populate scores after rows are rendered
  if (r.rows && r.rows.length) {
    setTimeout(() => {
      r.rows.forEach(row => {
        const csInp = document.querySelector(`.cls-score[data-subject="${row.sub}"]`);
        const esInp = document.querySelector(`.exam-score[data-subject="${row.sub}"]`);
        if (csInp) { csInp.value = row.clsScore; csInp.dispatchEvent(new Event('input')); }
        if (esInp) { esInp.value = row.examScore; esInp.dispatchEvent(new Event('input')); }
      });
    }, 30);
  }
}

function _renderReportCardDisplay(r) {
  const settings = state.settings;
  const logoHtml = state.schoolLogo
    ? `<img src="${state.schoolLogo}" class="rc-logo" alt="School Logo"/>`
    : `<div class="rc-logo-placeholder">🏫</div>`;
  const tableRows = (r.rows||[]).map(row=>`
    <tr>
      <td>${row.sub}</td>
      <td style="text-align:center;">${row.clsScore}</td>
      <td style="text-align:center;">${row.examScore}</td>
      <td style="text-align:center;font-weight:700;">${row.total}</td>
      <td style="text-align:center;" class="rc-grade grade-${row.grade}">${row.grade}</td>
      <td class="rc-remark-cell">${row.remark}</td>
    </tr>`).join('');
  const avgCls = r.avg>=80?'excellent':r.avg>=65?'good':r.avg>=40?'fair':'poor';

  // auto ranking
  const classReports = state.reports.filter(rep=>rep.cls===r.cls&&rep.term===r.term&&rep.year===r.year);
  const allAvgs = classReports.map(rep=>rep.avg).sort((a,b)=>b-a);
  const computedRank = allAvgs.indexOf(r.avg)+1 || 1;
  const totalInClass = Math.max(allAvgs.length, 1);
  const rankDisplay = `${computedRank} / ${totalInClass}`;

  const student = state.students.find(s=>`${s.first} ${s.last}`.toLowerCase()===r.name.toLowerCase());
  const photoHtml = (student&&student.photo)
    ? `<img src="${student.photo}" class="rc-student-photo" alt="${r.name}"/>`
    : `<div class="rc-student-photo-placeholder"><i class="fas fa-user"></i></div>`;

  const html = `
    <div class="rc-header">
      <div class="rc-logo-wrap">${logoHtml}</div>
      <div class="rc-school-info">
        <div class="rc-school">${settings.schoolName||'Ghana School'}</div>
        <div class="rc-ges">GHANA EDUCATION SERVICE</div>
        <div class="rc-subtitle">${settings.address||''}</div>
        ${settings.district?`<div class="rc-subtitle">${settings.district}</div>`:''}
        ${settings.motto?`<div class="rc-subtitle" style="font-style:italic;">Motto: ${settings.motto}</div>`:''}
        <div class="rc-term-badge">${(r.term||'').toUpperCase()} — ${r.year||''}</div>
      </div>
      <div class="rc-photo-wrap">${photoHtml}</div>
    </div>
    <hr class="rc-divider"/>
    <div class="rc-student-info">
      <div class="rc-info-item"><strong>${r.name}</strong>Pupil's Name</div>
      <div class="rc-info-item"><strong>${r.cls}</strong>Class</div>
      <div class="rc-info-item"><strong>${rankDisplay}</strong>Position / Class Size</div>
      <div class="rc-info-item"><strong>${r.daysPresent||'—'} / ${r.totalDays||'—'}</strong>Attendance</div>
    </div>
    <table class="rc-table">
      <thead><tr>
        <th>Subject</th>
        <th style="text-align:center;">Class Score<br/><span style="font-weight:400;font-size:10px;">(50%)</span></th>
        <th style="text-align:center;">Exam Score<br/><span style="font-weight:400;font-size:10px;">(50%)</span></th>
        <th style="text-align:center;">Total<br/><span style="font-weight:400;font-size:10px;">(100)</span></th>
        <th style="text-align:center;">Grade</th>
        <th>Remark</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
      <tfoot><tr style="background:var(--blue-light);font-weight:700;">
        <td colspan="3" style="padding:7px 10px;">Aggregate / Average</td>
        <td style="text-align:center;padding:7px 10px;">${r.avg}</td>
        <td style="text-align:center;padding:7px 10px;" class="rc-grade grade-${r.avgGrade}">${r.avgGrade}</td>
        <td style="padding:7px 10px;">${r.avgRemark}</td>
      </tr></tfoot>
    </table>
    <div class="rc-avg-row">
      <span class="rc-avg-pill ${avgCls}"><i class="fas fa-chart-bar"></i> Average: ${r.avg}/100 — Grade ${r.avgGrade} · ${r.avgRemark}</span>
      <span class="rc-rank-pill"><i class="fas fa-trophy"></i> Class Rank: ${rankDisplay}</span>
    </div>
    <div class="rc-conduct-row">
      <div class="rc-conduct-item"><span>Conduct</span><strong>${r.conduct||'—'}</strong></div>
      <div class="rc-conduct-item"><span>Interest / Extra-Curricular</span><strong>${r.interest||'—'}</strong></div>
      <div class="rc-conduct-item"><span>Next Term Begins</span><strong>${r.nextTerm||'—'}</strong></div>
    </div>
    <div class="rc-footer-grid">
      <div class="rc-sign-box">
        <span>Class Teacher's Remark</span>
        <strong style="margin-bottom:6px;font-style:italic;font-weight:400;color:var(--text-muted);">${r.remark||''}</strong>
        <div class="rc-sign-line">Class Teacher: _______________________</div>
      </div>
      <div class="rc-sign-box">
        <span>Headmaster's Remark</span>
        <strong style="margin-bottom:6px;font-style:italic;font-weight:400;color:var(--text-muted);">${r.hmRemark||''}</strong>
        <div class="rc-sign-line">Headmaster: _______________________</div>
      </div>
    </div>
    <p style="text-align:center;margin-top:12px;font-size:11px;color:var(--text-light);">Issued by EduManage Pro · GES Certified · ${r.date||new Date().toLocaleDateString('en-GH')}</p>
  `;
  document.getElementById('reportCardContent').innerHTML = html;
  document.getElementById('reportCardOutput').style.display = 'block';
}

// ── FEES ──
function renderFees(filter='', statusF='') {
  const tbody = document.getElementById('feesTbody');
  let data = state.fees;
  if (filter) data = data.filter(f=>f.student.toLowerCase().includes(filter.toLowerCase()));
  if (statusF) data = data.filter(f=>getStatus(f.due,f.paid)===statusF);
  if (!data.length) { tbody.innerHTML=`<tr><td colspan="8" style="text-align:center;color:var(--text-light);padding:28px;">No records. Pupils are auto-linked when enrolled.</td></tr>`; return; }
  tbody.innerHTML = data.map((f,i)=>{
    const bal=f.due-f.paid, status=getStatus(f.due,f.paid);
    // Enrich with live student data
    const pupil = state.students.find(s => s.id === f.studentId || `${s.first} ${s.last}` === f.student);
    const cls = pupil ? pupil.cls : f.cls;
    const name = pupil ? `${pupil.first} ${pupil.last}` : f.student;
    const photo = pupil && pupil.photo ? `<img src="${pupil.photo}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;margin-right:7px;vertical-align:middle;"/>` : `<span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:var(--blue-light);color:var(--blue);font-size:11px;font-weight:700;margin-right:7px;">${name.charAt(0)}</span>`;
    const pendingSetup = f.due === 0 ? '<span style="font-size:10px;color:var(--yellow);display:block;">⚠ Fee not set</span>' : '';
    return `<tr>
      <td>${i+1}</td>
      <td><div style="display:flex;align-items:center;">${photo}<div><strong>${name}</strong>${pendingSetup}</div></div></td>
      <td><span class="status-pill" style="background:var(--blue-light);color:var(--blue);font-size:11px;">${cls}</span></td>
      <td>${fmt(f.due)}</td><td style="color:var(--green);font-weight:600;">${fmt(f.paid)}</td>
      <td style="color:${bal>0?'var(--red)':'var(--green)'};font-weight:600;">${fmt(bal)}</td>
      <td>${statusPill(status)}</td>
      <td>
        <button class="tbl-btn" onclick="editFeeRecord(${f.id})" title="Edit"><i class="fas fa-edit"></i></button>
        <button class="tbl-btn" onclick="quickPrintFeeReceipt(${f.id})" title="Print Receipt"><i class="fas fa-receipt"></i></button>
        <button class="tbl-btn danger" onclick="deleteFee(${f.id})" title="Delete"><i class="fas fa-trash"></i></button>
      </td></tr>`;
  }).join('');
  updateFeeStats();
}

function updateFeeStats() {
  const paid = state.fees.filter(f=>getStatus(f.due,f.paid)==='Paid').length;
  const unpaid = state.fees.filter(f=>getStatus(f.due,f.paid)!=='Paid').length;
  const totalC = state.fees.reduce((a,f)=>a+f.paid,0);
  const totalP = state.fees.reduce((a,f)=>a+(f.due-f.paid),0);
  document.getElementById('feePaidCount').textContent=paid;
  document.getElementById('feeUnpaidCount').textContent=unpaid;
  document.getElementById('totalCollectedFee').textContent=fmt(totalC);
  document.getElementById('totalPendingFee').textContent=fmt(totalP);
  updateDashStats();
}

function initFees() {
  renderFees();
  document.getElementById('feeSearch').addEventListener('input',function(){ renderFees(this.value, document.getElementById('feeStatusFilter').value); });
  document.getElementById('feeStatusFilter').addEventListener('change',function(){ renderFees(document.getElementById('feeSearch').value,this.value); });
  document.getElementById('recordFeeBtn').addEventListener('click',()=>{
    document.getElementById('feeModalTitle').textContent='Record Fee Payment';
    document.getElementById('fEditId').value='';
    document.getElementById('printReceiptBtn').style.display='none';
    clearFeeModal();
    refreshAllPupilDropdowns();
    // Set default term
    const fTerm = document.getElementById('fTerm');
    if (fTerm) fTerm.value = state.settings.term || 'First Term';
    document.getElementById('feeModal').classList.add('open');
  });
  document.getElementById('closeFeeModal').addEventListener('click',()=>document.getElementById('feeModal').classList.remove('open'));
  document.getElementById('cancelFeeModal').addEventListener('click',()=>document.getElementById('feeModal').classList.remove('open'));
  document.getElementById('saveFeeBtn').addEventListener('click', saveFee);
  document.getElementById('printReceiptBtn').addEventListener('click', printFeeReceipt);

  // Bulk Fee Setup: set fee for all pupils in a class at once
  document.getElementById('bulkFeeBtn') && document.getElementById('bulkFeeBtn').addEventListener('click', openBulkFeeModal);

  // Fee Bill Generator
  document.getElementById('generateBillBtn').addEventListener('click',()=>{
    document.getElementById('billYear').value = state.settings.session;
    refreshAllPupilDropdowns();
    updateBillTotal();
    document.getElementById('feeBillModal').classList.add('open');
  });
  document.getElementById('closeFeeBillModal').addEventListener('click',()=>document.getElementById('feeBillModal').classList.remove('open'));
  document.getElementById('cancelFeeBillModal').addEventListener('click',()=>document.getElementById('feeBillModal').classList.remove('open'));
  document.getElementById('addBillItemBtn').addEventListener('click', addBillItem);
  document.getElementById('printBillBtn').addEventListener('click', printFeeBill);
  document.getElementById('billItemsContainer').addEventListener('input', updateBillTotal);
  document.getElementById('billItemsContainer').addEventListener('click', e=>{
    if (e.target.closest('.remove-bill-item')) {
      e.target.closest('.bill-item-row').remove();
      updateBillTotal();
    }
  });
}

function addBillItem() {
  const container = document.getElementById('billItemsContainer');
  const row = document.createElement('div');
  row.className = 'bill-item-row';
  row.innerHTML = `<input type="text" class="form-input bill-desc" placeholder="Description"/><input type="number" class="form-input bill-amt" placeholder="Amount (GH₵)" min="0"/><button class="tbl-btn danger remove-bill-item"><i class="fas fa-minus"></i></button>`;
  container.appendChild(row);
}

function updateBillTotal() {
  const amts = Array.from(document.querySelectorAll('.bill-amt')).map(i=>parseFloat(i.value)||0);
  const total = amts.reduce((a,b)=>a+b,0);
  document.getElementById('billTotalDisplay').textContent = 'GH₵ ' + total.toFixed(2);
}

function printFeeBill() {
  const student = document.getElementById('billStudentName').value.trim();
  if (!student){ showToast('⚠️ Enter pupil name.'); return; }
  const cls = document.getElementById('billClass').value;
  const term = document.getElementById('billTerm').value;
  const year = document.getElementById('billYear').value || state.settings.session;
  const rows = Array.from(document.querySelectorAll('#billItemsContainer .bill-item-row'));
  const items = rows.map((r,i)=>({
    sn: i+1,
    desc: r.querySelector('.bill-desc').value.trim()||'—',
    amt: parseFloat(r.querySelector('.bill-amt').value)||0
  })).filter(it=>it.desc!=='—'||it.amt>0);
  if (!items.length){ showToast('⚠️ Add at least one fee item.'); return; }
  const total = items.reduce((a,b)=>a+b.amt,0);
  const school = state.settings;
  const logoHtml = state.schoolLogo ? `<img src="${state.schoolLogo}" style="height:70px;object-fit:contain;"/>` : '🏫';
  const win = window.open('','_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Fee Bill — ${student}</title><style>
    body{font-family:'Plus Jakarta Sans',Arial,sans-serif;max-width:600px;margin:30px auto;color:#1a2133;font-size:14px;}
    .header{text-align:center;margin-bottom:20px;}
    .logo{font-size:40px;margin-bottom:8px;}
    h1{font-size:20px;font-weight:800;margin:4px 0;}
    h2{font-size:14px;font-weight:500;color:#64748b;margin:2px 0;}
    .bill-title{background:#1a6fd4;color:#fff;text-align:center;padding:10px;border-radius:8px;font-weight:700;font-size:16px;margin:20px 0 14px;}
    .info-row{display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px;}
    table{width:100%;border-collapse:collapse;margin-top:14px;}
    th{background:#e8f0fb;color:#1a6fd4;text-align:left;padding:8px 10px;font-size:12px;font-weight:700;}
    td{padding:8px 10px;border-bottom:1px solid #dde3ef;font-size:13px;}
    .total-row td{background:#e8f0fb;font-weight:800;font-size:15px;color:#1a6fd4;}
    .footer{margin-top:20px;font-size:11px;color:#94a3b8;text-align:center;}
  </style></head><body>
    <div class="header">
      <div class="logo">${logoHtml}</div>
      <h1>${school.schoolName||'Ghana School'}</h1>
      <h2>Ghana Education Service</h2>
      ${school.address?`<h2>${school.address}</h2>`:''}
    </div>
    <div class="bill-title">FEE BILL — ${term.toUpperCase()} ${year}</div>
    <div class="info-row"><span><strong>Student:</strong> ${student}</span><span><strong>Class:</strong> ${cls}</span></div>
    <div class="info-row"><span><strong>Date:</strong> ${new Date().toLocaleDateString('en-GH')}</span><span><strong>Bill No:</strong> BILL-${Date.now().toString().slice(-6)}</span></div>
    <table>
      <thead><tr><th>S/N</th><th>Description</th><th style="text-align:right;">Amount (GH₵)</th></tr></thead>
      <tbody>${items.map(it=>`<tr><td>${it.sn}</td><td>${it.desc}</td><td style="text-align:right;">${it.amt.toFixed(2)}</td></tr>`).join('')}</tbody>
      <tfoot><tr class="total-row"><td colspan="2">TOTAL DUE</td><td style="text-align:right;">GH₵ ${total.toFixed(2)}</td></tr></tfoot>
    </table>
    <div class="footer">Please make payment by the due date · ${school.schoolName||'Ghana School'} · EduManage Pro</div>
    <script>window.onload=function(){window.print();}<\/script>
  </body></html>`);
  win.document.close();
}



// ── BULK FEE SETUP ──
function openBulkFeeModal() {
  document.getElementById('bulkFeeModal').classList.add('open');
}

function applyBulkFee() {
  const cls = document.getElementById('bulkFeeClass').value;
  const due = parseFloat(document.getElementById('bulkFeeDue').value) || 0;
  const term = document.getElementById('bulkFeeTerm').value;
  if (!cls) { showToast('⚠️ Select a class.'); return; }
  if (due <= 0) { showToast('⚠️ Enter a valid fee amount.'); return; }

  const pupils = state.students.filter(s => s.cls === cls);
  if (!pupils.length) { showToast('⚠️ No pupils found in ' + cls); return; }

  let updated = 0, created = 0;
  pupils.forEach(p => {
    const name = `${p.first} ${p.last}`;
    const existing = state.fees.find(f => f.studentId === p.id || (f.student === name && f.cls === cls));
    if (existing) {
      existing.due = due;
      existing.term = term;
      existing.cls = cls;
      updated++;
    } else {
      state.fees.push({ id: state.nextFeeId++, student: name, cls, due, paid: 0, term, studentId: p.id });
      created++;
    }
  });

  renderFees(); updateFeeStats(); autosave();
  document.getElementById('bulkFeeModal').classList.remove('open');
  showToast(`✅ ${created} created, ${updated} updated for ${cls} — GH₵${due} per pupil.`);
}

function quickPrintFeeReceipt(feeId) {
  const f = state.fees.find(f => f.id === feeId); if (!f) return;
  const pupil = state.students.find(s => s.id === f.studentId || `${s.first} ${s.last}` === f.student);
  const school = state.settings;
  const bal = f.due - f.paid;
  const status = getStatus(f.due, f.paid);
  const logoHtml = state.schoolLogo ? `<img src="${state.schoolLogo}" style="height:70px;object-fit:contain;"/>` : '🏫';
  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Receipt — ${f.student}</title><style>
    body{font-family:'Segoe UI',Arial,sans-serif;max-width:500px;margin:30px auto;color:#1a2133;font-size:14px;}
    .header{text-align:center;margin-bottom:16px;}
    h1{font-size:18px;font-weight:800;margin:4px 0;}
    h2{font-size:13px;color:#64748b;margin:2px 0;}
    .receipt-title{background:#16a34a;color:#fff;text-align:center;padding:8px;border-radius:8px;font-weight:700;font-size:16px;margin:16px 0 12px;}
    .row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #dde3ef;font-size:13px;}
    .total{font-weight:800;font-size:15px;color:#16a34a;}
    .stamp{display:inline-block;border:2px solid #16a34a;color:#16a34a;padding:6px 20px;border-radius:4px;font-weight:700;font-size:13px;margin-top:14px;}
    .footer{margin-top:16px;font-size:11px;color:#94a3b8;text-align:center;border-top:1px solid #dde3ef;padding-top:10px;}
  </style></head><body>
    <div class="header">${logoHtml}<h1>${school.schoolName||'School'}</h1><h2>Official Payment Receipt</h2></div>
    <div class="receipt-title">PAYMENT RECEIPT</div>
    <div class="row"><span>Receipt No.</span><span>REC-${String(feeId).padStart(5,'0')}</span></div>
    <div class="row"><span>Date</span><span>${new Date().toLocaleDateString('en-GH')}</span></div>
    <div class="row"><span>Pupil</span><span><strong>${f.student}</strong></span></div>
    <div class="row"><span>Class</span><span>${pupil ? pupil.cls : f.cls}</span></div>
    <div class="row"><span>Term</span><span>${f.term || school.term || '—'}</span></div>
    ${pupil && pupil.phone ? `<div class="row"><span>Guardian Phone</span><span>${pupil.phone}</span></div>` : ''}
    <div class="row"><span>Total Fee Due</span><span>GH₵ ${Number(f.due).toFixed(2)}</span></div>
    <div class="row total"><span>Amount Paid</span><span>GH₵ ${Number(f.paid).toFixed(2)}</span></div>
    <div class="row" style="color:${bal>0?'#dc2626':'#16a34a'};font-weight:700;"><span>Balance</span><span>GH₵ ${Number(bal).toFixed(2)}</span></div>
    <div style="text-align:center;margin-top:16px;">
      ${bal<=0 ? '<span class="stamp">✅ FULLY PAID</span>' : `<span class="stamp" style="border-color:#d97706;color:#d97706;">⚠️ BALANCE: GH₵${bal.toFixed(2)}</span>`}
    </div>
    <div style="margin-top:28px;display:flex;justify-content:space-between;font-size:12px;">
      <div>Cashier: ____________________</div><div>Signature: __________________</div>
    </div>
    <div class="footer">${school.schoolName||'School'} · EduManage Pro · ${new Date().toLocaleDateString('en-GH')}</div>
  <script>window.onload=function(){window.print();}<\/script></body></html>`);
  win.document.close();
}

function printFeeReceipt() {
  const student = document.getElementById('fStudentName').value.trim();
  const cls = document.getElementById('fClass').value;
  const paid = parseFloat(document.getElementById('fPaid').value)||0;
  const due = parseFloat(document.getElementById('fDue').value)||0;
  if (!student){ showToast('⚠️ Fill in pupil details first.'); return; }
  const school = state.settings;
  const balance = due - paid;
  const logoHtml = state.schoolLogo ? `<img src="${state.schoolLogo}" style="height:70px;object-fit:contain;"/>` : '🏫';
  const win = window.open('','_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Receipt — ${student}</title><style>
    body{font-family:'Plus Jakarta Sans',Arial,sans-serif;max-width:500px;margin:30px auto;color:#1a2133;font-size:14px;}
    .header{text-align:center;margin-bottom:16px;}
    .logo{font-size:36px;margin-bottom:6px;}
    h1{font-size:18px;font-weight:800;margin:4px 0;}
    h2{font-size:13px;color:#64748b;margin:2px 0;}
    .receipt-title{background:#16a34a;color:#fff;text-align:center;padding:8px;border-radius:8px;font-weight:700;font-size:16px;margin:16px 0 12px;}
    .row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #dde3ef;font-size:13px;}
    .total{font-weight:800;font-size:15px;color:#16a34a;}
    .balance{color:${balance>0?'#dc2626':'#16a34a'};font-weight:700;}
    .footer{margin-top:16px;font-size:11px;color:#94a3b8;text-align:center;border-top:1px solid #dde3ef;padding-top:10px;}
    .stamp{display:inline-block;border:2px solid #16a34a;color:#16a34a;padding:6px 20px;border-radius:4px;font-weight:700;font-size:13px;margin-top:14px;transform:rotate(-5deg);}
  </style></head><body>
    <div class="header">
      <div class="logo">${logoHtml}</div>
      <h1>${school.schoolName||'Ghana School'}</h1>
      <h2>Ghana Education Service · Official Receipt</h2>
    </div>
    <div class="receipt-title">PAYMENT RECEIPT</div>
    <div class="row"><span>Receipt No.</span><span>REC-${Date.now().toString().slice(-6)}</span></div>
    <div class="row"><span>Date</span><span>${new Date().toLocaleDateString('en-GH')}</span></div>
    <div class="row"><span>Student</span><span><strong>${student}</strong></span></div>
    <div class="row"><span>Class</span><span>${cls}</span></div>
    <div class="row"><span>Term</span><span>${school.term||'Current Term'}</span></div>
    <div class="row"><span>Total Fee Due</span><span>GH₵ ${due.toFixed(2)}</span></div>
    <div class="row total"><span>Amount Paid</span><span>GH₵ ${paid.toFixed(2)}</span></div>
    <div class="row balance"><span>Balance</span><span>GH₵ ${balance.toFixed(2)}</span></div>
    <div style="text-align:center;margin-top:16px;">
      ${balance<=0?`<span class="stamp">✅ FULLY PAID</span>`:`<span class="stamp" style="border-color:#d97706;color:#d97706;">⚠️ BALANCE: GH₵${balance.toFixed(2)}</span>`}
    </div>
    <div style="margin-top:20px;display:flex;justify-content:space-between;font-size:12px;">
      <div>Cashier: ______________________</div>
      <div>Signature: ___________________</div>
    </div>
    <div class="footer">${school.schoolName||'Ghana School'} · EduManage Pro · ${new Date().toLocaleDateString('en-GH')}</div>
    <script>window.onload=function(){window.print();}<\/script>
  </body></html>`);
  win.document.close();
}

function saveFee() {
  const student = document.getElementById('fStudentName').value.trim();
  const cls = document.getElementById('fClass').value || '';
  const due = parseFloat(document.getElementById('fDue').value) || 0;
  const paid = parseFloat(document.getElementById('fPaid').value) || 0;
  const term = (document.getElementById('fTerm') && document.getElementById('fTerm').value) || state.settings.term || '';
  const editId = document.getElementById('fEditId').value;
  const selId = document.getElementById('fStudentSelect') ? parseInt(document.getElementById('fStudentSelect').value) : null;

  if (!student) { showToast('⚠️ Select or enter a pupil name.'); return; }
  if (due <= 0) { showToast('⚠️ Enter a valid fee amount.'); return; }

  if (editId) {
    const f = state.fees.find(f => f.id === parseInt(editId));
    if (f) { f.student=student; f.cls=cls||f.cls; f.due=due; f.paid=Math.min(paid,due); f.term=term; if(selId) f.studentId=selId; }
    showToast(`✅ Fee record updated for ${student}!`);
  } else {
    state.fees.push({ id:state.nextFeeId++, student, cls, due, paid:Math.min(paid,due), term, studentId: selId||null });
    showToast(`✅ Fee recorded for ${student}!`);
  }

  // Sync feeStatus back onto the student record
  const pupil = state.students.find(s => s.id === selId || `${s.first} ${s.last}` === student);
  if (pupil) { pupil.feeStatus = getStatus(due, Math.min(paid, due)); }

  renderFees(); renderStudents();
  document.getElementById('printReceiptBtn').style.display = 'inline-flex';
  updateFeeStats(); updateDashStats();
  autosave();
}

function editFeeRecord(id) {
  const f=state.fees.find(f=>f.id===id); if (!f) return;
  document.getElementById('feeModalTitle').textContent='Edit Fee Record';
  document.getElementById('fEditId').value=id;
  document.getElementById('fStudentName').value=f.student;
  document.getElementById('fClass').value=f.cls;
  document.getElementById('fDue').value=f.due;
  document.getElementById('fPaid').value=f.paid;
  document.getElementById('feeModal').classList.add('open');
}

function deleteFee(id) {
  if (!confirm('Delete this fee record?')) return;
  state.fees=state.fees.filter(f=>f.id!==id); renderFees(); autosave(); showToast('🗑️ Record removed.');
}
function clearFeeModal(){
  ['fDue','fPaid','fStudentName','fClass'].forEach(i=>{ const el=document.getElementById(i); if(el) el.value=''; });
  const fSel=document.getElementById('fStudentSelect');
  if(fSel) fSel.value='';
  const info=document.getElementById('feeAutoFilledInfo');
  if(info) info.style.display='none';
  const warn=document.getElementById('feeExistingWarning');
  if(warn) warn.style.display='none';
}

// ── GALLERY ──
let currentAlbumId = null;

function renderGallery() {
  const c = document.getElementById('galleryAlbums');
  if (!state.albums.length){ c.innerHTML=`<p class="empty-state"><i class="fas fa-images"></i> No albums yet.</p>`; return; }
  c.innerHTML=state.albums.map(a=>`
    <div class="album-card" onclick="openAlbum(${a.id})" style="cursor:pointer;">
      <span class="album-emoji">${a.emoji}</span>
      <div class="album-name">${a.name}</div>
      <div class="album-desc">${a.desc}</div>
      <div style="margin-top:8px;font-size:12px;color:var(--text-muted);"><i class="fas fa-images"></i> ${(a.photos||[]).length} photos</div>
      <button class="tbl-btn danger" style="margin-top:10px;" onclick="event.stopPropagation();deleteAlbum(${a.id})"><i class="fas fa-trash"></i> Delete Album</button>
    </div>`).join('');
}

function openAlbum(id) {
  currentAlbumId = id;
  const album = state.albums.find(a=>a.id===id);
  if (!album) return;
  document.getElementById('galleryAlbumsView').style.display = 'none';
  document.getElementById('galleryPhotosView').style.display = 'block';
  document.getElementById('backToAlbumsBtn').style.display = 'inline-flex';
  document.getElementById('addAlbumBtn').style.display = 'none';
  document.getElementById('currentAlbumTitle').textContent = album.emoji + ' ' + album.name;
  document.getElementById('currentAlbumDesc').textContent = album.desc;
  renderAlbumPhotos(album);
}

function renderAlbumPhotos(album) {
  const grid = document.getElementById('galleryPhotosGrid');
  if (!(album.photos||[]).length) {
    grid.innerHTML = `<p class="empty-state" style="grid-column:1/-1;"><i class="fas fa-camera"></i> No photos yet. Click "Upload Photos" to add some.</p>`;
    return;
  }
  grid.innerHTML = album.photos.map((p,i)=>`
    <div class="photo-thumb" onclick="openLightbox(${album.id},${i})">
      <img src="${p.src}" alt="${p.name}" style="width:100%;height:100%;object-fit:cover;"/>
      <div class="photo-overlay">
        <button class="photo-action-btn" onclick="event.stopPropagation();downloadPhoto(${album.id},${i})"><i class="fas fa-download"></i></button>
        <button class="photo-action-btn" onclick="event.stopPropagation();printPhoto(${album.id},${i})"><i class="fas fa-print"></i></button>
        <button class="photo-action-btn danger" onclick="event.stopPropagation();deletePhoto(${album.id},${i})"><i class="fas fa-trash"></i></button>
      </div>
    </div>`).join('');
}

function openLightbox(albumId, photoIndex) {
  const album = state.albums.find(a=>a.id===albumId);
  if (!album) return;
  const photo = album.photos[photoIndex];
  document.getElementById('lightboxImg').src = photo.src;
  document.getElementById('lightboxTitle').textContent = photo.name;
  document.getElementById('lightboxDownload').onclick = ()=>downloadPhoto(albumId,photoIndex);
  document.getElementById('lightboxPrint').onclick = ()=>printPhoto(albumId,photoIndex);
  document.getElementById('lightboxDelete').onclick = ()=>{ deletePhoto(albumId,photoIndex); document.getElementById('photoLightbox').classList.remove('open'); };
  document.getElementById('photoLightbox').classList.add('open');
}

function downloadPhoto(albumId, photoIndex) {
  const album = state.albums.find(a=>a.id===albumId);
  if (!album) return;
  const photo = album.photos[photoIndex];
  const a = document.createElement('a');
  a.href = photo.src;
  a.download = photo.name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  showToast('✅ Photo downloaded!');
}

function printPhoto(albumId, photoIndex) {
  const album = state.albums.find(a=>a.id===albumId);
  if (!album) return;
  const photo = album.photos[photoIndex];
  const win = window.open('','_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>${photo.name}</title><style>body{margin:0;display:grid;place-items:center;min-height:100vh;}img{max-width:100%;max-height:100vh;object-fit:contain;}</style></head><body><img src="${photo.src}" onload="window.print();window.close();"/></body></html>`);
  win.document.close();
}

function deletePhoto(albumId, photoIndex) {
  if (!confirm('Delete this photo?')) return;
  const album = state.albums.find(a=>a.id===albumId);
  if (!album) return;
  album.photos.splice(photoIndex, 1);
  renderAlbumPhotos(album);
  showToast('🗑️ Photo deleted.');
}

function deleteAlbum(id) {
  if (!confirm('Delete this entire album and all its photos?')) return;
  state.albums = state.albums.filter(a=>a.id!==id);
  renderGallery();
  showToast('🗑️ Album deleted.');
}

function initGallery() {
  renderGallery();
  document.getElementById('addAlbumBtn').addEventListener('click',()=>document.getElementById('albumModal').classList.add('open'));
  document.getElementById('closeAlbumModal').addEventListener('click',()=>document.getElementById('albumModal').classList.remove('open'));
  document.getElementById('cancelAlbumModal').addEventListener('click',()=>document.getElementById('albumModal').classList.remove('open'));
  document.getElementById('saveAlbumBtn').addEventListener('click',()=>{
    const name=document.getElementById('albumName').value.trim();
    const desc=document.getElementById('albumDesc').value.trim();
    const emoji=document.getElementById('albumEmoji').value.trim()||'📁';
    if (!name){ showToast('⚠️ Album name required.'); return; }
    state.albums.push({id:state.nextAlbumId++,name,desc,emoji,photos:[]});
    renderGallery();
    document.getElementById('albumModal').classList.remove('open');
    ['albumName','albumDesc','albumEmoji'].forEach(i=>document.getElementById(i).value='');
    showToast(`✅ Album "${name}" created!`);
  });
  document.getElementById('backToAlbumsBtn').addEventListener('click',()=>{
    document.getElementById('galleryAlbumsView').style.display = 'block';
    document.getElementById('galleryPhotosView').style.display = 'none';
    document.getElementById('backToAlbumsBtn').style.display = 'none';
    document.getElementById('addAlbumBtn').style.display = 'inline-flex';
    currentAlbumId = null;
    renderGallery();
  });
  document.getElementById('photoUploadInput').addEventListener('change', e=>{
    const album = state.albums.find(a=>a.id===currentAlbumId);
    if (!album) return;
    const files = Array.from(e.target.files);
    let loaded = 0;
    files.forEach(file=>{
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = ev => {
        album.photos.push({ src: ev.target.result, name: file.name });
        loaded++;
        if (loaded === files.length) {
          renderAlbumPhotos(album);
          showToast(`✅ ${loaded} photo(s) uploaded!`);
        }
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  });
  document.getElementById('printAllPhotosBtn').addEventListener('click',()=>{
    const album = state.albums.find(a=>a.id===currentAlbumId);
    if (!album||!album.photos.length){ showToast('⚠️ No photos to print.'); return; }
    const win = window.open('','_blank');
    win.document.write(`<!DOCTYPE html><html><head><title>${album.name}</title><style>body{margin:20px;font-family:sans-serif;}h1{text-align:center;margin-bottom:20px;}img{max-width:48%;margin:1%;border-radius:8px;page-break-inside:avoid;}</style></head><body><h1>${album.emoji} ${album.name}</h1>${album.photos.map(p=>`<img src="${p.src}" alt="${p.name}"/>`).join('')}<script>window.onload=function(){window.print();window.close();}<\/script></body></html>`);
    win.document.close();
  });
  document.getElementById('closeLightbox').addEventListener('click',()=>document.getElementById('photoLightbox').classList.remove('open'));
}

// ── WEEKLY WORK OUTPUT ──
function renderWeekly(filter='', cls='') {
  const tbody = document.getElementById('weeklyTbody');
  let data = state.weeklyRecords;
  if (filter) data = data.filter(w=>`${w.teacher} ${w.subject}`.toLowerCase().includes(filter.toLowerCase()));
  if (cls) data = data.filter(w=>w.cls===cls);
  if (!data.length){ tbody.innerHTML=`<tr><td colspan="8" style="text-align:center;color:var(--text-light);padding:28px;">No weekly records yet. Click "Add Weekly Record" to start.</td></tr>`; return; }
  tbody.innerHTML = data.map((w,i)=>`
    <tr>
      <td>${i+1}</td>
      <td><strong>${w.week}</strong></td>
      <td>${w.teacher}</td>
      <td>${w.subject}</td>
      <td>${w.cls}</td>
      <td style="text-align:center;font-weight:600;">${w.exercises}</td>
      <td>${w.homework||'—'}</td>
      <td>
        <button class="tbl-btn" onclick="editWeekly(${w.id})"><i class="fas fa-edit"></i></button>
        <button class="tbl-btn danger" onclick="deleteWeekly(${w.id})"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`).join('');
}

function initWeekly() {
  renderWeekly();
  document.getElementById('weeklySearch').addEventListener('input',function(){ renderWeekly(this.value, document.getElementById('weeklyClassFilter').value); });
  document.getElementById('weeklyClassFilter').addEventListener('change',function(){ renderWeekly(document.getElementById('weeklySearch').value, this.value); });
  document.getElementById('addWeeklyBtn').addEventListener('click',()=>{
    document.getElementById('weeklyModalTitle').textContent='Add Weekly Record';
    document.getElementById('wEditId').value='';
    clearWeeklyModal();
    document.getElementById('weeklyModal').classList.add('open');
  });
  document.getElementById('closeWeeklyModal').addEventListener('click',()=>document.getElementById('weeklyModal').classList.remove('open'));
  document.getElementById('cancelWeeklyModal').addEventListener('click',()=>document.getElementById('weeklyModal').classList.remove('open'));
  document.getElementById('saveWeeklyBtn').addEventListener('click', saveWeekly);
}

function saveWeekly() {
  const week = document.getElementById('wWeek').value.trim();
  const teacher = document.getElementById('wTeacher').value.trim();
  const subject = document.getElementById('wSubject').value.trim();
  const cls = document.getElementById('wClass').value;
  const exercises = parseInt(document.getElementById('wExercises').value)||0;
  const homework = document.getElementById('wHomework').value.trim();
  const editId = document.getElementById('wEditId').value;
  if (!week||!teacher||!subject){ showToast('⚠️ Please fill in week, teacher and subject.'); return; }
  if (editId){
    const w = state.weeklyRecords.find(w=>w.id===parseInt(editId));
    if (w){ w.week=week; w.teacher=teacher; w.subject=subject; w.cls=cls; w.exercises=exercises; w.homework=homework; }
    showToast('✅ Record updated!');
  } else {
    state.weeklyRecords.push({ id:state.nextWeeklyId++, week, teacher, subject, cls, exercises, homework });
    showToast('✅ Weekly record saved!');
  }
  renderWeekly(); autosave();
  document.getElementById('weeklyModal').classList.remove('open');
  clearWeeklyModal();
}

function editWeekly(id) {
  const w = state.weeklyRecords.find(w=>w.id===id); if (!w) return;
  document.getElementById('weeklyModalTitle').textContent='Edit Weekly Record';
  document.getElementById('wEditId').value=id;
  document.getElementById('wWeek').value=w.week;
  document.getElementById('wTeacher').value=w.teacher;
  document.getElementById('wSubject').value=w.subject;
  document.getElementById('wClass').value=w.cls;
  document.getElementById('wExercises').value=w.exercises;
  document.getElementById('wHomework').value=w.homework||'';
  document.getElementById('weeklyModal').classList.add('open');
}

function deleteWeekly(id) {
  if (!confirm('Delete this weekly record?')) return;
  state.weeklyRecords = state.weeklyRecords.filter(w=>w.id!==id);
  renderWeekly(); autosave(); showToast('🗑️ Record deleted.');
}

function clearWeeklyModal(){ ['wWeek','wTeacher','wSubject','wExercises','wHomework'].forEach(i=>document.getElementById(i).value=''); }

// ── TEACHERS ──
const AVATAR_COLORS=['#1a6fd4','#0891b2','#16a34a','#d97706','#9333ea','#dc2626'];

function renderTeachers(filter='', cls='') {
  const tbody=document.getElementById('teacherTbody');
  let data=state.teachers;
  if (filter) data=data.filter(t=>`${t.first} ${t.last}`.toLowerCase().includes(filter.toLowerCase()));
  if (cls) data=data.filter(t=>t.assigned.includes(cls));
  if (!data.length){ tbody.innerHTML=`<tr><td colspan="6" style="text-align:center;color:var(--text-light);padding:28px;">No teachers found.</td></tr>`; renderTeacherCards(data); return; }
  tbody.innerHTML=data.map((t,i)=>`
    <tr>
      <td>${i+1}</td>
      <td><strong>${t.first} ${t.last}</strong></td>
      <td>${t.subject}</td>
      <td>${t.assigned}</td>
      <td>${t.qualification}</td>
      <td>
        <button class="tbl-btn" onclick="editTeacher(${t.id})"><i class="fas fa-edit"></i> Edit</button>
        <button class="tbl-btn danger" onclick="deleteTeacher(${t.id})"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`).join('');
  renderTeacherCards(data);
}

function renderTeacherCards(data) {
  const c=document.getElementById('teachersGrid');
  if (!data.length){ c.innerHTML=''; return; }
  c.innerHTML=data.map((t,i)=>`
    <div class="teacher-card">
      <div class="teacher-avatar" style="background:${AVATAR_COLORS[i%AVATAR_COLORS.length]}">${t.first.charAt(0)}${t.last.charAt(0)}</div>
      <div class="teacher-name">${t.first} ${t.last}</div>
      <div class="teacher-subject">${t.subject}</div>
      <span class="teacher-class">${t.assigned}</span>
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">${t.qualification}</div>
    </div>`).join('');
}

function initTeachers() {
  renderTeachers();
  document.getElementById('teacherSearch').addEventListener('input',function(){ renderTeachers(this.value, document.getElementById('teacherClassFilter').value); });
  document.getElementById('teacherClassFilter').addEventListener('change',function(){ renderTeachers(document.getElementById('teacherSearch').value,this.value); });
  document.getElementById('addTeacherBtn').addEventListener('click',()=>{
    document.getElementById('teacherModalTitle').textContent='Add Teacher';
    document.getElementById('tEditId').value='';
    clearTeacherModal();
    document.getElementById('teacherModal').classList.add('open');
  });
  document.getElementById('closeTeacherModal').addEventListener('click',()=>document.getElementById('teacherModal').classList.remove('open'));
  document.getElementById('cancelTeacherModal').addEventListener('click',()=>document.getElementById('teacherModal').classList.remove('open'));
  document.getElementById('saveTeacherBtn').addEventListener('click', saveTeacher);
}

function saveTeacher() {
  const first=document.getElementById('tFirst').value.trim();
  const last=document.getElementById('tLast').value.trim();
  const subject=document.getElementById('tSubject').value.trim();
  const assigned=document.getElementById('tAssigned').value.trim();
  const qualification=document.getElementById('tQualification').value;
  const phone=document.getElementById('tPhone').value.trim();
  const editId=document.getElementById('tEditId').value;
  if (!first||!last){ showToast('⚠️ Enter teacher\'s full name.'); return; }
  if (editId){
    const t=state.teachers.find(t=>t.id===parseInt(editId));
    if (t){ t.first=first; t.last=last; t.subject=subject||'TBA'; t.assigned=assigned||'TBA'; t.qualification=qualification; t.phone=phone; }
    showToast(`✅ ${first} ${last} updated!`);
  } else {
    state.teachers.push({id:state.nextTeacherId++,first,last,subject:subject||'TBA',assigned:assigned||'TBA',qualification,phone});
    showToast(`✅ ${first} ${last} added to staff!`);
    // Auto-create Teacher user account
    const newTeacher = state.teachers[state.teachers.length - 1];
    autoCreateTeacherUser(newTeacher);
  }
  renderTeachers(); updateDashStats(); autosave();
  document.getElementById('teacherModal').classList.remove('open'); clearTeacherModal();
}

function editTeacher(id) {
  const t=state.teachers.find(t=>t.id===id); if (!t) return;
  document.getElementById('teacherModalTitle').textContent='Edit Teacher';
  document.getElementById('tEditId').value=id;
  document.getElementById('tFirst').value=t.first;
  document.getElementById('tLast').value=t.last;
  document.getElementById('tSubject').value=t.subject;
  document.getElementById('tAssigned').value=t.assigned;
  document.getElementById('tQualification').value=t.qualification;
  document.getElementById('tPhone').value=t.phone||'';
  document.getElementById('teacherModal').classList.add('open');
}

function deleteTeacher(id) {
  if (!confirm('Remove this teacher record?')) return;
  state.teachers=state.teachers.filter(t=>t.id!==id); renderTeachers(); updateDashStats(); autosave(); showToast('🗑️ Teacher removed.');
}
function clearTeacherModal(){ ['tFirst','tLast','tSubject','tAssigned','tPhone'].forEach(i=>document.getElementById(i).value=''); }

// ── CLASSES ──
function renderClasses() {
  const tbody=document.getElementById('classTbody');
  const grid=document.getElementById('classesGrid');
  if (!state.classes.length){ tbody.innerHTML=`<tr><td colspan="6" style="text-align:center;padding:28px;color:var(--text-light);">No classes added.</td></tr>`; grid.innerHTML=''; return; }
  tbody.innerHTML=state.classes.map((c,i)=>{
    const count=state.students.filter(s=>s.cls===c.name).length;
    return `<tr>
      <td>${i+1}</td><td><strong>${c.name}</strong></td><td>${c.teacher}</td>
      <td>${count} pupils</td><td>${c.level}</td>
      <td>
        <button class="tbl-btn" onclick="editClass(${c.id})"><i class="fas fa-edit"></i> Edit</button>
        <button class="tbl-btn danger" onclick="deleteClass(${c.id})"><i class="fas fa-trash"></i></button>
      </td></tr>`;
  }).join('');
  grid.innerHTML=state.classes.map(c=>{
    const count=state.students.filter(s=>s.cls===c.name).length;
    return `<div class="class-card">
      <div class="class-name">${c.name}</div>
      <div class="class-count"><i class="fas fa-users"></i> ${count} pupils</div>
      <div class="class-teacher"><i class="fas fa-chalkboard-teacher"></i> ${c.teacher}</div>
      <div style="font-size:11px;margin-top:4px;"><span style="background:var(--blue-light);color:var(--blue);padding:2px 8px;border-radius:30px;font-size:11px;font-weight:600;">${c.level}</span></div>
    </div>`;
  }).join('');
}

function populateClassTeacherDropdown(selectedValue) {
  const sel = document.getElementById('cTeacher');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Select Teacher (or type below) --</option><option value="TBA">TBA / Not Assigned</option>';
  state.teachers.forEach(t => {
    const name = `${t.first} ${t.last}`;
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${name} (${t.subject || '—'})`;
    if (selectedValue === name) opt.selected = true;
    sel.appendChild(opt);
  });
  if (selectedValue) sel.value = selectedValue;
}

function initClasses() {
  renderClasses();
  document.getElementById('addClassBtn').addEventListener('click',()=>{
    document.getElementById('classModalTitle').textContent='Add Class';
    document.getElementById('cEditId').value='';
    document.getElementById('cName').value='';
    document.getElementById('cLevel').value='Basic School';
    populateClassTeacherDropdown('');
    document.getElementById('classModal').classList.add('open');
  });
  document.getElementById('closeClassModal').addEventListener('click',()=>document.getElementById('classModal').classList.remove('open'));
  document.getElementById('cancelClassModal').addEventListener('click',()=>document.getElementById('classModal').classList.remove('open'));
  document.getElementById('saveClassBtn').addEventListener('click', saveClass);
}

function saveClass() {
  const name=document.getElementById('cName').value.trim();
  const level=document.getElementById('cLevel').value;
  const teacher=document.getElementById('cTeacher').value.trim();
  const editId=document.getElementById('cEditId').value;
  if (!name){ showToast('⚠️ Enter class name.'); return; }
  if (editId){
    const c=state.classes.find(c=>c.id===parseInt(editId));
    if (c){ c.name=name; c.level=level; c.teacher=teacher||'TBA'; }
    showToast(`✅ Class ${name} updated!`);
  } else {
    state.classes.push({id:state.nextClassId++,name,level,teacher:teacher||'TBA'});
    showToast(`✅ Class ${name} added!`);
  }
  renderClasses(); autosave();
  document.getElementById('classModal').classList.remove('open');
}

function editClass(id) {
  const c=state.classes.find(c=>c.id===id); if (!c) return;
  document.getElementById('classModalTitle').textContent='Edit Class';
  document.getElementById('cEditId').value=id;
  document.getElementById('cName').value=c.name;
  document.getElementById('cLevel').value=c.level||'Basic School';
  populateClassTeacherDropdown(c.teacher);
  document.getElementById('classModal').classList.add('open');
}

function deleteClass(id) {
  if (!confirm('Delete this class?')) return;
  state.classes=state.classes.filter(c=>c.id!==id); renderClasses(); autosave(); showToast('🗑️ Class removed.');
}

// ── SETTINGS ──
function initSettings() {
  const s=state.settings;
  document.getElementById('schoolName').value=s.schoolName;
  document.getElementById('sessionYear').value=s.session;
  document.getElementById('schoolAddress').value=s.address;
  document.getElementById('principalName').value=s.principal;
  document.getElementById('gesDistrict').value=s.district;
  document.getElementById('schoolMotto').value=s.motto;
  // Render theme swatches whenever settings section opens
  renderThemeSwatches();

  document.getElementById('saveSettingsBtn').addEventListener('click',()=>{
    s.schoolName=document.getElementById('schoolName').value;
    s.session=document.getElementById('sessionYear').value;
    s.address=document.getElementById('schoolAddress').value;
    s.principal=document.getElementById('principalName').value;
    s.district=document.getElementById('gesDistrict').value;
    s.motto=document.getElementById('schoolMotto').value;
    document.getElementById('sidebarSchoolName').textContent=s.schoolName;
    const d=document.getElementById('settingsSaved');
    d.style.display='flex'; setTimeout(()=>d.style.display='none',3000);
    autosave();
    showToast('✅ School settings saved!');
  });
}

// ── LOGO ──
function initLogo() {
  const fileInput=document.getElementById('logoFileInput');
  const previewImg=document.getElementById('logoPreviewImg');
  const placeholder=document.getElementById('logoPlaceholder');
  const removeBtn=document.getElementById('removeLogoBtn');

  if (state.schoolLogo) applyLogo(state.schoolLogo);

  fileInput.addEventListener('change',e=>{
    const file=e.target.files[0]; if (!file) return;
    if (!file.type.startsWith('image/')){ showToast('⚠️ Please select an image file.'); return; }
    if (file.size>2*1024*1024){ showToast('⚠️ Image must be under 2MB.'); return; }
    const reader=new FileReader();
    reader.onload=ev=>{ state.schoolLogo=ev.target.result; applyLogo(ev.target.result); showToast('✅ School logo uploaded!'); };
    reader.readAsDataURL(file);
  });

  removeBtn.addEventListener('click',()=>{
    state.schoolLogo=null;
    previewImg.src=''; previewImg.style.display='none';
    placeholder.style.display='flex'; removeBtn.style.display='none';
    document.getElementById('sidebarLogoImg').style.display='none';
    document.getElementById('brandIconDefault').style.display='grid';
    document.getElementById('headerLogoWrap').style.display='none';
    showToast('🗑️ Logo removed.');
  });
}

function applyLogo(src) {
  // Preview
  const previewImg=document.getElementById('logoPreviewImg');
  previewImg.src=src; previewImg.style.display='block';
  document.getElementById('logoPlaceholder').style.display='none';
  document.getElementById('removeLogoBtn').style.display='flex';
  // Sidebar
  const sidebarImg=document.getElementById('sidebarLogoImg');
  sidebarImg.src=src; sidebarImg.style.display='block';
  document.getElementById('brandIconDefault').style.display='none';
  // Header
  const headerImg=document.getElementById('headerLogoImg');
  headerImg.src=src;
  document.getElementById('headerLogoWrap').style.display='block';
}

// ── BACKUP ──
function initBackup() {
  document.getElementById('exportBackupBtn').addEventListener('click', exportBackup);
  document.getElementById('importBackupBtn').addEventListener('click',()=>document.getElementById('importFileInput').click());
  document.getElementById('importFileInput').addEventListener('change', importBackup);
  // Drag-and-drop restore zone
  const dropZone = document.getElementById('restoreDropZone');
  if (dropZone) {
    dropZone.addEventListener('dragover', e=>{ e.preventDefault(); dropZone.style.borderStyle='solid'; });
    dropZone.addEventListener('dragleave', ()=>{ dropZone.style.borderStyle='dashed'; });
    dropZone.addEventListener('drop', e=>{
      e.preventDefault(); dropZone.style.borderStyle='dashed';
      const file = e.dataTransfer.files[0];
      if (file && file.name.endsWith('.json')) {
        const fakeEvent = { target:{ files:[file], value:'' } };
        importBackup(fakeEvent);
      } else { showToast('⚠️ Please drop a valid .json backup file.'); }
    });
  }
  document.getElementById('guideToggle').addEventListener('click',()=>{
    const c=document.getElementById('guideContent');
    c.style.display=c.style.display==='none'?'block':'none';
  });
  document.getElementById('saveClientIdBtn').addEventListener('click',()=>{
    const id=document.getElementById('googleClientId').value.trim();
    if (!id){ showToast('⚠️ Please enter your Google Client ID.'); return; }
    state.driveClientId=id;
    loadGoogleIdentity();
    showToast('✅ Client ID saved. Loading Google Sign-In...');
  });
  document.getElementById('googleSignInBtn').addEventListener('click', handleGoogleSignIn);
  document.getElementById('googleSignOutBtn').addEventListener('click', handleGoogleSignOut);
  document.getElementById('saveToDriveBtn').addEventListener('click', saveToDrive);
  renderBackupHistory();
  updateBackupInfo();
}

function buildBackupData() {
  return {
    version: '2.0',
    appName: 'EduManage Pro — GES Edition',
    school: state.settings.schoolName,
    exportedAt: new Date().toISOString(),
    exportedBy: state.currentUser ? state.currentUser.name : 'Admin',

    // ── SCHOOL CONFIGURATION ──
    settings: state.settings,
    schoolLogo: state.schoolLogo,
    driveClientId: state.driveClientId,

    // ── PEOPLE ──
    students: state.students,
    teachers: state.teachers,
    users: state.users || [],

    // ── ACADEMIC ──
    classes: state.classes,
    reports: state.reports,
    weeklyRecords: state.weeklyRecords,
    attendance: state.attendance || [],

    // ── FINANCE ──
    fees: state.fees,
    expenditures: state.expenditures || [],

    // ── RESOURCES ──
    resources: state.resources || [],

    // ── EXAMS & TRANSFERS ──
    exams: state.exams || [],
    transfers: state.transfers || [],

    // ── COMMUNICATION ──
    announcements: state.announcements || [],
    parentNotifications: state.parentNotifications || [],

    // ── GALLERY ──
    albums: state.albums,

    // ── ID COUNTERS ──
    counters: {
      nextStudentId:    state.nextStudentId,
      nextFeeId:        state.nextFeeId,
      nextTeacherId:    state.nextTeacherId,
      nextClassId:      state.nextClassId,
      nextAlbumId:      state.nextAlbumId,
      nextWeeklyId:     state.nextWeeklyId,
      nextAttendanceId: state.nextAttendanceId || 1,
      nextUserId:       state.nextUserId || 3,
      nextResourceId:   state.nextResourceId || 1,
      nextExamId:       state.nextExamId || 1,
      nextTransferId:   state.nextTransferId || 1,
      nextAnnouncementId: state.nextAnnouncementId || 1,
      nextPNId:         state.nextPNId || 1,
    },

    // ── HUMAN-READABLE SUMMARY ──
    summary: {
      totalPupils:            state.students.length,
      totalTeachers:          state.teachers.length,
      totalClasses:           state.classes.length,
      totalFeeRecords:        state.fees.length,
      totalReports:           state.reports.length,
      totalAttendanceRecords: (state.attendance||[]).length,
      totalWeeklyRecords:     state.weeklyRecords.length,
      totalAlbums:            state.albums.length,
      totalPhotos:            state.albums.reduce((a,al)=>a+(al.photos||[]).length, 0),
      totalUsers:             (state.users||[]).length,
      feesCollected:          state.fees.reduce((a,f)=>a+f.paid, 0),
      feesOutstanding:        state.fees.reduce((a,f)=>a+(f.due-f.paid), 0),
    },
  };
}

function exportBackup() {
  const data = buildBackupData();
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], {type:'application/json'});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const ts   = new Date().toLocaleDateString('en-GH').replace(/\//g,'-');
  const fname = `edumanage_backup_${ts}.json`;
  a.href = url; a.download = fname;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const s = data.summary;
  const entry = {
    type: 'local', name: fname,
    date: new Date().toLocaleString('en-GH'),
    records: `${s.totalPupils} pupils · ${s.totalTeachers} teachers · ${s.totalFeeRecords} fees · ${s.totalReports} reports · ${s.totalAttendanceRecords} attendance · ${s.totalWeeklyRecords} weekly · ${s.totalPhotos} photos`
  };
  state.backupHistory.unshift(entry);
  renderBackupHistory();
  updateBackupInfo();
  autosave();
  showToast('✅ Full backup exported — includes all settings, pupils, fees, reports, attendance, gallery & more.');
}

function importBackup(e) {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);

      // Basic validation — must have at least settings or students
      if (!data.settings && !data.students) {
        showToast('⚠️ Invalid backup file. Could not find school data.'); return;
      }

      // Build confirmation message with summary
      const exportedAt = data.exportedAt ? new Date(data.exportedAt).toLocaleString('en-GH') : 'unknown date';
      const s = data.summary;
      const summaryLines = s
        ? `\n\n📋 This backup contains:\n• ${s.totalPupils||0} pupils  • ${s.totalTeachers||0} teachers\n• ${s.totalFeeRecords||0} fee records  • ${s.totalReports||0} report cards\n• ${s.totalAttendanceRecords||0} attendance records  • ${s.totalWeeklyRecords||0} weekly records\n• ${s.totalPhotos||0} gallery photos  • ${s.totalUsers||0} user accounts`
        : '';
      if (!confirm(`Restore full backup from ${exportedAt}?${summaryLines}\n\n⚠️ This will REPLACE all current data. Continue?`)) return;

      // ── RESTORE ALL DATA ──
      if (data.students)      state.students      = data.students;
      if (data.fees)          state.fees          = data.fees;
      if (data.teachers)      state.teachers      = data.teachers;
      if (data.classes)       state.classes       = data.classes;
      if (data.albums)        state.albums        = data.albums;
      if (data.reports)       state.reports       = data.reports;
      if (data.weeklyRecords) state.weeklyRecords = data.weeklyRecords;
      if (data.attendance)    state.attendance    = data.attendance;
      if (data.users)         state.users         = data.users;
    if (data.expenditures)  state.expenditures  = data.expenditures;
      if (data.resources)     state.resources     = data.resources || [];
      if (data.exams)         state.exams         = data.exams || [];
      if (data.transfers)     state.transfers     = data.transfers || [];
      if (data.announcements) state.announcements = data.announcements || [];
      if (data.parentNotifications) state.parentNotifications = data.parentNotifications || [];
      if (data.settings)      Object.assign(state.settings, data.settings);
      if (data.schoolLogo)    state.schoolLogo    = data.schoolLogo;
      if (data.driveClientId) state.driveClientId = data.driveClientId;
      if (data.backupHistory) state.backupHistory = data.backupHistory;

      // ── RESTORE ID COUNTERS ──
      if (data.counters) {
        state.nextStudentId    = data.counters.nextStudentId    || Math.max(0,...(data.students||[]).map(x=>x.id))+1;
        state.nextFeeId        = data.counters.nextFeeId        || Math.max(0,...(data.fees||[]).map(x=>x.id))+1;
        state.nextTeacherId    = data.counters.nextTeacherId    || Math.max(0,...(data.teachers||[]).map(x=>x.id))+1;
        state.nextClassId      = data.counters.nextClassId      || Math.max(0,...(data.classes||[]).map(x=>x.id))+1;
        state.nextAlbumId      = data.counters.nextAlbumId      || Math.max(0,...(data.albums||[]).map(x=>x.id))+1;
        state.nextWeeklyId     = data.counters.nextWeeklyId     || Math.max(0,...(data.weeklyRecords||[]).map(x=>x.id))+1;
        state.nextAttendanceId = data.counters.nextAttendanceId || Math.max(0,...(data.attendance||[]).map(x=>x.id))+1;
        state.nextUserId       = data.counters.nextUserId       || Math.max(0,...(data.users||[]).map(x=>x.id))+1;
      } else {
        // Legacy v1.0 — derive counters from arrays
        if ((data.students||[]).length)      state.nextStudentId    = Math.max(...data.students.map(x=>x.id))+1;
        if ((data.fees||[]).length)          state.nextFeeId        = Math.max(...data.fees.map(x=>x.id))+1;
        if ((data.teachers||[]).length)      state.nextTeacherId    = Math.max(...data.teachers.map(x=>x.id))+1;
        if ((data.classes||[]).length)       state.nextClassId      = Math.max(...data.classes.map(x=>x.id))+1;
        if ((data.albums||[]).length)        state.nextAlbumId      = Math.max(...data.albums.map(x=>x.id))+1;
        if ((data.weeklyRecords||[]).length) state.nextWeeklyId     = Math.max(...data.weeklyRecords.map(x=>x.id))+1;
      }

      // ── RE-APPLY SETTINGS TO UI ──
      const sv = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };
      const s2 = state.settings;
      sv('schoolName',    s2.schoolName);
      sv('sessionYear',   s2.session);
      sv('schoolAddress', s2.address);
      sv('principalName', s2.principal);
      sv('gesDistrict',   s2.district);
      sv('schoolMotto',   s2.motto);
      sv('currentTerm',   s2.term);
      const nameEl = document.getElementById('sidebarSchoolName');
      if (nameEl) nameEl.textContent = s2.schoolName || 'EduManage';

      // ── RE-APPLY LOGO ──
      if (data.schoolLogo) applyLogo(data.schoolLogo);

      // ── RE-RENDER ALL SECTIONS ──
      renderStudents();
      renderFees();
      renderTeachers();
      renderClasses();
      renderGallery();
      renderSavedReports();
      renderWeekly();
      if (typeof renderAttendance === 'function') renderAttendance();
      if (typeof renderUsers === 'function') renderUsers();
      if (typeof renderResources === 'function') renderResources();
      if (typeof renderExams === 'function')     renderExams();
      if (typeof renderTransfers === 'function') renderTransfers();
      if (typeof renderAnnouncements === 'function') renderAnnouncements();
      updateDashStats();
      updateFeeStats();
      renderBackupHistory();
      updateBackupInfo();

      // ── PERSIST RESTORED DATA ──
      saveToDB();
      showToast('✅ Full backup restored — all settings, pupils, fees, reports, attendance, gallery & accounts are back!');
    } catch (err) {
      console.error(err);
      showToast('⚠️ Could not read backup file. It may be corrupted or invalid.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function updateBackupInfo() {
  const el = document.getElementById('backupInfo');
  if (!el) return;
  const totalPhotos = state.albums.reduce((a,al)=>a+(al.photos||[]).length, 0);
  const collected   = state.fees.reduce((a,f)=>a+f.paid, 0);
  const outstanding = state.fees.reduce((a,f)=>a+(f.due-f.paid), 0);
  el.innerHTML = `
    <div class="backup-summary-grid">
      <div class="bsg-item"><i class="fas fa-user-graduate"></i><div><strong>${state.students.length}</strong><span>Pupils</span></div></div>
      <div class="bsg-item"><i class="fas fa-chalkboard-teacher"></i><div><strong>${state.teachers.length}</strong><span>Teachers</span></div></div>
      <div class="bsg-item"><i class="fas fa-school"></i><div><strong>${state.classes.length}</strong><span>Classes</span></div></div>
      <div class="bsg-item"><i class="fas fa-file-alt"></i><div><strong>${state.reports.length}</strong><span>Report Cards</span></div></div>
      <div class="bsg-item"><i class="fas fa-clipboard-check"></i><div><strong>${(state.attendance||[]).length}</strong><span>Attendance Records</span></div></div>
      <div class="bsg-item"><i class="fas fa-calendar-week"></i><div><strong>${state.weeklyRecords.length}</strong><span>Weekly Records</span></div></div>
      <div class="bsg-item"><i class="fas fa-images"></i><div><strong>${totalPhotos}</strong><span>Gallery Photos</span></div></div>
      <div class="bsg-item"><i class="fas fa-users-cog"></i><div><strong>${(state.users||[]).length}</strong><span>User Accounts</span></div></div>
      <div class="bsg-item bsg-green"><i class="fas fa-money-bill-wave"></i><div><strong>${fmt(collected)}</strong><span>Fees Collected</span></div></div>
      <div class="bsg-item bsg-red"><i class="fas fa-exclamation-circle"></i><div><strong>${fmt(outstanding)}</strong><span>Fees Outstanding</span></div></div>
    </div>`;
}

function renderBackupHistory() {
  const c=document.getElementById('backupHistory');
  if (!state.backupHistory.length){ c.innerHTML=`<p class="empty-state"><i class="fas fa-cloud-arrow-up"></i> No backups yet.</p>`; return; }
  c.innerHTML=state.backupHistory.map(b=>`
    <div class="backup-history-item">
      <div class="bh-info">
        <span class="bh-name"><i class="fas fa-file-code"></i> ${b.name}</span>
        <span class="bh-meta">${b.date} · ${b.records}</span>
      </div>
      <span class="bh-badge ${b.type==='drive'?'bh-drive':'bh-local'}">${b.type==='drive'?'<i class="fab fa-google-drive"></i> Drive':'<i class="fas fa-download"></i> Local'}</span>
    </div>`).join('');
}

// GOOGLE DRIVE OAUTH
function loadGoogleIdentity() {
  if (!state.driveClientId) return;
  const script=document.createElement('script');
  script.src='https://accounts.google.com/gsi/client';
  script.onload=()=>{ console.log('Google Identity loaded'); };
  document.head.appendChild(script);
}

function handleGoogleSignIn() {
  if (!state.driveClientId){
    document.getElementById('guideContent').style.display='block';
    showToast('⚠️ Please set up your Google Client ID first (see guide below).');
    return;
  }
  try {
    google.accounts.oauth2.initTokenClient({
      client_id: state.driveClientId,
      scope:'https://www.googleapis.com/auth/drive.file',
      callback:(resp)=>{
        if (resp.access_token){
          state.driveUser={ token:resp.access_token, name:'Google User', email:'connected@gmail.com' };
          showDriveConnected();
          showToast('✅ Connected to Google Drive!');
        }
      }
    }).requestAccessToken();
  } catch(e){
    showToast('⚠️ Google Sign-In not available. Add your Client ID first.');
  }
}

function handleGoogleSignOut() {
  state.driveUser=null;
  document.getElementById('driveConnected').style.display='none';
  document.getElementById('driveNotConnected').style.display='flex';
  showToast('Signed out of Google Drive.');
}

function showDriveConnected() {
  const u=state.driveUser;
  document.getElementById('driveNotConnected').style.display='none';
  document.getElementById('driveConnected').style.display='block';
  document.getElementById('driveUserInfo').innerHTML=`
    <div style="width:38px;height:38px;border-radius:50%;background:var(--green);display:grid;place-items:center;font-size:18px;">✅</div>
    <div><div class="du-name">Connected to Google Drive</div><div class="du-email">${u.email}</div></div>`;
}

async function saveToDrive() {
  if (!state.driveUser){ showToast('⚠️ Not signed in to Google.'); return; }
  const btn=document.getElementById('saveToDriveBtn');
  btn.innerHTML='<i class="fas fa-spinner fa-spin"></i> Saving...';
  btn.disabled=true;
  const data=buildBackupData();
  const json=JSON.stringify(data,null,2);
  const ts=new Date().toLocaleDateString('en-GH').replace(/\//g,'-');
  const fname=`edumanage_backup_${ts}.json`;
  try {
    const meta=new Blob([JSON.stringify({name:fname,mimeType:'application/json'})],{type:'application/json'});
    const content=new Blob([json],{type:'application/json'});
    const form=new FormData();
    form.append('metadata',meta);
    form.append('file',content);
    const res=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',{
      method:'POST',
      headers:{Authorization:`Bearer ${state.driveUser.token}`},
      body:form
    });
    if (res.ok){
      const s = data.summary;
      const entry = {
        type: 'drive', name: fname,
        date: new Date().toLocaleString('en-GH'),
        records: `${s.totalPupils} pupils · ${s.totalTeachers} teachers · ${s.totalFeeRecords} fees · ${s.totalReports} reports · ${s.totalAttendanceRecords} attendance · ${s.totalPhotos} photos`
      };
      state.backupHistory.unshift(entry);
      renderBackupHistory();
      const log=document.getElementById('driveLog');
      log.innerHTML=`✅ Full backup saved to Drive: <strong>${fname}</strong>`;
      autosave();
      log.style.display='block';
      showToast('✅ Backup saved to Google Drive!');
    } else {
      showToast('⚠️ Drive save failed. Token may have expired — sign in again.');
    }
  } catch(e){
    showToast('⚠️ Drive upload error. Check your connection.');
  }
  btn.innerHTML='<i class="fab fa-google-drive"></i> Save Backup to Drive';
  btn.disabled=false;
}

// ── ATTENDANCE REGISTER ──
function renderAttendance(cls='', week='') {
  const tbody = document.getElementById('attendanceTbody');
  let data = state.attendance;
  if (cls) data = data.filter(a=>a.cls===cls);
  if (week) data = data.filter(a=>a.week===week);
  if (!data.length) {
    tbody.innerHTML=`<tr><td colspan="11" style="text-align:center;color:var(--text-light);padding:28px;">No attendance records. Select a class and mark attendance below.</td></tr>`;
    return;
  }
  // Group by week+class
  const grouped = {};
  data.forEach(a=>{
    const key = `${a.cls}|${a.week}`;
    if (!grouped[key]) grouped[key] = { cls:a.cls, week:a.week, records:[] };
    grouped[key].records.push(a);
  });

  tbody.innerHTML = Object.values(grouped).map((g,i)=>{
    const present = g.records.filter(r=>r.status==='Present').length;
    const absent  = g.records.filter(r=>r.status==='Absent').length;
    const late    = g.records.filter(r=>r.status==='Late').length;

    // Cross-reference enrolled pupils in this class for gender breakdown
    const classPupils = state.students.filter(s => s.cls === g.cls);
    const totalEnrolled = classPupils.length;
    const maleEnrolled  = classPupils.filter(s => s.gender === 'Male').length;
    const femaleEnrolled = classPupils.filter(s => s.gender === 'Female').length;

    // Gender-split of present pupils
    const presentIds = g.records.filter(r=>r.status==='Present').map(r=>r.studentId);
    const malesPresent   = classPupils.filter(s => presentIds.includes(s.id) && s.gender === 'Male').length;
    const femalesPresent = classPupils.filter(s => presentIds.includes(s.id) && s.gender === 'Female').length;

    const totalMarked = g.records.length;
    const rate = totalMarked ? Math.round((present / totalMarked) * 100) : 0;
    const rateColor = rate >= 80 ? 'var(--green)' : rate >= 60 ? 'var(--yellow)' : 'var(--red)';

    return `<tr>
      <td>${i+1}</td>
      <td><strong>${g.cls}</strong><br><small style="color:var(--text-muted);">${totalEnrolled} enrolled</small></td>
      <td>${g.week}</td>
      <td style="font-weight:600;">${totalMarked}</td>
      <td style="color:#3b82f6;font-weight:600;">${maleEnrolled}<br><small style="font-weight:400;color:var(--text-muted);">${malesPresent} present</small></td>
      <td style="color:#ec4899;font-weight:600;">${femaleEnrolled}<br><small style="font-weight:400;color:var(--text-muted);">${femalesPresent} present</small></td>
      <td style="color:var(--green);font-weight:600;">${present}</td>
      <td style="color:var(--red);font-weight:600;">${absent}</td>
      <td style="color:var(--yellow);font-weight:600;">${late}</td>
      <td>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="flex:1;background:var(--border);border-radius:20px;height:6px;min-width:50px;"><div style="width:${rate}%;background:${rateColor};height:6px;border-radius:20px;transition:width .5s;"></div></div>
          <span style="font-weight:700;color:${rateColor};font-size:12px;">${rate}%</span>
        </div>
      </td>
      <td>
        <button class="tbl-btn" onclick="printAttendanceSummary('${g.cls}','${g.week.replace(/'/g,"\'")}')" title="Print Summary"><i class="fas fa-print"></i></button>
      </td>
    </tr>`;
  }).join('');
}

function printAttendanceSummary(cls, week) {
  const records = state.attendance.filter(a => a.cls === cls && a.week === week);
  if (!records.length) { showToast('No records for this entry.'); return; }
  const classPupils = state.students.filter(s => s.cls === cls);
  const school = state.settings;
  const present = records.filter(r=>r.status==='Present').length;
  const absent  = records.filter(r=>r.status==='Absent').length;
  const late    = records.filter(r=>r.status==='Late').length;
  const total   = records.length;
  const rate    = total ? Math.round(present/total*100) : 0;
  const maleEnrolled   = classPupils.filter(s=>s.gender==='Male').length;
  const femaleEnrolled = classPupils.filter(s=>s.gender==='Female').length;
  const presentIds     = records.filter(r=>r.status==='Present').map(r=>r.studentId);
  const malesPresent   = classPupils.filter(s=>presentIds.includes(s.id)&&s.gender==='Male').length;
  const femalesPresent = classPupils.filter(s=>presentIds.includes(s.id)&&s.gender==='Female').length;

  const logoHtml = state.schoolLogo ? `<img src="${state.schoolLogo}" style="height:65px;object-fit:contain;"/>` : '🏫';
  const win = window.open('','_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Attendance — ${cls} ${week}</title><style>
    body{font-family:'Segoe UI',Arial,sans-serif;padding:28px;max-width:720px;margin:auto;color:#1a2133;}
    .header{display:flex;align-items:center;gap:16px;border-bottom:3px solid #1a6fd4;padding-bottom:16px;margin-bottom:20px;}
    .school-name{font-size:20px;font-weight:800;color:#1a6fd4;}
    .sub{font-size:12px;color:#64748b;}
    .title{font-size:16px;font-weight:700;margin-bottom:16px;background:#e8f0fe;padding:10px 16px;border-radius:8px;color:#1a6fd4;}
    .stat-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;}
    .stat{background:#f8fafc;border-radius:8px;padding:12px;text-align:center;border:1px solid #e2e8f0;}
    .stat-val{font-size:22px;font-weight:800;}
    .stat-lbl{font-size:11px;color:#64748b;margin-top:2px;}
    .gender-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;}
    .gender-box{border-radius:8px;padding:12px;}
    table{width:100%;border-collapse:collapse;}
    th{background:#1a6fd4;color:#fff;padding:8px 10px;font-size:12px;text-align:left;}
    td{padding:7px 10px;border-bottom:1px solid #eee;font-size:12px;}
    .status-p{color:#16a34a;font-weight:600;} .status-a{color:#dc2626;font-weight:600;} .status-l{color:#d97706;font-weight:600;}
    .rate-bar{background:#e2e8f0;border-radius:20px;height:8px;margin-top:4px;}
    .rate-fill{background:#16a34a;height:8px;border-radius:20px;}
    .footer{margin-top:24px;padding-top:14px;border-top:1px solid #eee;font-size:11px;color:#94a3b8;text-align:center;}
    .sig{display:flex;justify-content:space-between;margin-top:32px;}
    .sig-box{text-align:center;width:180px;}
    .sig-line{border-top:1px solid #333;padding-top:5px;font-size:11px;color:#555;}
  </style></head><body>
  <div class="header">${logoHtml}<div>
    <div class="school-name">${school.schoolName||'School'}</div>
    <div class="sub">${school.address||''} &nbsp;|&nbsp; ${school.district||''}</div>
    <div class="sub">Principal: ${school.principal||''}</div>
  </div></div>
  <div class="title">📋 Attendance Summary — Class: <strong>${cls}</strong> &nbsp;|&nbsp; Week: <strong>${week}</strong></div>
  <div class="stat-row">
    <div class="stat"><div class="stat-val">${classPupils.length}</div><div class="stat-lbl">Class Size</div></div>
    <div class="stat"><div class="stat-val" style="color:#16a34a;">${present}</div><div class="stat-lbl">Present</div></div>
    <div class="stat"><div class="stat-val" style="color:#dc2626;">${absent}</div><div class="stat-lbl">Absent</div></div>
    <div class="stat"><div class="stat-val" style="color:#d97706;">${late}</div><div class="stat-lbl">Late</div></div>
  </div>
  <div class="gender-row">
    <div class="gender-box" style="background:#eff6ff;border:1px solid #bfdbfe;">
      <div style="font-weight:700;color:#3b82f6;margin-bottom:6px;">👦 Males</div>
      <div style="font-size:13px;">Enrolled: <strong>${maleEnrolled}</strong> &nbsp;·&nbsp; Present: <strong>${malesPresent}</strong> &nbsp;·&nbsp; Absent: <strong>${maleEnrolled-malesPresent}</strong></div>
    </div>
    <div class="gender-box" style="background:#fdf2f8;border:1px solid #f9a8d4;">
      <div style="font-weight:700;color:#ec4899;margin-bottom:6px;">👧 Females</div>
      <div style="font-size:13px;">Enrolled: <strong>${femaleEnrolled}</strong> &nbsp;·&nbsp; Present: <strong>${femalesPresent}</strong> &nbsp;·&nbsp; Absent: <strong>${femaleEnrolled-femalesPresent}</strong></div>
    </div>
  </div>
  <div style="margin-bottom:16px;font-size:13px;">Attendance Rate: <strong>${rate}%</strong>
    <div class="rate-bar"><div class="rate-fill" style="width:${rate}%;"></div></div>
  </div>
  <table>
    <thead><tr><th>#</th><th>Pupil Name</th><th>Gender</th><th>Status</th></tr></thead>
    <tbody>${records.map((r,i)=>{
      const p = state.students.find(s=>s.id===r.studentId);
      const name = p ? `${p.first} ${p.last}` : `Pupil #${r.studentId}`;
      const gender = p ? p.gender : '—';
      const cls2 = r.status==='Present'?'status-p':r.status==='Absent'?'status-a':'status-l';
      return `<tr><td>${i+1}</td><td>${name}</td><td>${gender}</td><td class="${cls2}">${r.status}</td></tr>`;
    }).join('')}</tbody>
  </table>
  <div class="sig">
    <div class="sig-box"><div class="sig-line">Class Teacher</div></div>
    <div class="sig-box"><div class="sig-line">Headmaster</div></div>
    <div class="sig-box"><div class="sig-line">Date</div></div>
  </div>
  <div class="footer">EduManage Pro — ${school.schoolName||'School'} — Printed ${new Date().toLocaleString('en-GH')}</div>
  <script>window.onload=function(){window.print();}<\/script></body></html>`);
  win.document.close();
}

function renderAttendanceSheet() {
  const cls = document.getElementById('attClassSelect').value;
  const week = document.getElementById('attWeek').value.trim();
  if (!cls||!week) { showToast('⚠️ Select a class and enter the week.'); return; }
  const pupils = state.students.filter(s=>s.cls===cls);
  if (!pupils.length) { showToast('⚠️ No pupils in this class.'); return; }
  const sheet = document.getElementById('attendanceSheet');
  sheet.innerHTML = `
    <p style="font-weight:700;margin-bottom:10px;color:var(--blue);">${cls} — ${week}</p>
    <div class="att-sheet-grid">
      ${pupils.map(p=>{
        const existing = state.attendance.find(a=>a.studentId===p.id&&a.week===week&&a.cls===cls);
        const status = existing ? existing.status : 'Present';
        return `<div class="att-row">
          <span class="att-name">${p.first} ${p.last}</span>
          <div class="att-btns">
            <button class="att-btn ${status==='Present'?'att-present':''}" onclick="setAttendance(${p.id},'${cls}','${week}','Present',this)">P</button>
            <button class="att-btn ${status==='Absent'?'att-absent':''}" onclick="setAttendance(${p.id},'${cls}','${week}','Absent',this)">A</button>
            <button class="att-btn ${status==='Late'?'att-late':''}" onclick="setAttendance(${p.id},'${cls}','${week}','Late',this)">L</button>
          </div>
        </div>`;
      }).join('')}
    </div>
    <button class="btn-primary" style="margin-top:14px;width:100%;" onclick="saveAttendance('${cls}','${week}')"><i class="fas fa-save"></i> Save Attendance</button>
  `;
  sheet.style.display='block';
}

function setAttendance(studentId, cls, week, status, btn) {
  const existing = state.attendance.find(a=>a.studentId===studentId&&a.week===week&&a.cls===cls);
  if (existing) existing.status = status;
  else state.attendance.push({ id:state.nextAttendanceId++, studentId, cls, week, status });
  // Update button highlights
  const row = btn.closest('.att-row');
  row.querySelectorAll('.att-btn').forEach(b=>b.classList.remove('att-present','att-absent','att-late'));
  btn.classList.add(status==='Present'?'att-present':status==='Absent'?'att-absent':'att-late');
}

function saveAttendance(cls, week) {
  autosave(); renderAttendance(cls); updateDashStats(); showToast('✅ Attendance saved!');
}

function initAttendance() {
  renderAttendance();
  document.getElementById('attLoadBtn').addEventListener('click', renderAttendanceSheet);
  document.getElementById('attClassSelect').addEventListener('change', function(){ renderAttendance(this.value); });
}

// ── STUDENT PROMOTION ──
const CLASS_ORDER = ['Creche','Nursery 1','Nursery 2','KG1','KG2','BS.1','BS.2','BS.3','BS.4','BS.5','BS.7','BS.8','BS.9'];

function renderPromotionPreview() {
  const fromCls = document.getElementById('promoteFromClass').value;
  const toCls = CLASS_ORDER[CLASS_ORDER.indexOf(fromCls)+1];
  const pupils = state.students.filter(s=>s.cls===fromCls);
  const preview = document.getElementById('promotionPreview');
  if (!pupils.length) { preview.innerHTML=`<p class="empty-state">No pupils in ${fromCls}.</p>`; return; }
  if (!toCls) { preview.innerHTML=`<p class="empty-state">${fromCls} is the highest class.</p>`; return; }
  preview.innerHTML = `
    <p style="margin-bottom:12px;font-size:13px;color:var(--text-muted);">
      <strong>${pupils.length} pupils</strong> in ${fromCls} will be promoted to <strong>${toCls}</strong>
    </p>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
      ${pupils.map(p=>`<span style="background:var(--blue-light);color:var(--blue);padding:4px 10px;border-radius:20px;font-size:12px;font-weight:600;">${p.first} ${p.last}</span>`).join('')}
    </div>
    <button class="btn-primary" style="width:100%;" onclick="executePromotion('${fromCls}','${toCls}')">
      <i class="fas fa-arrow-up"></i> Promote All ${pupils.length} Pupils: ${fromCls} → ${toCls}
    </button>`;
}

function executePromotion(from, to) {
  if (!confirm(`Promote all pupils from ${from} to ${to}? This cannot be undone.`)) return;
  let count = 0;
  state.students.forEach(s=>{ if(s.cls===from){ s.cls=to; count++; } });
  renderStudents(); updateDashStats(); autosave();
  document.getElementById('promotionPreview').innerHTML=`<p style="color:var(--green);font-weight:700;"><i class="fas fa-check-circle"></i> ✅ ${count} pupils promoted from ${from} to ${to}!</p>`;
  showToast(`✅ ${count} pupils promoted to ${to}!`);
}

function initPromotion() {
  document.getElementById('promoteFromClass').addEventListener('change', renderPromotionPreview);
}

// ── PARENT SMS REMINDERS ──
// ════════════════════════════════════════
// ADMISSIONS MODULE
// ════════════════════════════════════════

function genAdmissionNumber() {
  const yr  = new Date().getFullYear().toString().slice(-2);
  const seq = String(state.nextAdmissionId).padStart(4, '0');
  return `ADM-${yr}-${seq}`;
}

function renderAdmissions() {
  const tbody      = document.getElementById('admTbody');
  const search     = (document.getElementById('admSearch')?.value || '').toLowerCase();
  const statusF    = document.getElementById('admStatusFilter')?.value || '';
  const classF     = document.getElementById('admClassFilter')?.value || '';

  let data = state.admissions || [];
  if (search)  data = data.filter(a => `${a.first} ${a.last} ${a.admNumber}`.toLowerCase().includes(search));
  if (statusF) data = data.filter(a => a.status === statusF);
  if (classF)  data = data.filter(a => a.cls === classF);

  // Stats
  const all = state.admissions || [];
  document.getElementById('admTotalCount').textContent    = all.length;
  document.getElementById('admAdmittedCount').textContent = all.filter(a => a.enrolled).length;
  document.getElementById('admPendingCount').textContent  = all.filter(a => a.status === 'Pending').length;
  document.getElementById('admRejectedCount').textContent = all.filter(a => a.status === 'Not Admitted').length;

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:32px;color:var(--text-muted);"><i class="fas fa-file-signature" style="font-size:28px;display:block;margin-bottom:10px;"></i>No admission records. Click <strong>New Admission</strong> to begin.</td></tr>`;
    return;
  }

  const statusColor = { Pending:'#d97706', Admitted:'#16a34a', 'Not Admitted':'#dc2626' };
  const statusBg    = { Pending:'#fef3c7', Admitted:'#dcfce7', 'Not Admitted':'#fee2e2' };

  tbody.innerHTML = data.map((a, i) => {
    const sc = statusColor[a.status] || '#64748b';
    const sb = statusBg[a.status]   || '#f1f5f9';
    return `<tr>
      <td>${i+1}</td>
      <td style="font-family:monospace;font-size:12px;font-weight:700;color:var(--blue);">${a.admNumber}</td>
      <td>
        ${a.photo ? `<img src="${a.photo}" style="width:28px;height:32px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-right:6px;border:1px solid var(--border);">` : ''}
        <strong>${a.first} ${a.middle ? a.middle+' ' : ''}${a.last}</strong>
      </td>
      <td><span style="background:var(--blue-light);color:var(--blue);padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;">${a.cls}</span></td>
      <td>${a.gender}</td>
      <td style="font-size:12px;color:var(--text-muted);">${a.date || '—'}</td>
      <td><span style="background:${sb};color:${sc};padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;">${a.status}</span></td>
      <td style="text-align:center;">
        ${a.enrolled
          ? `<span style="color:var(--green);font-size:12px;font-weight:700;" title="Enrolled as pupil">✅ Yes</span>`
          : `<button class="tbl-btn" onclick="admitAndEnroll(${a.id})" title="Enroll this pupil" style="font-size:11px;padding:3px 8px;"><i class="fas fa-user-plus"></i> Enroll</button>`}
      </td>
      <td style="white-space:nowrap;">
        <button class="tbl-btn" onclick="editAdmission(${a.id})" title="Edit"><i class="fas fa-edit"></i></button>
        <button class="tbl-btn" onclick="printAdmissionForm(${a.id})" title="Print Form"><i class="fas fa-print"></i></button>
        <button class="tbl-btn danger" onclick="deleteAdmission(${a.id})" title="Delete"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`;
  }).join('');
}

function openNewAdmission() {
  clearAdmissionModal();
  document.getElementById('admModalTitle').innerHTML = '<i class="fas fa-file-signature"></i> New Admission Form';
  document.getElementById('admEditId').value = '';
  document.getElementById('admNumber').value = genAdmissionNumber();
  document.getElementById('admDate').value   = new Date().toISOString().split('T')[0];
  document.getElementById('admStatus').value = 'Pending';
  document.getElementById('admitAndEnrollBtn').style.display = 'inline-flex';
  document.getElementById('admissionModal').classList.add('open');
}

function clearAdmissionModal() {
  const fields = ['admFirst','admMiddle','admLast','admDOB','admNationality','admReligion',
    'admPrevSchool','admClass','admHomeTown','admAddress','admDate','admFatherName','admFatherOcc',
    'admFatherPhone','admMotherName','admMotherOcc','admMotherPhone','admGuardName','admGuardRel',
    'admGuardPhone','admBloodGroup','admAllergies','admMedical','admStatus','admNumber','admRemarks'];
  fields.forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  document.getElementById('admNationality').value = 'Ghanaian';
  document.getElementById('admStatus').value = 'Pending';
  const prev = document.getElementById('admPhotoPreview');
  prev.src = ''; prev.style.display = 'none'; prev.dataset.photo = '';
  document.getElementById('admPhotoInput').value = '';
}

function getAdmissionFormData() {
  return {
    first:       document.getElementById('admFirst').value.trim(),
    middle:      document.getElementById('admMiddle').value.trim(),
    last:        document.getElementById('admLast').value.trim(),
    dob:         document.getElementById('admDOB').value,
    gender:      document.getElementById('admGender').value,
    nationality: document.getElementById('admNationality').value.trim(),
    religion:    document.getElementById('admReligion').value,
    prevSchool:  document.getElementById('admPrevSchool').value.trim(),
    cls:         document.getElementById('admClass').value,
    homeTown:    document.getElementById('admHomeTown').value.trim(),
    address:     document.getElementById('admAddress').value.trim(),
    date:        document.getElementById('admDate').value,
    fatherName:  document.getElementById('admFatherName').value.trim(),
    fatherOcc:   document.getElementById('admFatherOcc').value.trim(),
    fatherPhone: document.getElementById('admFatherPhone').value.trim(),
    motherName:  document.getElementById('admMotherName').value.trim(),
    motherOcc:   document.getElementById('admMotherOcc').value.trim(),
    motherPhone: document.getElementById('admMotherPhone').value.trim(),
    guardName:   document.getElementById('admGuardName').value.trim(),
    guardRel:    document.getElementById('admGuardRel').value.trim(),
    guardPhone:  document.getElementById('admGuardPhone').value.trim(),
    bloodGroup:  document.getElementById('admBloodGroup').value,
    allergies:   document.getElementById('admAllergies').value.trim(),
    medical:     document.getElementById('admMedical').value.trim(),
    status:      document.getElementById('admStatus').value,
    admNumber:   document.getElementById('admNumber').value,
    remarks:     document.getElementById('admRemarks').value.trim(),
    photo:       document.getElementById('admPhotoPreview').dataset.photo || null,
  };
}

function saveAdmission(andEnroll = false) {
  const d = getAdmissionFormData();
  if (!d.first || !d.last) { showToast('⚠️ Please enter the pupil\'s first and last name.'); return; }
  if (!d.cls)              { showToast('⚠️ Please select the class applying for.'); return; }
  if (!d.gender)           { showToast('⚠️ Please select gender.'); return; }

  const editId = document.getElementById('admEditId').value;
  let admission;

  if (editId) {
    admission = state.admissions.find(a => a.id === parseInt(editId));
    if (admission) Object.assign(admission, d);
    showToast(`✅ Admission record updated for ${d.first} ${d.last}`);
  } else {
    if (andEnroll) d.status = 'Admitted';
    admission = { id: state.nextAdmissionId++, ...d, enrolled: false, enrolledStudentId: null };
    state.admissions.push(admission);
    showToast(`✅ Admission form saved — ${d.admNumber}`);
  }

  if (andEnroll || d.status === 'Admitted') {
    const target = editId ? state.admissions.find(a => a.id === parseInt(editId)) : admission;
    if (target && !target.enrolled) {
      doEnrollAdmission(target);
    }
  }

  autosave();
  renderAdmissions();
  updateDashStats();
  document.getElementById('admissionModal').classList.remove('open');
}

function admitAndEnroll(admId) {
  const a = state.admissions.find(x => x.id === admId);
  if (!a) return;
  if (a.enrolled) { showToast('ℹ️ This pupil is already enrolled.'); return; }
  if (!confirm(`Admit and enroll ${a.first} ${a.last} into ${a.cls}?`)) return;
  a.status = 'Admitted';
  doEnrollAdmission(a);
  autosave();
  renderAdmissions();
  updateDashStats();
  refreshAllPupilDropdowns();
}

function doEnrollAdmission(a) {
  // Check if already enrolled to avoid duplicates
  if (a.enrolled && a.enrolledStudentId) {
    showToast(`ℹ️ ${a.first} ${a.last} is already enrolled.`);
    return;
  }
  const phone = a.guardPhone || a.fatherPhone || a.motherPhone || '';
  const newPupil = {
    id: state.nextStudentId++,
    first: a.first, last: a.last, cls: a.cls,
    gender: a.gender, phone,
    feeStatus: 'Unpaid',
    photo: a.photo || null,
    enrolledDate: a.date || new Date().toLocaleDateString('en-GH'),
    admissionNumber: a.admNumber,
    dob: a.dob || '',
  };
  state.students.push(newPupil);
  autoCreateFeeRecord(newPupil);
  a.enrolled          = true;
  a.enrolledStudentId = newPupil.id;
  renderStudents();
  renderFees();
  showToast(`🎉 ${a.first} ${a.last} admitted and added to Pupils!`);
}

function editAdmission(admId) {
  const a = state.admissions.find(x => x.id === admId);
  if (!a) return;
  clearAdmissionModal();
  document.getElementById('admModalTitle').innerHTML = `<i class="fas fa-edit"></i> Edit Admission — ${a.admNumber}`;
  document.getElementById('admEditId').value = a.id;
  // Populate all fields
  const map = {
    admFirst:a.first, admMiddle:a.middle, admLast:a.last,
    admDOB:a.dob, admNationality:a.nationality, admReligion:a.religion,
    admPrevSchool:a.prevSchool, admClass:a.cls, admHomeTown:a.homeTown,
    admAddress:a.address, admDate:a.date, admFatherName:a.fatherName,
    admFatherOcc:a.fatherOcc, admFatherPhone:a.fatherPhone,
    admMotherName:a.motherName, admMotherOcc:a.motherOcc, admMotherPhone:a.motherPhone,
    admGuardName:a.guardName, admGuardRel:a.guardRel, admGuardPhone:a.guardPhone,
    admBloodGroup:a.bloodGroup, admAllergies:a.allergies, admMedical:a.medical,
    admStatus:a.status, admNumber:a.admNumber, admRemarks:a.remarks,
  };
  Object.entries(map).forEach(([id, val]) => { const el=document.getElementById(id); if(el&&val!==undefined) el.value=val||''; });
  document.getElementById('admGender').value = a.gender || '';
  if (a.photo) {
    const prev = document.getElementById('admPhotoPreview');
    prev.src = a.photo; prev.style.display = 'block'; prev.dataset.photo = a.photo;
  }
  document.getElementById('admitAndEnrollBtn').style.display = a.enrolled ? 'none' : 'inline-flex';
  document.getElementById('admissionModal').classList.add('open');
}

function deleteAdmission(admId) {
  const a = state.admissions.find(x => x.id === admId);
  if (!a) return;
  const name = `${a.first} ${a.last}`;
  if (!confirm(`Delete admission record for ${name}?\n${a.enrolled ? '⚠️ Note: The enrolled pupil record will NOT be deleted.' : ''}`)) return;
  state.admissions = state.admissions.filter(x => x.id !== admId);
  autosave(); renderAdmissions(); updateDashStats();
  showToast(`🗑️ Admission record deleted.`);
}

function printAdmissionForm(admId) {
  const a = admId !== undefined
    ? state.admissions.find(x => x.id === admId)
    : (() => { const d = getAdmissionFormData(); return { ...d, id: 0 }; })();
  if (!a) return;
  const school = state.settings;
  const logoHtml = state.schoolLogo
    ? `<img src="${state.schoolLogo}" style="height:70px;object-fit:contain;"/>`
    : '<div style="font-size:40px;">🏫</div>';

  const row = (label, val) => `<tr><td class="lbl">${label}</td><td class="val">${val||'—'}</td></tr>`;
  const sectionHdr = t => `<tr><th colspan="2" class="sec-hdr">${t}</th></tr>`;

  const win = window.open('','_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Admission Form — ${a.first} ${a.last}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'Segoe UI',Arial,sans-serif;padding:24px;color:#1a2133;font-size:13px;}
  .header{display:flex;align-items:center;gap:18px;border-bottom:3px solid #1a6fd4;padding-bottom:14px;margin-bottom:18px;}
  .school-name{font-size:20px;font-weight:900;color:#1a6fd4;line-height:1.2;}
  .school-sub{font-size:12px;color:#64748b;margin-top:3px;}
  .form-title{text-align:center;font-size:16px;font-weight:800;background:#1a6fd4;color:#fff;padding:8px;border-radius:6px;margin-bottom:16px;letter-spacing:.5px;text-transform:uppercase;}
  .adm-num{text-align:right;font-size:13px;font-weight:700;color:#1a6fd4;margin-bottom:12px;font-family:monospace;}
  table{width:100%;border-collapse:collapse;margin-bottom:14px;}
  .sec-hdr{background:#e8f0fe;color:#1a6fd4;font-weight:800;font-size:12px;padding:6px 10px;text-transform:uppercase;letter-spacing:.5px;}
  .lbl{width:38%;color:#64748b;padding:6px 8px;font-weight:600;border:1px solid #e2e8f0;font-size:12px;vertical-align:top;}
  .val{color:#1a2133;padding:6px 8px;font-weight:500;border:1px solid #e2e8f0;font-size:12px;}
  .photo-box{float:right;margin:-10px 0 10px 14px;width:90px;height:110px;border:2px solid #1a6fd4;border-radius:6px;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:40px;background:#f8fafc;}
  .sig-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-top:18px;}
  .sig-box{text-align:center;}
  .sig-line{border-top:1px solid #333;margin-top:30px;padding-top:5px;font-size:11px;color:#64748b;}
  .status-badge{display:inline-block;padding:3px 12px;border-radius:20px;font-weight:700;font-size:12px;}
  .status-Admitted{background:#dcfce7;color:#16a34a;}
  .status-Pending{background:#fef3c7;color:#d97706;}
  .status-NA{background:#fee2e2;color:#dc2626;}
  .footer{text-align:center;font-size:10px;color:#94a3b8;margin-top:18px;border-top:1px solid #eee;padding-top:10px;}
  @media print{@page{margin:15mm;}body{padding:0;}}
</style></head><body>
<div class="header">
  ${logoHtml}
  <div>
    <div class="school-name">${school.schoolName||'Ghana School'}</div>
    <div class="school-sub">GHANA EDUCATION SERVICE${school.district?' · '+school.district:''}</div>
    <div class="school-sub">${school.address||''}</div>
    <div class="school-sub">${school.motto?'Motto: '+school.motto:''}</div>
  </div>
</div>
<div class="form-title">📋 Official Pupil Admission Form</div>
<div class="adm-num">Admission No: <strong>${a.admNumber||'DRAFT'}</strong> &nbsp;|&nbsp; Status: <span class="status-badge status-${a.status==='Not Admitted'?'NA':a.status}">${a.status||'Pending'}</span></div>

${a.photo?`<div class="photo-box"><img src="${a.photo}" style="width:100%;height:100%;object-fit:cover;"></div>`:`<div class="photo-box">📷</div>`}

<table>
  ${sectionHdr('A. Pupil Information')}
  ${row('Full Name', `${a.first||''} ${a.middle||''} ${a.last||''}`)}
  ${row('Date of Birth', a.dob)}
  ${row('Gender', a.gender)}
  ${row('Nationality', a.nationality)}
  ${row('Religion', a.religion)}
  ${row('Class Admitted To', a.cls)}
  ${row('Date of Admission', a.date)}
  ${row('Home Town', a.homeTown)}
  ${row('Home Address', a.address)}
  ${row('Previous School', a.prevSchool)}
</table>
<table>
  ${sectionHdr('B. Parent / Guardian Information')}
  ${row("Father's Name", a.fatherName)}
  ${row("Father's Occupation", a.fatherOcc)}
  ${row("Father's Phone", a.fatherPhone)}
  ${row("Mother's Name", a.motherName)}
  ${row("Mother's Occupation", a.motherOcc)}
  ${row("Mother's Phone", a.motherPhone)}
  ${a.guardName?row("Guardian's Name", `${a.guardName} (${a.guardRel||'Guardian'})`):''}
  ${row("Primary Contact Phone", a.guardPhone)}
</table>
<table>
  ${sectionHdr('C. Health Information')}
  ${row('Blood Group', a.bloodGroup)}
  ${row('Known Allergies', a.allergies)}
  ${row('Medical Conditions', a.medical)}
</table>
${a.remarks?`<table>${sectionHdr('D. Remarks')}<tr><td colspan="2" class="val">${a.remarks}</td></tr></table>`:''}

<div class="sig-row">
  <div class="sig-box"><div class="sig-line">Parent / Guardian Signature</div></div>
  <div class="sig-box"><div class="sig-line">Class Teacher</div></div>
  <div class="sig-box"><div class="sig-line">Headmaster / Principal</div></div>
</div>
<div class="footer">EduManage Pro · GES Admission System · Generated ${new Date().toLocaleString('en-GH')} · ${school.schoolName||''}</div>
<script>window.onload=()=>{window.print();}<\/script>
</body></html>`);
  win.document.close();
}

function downloadAdmissionsCSV() {
  const headers = ['Adm. No','First','Middle','Last','Class','Gender','DOB','Date','Status','Enrolled',
    "Father's Name","Father's Phone","Mother's Name","Mother's Phone","Guardian Phone","Blood Group","Remarks"];
  const rows = (state.admissions||[]).map(a => [
    a.admNumber, a.first, a.middle||'', a.last, a.cls, a.gender, a.dob||'', a.date||'', a.status, a.enrolled?'Yes':'No',
    a.fatherName||'', a.fatherPhone||'', a.motherName||'', a.motherPhone||'', a.guardPhone||'', a.bloodGroup||'', a.remarks||''
  ]);
  downloadCSV(`Admissions_${new Date().toLocaleDateString('en-GH').replace(/\//g,'-')}.csv`, headers, rows);
}

function initAdmissions() {
  renderAdmissions();
  document.getElementById('newAdmissionBtn').addEventListener('click', openNewAdmission);
  document.getElementById('closeAdmissionModal').addEventListener('click', () => document.getElementById('admissionModal').classList.remove('open'));
  document.getElementById('cancelAdmissionBtn').addEventListener('click', () => document.getElementById('admissionModal').classList.remove('open'));
  document.getElementById('saveAdmissionBtn').addEventListener('click', () => saveAdmission(false));
  document.getElementById('admitAndEnrollBtn').addEventListener('click', () => saveAdmission(true));
  document.getElementById('printAdmissionBtn').addEventListener('click', () => {
    const editId = document.getElementById('admEditId').value;
    if (editId) printAdmissionForm(parseInt(editId));
    else {
      const d = getAdmissionFormData();
      const tmp = { ...d, admNumber: d.admNumber || 'DRAFT' };
      const tmpId = 'tmp_print';
      state.admissions.push({ id: tmpId, ...tmp });
      printAdmissionForm(tmpId);
      state.admissions = state.admissions.filter(a => a.id !== tmpId);
    }
  });
  document.getElementById('admPhotoInput').addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const prev = document.getElementById('admPhotoPreview');
      prev.src = ev.target.result; prev.style.display = 'block'; prev.dataset.photo = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('admSearch').addEventListener('input', renderAdmissions);
}


let _idTab = 'pupils';

function switchIDTab(tab) {
  _idTab = tab;
  document.getElementById('idTabPupils').classList.toggle('active', tab === 'pupils');
  document.getElementById('idTabTeachers').classList.toggle('active', tab === 'teachers');
  const clsFilter = document.getElementById('idClassFilter');
  if (clsFilter) clsFilter.style.display = tab === 'pupils' ? '' : 'none';
  renderIDCards();
}

function getIDCardColors() {
  const c = document.getElementById('idCardColor')?.value || 'blue';
  const map = {
    blue:   { cls:'id-theme-blue',   hex:'#1a6fd4' },
    green:  { cls:'id-theme-green',  hex:'#166534' },
    red:    { cls:'id-theme-red',    hex:'#991b1b' },
    purple: { cls:'id-theme-purple', hex:'#581c87' },
    dark:   { cls:'id-theme-dark',   hex:'#0f172a' },
  };
  return map[c] || map.blue;
}

function renderIDCards() {
  const grid   = document.getElementById('idCardsGrid');
  if (!grid) return;
  const theme  = getIDCardColors();
  const search = (document.getElementById('idSearch')?.value || '').toLowerCase();
  const cls    = document.getElementById('idClassFilter')?.value || '';
  const school = state.settings;
  const year   = school.session || new Date().getFullYear();

  const buildCard = (person, type) => {
    const name   = `${person.first} ${person.last}`;
    const idNum  = type === 'pupil'
      ? `GES-STU-${String(person.id).padStart(4,'0')}`
      : `GES-TCH-${String(person.id).padStart(4,'0')}`;
    const typeLabel = type === 'pupil' ? 'STUDENT' : 'STAFF';

    const photoSrc = person.photo || null;
    const initials = `${person.first.charAt(0)}${person.last.charAt(0)}`.toUpperCase();

    const clsVal = type === 'pupil' ? person.cls : (person.assigned || '—');
    const role   = type === 'teacher' ? (person.subject || 'Teacher') : null;

    return `<div class="id-card-wrap">
      <div class="id-ghcard ${theme.cls}" data-id="${person.id}" data-type="${type}">
        <!-- LEFT stripe -->
        <div class="id-ghcard-stripe">
          <div class="id-ghcard-logo-box">
            ${state.schoolLogo
              ? `<img src="${state.schoolLogo}" class="id-ghcard-logo"/>`
              : `<div class="id-ghcard-logo-fallback">🏫</div>`}
          </div>
          <div class="id-ghcard-photo-box">
            ${photoSrc
              ? `<img src="${photoSrc}" class="id-ghcard-photo"/>`
              : `<div class="id-ghcard-avatar">${initials}</div>`}
          </div>
          <div class="id-ghcard-type-badge">${typeLabel}</div>
        </div>
        <!-- RIGHT content -->
        <div class="id-ghcard-content">
          <div class="id-ghcard-school">${school.schoolName || 'GES School'}</div>
          <div class="id-ghcard-ges">GHANA EDUCATION SERVICE</div>
          <div class="id-ghcard-name">${name}</div>
          <div class="id-ghcard-fields">
            <div class="id-ghcard-row"><span class="id-lbl">Class</span><span class="id-val">${clsVal}</span></div>
            <div class="id-ghcard-row"><span class="id-lbl">Gender</span><span class="id-val">${person.gender}</span></div>
            ${role ? `<div class="id-ghcard-row"><span class="id-lbl">Subject</span><span class="id-val">${role}</span></div>` : ''}
            <div class="id-ghcard-row"><span class="id-lbl">Phone</span><span class="id-val">${person.phone || '—'}</span></div>
            <div class="id-ghcard-row"><span class="id-lbl">Year</span><span class="id-val">${year}</span></div>
          </div>
          <div class="id-ghcard-bottom">
            <div class="id-ghcard-idnum">${idNum}</div>
            <div class="id-ghcard-bars">⠿⠯⠿⠯⠿⠯⠿⠯⠿</div>
          </div>
        </div>
      </div>
      <div class="id-card-actions">
        <button class="btn-ghost" style="font-size:12px;flex:1;" onclick="printSingleIDCard(${person.id},'${type}')">
          <i class="fas fa-print"></i> Print
        </button>
      </div>
    </div>`;
  };

  if (_idTab === 'pupils') {
    let pupils = state.students;
    if (cls)    pupils = pupils.filter(p => p.cls === cls);
    if (search) pupils = pupils.filter(p => `${p.first} ${p.last}`.toLowerCase().includes(search));
    if (!pupils.length) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted);"><i class="fas fa-id-card" style="font-size:32px;margin-bottom:12px;display:block;"></i>No pupils found.</div>`;
      return;
    }
    grid.innerHTML = pupils.map(p => buildCard(p, 'pupil')).join('');
  } else {
    let teachers = state.teachers;
    if (search) teachers = teachers.filter(t => `${t.first} ${t.last}`.toLowerCase().includes(search));
    if (!teachers.length) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-muted);"><i class="fas fa-id-card" style="font-size:32px;margin-bottom:12px;display:block;"></i>No teachers found.</div>`;
      return;
    }
    grid.innerHTML = teachers.map(t => buildCard(t, 'teacher')).join('');
  }
}

function printSingleIDCard(id, type) {
  const person = type === 'pupil'
    ? state.students.find(p => p.id === id)
    : state.teachers.find(t => t.id === id);
  if (!person) return;

  const school   = state.settings;
  const year     = school.session || new Date().getFullYear();
  const name     = `${person.first} ${person.last}`;
  const idNum    = type === 'pupil'
    ? `GES-STU-${String(id).padStart(4,'0')}`
    : `GES-TCH-${String(id).padStart(4,'0')}`;
  const typeLabel = type === 'pupil' ? 'STUDENT' : 'STAFF';
  const clsVal    = type === 'pupil' ? person.cls : (person.assigned || '—');
  const role      = type === 'teacher' ? (person.subject || 'Teacher') : null;
  const initials  = `${person.first.charAt(0)}${person.last.charAt(0)}`.toUpperCase();

  const colorMap  = { blue:'#1a6fd4', green:'#166534', red:'#991b1b', purple:'#581c87', dark:'#0f172a' };
  const c1        = colorMap[document.getElementById('idCardColor')?.value || 'blue'];
  const c2        = c1 + 'cc';

  const logoBlock = state.schoolLogo
    ? `<img src="${state.schoolLogo}" style="width:44px;height:44px;object-fit:contain;border-radius:6px;background:rgba(255,255,255,.2);padding:3px;"/>`
    : `<div style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;font-size:26px;background:rgba(255,255,255,.2);border-radius:6px;">🏫</div>`;

  const photoBlock = person.photo
    ? `<img src="${person.photo}" style="width:62px;height:72px;object-fit:cover;border-radius:6px;border:2px solid rgba(255,255,255,.6);display:block;"/>`
    : `<div style="width:62px;height:72px;border-radius:6px;background:rgba(255,255,255,.25);border:2px solid rgba(255,255,255,.5);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:#fff;letter-spacing:1px;">${initials}</div>`;

  const extraField = role
    ? `<tr><td style="color:#94a3b8;padding:1.5px 0;font-size:8.5px;width:46px;">Subject</td><td style="font-weight:600;font-size:8.5px;color:#1e293b;">${role}</td></tr>`
    : '';

  const win = window.open('', '_blank', 'width=700,height=480');
  win.document.write(`<!DOCTYPE html><html><head><title>ID Card — ${name}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#d1d5db;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:'Segoe UI',Arial,sans-serif;gap:18px;}
  .print-hint{font-size:12px;color:#6b7280;text-align:center;}
  .card-wrap{display:flex;flex-direction:column;align-items:center;gap:10px;}
  /* Ghana Card exact dimensions: 85.6mm × 54mm */
  .card{
    width:85.6mm; height:54mm;
    border-radius:4mm;
    overflow:hidden;
    display:flex;
    box-shadow:0 6px 24px rgba(0,0,0,.35);
    position:relative;
    background:#fff;
  }
  /* LEFT stripe */
  .stripe{
    width:28mm; height:100%;
    background:linear-gradient(175deg,${c1},${c2} 60%,${c1}99);
    display:flex; flex-direction:column;
    align-items:center; justify-content:space-between;
    padding:3.5mm 2mm;
    position:relative;
    flex-shrink:0;
  }
  .stripe::after{
    content:'';
    position:absolute; right:0; top:0; bottom:0;
    width:3px;
    background:linear-gradient(to bottom,rgba(255,255,255,.5),rgba(255,255,255,.1),rgba(255,255,255,.5));
  }
  .type-badge{
    background:rgba(255,255,255,.22);
    color:#fff; font-size:6px; font-weight:900;
    letter-spacing:1.5px; padding:2px 6px;
    border-radius:20px; text-transform:uppercase;
    border:1px solid rgba(255,255,255,.4);
  }
  .photo{width:18mm;height:21mm;object-fit:cover;border-radius:2mm;border:1.5px solid rgba(255,255,255,.7);}
  .avatar{width:18mm;height:21mm;border-radius:2mm;background:rgba(255,255,255,.22);border:1.5px solid rgba(255,255,255,.5);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;color:#fff;}
  /* RIGHT content */
  .content{flex:1;padding:3.5mm 3mm 3mm 3.5mm;display:flex;flex-direction:column;justify-content:space-between;min-width:0;}
  .school-name{font-size:8px;font-weight:900;color:${c1};line-height:1.25;text-transform:uppercase;letter-spacing:.3px;}
  .ges-sub{font-size:6.5px;color:#64748b;font-weight:600;letter-spacing:.5px;margin-top:1px;}
  .divider{height:1.5px;background:linear-gradient(to right,${c1},transparent);border-radius:2px;margin:2mm 0 1.5mm;}
  .full-name{font-size:11.5px;font-weight:900;color:#0f172a;line-height:1.2;margin-bottom:2mm;}
  .fields{flex:1;}
  .fields table{width:100%;border-collapse:collapse;}
  .fields td{padding:1.5px 0;vertical-align:top;}
  .fields .lbl{color:#94a3b8;font-size:7.5px;width:42px;font-weight:500;}
  .fields .val{color:#1e293b;font-size:8px;font-weight:700;}
  .bottom{display:flex;justify-content:space-between;align-items:flex-end;border-top:1px solid #e2e8f0;padding-top:1.5mm;margin-top:1.5mm;}
  .id-code{font-size:7px;font-weight:700;color:${c1};letter-spacing:.5px;font-family:'Courier New',monospace;}
  .bars{font-size:10px;color:#cbd5e1;letter-spacing:2px;}
  @media print{
    body{background:#fff;margin:0;padding:0;}
    .print-hint{display:none;}
    @page{size:85.6mm 54mm;margin:0;}
    html,body{width:85.6mm;height:54mm;}
    .card{box-shadow:none;border-radius:0;width:85.6mm;height:54mm;}
    .card-wrap{margin:0;}
  }
</style>
</head><body>
<div class="print-hint">⬇ This card is sized exactly like the Ghana Card (85.6 × 54 mm). Print at 100% scale, no margins.</div>
<div class="card-wrap">
  <div class="card">
    <div class="stripe">
      ${logoBlock}
      ${photoBlock}
      <div class="type-badge">${typeLabel}</div>
    </div>
    <div class="content">
      <div>
        <div class="school-name">${school.schoolName || 'GES School'}</div>
        <div class="ges-sub">GHANA EDUCATION SERVICE${school.district ? ' · ' + school.district : ''}</div>
        <div class="divider"></div>
        <div class="full-name">${name}</div>
      </div>
      <div class="fields">
        <table>
          <tr><td class="lbl">Class</td><td class="val">${clsVal}</td></tr>
          <tr><td class="lbl">Gender</td><td class="val">${person.gender}</td></tr>
          ${extraField}
          <tr><td class="lbl">Phone</td><td class="val">${person.phone || '—'}</td></tr>
          <tr><td class="lbl">Year</td><td class="val">${year}</td></tr>
        </table>
      </div>
      <div class="bottom">
        <div class="id-code">${idNum}</div>
        <div class="bars">⠿⠯⠿⠯⠿⠯⠿</div>
      </div>
    </div>
  </div>
  <button onclick="window.print()" style="padding:8px 22px;background:${c1};color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:700;">🖨 Print Card</button>
</div>
</body></html>`);
  win.document.close();
}

function printAllIDCards() {
  window.print();
}

function initIDCards() {
  renderIDCards();
  document.getElementById('idPrintAllBtn')?.addEventListener('click', printAllIDCards);
}

// ════════════════════════════════════════
// SMS REMINDERS — ENHANCED WITH BULK SEND
// ════════════════════════════════════════
function getSMSData() {
  const clsFilter    = document.getElementById('smsClassFilter')?.value || '';
  const statusFilter = document.getElementById('smsStatusFilter')?.value || '';
  return state.fees.filter(f => {
    const status = getStatus(f.due, f.paid);
    const s = state.students.find(st => st.id === f.studentId || `${st.first} ${st.last}` === f.student);
    if (statusFilter) { if (status !== statusFilter) return false; }
    else { if (status === 'Paid') return false; }
    if (clsFilter) { const cls = s ? s.cls : f.cls; if (cls !== clsFilter) return false; }
    return true;
  }).map(f => {
    const s = state.students.find(st => st.id === f.studentId || `${st.first} ${st.last}` === f.student);
    return { ...f, student: s ? `${s.first} ${s.last}` : f.student, cls: s ? s.cls : f.cls, phone: s ? s.phone : f.phone };
  });
}

function buildSMSMessage(f, template) {
  const tpl = template || `Dear Parent/Guardian, this is a reminder that {name} ({class}) has an outstanding school fee balance of GH₵{balance}. Please pay at the earliest. Thank you — {school}.`;
  const balance = (f.due - f.paid).toFixed(2);
  return tpl
    .replace(/{name}/g, f.student)
    .replace(/{class}/g, f.cls)
    .replace(/{balance}/g, balance)
    .replace(/{school}/g, state.settings.schoolName || 'School');
}

function generateSMSReminders() {
  const unpaid = getSMSData();
  const tbody  = document.getElementById('smsTbody');
  const info   = document.getElementById('smsSelectedInfo');
  if (!unpaid.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:28px;color:var(--green);">✅ All fee payments are up to date!</td></tr>`;
    if (info) info.textContent = '';
    return;
  }
  if (info) info.textContent = `${unpaid.length} pupil${unpaid.length!==1?'s':''} with outstanding fees`;
  tbody.innerHTML = unpaid.map((f,i) => {
    const balance = f.due - f.paid;
    const msg     = buildSMSMessage(f);
    const safeMsg = msg.replace(/'/g,"\\'");
    const phone   = f.phone || '—';
    return `<tr id="sms_row_${i}" class="sms-row">
      <td class="sms-check-col"><input type="checkbox" class="sms-chk" data-index="${i}" onchange="updateSMSSelection()" checked/></td>
      <td>${i+1}</td>
      <td><strong>${f.student}</strong></td>
      <td>${f.cls}</td>
      <td style="color:var(--red);font-weight:600;">${fmt(balance)}</td>
      <td>${phone}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="tbl-btn" onclick="copySMS(this,'${safeMsg}')"><i class="fas fa-copy"></i> Copy</button>
        ${phone !== '—' ? `<a class="tbl-btn" href="sms:${phone}?body=${encodeURIComponent(msg)}" style="text-decoration:none;"><i class="fas fa-sms"></i> Send</a>` : `<span class="tbl-btn" style="opacity:.5;cursor:not-allowed;" title="No phone number">No phone</span>`}
      </td>
    </tr>`;
  }).join('');
  updateSMSSelection();
}

function updateSMSSelection() {
  const checked = document.querySelectorAll('.sms-chk:checked');
  const all     = document.querySelectorAll('.sms-chk');
  const selAll  = document.getElementById('smsSelectAll');
  if (selAll) selAll.checked = checked.length === all.length && all.length > 0;
  document.querySelectorAll('.sms-row').forEach(row => {
    const chk = row.querySelector('.sms-chk');
    row.classList.toggle('sms-row-selected', chk && chk.checked);
  });
  const info = document.getElementById('smsSelectedInfo');
  if (info) info.textContent = `${checked.length} / ${all.length} selected`;
}

function toggleSelectAllSMS(checked) {
  document.querySelectorAll('.sms-chk').forEach(chk => chk.checked = checked);
  updateSMSSelection();
}

function getSelectedSMSData() {
  const unpaid = getSMSData();
  const checked = document.querySelectorAll('.sms-chk:checked');
  const indices = Array.from(checked).map(c => parseInt(c.dataset.index));
  return indices.map(i => unpaid[i]).filter(Boolean);
}

function refreshBulkSelection() {
  updateBulkPhoneList();
}

function updateBulkPhoneList() {
  const selected = getSelectedSMSData();
  const phones   = selected.map(f => f.phone).filter(p => p && p !== '—');
  const el = document.getElementById('bulkPhoneList');
  if (el) el.value = phones.join(', ');
  const cnt = document.getElementById('bulkSelectedCount');
  if (cnt) cnt.textContent = `${selected.length} recipient${selected.length!==1?'s':''} · ${phones.length} with phone numbers`;
}

function openBulkSMSPanel() {
  const panel = document.getElementById('bulkSMSPanel');
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth' });
  updateBulkPhoneList();
}

function copyBulkPhones() {
  const el = document.getElementById('bulkPhoneList');
  if (!el || !el.value) { showToast('⚠️ No phone numbers to copy.'); return; }
  navigator.clipboard.writeText(el.value).then(() => showToast('✅ Phone numbers copied!'));
}

function previewBulkMessages() {
  const selected  = getSelectedSMSData();
  const template  = document.getElementById('bulkSMSTemplate')?.value || '';
  const area      = document.getElementById('bulkPreviewArea');
  if (!selected.length) { showToast('⚠️ No recipients selected.'); return; }
  area.style.display = 'block';
  area.innerHTML = selected.map((f,i) => {
    const msg     = buildSMSMessage(f, template);
    const phone   = f.phone || '—';
    const balance = (f.due - f.paid).toFixed(2);
    return `<div style="border-bottom:1px solid var(--border);padding:10px 0;font-size:12px;">
      <div style="font-weight:700;margin-bottom:4px;color:var(--blue);">${i+1}. ${f.student} (${f.cls}) — <span style="color:var(--red);">GH₵${balance}</span> — 📞 ${phone}</div>
      <div style="color:var(--text-muted);line-height:1.6;">${msg}</div>
    </div>`;
  }).join('');
}

function downloadSMSReport() {
  const selected = getSelectedSMSData();
  const template = document.getElementById('bulkSMSTemplate')?.value || '';
  if (!selected.length) { showToast('⚠️ No recipients selected.'); return; }
  const headers = ['#','Pupil Name','Class','Balance (GH₵)','Phone','Message'];
  const rows    = selected.map((f,i) => [i+1, f.student, f.cls, (f.due-f.paid).toFixed(2), f.phone||'—', buildSMSMessage(f,template)]);
  downloadCSV(`SMS_Report_${new Date().toLocaleDateString('en-GH').replace(/\//g,'-')}.csv`, headers, rows);
}

function copyAllSMS() {
  const selected = getSelectedSMSData();
  const template = document.getElementById('bulkSMSTemplate')?.value || '';
  if (!selected.length) { showToast('⚠️ No recipients selected.'); return; }
  const text = selected.map((f,i) => `${i+1}. ${f.phone||'?'}: ${buildSMSMessage(f,template)}`).join('\n\n');
  navigator.clipboard.writeText(text).then(() => showToast(`✅ ${selected.length} SMS messages copied!`));
}

function copySMS(btn, msg) {
  navigator.clipboard.writeText(msg).then(() => {
    btn.textContent = '✅ Copied!';
    setTimeout(() => { btn.innerHTML = '<i class="fas fa-copy"></i> Copy'; }, 2000);
  });
}

function initSMS() {
  generateSMSReminders();
  document.getElementById('refreshSMSBtn').addEventListener('click', generateSMSReminders);
  document.getElementById('smsSendBulkBtn').addEventListener('click', openBulkSMSPanel);
  document.getElementById('smsCopyAllBtn').addEventListener('click', copyAllSMS);
  const tpl = document.getElementById('bulkSMSTemplate');
  if (tpl) tpl.addEventListener('input', () => { if (document.getElementById('bulkPreviewArea').style.display !== 'none') previewBulkMessages(); });
}

// ════════════════════════════════════════
// SCORE AUTO-TAB (Academic Records)
// ════════════════════════════════════════
function initScoreAutoTab() {
  // Delegate: fires whenever a score input is typed in #subjectsGrid
  document.getElementById('subjectsGrid')?.addEventListener('input', function(e) {
    const inp = e.target;
    if (!inp.matches('.cls-score, .exam-score')) return;
    const val = inp.value.replace(/\D/g,'');
    inp.value = val.slice(0,2); // max 2 digits
    if (inp.value.length === 2) {
      // Find next focusable score input
      const all = Array.from(document.querySelectorAll('.cls-score, .exam-score'));
      const idx = all.indexOf(inp);
      if (idx >= 0 && idx < all.length - 1) {
        all[idx + 1].focus();
        all[idx + 1].select();
      }
    }
  });
  // Also allow Enter key to move forward
  document.getElementById('subjectsGrid')?.addEventListener('keydown', function(e) {
    const inp = e.target;
    if (!inp.matches('.cls-score, .exam-score')) return;
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (e.key === 'Enter') { e.preventDefault(); }
      const all = Array.from(document.querySelectorAll('.cls-score, .exam-score'));
      const idx = all.indexOf(inp);
      if (idx >= 0 && idx < all.length - 1) {
        all[idx + 1].focus();
        all[idx + 1].select();
      }
    }
  });
}

// ════════════════════════════════════════
// MULTI-SCHOOL LOGIN SYSTEM
// Flow: School Selector → Login → App
// ════════════════════════════════════════

// ── SCREEN SWITCHERS ──
function showSchoolSelector() {
  document.getElementById('appWrapper').style.display  = 'none';
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('schoolSelector').style.display = 'flex';
  stopRealtimeSync();
  renderSchoolList(); // show local registry immediately
  // Then also pull fresh from Firebase and re-render (picks up approved schools)
  if (window._fbReady && _isOnline) {
    loadRegistryFromFirebase().then(() => renderSchoolList());
  }
  // If Firebase not ready yet, wait for it then sync
  if (!window._fbReady) {
    document.addEventListener('firebase-ready', () => {
      loadRegistryFromFirebase().then(() => renderSchoolList());
    }, { once: true });
  }
}

function showLoginScreen(schoolId, schoolName) {
  document.getElementById('schoolSelector').style.display = 'none';
  document.getElementById('loginScreen').style.display    = 'flex';
  document.getElementById('loginSchoolName').textContent  = schoolName;
  document.getElementById('loginScreen').dataset.schoolId = schoolId;
  document.getElementById('loginError').style.display     = 'none';
  // Pre-fill remembered credentials
  const remembered = localStorage.getItem('edumanage_remembered_' + schoolId);
  if (remembered) {
    try {
      const { username, password } = JSON.parse(remembered);
      document.getElementById('loginUsername').value = username || '';
      document.getElementById('loginPassword').value = password || '';
      const cb = document.getElementById('rememberMeCheck');
      if (cb) cb.checked = true;
    } catch(e) {
      document.getElementById('loginUsername').value = '';
      document.getElementById('loginPassword').value = '';
    }
  } else {
    document.getElementById('loginUsername').value = '';
    document.getElementById('loginPassword').value = '';
    const cb = document.getElementById('rememberMeCheck');
    if (cb) cb.checked = false;
  }
}

function showApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appWrapper').style.display  = 'flex';
}

// ── SCHOOL SELECTOR ──

function renderSchoolList() {
  const reg = getRegistry();
  const container = document.getElementById('schoolListContainer');
  if (reg.length === 0) {
    container.innerHTML = `<div class="school-empty"><i class="fas fa-school" style="font-size:48px;color:var(--border);margin-bottom:12px;"></i><p>No schools registered yet.</p><p style="font-size:12px;color:var(--text-light);">Click <strong>Register New School</strong> below to get started.</p></div>`;
    return;
  }
  container.innerHTML = reg.map(s => `
    <div class="school-card" onclick="selectSchool('${s.id}','${escHtml(s.name)}')">
      <div class="school-card-icon"><i class="fas fa-graduation-cap"></i></div>
      <div class="school-card-info"><strong>${escHtml(s.name)}</strong><span>Created ${new Date(s.createdAt).toLocaleDateString('en-GH')}</span></div>
      <button class="school-card-delete" title="Delete school" onclick="event.stopPropagation();promptDeleteSchool('${s.id}')"><i class="fas fa-trash"></i></button>
    </div>`).join('');
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function selectSchool(schoolId, schoolName) { showLoginScreen(schoolId, schoolName); }

let _pendingDeleteSchoolId = null;

function promptDeleteSchool(schoolId) {
  const school = getRegistry().find(s => s.id === schoolId);
  if (!school) return;
  _pendingDeleteSchoolId = schoolId;
  document.getElementById('deleteSchoolNameLabel').textContent = `"${school.name}"`;
  document.getElementById('deleteSchoolCode').value = '';
  document.getElementById('deleteSchoolCodeError').style.display = 'none';
  document.getElementById('deleteSchoolModal').classList.add('open');
}

function confirmDeleteSchool() {
  const code = document.getElementById('deleteSchoolCode').value.trim();
  if (code !== SUPER_ADMIN_CODE) {
    document.getElementById('deleteSchoolCodeError').style.display = 'block';
    return;
  }
  document.getElementById('deleteSchoolCodeError').style.display = 'none';
  document.getElementById('deleteSchoolModal').classList.remove('open');
  if (_pendingDeleteSchoolId) {
    deleteSchool(_pendingDeleteSchoolId);
    _pendingDeleteSchoolId = null;
  }
}

function deleteSchool(schoolId) {
  const reg = getRegistry();
  const school = reg.find(s => s.id === schoolId);
  if (!school) return;
  if (window._fbReady && _isOnline) {
    const schoolData = localStorage.getItem(getSchoolKey(schoolId));
    const payload = { schoolId, schoolName: school.name, deletedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now()+90*24*60*60*1000).toISOString(), data: schoolData ? JSON.parse(schoolData) : {} };
    window._fb.set('archives/'+schoolId, payload)
      .then(() => { window._fb.set(fbSchoolPath(schoolId), null).catch(()=>{}); })
      .catch(e => console.warn('[FB] archive failed:', e));
    // Mark as deleted in pending_schools and registry so it never reappears on refresh
    window._fb.update('pending_schools/' + schoolId, { status: 'deleted', deletedAt: new Date().toISOString() }).catch(()=>{});
    window._fb.update('school_credentials/' + schoolId, { status: 'deleted' }).catch(()=>{});
    window._fb.set('registry/' + schoolId, null).catch(()=>{});
  }
  localStorage.removeItem(getSchoolKey(schoolId));
  saveRegistry(reg.filter(s => s.id !== schoolId));
  renderSchoolList();
  showToast('🗑️ Deleted. Data archived 90 days — restorable.');
}

async function showRestoreModal() {
  document.getElementById('restoreSchoolModal').classList.add('open');
  const listEl = document.getElementById('archivedSchoolsList');
  listEl.innerHTML = '<p style="text-align:center;padding:20px;"><i class="fas fa-spinner fa-spin"></i> Loading…</p>';
  if (!window._fbReady || !_isOnline) { listEl.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;">Internet required to view archives.</p>'; return; }
  try {
    const snap = await window._fb.get('archives');
    if (!snap.exists()) { listEl.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;">No archived schools found.</p>'; return; }
    const now = Date.now();
    const valid = Object.values(snap.val()).filter(a => new Date(a.expiresAt).getTime() > now);
    if (!valid.length) { listEl.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px;">No restorable schools (archives expire after 90 days).</p>'; return; }
    listEl.innerHTML = valid.map(a => {
      const days = Math.ceil((new Date(a.expiresAt).getTime()-now)/(86400000));
      return `<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px;display:flex;align-items:center;gap:12px;">
        <div style="font-size:28px;">🏫</div>
        <div style="flex:1;"><div style="font-weight:700;">${escHtml(a.schoolName)}</div>
          <div style="font-size:12px;color:var(--text-muted);">Deleted ${new Date(a.deletedAt).toLocaleDateString('en-GH')} · <span style="color:var(--yellow);font-weight:600;">${days} days left</span></div></div>
        <div style="display:flex;gap:6px;">
          <button class="btn-primary" style="font-size:12px;padding:6px 14px;" onclick="restoreSchool('${a.schoolId}')"><i class="fas fa-trash-restore"></i> Restore</button>
          <button class="btn-ghost" style="font-size:12px;padding:6px 14px;color:var(--red);border-color:var(--red);" onclick="permanentDeleteSchool('${a.schoolId}','${escHtml(a.schoolName)}')"><i class="fas fa-trash"></i> Delete Now</button>
        </div>
      </div>`;
    }).join('');
  } catch(e) { listEl.innerHTML = '<p style="color:var(--red);text-align:center;padding:20px;">Failed to load. Check connection.</p>'; }
}

async function restoreSchool(schoolId) {
  if (!window._fbReady || !_isOnline) { showToast('⚠️ Internet required.'); return; }
  try {
    const snap = await window._fb.get('archives/'+schoolId);
    if (!snap.exists()) { showToast('⚠️ Archive not found.'); return; }
    const a = snap.val();
    const schoolKey = getSchoolKey(schoolId);
    const restored = {...a.data, savedAt: Date.now()};
    await window._fb.set(fbSchoolPath(schoolId), restored);
    localStorage.setItem(schoolKey, JSON.stringify(restored));
    const reg = getRegistry();
    if (!reg.find(s => s.id === schoolId)) {
      reg.push({id:schoolId, key:schoolKey, name:a.schoolName, createdAt: a.data?.settings?.createdAt||new Date().toISOString()});
      saveRegistry(reg);
    }
    await window._fb.set('archives/'+schoolId, null);
    // Re-mark as approved so it shows up on refresh
    await window._fb.update('pending_schools/' + schoolId, { status: 'approved' }).catch(()=>{});
    await window._fb.update('school_credentials/' + schoolId, { status: 'approved' }).catch(()=>{});
    document.getElementById('restoreSchoolModal').classList.remove('open');
    renderSchoolList();
    showToast(`✅ "${a.schoolName}" restored with all data!`);
  } catch(e) { showToast('❌ Restore failed. Try again.'); console.error(e); }
}

async function permanentDeleteSchool(schoolId, schoolName) {
  if (!confirm(`⚠️ PERMANENTLY DELETE "${schoolName}"?

This will erase ALL data immediately from the archive. This CANNOT be undone.`)) return;
  if (!window._fbReady || !_isOnline) { showToast('⚠️ Internet required.'); return; }
  try {
    await window._fb.set('archives/' + schoolId, null);
    showToast(`🗑️ "${schoolName}" permanently deleted from archive.`);
    // Refresh whichever list is visible
    if (document.getElementById('restoreSchoolModal').classList.contains('open')) showRestoreModal();
    if (document.getElementById('saBodyDeleteReq') && document.getElementById('saBodyDeleteReq').style.display !== 'none') renderDeleteRequests();
  } catch(e) { showToast('❌ Failed to delete. Try again.'); }
}

function registerNewSchool() {
  const name      = document.getElementById('newSchoolName').value.trim();
  const adminName = document.getElementById('newSchoolAdmin').value.trim();
  const adminUser = document.getElementById('newSchoolUsername').value.trim().toLowerCase();
  const adminPass = document.getElementById('newSchoolPassword').value.trim();
  const phone     = document.getElementById('newSchoolPhone')?.value.trim() || '';
  const email     = document.getElementById('newSchoolEmail')?.value.trim() || '';

  if (!name || !adminUser || !adminPass) {
    showRegisterError('Please fill in School Name, Admin Username and Password.');
    return;
  }
  if (adminPass.length < 6) {
    showRegisterError('Password must be at least 6 characters.');
    return;
  }

  const btn = document.getElementById('confirmRegisterBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting…';

  submitSchoolRegistration(name, adminName, adminUser, adminPass, phone, email)
    .then(() => {
      document.getElementById('registerSchoolModal').classList.remove('open');
      ['newSchoolName','newSchoolAdmin','newSchoolUsername','newSchoolPassword','newSchoolPhone','newSchoolEmail']
        .forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
      // Show success screen
      document.getElementById('regSuccessSchoolName').textContent = name;
      document.getElementById('regSuccessModal').classList.add('open');
    })
    .catch(e => {
      console.error(e);
      showRegisterError('Submission failed. Please check your internet and try again.');
    })
    .finally(() => {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Registration';
    });
}

function showRegisterError(msg) {
  const el = document.getElementById('registerFormError');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
  else showToast('⚠️ ' + msg);
}


// ── LOGIN ──
function attemptLogin() {
  const username = document.getElementById('loginUsername').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value.trim();
  const schoolId = document.getElementById('loginScreen').dataset.schoolId;
  if (!schoolId) { showSchoolSelector(); return; }
  const schoolKey = getSchoolKey(schoolId);
  const loginBtn  = document.getElementById('loginBtn');
  const resetBtn  = () => { if (loginBtn) { loginBtn.disabled = false; loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Login'; } };
  if (loginBtn) { loginBtn.disabled = true; loginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...'; }
  document.getElementById('loginError').style.display = 'none';
  document.getElementById('loginErrorMsg').textContent = 'Wrong username or password.';

  // Lockout check
  if (isLoginLocked(schoolId)) {
    const secs = getRemainingLockout(schoolId);
    document.getElementById('loginErrorMsg').textContent = 'Too many failed attempts. Try again in ' + secs + 's.';
    document.getElementById('loginError').style.display = 'block';
    resetBtn(); return;
  }

  const proceed = () => {
    const user = state.users.find(u =>
      u.username && u.username.toLowerCase().trim() === username &&
      u.password && u.password.trim() === password &&
      u.active !== false
    );
    if (!user) {
      recordLoginFail(schoolId);
      const tries = _loginAttempts[schoolId]?.count || 0;
      const left = LOGIN_MAX_TRIES - tries;
      document.getElementById('loginErrorMsg').textContent = left <= 0
        ? 'Too many failed attempts. Wait 30 seconds.'
        : 'Wrong username or password. ' + left + ' attempt' + (left!==1?'s':'') + ' left.';
      document.getElementById('loginError').style.display = 'block';
      resetBtn(); return;
    }
    resetLoginAttempts(schoolId);
    _currentSchoolKey = schoolKey;
    state.currentUser = user;
    // Save credentials if Remember Me is checked
    const rememberMe = document.getElementById('rememberMeCheck');
    if (rememberMe && rememberMe.checked) {
      localStorage.setItem('edumanage_remembered_' + schoolId, JSON.stringify({ username, password }));
    } else {
      localStorage.removeItem('edumanage_remembered_' + schoolId);
    }
    showApp();
    showSyncStatus(_isOnline ? 'online' : 'offline');
    document.querySelector('.user-name').textContent   = user.name;
    document.querySelector('.user-role').textContent   = user.role;
    document.querySelector('.user-avatar').textContent = user.name.charAt(0).toUpperCase();
    document.getElementById('sidebarSchoolName').textContent = state.settings.schoolName;
    // Suppress autosave during initial render — state is being set up, not modified by user
    _fbSyncPaused = true;
    renderStudents(); renderFees(); renderTeachers(); renderClasses();
    renderGallery(); renderSavedReports(); renderWeekly();
    renderAttendance(); renderUsers(); updateDashStats(); updateFeeStats();
    renderBackupHistory(); updateBackupInfo();
    if (typeof renderResources === 'function') renderResources();
    if (typeof renderExams === 'function') renderExams();
    if (typeof renderTransfers === 'function') renderTransfers();
    if (typeof renderAnnouncements === 'function') renderAnnouncements();
    if (typeof renderParentNotifications === 'function') renderParentNotifications();
    if (typeof initTheme === 'function') initTheme();
    renderThemeSwatches();
    if (state.schoolLogo) applyLogo(state.schoolLogo);
    const sv = (id, val) => { const el=document.getElementById(id); if(el&&val!==undefined) el.value=val; };
    const s = state.settings;
    sv('schoolName',s.schoolName); sv('sessionYear',s.session); sv('schoolAddress',s.address);
    sv('principalName',s.principal); sv('gesDistrict',s.district); sv('schoolMotto',s.motto);
    if (document.getElementById('currentTerm')) document.getElementById('currentTerm').value = s.term||'';
    applyRoleNav(user);
    resetBtn();
    // Start realtime sync AFTER data is loaded and rendered — not before
    startRealtimeSync(schoolId);
    // Unpause after a short delay so render-triggered autosaves don't fire immediately
    setTimeout(() => { _fbSyncPaused = false; }, 3000);
    showToast('Welcome back, ' + user.name + ' - ' + state.settings.schoolName);
  };
  loadSchoolData(schoolKey);
  if (window._fbReady && _isOnline) {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done=true; proceed(); } }, 6000);
    loadSchoolDataFromFirebase(schoolId)
      .then(() => { if (!done) { done=true; clearTimeout(timer); proceed(); } })
      .catch(() => { if (!done) { done=true; clearTimeout(timer); proceed(); } });
  } else {
    proceed();
  }
}


// ══════════════════════════════════════
// ROLE-BASED ACCESS CONTROL (RBAC)
// The system ALWAYS reads role from state — users can never self-assign
// ══════════════════════════════════════

// What each role can access — system-defined, never user-input
const SECTION_ROLES = {
  dashboard:     ['Admin','Teacher'],
  admissions:    ['Admin','Teacher'],
  students:      ['Admin','Teacher'],
  reports:       ['Admin','Teacher'],
  fees:          ['Admin'],
  gallery:       ['Admin','Teacher'],
  expenditure:   ['Admin'],
  weekly:        ['Admin','Teacher'],
  attendance:    ['Admin','Teacher'],
  idcards:       ['Admin','Teacher'],
  promotion:     ['Admin'],
  sms:           ['Admin'],
  teachers:      ['Admin'],
  classes:       ['Admin'],
  resources:     ['Admin','Teacher'],
  exams:         ['Admin','Teacher'],
  transfers:     ['Admin'],
  communication: ['Admin','Teacher'],
  users:         ['Admin'],
  settings:      ['Admin'],
  backup:        ['Admin'],
};

// Login attempt tracker — prevents brute-force
const _loginAttempts = {};
const LOGIN_MAX_TRIES = 5;
const LOGIN_LOCKOUT_MS = 30000; // 30 seconds

function isLoginLocked(schoolId) {
  const rec = _loginAttempts[schoolId];
  if (!rec) return false;
  if (rec.count >= LOGIN_MAX_TRIES) {
    if (Date.now() - rec.lastTry < LOGIN_LOCKOUT_MS) return true;
    // Lockout expired — reset
    delete _loginAttempts[schoolId];
  }
  return false;
}
function recordLoginFail(schoolId) {
  if (!_loginAttempts[schoolId]) _loginAttempts[schoolId] = { count:0, lastTry:0 };
  _loginAttempts[schoolId].count++;
  _loginAttempts[schoolId].lastTry = Date.now();
}
function resetLoginAttempts(schoolId) { delete _loginAttempts[schoolId]; }
function getRemainingLockout(schoolId) {
  const rec = _loginAttempts[schoolId];
  if (!rec) return 0;
  const remaining = LOGIN_LOCKOUT_MS - (Date.now() - rec.lastTry);
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

// The ONLY function that decides what a user can see — reads from state, never from user input
function applyRoleNav(user) {
  const role = user?.role || 'Teacher';

  // Students/Parents → completely separate portal, no access to main app
  if (role === 'Student') {
    document.getElementById('appWrapper').style.display = 'none';
    showStudentPortal(user);
    return;
  }

  // Show all nav items first, then hide what this role can't access
  document.querySelectorAll('.nav-item[data-section]').forEach(el => {
    const section = el.dataset.section;
    const allowed = SECTION_ROLES[section] || ['Admin'];
    el.style.display = allowed.includes(role) ? '' : 'none';
  });

  // Also hide section cards from topbar search if not allowed
  document.querySelectorAll('.section[id^="sec-"]').forEach(el => {
    const section = el.id.replace('sec-','');
    const allowed = SECTION_ROLES[section] || ['Admin'];
    // Mark each section with the allowed roles for guardSection()
    el.dataset.allowedRoles = allowed.join(',');
  });

  // Apply custom per-user permissions on top of role defaults
  if (user.permissions && user.permissions.length > 0 && role === 'Teacher') {
    document.querySelectorAll('.nav-item[data-section]').forEach(el => {
      const section = el.dataset.section;
      // Teachers: only show sections they have permission for AND role allows
      if (SECTION_ROLES[section]?.includes('Teacher')) {
        el.style.display = user.permissions.includes(section) ? '' : 'none';
      }
    });
  }
}

// Guard called every time a section is opened — double-checks access
function guardSection(sectionName) {
  const user = state.currentUser;
  if (!user) { doLogout(); return false; }
  const role = user.role || 'Teacher';
  if (role === 'Student') { doLogout(); return false; }
  const allowed = SECTION_ROLES[sectionName] || ['Admin'];
  if (!allowed.includes(role)) {
    showToast(`⛔ You don't have access to ${sectionName}.`);
    // Redirect to dashboard
    document.querySelectorAll('.section').forEach(s => s.style.display = 'none');
    const dash = document.getElementById('sec-dashboard');
    if (dash) dash.style.display = '';
    return false;
  }
  // For Teacher: also check per-user permissions
  if (role === 'Teacher' && user.permissions?.length > 0) {
    if (!user.permissions.includes(sectionName)) {
      showToast(`⛔ You don't have permission for ${sectionName}.`);
      document.querySelectorAll('.section').forEach(s => s.style.display = 'none');
      const dash = document.getElementById('sec-dashboard');
      if (dash) dash.style.display = '';
      return false;
    }
  }
  return true;
}

// Can the current user manage roles / create Admins?
function canManageAdmins() {
  return state.currentUser?.role === 'Admin';
}


function doLogout() {
  saveNow();
  stopRealtimeSync();
  state.currentUser = null;
  _currentSchoolKey = null;
  _unsavedChanges   = false;
  _fbDataLoaded     = false;
  _fbKnownSavedAt   = 0;
  const portal = document.getElementById('studentPortal');
  if (portal) portal.style.display = 'none';
  showSchoolSelector();
}


// ── CHANGE PASSWORD ──
function togglePwdField(inputId, btn) {
  const inp = document.getElementById(inputId);
  const ico = btn.querySelector('i');
  if (inp.type === 'password') { inp.type = 'text'; ico.className = 'fas fa-eye-slash'; }
  else { inp.type = 'password'; ico.className = 'fas fa-eye'; }
}

function openChangePassword() {
  if (!state.currentUser) return;
  document.getElementById('changePwdUsername').textContent = state.currentUser.username;
  document.getElementById('cpCurrentPwd').value  = '';
  document.getElementById('cpNewPwd').value      = '';
  document.getElementById('cpConfirmPwd').value  = '';
  document.getElementById('cpError').style.display = 'none';
  document.getElementById('changePasswordModal').classList.add('open');
}

function saveNewPassword() {
  const current = document.getElementById('cpCurrentPwd').value;
  const newPwd  = document.getElementById('cpNewPwd').value.trim();
  const confirm = document.getElementById('cpConfirmPwd').value.trim();
  const errEl   = document.getElementById('cpError');
  errEl.style.display = 'none';

  if (!current || !newPwd || !confirm) {
    errEl.textContent = '⚠️ All fields are required.'; errEl.style.display = 'block'; return;
  }
  if (current !== state.currentUser.password) {
    errEl.textContent = '❌ Current password is incorrect.'; errEl.style.display = 'block'; return;
  }
  if (newPwd.length < 6) {
    errEl.textContent = '⚠️ New password must be at least 6 characters.'; errEl.style.display = 'block'; return;
  }
  if (newPwd !== confirm) {
    errEl.textContent = '❌ New passwords do not match.'; errEl.style.display = 'block'; return;
  }

  // Update password in state
  const user = state.users.find(u => u.id === state.currentUser.id);
  if (user) { user.password = newPwd; state.currentUser.password = newPwd; }
  autosave();
  document.getElementById('changePasswordModal').classList.remove('open');
  showToast('✅ Password changed successfully!');
}

// ── USER MANAGEMENT ──
// ── AUTO-USER CREATION ──
function _sanitizeUsername(name) {
  // Convert "Ama Serwaa Boateng" → "ama.serwaa.boateng"
  return name.trim().toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9.]/g, '');
}

function _sanitizePassword(contact) {
  // Use contact number as password; if blank use a default safe password
  const cleaned = (contact || '').replace(/\s+/g, '').replace(/[^0-9+]/g, '');
  return cleaned.length >= 4 ? cleaned : 'change123';
}

function autoCreateStudentUser(pupil) {
  const name     = (pupil.first + ' ' + pupil.last).trim();
  let   username = _sanitizeUsername(name);
  const password = _sanitizePassword(pupil.phone);
  const perms    = ROLE_PERMISSIONS['Student'] || ['fees','results','exams','gallery','resources','notices'];

  // Make username unique
  let suffix = ''; let attempt = username;
  let counter = 2;
  while (state.users.find(u => u.username === attempt)) {
    attempt = username + suffix; suffix = counter; counter++;
  }
  username = attempt;

  // Don't duplicate — check if a linked account already exists
  if (state.users.find(u => u.linkedStudentId === pupil.id)) return;

  state.users.push({
    id: state.nextUserId++,
    name, username, password,
    role: 'Student',
    linkedStudentId: pupil.id,
    permissions: perms,
    active: true,
    autoCreated: true,
  });
  renderUsers?.();
  console.log(`[AutoUser] Student account created: ${username} / ${password}`);
}

function autoCreateTeacherUser(teacher) {
  const name     = (teacher.first + ' ' + teacher.last).trim();
  let   username = _sanitizeUsername(name);
  const password = _sanitizePassword(teacher.phone);
  const perms    = ROLE_PERMISSIONS['Teacher'] || [];

  let suffix = ''; let attempt = username;
  let counter = 2;
  while (state.users.find(u => u.username === attempt)) {
    attempt = username + suffix; suffix = counter; counter++;
  }
  username = attempt;

  // Don't duplicate — check by name match
  if (state.users.find(u => u.name === name && u.role === 'Teacher')) return;

  state.users.push({
    id: state.nextUserId++,
    name, username, password,
    role: 'Teacher',
    linkedStudentId: null,
    permissions: perms,
    active: true,
    autoCreated: true,
  });
  renderUsers?.();
  console.log(`[AutoUser] Teacher account created: ${username} / ${password}`);
}

function initLogin() {
  document.getElementById('loginBtn').addEventListener('click', attemptLogin);
  document.getElementById('loginPassword').addEventListener('keydown', e=>{ if(e.key==='Enter') attemptLogin(); });
  document.getElementById('backToSchoolsBtn').addEventListener('click', showSchoolSelector);
  document.getElementById('logoutBtn').addEventListener('click', doLogout);
  document.getElementById('changePasswordBtn').addEventListener('click', openChangePassword);
  document.getElementById('closeChangePwdModal').addEventListener('click', ()=>document.getElementById('changePasswordModal').classList.remove('open'));
  document.getElementById('cancelChangePwdModal').addEventListener('click', ()=>document.getElementById('changePasswordModal').classList.remove('open'));
  document.getElementById('saveNewPasswordBtn').addEventListener('click', saveNewPassword);

  // Register new school — open directly (who can access this page is controlled by the app URL)

  // Restore deleted school — open directly
  const restoreBtn = document.getElementById('restoreSchoolBtn');
  if (restoreBtn) restoreBtn.addEventListener('click', () => showRestoreModal());

  // Super Admin panel — manage pending registrations
  const superAdminBtn = document.getElementById('superAdminBtn');
  if (superAdminBtn) superAdminBtn.addEventListener('click', () => {
    document.getElementById('superAdminCode').value = '';
    document.getElementById('superAdminCodeError').style.display = 'none';
    document.getElementById('superAdminCodeRow').style.display = '';
    document.getElementById('superAdminPanelBody').style.display = 'none';
    document.getElementById('superAdminPanelModal').classList.add('open');
  });

  // Toggle new school password visibility
  document.getElementById('toggleNewSchoolPwd').addEventListener('click', ()=>{
    const inp = document.getElementById('newSchoolPassword');
    const ico = document.getElementById('toggleNewSchoolPwd').querySelector('i');
    if (inp.type==='password') { inp.type='text'; ico.className='fas fa-eye-slash'; }
    else { inp.type='password'; ico.className='fas fa-eye'; }
  });

  // Toggle login password visibility
  document.getElementById('toggleLoginPwd').addEventListener('click', ()=>{
    const inp = document.getElementById('loginPassword');
    const ico = document.getElementById('toggleLoginPwd').querySelector('i');
    if (inp.type==='password') { inp.type='text'; ico.className='fas fa-eye-slash'; }
    else { inp.type='password'; ico.className='fas fa-eye'; }
  });

  // User management
  renderUsers();
  document.getElementById('addUserBtn').addEventListener('click', ()=>{
    document.getElementById('uEditId').value = '';
    document.getElementById('userModalTitle').textContent = 'Add User';
    ['uName','uUsername','uPassword'].forEach(id=>document.getElementById(id).value='');
    document.getElementById('uPasswordRow').style.display = '';
    document.getElementById('uPasswordRow').querySelector('label').textContent = 'Password';
    document.getElementById('uRole').value = 'Teacher';
    renderPermissionsGrid('Teacher');
    document.getElementById('linkedStudentRow').style.display = 'none';
    populateLinkedStudentDropdown(null);
    document.getElementById('userModal').classList.add('open');
  });
  document.getElementById('closeUserModal').addEventListener('click', ()=>document.getElementById('userModal').classList.remove('open'));
  document.getElementById('cancelUserModal').addEventListener('click', ()=>document.getElementById('userModal').classList.remove('open'));
  document.getElementById('saveUserBtn').addEventListener('click', saveUser);

  // Toggle user modal password visibility
  document.getElementById('toggleUserPwd').addEventListener('click', ()=>{
    const inp = document.getElementById('uPassword');
    const ico = document.getElementById('toggleUserPwd').querySelector('i');
    if (inp.type==='password') { inp.type='text'; ico.className='fas fa-eye-slash'; }
    else { inp.type='password'; ico.className='fas fa-eye'; }
  });
}


function renderUsers() {
  const tbody = document.getElementById('usersTbody');
  if (!tbody) return;
  const roleBadge = r => {
    if (r==='Admin')   return `<span class="role-admin"><i class="fas fa-shield-alt"></i> Admin</span>`;
    if (r==='Teacher') return `<span class="role-teacher"><i class="fas fa-chalkboard-teacher"></i> Teacher</span>`;
    return `<span class="role-student"><i class="fas fa-user-graduate"></i> Student/Parent</span>`;
  };
  tbody.innerHTML = state.users.map((u,i) => {
    const linkedPupil = u.linkedStudentId ? state.students.find(s=>s.id===u.linkedStudentId) : null;
    const perms = (u.permissions||[]).join(', ') || '—';
    return `<tr>
      <td>${i+1}</td>
      <td>
        <strong>${u.name}</strong>
        ${u.autoCreated ? `<span style="background:#fef3c7;color:#92400e;padding:1px 6px;border-radius:10px;font-size:10px;font-weight:700;margin-left:6px;">AUTO</span>` : ''}
        ${linkedPupil ? `<br><small style="color:var(--blue);font-size:11px;"><i class="fas fa-link"></i> Linked: ${linkedPupil.first} ${linkedPupil.last}</small>` : ''}
      </td>
      <td><code style="background:var(--bg);padding:2px 7px;border-radius:5px;font-size:12px;">${u.username}</code></td>
      <td><span style="letter-spacing:2px;color:var(--text-light);font-size:13px;">••••••</span></td>
      <td>${roleBadge(u.role)}</td>
      <td style="font-size:11px;color:var(--text-muted);max-width:160px;overflow:hidden;text-overflow:ellipsis;" title="${perms}">${perms}</td>
      <td><span class="status-pill ${u.active?'pill-paid':'pill-unpaid'}">${u.active?'Active':'Inactive'}</span></td>
      <td>
        <button class="tbl-btn" onclick="editUser(${u.id})" title="Edit"><i class="fas fa-edit"></i></button>
        <button class="tbl-btn" onclick="resetUserPassword(${u.id})" title="Reset Password"><i class="fas fa-key"></i></button>
        <button class="tbl-btn" onclick="toggleUserActive(${u.id})" title="${u.active?'Deactivate':'Activate'}">
          <i class="fas fa-toggle-${u.active?'on':'off'}"></i>
        </button>
        <button class="tbl-btn danger" onclick="deleteUser(${u.id})" title="Delete"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`;
  }).join('');
}

function saveUser() {
  const name     = document.getElementById('uName').value.trim();
  const username = document.getElementById('uUsername').value.trim();
  const password = document.getElementById('uPassword').value.trim();
  const role     = document.getElementById('uRole').value;
  const editId   = document.getElementById('uEditId').value;

  // RBAC: Only Admins can manage users at all
  if (!canManageAdmins()) { showToast('⛔ Only Admins can manage users.'); return; }

  // RBAC: Only Admins can create other Admins
  // Prevent creating an Admin account unless current user is Admin
  if (role === 'Admin' && state.currentUser?.role !== 'Admin') {
    showToast('⛔ Only an Admin can create another Admin account.'); return;
  }

  // RBAC: Cannot demote yourself
  if (editId && parseInt(editId) === state.currentUser?.id && role !== state.currentUser?.role) {
    showToast('⛔ You cannot change your own role.'); return;
  }

  // Linked student for Student/Parent role
  const linkedStudentId = role === 'Student'
    ? (parseInt(document.getElementById('uLinkedStudent').value) || null)
    : null;
  if (role === 'Student' && !linkedStudentId) {
    showToast('⚠️ Please link a pupil to this Student/Parent account.'); return;
  }

  // Permissions checkboxes
  const permissions = [];
  document.querySelectorAll('#uPermissionsGrid input[type=checkbox]:checked').forEach(cb => permissions.push(cb.value));

  if (!name||!username) { showToast('⚠️ Name and username are required.'); return; }

  if (editId) {
    const u = state.users.find(u=>u.id===parseInt(editId));
    if (!u) return;
    const dupe = state.users.find(u=>u.username===username && u.id!==parseInt(editId));
    if (dupe) { showToast('⚠️ Username already taken.'); return; }
    u.name = name; u.username = username; u.role = role;
    u.linkedStudentId = linkedStudentId;
    u.permissions = permissions;
    if (password) u.password = password;
    showToast(`✅ ${name} updated!`);
  } else {
    if (!password || password.length < 4) { showToast('⚠️ Password must be at least 4 characters.'); return; }
    if (state.users.find(u=>u.username===username)) { showToast('⚠️ Username already exists.'); return; }
    state.users.push({ id:state.nextUserId++, name, username, password, role, linkedStudentId, permissions, active:true });
    showToast(`✅ User ${name} created!`);
  }

  renderUsers(); autosave();
  document.getElementById('userModal').classList.remove('open');
}

function resetUserPassword(id) {
  const u = state.users.find(u=>u.id===id); if (!u) return;
  const newPwd = prompt(`Reset password for "${u.name}" (${u.username}).\n\nEnter new password (min 4 characters):`);
  if (newPwd === null) return;
  if (newPwd.length < 4) { showToast('⚠️ Password too short — minimum 4 characters.'); return; }
  u.password = newPwd;
  autosave();
  showToast(`✅ Password reset for ${u.name}.`);
}

function toggleLinkedStudentField() {
  const role = document.getElementById('uRole')?.value;
  const row  = document.getElementById('linkedStudentRow');
  if (row) row.style.display = role === 'Student' ? '' : 'none';
  renderPermissionsGrid(role);
}

const ROLE_PERMISSIONS = {
  Admin: ['dashboard','admissions','pupils','reports','fees','gallery','expenditure','weekly','attendance','idcards','promotion','sms','teachers','classes','resources','exams','transfers','communication','users','settings','backup'],
  Teacher: ['dashboard','admissions','pupils','reports','gallery','weekly','attendance','idcards','resources','exams','transfers','communication'],
  Student: ['fees','results','exams','gallery','resources','notices'],
};

function renderPermissionsGrid(role) {
  const grid = document.getElementById('uPermissionsGrid');
  if (!grid) return;
  const defaults = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS['Teacher'];
  const labels = {
    dashboard:'Dashboard', admissions:'Admissions', pupils:'Pupils', reports:'Report Cards',
    fees:'Fees / Bills', gallery:'Gallery', expenditure:'Expenditure', weekly:'Weekly Output',
    attendance:'Attendance', idcards:'ID Cards', promotion:'Promotion', sms:'SMS',
    teachers:'Teachers', classes:'Classes', resources:'Resources', exams:'Exams',
    transfers:'Transfers', communication:'Communication', users:'Access Control',
    settings:'Settings', backup:'Backup', results:'View Results', notices:'Notices',
  };
  const allPerms = role === 'Student'
    ? ['fees','results','exams','gallery','resources','notices']
    : Object.keys(labels).filter(k => !['results','notices'].includes(k));

  grid.innerHTML = allPerms.map(p => `
    <label class="perm-check">
      <input type="checkbox" value="${p}" ${defaults.includes(p)?'checked':''}>
      ${labels[p]||p}
    </label>`).join('');
}

function populateLinkedStudentDropdown(selectedId) {
  const sel = document.getElementById('uLinkedStudent');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Select Pupil --</option>';
  state.students.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.first} ${s.last} (${s.cls})`;
    if (s.id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  });
}

function editUser(id) {
  const u = state.users.find(u=>u.id===id); if (!u) return;
  document.getElementById('uEditId').value    = id;
  document.getElementById('userModalTitle').textContent = 'Edit User';
  document.getElementById('uName').value     = u.name;
  document.getElementById('uUsername').value = u.username;
  document.getElementById('uPassword').value = '';
  document.getElementById('uRole').value     = u.role;
  document.getElementById('uPasswordRow').querySelector('label').textContent = 'New Password (leave blank to keep current)';
  // Permissions
  renderPermissionsGrid(u.role);
  setTimeout(() => {
    (u.permissions||[]).forEach(p => {
      const cb = document.querySelector(`#uPermissionsGrid input[value="${p}"]`);
      if (cb) cb.checked = true;
    });
  }, 0);
  // Linked student
  toggleLinkedStudentField();
  populateLinkedStudentDropdown(u.linkedStudentId);
  document.getElementById('userModal').classList.add('open');
}

function toggleUserActive(id) {
  const u = state.users.find(u=>u.id===id); if (!u) return;
  if (u.id === state.currentUser?.id) { showToast('⚠️ Cannot deactivate your own account.'); return; }
  u.active = !u.active; renderUsers(); autosave();
  showToast(`${u.active?'✅ Activated':'⛔ Deactivated'}: ${u.name}`);
}

function deleteUser(id) {
  if (id === state.currentUser?.id) { showToast('⚠️ Cannot delete your own account.'); return; }
  if (state.users.filter(u=>u.active).length<=1) { showToast('⚠️ At least one active user must remain.'); return; }
  if (!confirm('Delete this user account?')) return;
  state.users = state.users.filter(u=>u.id!==id); renderUsers(); autosave();
  showToast('🗑️ User deleted.');
}

// ── GLOBAL SEARCH ──
function initGlobalSearch() {
  document.getElementById('globalSearch').addEventListener('keydown',function(e){
    if (e.key!=='Enter') return;
    const q=this.value.trim().toLowerCase(); if (!q) return;
    const s=state.students.find(s=>`${s.first} ${s.last}`.toLowerCase().includes(q));
    if (s){
      switchSection('students');
      document.querySelectorAll('.nav-item').forEach(i=>i.classList.remove('active'));
      document.querySelector('[data-section="students"]').classList.add('active');
      document.getElementById('studentSearch').value=q;
      renderStudents(q);
      showToast(`🔍 Showing pupils matching "${q}"`);
      return;
    }
    const f=state.fees.find(f=>f.student.toLowerCase().includes(q));
    if (f){
      switchSection('fees');
      document.querySelectorAll('.nav-item').forEach(i=>i.classList.remove('active'));
      document.querySelector('[data-section="fees"]').classList.add('active');
      document.getElementById('feeSearch').value=q;
      renderFees(q);
      showToast(`🔍 Showing fees for "${q}"`);
      return;
    }
    showToast(`No results found for "${q}"`);
  });
}

// ── INIT ──

// ── EXPENDITURE ──
function renderExpenditures(filter='', category='') {
  const tbody = document.getElementById('expTbody');
  if (!tbody) return;
  let data = state.expenditures || [];
  if (filter) data = data.filter(e => `${e.desc} ${e.notes||''}`.toLowerCase().includes(filter.toLowerCase()));
  if (category) data = data.filter(e => e.category === category);
  
  // Update stats
  const all = state.expenditures || [];
  const total = all.reduce((s,e) => s + (e.amount||0), 0);
  const now = new Date();
  const thisMonth = all.filter(e => {
    const d = new Date(e.date);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).reduce((s,e) => s + (e.amount||0), 0);
  const cats = new Set(all.map(e => e.category)).size;
  
  const el = id => document.getElementById(id);
  if (el('expTotalSpent')) el('expTotalSpent').textContent = fmt(total);
  if (el('expTotalCount')) el('expTotalCount').textContent = all.length;
  if (el('expThisMonth')) el('expThisMonth').textContent = fmt(thisMonth);
  if (el('expCategoryCount')) el('expCategoryCount').textContent = cats;

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-light);padding:28px;">No expenses recorded. Click "Add Expense" to start tracking.</td></tr>`;
    return;
  }
  tbody.innerHTML = data.map((e,i) => `
    <tr>
      <td>${i+1}</td>
      <td><strong>${e.desc}</strong>${e.notes ? `<br><small style="color:var(--text-muted)">${e.notes}</small>` : ''}</td>
      <td><span class="status-pill" style="background:var(--blue-light);color:var(--blue);">${e.category}</span></td>
      <td style="font-weight:700;color:var(--red);">${fmt(e.amount)}</td>
      <td>${e.date ? new Date(e.date).toLocaleDateString('en-GH') : '—'}</td>
      <td>${e.receiver||'—'}</td>
      <td>
        <button class="tbl-btn" onclick="editExpenditure(${e.id})"><i class="fas fa-edit"></i></button>
        <button class="tbl-btn" onclick="printExpReceipt(${e.id})"><i class="fas fa-receipt"></i></button>
        <button class="tbl-btn danger" onclick="deleteExpenditure(${e.id})"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`).join('');
}

function initExpenditure() {
  renderExpenditures();
  
  const today = new Date().toISOString().split('T')[0];
  const expDate = document.getElementById('expDate');
  if (expDate) expDate.value = today;

  document.getElementById('addExpenseBtn').addEventListener('click', () => {
    document.getElementById('expenseModalTitle').textContent = 'Add Expense';
    document.getElementById('expEditId').value = '';
    document.getElementById('expDesc').value = '';
    document.getElementById('expAmount').value = '';
    document.getElementById('expDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('expReceiver').value = '';
    document.getElementById('expNotes').value = '';
    document.getElementById('expCategory').value = 'Stationery';
    document.getElementById('printExpReceiptBtn').style.display = 'none';
    document.getElementById('expenseModal').classList.add('open');
  });
  document.getElementById('closeExpenseModal').addEventListener('click', () => document.getElementById('expenseModal').classList.remove('open'));
  document.getElementById('cancelExpenseModal').addEventListener('click', () => document.getElementById('expenseModal').classList.remove('open'));
  document.getElementById('saveExpenseBtn').addEventListener('click', saveExpenditure);
  document.getElementById('printExpReceiptBtn').addEventListener('click', () => {
    const id = parseInt(document.getElementById('expEditId').value);
    if (id) printExpReceipt(id);
  });
  document.getElementById('expSearch').addEventListener('input', function() {
    renderExpenditures(this.value, document.getElementById('expCategoryFilter').value);
  });
  document.getElementById('expCategoryFilter').addEventListener('change', function() {
    renderExpenditures(document.getElementById('expSearch').value, this.value);
  });

  // Invoice modal
  document.getElementById('generateExpInvoiceBtn').addEventListener('click', () => {
    const invNum = 'EXP-' + String((state.expenditures||[]).length + 1).padStart(3,'0');
    document.getElementById('invNumber').value = invNum;
    document.getElementById('invTitle').value = '';
    document.getElementById('invFromDate').value = '';
    document.getElementById('invToDate').value = '';
    document.getElementById('invCategoryFilter').value = '';
    document.getElementById('invoicePreviewArea').style.display = 'none';
    document.getElementById('expInvoiceModal').classList.add('open');
  });
  document.getElementById('closeExpInvoiceModal').addEventListener('click', () => document.getElementById('expInvoiceModal').classList.remove('open'));
  document.getElementById('cancelExpInvoiceModal').addEventListener('click', () => document.getElementById('expInvoiceModal').classList.remove('open'));
  document.getElementById('previewInvoiceBtn').addEventListener('click', previewExpenseInvoice);
  document.getElementById('printExpInvoiceBtn').addEventListener('click', printExpenseInvoice);
}

function saveExpenditure() {
  const desc = document.getElementById('expDesc').value.trim();
  const amount = parseFloat(document.getElementById('expAmount').value) || 0;
  const date = document.getElementById('expDate').value;
  const category = document.getElementById('expCategory').value;
  const receiver = document.getElementById('expReceiver').value.trim();
  const notes = document.getElementById('expNotes').value.trim();
  const editId = document.getElementById('expEditId').value;
  
  if (!desc) { showToast('⚠️ Enter a description for the expense.'); return; }
  if (!amount || amount <= 0) { showToast('⚠️ Enter a valid amount.'); return; }
  if (!date) { showToast('⚠️ Select an expense date.'); return; }
  
  if (!state.expenditures) state.expenditures = [];
  
  if (editId) {
    const e = state.expenditures.find(e => e.id === parseInt(editId));
    if (e) { e.desc=desc; e.amount=amount; e.date=date; e.category=category; e.receiver=receiver; e.notes=notes; }
    showToast('✅ Expense updated!');
  } else {
    state.expenditures.push({ id: state.nextExpenditureId++, desc, amount, date, category, receiver, notes });
    showToast('✅ Expense recorded!');
  }
  renderExpenditures(); autosave();
  document.getElementById('expenseModal').classList.remove('open');
}

function editExpenditure(id) {
  const e = state.expenditures.find(e => e.id === id); if (!e) return;
  document.getElementById('expenseModalTitle').textContent = 'Edit Expense';
  document.getElementById('expEditId').value = id;
  document.getElementById('expDesc').value = e.desc;
  document.getElementById('expAmount').value = e.amount;
  document.getElementById('expDate').value = e.date;
  document.getElementById('expCategory').value = e.category;
  document.getElementById('expReceiver').value = e.receiver||'';
  document.getElementById('expNotes').value = e.notes||'';
  document.getElementById('printExpReceiptBtn').style.display = 'inline-flex';
  document.getElementById('expenseModal').classList.add('open');
}

function deleteExpenditure(id) {
  if (!confirm('Delete this expense record?')) return;
  state.expenditures = state.expenditures.filter(e => e.id !== id);
  renderExpenditures(); autosave(); showToast('🗑️ Expense deleted.');
}

function printExpReceipt(id) {
  const e = state.expenditures.find(e => e.id === id); if (!e) return;
  const s = state.settings;
  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html>
<html><head><title>Expense Receipt</title>
<style>
  body{font-family:'Segoe UI',Arial,sans-serif;padding:30px;max-width:500px;margin:auto;color:#222;}
  .header{text-align:center;border-bottom:2px solid #1a6fd4;padding-bottom:16px;margin-bottom:20px;}
  .school{font-size:20px;font-weight:800;color:#1a6fd4;}
  .receipt-title{font-size:14px;color:#555;text-transform:uppercase;letter-spacing:1px;margin-top:4px;}
  .row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;}
  .label{color:#666;font-size:13px;}
  .value{font-weight:600;font-size:13px;}
  .amount-row{background:#f0f7ff;border-radius:8px;padding:12px 16px;margin:16px 0;display:flex;justify-content:space-between;align-items:center;}
  .amount-label{font-weight:700;color:#1a6fd4;}
  .amount-value{font-size:22px;font-weight:800;color:#1a6fd4;}
  .footer{text-align:center;margin-top:24px;font-size:11px;color:#999;}
  .receipt-num{font-size:11px;color:#888;margin-top:4px;}
</style></head><body>
<div class="header">
  <div class="school">${s.schoolName||'School'}</div>
  <div class="receipt-title">Expense Receipt</div>
  <div class="receipt-num">Receipt #EXP-${String(e.id).padStart(4,'0')}</div>
</div>
<div class="row"><span class="label">Description</span><span class="value">${e.desc}</span></div>
<div class="row"><span class="label">Category</span><span class="value">${e.category}</span></div>
<div class="row"><span class="label">Date</span><span class="value">${new Date(e.date).toLocaleDateString('en-GH', {day:'numeric',month:'long',year:'numeric'})}</span></div>
<div class="row"><span class="label">Received/Paid By</span><span class="value">${e.receiver||'—'}</span></div>
${e.notes ? `<div class="row"><span class="label">Notes</span><span class="value">${e.notes}</span></div>` : ''}
<div class="amount-row">
  <span class="amount-label">Amount Paid</span>
  <span class="amount-value">GH₵ ${Number(e.amount).toFixed(2)}</span>
</div>
<div class="footer">
  <p>Printed on ${new Date().toLocaleString('en-GH')}</p>
  <p>EduManage Pro — ${s.schoolName||'School'}</p>
</div>
<script>window.onload=function(){window.print();}<\/script>
</body></html>`);
  win.document.close();
}

function previewExpenseInvoice() {
  const fromDate = document.getElementById('invFromDate').value;
  const toDate = document.getElementById('invToDate').value;
  const category = document.getElementById('invCategoryFilter').value;
  
  let data = state.expenditures || [];
  if (fromDate) data = data.filter(e => e.date >= fromDate);
  if (toDate) data = data.filter(e => e.date <= toDate);
  if (category) data = data.filter(e => e.category === category);
  
  const total = data.reduce((s,e) => s + (e.amount||0), 0);
  const area = document.getElementById('invoicePreviewArea');
  
  if (!data.length) {
    area.innerHTML = `<p style="text-align:center;color:var(--text-muted);padding:20px;"><i class="fas fa-exclamation-circle"></i> No expenses found for the selected filters.</p>`;
    area.style.display = 'block';
    return;
  }
  
  area.innerHTML = `
    <div style="border:1px solid var(--border);border-radius:var(--radius);padding:20px;background:var(--white);">
      <table class="data-table">
        <thead><tr><th>#</th><th>Description</th><th>Category</th><th>Date</th><th>Received By</th><th>Amount</th></tr></thead>
        <tbody>
          ${data.map((e,i) => `<tr>
            <td>${i+1}</td>
            <td>${e.desc}${e.notes?`<br><small>${e.notes}</small>`:''}</td>
            <td>${e.category}</td>
            <td>${new Date(e.date).toLocaleDateString('en-GH')}</td>
            <td>${e.receiver||'—'}</td>
            <td style="font-weight:700;">GH₵${Number(e.amount).toFixed(2)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div style="text-align:right;margin-top:12px;padding:12px;background:var(--blue-light);border-radius:var(--radius-sm);">
        <strong style="color:var(--blue);font-size:16px;">Total: GH₵ ${Number(total).toFixed(2)}</strong>
        &nbsp;&nbsp;<span style="color:var(--text-muted);font-size:12px;">(${data.length} expense${data.length>1?'s':''})</span>
      </div>
    </div>`;
  area.style.display = 'block';
}

function printExpenseInvoice() {
  const title = document.getElementById('invTitle').value || 'Expense Invoice';
  const invNum = document.getElementById('invNumber').value || 'EXP-001';
  const fromDate = document.getElementById('invFromDate').value;
  const toDate = document.getElementById('invToDate').value;
  const category = document.getElementById('invCategoryFilter').value;
  const s = state.settings;
  
  let data = state.expenditures || [];
  if (fromDate) data = data.filter(e => e.date >= fromDate);
  if (toDate) data = data.filter(e => e.date <= toDate);
  if (category) data = data.filter(e => e.category === category);
  
  const total = data.reduce((s,e) => s + (e.amount||0), 0);
  
  if (!data.length) { showToast('⚠️ No expenses match the selected filters.'); return; }
  
  // Group by category
  const byCategory = {};
  data.forEach(e => {
    if (!byCategory[e.category]) byCategory[e.category] = [];
    byCategory[e.category].push(e);
  });
  
  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html>
<html><head><title>${title}</title>
<style>
  *{box-sizing:border-box;} body{font-family:'Segoe UI',Arial,sans-serif;padding:30px;color:#222;max-width:800px;margin:auto;}
  .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1a6fd4;padding-bottom:20px;margin-bottom:24px;}
  .school-info .school{font-size:22px;font-weight:800;color:#1a6fd4;}
  .school-info .address{font-size:12px;color:#666;margin-top:4px;}
  .invoice-meta{text-align:right;}
  .invoice-title{font-size:18px;font-weight:700;color:#333;}
  .invoice-num{font-size:12px;color:#888;margin-top:4px;}
  .date-range{font-size:12px;color:#666;margin-top:8px;}
  table{width:100%;border-collapse:collapse;margin-bottom:20px;}
  th{background:#1a6fd4;color:white;padding:10px 12px;text-align:left;font-size:12px;}
  td{padding:9px 12px;border-bottom:1px solid #eee;font-size:12px;}
  tr:nth-child(even){background:#f9f9f9;}
  .category-header{background:#e8f0fe;font-weight:700;color:#1a6fd4;padding:8px 12px;font-size:12px;}
  .total-section{background:#1a6fd4;color:white;padding:16px 20px;border-radius:8px;display:flex;justify-content:space-between;align-items:center;margin-top:16px;}
  .total-label{font-size:14px;font-weight:600;}
  .total-amount{font-size:24px;font-weight:800;}
  .footer{text-align:center;margin-top:32px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#999;}
  .sig-area{display:flex;justify-content:space-between;margin-top:40px;}
  .sig-box{text-align:center;width:200px;}
  .sig-line{border-top:1px solid #333;padding-top:6px;font-size:11px;color:#555;}
</style></head><body>
<div class="header">
  <div class="school-info">
    <div class="school">${s.schoolName||'School'}</div>
    <div class="address">${s.address||''} &nbsp;|&nbsp; ${s.district||''}</div>
    <div class="address">Principal: ${s.principal||''}</div>
  </div>
  <div class="invoice-meta">
    <div class="invoice-title">${title}</div>
    <div class="invoice-num">Invoice No: ${invNum}</div>
    <div class="invoice-num">Academic Year: ${s.session||''}</div>
    <div class="date-range">
      ${fromDate ? 'From: '+new Date(fromDate).toLocaleDateString('en-GH') : ''}
      ${toDate ? ' &nbsp;To: '+new Date(toDate).toLocaleDateString('en-GH') : ''}
    </div>
    <div class="invoice-num">Printed: ${new Date().toLocaleString('en-GH')}</div>
  </div>
</div>

<table>
  <thead><tr><th>#</th><th>Description</th><th>Category</th><th>Date</th><th>Received/Paid By</th><th style="text-align:right">Amount (GH₵)</th></tr></thead>
  <tbody>
    ${data.map((e,i) => `<tr>
      <td>${i+1}</td>
      <td><strong>${e.desc}</strong>${e.notes?`<br><small style="color:#888">${e.notes}</small>`:''}</td>
      <td>${e.category}</td>
      <td>${new Date(e.date).toLocaleDateString('en-GH')}</td>
      <td>${e.receiver||'—'}</td>
      <td style="text-align:right;font-weight:600;">${Number(e.amount).toFixed(2)}</td>
    </tr>`).join('')}
  </tbody>
</table>

<div class="total-section">
  <span class="total-label">TOTAL EXPENDITURE (${data.length} item${data.length>1?'s':''})</span>
  <span class="total-amount">GH₵ ${Number(total).toFixed(2)}</span>
</div>

<div class="sig-area">
  <div class="sig-box"><div class="sig-line">Prepared By</div></div>
  <div class="sig-box"><div class="sig-line">Checked By</div></div>
  <div class="sig-box"><div class="sig-line">Approved By (Head)</div></div>
</div>

<div class="footer">
  <p>EduManage Pro — ${s.schoolName||'School'} | Generated on ${new Date().toLocaleString('en-GH')}</p>
</div>
<script>window.onload=function(){window.print();}<\/script>
</body></html>`);
  win.document.close();
}


// ══════════════════════════════════════
// RESOURCES LIBRARY MODULE
// ══════════════════════════════════════
function renderResources() {
  const search = (document.getElementById('resSearch')?.value||'').toLowerCase();
  const typeFilter = document.getElementById('resTypeFilter')?.value||'';
  const classFilter = document.getElementById('resClassFilter')?.value||'';
  const termFilter = document.getElementById('resTermFilter')?.value||'';
  const tbody = document.getElementById('resTbody');
  const grid = document.getElementById('resourcesGrid');
  if (!tbody) return;

  let data = state.resources || [];
  if (search) data = data.filter(r =>
    (r.title||'').toLowerCase().includes(search) ||
    (r.subject||'').toLowerCase().includes(search) ||
    (r.cls||'').toLowerCase().includes(search) ||
    (r.author||'').toLowerCase().includes(search)
  );
  if (typeFilter) data = data.filter(r => r.type === typeFilter);
  if (classFilter) data = data.filter(r => r.cls === classFilter);
  if (termFilter) data = data.filter(r => r.term === termFilter);

  // Update stats
  const all = state.resources || [];
  const examCount = all.filter(r => r.type === 'Exam Paper' || r.type === 'Past Question').length;
  const bookCount = all.filter(r => r.type === 'Textbook' || r.type === 'Workbook').length;
  const otherCount = all.filter(r => r.type === 'Notes' || r.type === 'Other').length;
  if (document.getElementById('resTotalCount')) document.getElementById('resTotalCount').textContent = all.length;
  if (document.getElementById('resExamCount'))  document.getElementById('resExamCount').textContent  = examCount;
  if (document.getElementById('resBookCount'))  document.getElementById('resBookCount').textContent  = bookCount;
  if (document.getElementById('resOtherCount')) document.getElementById('resOtherCount').textContent = otherCount;

  const condColor = {New:'var(--green)',Good:'var(--blue)',Fair:'var(--yellow)',Poor:'var(--red)'};
  const typeIcon  = {'Exam Paper':'fas fa-scroll','Textbook':'fas fa-book','Workbook':'fas fa-book-open',
                     'Past Question':'fas fa-file-alt','Notes':'fas fa-sticky-note','Other':'fas fa-shapes'};

  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--text-light);"><i class="fas fa-book-open" style="font-size:28px;display:block;margin-bottom:10px;"></i>No resources found. Add your first resource above.</td></tr>`;
    grid.innerHTML = '';
    return;
  }

  tbody.innerHTML = data.map((r, i) => `<tr>
    <td>${i+1}</td>
    <td><strong>${r.title||'—'}</strong>${r.author?`<br><small style="color:var(--text-muted)">${r.author}</small>`:''}</td>
    <td><span style="background:var(--blue-light);color:var(--blue);padding:2px 8px;border-radius:30px;font-size:11px;font-weight:600;white-space:nowrap;">
      <i class="${typeIcon[r.type]||'fas fa-file'}" style="margin-right:4px;"></i>${r.type||'—'}
    </span></td>
    <td>${r.subject||'—'}</td>
    <td>${r.cls||'—'}</td>
    <td>${r.term||'—'}${r.year?`<br><small>${r.year}</small>`:''}</td>
    <td style="text-align:center;font-weight:700;">${r.copies||1}</td>
    <td><span style="color:${condColor[r.condition]||'var(--text)'};font-weight:600;font-size:12px;">${r.condition||'—'}</span></td>
    <td style="font-size:12px;">${r.addedBy||'—'}</td>
    <td>
      <button class="tbl-btn" onclick="editResource(${r.id})"><i class="fas fa-edit"></i></button>
      <button class="tbl-btn danger" onclick="deleteResource(${r.id})"><i class="fas fa-trash"></i></button>
    </td>
  </tr>`).join('');

  // Card view
  grid.innerHTML = data.map(r => `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;transition:all .2s;cursor:default;"
         onmouseover="this.style.boxShadow='var(--shadow-md)';this.style.transform='translateY(-2px)'"
         onmouseout="this.style.boxShadow='';this.style.transform=''">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        <div style="width:42px;height:42px;border-radius:10px;background:var(--blue-light);color:var(--blue);display:grid;place-items:center;font-size:18px;flex-shrink:0;">
          <i class="${typeIcon[r.type]||'fas fa-file'}"></i>
        </div>
        <div style="min-width:0;">
          <div style="font-weight:700;font-size:13px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.title||'Untitled'}</div>
          <div style="font-size:11px;color:var(--text-muted);">${r.type||'Resource'}</div>
        </div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;font-size:11px;margin-bottom:8px;">
        ${r.subject?`<span style="background:var(--bg);border:1px solid var(--border);border-radius:20px;padding:2px 8px;">${r.subject}</span>`:''}
        ${r.cls?`<span style="background:var(--blue-light);color:var(--blue);border-radius:20px;padding:2px 8px;">${r.cls}</span>`:''}
        ${r.term?`<span style="background:var(--teal-light);color:var(--teal);border-radius:20px;padding:2px 8px;">${r.term}</span>`:''}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:11px;color:${condColor[r.condition]||'var(--text)'};font-weight:600;">${r.condition||''} · ${r.copies||1} cop${(r.copies||1)!==1?'ies':'y'}</span>
        <div style="display:flex;gap:6px;">
          <button class="tbl-btn" onclick="editResource(${r.id})" style="padding:3px 8px;"><i class="fas fa-edit"></i></button>
          <button class="tbl-btn danger" onclick="deleteResource(${r.id})" style="padding:3px 8px;"><i class="fas fa-trash"></i></button>
        </div>
      </div>
    </div>`).join('');
}

function saveResource() {
  const title    = document.getElementById('resTitle').value.trim();
  const type     = document.getElementById('resType').value;
  const subject  = document.getElementById('resSubject').value.trim();
  const cls      = document.getElementById('resClass').value;
  const term     = document.getElementById('resTerm').value;
  const year     = document.getElementById('resYear').value.trim();
  const copies   = parseInt(document.getElementById('resCopies').value)||1;
  const condition= document.getElementById('resCondition').value;
  const author   = document.getElementById('resAuthor').value.trim();
  const location = document.getElementById('resLocation').value.trim();
  const addedBy  = document.getElementById('resAddedBy').value.trim();
  const notes    = document.getElementById('resNotes').value.trim();
  const editId   = document.getElementById('resEditId').value;

  if (!title) { showToast('⚠️ Enter a title for this resource.'); return; }
  if (!type)  { showToast('⚠️ Select a resource type.'); return; }

  if (editId) {
    const r = state.resources.find(r => r.id === parseInt(editId));
    if (r) Object.assign(r, {title,type,subject,cls,term,year,copies,condition,author,location,addedBy,notes});
    showToast('✅ Resource updated!');
  } else {
    state.resources.push({id:state.nextResourceId++, title,type,subject,cls,term,year,copies,condition,author,location,addedBy,notes, dateAdded:new Date().toISOString()});
    showToast('✅ Resource added to library!');
  }
  renderResources(); autosave();
  document.getElementById('resourceModal').classList.remove('open');
}

function editResource(id) {
  const r = state.resources.find(r => r.id === id);
  if (!r) return;
  document.getElementById('resourceModalTitle').innerHTML = '<i class="fas fa-book-open"></i> Edit Resource';
  document.getElementById('resEditId').value = id;
  document.getElementById('resTitle').value   = r.title||'';
  document.getElementById('resType').value    = r.type||'';
  document.getElementById('resSubject').value = r.subject||'';
  document.getElementById('resClass').value   = r.cls||'All Classes';
  document.getElementById('resTerm').value    = r.term||'';
  document.getElementById('resYear').value    = r.year||'';
  document.getElementById('resCopies').value  = r.copies||1;
  document.getElementById('resCondition').value = r.condition||'Good';
  document.getElementById('resAuthor').value  = r.author||'';
  document.getElementById('resLocation').value= r.location||'';
  document.getElementById('resAddedBy').value = r.addedBy||'';
  document.getElementById('resNotes').value   = r.notes||'';
  document.getElementById('resourceModal').classList.add('open');
}

function deleteResource(id) {
  if (!confirm('Remove this resource from the library?')) return;
  state.resources = state.resources.filter(r => r.id !== id);
  renderResources(); autosave(); showToast('🗑️ Resource removed.');
}

function clearResourceModal() {
  ['resTitle','resSubject','resYear','resAuthor','resLocation','resAddedBy','resNotes'].forEach(i => {
    const el = document.getElementById(i); if (el) el.value='';
  });
  const t = document.getElementById('resType'); if(t) t.value='';
  const cls = document.getElementById('resClass'); if(cls) cls.value='All Classes';
  const term = document.getElementById('resTerm'); if(term) term.value='';
  const copies = document.getElementById('resCopies'); if(copies) copies.value='1';
  const cond = document.getElementById('resCondition'); if(cond) cond.value='New';
  document.getElementById('resEditId').value='';
}

function downloadResourcesCSV() {
  const rows = (state.resources||[]).map((r,i) => [i+1, r.title||'', r.type||'', r.subject||'', r.cls||'', r.term||'', r.year||'', r.copies||1, r.condition||'', r.author||'', r.location||'', r.addedBy||'', r.notes||'']);
  let csv = 'No,Title,Type,Subject,Class,Term,Year,Copies,Condition,Author/Publisher,Location,Added By,Notes\n';
  rows.forEach(r => { csv += r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',') + '\n'; });
  const blob = new Blob([csv], {type:'text/csv'});
  const a = Object.assign(document.createElement('a'), {href:URL.createObjectURL(blob), download:'resources.csv'});
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ── RESOURCE CONTENT TAB SWITCHER ──
function switchResTab(tab) {
  ['file','text','link'].forEach(t => {
    const btn   = document.getElementById('resTab'+t.charAt(0).toUpperCase()+t.slice(1));
    const panel = document.getElementById('resContent'+t.charAt(0).toUpperCase()+t.slice(1));
    const active = t === tab;
    if (btn)   { btn.style.background = active ? 'var(--blue)' : 'var(--surface)'; btn.style.color = active ? '#fff' : 'var(--text)'; }
    if (panel) panel.style.display = active ? '' : 'none';
  });
}
function handleResFileDrop(event) {
  event.preventDefault();
  const zone = document.getElementById('resDropZone');
  zone.style.borderColor=''; zone.style.background='var(--bg)';
  if (event.dataTransfer.files[0]) processResFile(event.dataTransfer.files[0]);
}
function processResFile(file) {
  if (file.size > 10*1024*1024) { showToast('⚠️ File too large. Max 10MB.'); return; }
  const ext = file.name.split('.').pop().toLowerCase();
  const icons = {pdf:'fas fa-file-pdf',doc:'fas fa-file-word',docx:'fas fa-file-word',
                 ppt:'fas fa-file-powerpoint',pptx:'fas fa-file-powerpoint',
                 xls:'fas fa-file-excel',xlsx:'fas fa-file-excel',
                 png:'fas fa-file-image',jpg:'fas fa-file-image',jpeg:'fas fa-file-image',txt:'fas fa-file-alt'};
  const reader = new FileReader();
  reader.onload = ev => {
    const zone=document.getElementById('resDropZone');
    const preview=document.getElementById('resFilePreview');
    const icon=document.getElementById('resFileIcon');
    const nameEl=document.getElementById('resFileName');
    const sizeEl=document.getElementById('resFileSize');
    if(zone) zone.style.display='none';
    if(preview) preview.style.display='flex';
    if(icon) { icon.className=(icons[ext]||'fas fa-file'); icon.style.color=ext==='pdf'?'#dc2626':ext.includes('doc')?'#2563eb':ext.includes('xls')?'#16a34a':'var(--blue)'; }
    if(nameEl) nameEl.textContent=file.name;
    if(sizeEl) sizeEl.textContent=(file.size/1024).toFixed(0)+' KB · '+ext.toUpperCase();
    const inp=document.getElementById('resFileInput');
    if(inp){ inp.dataset.fileData=ev.target.result; inp.dataset.fileName=file.name; inp.dataset.fileType=file.type; inp.dataset.fileExt=ext; }
    const titleEl=document.getElementById('resTitle');
    if(titleEl&&!titleEl.value) titleEl.value=file.name.replace(/\.[^.]+$/,'');
    showToast('File ready — click Save to attach');
  };
  reader.readAsDataURL(file);
}
function clearResFile() {
  const input=document.getElementById('resFileInput');
  const zone=document.getElementById('resDropZone');
  const preview=document.getElementById('resFilePreview');
  if(input){input.value='';input.dataset.fileData='';input.dataset.fileName='';}
  if(zone) zone.style.display='';
  if(preview) preview.style.display='none';
}

function portalToggleText(id) {
  const div=document.getElementById(id);
  const btn=document.getElementById('btn_'+id);
  if(!div) return;
  const showing=div.style.display!=='none'&&div.style.display!=='';
  div.style.display=showing?'none':'block';
  if(btn) btn.innerHTML=showing?'<i class="fas fa-book-open"></i> Read Content':'<i class="fas fa-chevron-up"></i> Hide Content';
}

function initResources() {
  renderResources();
  const addBtn = document.getElementById('addResourceBtn');
  if (addBtn) addBtn.addEventListener('click', () => {
    document.getElementById('resourceModalTitle').innerHTML = '<i class="fas fa-book-open"></i> Add Resource';
    clearResourceModal();
    const yr = document.getElementById('resYear');
    if (yr && state.settings?.session) yr.value = state.settings.session;
    document.getElementById('resourceModal').classList.add('open');
  });
  const closeBtn  = document.getElementById('closeResourceModal');
  const cancelBtn = document.getElementById('cancelResourceModal');
  const saveBtn   = document.getElementById('saveResourceBtn');
  const fileInput = document.getElementById('resFileInput');
  if (closeBtn)  closeBtn.addEventListener('click',  () => document.getElementById('resourceModal').classList.remove('open'));
  if (cancelBtn) cancelBtn.addEventListener('click', () => document.getElementById('resourceModal').classList.remove('open'));
  if (saveBtn)   saveBtn.addEventListener('click', saveResource);
  if (fileInput) fileInput.addEventListener('change', e => { if (e.target.files[0]) processResFile(e.target.files[0]); });
  const searchEl = document.getElementById('resSearch');
  if (searchEl) searchEl.addEventListener('input', renderResources);
}


// ══════════════════════════════════════
// THEME SYSTEM
// ══════════════════════════════════════
const THEMES = {
  blue:   { name:'GES Blue',      '--blue':'#1a6fd4', '--blue-light':'#e8f0fb', '--blue-dark':'#1255a8', '--sidebar-bg':'#0f2a5e', '--sidebar-active':'#1a6fd4' },
  teal:   { name:'Ocean Teal',    '--blue':'#0891b2', '--blue-light':'#e0f7fd', '--blue-dark':'#0670a0', '--sidebar-bg':'#0c3347', '--sidebar-active':'#0891b2' },
  green:  { name:'Forest Green',  '--blue':'#16a34a', '--blue-light':'#dcfce7', '--blue-dark':'#15803d', '--sidebar-bg':'#0d2e1c', '--sidebar-active':'#16a34a' },
  purple: { name:'Royal Purple',  '--blue':'#7c3aed', '--blue-light':'#ede9fe', '--blue-dark':'#6d28d9', '--sidebar-bg':'#1e1035', '--sidebar-active':'#7c3aed' },
  red:    { name:'Crimson Red',   '--blue':'#dc2626', '--blue-light':'#fee2e2', '--blue-dark':'#b91c1c', '--sidebar-bg':'#2d0a0a', '--sidebar-active':'#dc2626' },
  slate:  { name:'Slate Dark',    '--blue':'#475569', '--blue-light':'#f1f5f9', '--blue-dark':'#334155', '--sidebar-bg':'#1e293b', '--sidebar-active':'#475569' },
};

function applyTheme(themeKey) {
  const theme = THEMES[themeKey];
  if (!theme) return;
  state.appTheme = themeKey;
  const root = document.documentElement;
  root.style.setProperty('--blue', theme['--blue']);
  root.style.setProperty('--blue-light', theme['--blue-light']);
  root.style.setProperty('--blue-dark', theme['--blue-dark']);
  // Sidebar color
  const sidebar = document.querySelector('.sidebar');
  if (sidebar) sidebar.style.background = theme['--sidebar-bg'];
  // Active nav items
  document.querySelectorAll('.nav-item.active').forEach(el => {
    el.style.background = theme['--sidebar-active'];
  });
  autosave();
  renderThemeSwatches();
}

function applySidebarStyle(style) {
  state.sidebarStyle = style;
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  if (style === 'light') {
    sidebar.style.background = '#ffffff';
    sidebar.style.borderRight = '1px solid #dde3ef';
    document.querySelectorAll('.nav-item').forEach(el => {
      el.style.color = '#1a2133';
    });
  } else if (style === 'gradient') {
    sidebar.style.background = 'linear-gradient(160deg, #1a6fd4 0%, #0f2a5e 60%)';
    sidebar.style.borderRight = 'none';
  } else {
    sidebar.style.background = '#0f2a5e';
    sidebar.style.borderRight = 'none';
  }
  autosave();
}

function applyFontSize(size) {
  state.fontSize = size;
  document.documentElement.style.fontSize = size + 'px';
  autosave();
}

function renderThemeSwatches() {
  const grid = document.getElementById('themeSwatchGrid');
  if (!grid) return;
  grid.innerHTML = Object.entries(THEMES).map(([key, t]) => `
    <div onclick="applyTheme('${key}')" style="cursor:pointer;border-radius:10px;overflow:hidden;border:3px solid ${state.appTheme===key?t['--blue']:'transparent'};transition:all .2s;" title="${t.name}">
      <div style="height:36px;background:${t['--sidebar-bg']};display:flex;align-items:center;justify-content:center;gap:4px;">
        <div style="width:12px;height:12px;border-radius:50%;background:${t['--blue']};"></div>
        <div style="width:30px;height:6px;border-radius:3px;background:rgba(255,255,255,.25);"></div>
      </div>
      <div style="background:${t['--blue-light']};padding:6px 8px;display:flex;align-items:center;gap:6px;">
        <div style="width:20px;height:20px;border-radius:50%;background:${t['--blue']};flex-shrink:0;"></div>
        <div>
          <div style="font-size:11px;font-weight:700;color:${t['--blue']}">${t.name}</div>
          ${state.appTheme===key?`<div style="font-size:10px;color:${t['--blue']}">✓ Active</div>`:''}
        </div>
      </div>
    </div>`).join('');
}

function initTheme() {
  // Restore saved theme
  applyTheme(state.appTheme || 'blue');
  if (state.sidebarStyle) applySidebarStyle(state.sidebarStyle);
  if (state.fontSize) applyFontSize(state.fontSize);
  // Restore select values
  const ssEl = document.getElementById('sidebarStyleSelect');
  if (ssEl && state.sidebarStyle) ssEl.value = state.sidebarStyle;
  const fsEl = document.getElementById('fontSizeSelect');
  if (fsEl && state.fontSize) fsEl.value = state.fontSize;
}

function copySMSMsg(btn) {
  const txt = btn.getAttribute('data-sms') || '';
  navigator.clipboard.writeText(txt).then(() => showToast('📋 SMS copied!')).catch(() => {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = txt; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    showToast('📋 SMS copied!');
  });
}

// ══════════════════════════════════════
// EXAMINATIONS MODULE
// ══════════════════════════════════════
function renderExams() {
  const search = (document.getElementById('examSearch')?.value||'').toLowerCase();
  const typeF  = document.getElementById('examTypeFilter')?.value||'';
  const statF  = document.getElementById('examStatusFilter')?.value||'';
  const tbody  = document.getElementById('examTbody');
  const ttGrid = document.getElementById('examTimetableGrid');
  if (!tbody) return;

  let data = state.exams || [];
  if (search) data = data.filter(e => (e.title||'').toLowerCase().includes(search)||(e.cls||'').toLowerCase().includes(search)||(e.subject||'').toLowerCase().includes(search));
  if (typeF)  data = data.filter(e => e.type === typeF);
  if (statF)  data = data.filter(e => e.status === statF);

  const all = state.exams || [];
  const today = new Date().toISOString().split('T')[0];
  if (document.getElementById('examTotalCount'))    document.getElementById('examTotalCount').textContent    = all.length;
  if (document.getElementById('examUpcomingCount')) document.getElementById('examUpcomingCount').textContent = all.filter(e=>e.date>=today&&e.status!=='Completed'&&e.status!=='Cancelled').length;
  if (document.getElementById('examDoneCount'))     document.getElementById('examDoneCount').textContent     = all.filter(e=>e.status==='Completed').length;
  if (document.getElementById('examMidtermCount'))  document.getElementById('examMidtermCount').textContent  = all.filter(e=>e.type==='Midterm').length;

  const statusColor = {Scheduled:'var(--blue)',Ongoing:'var(--yellow)',Completed:'var(--green)',Cancelled:'var(--red)'};
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:32px;color:var(--text-light);"><i class="fas fa-file-pen" style="font-size:28px;display:block;margin-bottom:10px;"></i>No exams yet. Click "Create Exam" to add one.</td></tr>`;
    if (ttGrid) ttGrid.innerHTML = '';
    return;
  }

  tbody.innerHTML = data.sort((a,b)=>(a.date||'').localeCompare(b.date||'')).map((e,i) => `<tr>
    <td>${i+1}</td>
    <td><strong>${e.title||'—'}</strong>${e.invigilator?`<br><small style="color:var(--text-muted)">${e.invigilator}</small>`:''}</td>
    <td><span style="background:var(--blue-light);color:var(--blue);padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;">${e.type||'—'}</span></td>
    <td>${e.cls||'—'}</td>
    <td>${e.subject||'All Subjects'}</td>
    <td>${e.date ? new Date(e.date+'T00:00').toLocaleDateString('en-GH',{day:'numeric',month:'short',year:'numeric'}) : '—'}</td>
    <td>${e.time||'—'}</td>
    <td>${e.duration ? e.duration+' mins' : '—'}</td>
    <td>${e.venue||'—'}</td>
    <td><span style="color:${statusColor[e.status]||'var(--text)'};font-weight:700;font-size:12px;">${e.status||'—'}</span></td>
    <td>
      <button class="tbl-btn" onclick="editExam(${e.id})"><i class="fas fa-edit"></i></button>
      <button class="tbl-btn" onclick="printExamSlip(${e.id})"><i class="fas fa-print"></i></button>
      <button class="tbl-btn danger" onclick="deleteExam(${e.id})"><i class="fas fa-trash"></i></button>
    </td>
  </tr>`).join('');

  // Timetable
  if (ttGrid) {
    const upcoming = (state.exams||[]).filter(e=>e.date>=today&&e.status!=='Cancelled').sort((a,b)=>a.date.localeCompare(b.date));
    if (!upcoming.length) { ttGrid.innerHTML = `<p style="color:var(--text-muted);font-size:13px;">No upcoming exams scheduled.</p>`; return; }
    ttGrid.innerHTML = `
      <div class="exam-timetable-row"><div>Date</div><div>Exam / Subject</div><div>Class · Time</div><div>Status</div></div>
      ${upcoming.map(e=>`
        <div class="exam-timetable-row">
          <div style="font-weight:700;">${new Date(e.date+'T00:00').toLocaleDateString('en-GH',{weekday:'short',day:'numeric',month:'short'})}</div>
          <div><strong>${e.title||'—'}</strong>${e.subject&&e.subject!=='All Subjects'?`<br><small>${e.subject}</small>`:''}</div>
          <div><strong>${e.cls||'—'}</strong>${e.time?`<br><small>${e.time}${e.duration?' · '+e.duration+' mins':''}</small>`:''}</div>
          <div><span style="color:${statusColor[e.status]||'var(--text)'};font-weight:700;font-size:12px;">${e.status||'—'}</span></div>
        </div>`).join('')}`;
  }
}

function saveExam() {
  const title  = document.getElementById('examTitle').value.trim();
  const type   = document.getElementById('examType').value;
  const cls    = document.getElementById('examClass').value;
  const subject= document.getElementById('examSubject').value.trim();
  const date   = document.getElementById('examDate').value;
  const time   = document.getElementById('examTime').value;
  const duration= parseInt(document.getElementById('examDuration').value)||null;
  const term   = document.getElementById('examTerm').value;
  const year   = document.getElementById('examYear').value.trim();
  const venue  = document.getElementById('examVenue').value.trim();
  const invig  = document.getElementById('examInvigilator').value.trim();
  const marks  = parseInt(document.getElementById('examTotalMarks').value)||100;
  const status = document.getElementById('examStatus').value;
  const notes  = document.getElementById('examNotes').value.trim();
  const editId = document.getElementById('examEditId').value;

  if (!title) { showToast('⚠️ Enter an exam title.'); return; }
  if (!type)  { showToast('⚠️ Select exam type.'); return; }
  if (!date)  { showToast('⚠️ Select a date.'); return; }

  const obj = {title,type,cls,subject,date,time,duration,term,year,venue,invigilator:invig,totalMarks:marks,status,notes};
  if (editId) {
    const e = state.exams.find(e=>e.id===parseInt(editId));
    if (e) Object.assign(e, obj);
    showToast('✅ Exam updated!');
  } else {
    state.exams.push({id:state.nextExamId++, ...obj, createdAt:new Date().toISOString()});
    showToast('✅ Exam created!');
  }
  renderExams(); autosave();
  document.getElementById('examModal').classList.remove('open');
}

function editExam(id) {
  const e = state.exams.find(e=>e.id===id); if (!e) return;
  document.getElementById('examModalTitle').innerHTML = '<i class="fas fa-file-pen"></i> Edit Exam';
  document.getElementById('examEditId').value = id;
  ['examTitle','examType','examClass','examSubject','examDate','examTime','examTerm','examYear','examVenue','examInvigilator','examStatus','examNotes'].forEach(fid => {
    const map = {examTitle:'title',examType:'type',examClass:'cls',examSubject:'subject',examDate:'date',examTime:'time',examTerm:'term',examYear:'year',examVenue:'venue',examInvigilator:'invigilator',examStatus:'status',examNotes:'notes'};
    const el = document.getElementById(fid); if (el) el.value = e[map[fid]]||'';
  });
  document.getElementById('examDuration').value = e.duration||'';
  document.getElementById('examTotalMarks').value = e.totalMarks||100;
  document.getElementById('examModal').classList.add('open');
}

function deleteExam(id) {
  if (!confirm('Delete this exam?')) return;
  state.exams = state.exams.filter(e=>e.id!==id);
  renderExams(); autosave(); showToast('🗑️ Exam deleted.');
}

function printExamSlip(id) {
  const e = state.exams.find(e=>e.id===id); if (!e) return;
  const s = state.settings;
  const win = window.open('','_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Exam Slip</title>
<style>body{font-family:'Segoe UI',Arial,sans-serif;padding:30px;color:#222;max-width:600px;margin:auto;}
.header{border-bottom:3px solid #1a6fd4;padding-bottom:16px;margin-bottom:20px;text-align:center;}
.school{font-size:20px;font-weight:800;color:#1a6fd4;} .sub{font-size:12px;color:#666;}
.badge{display:inline-block;background:#e8f0fb;color:#1a6fd4;padding:4px 14px;border-radius:20px;font-weight:700;font-size:13px;margin:10px 0;}
table{width:100%;border-collapse:collapse;margin:16px 0;}
td{padding:9px 12px;border-bottom:1px solid #eee;font-size:13px;}
td:first-child{font-weight:700;color:#444;width:160px;}
.footer{margin-top:32px;text-align:center;font-size:11px;color:#999;border-top:1px solid #eee;padding-top:12px;}
</style></head><body>
<div class="header"><div class="school">${s.schoolName||'School'}</div>
<div class="sub">${s.address||''} | ${s.district||''}</div>
<div class="badge">EXAMINATION SLIP</div></div>
<table>
<tr><td>Exam Title</td><td><strong>${e.title}</strong></td></tr>
<tr><td>Type</td><td>${e.type}</td></tr>
<tr><td>Class</td><td>${e.cls}</td></tr>
<tr><td>Subject</td><td>${e.subject||'All Subjects'}</td></tr>
<tr><td>Date</td><td>${e.date ? new Date(e.date+'T00:00').toLocaleDateString('en-GH',{weekday:'long',day:'numeric',month:'long',year:'numeric'}) : '—'}</td></tr>
<tr><td>Start Time</td><td>${e.time||'—'}</td></tr>
<tr><td>Duration</td><td>${e.duration ? e.duration+' minutes' : '—'}</td></tr>
<tr><td>Venue</td><td>${e.venue||'—'}</td></tr>
<tr><td>Invigilator</td><td>${e.invigilator||'—'}</td></tr>
<tr><td>Total Marks</td><td>${e.totalMarks||100}</td></tr>
<tr><td>Term</td><td>${e.term||'—'}</td></tr>
<tr><td>Academic Year</td><td>${e.year||s.session||'—'}</td></tr>
${e.notes?`<tr><td>Instructions</td><td>${e.notes}</td></tr>`:''}
</table>
<div class="footer">EduManage Pro — ${s.schoolName||'School'} | Printed ${new Date().toLocaleString('en-GH')}</div>
<script>window.onload=function(){window.print();}<\/script>
</body></html>`); win.document.close();
}

function downloadExamsCSV() {
  let csv = 'No,Title,Type,Class,Subject,Date,Time,Duration,Venue,Invigilator,Status,Term,Year\n';
  (state.exams||[]).forEach((e,i) => { csv += `"${i+1}","${e.title||''}","${e.type||''}","${e.cls||''}","${e.subject||''}","${e.date||''}","${e.time||''}","${e.duration||''}","${e.venue||''}","${e.invigilator||''}","${e.status||''}","${e.term||''}","${e.year||''}"\n`; });
  const a = Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([csv],{type:'text/csv'})),download:'exams.csv'});
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function initExams() {
  renderExams();
  document.getElementById('addExamBtn').addEventListener('click', () => {
    document.getElementById('examModalTitle').innerHTML = '<i class="fas fa-file-pen"></i> Create Exam';
    document.getElementById('examEditId').value = '';
    ['examTitle','examSubject','examDate','examTime','examVenue','examInvigilator','examNotes'].forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
    document.getElementById('examType').value = '';
    document.getElementById('examClass').value = 'All Classes';
    document.getElementById('examDuration').value = '60';
    document.getElementById('examTotalMarks').value = '100';
    document.getElementById('examStatus').value = 'Scheduled';
    if (state.settings.session) document.getElementById('examYear').value = state.settings.session;
    if (state.settings.term)    document.getElementById('examTerm').value  = state.settings.term;
    document.getElementById('examModal').classList.add('open');
  });
  document.getElementById('closeExamModal').addEventListener('click', ()=>document.getElementById('examModal').classList.remove('open'));
  document.getElementById('cancelExamModal').addEventListener('click', ()=>document.getElementById('examModal').classList.remove('open'));
  document.getElementById('saveExamBtn').addEventListener('click', saveExam);
  document.getElementById('printExamSlipBtn').addEventListener('click', ()=>{ const id=document.getElementById('examEditId').value; if(id) printExamSlip(parseInt(id)); });
  document.getElementById('examSearch').addEventListener('input', renderExams);
}

// ══════════════════════════════════════
// TRANSFERS & WITHDRAWALS MODULE
// ══════════════════════════════════════
function renderTransfers() {
  const search = (document.getElementById('transferSearch')?.value||'').toLowerCase();
  const typeF  = document.getElementById('transferTypeFilter')?.value||'';
  const tbody  = document.getElementById('transferTbody');
  if (!tbody) return;

  let data = state.transfers || [];
  if (search) data = data.filter(t => (t.pupilName||'').toLowerCase().includes(search)||(t.fromTo||'').toLowerCase().includes(search));
  if (typeF)  data = data.filter(t => t.type === typeF);

  const all = state.transfers || [];
  if (document.getElementById('transferTotalCount')) document.getElementById('transferTotalCount').textContent = all.length;
  if (document.getElementById('transferInCount'))    document.getElementById('transferInCount').textContent    = all.filter(t=>t.type==='Transfer In').length;
  if (document.getElementById('transferOutCount'))   document.getElementById('transferOutCount').textContent   = all.filter(t=>t.type==='Transfer Out').length;
  if (document.getElementById('withdrawalCount'))    document.getElementById('withdrawalCount').textContent    = all.filter(t=>t.type==='Withdrawal').length;

  const typeColor = {'Transfer In':'var(--green)','Transfer Out':'var(--red)','Withdrawal':'var(--yellow)'};
  if (!data.length) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--text-light);"><i class="fas fa-exchange-alt" style="font-size:28px;display:block;margin-bottom:10px;"></i>No transfer or withdrawal records yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = data.sort((a,b)=>(b.date||'').localeCompare(a.date||'')).map((t,i) => `<tr>
    <td>${i+1}</td>
    <td><strong>${t.pupilName||'—'}</strong></td>
    <td>${t.cls||'—'}</td>
    <td><span style="color:${typeColor[t.type]||'var(--text)'};font-weight:700;font-size:12px;">${t.type||'—'}</span></td>
    <td>${t.date ? new Date(t.date+'T00:00').toLocaleDateString('en-GH',{day:'numeric',month:'short',year:'numeric'}) : '—'}</td>
    <td>${t.fromTo||'—'}</td>
    <td style="max-width:140px;font-size:12px;">${t.reason||'—'}</td>
    <td>${t.auth||'—'}</td>
    <td><span style="font-size:11px;font-weight:600;color:${t.cert&&t.cert!=='No'?'var(--green)':'var(--text-muted)'};">${t.cert||'No'}</span></td>
    <td>
      <button class="tbl-btn" onclick="editTransfer(${t.id})"><i class="fas fa-edit"></i></button>
      <button class="tbl-btn" onclick="printTransferCert(${t.id})"><i class="fas fa-print"></i></button>
      <button class="tbl-btn danger" onclick="deleteTransfer(${t.id})"><i class="fas fa-trash"></i></button>
    </td>
  </tr>`).join('');
}

function autoFillTransferPupil(val) {
  const s = state.students.find(s=>s.id===parseInt(val));
  if (s) {
    document.getElementById('transferPupilName').value = `${s.first} ${s.last}`;
    document.getElementById('transferPupilClass').value = s.cls;
  }
}

function updateTransferFromTo() {
  const type = document.getElementById('transferType').value;
  const lbl  = document.getElementById('transferFromToLabel');
  if (!lbl) return;
  if (type==='Transfer In')  { lbl.textContent='From School'; document.getElementById('transferFromTo').placeholder='Name of sending school'; }
  else if (type==='Transfer Out') { lbl.textContent='To School'; document.getElementById('transferFromTo').placeholder='Name of receiving school'; }
  else { lbl.textContent='Former School / Institution'; document.getElementById('transferFromTo').placeholder='School name (if applicable)'; }
}

function saveTransfer() {
  const sel  = document.getElementById('transferStudentSelect').value;
  const name = document.getElementById('transferPupilName').value.trim();
  const cls  = document.getElementById('transferPupilClass').value.trim();
  const type = document.getElementById('transferType').value;
  const date = document.getElementById('transferDate').value;
  const fromTo= document.getElementById('transferFromTo').value.trim();
  const reason= document.getElementById('transferReason').value.trim();
  const auth = document.getElementById('transferAuth').value.trim();
  const cert = document.getElementById('transferCert').value;
  const notes= document.getElementById('transferNotes').value.trim();
  const editId= document.getElementById('transferEditId').value;

  if (!name) { showToast('⚠️ Enter pupil name.'); return; }
  if (!type) { showToast('⚠️ Select record type.'); return; }
  if (!date) { showToast('⚠️ Select a date.'); return; }

  const studentId = sel ? parseInt(sel) : null;
  const obj = {pupilName:name, cls, type, date, fromTo, reason, auth, cert, notes, studentId};

  if (editId) {
    const t = state.transfers.find(t=>t.id===parseInt(editId));
    if (t) Object.assign(t, obj);
    showToast('✅ Record updated!');
  } else {
    state.transfers.push({id:state.nextTransferId++, ...obj, createdAt:new Date().toISOString()});
    showToast('✅ Transfer record saved!');
    // Optionally mark pupil as inactive on transfer out/withdrawal
    if ((type==='Transfer Out'||type==='Withdrawal') && studentId) {
      const pupil = state.students.find(s=>s.id===studentId);
      if (pupil) pupil.transferred = type;
    }
  }
  renderTransfers(); autosave();
  document.getElementById('transferModal').classList.remove('open');
}

function editTransfer(id) {
  const t = state.transfers.find(t=>t.id===id); if (!t) return;
  document.getElementById('transferModalTitle').innerHTML = '<i class="fas fa-exchange-alt"></i> Edit Transfer Record';
  document.getElementById('transferEditId').value = id;
  // Populate student dropdown
  populateTransferStudentDropdown(t.studentId);
  document.getElementById('transferPupilName').value  = t.pupilName||'';
  document.getElementById('transferPupilClass').value = t.cls||'';
  document.getElementById('transferType').value       = t.type||'';
  document.getElementById('transferDate').value       = t.date||'';
  document.getElementById('transferFromTo').value     = t.fromTo||'';
  document.getElementById('transferReason').value     = t.reason||'';
  document.getElementById('transferAuth').value       = t.auth||'';
  document.getElementById('transferCert').value       = t.cert||'No';
  document.getElementById('transferNotes').value      = t.notes||'';
  updateTransferFromTo();
  document.getElementById('transferModal').classList.add('open');
}

function deleteTransfer(id) {
  if (!confirm('Delete this transfer record?')) return;
  state.transfers = state.transfers.filter(t=>t.id!==id);
  renderTransfers(); autosave(); showToast('🗑️ Record deleted.');
}

function populateTransferStudentDropdown(selectedId) {
  const sel = document.getElementById('transferStudentSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Select pupil --</option>';
  state.students.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.first} ${s.last} (${s.cls})`;
    if (s.id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  });
}

function printTransferCert(id) {
  const t = state.transfers.find(t=>t.id===id); if (!t) return;
  const s = state.settings;
  const isWithdrawal = t.type === 'Withdrawal';
  const docTitle = isWithdrawal ? 'WITHDRAWAL CERTIFICATE' : 'TRANSFER CERTIFICATE';
  const win = window.open('','_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>${docTitle}</title>
<style>body{font-family:'Georgia',serif;padding:50px;color:#222;max-width:680px;margin:auto;border:2px solid #1a6fd4;}
.header{text-align:center;border-bottom:2px solid #1a6fd4;padding-bottom:20px;margin-bottom:24px;}
.school{font-size:22px;font-weight:800;color:#1a6fd4;} .sub{font-size:12px;color:#666;margin-top:4px;}
.cert-title{font-size:20px;font-weight:800;color:#333;margin:16px 0;letter-spacing:2px;text-transform:uppercase;}
.body{font-size:14px;line-height:2;} .blank{border-bottom:1px solid #333;display:inline-block;min-width:200px;}
.sig{display:flex;justify-content:space-between;margin-top:60px;}
.sig-box{text-align:center;width:200px;} .sig-line{border-top:1px solid #333;padding-top:6px;font-size:12px;}
.footer{text-align:center;margin-top:30px;font-size:11px;color:#999;}
</style></head><body>
<div class="header">
  <div class="school">${s.schoolName||'School Name'}</div>
  <div class="sub">${s.address||''} ${s.district?'| '+s.district:''}</div>
  <div class="sub">Headmaster: ${s.principal||'—'} &nbsp;|&nbsp; GES Circuit: ${s.district||'—'}</div>
</div>
<div style="text-align:center;"><div class="cert-title">${docTitle}</div></div>
<div class="body">
  <p>This is to certify that <strong class="blank">${t.pupilName||'_______________________'}</strong> 
  was a pupil of this school in Class <strong class="blank">${t.cls||'___________'}</strong>.</p>
  ${t.type==='Transfer In'
    ? `<p>The said pupil was transferred to this school from <strong class="blank">${t.fromTo||'_______________________'}</strong> on <strong>${t.date?new Date(t.date+'T00:00').toLocaleDateString('en-GH',{day:'numeric',month:'long',year:'numeric'}):'_______________'}</strong>.</p>`
    : t.type==='Transfer Out'
    ? `<p>The said pupil is hereby transferred to <strong class="blank">${t.fromTo||'_______________________'}</strong> on <strong>${t.date?new Date(t.date+'T00:00').toLocaleDateString('en-GH',{day:'numeric',month:'long',year:'numeric'}):'_______________'}</strong>.</p>`
    : `<p>The said pupil formally withdrew from this school on <strong>${t.date?new Date(t.date+'T00:00').toLocaleDateString('en-GH',{day:'numeric',month:'long',year:'numeric'}):'_______________'}</strong>.</p>`
  }
  ${t.reason?`<p><strong>Reason:</strong> ${t.reason}</p>`:''}
  <p>We wish the pupil well in all future endeavours.</p>
</div>
<div class="sig">
  <div class="sig-box"><div class="sig-line">Class Teacher</div></div>
  <div class="sig-box"><div class="sig-line">Date</div></div>
  <div class="sig-box"><div class="sig-line">Headmaster / Headmistress<br>${s.principal||''}</div></div>
</div>
<div class="footer">EduManage Pro — ${s.schoolName||'School'} | Printed ${new Date().toLocaleString('en-GH')} | Official School Stamp: ___________</div>
<script>window.onload=function(){window.print();}<\/script>
</body></html>`); win.document.close();
}

function downloadTransfersCSV() {
  let csv = 'No,Pupil Name,Class,Type,Date,From/To,Reason,Auth By,Certificate\n';
  (state.transfers||[]).forEach((t,i) => { csv += `"${i+1}","${t.pupilName||''}","${t.cls||''}","${t.type||''}","${t.date||''}","${t.fromTo||''}","${t.reason||''}","${t.auth||''}","${t.cert||''}"\n`; });
  const a = Object.assign(document.createElement('a'),{href:URL.createObjectURL(new Blob([csv],{type:'text/csv'})),download:'transfers.csv'});
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function initTransfers() {
  renderTransfers();
  document.getElementById('addTransferBtn').addEventListener('click', () => {
    document.getElementById('transferModalTitle').innerHTML = '<i class="fas fa-exchange-alt"></i> Add Transfer Record';
    document.getElementById('transferEditId').value = '';
    ['transferPupilName','transferPupilClass','transferFromTo','transferReason','transferAuth','transferNotes'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    document.getElementById('transferType').value = '';
    document.getElementById('transferCert').value = 'No';
    document.getElementById('transferDate').value = new Date().toISOString().split('T')[0];
    populateTransferStudentDropdown(null);
    document.getElementById('transferModal').classList.add('open');
  });
  document.getElementById('closeTransferModal').addEventListener('click', ()=>document.getElementById('transferModal').classList.remove('open'));
  document.getElementById('cancelTransferModal').addEventListener('click', ()=>document.getElementById('transferModal').classList.remove('open'));
  document.getElementById('saveTransferBtn').addEventListener('click', saveTransfer);
  document.getElementById('printTransferCertBtn').addEventListener('click', ()=>{ const id=document.getElementById('transferEditId').value; if(id) printTransferCert(parseInt(id)); else showToast('⚠️ Save the record first.'); });
  document.getElementById('transferSearch').addEventListener('input', renderTransfers);
}

// ══════════════════════════════════════
// COMMUNICATION MODULE
// ══════════════════════════════════════
function switchCommTab(tab) {
  ['announcements','sms','parent'].forEach(t => {
    document.getElementById('commTab'+t.charAt(0).toUpperCase()+t.slice(1)).classList.toggle('active', t===tab);
    document.getElementById('commPanel'+t.charAt(0).toUpperCase()+t.slice(1)).style.display = t===tab?'':'none';
  });
  if (tab==='sms') generateSMSReminders2();
  if (tab==='parent') renderParentNotifications();
}

function renderAnnouncements() {
  const list = document.getElementById('announcementsList');
  if (!list) return;
  const items = (state.announcements||[]).slice().reverse();
  if (!items.length) { list.innerHTML = `<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px;"><i class="fas fa-bullhorn"></i> No announcements yet.</p>`; return; }
  const prioIcon = {Urgent:'🚨',Important:'⚠️',Normal:'📢'};
  const prioBg   = {Urgent:'#fee2e2',Important:'#fef3c7',Normal:'var(--bg)'};
  list.innerHTML = items.map(a => `
    <div class="ann-card" style="background:${prioBg[a.priority]||'var(--bg)'};">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
        <div>
          <span style="font-size:14px;font-weight:700;">${prioIcon[a.priority]||'📢'} ${a.title}</span>
          <span class="ann-priority-${(a.priority||'normal').toLowerCase()}" style="margin-left:8px;">${a.priority}</span>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="tbl-btn" onclick="editAnnouncement(${a.id})" style="padding:3px 7px;"><i class="fas fa-edit"></i></button>
          <button class="tbl-btn danger" onclick="deleteAnnouncement(${a.id})" style="padding:3px 7px;"><i class="fas fa-trash"></i></button>
        </div>
      </div>
      <p style="font-size:13px;color:var(--text-muted);margin:4px 0 8px;">${a.message}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--text-light);">
        <span><i class="fas fa-users"></i> ${a.audience}</span>
        ${a.cls&&a.audience==='Class'?`<span><i class="fas fa-school"></i> ${a.cls}</span>`:''}
        <span><i class="fas fa-clock"></i> ${a.postedAt ? new Date(a.postedAt).toLocaleString('en-GH') : '—'}</span>
      </div>
    </div>`).join('');
}

function saveAnnouncement() {
  const title    = document.getElementById('annTitle').value.trim();
  const audience = document.getElementById('annAudience').value;
  const cls      = document.getElementById('annClass').value;
  const priority = document.getElementById('annPriority').value;
  const message  = document.getElementById('annMessage').value.trim();
  const editId   = document.getElementById('annEditId').value;

  if (!title||!message) { showToast('⚠️ Title and message are required.'); return; }

  const obj = {title, audience, cls: audience==='Class'?cls:'', priority, message};
  if (editId) {
    const a = state.announcements.find(a=>a.id===parseInt(editId));
    if (a) Object.assign(a, obj);
    showToast('✅ Announcement updated!');
  } else {
    state.announcements.push({id:state.nextAnnouncementId++, ...obj, postedAt:new Date().toISOString(), postedBy:state.currentUser?.name||'Admin'});
    showToast('✅ Announcement posted!');
  }
  document.getElementById('annTitle').value=''; document.getElementById('annMessage').value=''; document.getElementById('annEditId').value='';
  renderAnnouncements(); autosave();
}

function editAnnouncement(id) {
  const a = state.announcements.find(a=>a.id===id); if (!a) return;
  document.getElementById('annEditId').value   = id;
  document.getElementById('annTitle').value    = a.title;
  document.getElementById('annAudience').value = a.audience;
  document.getElementById('annPriority').value = a.priority;
  document.getElementById('annMessage').value  = a.message;
  if (a.cls) document.getElementById('annClass').value = a.cls;
  document.getElementById('annClassRow').style.display = a.audience==='Class' ? '' : 'none';
}

function deleteAnnouncement(id) {
  if (!confirm('Delete this announcement?')) return;
  state.announcements = state.announcements.filter(a=>a.id!==id);
  renderAnnouncements(); autosave(); showToast('🗑️ Announcement deleted.');
}

function generateSMSReminders2() {
  const tbody = document.getElementById('smsTbody2');
  if (!tbody) return;
  const cls    = document.getElementById('smsClassFilter2')?.value||'';
  const status = document.getElementById('smsStatusFilter2')?.value||'';
  let data = state.fees.filter(f => {
    const bal = (f.due||0)-(f.paid||0);
    if (bal<=0 && !status) return false;
    if (bal<=0) return false;
    const st = bal<=(f.due||0)&&(f.paid||0)>0 ? 'Partial' : 'Unpaid';
    if (status && st!==status) return false;
    return true;
  });
  if (cls) data = data.filter(f => f.cls===cls || (state.students.find(s=>`${s.first} ${s.last}`===f.student&&s.cls===cls)));
  if (!data.length) { tbody.innerHTML=`<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--text-muted);">No outstanding fees found.</td></tr>`; return; }
  const sc = state.settings.schoolName||'School';
  tbody.innerHTML = data.map((f,i)=>{
    const bal = (f.due||0)-(f.paid||0);
    const pupil = state.students.find(s=>`${s.first} ${s.last}`===f.student);
    const phone = pupil?.phone || f.phone || '—';
    const smsText = `Dear Parent, ${f.student} (${f.cls||pupil?.cls||'—'}) has an outstanding fee balance of GH₵${bal.toFixed(2)}. Please pay ASAP. — ${sc}`;
    return `<tr>
      <td>${i+1}</td><td><strong>${f.student}</strong></td><td>${f.cls||pupil?.cls||'—'}</td>
      <td style="font-weight:700;color:var(--red);">GH₵${bal.toFixed(2)}</td>
      <td>${phone}</td>
      <td><button class="tbl-btn" onclick="copySMSMsg(this)" data-sms="${escHtml(smsText)}"><i class="fas fa-copy"></i> Copy</button>
          ${phone!=='—'?`<a class="tbl-btn" href="sms:${phone}?body=${encodeURIComponent(smsText)}" style="text-decoration:none;"><i class="fas fa-sms"></i> SMS</a>`:''}
      </td>
    </tr>`;
  }).join('');
  // Also update phone list
  const phones = data.map(f=>{ const p=state.students.find(s=>`${s.first} ${s.last}`===f.student); return p?.phone||f.phone||''; }).filter(Boolean).join(', ');
  const pl = document.getElementById('bulkPhoneList2'); if (pl) pl.value = phones;
  const ct = document.getElementById('bulkSelectedCount2'); if (ct) ct.textContent = `${data.length} recipients`;
}

function renderParentNotifications() {
  const list = document.getElementById('parentNotificationsList');
  if (!list) return;
  // Populate student dropdown
  const sel = document.getElementById('pnStudentSelect');
  if (sel && sel.options.length<=1) {
    state.students.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = `${s.first} ${s.last} (${s.cls})`;
      sel.appendChild(opt);
    });
  }
  const items = (state.parentNotifications||[]).slice().reverse();
  if (!items.length) { list.innerHTML = `<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px;"><i class="fas fa-inbox"></i> No notifications sent yet.</p>`; return; }
  const typeColor = {'Fee Reminder':'var(--red)','Attendance Alert':'var(--yellow)','Exam Notice':'var(--blue)','Behaviour Report':'var(--purple)',General:'var(--teal)'};
  list.innerHTML = items.map(n => {
    const pupil = n.studentId ? state.students.find(s=>s.id===n.studentId) : null;
    return `<div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px 14px;background:var(--surface);">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">
        <div>
          <span style="font-size:13px;font-weight:700;">${n.subject||n.type}</span>
          <span style="margin-left:8px;font-size:11px;color:${typeColor[n.type]||'var(--blue)'};font-weight:600;">${n.type}</span>
        </div>
        <button class="tbl-btn danger" onclick="deletePN(${n.id})" style="padding:3px 7px;"><i class="fas fa-trash"></i></button>
      </div>
      ${pupil?`<div style="font-size:11px;color:var(--blue);margin-bottom:4px;"><i class="fas fa-user-graduate"></i> ${pupil.first} ${pupil.last} (${pupil.cls})</div>`:'<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">All Parents</div>'}
      <p style="font-size:12px;color:var(--text-muted);">${n.message}</p>
      <div style="font-size:11px;color:var(--text-light);margin-top:6px;"><i class="fas fa-clock"></i> ${n.sentAt ? new Date(n.sentAt).toLocaleString('en-GH') : '—'}</div>
    </div>`;
  }).join('');
}

function saveParentNotification() {
  const studentId = parseInt(document.getElementById('pnStudentSelect').value)||null;
  const type      = document.getElementById('pnType').value;
  const subject   = document.getElementById('pnSubject').value.trim();
  const message   = document.getElementById('pnMessage').value.trim();
  if (!message) { showToast('⚠️ Message is required.'); return; }
  state.parentNotifications.push({id:state.nextPNId++, studentId, type, subject, message, sentAt:new Date().toISOString(), sentBy:state.currentUser?.name||'Admin'});
  document.getElementById('pnMessage').value=''; document.getElementById('pnSubject').value='';
  renderParentNotifications(); autosave();
  showToast('✅ Notification sent!');
}

function deletePN(id) {
  if (!confirm('Delete this notification?')) return;
  state.parentNotifications = state.parentNotifications.filter(n=>n.id!==id);
  renderParentNotifications(); autosave(); showToast('🗑️ Deleted.');
}

function initCommunication() {
  document.getElementById('newAnnouncementBtn').addEventListener('click', () => {
    document.getElementById('annEditId').value = '';
    document.getElementById('annTitle').value  = '';
    document.getElementById('annMessage').value= '';
    switchCommTab('announcements');
    document.getElementById('annTitle').focus();
  });
  document.getElementById('saveAnnouncementBtn').addEventListener('click', saveAnnouncement);
  document.getElementById('annAudience').addEventListener('change', function() {
    document.getElementById('annClassRow').style.display = this.value==='Class' ? '' : 'none';
  });
  document.getElementById('savePNBtn').addEventListener('click', saveParentNotification);
  renderAnnouncements();
  renderParentNotifications();
}

// ══════════════════════════════════════
// STUDENT / PARENT PORTAL
// ══════════════════════════════════════
function showStudentPortal(user) {
  document.getElementById('studentPortal').style.display = 'block';
  document.getElementById('portalSchoolName').textContent = state.settings.schoolName || 'EduManage Pro';
  document.getElementById('portalUserName').textContent   = user.name;

  switchPortalTab('fees');
}

function switchPortalTab(tab) {
  ['fees','results','exams','gallery','resources','notices'].forEach(t => {
    const btn   = document.getElementById('ptab'+t.charAt(0).toUpperCase()+t.slice(1));
    const panel = document.getElementById('portalPanel'+t.charAt(0).toUpperCase()+t.slice(1));
    if (btn)   btn.classList.toggle('active', t===tab);
    if (panel) panel.style.display = t===tab ? '' : 'none';
  });
  const user = state.currentUser;
  const perms = user?.permissions || ROLE_PERMISSIONS['Student'];

  if (tab==='fees'     && perms.includes('fees'))      renderPortalFees();
  if (tab==='results'  && perms.includes('results'))   renderPortalResults();
  if (tab==='exams'    && perms.includes('exams'))     renderPortalExams();
  if (tab==='gallery'  && perms.includes('gallery'))   renderPortalGallery();
  if (tab==='resources'&& perms.includes('resources')) renderPortalResources();
  if (tab==='notices'  && perms.includes('notices'))   renderPortalNotices();
}

function _portalPupil() {
  const user = state.currentUser;
  if (!user?.linkedStudentId) return null;
  return state.students.find(s=>s.id===user.linkedStudentId)||null;
}

function renderPortalFees() {
  const panel = document.getElementById('portalPanelFees');
  const pupil = _portalPupil();
  if (!panel) return;
  if (!pupil) { panel.innerHTML = `<div class="card"><p style="color:var(--text-muted);"><i class="fas fa-exclamation-circle"></i> No pupil linked to this account. Please contact the school administrator.</p></div>`; return; }
  const feeRec = state.fees.find(f => f.studentId===pupil.id || f.student===`${pupil.first} ${pupil.last}`);
  const s = state.settings;
  panel.innerHTML = `
    <div style="display:grid;gap:20px;">
      <div class="card">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;">
          ${pupil.photo ? `<img src="${pupil.photo}" style="width:60px;height:60px;border-radius:50%;object-fit:cover;border:3px solid var(--blue);">` : `<div style="width:60px;height:60px;border-radius:50%;background:var(--blue);color:#fff;display:grid;place-items:center;font-size:24px;font-weight:700;">${(pupil.first||'?').charAt(0)}</div>`}
          <div>
            <h2 style="font-size:18px;font-weight:800;color:var(--text);">${pupil.first} ${pupil.last}</h2>
            <p style="font-size:13px;color:var(--text-muted);">Class: <strong>${pupil.cls}</strong> &nbsp;|&nbsp; Academic Year: <strong>${s.session||'—'}</strong></p>
          </div>
        </div>
        ${feeRec ? `
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px;">
            <div style="background:var(--blue-light);border-radius:10px;padding:14px;text-align:center;">
              <div style="font-size:20px;font-weight:800;color:var(--blue);">GH₵${(feeRec.due||0).toFixed(2)}</div>
              <div style="font-size:12px;color:var(--text-muted);">Total Fee Due</div>
            </div>
            <div style="background:var(--green-light);border-radius:10px;padding:14px;text-align:center;">
              <div style="font-size:20px;font-weight:800;color:var(--green);">GH₵${(feeRec.paid||0).toFixed(2)}</div>
              <div style="font-size:12px;color:var(--text-muted);">Amount Paid</div>
            </div>
            <div style="background:var(--red-light);border-radius:10px;padding:14px;text-align:center;">
              <div style="font-size:20px;font-weight:800;color:var(--red);">GH₵${((feeRec.due||0)-(feeRec.paid||0)).toFixed(2)}</div>
              <div style="font-size:12px;color:var(--text-muted);">Outstanding Balance</div>
            </div>
          </div>
          <div style="padding:10px 14px;background:var(--bg);border-radius:8px;font-size:13px;">
            <strong>Term:</strong> ${feeRec.term||s.term||'—'} &nbsp;|&nbsp;
            <strong>Status:</strong> <span style="font-weight:700;color:${feeRec.status==='Paid'?'var(--green)':feeRec.status==='Partial'?'var(--yellow)':'var(--red)'};">${feeRec.status||'Unpaid'}</span>
          </div>
          <button class="btn-ghost" style="margin-top:12px;" onclick="printPortalFeeReceipt()"><i class="fas fa-print"></i> Print Fee Statement</button>`
        : `<div style="text-align:center;padding:30px;color:var(--text-muted);"><i class="fas fa-receipt" style="font-size:32px;margin-bottom:10px;display:block;"></i>No fee record found for this term. Please contact the school office.</div>`}
      </div>
    </div>`;
}

function renderPortalResults() {
  const panel = document.getElementById('portalPanelResults');
  const pupil = _portalPupil();
  if (!panel) return;
  if (!pupil) { panel.innerHTML = `<div class="card"><p style="color:var(--text-muted);">No pupil linked to this account.</p></div>`; return; }
  const fullName = `${pupil.first} ${pupil.last}`;
  const reports  = (state.reports||[]).filter(r => r.studentName === fullName || r.studentId === pupil.id);
  if (!reports.length) { panel.innerHTML = `<div class="card"><div style="text-align:center;padding:30px;color:var(--text-muted);"><i class="fas fa-chart-bar" style="font-size:32px;display:block;margin-bottom:10px;"></i>No report cards available yet.</div></div>`; return; }
  panel.innerHTML = `<div style="display:grid;gap:16px;">` + reports.map(r => `
    <div class="card">
      <div class="card-head">
        <h2 class="card-title"><i class="fas fa-file-alt"></i> ${r.term||'—'} — ${r.year||'—'}</h2>
        <button class="btn-ghost" onclick="viewPortalReport(${r.id})" style="font-size:12px;"><i class="fas fa-eye"></i> View</button>
      </div>
      <p style="font-size:13px;color:var(--text-muted);">Class: <strong>${r.cls||pupil.cls}</strong> &nbsp;|&nbsp; Position: <strong>${r.position||'—'}</strong> / ${r.classSize||'—'}</p>
      ${r.subjects && r.subjects.length ? `
        <div style="margin-top:10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;">
          ${r.subjects.map(sub=>`
            <div style="background:var(--bg);border-radius:8px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;">
              <span style="font-size:12px;font-weight:600;">${sub.name}</span>
              <span style="font-size:14px;font-weight:800;color:${sub.total>=50?'var(--green)':'var(--red)'};">${sub.total||'—'}</span>
            </div>`).join('')}
        </div>` : ''}
    </div>`).join('') + `</div>`;
}

function renderPortalExams() {
  const panel = document.getElementById('portalPanelExams');
  const pupil = _portalPupil();
  if (!panel) return;
  const today = new Date().toISOString().split('T')[0];
  let exams = (state.exams||[]).filter(e => e.status!=='Cancelled' && (e.cls==='All Classes' || e.cls===pupil?.cls));
  exams = exams.sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  if (!exams.length) { panel.innerHTML = `<div class="card"><div style="text-align:center;padding:30px;color:var(--text-muted);"><i class="fas fa-calendar-alt" style="font-size:32px;display:block;margin-bottom:10px;"></i>No upcoming exams at this time.</div></div>`; return; }
  panel.innerHTML = `<div class="card"><div class="card-head"><h2 class="card-title"><i class="fas fa-calendar-alt"></i> Exam Schedule${pupil?` — ${pupil.cls}`:''}</h2></div>
    <div class="table-wrap"><table class="data-table">
      <thead><tr><th>Date</th><th>Exam</th><th>Type</th><th>Subject</th><th>Time</th><th>Venue</th></tr></thead>
      <tbody>${exams.map(e=>`<tr style="${e.date>=today?'':'opacity:.6'}">
        <td><strong>${e.date?new Date(e.date+'T00:00').toLocaleDateString('en-GH',{weekday:'short',day:'numeric',month:'short',year:'numeric'}):'—'}</strong></td>
        <td>${e.title}</td>
        <td><span style="background:var(--blue-light);color:var(--blue);padding:2px 8px;border-radius:20px;font-size:11px;">${e.type}</span></td>
        <td>${e.subject||'All'}</td>
        <td>${e.time||'—'}${e.duration?` (${e.duration} mins)`:''}</td>
        <td>${e.venue||'—'}</td>
      </tr>`).join('')}</tbody>
    </table></div></div>`;
}

function renderPortalGallery() {
  const panel = document.getElementById('portalPanelGallery');
  if (!panel) return;
  const albums = state.albums||[];
  if (!albums.length) { panel.innerHTML = `<div class="card"><div style="text-align:center;padding:30px;color:var(--text-muted);"><i class="fas fa-images" style="font-size:32px;display:block;margin-bottom:10px;"></i>No gallery albums yet.</div></div>`; return; }
  panel.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;">` +
    albums.map(a => `<div class="card" style="padding:16px;cursor:default;">
      <div style="font-size:32px;text-align:center;margin-bottom:8px;">${a.emoji||'🖼️'}</div>
      <h3 style="font-size:14px;font-weight:700;text-align:center;">${a.name}</h3>
      <p style="font-size:12px;color:var(--text-muted);text-align:center;">${(a.photos||[]).length} photo${(a.photos||[]).length!==1?'s':''}</p>
      ${a.photos&&a.photos.length ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:8px;">
        ${a.photos.slice(0,4).map(p=>`<img src="${p.src}" style="width:100%;height:60px;object-fit:cover;border-radius:6px;" onclick="this.requestFullscreen?this.requestFullscreen():null">`).join('')}
      </div>` : ''}
    </div>`).join('') + `</div>`;
}

function renderPortalResources() {
  const panel = document.getElementById('portalPanelResources');
  if (!panel) return;
  const pupil = _portalPupil();
  // Students can see All Classes resources and resources for their specific class
  let res = (state.resources||[]).filter(r => r.cls==='All Classes' || !pupil || r.cls===pupil.cls);
  if (!res.length) { panel.innerHTML = `<div class="card"><div style="text-align:center;padding:30px;color:var(--text-muted);"><i class="fas fa-book-open" style="font-size:32px;display:block;margin-bottom:10px;"></i>No resources available yet.</div></div>`; return; }
  const typeIcon = {'Exam Paper':'fas fa-scroll','Textbook':'fas fa-book','Workbook':'fas fa-book-open','Past Question':'fas fa-file-alt','Notes':'fas fa-sticky-note','Other':'fas fa-shapes'};
  panel.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;">` +
    res.map(r => `<div class="card" style="padding:14px;">
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px;">
        <div style="width:38px;height:38px;border-radius:8px;background:var(--blue-light);color:var(--blue);display:grid;place-items:center;font-size:16px;flex-shrink:0;">
          <i class="${typeIcon[r.type]||'fas fa-file'}"></i>
        </div>
        <div><div style="font-weight:700;font-size:13px;">${r.title}</div><div style="font-size:11px;color:var(--text-muted);">${r.type}</div></div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);">${r.subject?`<strong>${r.subject}</strong> · `:''} ${r.cls} ${r.term?'· '+r.term:''}</div>
      ${r.author?`<div style="font-size:11px;color:var(--text-light);margin-top:4px;">${r.author}</div>`:''}
    </div>`).join('') + `</div>`;
}

function renderPortalNotices() {
  const panel = document.getElementById('portalPanelNotices');
  if (!panel) return;
  const pupil = _portalPupil();
  // Show announcements relevant to this pupil
  let notices = (state.announcements||[]).filter(a => {
    if (a.audience==='Staff') return false;
    if (a.audience==='Class' && pupil && a.cls!==pupil.cls) return false;
    return true;
  }).slice().reverse();
  if (!notices.length) { panel.innerHTML = `<div class="card"><div style="text-align:center;padding:30px;color:var(--text-muted);"><i class="fas fa-bullhorn" style="font-size:32px;display:block;margin-bottom:10px;"></i>No announcements at this time.</div></div>`; return; }
  const prioIcon = {Urgent:'🚨',Important:'⚠️',Normal:'📢'};
  const prioBg   = {Urgent:'#fee2e2',Important:'#fef3c7',Normal:'var(--bg)'};
  panel.innerHTML = `<div style="display:flex;flex-direction:column;gap:12px;">` +
    notices.map(a => `<div class="card ann-card" style="background:${prioBg[a.priority]||'var(--bg)'};">
      <div style="font-size:14px;font-weight:700;margin-bottom:6px;">${prioIcon[a.priority]||'📢'} ${a.title}</div>
      <p style="font-size:13px;color:var(--text-muted);">${a.message}</p>
      <div style="font-size:11px;color:var(--text-light);margin-top:8px;"><i class="fas fa-clock"></i> ${a.postedAt?new Date(a.postedAt).toLocaleString('en-GH'):'—'}</div>
    </div>`).join('') + `</div>`;
}

function printPortalFeeReceipt() {
  const pupil = _portalPupil(); if (!pupil) return;
  const feeRec = state.fees.find(f=>f.studentId===pupil.id||f.student===`${pupil.first} ${pupil.last}`);
  if (!feeRec) return;
  const s = state.settings;
  const win = window.open('','_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Fee Statement</title>
<style>body{font-family:'Segoe UI',Arial,sans-serif;padding:30px;max-width:500px;margin:auto;color:#222;}
.header{text-align:center;border-bottom:2px solid #1a6fd4;padding-bottom:14px;margin-bottom:20px;}
.school{font-size:18px;font-weight:800;color:#1a6fd4;} .row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:13px;}
.label{color:#666;} .value{font-weight:700;} .total{background:#e8f0fb;padding:12px;border-radius:8px;display:flex;justify-content:space-between;margin-top:10px;}
</style></head><body>
<div class="header"><div class="school">${s.schoolName}</div><div style="font-size:12px;color:#666;">${s.address||''}</div><div style="font-weight:700;font-size:14px;margin-top:6px;">FEE STATEMENT</div></div>
<div class="row"><span class="label">Pupil Name</span><span class="value">${pupil.first} ${pupil.last}</span></div>
<div class="row"><span class="label">Class</span><span class="value">${pupil.cls}</span></div>
<div class="row"><span class="label">Term</span><span class="value">${feeRec.term||s.term||'—'}</span></div>
<div class="row"><span class="label">Academic Year</span><span class="value">${s.session||'—'}</span></div>
<div class="row"><span class="label">Total Fee Due</span><span class="value">GH₵${(feeRec.due||0).toFixed(2)}</span></div>
<div class="row"><span class="label">Amount Paid</span><span class="value" style="color:#16a34a;">GH₵${(feeRec.paid||0).toFixed(2)}</span></div>
<div class="total"><span style="font-weight:700;color:#1a6fd4;">Outstanding Balance</span><span style="font-size:18px;font-weight:800;color:${((feeRec.due||0)-(feeRec.paid||0))<=0?'#16a34a':'#dc2626'};">GH₵${((feeRec.due||0)-(feeRec.paid||0)).toFixed(2)}</span></div>
<p style="text-align:center;font-size:11px;color:#999;margin-top:20px;">Printed ${new Date().toLocaleString('en-GH')} — EduManage Pro</p>
<script>window.onload=function(){window.print();}<\/script>
</body></html>`); win.document.close();
}

document.addEventListener('DOMContentLoaded', () => {
  // Migrate any legacy single-school data first
  migrateLegacyData();

  // Init all UI modules (they render when school data loads after login)
  initLogin();
  initNav();
  initSidebar();
  initDate();
  initReportGenerator();
  initStudents();
  initStudentPhotoUpload();
  initReportSection();
  initFees();
  initGallery();
  initWeekly();
  initAttendance();
  initPromotion();
  initSMS();
  initIDCards();
  initAdmissions();
  initTeachers();
  initClasses();
  initResources();
  initExams();
  initTransfers();
  initCommunication();
  initExpenditure();
  initSettings();
  initLogo();
  initBackup();
  initGlobalSearch();
  initPageLeaveProtection();
  initTheme();

  // Start at the school selector (no auto-login)
  showSchoolSelector();

  // Logout btn always visible in sidebar
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.style.display = 'inline-flex';
});
