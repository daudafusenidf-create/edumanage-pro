/* ════════════════════════════════════════
   EduManage Pro — GES Edition
   Full Application Logic
   Firebase Realtime DB + localStorage fallback
════════════════════════════════════════ */

// ════════════════════════════════════════
// MULTI-SCHOOL DATABASE ARCHITECTURE
// Primary:  Firebase Realtime Database (multi-device sync)
// Fallback: localStorage (offline / no internet)
// ════════════════════════════════════════

const REGISTRY_KEY = 'edumanage_schools_registry';
let _currentSchoolKey = null;
let _fbListener = null;       // active Firebase onValue listener
let _fbSyncPaused = false;    // pause incoming sync while we are saving
let _isOnline = navigator.onLine;

window.addEventListener('online',  () => { _isOnline = true;  showSyncStatus('online');  });
window.addEventListener('offline', () => { _isOnline = false; showSyncStatus('offline'); });

function showSyncStatus(status) {
  const el = document.getElementById('syncStatusBadge');
  if (!el) return;
  if (status === 'online') {
    el.innerHTML = '<i class="fas fa-wifi"></i> Live Sync';
    el.style.background = 'var(--green)'; el.style.color = '#fff';
  } else if (status === 'offline') {
    el.innerHTML = '<i class="fas fa-wifi-slash"></i> Offline';
    el.style.background = 'var(--red)'; el.style.color = '#fff';
  } else if (status === 'syncing') {
    el.innerHTML = '<i class="fas fa-sync fa-spin"></i> Syncing…';
    el.style.background = 'var(--yellow)'; el.style.color = '#fff';
  }
}

// ── REGISTRY: stored BOTH in Firebase & localStorage ──
function getRegistry() {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch(e) { return []; }
}

function saveRegistry(schools) {
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(schools));
  // Mirror registry to Firebase so other devices can see all schools
  if (window._fbReady) {
    window._fb.set('registry', schools).catch(e => console.warn('[FB] registry save failed:', e));
  }
}

async function loadRegistryFromFirebase() {
  if (!window._fbReady) return;
  try {
    const snap = await window._fb.get('registry');
    if (snap.exists()) {
      const fbReg = snap.val();
      // Merge: firebase is source of truth, but keep local-only entries too
      const localReg = getRegistry();
      const merged = [...fbReg];
      localReg.forEach(ls => {
        if (!merged.find(fb => fb.id === ls.id)) merged.push(ls);
      });
      localStorage.setItem(REGISTRY_KEY, JSON.stringify(merged));
      return merged;
    }
  } catch(e) { console.warn('[FB] registry load failed:', e); }
  return getRegistry();
}

function getSchoolKey(schoolId) {
  return `edumanage_school_${schoolId}`;
}

// Firebase path for a school: schools/<schoolId>/data
function fbSchoolPath(schoolId) {
  return 'schools/' + schoolId + '/data';
}

// ── SAVE: Firebase PRIMARY + localStorage FALLBACK ──
function _buildSavePayload(stripPhotos = false) {
  const albums = stripPhotos
    ? state.albums.map(a=>({...a, photos:(a.photos||[]).map(p=>({name:p.name,src:p.src&&p.src.length>500000?'[photo-omitted]':p.src}))}))
    : state.albums; // Firebase gets full photos
  return {
    students:             state.students,
    fees:                 state.fees,
    teachers:             state.teachers,
    classes:              state.classes,
    albums,
    reports:              state.reports,
    weeklyRecords:        state.weeklyRecords,
    attendance:           state.attendance,
    settings:             state.settings,
    schoolLogo:           state.schoolLogo,
    driveClientId:        state.driveClientId,
    backupHistory:        state.backupHistory,
    users:                state.users,
    admissions:           state.admissions,
    nextAdmissionId:      state.nextAdmissionId,
    nextStudentId:        state.nextStudentId,
    nextFeeId:            state.nextFeeId,
    nextTeacherId:        state.nextTeacherId,
    nextClassId:          state.nextClassId,
    nextAlbumId:          state.nextAlbumId,
    nextWeeklyId:         state.nextWeeklyId,
    nextAttendanceId:     state.nextAttendanceId,
    nextUserId:           state.nextUserId,
    expenditures:         state.expenditures,
    nextExpenditureId:    state.nextExpenditureId,
    resources:            state.resources,
    nextResourceId:       state.nextResourceId,
    exams:                state.exams,
    nextExamId:           state.nextExamId,
    transfers:            state.transfers,
    nextTransferId:       state.nextTransferId,
    announcements:        state.announcements,
    nextAnnouncementId:   state.nextAnnouncementId,
    parentNotifications:  state.parentNotifications,
    nextPNId:             state.nextPNId,
    appTheme:             state.appTheme,
    sidebarStyle:         state.sidebarStyle,
    fontSize:             state.fontSize,
    savedAt:              Date.now(),
  };
}

// Save to Firebase (primary) AND localStorage (fallback/offline cache)
function saveToDB() {
  if (!_currentSchoolKey) return;
  try {
    const dataForLocal  = _buildSavePayload(true);   // strip large photos for localStorage
    const dataForCloud  = _buildSavePayload(false);  // full photos for Firebase
    const jsonStr       = JSON.stringify(dataForLocal);

    // Always save to localStorage for offline access
    localStorage.setItem(_currentSchoolKey, jsonStr);

    // Keep registry name in sync
    const reg   = getRegistry();
    const entry = reg.find(s => s.key === _currentSchoolKey);
    if (entry) { entry.name = state.settings.schoolName; saveRegistry(reg); }

    // Save to Firebase if online
    if (window._fbReady && _isOnline) {
      const schoolId = _currentSchoolKey.replace('edumanage_school_', '');
      showSyncStatus('syncing');
      _fbSyncPaused = true;
      window._fb.set(fbSchoolPath(schoolId), dataForCloud)
        .then(() => {
          showSyncStatus('online');
          setTimeout(() => { _fbSyncPaused = false; }, 1500);
        })
        .catch(e => {
          console.warn('[FB] save failed, data kept locally:', e);
          showSyncStatus('offline');
          _fbSyncPaused = false;
        });
    }
  } catch(e) { console.warn('Save failed:', e); }
}

// Apply a data snapshot object into state (shared by load & realtime listener)
function _applyDataToState(data) {
  if (!data) return false;
  if (data.students)            state.students            = data.students;
  if (data.fees)                state.fees                = data.fees;
  if (data.teachers)            state.teachers            = data.teachers;
  if (data.classes)             state.classes             = data.classes;
  if (data.albums)              state.albums              = data.albums;
  if (data.reports)             state.reports             = data.reports;
  if (data.weeklyRecords)       state.weeklyRecords       = data.weeklyRecords;
  if (data.attendance)          state.attendance          = data.attendance;
  if (data.settings)            Object.assign(state.settings, data.settings);
  if (data.schoolLogo)          state.schoolLogo          = data.schoolLogo;
  if (data.driveClientId)       state.driveClientId       = data.driveClientId;
  if (data.backupHistory)       state.backupHistory       = data.backupHistory;
  if (data.users)               state.users               = data.users;
  if (data.expenditures)        state.expenditures        = data.expenditures;
  if (data.resources)           state.resources           = data.resources;
  if (data.nextResourceId)      state.nextResourceId      = data.nextResourceId;
  if (data.exams)               state.exams               = data.exams;
  if (data.nextExamId)          state.nextExamId          = data.nextExamId;
  if (data.transfers)           state.transfers           = data.transfers;
  if (data.nextTransferId)      state.nextTransferId      = data.nextTransferId;
  if (data.announcements)       state.announcements       = data.announcements;
  if (data.nextAnnouncementId)  state.nextAnnouncementId  = data.nextAnnouncementId;
  if (data.parentNotifications) state.parentNotifications = data.parentNotifications;
  if (data.nextPNId)            state.nextPNId            = data.nextPNId;
  if (data.appTheme)            state.appTheme            = data.appTheme;
  if (data.sidebarStyle)        state.sidebarStyle        = data.sidebarStyle;
  if (data.fontSize)            state.fontSize            = data.fontSize;
  if (data.admissions)          state.admissions          = data.admissions;
  if (data.nextAdmissionId)     state.nextAdmissionId     = data.nextAdmissionId;
  if (data.nextStudentId)       state.nextStudentId       = data.nextStudentId;
  if (data.nextFeeId)           state.nextFeeId           = data.nextFeeId;
  if (data.nextTeacherId)       state.nextTeacherId       = data.nextTeacherId;
  if (data.nextClassId)         state.nextClassId         = data.nextClassId;
  if (data.nextAlbumId)         state.nextAlbumId         = data.nextAlbumId;
  if (data.nextWeeklyId)        state.nextWeeklyId        = data.nextWeeklyId;
  if (data.nextAttendanceId)    state.nextAttendanceId    = data.nextAttendanceId;
  if (data.nextUserId)          state.nextUserId          = data.nextUserId;
  if (data.nextExpenditureId)   state.nextExpenditureId   = data.nextExpenditureId;
  return true;
}

// Load from localStorage immediately (fast, offline-capable)
function loadSchoolData(schoolKey) {
  try {
    const raw = localStorage.getItem(schoolKey);
    if (!raw) return false;
    return _applyDataToState(JSON.parse(raw));
  } catch(e) { console.warn('Load failed:', e); return false; }
}

// Load from Firebase (async, most up-to-date)
async function loadSchoolDataFromFirebase(schoolId) {
  if (!window._fbReady || !_isOnline) return false;
  try {
    showSyncStatus('syncing');
    const snap = await window._fb.get(fbSchoolPath(schoolId));
    if (snap.exists()) {
      const data = snap.val();
      _applyDataToState(data);
      // Also cache locally so offline works
      localStorage.setItem(getSchoolKey(schoolId), JSON.stringify(data));
      showSyncStatus('online');
      console.log('[FB] Loaded latest data from Firebase ✅');
      return true;
    }
  } catch(e) {
    console.warn('[FB] Firebase load failed, using local cache:', e);
    showSyncStatus('offline');
  }
  return false;
}

// Start real-time listener — updates all open devices when any device saves
function startRealtimeSync(schoolId) {
  stopRealtimeSync(); // clear any previous listener
  if (!window._fbReady) return;
  const path = fbSchoolPath(schoolId);
  const dbRef = window._fb.ref(path);
  _fbListener = { ref: dbRef, path };
  window._fb.onValue(dbRef, (snap) => {
    if (!snap.exists()) return;
    if (_fbSyncPaused) return; // this device just saved, ignore echo
    if (!state.currentUser) return; // not logged in
    const data = snap.val();
    // Only apply if the incoming data is newer than our last save
    const localJson = localStorage.getItem(getSchoolKey(schoolId));
    const localSavedAt = localJson ? (JSON.parse(localJson).savedAt || 0) : 0;
    if ((data.savedAt || 0) <= localSavedAt) return;
    console.log('[FB] 🔄 Remote update received — refreshing UI');
    _applyDataToState(data);
    localStorage.setItem(getSchoolKey(schoolId), JSON.stringify(data));
    refreshAllViews();
    showToast('🔄 Data updated from another device');
    showSyncStatus('online');
  }, (err) => {
    console.warn('[FB] Listener error:', err);
    showSyncStatus('offline');
  });
}

function stopRealtimeSync() {
  if (_fbListener) {
    window._fb.off(_fbListener.ref);
    _fbListener = null;
  }
}

// Re-render all visible views after a remote sync
function refreshAllViews() {
  try {
    renderStudents(); renderFees(); renderTeachers(); renderClasses();
    renderGallery(); renderSavedReports(); renderWeekly();
    renderAttendance(); renderUsers(); updateDashStats(); updateFeeStats();
    if (typeof renderResources === 'function') renderResources();
    if (typeof renderExams === 'function') renderExams();
    if (typeof renderTransfers === 'function') renderTransfers();
    if (typeof renderAnnouncements === 'function') renderAnnouncements();
    if (typeof renderParentNotifications === 'function') renderParentNotifications();
    if (typeof initTheme === 'function') initTheme();
    if (state.schoolLogo) applyLogo(state.schoolLogo);
    const s = state.settings;
    const sv = (id, val) => { const el=document.getElementById(id); if(el&&val!==undefined) el.value=val; };
    sv('schoolName',s.schoolName); sv('sessionYear',s.session);
    sv('schoolAddress',s.address); sv('principalName',s.principal);
    sv('gesDistrict',s.district); sv('schoolMotto',s.motto);
    if (document.getElementById('currentTerm')) document.getElementById('currentTerm').value = s.term||'';
    document.querySelector('.user-name') && (document.querySelector('.user-name').textContent = state.currentUser?.name || '');
    document.getElementById('sidebarSchoolName') && (document.getElementById('sidebarSchoolName').textContent = s.schoolName);
  } catch(e) { console.warn('[refreshAllViews]', e); }
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
      if (typeof _paintSidebar === 'function') _paintSidebar();
      closeSidebar();
    });
  });
}

function switchSection(name) {
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
function updateAttClassSize() {
  const cls = document.getElementById('attClassSelect')?.value || '';
  const bar = document.getElementById('attClassSizeBar');
  const lbl = document.getElementById('attClassSizeLabel');
  if (!cls || !bar || !lbl) return;
  const count = state.students.filter(s => s.cls === cls).length;
  bar.style.display = count ? '' : 'none';
  lbl.textContent = count + ' pupil' + (count !== 1 ? 's' : '') + ' enrolled in ' + cls;
}

function renderAttendance(cls, week, day) {
  cls = cls || ''; week = week || ''; day = day || '';
  const tbody = document.getElementById('attendanceTbody');
  if (!tbody) return;
  let data = state.attendance || [];
  if (cls)  data = data.filter(a => a.cls  === cls);
  if (week) data = data.filter(a => a.week === week);
  if (day)  data = data.filter(a => (a.day||'')  === day);

  if (!data.length) {
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--text-light);padding:28px;"><i class="fas fa-clipboard-check" style="font-size:28px;display:block;margin-bottom:10px;"></i>No attendance records yet.</td></tr>';
    return;
  }
  const grouped = {};
  data.forEach(a => {
    const key = a.cls + '|' + a.week + '|' + (a.day||'');
    if (!grouped[key]) grouped[key] = { cls:a.cls, week:a.week, day:a.day||'', records:[] };
    grouped[key].records.push(a);
  });
  const DAY_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
  const weekNum = w => parseInt((w||'').replace(/\D/g,'')) || 99;
  const sortedGroups = Object.values(grouped).sort((a,b) => {
    const wDiff = weekNum(a.week) - weekNum(b.week);
    if (wDiff !== 0) return wDiff;
    return DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day);
  });
  tbody.innerHTML = sortedGroups.map((g, i) => {
    const classPupils    = state.students.filter(s => s.cls === g.cls);
    const totalEnrolled  = classPupils.length;
    const maleEnrolled   = classPupils.filter(s => s.gender === 'Male').length;
    const femaleEnrolled = classPupils.filter(s => s.gender === 'Female').length;
    const present    = g.records.filter(r => r.status === 'Present').length;
    const absent     = g.records.filter(r => r.status === 'Absent').length;
    const late       = g.records.filter(r => r.status === 'Late').length;
    const presentIds = g.records.filter(r => r.status === 'Present').map(r => r.studentId);
    const malesP     = classPupils.filter(s => presentIds.includes(s.id) && s.gender === 'Male').length;
    const femalesP   = classPupils.filter(s => presentIds.includes(s.id) && s.gender === 'Female').length;
    const marked     = g.records.length;
    const rate       = marked ? Math.round((present / marked) * 100) : 0;
    const rateColor  = rate >= 80 ? 'var(--green)' : rate >= 60 ? 'var(--yellow)' : 'var(--red)';
    const clsEnc  = encodeURIComponent(g.cls);
    const weekEnc = encodeURIComponent(g.week);
    const dayEnc  = encodeURIComponent(g.day);
    return '<tr>' +
      '<td>' + (i+1) + '</td>' +
      '<td><strong>' + g.cls + '</strong><br><small style="color:var(--text-muted);font-size:11px;">' + totalEnrolled + ' enrolled</small></td>' +
      '<td>' + g.week + '</td>' +
      '<td style="font-weight:600;">' + (g.day||'—') + '</td>' +
      '<td style="font-weight:700;">' + totalEnrolled + '</td>' +
      '<td style="color:#3b82f6;font-weight:600;">' + maleEnrolled + '<br><small>' + malesP + '\u2705</small></td>' +
      '<td style="color:#ec4899;font-weight:600;">' + femaleEnrolled + '<br><small>' + femalesP + '\u2705</small></td>' +
      '<td style="color:var(--green);font-weight:700;">' + present + '</td>' +
      '<td style="color:var(--red);font-weight:700;">' + absent + '</td>' +
      '<td style="color:var(--yellow);font-weight:700;">' + late + '</td>' +
      '<td><div style="display:flex;align-items:center;gap:6px;">' +
        '<div style="flex:1;background:var(--border);border-radius:20px;height:6px;min-width:50px;">' +
          '<div style="width:' + rate + '%;background:' + rateColor + ';height:6px;border-radius:20px;"></div></div>' +
        '<span style="font-weight:700;color:' + rateColor + ';font-size:12px;">' + rate + '%</span></div></td>' +
      '<td>' +
        '<button class="tbl-btn" onclick="editAttendanceSheet(\'' + clsEnc + '\',\'' + weekEnc + '\',\'' + dayEnc + '\')" title="Edit"><i class="fas fa-edit"></i></button>' +
        '<button class="tbl-btn" onclick="printAttendanceSummary(\'' + clsEnc + '\',\'' + weekEnc + '\',\'' + dayEnc + '\')" title="Print"><i class="fas fa-print"></i></button>' +
        '<button class="tbl-btn danger" onclick="deleteAttendanceRecord(\'' + clsEnc + '\',\'' + weekEnc + '\',\'' + dayEnc + '\')" title="Delete"><i class="fas fa-trash"></i></button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

function editAttendanceSheet(clsEnc, weekEnc, dayEnc) {
  const cls  = decodeURIComponent(clsEnc);
  const week = decodeURIComponent(weekEnc);
  const day  = decodeURIComponent(dayEnc);
  const attCls  = document.getElementById('attClassSelect');
  const attWeek = document.getElementById('attWeek');
  const attDay  = document.getElementById('attDay');
  if (attCls)  attCls.value  = cls;
  if (attWeek) attWeek.value = week;
  if (attDay)  attDay.value  = day;
  updateAttClassSize();
  document.getElementById('sec-attendance').scrollIntoView({ behavior:'smooth' });
  renderAttendanceSheet();
}

function deleteAttendanceRecord(clsEnc, weekEnc, dayEnc) {
  const cls  = decodeURIComponent(clsEnc);
  const week = decodeURIComponent(weekEnc);
  const day  = decodeURIComponent(dayEnc);
  if (!confirm('Delete attendance for ' + cls + ' \u2014 ' + week + ' ' + day + '?')) return;
  state.attendance = state.attendance.filter(a => !(a.cls===cls && a.week===week && (a.day||'')===(day||'')));
  renderAttendance(); autosave(); showToast('\uD83D\uDDD1\uFE0F Attendance record deleted.');
}

function downloadAttendanceCSV() {
  let csv = 'Class,Week,Day,Pupil,Gender,Status\n';
  (state.attendance||[]).forEach(a => {
    const p = state.students.find(s => s.id === a.studentId);
    const name = p ? p.first + ' ' + p.last : 'Pupil#' + a.studentId;
    const gender = p ? p.gender : '—';
    csv += '"' + a.cls + '","' + a.week + '","' + (a.day||'') + '","' + name + '","' + gender + '","' + a.status + '"\n';
  });
  const url = URL.createObjectURL(new Blob([csv], { type:'text/csv' }));
  const el = Object.assign(document.createElement('a'), { href:url, download:'attendance.csv' });
  document.body.appendChild(el); el.click(); document.body.removeChild(el);
  showToast('\uD83D\uDCE5 Attendance exported!');
}

function printAttendanceSummary(clsEnc, weekEnc, dayEnc) {
  const cls  = decodeURIComponent(clsEnc);
  const week = decodeURIComponent(weekEnc);
  const day  = decodeURIComponent(dayEnc);
  const records = state.attendance.filter(a => a.cls===cls && a.week===week && (a.day||'')===(day||''));
  if (!records.length) { showToast('No records for this entry.'); return; }
  const classPupils    = state.students.filter(s => s.cls === cls);
  const totalEnrolled  = classPupils.length;
  const school         = state.settings;
  const present        = records.filter(r => r.status==='Present').length;
  const absent         = records.filter(r => r.status==='Absent').length;
  const late           = records.filter(r => r.status==='Late').length;
  const total          = records.length;
  const rate           = total ? Math.round(present/total*100) : 0;
  const maleEnrolled   = classPupils.filter(s => s.gender==='Male').length;
  const femaleEnrolled = classPupils.filter(s => s.gender==='Female').length;
  const presentIds     = records.filter(r => r.status==='Present').map(r => r.studentId);
  const malesP         = classPupils.filter(s => presentIds.includes(s.id) && s.gender==='Male').length;
  const femalesP       = classPupils.filter(s => presentIds.includes(s.id) && s.gender==='Female').length;
  const logoHtml       = state.schoolLogo ? '<img src="' + state.schoolLogo + '" style="height:65px;object-fit:contain;"/>' : '\uD83C\uDFEB';
  const rateCol        = rate>=80 ? '#16a34a' : rate>=60 ? '#d97706' : '#dc2626';
  const allRows = classPupils.map((p,i) => {
    const rec = records.find(r => r.studentId === p.id);
    const status = rec ? rec.status : '\u2014';
    const sc = status==='Present' ? 'color:#16a34a;font-weight:700;' : status==='Absent' ? 'color:#dc2626;font-weight:700;' : status==='Late' ? 'color:#d97706;font-weight:700;' : '';
    return '<tr><td>' + (i+1) + '</td><td>' + p.first + ' ' + p.last + '</td><td>' + (p.gender||'—') + '</td><td style="' + sc + '">' + status + '</td><td></td></tr>';
  }).join('');
  const win = window.open('','_blank');
  win.document.write('<!DOCTYPE html><html><head><title>Attendance</title><style>' +
    'body{font-family:"Segoe UI",Arial,sans-serif;padding:28px;max-width:720px;margin:auto;color:#1a2133;}' +
    '.header{display:flex;align-items:center;gap:16px;border-bottom:3px solid #1a6fd4;padding-bottom:16px;margin-bottom:20px;}' +
    '.school-name{font-size:20px;font-weight:800;color:#1a6fd4;}.sub{font-size:12px;color:#64748b;}' +
    '.title{font-size:15px;font-weight:700;margin-bottom:16px;background:#e8f0fe;padding:10px 16px;border-radius:8px;color:#1a6fd4;}' +
    '.stat-row{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:18px;}' +
    '.stat{background:#f8fafc;border-radius:8px;padding:10px;text-align:center;border:1px solid #e2e8f0;}' +
    '.stat-val{font-size:20px;font-weight:800;}.stat-lbl{font-size:10px;color:#64748b;margin-top:2px;}' +
    'table{width:100%;border-collapse:collapse;}th{background:#1a6fd4;color:#fff;padding:8px 10px;font-size:12px;text-align:left;}' +
    'td{padding:7px 10px;border-bottom:1px solid #eee;font-size:12px;}' +
    '.sig{display:flex;justify-content:space-between;margin-top:40px;}' +
    '.sig-box{text-align:center;width:180px;}.sig-line{border-top:1px solid #333;padding-top:5px;font-size:11px;color:#555;}' +
    '.footer{margin-top:20px;padding-top:12px;border-top:1px solid #eee;font-size:11px;color:#94a3b8;text-align:center;}' +
    '</style></head><body>' +
    '<div class="header">' + logoHtml + '<div>' +
      '<div class="school-name">' + (school.schoolName||'School') + '</div>' +
      '<div class="sub">' + (school.address||'') + ' | ' + (school.district||'') + '</div>' +
      '<div class="sub">Headmaster: ' + (school.principal||'') + ' | ' + (school.session||'') + '</div>' +
    '</div></div>' +
    '<div class="title">\uD83D\uDCCB Attendance Register \u2014 <strong>' + cls + '</strong> | <strong>' + week + '</strong> | <strong>' + day + '</strong></div>' +
    '<div class="stat-row">' +
      '<div class="stat"><div class="stat-val">' + totalEnrolled + '</div><div class="stat-lbl">Class Size</div></div>' +
      '<div class="stat"><div class="stat-val">' + total + '</div><div class="stat-lbl">Marked</div></div>' +
      '<div class="stat"><div class="stat-val" style="color:#16a34a;">' + present + '</div><div class="stat-lbl">Present</div></div>' +
      '<div class="stat"><div class="stat-val" style="color:#dc2626;">' + absent + '</div><div class="stat-lbl">Absent</div></div>' +
      '<div class="stat"><div class="stat-val" style="color:#d97706;">' + late + '</div><div class="stat-lbl">Late</div></div>' +
    '</div>' +
    '<div style="margin-bottom:10px;font-size:13px;">Rate: <strong>' + rate + '%</strong> &nbsp;|&nbsp; Males: ' + maleEnrolled + ' enrolled, ' + malesP + ' present &nbsp;|&nbsp; Females: ' + femaleEnrolled + ' enrolled, ' + femalesP + ' present</div>' +
    '<table><thead><tr><th>#</th><th>Pupil Name</th><th>Gender</th><th>Status</th><th>Remarks</th></tr></thead>' +
    '<tbody>' + allRows + '</tbody></table>' +
    '<div class="sig"><div class="sig-box"><div class="sig-line">Class Teacher</div></div><div class="sig-box"><div class="sig-line">Headmaster</div></div><div class="sig-box"><div class="sig-line">Date</div></div></div>' +
    '<div class="footer">EduManage Pro \u2014 ' + (school.schoolName||'School') + ' \u2014 Printed ' + new Date().toLocaleString('en-GH') + '</div>' +
    '<script>window.onload=function(){window.print();}<\/script></body></html>');
  win.document.close();
}

function renderAttendanceSheet() {
  const cls  = document.getElementById('attClassSelect').value;
  const week = document.getElementById('attWeek').value;
  const day  = document.getElementById('attDay').value;
  if (!cls)  { showToast('\u26A0\uFE0F Select a class.'); return; }
  if (!week) { showToast('\u26A0\uFE0F Select a week.'); return; }
  if (!day)  { showToast('\u26A0\uFE0F Select a day.'); return; }
  const pupils = state.students.filter(s => s.cls === cls);
  if (!pupils.length) { showToast('\u26A0\uFE0F No pupils enrolled in this class.'); return; }
  const sheet = document.getElementById('attendanceSheet');
  const totalEnrolled = pupils.length;
  const maleCount   = pupils.filter(p => p.gender==='Male').length;
  const femaleCount = pupils.filter(p => p.gender==='Female').length;
  const rowsHtml = pupils.map(p => {
    const existing = state.attendance.find(a => a.studentId===p.id && a.week===week && a.cls===cls && (a.day||'')===(day||''));
    const status   = existing ? existing.status : 'Present';
    return '<div class="att-row" id="att-row-' + p.id + '">' +
      '<span class="att-name">' + p.first + ' ' + p.last + ' <small style="color:var(--text-muted);font-size:10px;">' + (p.gender||'') + '</small></span>' +
      '<div class="att-btns">' +
        '<button class="att-btn ' + (status==='Present'?'att-present':'') + '" onclick="setAttendance(' + p.id + ',\'' + cls + '\',\'' + week + '\',\'' + day + '\',\'Present\',this)">P</button>' +
        '<button class="att-btn ' + (status==='Absent'?'att-absent':'') + '" onclick="setAttendance(' + p.id + ',\'' + cls + '\',\'' + week + '\',\'' + day + '\',\'Absent\',this)">A</button>' +
        '<button class="att-btn ' + (status==='Late'?'att-late':'') + '" onclick="setAttendance(' + p.id + ',\'' + cls + '\',\'' + week + '\',\'' + day + '\',\'Late\',this)">L</button>' +
      '</div>' +
    '</div>';
  }).join('');
  sheet.innerHTML =
    '<div style="background:var(--blue-light);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;">' +
      '<strong style="color:var(--blue);">' + cls + ' \u2014 ' + week + ' \u2014 ' + day + '</strong>' +
      '<span style="margin-left:12px;color:var(--text-muted);">' + totalEnrolled + ' pupils (' + maleCount + 'M / ' + femaleCount + 'F)</span>' +
    '</div>' +
    '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">' +
      '<button class="btn-ghost" style="font-size:12px;" onclick="markAllAttendance(\'' + cls + '\',\'' + week + '\',\'' + day + '\',\'Present\')"><i class="fas fa-check-circle" style="color:var(--green);"></i> Mark All Present</button>' +
      '<button class="btn-ghost" style="font-size:12px;" onclick="markAllAttendance(\'' + cls + '\',\'' + week + '\',\'' + day + '\',\'Absent\')"><i class="fas fa-times-circle" style="color:var(--red);"></i> Mark All Absent</button>' +
    '</div>' +
    '<div class="att-sheet-grid">' + rowsHtml + '</div>' +
    '<div style="display:flex;gap:10px;margin-top:14px;">' +
      '<button class="btn-primary" style="flex:1;justify-content:center;" onclick="saveAttendance(\'' + cls + '\',\'' + week + '\',\'' + day + '\')"><i class="fas fa-save"></i> Save Attendance</button>' +
      '<button class="btn-ghost" onclick="printAttendanceSummary(\'' + encodeURIComponent(cls) + '\',\'' + encodeURIComponent(week) + '\',\'' + encodeURIComponent(day) + '\')"><i class="fas fa-print"></i> Print</button>' +
    '</div>';
  sheet.style.display = 'block';
}

function markAllAttendance(cls, week, day, status) {
  const pupils = state.students.filter(s => s.cls === cls);
  pupils.forEach(p => {
    const existing = state.attendance.find(a => a.studentId===p.id && a.week===week && a.cls===cls && (a.day||'')===(day||''));
    if (existing) existing.status = status;
    else state.attendance.push({ id:state.nextAttendanceId++, studentId:p.id, cls, week, day, status });
    const row = document.getElementById('att-row-' + p.id);
    if (!row) return;
    row.querySelectorAll('.att-btn').forEach(b => b.classList.remove('att-present','att-absent','att-late'));
    const btns = row.querySelectorAll('.att-btn');
    const idx = status==='Present'?0:status==='Absent'?1:2;
    if (btns[idx]) btns[idx].classList.add(status==='Present'?'att-present':status==='Absent'?'att-absent':'att-late');
  });
  showToast('\u2705 All marked ' + status);
}

function setAttendance(studentId, cls, week, day, status, btn) {
  const existing = state.attendance.find(a => a.studentId===studentId && a.week===week && a.cls===cls && (a.day||'')===(day||''));
  if (existing) existing.status = status;
  else state.attendance.push({ id:state.nextAttendanceId++, studentId, cls, week, day, status });
  const row = btn.closest('.att-row');
  row.querySelectorAll('.att-btn').forEach(b => b.classList.remove('att-present','att-absent','att-late'));
  btn.classList.add(status==='Present'?'att-present':status==='Absent'?'att-absent':'att-late');
}

function saveAttendance(cls, week, day) {
  // Flush every pupil row's current button state into state.attendance
  const pupils = state.students.filter(s => s.cls === cls);
  pupils.forEach(p => {
    const row = document.getElementById('att-row-' + p.id);
    let status = 'Present'; // default
    if (row) {
      const btns = row.querySelectorAll('.att-btn');
      if (btns[1] && btns[1].classList.contains('att-absent')) status = 'Absent';
      else if (btns[2] && btns[2].classList.contains('att-late'))   status = 'Late';
      else if (btns[0] && btns[0].classList.contains('att-present')) status = 'Present';
    }
    const existing = state.attendance.find(a => a.studentId===p.id && a.week===week && a.cls===cls && (a.day||'')===(day||''));
    if (existing) existing.status = status;
    else state.attendance.push({ id: state.nextAttendanceId++, studentId: p.id, cls, week, day, status });
  });

  autosave();

  // Refresh the summary table with current filter values (or show all)
  const fc = document.getElementById('attFilterClass');
  const fw = document.getElementById('attFilterWeek');
  const fd = document.getElementById('attFilterDay');
  renderAttendance(fc?.value || '', fw?.value || '', fd?.value || '');
  updateDashStats();
  showToast('✅ Attendance saved — ' + cls + ' · ' + week + ' · ' + day + ' (' + pupils.length + ' pupils)');
}

function initAttendance() {
  renderAttendance();
  document.getElementById('attLoadBtn').addEventListener('click', renderAttendanceSheet);
  document.getElementById('attClassSelect').addEventListener('change', updateAttClassSize);
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
  // Load registry from Firebase first (gets schools registered on other devices)
  if (window._fbReady && _isOnline) {
    loadRegistryFromFirebase().then(() => renderSchoolList());
  } else {
    renderSchoolList();
  }
}

function showLoginScreen(schoolId, schoolName) {
  document.getElementById('schoolSelector').style.display = 'none';
  document.getElementById('loginScreen').style.display    = 'flex';
  document.getElementById('loginSchoolName').textContent  = schoolName;
  document.getElementById('loginScreen').dataset.schoolId = schoolId;
  document.getElementById('loginError').style.display     = 'none';
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
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
    container.innerHTML = `
      <div class="school-empty">
        <i class="fas fa-school" style="font-size:48px;color:var(--border);margin-bottom:12px;"></i>
        <p>No schools registered yet.</p>
        <p style="font-size:12px;color:var(--text-light);">Click <strong>Register New School</strong> below to get started.</p>
      </div>`;
    return;
  }
  container.innerHTML = reg.map(s => `
    <div class="school-card" onclick="selectSchool('${s.id}','${escHtml(s.name)}')">
      <div class="school-card-icon"><i class="fas fa-graduation-cap"></i></div>
      <div class="school-card-info">
        <strong>${escHtml(s.name)}</strong>
        <span>Created ${new Date(s.createdAt).toLocaleDateString('en-GH')}</span>
      </div>
      <button class="school-card-delete" title="Remove school" onclick="event.stopPropagation();deleteSchool('${s.id}')">
        <i class="fas fa-trash"></i>
      </button>
    </div>`).join('');
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function selectSchool(schoolId, schoolName) {
  showLoginScreen(schoolId, schoolName);
}

function deleteSchool(schoolId) {
  const reg = getRegistry();
  const school = reg.find(s => s.id === schoolId);
  if (!school) return;
  if (!confirm(`Permanently delete "${school.name}" and all its data? This cannot be undone.`)) return;
  localStorage.removeItem(getSchoolKey(schoolId));
  saveRegistry(reg.filter(s => s.id !== schoolId));
  // Also delete from Firebase
  if (window._fbReady && _isOnline) {
    window._fb.set(fbSchoolPath(schoolId), null).catch(e => console.warn('[FB] delete failed:', e));
  }
  renderSchoolList();
  showToast('🗑️ School removed.');
}

function registerNewSchool() {
  const name = document.getElementById('newSchoolName').value.trim();
  const adminName = document.getElementById('newSchoolAdmin').value.trim();
  const adminUser = document.getElementById('newSchoolUsername').value.trim();
  const adminPass = document.getElementById('newSchoolPassword').value.trim();
  if (!name||!adminUser||!adminPass) { showToast('⚠️ Fill school name, username and password.'); return; }
  if (adminPass.length < 6) { showToast('⚠️ Password must be at least 6 characters.'); return; }

  const schoolId = 'school_' + Date.now();
  const schoolKey = getSchoolKey(schoolId);

  // Build a fresh school data object
  const freshData = {
    students:[], fees:[], teachers:[], classes:[
      {id:1,name:'KG1',level:'Kindergarten',teacher:''},
      {id:2,name:'KG2',level:'Kindergarten',teacher:''},
      {id:3,name:'P1',level:'Primary',teacher:''},
      {id:4,name:'P2',level:'Primary',teacher:''},
      {id:5,name:'P3',level:'Primary',teacher:''},
      {id:6,name:'P4',level:'Primary',teacher:''},
      {id:7,name:'P5',level:'Primary',teacher:''},
      {id:8,name:'P6',level:'Primary',teacher:''},
      {id:9,name:'JHS1',level:'JHS',teacher:''},
      {id:10,name:'JHS2',level:'JHS',teacher:''},
      {id:11,name:'JHS3',level:'JHS',teacher:''},
    ],
    albums:[], reports:[], weeklyRecords:[], attendance:[],
    backupHistory:[], schoolLogo:null, driveClientId:'',
    settings:{ schoolName:name, term:'First Term', session:new Date().getFullYear()+'/'+(new Date().getFullYear()+1), address:'', principal:adminName||'Administrator', district:'', motto:'' },
    users:[{ id:1, username:adminUser, password:adminPass, role:'Admin', name:adminName||adminUser, active:true }],
    nextStudentId:1, nextFeeId:1, nextTeacherId:1, nextClassId:12, nextAlbumId:1, nextWeeklyId:1, nextAttendanceId:1, nextUserId:2,
  };

  // Save locally first (works offline)
  localStorage.setItem(schoolKey, JSON.stringify(freshData));
  const reg = getRegistry();
  reg.push({ id:schoolId, key:schoolKey, name, createdAt:new Date().toISOString() });
  saveRegistry(reg); // saveRegistry also writes to Firebase

  // Write school data to Firebase
  if (window._fbReady && _isOnline) {
    window._fb.set(fbSchoolPath(schoolId), { ...freshData, savedAt: Date.now() })
      .then(() => console.log('[FB] New school written to Firebase ✅'))
      .catch(e => console.warn('[FB] school write failed:', e));
  }

  document.getElementById('registerSchoolModal').classList.remove('open');
  ['newSchoolName','newSchoolAdmin','newSchoolUsername','newSchoolPassword'].forEach(id=>document.getElementById(id).value='');
  renderSchoolList();
  showToast(`✅ School "${name}" registered! You can now log in.`);
}

// ── LOGIN ──
function attemptLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const schoolId = document.getElementById('loginScreen').dataset.schoolId;
  if (!schoolId) { showSchoolSelector(); return; }

  const schoolKey = getSchoolKey(schoolId);
  const loginBtn  = document.getElementById('loginBtn');

  // Show loading state
  if (loginBtn) { loginBtn.disabled = true; loginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading…'; }

  // Try Firebase first, fall back to localStorage
  const proceed = () => {
    const user = state.users.find(u => u.username===username && u.password===password && u.active);
    if (!user) {
      document.getElementById('loginError').style.display = 'block';
      if (loginBtn) { loginBtn.disabled = false; loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Login'; }
      return;
    }

    _currentSchoolKey = schoolKey;
    state.currentUser = user;
    showApp();

    // Start real-time listener so this device gets updates from others
    startRealtimeSync(schoolId);
    showSyncStatus(_isOnline ? 'online' : 'offline');

    document.querySelector('.user-name').textContent   = user.name;
    document.querySelector('.user-role').textContent   = user.role;
    document.querySelector('.user-avatar').textContent = user.name.charAt(0).toUpperCase();
    document.getElementById('sidebarSchoolName').textContent = state.settings.schoolName;

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
    if (loginBtn) { loginBtn.disabled = false; loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Login'; }
    showToast(`👋 Welcome, ${user.name} — ${state.settings.schoolName}`);
  };

  // Load local first for instant feel, then overlay with Firebase data
  loadSchoolData(schoolKey);
  if (window._fbReady && _isOnline) {
    loadSchoolDataFromFirebase(schoolId).then(() => proceed());
  } else {
    const loaded = !!localStorage.getItem(schoolKey);
    if (!loaded) {
      showToast('⚠️ No data found. Check your internet connection.');
      if (loginBtn) { loginBtn.disabled = false; loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Login'; }
      return;
    }
    proceed();
  }
}

function applyRoleNav(user) {
  const role = user.role || 'Teacher';

  // Student/Parent role → hide main app, show portal
  if (role === 'Student') {
    document.getElementById('appWrapper').style.display = 'none';
    showStudentPortal(user);
    return;
  }

  // Show all nav first
  document.querySelectorAll('.nav-item').forEach(el => el.style.display = '');

  // Admin sections hidden from Teacher
  const adminOnly = ['backup','settings','users','expenditure'];
  // Teacher-only visible sections
  const teacherHidden = [...adminOnly, 'promotion'];

  if (role === 'Teacher') {
    teacherHidden.forEach(sec => {
      document.querySelectorAll(`[data-section="${sec}"]`).forEach(el => el.style.display = 'none');
    });
  }
}

function doLogout() {
  saveNow();
  stopRealtimeSync();
  state.currentUser = null;
  _currentSchoolKey = null;
  _unsavedChanges   = false;
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

  // Register new school
  document.getElementById('registerSchoolBtn').addEventListener('click', ()=>{
    document.getElementById('registerSchoolModal').classList.add('open');
  });
  document.getElementById('closeRegisterModal').addEventListener('click', ()=>document.getElementById('registerSchoolModal').classList.remove('open'));
  document.getElementById('cancelRegisterModal').addEventListener('click', ()=>document.getElementById('registerSchoolModal').classList.remove('open'));
  document.getElementById('confirmRegisterBtn').addEventListener('click', registerNewSchool);

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

// ── RESOURCE CONTENT TAB SWITCHER ──
function switchResTab(tab) {
  ['file','text','link'].forEach(t => {
    const btn   = document.getElementById('resTab' + t.charAt(0).toUpperCase() + t.slice(1));
    const panel = document.getElementById('resContent' + t.charAt(0).toUpperCase() + t.slice(1));
    const active = t === tab;
    if (btn)   { btn.style.background = active ? 'var(--blue)' : 'var(--surface)'; btn.style.color = active ? '#fff' : 'var(--text)'; }
    if (panel) panel.style.display = active ? '' : 'none';
  });
}

function handleResFileDrop(event) {
  event.preventDefault();
  const zone = document.getElementById('resDropZone');
  zone.style.borderColor = ''; zone.style.background = 'var(--bg)';
  const file = event.dataTransfer.files[0];
  if (file) processResFile(file);
}

function processResFile(file) {
  const maxMB = 10;
  if (file.size > maxMB * 1024 * 1024) { showToast(`⚠️ File too large. Max ${maxMB}MB.`); return; }
  const ext  = file.name.split('.').pop().toLowerCase();
  const icons = { pdf:'fas fa-file-pdf', doc:'fas fa-file-word', docx:'fas fa-file-word',
                  ppt:'fas fa-file-powerpoint', pptx:'fas fa-file-powerpoint',
                  xls:'fas fa-file-excel', xlsx:'fas fa-file-excel',
                  png:'fas fa-file-image', jpg:'fas fa-file-image', jpeg:'fas fa-file-image',
                  gif:'fas fa-file-image', txt:'fas fa-file-alt' };
  const reader = new FileReader();
  reader.onload = ev => {
    const zone    = document.getElementById('resDropZone');
    const preview = document.getElementById('resFilePreview');
    const icon    = document.getElementById('resFileIcon');
    const nameEl  = document.getElementById('resFileName');
    const sizeEl  = document.getElementById('resFileSize');
    zone.style.display    = 'none';
    preview.style.display = 'flex';
    icon.className        = (icons[ext] || 'fas fa-file') + ' ';
    icon.style.color      = ext === 'pdf' ? '#dc2626' : ext.includes('doc') ? '#2563eb' : ext.includes('xls') ? '#16a34a' : ext.includes('ppt') ? '#d97706' : 'var(--blue)';
    nameEl.textContent    = file.name;
    sizeEl.textContent    = (file.size / 1024).toFixed(0) + ' KB · ' + ext.toUpperCase();
    // Store on the input element as data attribute
    document.getElementById('resFileInput').dataset.fileData     = ev.target.result;
    document.getElementById('resFileInput').dataset.fileName     = file.name;
    document.getElementById('resFileInput').dataset.fileType     = file.type;
    document.getElementById('resFileInput').dataset.fileExt      = ext;
    // Auto-fill title if empty
    const titleEl = document.getElementById('resTitle');
    if (titleEl && !titleEl.value) titleEl.value = file.name.replace(/\.[^.]+$/, '');
    showToast('📎 File ready — click Save to attach it');
  };
  reader.readAsDataURL(file);
}

function clearResFile() {
  const input   = document.getElementById('resFileInput');
  const zone    = document.getElementById('resDropZone');
  const preview = document.getElementById('resFilePreview');
  input.value = ''; input.dataset.fileData = ''; input.dataset.fileName = '';
  zone.style.display = ''; preview.style.display = 'none';
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

  // Detect which content tab is active
  const fileInput   = document.getElementById('resFileInput');
  const textContent = document.getElementById('resTextContent')?.value.trim() || '';
  const link        = document.getElementById('resLink')?.value.trim() || '';
  const fileData    = fileInput?.dataset.fileData || '';
  const fileName    = fileInput?.dataset.fileName || '';
  const fileExt     = fileInput?.dataset.fileExt  || '';

  const contentType = fileData   ? 'file'
                    : textContent ? 'text'
                    : link        ? 'link'
                    : 'none';

  const payload = {
    title, type, subject, cls, term, year, copies, condition,
    author, location, addedBy, notes,
    contentType,
    fileData:    contentType === 'file' ? fileData    : '',
    fileName:    contentType === 'file' ? fileName    : '',
    fileExt:     contentType === 'file' ? fileExt     : '',
    textContent: contentType === 'text' ? textContent : '',
    link:        contentType === 'link' ? link        : '',
  };

  if (editId) {
    const r = state.resources.find(r => r.id === parseInt(editId));
    if (r) Object.assign(r, payload);
    showToast('✅ Resource updated!');
  } else {
    state.resources.push({ id: state.nextResourceId++, ...payload, dateAdded: new Date().toISOString() });
    showToast('✅ Resource added to library!');
  }
  renderResources(); autosave();
  document.getElementById('resourceModal').classList.remove('open');
}

function editResource(id) {
  const r = state.resources.find(r => r.id === id);
  if (!r) return;
  document.getElementById('resourceModalTitle').innerHTML = '<i class="fas fa-book-open"></i> Edit Resource';
  document.getElementById('resEditId').value    = id;
  document.getElementById('resTitle').value     = r.title||'';
  document.getElementById('resType').value      = r.type||'';
  document.getElementById('resSubject').value   = r.subject||'';
  document.getElementById('resClass').value     = r.cls||'All Classes';
  document.getElementById('resTerm').value      = r.term||'';
  document.getElementById('resYear').value      = r.year||'';
  document.getElementById('resCopies').value    = r.copies||1;
  document.getElementById('resCondition').value = r.condition||'Good';
  document.getElementById('resAuthor').value    = r.author||'';
  document.getElementById('resLocation').value  = r.location||'';
  document.getElementById('resAddedBy').value   = r.addedBy||'';
  document.getElementById('resNotes').value     = r.notes||'';

  // Restore content tab
  clearResFile();
  document.getElementById('resTextContent').value = '';
  document.getElementById('resLink').value = '';

  if (r.contentType === 'file' && r.fileData) {
    const input = document.getElementById('resFileInput');
    input.dataset.fileData = r.fileData;
    input.dataset.fileName = r.fileName||'';
    input.dataset.fileExt  = r.fileExt||'';
    document.getElementById('resDropZone').style.display = 'none';
    const preview = document.getElementById('resFilePreview');
    preview.style.display = 'flex';
    document.getElementById('resFileName').textContent = r.fileName||'Attached file';
    document.getElementById('resFileSize').textContent = r.fileExt?.toUpperCase()||'';
    switchResTab('file');
  } else if (r.contentType === 'text') {
    document.getElementById('resTextContent').value = r.textContent||'';
    switchResTab('text');
  } else if (r.contentType === 'link' || r.link) {
    document.getElementById('resLink').value = r.link||'';
    switchResTab('link');
  } else {
    switchResTab('file');
  }
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
  document.getElementById('resTextContent').value='';
  document.getElementById('resLink').value='';
  clearResFile();
  switchResTab('file');
}

function downloadResourcesCSV() {
  const rows = (state.resources||[]).map((r,i) => [i+1, r.title||'', r.type||'', r.subject||'', r.cls||'', r.term||'', r.year||'', r.copies||1, r.condition||'', r.author||'', r.location||'', r.addedBy||'', r.contentType||'none', r.notes||'']);
  let csv = 'No,Title,Type,Subject,Class,Term,Year,Copies,Condition,Author,Location,Added By,Content Type,Notes\n';
  rows.forEach(r => { csv += r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',') + '\n'; });
  const blob = new Blob([csv], {type:'text/csv'});
  const a = Object.assign(document.createElement('a'), {href:URL.createObjectURL(blob), download:'resources.csv'});
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
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
  blue:   { name:'GES Blue',      accent:'#1a6fd4', accentLight:'#e8f0fb', accentDark:'#1255a8', sidebarBg:'#0f2a5e',  sidebarDark:true  },
  teal:   { name:'Ocean Teal',    accent:'#0891b2', accentLight:'#e0f7fd', accentDark:'#0670a0', sidebarBg:'#0c3347',  sidebarDark:true  },
  green:  { name:'Forest Green',  accent:'#16a34a', accentLight:'#dcfce7', accentDark:'#15803d', sidebarBg:'#0d2e1c',  sidebarDark:true  },
  purple: { name:'Royal Purple',  accent:'#7c3aed', accentLight:'#ede9fe', accentDark:'#6d28d9', sidebarBg:'#1e1035',  sidebarDark:true  },
  red:    { name:'Crimson Red',   accent:'#dc2626', accentLight:'#fee2e2', accentDark:'#b91c1c', sidebarBg:'#2d0a0a',  sidebarDark:true  },
  slate:  { name:'Slate Dark',    accent:'#475569', accentLight:'#f1f5f9', accentDark:'#334155', sidebarBg:'#1e293b',  sidebarDark:true  },
};

// Master function: applies CSS vars + all sidebar text colours in one pass
function applyTheme(themeKey) {
  const theme = THEMES[themeKey];
  if (!theme) return;
  state.appTheme = themeKey;

  // 1. CSS custom properties
  const root = document.documentElement;
  root.style.setProperty('--blue',       theme.accent);
  root.style.setProperty('--blue-light', theme.accentLight);
  root.style.setProperty('--blue-dark',  theme.accentDark);

  // 2. Re-paint the sidebar (respects current sidebarStyle override)
  _paintSidebar();

  autosave();
  renderThemeSwatches();
}

// Paints sidebar bg + ALL text inside it based on current theme + sidebarStyle
function _paintSidebar() {
  const sidebar  = document.querySelector('.sidebar');
  if (!sidebar) return;

  const themeKey = state.appTheme || 'blue';
  const theme    = THEMES[themeKey] || THEMES.blue;
  const style    = state.sidebarStyle || 'dark';

  let bg, isLight;
  if (style === 'light') {
    bg = '#ffffff'; isLight = true;
    sidebar.style.borderRight = '1px solid #dde3ef';
  } else if (style === 'gradient') {
    bg = `linear-gradient(160deg, ${theme.accent} 0%, ${theme.sidebarBg} 65%)`;
    isLight = false;
    sidebar.style.borderRight = 'none';
  } else {
    // dark — use theme's own dark sidebar colour
    bg = theme.sidebarBg; isLight = false;
    sidebar.style.borderRight = 'none';
  }
  sidebar.style.background = bg;

  // Text colours that depend on whether sidebar is light or dark
  const navText    = isLight ? 'rgba(30,40,60,.70)'  : 'rgba(255,255,255,.65)';
  const navHover   = isLight ? theme.accent          : '#ffffff';
  const navActive  = isLight ? theme.accent          : '#ffffff';
  const navActiveBg= isLight ? theme.accentLight     : theme.accent;
  const labelColor = isLight ? 'rgba(30,40,60,.35)'  : 'rgba(255,255,255,.30)';
  const brandName  = isLight ? '#1a2133'             : '#ffffff';
  const brandPro   = isLight ? theme.accent          : '#93c5fd';
  const userName   = isLight ? '#1a2133'             : '#ffffff';
  const userRole   = isLight ? 'rgba(30,40,60,.45)'  : 'rgba(255,255,255,.40)';
  const footBtnCol = isLight ? '#475569'             : 'rgba(255,255,255,.55)';
  const borderCol  = isLight ? 'rgba(0,0,0,.08)'     : 'rgba(255,255,255,.08)';

  // Nav items
  sidebar.querySelectorAll('.nav-item').forEach(el => {
    el.style.color = navText;
    el.style.background = '';
    el.onmouseenter = () => { if (!el.classList.contains('active')) { el.style.background='rgba(0,0,0,.05)'; el.style.color=navHover; } };
    el.onmouseleave = () => { if (!el.classList.contains('active')) { el.style.background=''; el.style.color=navText; } };
  });
  sidebar.querySelectorAll('.nav-item.active').forEach(el => {
    el.style.background = navActiveBg;
    el.style.color      = navActive;
  });

  // Labels
  sidebar.querySelectorAll('.nav-label').forEach(el => el.style.color = labelColor);

  // Brand text
  const bn = sidebar.querySelector('.brand-name');  if (bn) bn.style.color = brandName;
  const bp = sidebar.querySelector('.brand-pro');   if (bp) bp.style.color = brandPro;
  const un = sidebar.querySelector('.user-name');   if (un) un.style.color = userName;
  const ur = sidebar.querySelector('.user-role');   if (ur) ur.style.color = userRole;

  // Brand icon bg
  const bi = sidebar.querySelector('.brand-icon');
  if (bi) { bi.style.background = isLight ? theme.accentLight : theme.accent;
            bi.style.color      = isLight ? theme.accent       : '#ffffff'; }

  // User avatar
  const ua = sidebar.querySelector('.user-avatar');
  if (ua) { ua.style.background = isLight ? theme.accentLight : theme.accent;
            ua.style.color      = isLight ? theme.accent       : '#ffffff'; }

  // Footer buttons
  sidebar.querySelectorAll('.sidebar-foot-btn').forEach(el => el.style.color = footBtnCol);

  // Divider lines
  sidebar.querySelectorAll('.sidebar-brand, .sidebar-footer').forEach(el => {
    el.style.borderColor = borderCol;
  });
}

function applySidebarStyle(style) {
  state.sidebarStyle = style;
  _paintSidebar();
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
  const active = state.appTheme || 'blue';
  grid.innerHTML = Object.entries(THEMES).map(([key, t]) => {
    const isActive = active === key;
    // Swatch bottom strip: always white bg with dark text so it's always readable
    return `
    <div onclick="applyTheme('${key}')"
         style="cursor:pointer;border-radius:10px;overflow:hidden;
                border:3px solid ${isActive ? t.accent : 'transparent'};
                box-shadow:${isActive ? '0 0 0 1px '+t.accent : 'none'};
                transition:all .18s;"
         onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 4px 16px rgba(0,0,0,.18)'"
         onmouseout="this.style.transform='';this.style.boxShadow='${isActive?'0 0 0 1px '+t.accent:'none'}'"
         title="${t.name}">
      <!-- Sidebar preview strip (always dark bg) -->
      <div style="height:40px;background:${t.sidebarBg};display:flex;align-items:center;padding:0 10px;gap:7px;">
        <div style="width:10px;height:10px;border-radius:50%;background:${t.accent};flex-shrink:0;"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:3px;">
          <div style="height:4px;border-radius:2px;background:rgba(255,255,255,.35);width:70%;"></div>
          <div style="height:4px;border-radius:2px;background:rgba(255,255,255,.18);width:50%;"></div>
        </div>
      </div>
      <!-- Label strip — always white bg, dark text = always readable -->
      <div style="background:#ffffff;padding:7px 10px;display:flex;align-items:center;gap:8px;border-top:1px solid #eee;">
        <div style="width:18px;height:18px;border-radius:50%;background:${t.accent};flex-shrink:0;"></div>
        <div style="min-width:0;">
          <div style="font-size:11px;font-weight:700;color:#1a2133;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${t.name}</div>
          ${isActive ? `<div style="font-size:10px;color:${t.accent};font-weight:600;">✓ Active</div>` : `<div style="font-size:10px;color:#94a3b8;">Click to apply</div>`}
        </div>
      </div>
    </div>`;
  }).join('');
}

function initTheme() {
  applyTheme(state.appTheme || 'blue');
  if (state.sidebarStyle) applySidebarStyle(state.sidebarStyle);
  if (state.fontSize) applyFontSize(state.fontSize);
  const ssEl = document.getElementById('sidebarStyleSelect');
  if (ssEl && state.sidebarStyle) ssEl.value = state.sidebarStyle;
  const fsEl = document.getElementById('fontSizeSelect');
  if (fsEl && state.fontSize) fsEl.value = state.fontSize;
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
      <td><button class="tbl-btn" data-smsmsg="${smsText}" onclick="var t=this.getAttribute('data-smsmsg');navigator.clipboard.writeText(t);showToast('📋 SMS copied!')"><i class="fas fa-copy"></i> Copy</button>
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
  const fullName = `${pupil.first} ${pupil.last}`.toLowerCase();
  // Match by studentId OR name (case-insensitive) OR class
  const reports = (state.reports||[]).map((r,i)=>({...r,_idx:i}))
    .filter(r => {
      if (r.studentId && r.studentId === pupil.id) return true;
      const rName = (r.name||r.studentName||'').toLowerCase();
      if (rName && rName === fullName) return true;
      if (r.cls && r.cls === pupil.cls) return true;
      return false;
    });
  if (!reports.length) {
    panel.innerHTML = `<div class="card"><div style="text-align:center;padding:30px;color:var(--text-muted);"><i class="fas fa-chart-bar" style="font-size:32px;display:block;margin-bottom:10px;"></i>No report cards available yet.<br><small>Your teacher will publish your report card at the end of term.</small></div></div>`;
    return;
  }
  panel.innerHTML = `<div style="display:grid;gap:16px;">` + reports.map(r => {
    const gradeColor = g => {
      const n = parseFloat(g);
      if (isNaN(n)) return 'var(--text-muted)';
      return n >= 80 ? '#16a34a' : n >= 60 ? '#2563eb' : n >= 50 ? '#d97706' : '#dc2626';
    };
    return `
    <div class="card">
      <div class="card-head">
        <h2 class="card-title"><i class="fas fa-file-alt"></i> ${r.term||'—'} &nbsp;·&nbsp; ${r.year||'—'}</h2>
        <button class="btn-primary" style="font-size:12px;" onclick="viewPortalReport(${r._idx})"><i class="fas fa-print"></i> Print Report</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px;">
        <div style="background:var(--blue-light);padding:8px 14px;border-radius:8px;font-size:12px;"><strong>Class:</strong> ${r.cls||pupil.cls}</div>
        <div style="background:var(--blue-light);padding:8px 14px;border-radius:8px;font-size:12px;"><strong>Position:</strong> ${r.position||'—'} / ${r.classSize||'—'}</div>
        <div style="background:var(--blue-light);padding:8px 14px;border-radius:8px;font-size:12px;"><strong>Average:</strong> ${r.avg||'—'}% (${r.avgGrade||'—'})</div>
        <div style="background:var(--blue-light);padding:8px 14px;border-radius:8px;font-size:12px;"><strong>Attendance:</strong> ${r.daysPresent||'—'} / ${r.totalDays||'—'} days</div>
      </div>
      ${r.rows && r.rows.length ? `
        <div class="table-wrap"><table class="data-table" style="font-size:12px;">
          <thead><tr><th>Subject</th><th>Class Score</th><th>Exams</th><th>Total</th><th>Grade</th><th>Remark</th></tr></thead>
          <tbody>${r.rows.map(sub=>`<tr>
            <td style="font-weight:600;">${sub.name||sub.subject||'—'}</td>
            <td>${sub.classScore||sub.cs||'—'}</td>
            <td>${sub.examScore||sub.es||'—'}</td>
            <td style="font-weight:800;color:${gradeColor(sub.total)}">${sub.total||'—'}</td>
            <td>${sub.grade||'—'}</td>
            <td style="font-size:11px;color:var(--text-muted);">${sub.remark||'—'}</td>
          </tr>`).join('')}</tbody>
        </table></div>` : ''}
      ${r.remark ? `<div style="margin-top:10px;padding:10px 14px;background:var(--bg);border-radius:8px;font-size:13px;"><strong>Teacher's Remark:</strong> <em>${r.remark}</em></div>` : ''}
      ${r.hmRemark ? `<div style="margin-top:6px;padding:10px 14px;background:var(--bg);border-radius:8px;font-size:13px;"><strong>Headmaster's Remark:</strong> <em>${r.hmRemark}</em></div>` : ''}
    </div>`;
  }).join('') + `</div>`;
}

function viewPortalReport(idx) {
  const r = (state.reports||[])[idx];
  if (!r) { showToast('Report not found.'); return; }
  const school = state.settings;
  const logoHtml = state.schoolLogo ? `<img src="${state.schoolLogo}" style="height:65px;object-fit:contain;"/>` : '🏫';
  const gradeColor = g => { const n=parseFloat(g); if(isNaN(n)) return '#374151'; return n>=80?'#16a34a':n>=60?'#2563eb':n>=50?'#d97706':'#dc2626'; };
  const win = window.open('','_blank');
  const rows = (r.rows||[]).map((sub,i)=>`<tr>
    <td>${i+1}</td><td>${sub.name||sub.subject||'—'}</td>
    <td style="text-align:center;">${sub.classScore||sub.cs||'—'}</td>
    <td style="text-align:center;">${sub.examScore||sub.es||'—'}</td>
    <td style="text-align:center;font-weight:800;color:${gradeColor(sub.total)}">${sub.total||'—'}</td>
    <td style="text-align:center;">${sub.grade||'—'}</td>
    <td>${sub.remark||'—'}</td>
  </tr>`).join('');
  win.document.write(`<!DOCTYPE html><html><head><title>Report Card — ${r.name}</title><style>
    body{font-family:'Segoe UI',Arial,sans-serif;padding:24px;max-width:720px;margin:auto;color:#1a2133;}
    .header{display:flex;align-items:center;gap:16px;border-bottom:3px solid #1a6fd4;padding-bottom:14px;margin-bottom:18px;}
    .school-name{font-size:19px;font-weight:800;color:#1a6fd4;}.sub{font-size:12px;color:#64748b;}
    .title{background:#e8f0fe;padding:10px 16px;border-radius:8px;color:#1a6fd4;font-weight:700;font-size:14px;margin-bottom:14px;}
    .info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px;}
    .info-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px;text-align:center;}
    .info-val{font-size:16px;font-weight:800;}.info-lbl{font-size:10px;color:#64748b;margin-top:2px;}
    table{width:100%;border-collapse:collapse;margin-bottom:14px;}
    th{background:#1a6fd4;color:#fff;padding:7px 10px;font-size:11px;text-align:left;}
    td{padding:6px 10px;border-bottom:1px solid #eee;font-size:12px;}
    .remark{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;margin-bottom:10px;font-size:12px;}
    .sig{display:flex;justify-content:space-between;margin-top:30px;}
    .sig-box{text-align:center;width:160px;}.sig-line{border-top:1px solid #333;padding-top:4px;font-size:10px;color:#555;}
    .footer{margin-top:16px;padding-top:10px;border-top:1px solid #eee;font-size:10px;color:#94a3b8;text-align:center;}
  </style></head><body>
  <div class="header">${logoHtml}<div>
    <div class="school-name">${school.schoolName||'School'}</div>
    <div class="sub">${school.address||''} | ${school.district||''}</div>
    <div class="sub">Headmaster: ${school.principal||''} | ${school.motto||''}</div>
  </div></div>
  <div class="title">📋 Academic Report Card &nbsp;·&nbsp; ${r.term||'—'} &nbsp;·&nbsp; ${r.year||'—'}</div>
  <div style="margin-bottom:12px;font-size:13px;"><strong>Name:</strong> ${r.name} &nbsp;&nbsp; <strong>Class:</strong> ${r.cls} &nbsp;&nbsp; <strong>Date:</strong> ${r.date||''}</div>
  <div class="info-grid">
    <div class="info-box"><div class="info-val">${r.avg||'—'}%</div><div class="info-lbl">Average</div></div>
    <div class="info-box"><div class="info-val">${r.avgGrade||'—'}</div><div class="info-lbl">Grade</div></div>
    <div class="info-box"><div class="info-val">${r.position||'—'}/${r.classSize||'—'}</div><div class="info-lbl">Position</div></div>
    <div class="info-box"><div class="info-val">${r.daysPresent||'—'}/${r.totalDays||'—'}</div><div class="info-lbl">Attendance</div></div>
    <div class="info-box"><div class="info-val">${r.interest||'—'}</div><div class="info-lbl">Interest</div></div>
    <div class="info-box"><div class="info-val">${r.conduct||'—'}</div><div class="info-lbl">Conduct</div></div>
  </div>
  <table>
    <thead><tr><th>#</th><th>Subject</th><th>Class Score</th><th>Exams</th><th>Total</th><th>Grade</th><th>Remark</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="remark"><strong>Class Teacher:</strong> <em>${r.remark||'—'}</em></div>
  <div class="remark"><strong>Headmaster:</strong> <em>${r.hmRemark||'—'}</em></div>
  ${r.nextTerm ? `<div class="remark"><strong>Next Term Begins:</strong> ${r.nextTerm}</div>` : ''}
  <div class="sig">
    <div class="sig-box"><div class="sig-line">Class Teacher</div></div>
    <div class="sig-box"><div class="sig-line">Headmaster</div></div>
    <div class="sig-box"><div class="sig-line">Parent/Guardian</div></div>
  </div>
  <div class="footer">EduManage Pro · ${school.schoolName||'School'} · Printed ${new Date().toLocaleString('en-GH')}</div>
  <script>window.onload=function(){window.print();}<\/script>
  </body></html>`);
  win.document.close();
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
  if (!albums.length) {
    panel.innerHTML = '<div class="card"><div style="text-align:center;padding:30px;color:var(--text-muted);"><i class="fas fa-images" style="font-size:32px;display:block;margin-bottom:10px;"></i>No gallery albums yet.</div></div>';
    return;
  }
  const albumCards = albums.map(a => {
    const allPhotos  = a.photos||[];
    const realPhotos = allPhotos.filter(p => p.src && p.src !== '[photo-omitted]');
    const total      = allPhotos.length;
    let photoGrid;
    if (realPhotos.length) {
      const thumbs = realPhotos.slice(0,4).map(p => {
        const safeSrc = p.src.replace(/"/g,'&quot;').replace(/'/g,'&#39;');
        return '<img src="' + safeSrc + '" loading="lazy" style="width:100%;height:80px;object-fit:cover;border-radius:6px;cursor:pointer;" onclick="portalOpenPhoto(this.src)">';
      }).join('');
      const extra = realPhotos.length > 4 ? '<div style="display:flex;align-items:center;justify-content:center;height:80px;background:var(--blue-light);border-radius:6px;font-weight:700;color:var(--blue);">+' + (realPhotos.length-4) + ' more</div>' : '';
      photoGrid = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:10px;">' + thumbs + extra + '</div>';
    } else if (total > 0) {
      photoGrid = '<div style="text-align:center;padding:14px 0;color:var(--text-muted);font-size:12px;"><i class="fas fa-images"></i> ' + total + ' photo' + (total!==1?'s':'') + ' in album</div>';
    } else {
      photoGrid = '<div style="text-align:center;padding:14px 0;color:var(--text-muted);font-size:12px;"><i class="fas fa-image"></i> No photos yet</div>';
    }
    return '<div class="card" style="padding:16px;">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">' +
        '<div style="font-size:26px;">' + (a.emoji||'\uD83D\uDDBC\uFE0F') + '</div>' +
        '<div><div style="font-weight:700;font-size:14px;">' + a.name + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);">' + total + ' photo' + (total!==1?'s':'') + '</div></div>' +
      '</div>' + photoGrid + '</div>';
  }).join('');

  panel.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;">' + albumCards + '</div>' +
    '<div id="portalLightbox" onclick="document.getElementById(\'portalLightbox\').style.display=\'none\'" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;align-items:center;justify-content:center;cursor:zoom-out;">' +
    '<img id="portalLightboxImg" style="max-width:92vw;max-height:90vh;border-radius:10px;box-shadow:0 0 60px rgba(0,0,0,.7);">' +
    '</div>';
}

function portalToggleText(id) {
  const div = document.getElementById(id);
  const btn = document.getElementById('btn_' + id);
  if (!div) return;
  const showing = div.style.display !== 'none';
  div.style.display = showing ? 'none' : 'block';
  if (btn) btn.innerHTML = showing
    ? '<i class="fas fa-book-open"></i> Read Content'
    : '<i class="fas fa-chevron-up"></i> Hide Content';
}

function portalOpenPhoto(src) {
  const lb  = document.getElementById('portalLightbox');
  const img = document.getElementById('portalLightboxImg');
  if (lb && img) { img.src = src; lb.style.display = 'flex'; }
}


function renderPortalResources() {
  const panel = document.getElementById('portalPanelResources');
  if (!panel) return;
  const pupil = _portalPupil();
  let res = (state.resources||[]).filter(r => r.cls==='All Classes' || !pupil || r.cls===pupil.cls);
  if (!res.length) {
    panel.innerHTML = '<div class="card"><div style="text-align:center;padding:30px;color:var(--text-muted);"><i class="fas fa-book-open" style="font-size:32px;display:block;margin-bottom:10px;"></i>No resources available yet.</div></div>';
    return;
  }
  const typeIcon = {'Exam Paper':'fas fa-scroll','Textbook':'fas fa-book','Workbook':'fas fa-book-open',
                    'Past Question':'fas fa-file-alt','Notes':'fas fa-sticky-note','Other':'fas fa-shapes'};
  const extIcon  = {pdf:'fas fa-file-pdf',doc:'fas fa-file-word',docx:'fas fa-file-word',
                    ppt:'fas fa-file-powerpoint',pptx:'fas fa-file-powerpoint',
                    xls:'fas fa-file-excel',xlsx:'fas fa-file-excel',
                    png:'fas fa-file-image',jpg:'fas fa-file-image',jpeg:'fas fa-file-image',txt:'fas fa-file-alt'};

  const cards = res.map(r => {
    let contentHtml = '';
    if (r.contentType === 'file' && r.fileData) {
      const ico = extIcon[r.fileExt||''] || 'fas fa-file';
      const safeName = (r.fileName||r.title||'file').replace(/"/g,'&quot;');
      contentHtml = '<a href="' + r.fileData + '" download="' + safeName + '" style="display:flex;align-items:center;gap:8px;margin-top:10px;padding:8px 12px;background:var(--blue-light);border-radius:8px;text-decoration:none;color:var(--blue);font-size:13px;font-weight:600;">' +
        '<i class="' + ico + '"></i> Download ' + (r.fileExt||'File').toUpperCase() +
        '<i class="fas fa-download" style="margin-left:auto;font-size:11px;"></i></a>';
    } else if (r.contentType === 'text' && r.textContent) {
      const escaped = r.textContent.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const rid = 'restxt_' + r.id;
      contentHtml = '<div style="margin-top:10px;">' +
        '<button id="btn_' + rid + '" onclick="portalToggleText(\'' + rid + '\')" style="font-size:12px;font-weight:600;color:var(--blue);background:var(--blue-light);border:none;padding:6px 12px;border-radius:20px;cursor:pointer;">' +
        '<i class="fas fa-book-open"></i> Read Content</button>' +
        '<div id="' + rid + '" style="display:none;margin-top:8px;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:13px;line-height:1.7;white-space:pre-wrap;max-height:260px;overflow-y:auto;">' + escaped + '</div></div>';
    } else if (r.link) {
      const isYT  = r.link.includes('youtube.com') || r.link.includes('youtu.be');
      const isGD  = r.link.includes('drive.google.com');
      const lIcon = isYT ? 'fab fa-youtube' : isGD ? 'fab fa-google-drive' : 'fas fa-external-link-alt';
      const lCol  = isYT ? '#FF0000' : isGD ? '#4285F4' : 'var(--blue)';
      const lLbl  = isYT ? 'Watch on YouTube' : isGD ? 'Open in Google Drive' : 'Open Resource';
      contentHtml = '<a href="' + r.link + '" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:8px;margin-top:10px;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;text-decoration:none;color:var(--text);font-size:13px;font-weight:600;">' +
        '<i class="' + lIcon + '" style="color:' + lCol + ';"></i> ' + lLbl +
        '<i class="fas fa-external-link-alt" style="margin-left:auto;font-size:10px;color:var(--text-muted);"></i></a>';
    }
    return '<div class="card" style="padding:14px;">' +
      '<div style="display:flex;gap:10px;align-items:flex-start;margin-bottom:4px;">' +
        '<div style="width:38px;height:38px;border-radius:8px;background:var(--blue-light);color:var(--blue);display:grid;place-items:center;font-size:16px;flex-shrink:0;">' +
          '<i class="' + (typeIcon[r.type]||'fas fa-file') + '"></i></div>' +
        '<div style="flex:1;min-width:0;"><div style="font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + r.title + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);">' + r.type + (r.subject?' · '+r.subject:'') + '</div></div>' +
      '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:5px;font-size:11px;margin-top:6px;">' +
        (r.cls?'<span style="background:var(--blue-light);color:var(--blue);border-radius:20px;padding:1px 8px;">'+r.cls+'</span>':'') +
        (r.term?'<span style="background:var(--bg);border:1px solid var(--border);border-radius:20px;padding:1px 8px;">'+r.term+'</span>':'') +
        (r.year?'<span style="background:var(--bg);border:1px solid var(--border);border-radius:20px;padding:1px 8px;">'+r.year+'</span>':'') +
      '</div>' + contentHtml + '</div>';
  }).join('');
  panel.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;">' + cards + '</div>';
}


function renderPortalNotices() {
  const panel = document.getElementById('portalPanelNotices');
  if (!panel) return;
  const pupil = _portalPupil();
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
