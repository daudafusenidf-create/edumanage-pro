window._EDUMANAGE_VERSION = 'v2026.SYNC.FINAL.10'; // Incremented version

/* ════════════════════════════════════════
   EduManage Pro - GES Edition
   Full Application Logic
════════════════════════════════════════ */

// ════════════════════════════════════════
// MULTI-SCHOOL DATABASE ARCHITECTURE
// Each school gets its own isolated localStorage key
// Registry key stores all registered schools
// ════════════════════════════════════════

const REGISTRY_KEY = 'edumanage_schools_registry'; // list of all schools
let _currentSchoolKey = null;  // active school's storage key

// ── GLOBAL APPLICATION STATE ──
// Single source of truth for all in-memory data within a school session.
const state = {
  currentUser:  null,
  students:     [], fees:          [], feeStructure:  [], classBills:   [],
  payments:     [], teachers:      [], classes:        [], albums:        [],
  reports:      [], _reportsDict:  {}, weeklyRecords:  [], attendance:   [],
  settings: {
    schoolName: 'My School',
    session:    new Date().getFullYear() + '/' + (new Date().getFullYear() + 1),
    term:       'First Term',
    address: '', principal: '', district: '', motto: ''
  },
  schoolLogo:   null, driveClientId: null, backupHistory: [],
  users:        [], admissions:    [], expenditures:  [], resources:     [],
  exams:        [], transfers:     [], announcements: [], parentNotifications: [],
  appTheme:     'default', sidebarStyle: 'dark', fontSize: '15',
  nextStudentId: 1, nextStudentUID: 1, nextFeeId: 1, nextReceiptId: 1,
  nextTeacherId: 1, nextClassId:    1, nextUserId: 1, nextResourceId:  1,
  nextExamId:    1, nextAlbumId:    1, nextAttendanceId: 1, nextWeeklyId: 1,
  nextTransferId: 1, nextAnnouncementId: 1, nextPNId: 1,
  nextAdmissionId: 1, nextExpenditureId: 1
};

// ── FEE PAYMENT DRAFT (holds unsaved payment entries in the fee modal) ──
let _feePaymentDraft = [];

// ── LOGIN LOCKOUT ──
const LOGIN_MAX_TRIES  = 5;
const LOGIN_LOCKOUT_MS = 30000; // 30 seconds
const _loginAttempts   = {};    // { [schoolId]: { count, time } }

function isLoginLocked(schoolId) {
  const a = _loginAttempts[schoolId];
  if (!a || a.count < LOGIN_MAX_TRIES) return false;
  return (Date.now() - a.time) < LOGIN_LOCKOUT_MS;
}
function getRemainingLockout(schoolId) {
  const a = _loginAttempts[schoolId];
  if (!a) return 0;
  return Math.ceil((LOGIN_LOCKOUT_MS - (Date.now() - a.time)) / 1000);
}
function recordLoginFail(schoolId) {
  if (!_loginAttempts[schoolId]) _loginAttempts[schoolId] = { count: 0, time: Date.now() };
  _loginAttempts[schoolId].count++;
  _loginAttempts[schoolId].time = Date.now();
}
function resetLoginAttempts(schoolId) {
  delete _loginAttempts[schoolId];
}

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
let _fbPauseIncoming = false; // suppress onValue echo after we write
let _fbPauseOutgoing = false; // block push during startup window
let _fbDataLoaded   = false; // true only after we've confirmed our data is in sync with Firebase
let _fbKnownSavedAt = 0;    // savedAt timestamp last seen on Firebase - never push older data than this

window.addEventListener('online',  () => { _isOnline = true;  showSyncStatus('online'); });
window.addEventListener('offline', () => { _isOnline = false; showSyncStatus('offline'); });

function fbSchoolPath(schoolId) {
  return 'schools/' + schoolId + '/data';
}

function showSyncStatus(status) {
  const el = document.getElementById('syncStatusBadge');
  if (!el) return;
  if (status === 'online')  { el.innerHTML = '<i class="fas fa-wifi"></i> Live Sync'; el.style.background='var(--green)'; }
  if (status === 'offline') { el.innerHTML = '<i class="fas fa-wifi-slash"></i> Offline'; el.style.background='#f59e0b'; }
  if (status === 'saving')  { el.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; el.style.background='var(--blue)'; }
}

function startRealtimeSync(schoolId) {
  stopRealtimeSync(); // Always detach any previous listener first
  if (!window._fbReady) return;
  const dbRef = window._fb.ref(fbSchoolPath(schoolId));
  // In Firebase v10 modular SDK, onValue() returns an UNSUBSCRIBE function.
  // We must store and call THAT - not the ref - to properly detach.
  _fbListener = window._fb.onValue(dbRef, (snap) => {
    if (!snap.exists() || !state.currentUser) return;
    const data = snap.val();
    const localJson = localStorage.getItem(getSchoolKey(schoolId));
    const localSavedAt = localJson ? (JSON.parse(localJson).savedAt || 0) : 0;
    const fbSavedAt = data.savedAt || 0;

    // Always mark as loaded when we receive any Firebase data
    if (!_fbDataLoaded) {
      _fbDataLoaded = true;
      _fbKnownSavedAt = fbSavedAt;
    }
    // Track highest savedAt seen from Firebase for subsequent syncs
    if (fbSavedAt > _fbKnownSavedAt) _fbKnownSavedAt = fbSavedAt;

    if (_fbPauseIncoming) return; // suppress echo of our own write
    if (fbSavedAt <= localSavedAt) return; // Local is already up to date

    // Firebase has newer data - apply it
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
    const safe = fn => { if (typeof fn === 'function') fn(); };
    safe(renderStudents); safe(renderFees); safe(renderTeachers); safe(renderClasses);
    safe(renderGallery);  safe(renderSavedReports); safe(renderWeekly);
    safe(renderAttendance); safe(renderUsers); safe(updateDashStats); safe(updateFeeStats);
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

    // Firebase registry is the source of truth - only use schools NOT in deletedIds
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
    // Firebase has no data yet - this is a brand new school, safe to push local
    _fbDataLoaded = true;
    // FIX BUG 2: Ensure _fbPauseOutgoing is cleared even for new schools
    _fbPauseOutgoing = false;
    throw new Error('No data in Firebase');
  }
  const fbData  = snap.val();
  const localJson = localStorage.getItem(getSchoolKey(schoolId));
  const localSavedAt = localJson ? (JSON.parse(localJson).savedAt || 0) : 0;
  const fbSavedAt    = fbData.savedAt || 0;

  if (fbSavedAt >= localSavedAt) {
    // Firebase is newer or equal - use Firebase as source of truth
    localStorage.setItem(getSchoolKey(schoolId), JSON.stringify(fbData));
    loadSchoolData(getSchoolKey(schoolId));
    // FIX BUG 1: Use the real Firebase savedAt timestamp, not Date.now().
    // Using Date.now() caused a race: saves made within the same ms as login
    // would fail the (savedAt > _fbKnownSavedAt) guard in saveToDB() and never
    // reach Firebase, so data appeared locally then vanished on next sync.
    _fbKnownSavedAt = fbSavedAt;
    _fbDataLoaded = true;
    // FIX BUG 2: Ensure _fbPauseOutgoing is cleared after a successful load
    // so that saves are never silently blocked for the rest of the session.
    _fbPauseOutgoing = false;
    return fbData;
  } else {
    // Local is genuinely newer - load it and allow push on next real user action
    loadSchoolData(getSchoolKey(schoolId));
    _fbKnownSavedAt = localSavedAt; // use local timestamp - it's the newer source
    _fbDataLoaded = true;
    _fbPauseOutgoing = false; // FIX BUG 2: always clear the outgoing pause after load
    return fbData;
  }
}

function _applyDataToState(data) {
  const merge = (key, def) => { if (data[key] !== undefined) state[key] = data[key]; else if (state[key]===undefined) state[key]=def; };
  merge('students',[]); merge('fees',[]); merge('feeStructure',[]); merge('classBills',[]); merge('payments',[]); merge('teachers',[]); merge('classes',[]);
  merge('albums',[]); merge('reports',[]); merge('weeklyRecords',[]); merge('attendance',[]);
  merge('settings',{}); merge('users',[]); merge('admissions',[]); merge('expenditures',[]);
  merge('resources',[]); merge('exams',[]); merge('transfers',[]); merge('announcements',[]);
  merge('parentNotifications',[]); merge('backupHistory',[]);
  merge('nextStudentId',1); merge('nextStudentUID',1); merge('nextFeeId',1); merge('nextReceiptId',1); merge('nextTeacherId',1);
  merge('nextClassId',1); merge('nextUserId',1); merge('nextResourceId',1);
  merge('nextExamId',1); merge('nextAlbumId',1); merge('nextAttendanceId',1);
  merge('nextWeeklyId',1); merge('nextTransferId',1); merge('nextAnnouncementId',1);
  merge('nextPNId',1); merge('nextAdmissionId',1); merge('nextExpenditureId',1);
  if (data.schoolLogo !== undefined) state.schoolLogo = data.schoolLogo;
}

// Save current school data to its own key
function saveToDB() {
  if (!_currentSchoolKey) return;
  try {
    const savedAt = Date.now();
    const data = {
      students: state.students,
      fees: state.fees,
      feeStructure: state.feeStructure||[],
      classBills: state.classBills||[],
      payments: state.payments||[],
      teachers: state.teachers,
      classes: state.classes,
      albums: state.albums.map(a=>({...a, photos:(a.photos||[]).map(p=>({name:p.name,src:p.src&&p.src.length>500000?'[photo-omitted]':p.src}))})),
      reports: state.reports,
      _reportsDict: state._reportsDict||{},
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
      nextStudentUID: state.nextStudentUID || 1,
      nextFeeId: state.nextFeeId,
      nextReceiptId: state.nextReceiptId||1,
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

    // 2. Push to Firebase - guards:
    //    _fbDataLoaded: we must have loaded from Firebase first this session
    //    savedAt > _fbKnownSavedAt: only push if we loaded data before this moment
    //    (on fresh page load _fbKnownSavedAt=0, so we wait until loadSchoolDataFromFirebase
    //     sets it, after which any save with a newer timestamp is legitimate)
    if (window._fbReady && _isOnline && _fbDataLoaded && state.currentUser) {
      const schoolId = _currentSchoolKey.replace('edumanage_school_', '');
      showSyncStatus('saving');
      _fbPauseIncoming = true; // suppress our own echo
      _fbKnownSavedAt = savedAt; // Update our known timestamp immediately
      window._fb.set(fbSchoolPath(schoolId), data)
        .then(() => {
          showSyncStatus('online');
          markSaved(); // Only mark as saved once Firebase confirms
          // FIX BUG 3: Extended from 2000ms to 5000ms - on slow connections the
          // Firebase echo arrived after 2s, triggering an overwrite of fresh data.
          setTimeout(() => { _fbPauseIncoming = false; }, 5000);
        })
        .catch(e => {
          console.warn('[FB] Save to Firebase failed:', e);
          _fbPauseIncoming = false;
          // FIX BUG 2: Also reset _fbKnownSavedAt so next save retries
          _fbKnownSavedAt = savedAt - 1; // Roll back so next save retries
          showSyncStatus('offline');
          showToast('⚠️ Cloud save failed - data saved locally only.');
        });
    } else {
      // Offline or not yet loaded - still mark saved locally
      markSaved();
    }

    // 3. Keep registry entry's displayName in sync
    const reg = getRegistry();
    const entry = reg.find(s => s.key === _currentSchoolKey);
    if (entry) { entry.name = state.settings.schoolName; saveRegistry(reg); }
  } catch(e) { 
    console.warn('Save failed:', e);
    // FIX BUG 2: Always reset pause flags on error
    _fbPauseIncoming = false;
    _fbPauseOutgoing = false;
  }
}

// ── REPORTS LOADER ──
// Loads report data from a saved data object into state.
// Handles both the flat array and the indexed dict formats.
function _loadReports(data) {
  if (data.reports)      state.reports      = data.reports;
  if (data._reportsDict) state._reportsDict = data._reportsDict;
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
    _loadReports(data);
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
    if (data.nextStudentUID)   state.nextStudentUID   = data.nextStudentUID;
    if (data.nextFeeId)        state.nextFeeId        = data.nextFeeId;
    if (data.nextReceiptId)   state.nextReceiptId   = data.nextReceiptId;
    if (data.feeStructure)     state.feeStructure     = data.feeStructure;
    if (data.classBills)       state.classBills       = data.classBills;
    if (data.payments)         state.payments         = data.payments;
    if (data.nextTeacherId)    state.nextTeacherId    = data.nextTeacherId;
    if (data.nextClassId)      state.nextClassId      = data.nextClassId;
    if (data.nextAlbumId)      state.nextAlbumId      = data.nextAlbumId;
    if (data.nextWeeklyId)     state.nextWeeklyId     = data.nextWeeklyId;
    if (data.nextAttendanceId) state.nextAttendanceId = data.nextAttendanceId;
    if (data.nextUserId)       state.nextUserId       = data.nextUserId;
    if (data.nextExpenditureId) state.nextExpenditureId = data.nextExpenditureId;
    // Migrate legacy f.payments[] into global state.payments[] ledger (runs once)
    migratePaymentsToGlobalLedger();
    // Stamp missing studentId on fee records that were saved before this fix
    backfillFeeStudentIds();
    return true;
  } catch(e) { console.warn('Load failed:', e); return false; }
}

// ════════════════════════════════════════
// FEE SYSTEM - FIXED VERSION
// ════════════════════════════════════════

// Get the expected fee for a class+term+year from the structure table
function getFeeFromStructure(cls, term, year) {
  if (!state.feeStructure) return null;
  const yr = year || state.settings.session || '';
  const entry = state.feeStructure.find(s =>
    s.cls === cls && s.term === term && (s.year === yr || !s.year)
  );
  return entry ? entry.amount : null;
}

// Get the correct due amount for a fee record - ALWAYS prefer structure
function getDueForRecord(f) {
  // First, get the pupil's current class (may have changed since fee record was created)
  const pupil = f.studentId ? state.students.find(s => s.id === f.studentId) : null;
  const currentClass = pupil ? pupil.cls : f.cls;
  
  // Try fee structure first with current class
  const structAmt = getFeeFromStructure(currentClass, f.term, f.year || state.settings.session);
  if (structAmt !== null) return structAmt;
  
  // Fall back to stored due amount
  return f.due || 0;
}

// Calculate total paid for a record - use global ledger as source of truth
function totalPaidForRecord(f) {
  if (!f) return 0;
  
  // Use studentId if available, otherwise try to find pupil by name
  const studentId = f.studentId;
  const term = f.term;
  const year = f.year || state.settings.session || '';
  
  // Try global payments ledger first (most accurate)
  if (studentId && state.payments && state.payments.length) {
    const sum = state.payments
      .filter(p => 
        p.studentId === studentId && 
        p.term === term && 
        (p.year === year || !p.year)
      )
      .reduce((a, p) => a + (p.amount || p.amt || 0), 0);
    if (sum > 0) return sum;
  }
  
  // Fallback to f.payments[] on the fee record
  if (f.payments && f.payments.length) {
    return f.payments.reduce((a, p) => a + (p.amt || 0), 0);
  }
  
  // Legacy fallback
  return f.paid || 0;
}

// Calculate total due including arrears
function totalDueForRecord(f) {
  return getDueForRecord(f) + (f.arrears || 0);
}

// Get status based on due and paid
function getStatus(due, paid) { 
  return paid >= due ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid'; 
}

// Term ordering helper
const TERM_ORDER = {'First Term':1, 'Second Term':2, 'Third Term':3};

function termBefore(t1, t2) {
  // Returns true if t1 comes before t2
  return (TERM_ORDER[t1] || 0) < (TERM_ORDER[t2] || 0);
}

// FIXED: Get arrears for pupil using studentId for reliable lookup
function getArrearsForPupil(studentId, studentName, currentTerm) {
  if (!studentId && !studentName) return 0;
  
  // Find ALL fee records for this pupil across all terms
  const allFees = state.fees.filter(f => {
    if (studentId && f.studentId === studentId) return true;
    if (!studentId && f.student === studentName) return true;
    return false;
  });
  
  // Sum unpaid balances from all PRIOR terms
  let totalArrears = 0;
  allFees.forEach(f => {
    // Skip if this is current term or future term
    if (!termBefore(f.term, currentTerm)) return;
    
    const due = getDueForRecord(f);
    const paid = totalPaidForRecord(f);
    const arrears = Math.max(0, due - paid);
    totalArrears += arrears;
  });
  
  return totalArrears;
}

// FIXED: Auto-fill fee modal from pupil selection
function autoFillFeeFromPupil(pupilId) {
  if (!pupilId) {
    document.getElementById('fStudentName').value = '';
    document.getElementById('fClass').value = '';
    document.getElementById('feeAutoFilledInfo').style.display = 'none';
    document.getElementById('feeExistingWarning').style.display = 'none';
    document.getElementById('fDue').value = '';
    const arrEl2 = document.getElementById('fArrearsRow');
    if (arrEl2) { 
      arrEl2.style.display = 'none'; 
      arrEl2.dataset.arrears = '0'; 
    }
    _feePaymentDraft = []; 
    renderPaymentLogInModal();
    return;
  }
  
  const p = state.students.find(s => s.id === parseInt(pupilId));
  if (!p) return;
  
  const name = `${p.first} ${p.last}`;
  document.getElementById('fStudentName').value = name;
  document.getElementById('fClass').value = p.cls;
  document.getElementById('feeAutoFilledInfo').style.display = 'flex';

  const term = document.getElementById('fTerm')?.value || state.settings.term || 'First Term';
  const year = state.settings.session || '';

  // ── Auto-fill fee from structure table (read-only - teachers cannot override) ──
  const structAmt = getFeeFromStructure(p.cls, term, year);
  const fDueEl = document.getElementById('fDue');
  const fDueNotice = document.getElementById('fDueStructureNotice');
  
  if (structAmt !== null && structAmt > 0) {
    fDueEl.value = structAmt;
    fDueEl.readOnly = true;
    fDueEl.style.background = 'var(--bg-light)';
    fDueEl.style.color = 'var(--text-muted)';
    fDueEl.style.cursor = 'not-allowed';
    fDueEl.title = 'Set in Fee Structure - cannot be changed here';
    if (fDueNotice) {
      fDueNotice.style.display = 'block';
      fDueNotice.style.color = 'var(--blue)';
      fDueNotice.innerHTML = '<i class="fas fa-lock" style="font-size:9px;"></i> From Fee Structure';
    }
  } else {
    // No fee structure set — allow admin to type the amount manually
    fDueEl.readOnly = false;
    fDueEl.style.background = '';
    fDueEl.style.color = '';
    fDueEl.style.cursor = '';
    fDueEl.title = 'Enter fee amount manually (or set it in Fee Structure)';
    fDueEl.placeholder = 'Enter amount (e.g. 350)';
    if (fDueNotice) {
      fDueNotice.style.display = 'block';
      fDueNotice.style.color = 'var(--yellow)';
      fDueNotice.innerHTML = '<i class="fas fa-exclamation-triangle" style="font-size:9px;"></i> No Fee Structure set for ' + p.cls + ' · ' + term + '. Enter amount manually or set it in Fee Structure.';
    }
  }

  // Check if a fee record already exists for this pupil THIS term — ID-first
  const existing = state.fees.find(f => 
    f.studentId === p.id && f.term === term && (f.year === year || !f.year)
  );
  
  if (existing) {
    document.getElementById('fEditId').value = existing.id;
    // Always use structure amount, not stored f.due
    if (structAmt !== null) fDueEl.value = structAmt;
    else fDueEl.value = existing.due;
    
    _feePaymentDraft = existing.payments ? [...existing.payments]
                     : (existing.paid > 0 ? [{amt:existing.paid, date:existing.createdAt?.slice(0,10)||new Date().toISOString().slice(0,10), note:'', method:'Cash', receiptNo:'-'}] : []);
    
    const arrEl = document.getElementById('fArrearsRow');
    if (arrEl) {
      const arrears = existing.arrears || 0;
      arrEl.dataset.arrears = arrears;
      if (arrears > 0) { 
        arrEl.style.display = 'block'; 
        document.getElementById('fArrearsAmt').textContent = fmt(arrears); 
      } else {
        arrEl.style.display = 'none';
      }
    }
    document.getElementById('feeExistingWarning').style.display = 'block';
  } else {
    document.getElementById('fEditId').value = '';
    _feePaymentDraft = [];
    
    // Calculate arrears from PRIOR terms only
    const arrears = getArrearsForPupil(p.id, name, term);
    const arrEl = document.getElementById('fArrearsRow');
    if (arrEl) {
      arrEl.dataset.arrears = arrears;
      if (arrears > 0) { 
        arrEl.style.display = 'block'; 
        document.getElementById('fArrearsAmt').textContent = fmt(arrears); 
      } else {
        arrEl.style.display = 'none';
      }
    }
    document.getElementById('feeExistingWarning').style.display = 'none';
  }
  
  renderPaymentLogInModal();
}

// FIXED: Save fee record with proper validation
function saveFee() {
  const student = document.getElementById('fStudentName').value.trim();
  const cls     = document.getElementById('fClass').value || '';
  const term    = document.getElementById('fTerm')?.value || state.settings.term || '';
  const year    = state.settings.session || '';
  const editId  = document.getElementById('fEditId').value;
  const selId   = parseInt(document.getElementById('fStudentSelect')?.value) || null;
  const arrears = parseFloat(document.getElementById('fArrearsRow')?.dataset?.arrears || 0);

  // Must have a pupil selected so we always have a reliable numeric studentId
  if (!selId || !student) { 
    showToast('⚠️ Please select a pupil from the dropdown.'); 
    return; 
  }

  // Verify pupil exists
  const pupil = state.students.find(s => s.id === selId);
  if (!pupil) {
    showToast('⚠️ Selected pupil not found.');
    return;
  }

  // Derive due from fee structure; allow manual entry only when no structure is set
  const structAmt = getFeeFromStructure(cls, term, year);
  const fDueEl    = document.getElementById('fDue');
  const manualAmt = fDueEl ? parseFloat(fDueEl.value) || 0 : 0;
  const due       = (structAmt !== null && structAmt > 0) ? structAmt : manualAmt;
  
  if (due <= 0) { 
    showToast('⚠️ Fee amount is zero. Set the Fee Structure for this class first, or enter the amount manually.'); 
    return; 
  }

  const totalPaid = _feePaymentDraft.reduce((a, p) => a + (p.amt || 0), 0);
  const totalDue  = due + arrears;

  if (editId) {
    const f = state.fees.find(f => f.id === parseInt(editId));
    if (f) {
      // Update existing record - preserve studentId
      f.studentId = selId;
      f.student   = student;
      f.cls       = cls;
      f.due       = due;
      f.arrears   = arrears;
      f.term      = term;
      f.year      = year;
      f.payments  = [..._feePaymentDraft];
      f.paid      = f.payments.reduce((a, p) => a + (p.amt || 0), 0);
      f.updatedBy = state.currentUser?.name || 'System';
      f.updatedAt = new Date().toISOString();
    }
    showToast(`✅ Fee record updated for ${student}!`);
  } else {
    // Create new fee record
    state.fees.push({
      id:        state.nextFeeId++,
      studentId: selId,
      student,                      // display name (kept for legacy read compatibility)
      cls, due, arrears,
      payments:  [..._feePaymentDraft],
      paid:      totalPaid,
      term, year,
      createdAt: new Date().toISOString(),
      createdBy: state.currentUser?.name || 'System'
    });
    showToast(`✅ Fee recorded for ${student}!`);
  }

  // Update pupil's fee status cache
  pupil.feeStatus = getStatus(totalDue, totalPaid);

  renderFees(); 
  renderStudents();
  document.getElementById('printReceiptBtn').style.display = 'inline-flex';
  updateFeeStats(); 
  updateDashStats(); 
  autosave();
  
  // Close modal
  document.getElementById('feeModal').classList.remove('open');
}

// FIXED: Render fees table with proper student linking
function renderFees(filter='', statusF='') {
  const tbody = document.getElementById('feesTbody');
  if (!tbody) return;
  
  let data = state.fees || [];
  
  // Filter by search term
  if (filter) {
    data = data.filter(f => {
      // Try to get pupil name via studentId first
      if (f.studentId) {
        const pupil = state.students.find(s => s.id === f.studentId);
        if (pupil) {
          const name = `${pupil.first} ${pupil.last}`.toLowerCase();
          if (name.includes(filter.toLowerCase())) return true;
        }
      }
      // Fallback to stored student name
      return f.student && f.student.toLowerCase().includes(filter.toLowerCase());
    });
  }
  
  // Filter by status
  if (statusF) {
    data = data.filter(f => {
      const td = totalDueForRecord(f);
      const tp = totalPaidForRecord(f);
      return getStatus(td, tp) === statusF;
    });
  }
  
  if (!data.length) { 
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-light);padding:28px;">No records. Pupils are auto-linked when enrolled.</td></tr>`; 
    return; 
  }
  
  tbody.innerHTML = data.map((f, i) => {
    // Find pupil by studentId first (reliable)
    const pupil = f.studentId ? state.students.find(s => s.id === f.studentId) : null;
    
    // Fallback to name match for legacy records
    const name = pupil ? `${pupil.first} ${pupil.last}` : (f.student || 'Unknown');
    const cls = pupil ? pupil.cls : (f.cls || '-');
    
    const td = getDueForRecord(f) + (f.arrears || 0);
    const paid = totalPaidForRecord(f);
    const bal = td - paid;
    const status = getStatus(td, paid);
    
    const photo = pupil && pupil.photo
      ? `<img src="${pupil.photo}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;margin-right:7px;vertical-align:middle;"/>`
      : `<span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;background:var(--blue-light);color:var(--blue);font-size:11px;font-weight:700;margin-right:7px;">${name.charAt(0)}</span>`;
    
    const pendingSetup = td === 0 ? '<span style="font-size:10px;color:var(--yellow);display:block;">⚠ Fee not set</span>' : '';
    const arrearsBadge = (f.arrears || 0) > 0 ? `<span style="font-size:10px;background:#fff7e0;color:#92400e;border:1px solid #fbbf24;border-radius:4px;padding:1px 5px;display:block;margin-top:2px;">Arr: ${fmt(f.arrears)}</span>` : '';
    const termBadge = f.term ? `<span style="font-size:10px;color:var(--text-muted);">${f.term}</span>` : '';
    
    const payCount = (f.payments || []).length;
    const lastPay = payCount ? f.payments[payCount - 1] : null;
    const payBadge = payCount > 0
      ? `<span style="font-size:10px;color:var(--blue);">${payCount} payment${payCount !== 1 ? 's' : ''}</span>${lastPay && lastPay.receiptNo ? `<span style="font-size:9px;color:var(--text-muted);display:block;">${lastPay.receiptNo}</span>` : ''}`
      : '';
    
    return `<tr>
      <td>${i + 1}</td>
      <td><div style="display:flex;align-items:center;">${photo}<div><strong>${name}</strong>${pendingSetup}</div></div></td>
      <td><div style="display:flex;flex-direction:column;gap:2px;"><span class="status-pill" style="background:var(--blue-light);color:var(--blue);font-size:11px;">${cls}</span>${termBadge}</div></td>
      <td><div>${fmt(td)}</div>${arrearsBadge}</td>
      <td style="color:var(--green);font-weight:600;">${fmt(paid)}<div>${payBadge}</div></td>
      <td style="color:${bal > 0 ? 'var(--red)' : 'var(--green)'};font-weight:600;">${fmt(bal)}</td>
      <td>${statusPill(status)}</td>
      <td>
        <button class="tbl-btn" onclick="editFeeRecord(${f.id})" title="Edit"><i class="fas fa-edit"></i></button>
        <button class="tbl-btn" onclick="viewPaymentHistory(${f.id})" title="Payment History"><i class="fas fa-list-ul"></i></button>
        <button class="tbl-btn" onclick="quickPrintFeeReceipt(${f.id})" title="Print Receipt"><i class="fas fa-receipt"></i></button>
        <button class="tbl-btn danger" onclick="deleteFee(${f.id})" title="Delete"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`;
  }).join('');
  
  updateFeeStats();
}

// FIXED: Update fee statistics
function updateFeeStats() {
  const paid = state.fees.filter(f => {
    const td = totalDueForRecord(f);
    const tp = totalPaidForRecord(f);
    return getStatus(td, tp) === 'Paid';
  }).length;
  
  const unpaid = state.fees.filter(f => {
    const td = totalDueForRecord(f);
    const tp = totalPaidForRecord(f);
    return getStatus(td, tp) !== 'Paid';
  }).length;
  
  const totalC = state.fees.reduce((a, f) => a + totalPaidForRecord(f), 0);
  const totalP = state.fees.reduce((a, f) => a + Math.max(0, totalDueForRecord(f) - totalPaidForRecord(f)), 0);
  
  const paidEl = document.getElementById('feePaidCount');
  const unpaidEl = document.getElementById('feeUnpaidCount');
  const totalCollectedEl = document.getElementById('totalCollectedFee');
  const totalPendingEl = document.getElementById('totalPendingFee');
  
  if (paidEl) paidEl.textContent = paid;
  if (unpaidEl) unpaidEl.textContent = unpaid;
  if (totalCollectedEl) totalCollectedEl.textContent = fmt(totalC);
  if (totalPendingEl) totalPendingEl.textContent = fmt(totalP);
  
  updateDashStats();
}

// FIXED: Validate all fee records have valid studentId
function validateFeeRecords() {
  let fixed = 0;
  state.fees.forEach(f => {
    // If no studentId, try to find by name
    if (!f.studentId && f.student) {
      const pupil = state.students.find(s => 
        `${s.first} ${s.last}`.toLowerCase() === f.student.toLowerCase()
      );
      if (pupil) {
        f.studentId = pupil.id;
        fixed++;
      }
    }
    
    // If studentId exists but pupil not found, mark for review
    if (f.studentId && !state.students.find(s => s.id === f.studentId)) {
      console.warn('Fee record references missing pupil:', f);
      // Optionally set to null so it falls back to name
      f.studentId = null;
    }
  });
  
  if (fixed > 0) {
    autosave();
    console.log(`[validate] Fixed ${fixed} fee records with missing studentId`);
  }
}

// FIXED: Auto-create fee record for new pupil
function autoCreateFeeRecord(pupil) {
  if (!pupil || !pupil.id) return;
  
  const name = `${pupil.first} ${pupil.last}`;
  const academicYear = state.settings.session || new Date().getFullYear() + '/' + (new Date().getFullYear() + 1);
  const term = state.settings.term || 'First Term';
  
  // Check if fee record already exists for this student + term
  const existing = state.fees.find(f => 
    f.studentId === pupil.id && 
    f.term === term && 
    (f.year === academicYear || !f.year)
  );
  
  if (!existing) {
    state.fees.push({
      id:          state.nextFeeId++,
      student:     name,
      cls:         pupil.cls,
      studentId:   pupil.id,
      studentUID:  pupil.uid || null,
      term,
      year:        academicYear,
      due:         0,
      paid:        0,
      payments:    [],
      arrears:     0,
      createdAt:   new Date().toISOString(),
      createdBy:   state.currentUser?.name || 'System'
    });
  }
}

// FIXED: Back-fill missing studentId on old fee records
function backfillFeeStudentIds() {
  if (!state.fees || !state.students) return;
  
  let fixed = 0;
  state.fees.forEach(f => {
    if (f.studentId) return; // already has ID
    
    // Try to find pupil by exact name match
    const match = state.students.find(s => 
      `${s.first} ${s.last}`.toLowerCase().trim() === (f.student || '').toLowerCase().trim() &&
      (!f.cls || s.cls === f.cls)
    );
    
    if (match) { 
      f.studentId = match.id; 
      fixed++; 
    }
  });
  
  if (fixed > 0) { 
    autosave(); 
    console.log('[backfill] stamped studentId on ' + fixed + ' fee record(s)'); 
  }
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

// ════════════════════════════════════════
// LOGIN
// ════════════════════════════════════════
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
    // Primary: check state.users (may be Firebase-loaded)
    let user = state.users.find(u =>
      u.username && u.username.toLowerCase().trim() === username &&
      u.password && u.password.trim() === password &&
      u.active !== false
    );
    // Fallback: if Firebase overwrote state.users with stale data, try localStorage copy
    if (!user) {
      try {
        const localRaw = localStorage.getItem(schoolKey);
        if (localRaw) {
          const localData = JSON.parse(localRaw);
          if (localData.users && localData.users.length) {
            user = localData.users.find(u =>
              u.username && u.username.toLowerCase().trim() === username &&
              u.password && u.password.trim() === password &&
              u.active !== false
            );
            // If local login works, restore local users to state (Firebase was stale)
            if (user) {
              state.users = localData.users;
              console.log('[login] Firebase users stale - restored from localStorage');
            }
          }
        }
      } catch(e) {}
    }
    if (!user) {
      recordLoginFail(schoolId);
      const tries = _loginAttempts[schoolId]?.count || 0;
      const left = LOGIN_MAX_TRIES - tries;
      // Show hint: list usernames from local storage so admin isn't locked out
      let hint = '';
      try {
        const localRaw = localStorage.getItem(schoolKey);
        if (localRaw) {
          const localData = JSON.parse(localRaw);
          if (localData.users && localData.users.length) {
            const names = localData.users.map(u => u.username).join(', ');
            hint = '\nHint: Known usernames: ' + names;
          }
        }
      } catch(e) {}
      document.getElementById('loginErrorMsg').textContent = (left <= 0
        ? 'Too many failed attempts. Wait 30 seconds.'
        : 'Wrong username or password. ' + left + ' attempt' + (left!==1?'s':'') + ' left.') + hint;
      document.getElementById('loginError').style.display = 'block';
      resetBtn(); return;
    }
    resetLoginAttempts(schoolId);
    _currentSchoolKey = schoolKey;
    state.currentUser = user;
    // Record last login time
    user.lastLogin = new Date().toISOString();
    autosave();
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
    // Suppress renders from triggering autosave during startup - we do a single
    // controlled saveToDB after Firebase data is loaded if needed.
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
    // Start realtime sync AFTER data is loaded and rendered - not before
    startRealtimeSync(schoolId);
    // FIX BUG 2: Ensure _fbPauseOutgoing is cleared after login
    _fbPauseOutgoing = false;
    // The savedAt > _fbKnownSavedAt guard in saveToDB() is the correct
    // protection against premature pushes - no startup timeout needed.
    showToast('Welcome back, ' + user.name + ' - ' + state.settings.schoolName);
  };
  if (window._fbReady && _isOnline) {
    loadSchoolData(schoolKey);
    let done = false;
    const timer = setTimeout(() => { if (!done) { done=true; proceed(); } }, 6000);
    loadSchoolDataFromFirebase(schoolId)
      .then(() => { if (!done) { done=true; clearTimeout(timer); proceed(); } })
      .catch(() => { if (!done) { done=true; clearTimeout(timer); proceed(); } });
  } else {
    loadSchoolData(schoolKey);
    proceed();
  }
}

// ── UNSAVED CHANGES TRACKING ──
let _unsavedChanges = false;
let _saveTimer = null;

function markUnsaved() {
  _unsavedChanges = true;
  const ind = document.getElementById('autosaveIndicator');
  if (ind) { ind.textContent = '⏳ Saving...'; ind.style.opacity='1'; ind.style.color='var(--yellow)'; }
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
    // markSaved() is called inside saveToDB's Firebase .then() callback
    // so the "All saved" indicator only shows after cloud confirmation.
    // For offline mode we still mark saved immediately since there's no cloud to wait for.
    if (!window._fbReady || !_isOnline) markSaved();
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
  // Warn on refresh / close - always try to save first
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

// ── LOGOUT ──
function doLogout() {
  saveNow();
  stopRealtimeSync();
  state.currentUser = null;
  _currentSchoolKey = null;
  _unsavedChanges   = false;
  _fbDataLoaded     = false;
  _fbKnownSavedAt   = 0;
  _fbPauseIncoming  = false;
  _fbPauseOutgoing  = false; // FIX BUG 2: Always reset outgoing pause on logout
  const portal = document.getElementById('studentPortal');
  if (portal) portal.style.display = 'none';
  showSchoolSelector();
}

// ── UTILS ──
function fmt(n) { return 'GH₵' + Number(n).toLocaleString('en-GH', {minimumFractionDigits:2, maximumFractionDigits:2}); }
function statusPill(s) {
  const m = { Paid:'pill-paid', Partial:'pill-partial', Unpaid:'pill-unpaid' };
  return `<span class="status-pill ${m[s]||''}">${s}</span>`;
}
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function showToast(msg, dur=3200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), dur);
}

// ════════════════════════════════════════
// PAYMENT LEDGER HELPERS
// ════════════════════════════════════════

// Global state.payments[] - every payment gets its own record.
function recordPayment(studentId, term, year, amount, meta) {
  if (!state.payments) state.payments = [];
  // Look up the permanent UID for cross-referencing
  const pupil = state.students.find(s => s.id === studentId);
  const entry = {
    id:         'PMT-' + Date.now() + '-' + Math.floor(Math.random()*1000),
    studentId,
    studentUID: pupil?.uid || null,      // permanent ID - survives name changes
    term,
    year:       year || state.settings.session || '',
    amount,
    date:       meta?.date    || new Date().toISOString().slice(0, 10),
    method:     meta?.method  || 'Cash',
    note:       meta?.note    || '',
    receiptNo:  meta?.receiptNo || '',
    rcvdBy:     meta?.rcvdBy  || (state.currentUser?.name || 'Admin'),
    addedAt:    new Date().toISOString(),
    createdBy:  state.currentUser?.name || 'System',
  };
  state.payments.push(entry);
  return entry;
}

// Migrate legacy f.payments[] into global state.payments[] (runs once on load)
function migratePaymentsToGlobalLedger() {
  if (!state.payments) state.payments = [];
  if (!state.fees) return;
  let migrated = 0;
  state.fees.forEach(f => {
    if (!f.payments || !f.payments.length) return;
    f.payments.forEach(p => {
      // Only migrate if not already in global ledger (check by receiptNo or addedAt)
      const alreadyIn = state.payments.some(gp =>
        gp.receiptNo && gp.receiptNo === p.receiptNo ||
        gp.addedAt   && gp.addedAt   === p.addedAt
      );
      if (!alreadyIn && f.studentId) {
        state.payments.push({
          id:        'PMT-MIG-' + Date.now() + '-' + migrated,
          studentId: f.studentId,
          term:      f.term, year: f.year || state.settings.session || '',
          amount:    p.amt || 0,
          date:      p.date || f.createdAt?.slice(0,10) || '',
          method:    p.method || 'Cash',
          note:      p.note || '',
          receiptNo: p.receiptNo || '',
          rcvdBy:    p.rcvdBy || 'Admin',
          addedAt:   p.addedAt || new Date().toISOString()
        });
        migrated++;
      }
    });
  });
  if (migrated > 0) { autosave(); console.log('[migrate] moved ' + migrated + ' payments to global ledger'); }
}

// ════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  // Migrate any legacy single-school data first
  migrateLegacyData();

  // Initialize fee system with validation
  validateFeeRecords();

  // Helper: only call if the function exists (safe for partial builds)
  const tryInit = fn => { if (typeof fn === 'function') fn(); };

  // Init all UI modules (they render when school data loads after login)
  tryInit(initLogin);
  tryInit(initNav);
  tryInit(initSidebar);
  tryInit(initDate);
  tryInit(initReportGenerator);
  tryInit(initStudents);
  tryInit(initStudentPhotoUpload);
  tryInit(initReportSection);
  tryInit(initFees);
  tryInit(initGallery);
  tryInit(initWeekly);
  tryInit(initAttendance);
  tryInit(initPromotion);
  tryInit(initSMS);
  tryInit(initIDCards);
  tryInit(initAdmissions);
  tryInit(initTeachers);
  tryInit(initClasses);
  tryInit(initResources);
  tryInit(initExams);
  tryInit(initTransfers);
  tryInit(initCommunication);
  tryInit(initExpenditure);
  tryInit(initSettings);
  tryInit(initLogo);
  tryInit(initBackup);
  tryInit(initGlobalSearch);
  tryInit(initPageLeaveProtection);
  tryInit(initTheme);

  // Start at the school selector (no auto-login)
  if (typeof showSchoolSelector === 'function') showSchoolSelector();

  // NOTE: Do NOT show logoutBtn here — it must only appear after a successful
  // login (showApp handles this). Showing it on startup was a bug.
});
/* ════════════════════════════════════════
   UI LAYER — Screen Management, Navigation,
   Settings, Theme, Backup, Fee UI helpers,
   Super Admin Panel, and section stubs.
════════════════════════════════════════ */

// ════════════════════════════════════════
// SCREEN MANAGEMENT
// ════════════════════════════════════════

function showSchoolSelector() {
  document.getElementById('schoolSelector').style.display = 'flex';
  document.getElementById('loginScreen').style.display    = 'none';
  document.getElementById('appWrapper').style.display     = 'none';
  const portal = document.getElementById('studentPortal');
  if (portal) portal.style.display = 'none';
  renderSchoolList();
  loadRegistryFromFirebase().then(() => renderSchoolList()).catch(() => {});
}

function showLoginScreen(schoolId, schoolName) {
  document.getElementById('schoolSelector').style.display = 'none';
  document.getElementById('loginScreen').style.display    = 'flex';
  document.getElementById('loginScreen').dataset.schoolId = schoolId;
  document.getElementById('loginSchoolName').textContent  = schoolName;
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').style.display = 'none';
  try {
    const rem = localStorage.getItem('edumanage_remembered_' + schoolId);
    if (rem) {
      const { username, password } = JSON.parse(rem);
      document.getElementById('loginUsername').value = username;
      document.getElementById('loginPassword').value = password;
      const rc = document.getElementById('rememberMeCheck');
      if (rc) rc.checked = true;
    }
  } catch(e) {}
  setTimeout(() => document.getElementById('loginUsername')?.focus(), 80);
}

function showApp() {
  document.getElementById('schoolSelector').style.display = 'none';
  document.getElementById('loginScreen').style.display    = 'none';
  document.getElementById('appWrapper').style.display     = '';
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) logoutBtn.style.display = 'inline-flex';
}

function renderSchoolList() {
  const container = document.getElementById('schoolListContainer');
  if (!container) return;
  const schools = getRegistry().filter(s => !s.deleted);

  if (!schools.length) {
    container.innerHTML = `
      <div style="text-align:center;padding:20px 0 8px;">
        <div style="font-size:36px;margin-bottom:8px;">🏫</div>
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:14px;">No schools registered yet.</p>
        <button class="btn-primary" onclick="document.getElementById('registerSchoolModal').classList.add('open')"
                style="width:100%;justify-content:center;">
          <i class="fas fa-plus"></i> Register Your School
        </button>
      </div>`;
    return;
  }

  container.innerHTML = schools.map(s => `
    <div onclick="showLoginScreen('${s.id}','${escHtml(s.name)}')"
         style="display:flex;align-items:center;gap:12px;padding:11px 14px;border:1px solid var(--border);
                border-radius:var(--radius-sm);margin-bottom:8px;cursor:pointer;background:var(--surface);transition:all .18s;"
         onmouseover="this.style.borderColor='var(--blue)';this.style.background='var(--blue-light)'"
         onmouseout="this.style.borderColor='var(--border)';this.style.background='var(--surface)'">
      <div style="width:38px;height:38px;border-radius:10px;background:var(--blue-light);
                  display:grid;place-items:center;color:var(--blue);font-size:16px;flex-shrink:0;">
        <i class="fas fa-graduation-cap"></i>
      </div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${escHtml(s.name)}</div>
        <div style="font-size:11px;color:var(--text-muted);">Click to sign in</div>
      </div>
      <i class="fas fa-chevron-right" style="color:var(--text-light);font-size:12px;"></i>
    </div>`).join('') + `
    <button class="btn-primary"
            onclick="document.getElementById('registerSchoolModal').classList.add('open')"
            style="width:100%;justify-content:center;margin-top:4px;">
      <i class="fas fa-plus"></i> Register New School
    </button>`;
}

// ════════════════════════════════════════
// NAVIGATION & SIDEBAR
// ════════════════════════════════════════

function initNav() {
  document.querySelectorAll('.nav-item[data-section]').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      navigateTo(link.dataset.section);
      if (window.innerWidth < 900) {
        document.getElementById('sidebar')?.classList.remove('open');
        document.getElementById('overlay')?.classList.remove('show');
      }
    });
  });
}

function navigateTo(section) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navLink = document.querySelector(`.nav-item[data-section="${section}"]`);
  if (navLink) navLink.classList.add('active');
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  const sec = document.getElementById('sec-' + section);
  if (sec) sec.classList.add('active');
  const labels = {
    dashboard:'Dashboard', admissions:'Admissions', students:'Pupils',
    reports:'Academic Reports', fees:'School Fees', gallery:'Gallery',
    expenditure:'Expenditure', weekly:'Weekly Output', attendance:'Attendance',
    idcards:'ID Cards', promotion:'Promotion', sms:'SMS Reminders',
    teachers:'Teachers', classes:'Classes', resources:'Resources Library',
    exams:'Examinations', transfers:'Transfers & Withdrawal',
    communication:'Communication Centre', users:'User Management',
    settings:'Settings', backup:'Backup & Drive'
  };
  const bc = document.getElementById('breadcrumb');
  if (bc) bc.textContent = labels[section] || section;
  // Refresh on navigate
  if (section === 'dashboard')   updateDashStats();
  if (section === 'fees')        { if(typeof renderFees==='function') renderFees(); updateFeeStats(); }
  if (section === 'students')    renderStudents();
  if (section === 'teachers')    renderTeachers();
  if (section === 'classes')     renderClasses();
  if (section === 'reports')     renderSavedReports();
  if (section === 'gallery')     renderGallery();
  if (section === 'weekly')      renderWeekly();
  if (section === 'attendance')  renderAttendance();
  if (section === 'users')       renderUsers();
  if (section === 'backup')      { renderBackupHistory(); updateBackupInfo(); }
  if (section === 'admissions')  typeof renderAdmissions==='function'   && renderAdmissions();
  if (section === 'idcards')     typeof renderIDCards==='function'       && renderIDCards();
  if (section === 'sms')         typeof generateSMSReminders==='function'&& generateSMSReminders();
  if (section === 'resources')   typeof renderResources==='function'     && renderResources();
  if (section === 'exams')       typeof renderExams==='function'         && renderExams();
  if (section === 'transfers')   typeof renderTransfers==='function'     && renderTransfers();
  if (section === 'communication') { typeof renderAnnouncements==='function'&&renderAnnouncements(); }
  if (section === 'expenditure') typeof renderExpenditures==='function'  && renderExpenditures();
  if (section === 'settings')    { renderThemeSwatches(); populateSettingsForm(); }
}

function initSidebar() {
  const menuToggle = document.getElementById('menuToggle');
  const overlay    = document.getElementById('overlay');
  const sidebar    = document.getElementById('sidebar');
  menuToggle?.addEventListener('click', () => {
    sidebar?.classList.toggle('open');
    overlay?.classList.toggle('show');
  });
  overlay?.addEventListener('click', () => {
    sidebar?.classList.remove('open');
    overlay?.classList.remove('show');
  });
}

function initDate() {
  const el = document.getElementById('headerDate');
  if (!el) return;
  el.textContent = new Date().toLocaleDateString('en-GH',
    { weekday:'long', year:'numeric', month:'long', day:'numeric' });
}

function applyRoleNav(user) {
  if (!user) return;
  const role = user.role || 'Admin';
  if (role === 'Student') {
    document.getElementById('appWrapper').style.display = 'none';
    const portal = document.getElementById('studentPortal');
    if (portal) {
      portal.style.display = 'block';
      const pn = document.getElementById('portalSchoolName');
      if (pn) pn.textContent = state.settings.schoolName || 'EduManage Pro';
      const pu = document.getElementById('portalUserName');
      if (pu) pu.textContent = user.name;
    }
    return;
  }
  if (role === 'Teacher') {
    ['users','backup'].forEach(sec => {
      const link = document.querySelector(`.nav-item[data-section="${sec}"]`);
      if (link) link.style.display = 'none';
    });
  }
  const pinGroup = document.getElementById('masterPinSettingGroup');
  if (pinGroup) pinGroup.style.display = role === 'Admin' ? 'block' : 'none';
}

// ════════════════════════════════════════
// LOGIN EVENT WIRING
// ════════════════════════════════════════

function initLogin() {
  document.getElementById('loginBtn')?.addEventListener('click', attemptLogin);
  ['loginUsername','loginPassword'].forEach(id =>
    document.getElementById(id)?.addEventListener('keydown', e => { if(e.key==='Enter') attemptLogin(); }));
  document.getElementById('backToSchoolsBtn')?.addEventListener('click', showSchoolSelector);
  // Password toggle on login screen
  document.getElementById('toggleLoginPwd')?.addEventListener('click', function() {
    togglePwdField('loginPassword', this);
  });
  // New-school password toggle
  document.getElementById('toggleNewSchoolPwd')?.addEventListener('click', function() {
    togglePwdField('newSchoolPassword', this);
  });
  // Register modal
  document.getElementById('closeRegisterModal')?.addEventListener('click',  () => document.getElementById('registerSchoolModal').classList.remove('open'));
  document.getElementById('cancelRegisterModal')?.addEventListener('click', () => document.getElementById('registerSchoolModal').classList.remove('open'));
  document.getElementById('confirmRegisterBtn')?.addEventListener('click',  submitSchoolRegistration);
  // Super admin
  document.getElementById('superAdminBtn')?.addEventListener('click', () => document.getElementById('superAdminPanelModal').classList.add('open'));
  // Restore
  document.getElementById('restoreSchoolBtn')?.addEventListener('click', () => {
    document.getElementById('restoreSchoolModal').classList.add('open');
    renderArchivedSchools();
  });
  // Change password modal
  document.getElementById('changePasswordBtn')?.addEventListener('click', openChangePwdModal);
  document.getElementById('closeChangePwdModal')?.addEventListener('click',  () => document.getElementById('changePasswordModal').classList.remove('open'));
  document.getElementById('cancelChangePwdModal')?.addEventListener('click', () => document.getElementById('changePasswordModal').classList.remove('open'));
  document.getElementById('saveNewPasswordBtn')?.addEventListener('click', saveNewPassword);
}

// ════════════════════════════════════════
// CHANGE PASSWORD
// ════════════════════════════════════════

function openChangePwdModal() {
  if (!state.currentUser) return;
  const el = document.getElementById('changePwdUsername');
  if (el) el.textContent = state.currentUser.username;
  ['cpCurrentPwd','cpNewPwd','cpConfirmPwd'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const errEl = document.getElementById('cpError');
  if (errEl) errEl.style.display = 'none';
  document.getElementById('changePasswordModal').classList.add('open');
}

function saveNewPassword() {
  const current = document.getElementById('cpCurrentPwd')?.value.trim();
  const newPwd  = document.getElementById('cpNewPwd')?.value.trim();
  const confirm = document.getElementById('cpConfirmPwd')?.value.trim();
  const errEl   = document.getElementById('cpError');
  const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };
  if (errEl) errEl.style.display = 'none';
  if (!current || !newPwd || !confirm) { showErr('All fields are required.'); return; }
  if (current !== state.currentUser?.password) { showErr('Current password is incorrect.'); return; }
  if (newPwd.length < 6)  { showErr('New password must be at least 6 characters.'); return; }
  if (newPwd !== confirm) { showErr('Passwords do not match.'); return; }
  const userInList = state.users.find(u => u.id === state.currentUser.id);
  if (userInList) userInList.password = newPwd;
  state.currentUser.password = newPwd;
  autosave();
  document.getElementById('changePasswordModal').classList.remove('open');
  showToast('✅ Password changed successfully!');
}

// ════════════════════════════════════════
// THEME & APPEARANCE
// ════════════════════════════════════════

const THEMES = [
  { id:'default', name:'GES Blue',     blue:'#1a6fd4', dark:'#1255a8' },
  { id:'green',   name:'Forest Green', blue:'#16a34a', dark:'#15803d' },
  { id:'teal',    name:'Ocean Teal',   blue:'#0891b2', dark:'#0e7490' },
  { id:'purple',  name:'Royal Purple', blue:'#7c3aed', dark:'#6d28d9' },
  { id:'red',     name:'Crimson',      blue:'#dc2626', dark:'#b91c1c' },
  { id:'dark',    name:'Midnight',     blue:'#334155', dark:'#1e293b' },
];

function initTheme() {
  applyTheme(state.appTheme || 'default');
  applySidebarStyle(state.sidebarStyle || 'dark');
  applyFontSize(state.fontSize || '15');
}

function applyTheme(themeId) {
  state.appTheme = themeId;
  const t = THEMES.find(x => x.id === themeId) || THEMES[0];
  const root = document.documentElement;
  root.style.setProperty('--blue', t.blue);
  root.style.setProperty('--blue-dark', t.dark);
  const r = parseInt(t.blue.slice(1,3),16), g = parseInt(t.blue.slice(3,5),16), b = parseInt(t.blue.slice(5,7),16);
  root.style.setProperty('--blue-light', `rgba(${r},${g},${b},0.12)`);
}

function applySidebarStyle(style) {
  state.sidebarStyle = style;
  const sb = document.getElementById('sidebar');
  if (!sb) return;
  const styles = { dark:'#0f2a5e', light:'#ffffff', gradient:'linear-gradient(160deg,#0f2a5e 0%,#1a6fd4 100%)' };
  sb.style.background = styles[style] || styles.dark;
  if (style === 'light') {
    sb.querySelectorAll('.nav-item,.nav-label,.brand-name,.user-name,.brand-pro').forEach(el => el.style.color = '#1a2133');
  } else {
    sb.querySelectorAll('.nav-item,.brand-name,.user-name').forEach(el => el.style.color = '');
    sb.querySelectorAll('.nav-label').forEach(el => el.style.color = '');
  }
}

function applyFontSize(size) {
  state.fontSize = size;
  document.documentElement.style.fontSize = parseInt(size) + 'px';
}

function renderThemeSwatches() {
  const grid = document.getElementById('themeSwatchGrid');
  if (!grid) return;
  const cur = state.appTheme || 'default';
  grid.innerHTML = THEMES.map(t => `
    <div data-theme="${t.id}" onclick="applyTheme('${t.id}');autosave();"
         style="border-radius:10px;padding:10px 8px;cursor:pointer;border:2px solid ${cur===t.id?t.blue:'var(--border)'};
                text-align:center;transition:all .2s;"
         onmouseover="this.style.borderColor='${t.blue}'"
         onmouseout="this.style.borderColor='${cur===t.id?t.blue:'var(--border)'}'">
      <div style="width:32px;height:32px;border-radius:8px;background:${t.blue};margin:0 auto 6px;"></div>
      <div style="font-size:11px;font-weight:600;color:var(--text-muted);">${t.name}</div>
    </div>`).join('');
  const ss = document.getElementById('sidebarStyleSelect'); if(ss) ss.value = state.sidebarStyle||'dark';
  const fs = document.getElementById('fontSizeSelect');     if(fs) fs.value = state.fontSize||'15';
}

// ════════════════════════════════════════
// LOGO
// ════════════════════════════════════════

function initLogo() {
  document.getElementById('logoFileInput')?.addEventListener('change', function() {
    const file = this.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = e => { state.schoolLogo = e.target.result; applyLogo(e.target.result); autosave(); showToast('✅ Logo uploaded!'); };
    reader.readAsDataURL(file);
  });
  document.getElementById('removeLogoBtn')?.addEventListener('click', () => {
    state.schoolLogo = null; applyLogo(null); autosave(); showToast('Logo removed.');
  });
}

function applyLogo(src) {
  // Sidebar
  const brandIcon = document.getElementById('brandIconDefault');
  const logoImg   = document.getElementById('sidebarLogoImg');
  if (src) {
    if (brandIcon) brandIcon.style.display = 'none';
    if (logoImg)   { logoImg.src = src; logoImg.style.display = 'block'; }
  } else {
    if (brandIcon) brandIcon.style.display = '';
    if (logoImg)   logoImg.style.display = 'none';
  }
  // Topbar
  const hw = document.getElementById('headerLogoWrap');
  const hi = document.getElementById('headerLogoImg');
  if (src) { if(hi) hi.src=src; if(hw) hw.style.display='block'; }
  else     { if(hw) hw.style.display='none'; }
  // Settings preview
  const pi = document.getElementById('logoPreviewImg');
  const ph = document.getElementById('logoPlaceholder');
  const rb = document.getElementById('removeLogoBtn');
  if (src) { if(pi){ pi.src=src; pi.style.display='block'; } if(ph) ph.style.display='none'; if(rb) rb.style.display='block'; }
  else     { if(pi) pi.style.display='none'; if(ph) ph.style.display=''; if(rb) rb.style.display='none'; }
}

// ════════════════════════════════════════
// SETTINGS
// ════════════════════════════════════════

function initSettings() {
  document.getElementById('saveSettingsBtn')?.addEventListener('click', saveSettings);
  document.getElementById('sidebarStyleSelect')?.addEventListener('change', function() {
    applySidebarStyle(this.value); autosave();
  });
  document.getElementById('fontSizeSelect')?.addEventListener('change', function() {
    applyFontSize(this.value); autosave();
  });
}

function populateSettingsForm() {
  const s = state.settings;
  const sv = (id, val) => { const el=document.getElementById(id); if(el&&val!==undefined) el.value=val; };
  sv('schoolName', s.schoolName); sv('sessionYear', s.session); sv('schoolAddress', s.address);
  sv('principalName', s.principal); sv('gesDistrict', s.district); sv('schoolMotto', s.motto);
  if (document.getElementById('currentTerm')) document.getElementById('currentTerm').value = s.term||'First Term';
}

function saveSettings() {
  const g = id => document.getElementById(id)?.value?.trim() || '';
  state.settings.schoolName = g('schoolName');
  state.settings.session    = g('sessionYear');
  state.settings.address    = g('schoolAddress');
  state.settings.principal  = g('principalName');
  state.settings.district   = g('gesDistrict');
  state.settings.motto      = g('schoolMotto');
  state.settings.term       = document.getElementById('currentTerm')?.value || state.settings.term;
  const snEl = document.getElementById('sidebarSchoolName');
  if (snEl) snEl.textContent = state.settings.schoolName;
  autosave();
  const msg = document.getElementById('settingsSaved');
  if (msg) { msg.style.display='flex'; setTimeout(()=>msg.style.display='none', 2500); }
  showToast('✅ Settings saved!');
}

function changeMasterPin() {
  const input = document.getElementById('masterPinSetting');
  if (!input) return;
  const newPin = input.value.trim();
  if (!newPin || newPin.length < 4) { showToast('⚠️ PIN must be at least 4 characters.'); return; }
  localStorage.setItem('edumanage_super_admin_code', newPin);
  input.value = '';
  showToast('✅ Master PIN updated!');
}

// ════════════════════════════════════════
// DASHBOARD STATS
// ════════════════════════════════════════

function updateDashStats() {
  const set = (id, val) => { const el=document.getElementById(id); if(el) el.textContent=val; };
  const totalS  = state.students.length;
  const males   = state.students.filter(s => (s.gender||'').toLowerCase()==='male').length;
  const females = totalS - males;
  set('totalStudents', totalS);
  set('dashMaleFemaleSplit', totalS ? `♂ ${males}  ♀ ${females}` : '—');
  set('totalTeachers', state.teachers.length);
  const totalC = state.fees.reduce((a,f) => a + totalPaidForRecord(f), 0);
  const totalP = state.fees.reduce((a,f) => a + Math.max(0, totalDueForRecord(f)-totalPaidForRecord(f)), 0);
  set('totalCollected', fmt(totalC));
  set('totalOutstanding', state.fees.filter(f => getStatus(totalDueForRecord(f),totalPaidForRecord(f))!=='Paid').length);
  const totalDue = state.fees.reduce((a,f) => a + totalDueForRecord(f), 0);
  set('feePctDash', totalDue > 0 ? Math.round(totalC/totalDue*100)+'% collected' : '');
  set('dashTotalClasses', state.classes.length);
  set('dashActiveClasses', state.classes.length + ' active');
  set('dashAttToday', '—');
  set('dashAttLabel', 'No data yet');
  const sumEl = document.getElementById('dashLiveSummary');
  if (sumEl) {
    const now = new Date();
    sumEl.innerHTML = `
      <div>📅 <strong>${now.toLocaleDateString('en-GH',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</strong></div>
      <div>🏫 <strong>${escHtml(state.settings.schoolName||'School')}</strong> · ${escHtml(state.settings.term||'')} ${escHtml(state.settings.session||'')}</div>
      <div>👩‍🎓 <strong>${totalS}</strong> pupils (${males} M, ${females} F)</div>
      <div>👩‍🏫 <strong>${state.teachers.length}</strong> teachers on staff</div>
      <div>💰 <strong>${fmt(totalC)}</strong> collected · <strong>${fmt(totalP)}</strong> pending</div>
      <div>📋 <strong>${state.reports.length}</strong> report cards generated</div>`;
  }
  const lr = document.getElementById('dashLastRefresh');
  if (lr) lr.textContent = new Date().toLocaleTimeString('en-GH',{hour:'2-digit',minute:'2-digit'});
  _renderFeeBars();
}

function _renderFeeBars() {
  const el = document.getElementById('feeBars'); if (!el) return;
  const classes = [...new Set(state.students.map(s=>s.cls))].filter(Boolean);
  if (!classes.length) { el.innerHTML='<p style="color:var(--text-muted);font-size:13px;text-align:center;padding:16px;">No classes yet.</p>'; return; }
  el.innerHTML = classes.map(cls => {
    const recs = state.fees.filter(f => { const p=state.students.find(s=>s.id===f.studentId); return p?p.cls===cls:f.cls===cls; });
    const tD = recs.reduce((a,f)=>a+totalDueForRecord(f),0);
    const tP = recs.reduce((a,f)=>a+totalPaidForRecord(f),0);
    const pct = tD>0?Math.round(tP/tD*100):0;
    const col = pct>=80?'var(--green)':pct>=40?'var(--yellow)':'var(--red)';
    return `<div style="margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:600;margin-bottom:4px;">
        <span>${escHtml(cls)}</span><span style="color:${col}">${pct}%</span></div>
      <div style="height:7px;background:var(--border);border-radius:10px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${col};border-radius:10px;transition:width .4s;"></div></div>
      <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${fmt(tP)} of ${fmt(tD)}</div>
    </div>`;
  }).join('');
}

// ════════════════════════════════════════
// PASSWORD TOGGLE
// ════════════════════════════════════════

function togglePwdField(inputId, btn) {
  const inp = document.getElementById(inputId); if (!inp) return;
  const isText = inp.type === 'text';
  inp.type = isText ? 'password' : 'text';
  const icon = btn?.querySelector('i');
  if (icon) icon.className = isText ? 'fas fa-eye' : 'fas fa-eye-slash';
}

// ════════════════════════════════════════
// PAYMENT LOG (fee modal)
// ════════════════════════════════════════

function addPaymentEntry() {
  const amt    = parseFloat(document.getElementById('fNewPayAmt')?.value)||0;
  const date   = document.getElementById('fNewPayDate')?.value||new Date().toISOString().slice(0,10);
  const method = document.getElementById('fNewPayMethod')?.value||'Cash';
  const note   = document.getElementById('fNewPayNote')?.value?.trim()||'';
  if (amt <= 0) { showToast('⚠️ Enter a valid payment amount.'); return; }
  const receiptNo = 'RCP-' + Date.now().toString().slice(-6);
  _feePaymentDraft.push({ amt, date, method, note, receiptNo, addedAt: new Date().toISOString() });
  if (document.getElementById('fNewPayAmt'))  document.getElementById('fNewPayAmt').value  = '';
  if (document.getElementById('fNewPayNote')) document.getElementById('fNewPayNote').value = '';
  renderPaymentLogInModal();
  showToast('✅ Payment entry added.');
}

function renderPaymentLogInModal() {
  const log = document.getElementById('fPaymentLog');
  const sum = document.getElementById('fPaySummary');
  if (!log) return;
  if (!_feePaymentDraft.length) {
    log.innerHTML = '<p style="text-align:center;color:var(--text-muted);font-size:12px;padding:10px 0;">No payments recorded yet.</p>';
    if (sum) sum.style.display = 'none'; return;
  }
  const totalPaid = _feePaymentDraft.reduce((a,p)=>a+(p.amt||0),0);
  const due    = parseFloat(document.getElementById('fDue')?.value)||0;
  const arr    = parseFloat(document.getElementById('fArrearsRow')?.dataset?.arrears||0);
  const totalDue = due + arr;
  const balance  = totalDue - totalPaid;
  log.innerHTML = _feePaymentDraft.map((p,i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg);border-radius:6px;margin-bottom:5px;">
      <div style="flex:1;">
        <div style="font-weight:700;font-size:13px;color:var(--green);">${fmt(p.amt)}</div>
        <div style="font-size:11px;color:var(--text-muted);">${p.date} · ${escHtml(p.method)}${p.note?' · '+escHtml(p.note):''}</div>
        <div style="font-size:10px;color:var(--text-light);">${p.receiptNo||''}</div>
      </div>
      <button onclick="removeDraftPayment(${i})" style="background:none;border:none;color:var(--red);cursor:pointer;padding:4px;font-size:13px;"><i class="fas fa-times"></i></button>
    </div>`).join('');
  if (sum) {
    sum.style.display='block';
    sum.innerHTML=`
      <div style="display:flex;justify-content:space-between;"><span>Total Due:</span><strong>${fmt(totalDue)}</strong></div>
      <div style="display:flex;justify-content:space-between;color:var(--green);"><span>Total Paid:</span><strong>${fmt(totalPaid)}</strong></div>
      <div style="display:flex;justify-content:space-between;color:${balance>0?'var(--red)':'var(--green)'};border-top:1px solid var(--border);margin-top:6px;padding-top:6px;">
        <span>Balance:</span><strong>${fmt(balance)}</strong></div>
      <div style="margin-top:4px;">${balance<=0?'<span style="color:var(--green);font-size:12px;">✅ Fully Paid</span>':balance<totalDue?'<span style="color:var(--yellow);font-size:12px;">⏳ Partial</span>':'<span style="color:var(--red);font-size:12px;">❌ Unpaid</span>'}</div>`;
  }
}

function removeDraftPayment(index) {
  _feePaymentDraft.splice(index, 1);
  renderPaymentLogInModal();
}

// ════════════════════════════════════════
// FEES UI (fee section init + structure table)
// ════════════════════════════════════════

function initFees() {
  document.getElementById('recordFeeBtn')?.addEventListener('click', () => {
    document.getElementById('fEditId').value = '';
    ['fStudentName','fClass'].forEach(id=>{ const e=document.getElementById(id); if(e) e.value=''; });
    document.getElementById('fStudentSelect').value='';
    document.getElementById('feeAutoFilledInfo').style.display='none';
    document.getElementById('feeExistingWarning').style.display='none';
    const arr=document.getElementById('fArrearsRow'); if(arr){arr.style.display='none';arr.dataset.arrears='0';}
    _feePaymentDraft=[]; renderPaymentLogInModal();
    populatePupilDropdown('fStudentSelect');
    document.getElementById('feeModal').classList.add('open');
  });
  document.getElementById('closeFeeModal')?.addEventListener('click',  ()=>document.getElementById('feeModal').classList.remove('open'));
  document.getElementById('cancelFeeModal')?.addEventListener('click', ()=>document.getElementById('feeModal').classList.remove('open'));
  document.getElementById('saveFeeBtn')?.addEventListener('click', saveFee);
  document.getElementById('feeSearch')?.addEventListener('input', function() {
    renderFees(this.value, document.getElementById('feeStatusFilter')?.value||'');
  });
  document.getElementById('feeStatusFilter')?.addEventListener('change', function() {
    renderFees(document.getElementById('feeSearch')?.value||'', this.value);
  });
  document.getElementById('fTerm')?.addEventListener('change', function() {
    const selId=document.getElementById('fStudentSelect')?.value;
    if(selId) autoFillFeeFromPupil(selId);
  });
  document.getElementById('feeStructureBtn')?.addEventListener('click', ()=>{
    document.getElementById('feeStructureModal').classList.add('open');
    renderFeeStructureTable();
  });
  document.getElementById('bulkFeeBtn')?.addEventListener('click', ()=>{
    populateClassDropdown('bulkFeeClass');
    document.getElementById('bulkFeeModal').classList.add('open');
  });
  document.getElementById('generateBillBtn')?.addEventListener('click', ()=>{
    document.getElementById('feeBillModal').classList.add('open');
  });
  document.getElementById('closeFeeBillModal')?.addEventListener('click',  ()=>document.getElementById('feeBillModal').classList.remove('open'));
  document.getElementById('cancelFeeBillModal')?.addEventListener('click', ()=>document.getElementById('feeBillModal').classList.remove('open'));
}

function renderFeeStructureTable() {
  const wrap = document.getElementById('feeStructureWrap'); if (!wrap) return;
  const year = state.settings.session||'';
  const yearLabel = document.getElementById('feeStructYearLabel');
  if (yearLabel) yearLabel.textContent = year;
  const CLASSES = ['Creche','Nursery 1','Nursery 2','KG1','KG2','BS.1','BS.2','BS.3','BS.4','BS.5','BS.7','BS.8','BS.9'];
  const TERMS   = ['First Term','Second Term','Third Term'];
  const fs = state.feeStructure||[];
  wrap.innerHTML = `<table class="data-table" style="width:100%;">
    <thead><tr><th>Class</th>${TERMS.map(t=>`<th>${t}</th>`).join('')}</tr></thead>
    <tbody>${CLASSES.map(cls=>`
      <tr><td><strong>${cls}</strong></td>
      ${TERMS.map(term=>{
        const e=fs.find(s=>s.cls===cls&&s.term===term&&(s.year===year||!s.year));
        return `<td><input type="number" class="form-input" style="max-width:120px;" placeholder="0.00" min="0"
          value="${e?e.amount:''}" onchange="updateFeeStructure('${cls}','${term}',this.value)"/></td>`;
      }).join('')}
      </tr>`).join('')}
    </tbody></table>`;
}

function updateFeeStructure(cls, term, value) {
  if (!state.feeStructure) state.feeStructure=[];
  const year=state.settings.session||''; const amt=parseFloat(value)||0;
  const idx=state.feeStructure.findIndex(s=>s.cls===cls&&s.term===term&&(s.year===year||!s.year));
  if(idx>=0){state.feeStructure[idx].amount=amt;state.feeStructure[idx].year=year;}
  else state.feeStructure.push({cls,term,year,amount:amt});
  autosave();
}

function applyBulkFee() {
  const cls=document.getElementById('bulkFeeClass')?.value;
  const amt=parseFloat(document.getElementById('bulkFeeDue')?.value)||0;
  const term=document.getElementById('bulkFeeTerm')?.value;
  if(!cls||!amt||!term){showToast('⚠️ Fill in all fields.');return;}
  updateFeeStructure(cls,term,amt);
  document.getElementById('bulkFeeModal').classList.remove('open');
  showToast('✅ Fee set for '+cls+' · '+term); renderFees();
}

function showArrearsReport() {
  document.getElementById('arrearsModal').classList.add('open');
  renderArrearsTable();
  const cf=document.getElementById('arrearsClassFilter');
  if(cf){const cls=[...new Set(state.students.map(s=>s.cls))].filter(Boolean);
    cf.innerHTML='<option value="">All Classes</option>'+cls.map(c=>`<option>${c}</option>`).join('');}
}

function renderArrearsTable() {
  const wrap=document.getElementById('arrearsTableWrap'); if(!wrap) return;
  const arr=state.fees.filter(f=>getStatus(totalDueForRecord(f),totalPaidForRecord(f))!=='Paid')
    .map(f=>{
      const p=f.studentId?state.students.find(s=>s.id===f.studentId):null;
      const name=p?`${p.first} ${p.last}`:(f.student||'Unknown');
      const cls=p?p.cls:(f.cls||'-');
      const bal=Math.max(0,totalDueForRecord(f)-totalPaidForRecord(f));
      return {name,cls,bal,term:f.term||''};
    }).sort((a,b)=>b.bal-a.bal);
  if(!arr.length){wrap.innerHTML='<p style="text-align:center;padding:20px;color:var(--green);">✅ No arrears!</p>';return;}
  wrap.innerHTML=`<table class="data-table"><thead><tr><th>#</th><th>Pupil</th><th>Class</th><th>Term</th><th>Balance</th></tr></thead>
    <tbody>${arr.map((a,i)=>`<tr><td>${i+1}</td><td><strong>${escHtml(a.name)}</strong></td><td>${escHtml(a.cls)}</td>
      <td>${escHtml(a.term)}</td><td style="color:var(--red);font-weight:700;">${fmt(a.bal)}</td></tr>`).join('')}
    </tbody></table>`;
}

function printArrearsReport()   { window.print(); }
function showPaymentStatement() { document.getElementById('paymentStatementModal').classList.add('open'); }
function renderPaymentStatement() {}
function printPaymentStatement()  { window.print(); }
function quickPrintFeeReceipt()   { showToast('🖨️ Print receipt — coming soon.'); }
function viewPaymentHistory()     { showToast('💳 Payment history — coming soon.'); }
function editFeeRecord(id) {
  const f=state.fees.find(f=>f.id===id); if(!f) return;
  populatePupilDropdown('fStudentSelect');
  document.getElementById('fStudentSelect').value=f.studentId||'';
  autoFillFeeFromPupil(f.studentId||'');
  if(document.getElementById('fTerm')) document.getElementById('fTerm').value=f.term||'First Term';
  document.getElementById('fEditId').value=id;
  document.getElementById('feeModal').classList.add('open');
}
function deleteFee(id) {
  if(!confirm('Delete this fee record?')) return;
  state.fees=state.fees.filter(f=>f.id!==id);
  renderFees(); updateFeeStats(); updateDashStats(); autosave();
  showToast('Fee record deleted.');
}
function printTranscript() { window.print(); }

// ════════════════════════════════════════
// DROPDOWN HELPERS
// ════════════════════════════════════════

function populatePupilDropdown(selectId) {
  const el=document.getElementById(selectId); if(!el) return;
  const cur=el.value;
  el.innerHTML='<option value="">-- Search & Select Pupil --</option>'+
    state.students.map(s=>`<option value="${s.id}">${escHtml(s.first+' '+s.last)} (${escHtml(s.cls||'')})</option>`).join('');
  el.value=cur;
}

function populateClassDropdown(selectId) {
  const el=document.getElementById(selectId); if(!el) return;
  const cls=['Creche','Nursery 1','Nursery 2','KG1','KG2','BS.1','BS.2','BS.3','BS.4','BS.5','BS.7','BS.8','BS.9'];
  el.innerHTML='<option value="">-- Select Class --</option>'+cls.map(c=>`<option>${c}</option>`).join('');
}

// ════════════════════════════════════════
// BACKUP
// ════════════════════════════════════════

function initBackup() {
  document.getElementById('exportBackupBtn')?.addEventListener('click', exportBackup);
  document.getElementById('importFileInput')?.addEventListener('change', function(){ importBackup(this.files[0]); });
  const rz=document.getElementById('restoreDropZone');
  if(rz){ rz.addEventListener('dragover',e=>{e.preventDefault();rz.style.borderColor='var(--blue)';}); rz.addEventListener('dragleave',()=>rz.style.borderColor=''); rz.addEventListener('drop',e=>{e.preventDefault();rz.style.borderColor='';const f=e.dataTransfer.files[0];if(f) importBackup(f);}); }
}

function exportBackup() {
  const data=localStorage.getItem(_currentSchoolKey)||'{}';
  const blob=new Blob([data],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=(state.settings.schoolName||'EduManage').replace(/\s+/g,'_')+'_backup_'+new Date().toISOString().slice(0,10)+'.json';
  a.click(); URL.revokeObjectURL(url);
  state.backupHistory=state.backupHistory||[];
  state.backupHistory.unshift({date:new Date().toISOString(),type:'Manual Export',size:Math.round(blob.size/1024)+' KB'});
  autosave(); renderBackupHistory(); showToast('✅ Backup downloaded!');
}

function importBackup(file) {
  if(!file) return;
  const reader=new FileReader();
  reader.onload=e=>{
    try {
      if(!confirm('⚠️ This will REPLACE all current data. Continue?')) return;
      const data=JSON.parse(e.target.result);
      localStorage.setItem(_currentSchoolKey,JSON.stringify(data));
      loadSchoolData(_currentSchoolKey); refreshAllViews();
      if(state.schoolLogo) applyLogo(state.schoolLogo);
      showToast('✅ Backup restored!');
    } catch(err){ showToast('❌ Invalid backup file.'); }
  };
  reader.readAsText(file);
}

function renderBackupHistory() {
  const el=document.getElementById('backupHistory'); if(!el) return;
  const hist=state.backupHistory||[];
  if(!hist.length){el.innerHTML='<p class="empty-state"><i class="fas fa-cloud-arrow-up"></i> No backups yet.</p>';return;}
  el.innerHTML=`<table class="data-table"><thead><tr><th>#</th><th>Date</th><th>Type</th><th>Size</th></tr></thead>
    <tbody>${hist.slice(0,20).map((b,i)=>`<tr><td>${i+1}</td><td>${new Date(b.date).toLocaleString('en-GH')}</td><td>${b.type}</td><td>${b.size||'-'}</td></tr>`).join('')}</tbody></table>`;
}

function updateBackupInfo() {
  const el=document.getElementById('backupInfo'); if(!el) return;
  el.innerHTML=`
    <div>👩‍🎓 Pupils: <strong>${state.students.length}</strong></div>
    <div>👩‍🏫 Teachers: <strong>${state.teachers.length}</strong></div>
    <div>💰 Fee Records: <strong>${state.fees.length}</strong></div>
    <div>📋 Reports: <strong>${state.reports.length}</strong></div>
    <div>🏛 Classes: <strong>${state.classes.length}</strong></div>`;
}

// ════════════════════════════════════════
// GLOBAL SEARCH
// ════════════════════════════════════════

function initGlobalSearch() {
  document.getElementById('globalSearch')?.addEventListener('input', function() {
    const q=this.value.trim().toLowerCase(); if(!q) return;
    const match=state.students.find(s=>`${s.first} ${s.last}`.toLowerCase().includes(q));
    if(match){ navigateTo('students'); showToast('🔍 Found: '+match.first+' '+match.last); }
  });
}

// ════════════════════════════════════════
// SCHOOL REGISTRATION
// ════════════════════════════════════════

function submitSchoolRegistration() {
  const name=document.getElementById('newSchoolName')?.value.trim();
  const admin=document.getElementById('newSchoolAdmin')?.value.trim();
  const phone=document.getElementById('newSchoolPhone')?.value.trim();
  const username=document.getElementById('newSchoolUsername')?.value.trim().toLowerCase();
  const password=document.getElementById('newSchoolPassword')?.value.trim();
  const errEl=document.getElementById('registerFormError');
  const showErr=msg=>{if(errEl){errEl.textContent=msg;errEl.style.display='block';}};
  if(errEl) errEl.style.display='none';
  if(!name){showErr('⚠️ School name is required.');return;}
  if(!username){showErr('⚠️ Admin username is required.');return;}
  if(!password||password.length<6){showErr('⚠️ Password must be at least 6 characters.');return;}
  const reqId='req_'+Date.now(); const schoolId='school_'+Date.now();
  const req={reqId,schoolId,schoolName:name,adminName:admin,phone,username,password,requestedAt:new Date().toISOString(),status:'pending'};
  const pendingKey='edumanage_pending_registrations';
  const pending=JSON.parse(localStorage.getItem(pendingKey)||'[]');
  pending.push(req); localStorage.setItem(pendingKey,JSON.stringify(pending));
  if(window._fbReady) window._fb.set('pending_schools/'+reqId,req).catch(()=>{});
  document.getElementById('registerSchoolModal').classList.remove('open');
  const snEl=document.getElementById('regSuccessSchoolName'); if(snEl) snEl.textContent=name;
  document.getElementById('regSuccessModal').classList.add('open');
  ['newSchoolName','newSchoolAdmin','newSchoolPhone','newSchoolUsername','newSchoolPassword'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
}

// ════════════════════════════════════════
// SUPER ADMIN PANEL
// ════════════════════════════════════════

const SA_DEFAULT_CODE = 'EduManage2025';
function getSuperAdminCode() { return localStorage.getItem('edumanage_super_admin_code')||SA_DEFAULT_CODE; }

function openSuperAdminPanel() {
  const code=document.getElementById('superAdminCode')?.value?.trim();
  const errEl=document.getElementById('superAdminCodeError');
  if(errEl) errEl.style.display='none';
  if(code!==getSuperAdminCode()){if(errEl) errEl.style.display='block';return;}
  document.getElementById('superAdminCodeRow').style.display='none';
  document.getElementById('superAdminPanelBody').style.display='block';
  switchSATab('registrations');
}

function switchSATab(tab) {
  const tabs=['addSchool','registrations','credentials','recovery','deleteReq'];
  tabs.forEach(t=>{
    const cap=t.charAt(0).toUpperCase()+t.slice(1);
    const btn=document.getElementById('saTab'+cap);
    const body=document.getElementById('saBody'+cap);
    if(btn) btn.classList.toggle('active',t===tab);
    if(body) body.style.display=(t===tab)?'block':'none';
  });
  if(tab==='registrations') renderPendingSchoolsList();
  if(tab==='credentials')   renderAllSchoolCredentials();
  if(tab==='recovery')      renderRecoveryRequests();
  if(tab==='deleteReq')     renderDeleteRequests();
}

function saRegisterSchool() {
  const g=id=>document.getElementById(id)?.value?.trim()||'';
  const name=g('saNewSchoolName'),username=g('saNewSchoolUsername'),password=g('saNewSchoolPassword');
  const admin=g('saNewSchoolAdmin'),phone=g('saNewSchoolPhone');
  const errEl=document.getElementById('saRegisterFormError');
  if(errEl) errEl.style.display='none';
  const showErr=msg=>{if(errEl){errEl.textContent=msg;errEl.style.display='block';}};
  if(!name){showErr('School name required.');return;}
  if(!username){showErr('Username required.');return;}
  if(!password||password.length<6){showErr('Password min 6 chars.');return;}
  const schoolId='school_'+Date.now(); const schoolKey=getSchoolKey(schoolId);
  const newData={students:[],fees:[],teachers:[],classes:[],albums:[],reports:[],_reportsDict:{},
    weeklyRecords:[],attendance:[],settings:{schoolName:name,term:'First Term',session:new Date().getFullYear()+'/'+(new Date().getFullYear()+1)},
    users:[{id:1,name:admin||name+' Admin',username,password,role:'Admin',active:true,createdAt:new Date().toISOString()}],
    nextStudentId:1,nextFeeId:1,nextTeacherId:1,nextClassId:1,nextAlbumId:1,
    nextWeeklyId:1,nextAttendanceId:1,nextUserId:2,savedAt:Date.now()};
  localStorage.setItem(schoolKey,JSON.stringify(newData));
  const reg=getRegistry();
  reg.push({id:schoolId,key:schoolKey,name,createdAt:new Date().toISOString()});
  saveRegistry(reg);
  if(window._fbReady) window._fb.set('schools/'+schoolId+'/data',newData).catch(()=>{});
  const msgEl=document.getElementById('saRegisterSuccessMsg'); if(msgEl) msgEl.textContent='🎉 "'+name+'" is now active!';
  const sEl=document.getElementById('saRegisterSuccess'); if(sEl) sEl.style.display='block';
  ['saNewSchoolName','saNewSchoolAdmin','saNewSchoolPhone','saNewSchoolUsername','saNewSchoolPassword'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});
  showToast('✅ School registered!'); renderSchoolList();
}

function renderPendingSchoolsList() {
  const el=document.getElementById('pendingSchoolsList'); if(!el) return;
  const pending=JSON.parse(localStorage.getItem('edumanage_pending_registrations')||'[]').filter(r=>r.status==='pending');
  if(!pending.length){el.innerHTML='<p style="text-align:center;color:var(--text-muted);padding:20px;font-size:13px;"><i class="fas fa-check-circle" style="color:var(--green);"></i> No pending registrations.</p>';return;}
  el.innerHTML=pending.map(r=>`
    <div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:10px;">
      <div style="font-weight:700;">${escHtml(r.schoolName)}</div>
      <div style="font-size:12px;color:var(--text-muted);">Admin: ${escHtml(r.adminName||'—')} · Phone: ${escHtml(r.phone||'—')}</div>
      <div style="font-size:12px;color:var(--text-muted);">Username: <strong>${escHtml(r.username)}</strong> · Requested: ${new Date(r.requestedAt).toLocaleDateString('en-GH')}</div>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="btn-primary" style="font-size:12px;padding:6px 14px;" onclick="approveRegistration('${r.reqId}')"><i class="fas fa-check"></i> Approve</button>
        <button class="btn-ghost" style="font-size:12px;padding:6px 14px;color:var(--red);border-color:var(--red);" onclick="rejectRegistration('${r.reqId}')"><i class="fas fa-times"></i> Reject</button>
      </div>
    </div>`).join('');
}

function approveRegistration(reqId) {
  const pendingKey='edumanage_pending_registrations';
  const pending=JSON.parse(localStorage.getItem(pendingKey)||'[]');
  const req=pending.find(r=>r.reqId===reqId); if(!req) return;
  req.status='approved'; localStorage.setItem(pendingKey,JSON.stringify(pending));
  const schoolId=req.schoolId; const schoolKey=getSchoolKey(schoolId);
  const newData={students:[],fees:[],teachers:[],classes:[],albums:[],reports:[],_reportsDict:{},weeklyRecords:[],attendance:[],
    settings:{schoolName:req.schoolName,term:'First Term',session:new Date().getFullYear()+'/'+(new Date().getFullYear()+1)},
    users:[{id:1,name:req.adminName||req.schoolName+' Admin',username:req.username,password:req.password,role:'Admin',active:true,createdAt:new Date().toISOString()}],
    nextStudentId:1,nextFeeId:1,nextTeacherId:1,nextClassId:1,nextAlbumId:1,nextWeeklyId:1,nextAttendanceId:1,nextUserId:2,savedAt:Date.now()};
  localStorage.setItem(schoolKey,JSON.stringify(newData));
  const reg=getRegistry();
  if(!reg.find(s=>s.id===schoolId)){reg.push({id:schoolId,key:schoolKey,name:req.schoolName,createdAt:new Date().toISOString()});saveRegistry(reg);}
  if(window._fbReady){window._fb.set('schools/'+schoolId+'/data',newData).catch(()=>{});window._fb.update('pending_schools/'+reqId,{status:'approved'}).catch(()=>{});}
  showToast('✅ Approved: '+req.schoolName); renderPendingSchoolsList(); renderSchoolList();
}

function rejectRegistration(reqId) {
  const pendingKey='edumanage_pending_registrations';
  const pending=JSON.parse(localStorage.getItem(pendingKey)||'[]');
  const req=pending.find(r=>r.reqId===reqId); if(req) req.status='rejected';
  localStorage.setItem(pendingKey,JSON.stringify(pending));
  if(window._fbReady) window._fb.update('pending_schools/'+reqId,{status:'rejected'}).catch(()=>{});
  showToast('Registration rejected.'); renderPendingSchoolsList();
}

function renderAllSchoolCredentials() {
  const el=document.getElementById('credentialsList'); if(!el) return;
  const reg=getRegistry();
  if(!reg.length){el.innerHTML='<p style="text-align:center;color:var(--text-muted);padding:16px;">No schools found.</p>';return;}
  el.innerHTML=reg.map(s=>{
    let uHtml='';
    try{const d=JSON.parse(localStorage.getItem(getSchoolKey(s.id))||'{}');
      uHtml=(d.users||[]).map(u=>`<div style="font-size:12px;color:var(--text-muted);padding:2px 0;">
        👤 <strong>${escHtml(u.username)}</strong> · <code>${escHtml(u.password)}</code> · ${u.role}</div>`).join('')||'<div style="font-size:12px;color:var(--text-muted);">No users</div>';}catch(e){}
    return `<div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:10px;">
      <div style="font-weight:700;margin-bottom:6px;">${escHtml(s.name)}</div>${uHtml}</div>`;
  }).join('');
}

function renderRecoveryRequests() {
  const el=document.getElementById('recoveryRequestsList'); if(!el) return;
  const reqs=JSON.parse(localStorage.getItem('edumanage_recovery_requests')||'[]');
  if(!reqs.length){el.innerHTML='<p style="text-align:center;color:var(--text-muted);padding:20px;font-size:13px;">No recovery requests.</p>';return;}
  el.innerHTML=reqs.map(r=>`
    <div style="border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:8px;">
      <div style="font-weight:700;">${escHtml(r.school||'—')}</div>
      <div style="font-size:12px;color:var(--text-muted);">Admin: ${escHtml(r.admin||'—')} · Phone: ${escHtml(r.phone||'—')} · Type: ${r.type||'—'}</div>
    </div>`).join('');
}

function renderDeleteRequests() {
  const el=document.getElementById('deleteRequestsList'); if(!el) return;
  el.innerHTML='<p style="text-align:center;color:var(--text-muted);padding:20px;font-size:13px;">No pending delete requests.</p>';
}

// ── SCHOOL DELETION ──
let _deleteTargetSchoolId=null;
function deleteSchool(schoolId) {
  const reg=getRegistry(); const school=reg.find(s=>s.id===schoolId); if(!school) return;
  _deleteTargetSchoolId=schoolId;
  const label=document.getElementById('deleteSchoolNameLabel'); if(label) label.textContent='"'+school.name+'"';
  const ci=document.getElementById('deleteSchoolCode'); if(ci) ci.value='';
  const errEl=document.getElementById('deleteSchoolCodeError'); if(errEl) errEl.style.display='none';
  document.getElementById('deleteSchoolModal').classList.add('open');
}
function confirmDeleteSchool() {
  const code=document.getElementById('deleteSchoolCode')?.value?.trim();
  const errEl=document.getElementById('deleteSchoolCodeError'); if(errEl) errEl.style.display='none';
  if(code!==getSuperAdminCode()){if(errEl) errEl.style.display='block';return;}
  if(!_deleteTargetSchoolId) return;
  const schoolKey=getSchoolKey(_deleteTargetSchoolId);
  const data=localStorage.getItem(schoolKey);
  const archives=JSON.parse(localStorage.getItem('edumanage_archives')||'{}');
  archives[_deleteTargetSchoolId]={data,deletedAt:new Date().toISOString(),expiresAt:Date.now()+90*24*60*60*1000};
  localStorage.setItem('edumanage_archives',JSON.stringify(archives));
  localStorage.removeItem(schoolKey);
  saveRegistry(getRegistry().filter(s=>s.id!==_deleteTargetSchoolId));
  if(window._fbReady) window._fb.set('archives/'+_deleteTargetSchoolId,{deletedAt:new Date().toISOString()}).catch(()=>{});
  document.getElementById('deleteSchoolModal').classList.remove('open');
  _deleteTargetSchoolId=null; renderSchoolList();
  showToast('School archived. Restorable within 90 days.');
}

// ── RESTORE ──
function renderArchivedSchools() {
  const el=document.getElementById('archivedSchoolsList'); if(!el) return;
  const archives=JSON.parse(localStorage.getItem('edumanage_archives')||'{}');
  const now=Date.now();
  const active=Object.entries(archives).filter(([,v])=>(v.expiresAt||0)>now);
  if(!active.length){el.innerHTML='<p style="text-align:center;color:var(--text-muted);padding:20px;font-size:13px;">No archived schools.</p>';return;}
  el.innerHTML=active.map(([id,v])=>{
    let name=id; try{name=JSON.parse(v.data||'{}').settings?.schoolName||id;}catch(e){}
    const days=Math.ceil(((v.expiresAt||0)-now)/86400000);
    return `<div style="display:flex;align-items:center;gap:12px;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">
      <div style="flex:1;"><div style="font-weight:700;">${escHtml(name)}</div>
        <div style="font-size:12px;color:var(--text-muted);">Deleted: ${new Date(v.deletedAt).toLocaleDateString('en-GH')} · ${days} days left</div></div>
      <button class="btn-primary" style="font-size:12px;padding:6px 14px;" onclick="restoreSchool('${id}')"><i class="fas fa-trash-restore"></i> Restore</button>
    </div>`;
  }).join('');
}

function restoreSchool(schoolId) {
  const archives=JSON.parse(localStorage.getItem('edumanage_archives')||'{}');
  const arc=archives[schoolId]; if(!arc){showToast('Archive not found.');return;}
  const schoolKey=getSchoolKey(schoolId);
  localStorage.setItem(schoolKey,arc.data);
  delete archives[schoolId]; localStorage.setItem('edumanage_archives',JSON.stringify(archives));
  let name=schoolId; try{name=JSON.parse(arc.data||'{}').settings?.schoolName||schoolId;}catch(e){}
  const reg=getRegistry();
  if(!reg.find(s=>s.id===schoolId)){reg.push({id:schoolId,key:schoolKey,name,createdAt:new Date().toISOString()});saveRegistry(reg);}
  if(window._fbReady) window._fb.set('schools/'+schoolId+'/data',JSON.parse(arc.data)).catch(()=>{});
  document.getElementById('restoreSchoolModal').classList.remove('open');
  renderSchoolList(); showToast('✅ "'+name+'" restored!');
}

// ── RECOVERY MODAL ──
function switchRecoveryTab(n) {
  document.getElementById('recTabPane1').style.display=n===1?'block':'none';
  document.getElementById('recTabPane2').style.display=n===2?'block':'none';
  document.getElementById('recModalFoot1').style.display=n===1?'flex':'none';
  document.getElementById('recModalFoot2').style.display=n===2?'flex':'none';
  const activeStyle='flex:1;padding:9px;font-size:13px;font-weight:700;background:var(--blue);color:#fff;border:none;cursor:pointer;';
  const inactStyle ='flex:1;padding:9px;font-size:13px;font-weight:600;background:transparent;color:var(--text-muted);border:none;cursor:pointer;';
  document.getElementById('recTab1').style.cssText=n===1?activeStyle:inactStyle;
  document.getElementById('recTab2').style.cssText=n===2?activeStyle:inactStyle;
}

function doEmergencyReveal() {
  const code=document.getElementById('recSuperCode')?.value?.trim();
  const resEl=document.getElementById('recRevealResult'); const errEl=document.getElementById('recLocalError');
  if(errEl) errEl.style.display='none'; if(resEl) resEl.style.display='none';
  if(code!==getSuperAdminCode()){if(errEl){errEl.textContent='❌ Wrong Super Admin Code.';errEl.style.display='block';}return;}
  let html='';
  getRegistry().forEach(s=>{
    try{const d=JSON.parse(localStorage.getItem(getSchoolKey(s.id))||'{}');
      (d.users||[]).forEach(u=>{html+=`<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">
        <strong>${escHtml(s.name)}</strong><br>👤 <code>${escHtml(u.username)}</code> · <code>${escHtml(u.password)}</code> · ${u.role}</div>`;});}catch(e){}
  });
  if(!html) html='<p style="color:var(--text-muted);">No schools found.</p>';
  if(resEl){resEl.innerHTML=html;resEl.style.display='block';}
}

function submitRecoveryRequest() {
  const school=document.getElementById('recSchoolName')?.value.trim();
  const admin=document.getElementById('recAdminName')?.value.trim();
  const phone=document.getElementById('recPhone')?.value.trim();
  const type=document.getElementById('recType')?.value||'both';
  const errEl=document.getElementById('recoveryFormError');
  if(errEl) errEl.style.display='none';
  if(!school||!admin||!phone){if(errEl){errEl.textContent='Fill in all required fields.';errEl.style.display='block';}return;}
  const req={school,admin,phone,type,submittedAt:new Date().toISOString()};
  const key='edumanage_recovery_requests'; const reqs=JSON.parse(localStorage.getItem(key)||'[]');
  reqs.push(req); localStorage.setItem(key,JSON.stringify(reqs));
  if(window._fbReady) window._fb.set('recovery_requests/'+Date.now(),req).catch(()=>{});
  document.getElementById('recoveryRequestModal').classList.remove('open');
  document.getElementById('recoverySuccessModal').classList.add('open');
}

// ════════════════════════════════════════
// SECTION STUB RENDERS
// (Prevent crashes; full CRUD in init modules)
// ════════════════════════════════════════

function _stubRow(tbodyId, msg, cols=9) {
  const el=document.getElementById(tbodyId);
  if(el) el.innerHTML=`<tr><td colspan="${cols}" style="text-align:center;color:var(--text-light);padding:28px;">${msg}</td></tr>`;
}
function renderStudents()  { _stubRow('studentTbody','No pupils yet. Click <strong>Add Pupil</strong> to get started.',7); updateDashStats(); }
function renderTeachers()  { _stubRow('teacherTbody','No teachers yet.',6); }
function renderClasses()   { _stubRow('classTbody','No classes yet.',6); }
function renderGallery()   { const el=document.getElementById('galleryAlbums'); if(el&&!state.albums?.length) el.innerHTML='<p class="empty-state"><i class="fas fa-images"></i> No albums yet. Click <strong>New Album</strong>.</p>'; }
function renderSavedReports(){ const el=document.getElementById('savedReportsList'); if(el&&!state.reports?.length) el.innerHTML='<p class="empty-state"><i class="fas fa-file-circle-plus"></i> No reports yet.</p>'; }
function renderWeekly()    { _stubRow('weeklyTbody','No weekly records yet.',8); }
function renderAttendance(){ _stubRow('attendanceTbody','No attendance records yet.',12); }
function renderUsers()     { _stubRow('usersTbody','No users yet.',8); }
function renderAnnouncements()     { const el=document.getElementById('announcementsList'); if(el&&!state.announcements?.length) el.innerHTML='<p style="text-align:center;color:var(--text-muted);font-size:13px;padding:20px;">No announcements yet.</p>'; }
function renderParentNotifications(){ const el=document.getElementById('parentNotificationsList'); if(el&&!state.parentNotifications?.length) el.innerHTML='<p style="text-align:center;color:var(--text-muted);font-size:13px;padding:20px;">No notifications yet.</p>'; }

// CSV / print stubs
function downloadFeesCSV()        { showToast('📥 CSV export — coming soon.'); }
function downloadPupilsCSV()      { showToast('📥 CSV export — coming soon.'); }
function downloadTeachersCSV()    { showToast('📥 CSV export — coming soon.'); }
function downloadAdmissionsCSV()  { showToast('📥 CSV export — coming soon.'); }
function downloadResourcesCSV()   { showToast('📥 CSV export — coming soon.'); }
function downloadExamsCSV()       { showToast('📥 CSV export — coming soon.'); }
function downloadTransfersCSV()   { showToast('📥 CSV export — coming soon.'); }
function downloadAttendanceCSV()  { showToast('📥 CSV export — coming soon.'); }
function printAdmissionsCSV()     { window.print(); }

// Section init stubs (no crash if not yet implemented)
function initReportGenerator()    {}
function initStudents()           {}
function initStudentPhotoUpload() {}
function initReportSection()      {}
function initGallery()            {}
function initWeekly()             {}
function initAttendance()         {}
function initPromotion()          {}
function initSMS()                {}
function initIDCards()            {}
function initAdmissions()         {}
function initTeachers()           {}
function initClasses()            {}
function initResources()          {}
function initExams()              {}
function initTransfers()          {}
function initCommunication()      {}
function initExpenditure()        {}

// Misc stubs referenced in HTML
function autoFillReportFromPupil(v)   {}
function autoFillTransferPupil(v)     {}
function generateSMSReminders()       {}
function generateSMSReminders2()      {}
function showInactivePupils()         { showToast('📂 Inactive pupils view — coming soon.'); }
function switchIDTab(t)               {}
function renderIDCards()              {}
function switchPromoTab(n)            {}
function promoteAllClasses()          { showToast('⬆️ Promotion — coming soon.'); }
function switchCommTab(t)             {}
function switchPortalTab(t)           {}
function copyBulkPhones()             { showToast('📋 Numbers copied.'); }
function previewBulkMessages()        {}
function downloadSMSReport()          { showToast('📥 SMS report — coming soon.'); }
function toggleSelectAllSMS(v)        {}
function refreshBulkSelection()       {}
function updateTransferFromTo()       {}
function renderResources()            { _stubRow('resTbody','No resources yet.',10); }
function renderExams()                { _stubRow('examTbody','No exams yet.',11); }
function renderTransfers()            { _stubRow('transferTbody','No transfer records yet.',10); }
function renderAdmissions()           { _stubRow('admTbody','No admissions yet.',9); }
function renderExpenditures()         { _stubRow('expTbody','No expenses yet.',7); }
function handleResFileDrop(e)         { e.preventDefault(); }
function switchResTab(t)              {}
function clearResFile()               {}
function updateAttClassSize()         {}
function populateStatementPupils()    {}
function switchSATab_comm(t)          {}
function promptShowAllPasswords()     { showToast('🔐 Requires super admin code.'); }
function toggleLinkedStudentField()   {}
function renderPromotionPreview()     {}
function switchPromoTab(n)            {}
