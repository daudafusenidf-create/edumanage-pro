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