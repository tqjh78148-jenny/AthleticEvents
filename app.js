/**
 * 頭前國中 115學年度校慶運動大會田徑賽事 - 智慧賽務與即時榜單核心系統 (app.js)
 * 遵循教育部與頭前國中校慶運動會規程、並列排序演算法、多人雲端同步與分權設計
 * 
 * 全校跨載具即時同步正式雲端網址 (Google Apps Script Web App)
 * 支援全校所有手機、平板、電腦、大螢幕自動零設定連線
 */
window.DEFAULT_GAS_URL = 'https://script.google.com/macros/s/AKfycbzDWLgvkjLhHcVQBSa1AcMWPbu78C8Eqkhu7G92Mng7_UZEpZxjvqQfdWYvwqHO1YdL/exec';

// 應用程式全域狀態
const APP_STATE = {
  data: null,
  currentYear: '115',
  years: {},
  currentTab: 'leaderboard',
  isAdminUnlocked: false,
  currentUser: null,
  pendingTabAfterLogin: null,
  isRosterEditUnlocked: false, // 選手名冊與分組分道進階編輯授權開關 (需密碼 tqjh888)
  rosterEditPassword: 'tqjh888', // 專用修改授權密碼
  adminAccounts: [
    { username: 'tqjh888', password: 'tqjh888', name: '體育組管理員' },
    { username: 'jenny', password: '123456789', name: 'Jenny 管理員' }
  ],
  projectorMode: false,
  
  // 榜單篩選
  leaderboardFilter: {
    event: 'grandRelay', // grandRelay, relay4x200, 100m, 200m, 400m, 800m, 1500m, shotPut, longJump
    grade: '七年級',     // 預設七年級（避免全校各年級混班跨級排名）
    gender: 'all',       // all, 男生組, 女生組
    sprintView: 'ranking', // ranking (總排晉級), heats (分組分道)
    subTab: 'events',    // events (各單項與接力賽況) 或 points (班級運動會總積分查詢)
    selectedClass: '701' // 班級總積分查詢選定之班級 (701~916 或 all-7, all-8, all-9, all-school)
  },

  // 賽前班級查詢
  classSearch: {
    classId: '701',
    date: 'all'
  },

  // 體育老師工作看板
  selectedTeacher: '忠哲',

  // 後台成績登錄選擇
  adminEdit: {
    event: 'grandRelay',
    grade: '七年級',
    gender: '混組',
    flightOrHeat: 'all'
  },

  // 多人雲端即時同步設定 (跨載具手機、平板、電腦、大螢幕自動輪詢同步)
  sync: {
    gasUrl: localStorage.getItem('TQ_GAS_URL') || (window.INITIAL_MEET_DATA && window.INITIAL_MEET_DATA.meta && window.INITIAL_MEET_DATA.meta.gasUrl) || window.DEFAULT_GAS_URL || 'https://script.google.com/macros/s/AKfycbzDWLgvkjLhHcVQBSa1AcMWPbu78C8Eqkhu7G92Mng7_UZEpZxjvqQfdWYvwqHO1YdL/exec',
    pollingEnabled: localStorage.getItem('TQ_POLLING_ENABLED') !== 'false',
    intervalId: null,
    countdown: 5,
    lastSyncedTime: null,
    isSyncing: false
  }
};
window.APP_STATE = APP_STATE;

// ==========================================
// 1. 初始化與資料存取 (Local Storage / Multi-Year Archive / Seed Data)
// ==========================================

// 判定該選手/班級是否有登記任何有效成績
function hasValidAthleteScore(item) {
  if (!item) return false;
  if (item.rawScore && String(item.rawScore).trim() !== '' && item.rawScore !== '--') return true;
  if (item.score !== undefined && item.score !== null && String(item.score).trim() !== '' && item.score !== '--') {
    const sec = parseChineseTimeToSeconds(item.score);
    if (sec !== null && sec > 0) return true;
    if (!isNaN(parseFloat(item.score)) && parseFloat(item.score) > 0) return true;
  }
  if (item.best && String(item.best).trim() !== '' && item.best !== '--' && !isNaN(parseFloat(item.best)) && parseFloat(item.best) > 0) return true;
  if (item.att1 && String(item.att1).trim() !== '' && item.att1 !== '--' && !isNaN(parseFloat(item.att1)) && parseFloat(item.att1) > 0) return true;
  if (item.att2 && String(item.att2).trim() !== '' && item.att2 !== '--' && !isNaN(parseFloat(item.att2)) && parseFloat(item.att2) > 0) return true;
  if (item.att3 && String(item.att3).trim() !== '' && item.att3 !== '--' && !isNaN(parseFloat(item.att3)) && parseFloat(item.att3) > 0) return true;
  return false;
}

// 計算資料集中總有效成績筆數
function countTotalScoresInDataset(data) {
  if (!data || !data.events) return 0;
  let count = 0;
  Object.keys(data.events).forEach(k => {
    const list = data.events[k];
    if (Array.isArray(list)) {
      list.forEach(item => {
        if (hasValidAthleteScore(item)) count++;
      });
    }
  });
  return count;
}

/**
 * 雙向安全成績合併工具 (Non-destructive Score Merger)
 * 核心準則：已輸入之真實比賽成績為最高優先，絕不可被空字串或缺漏資料覆蓋！
 */
function mergeEventDatasets(baseData, incomingData) {
  if (!baseData || !baseData.events) return incomingData ? JSON.parse(JSON.stringify(incomingData)) : baseData;
  if (!incomingData || !incomingData.events) return baseData;

  const result = JSON.parse(JSON.stringify(baseData));

  Object.keys(incomingData.events).forEach(evKey => {
    const incomingList = incomingData.events[evKey];
    if (!Array.isArray(incomingList)) return;
    if (!result.events[evKey]) result.events[evKey] = [];
    const baseList = result.events[evKey];

    incomingList.forEach(inItem => {
      let match = baseList.find(x => x.id === inItem.id || (x.classId === inItem.classId && x.name === inItem.name && x.heat === inItem.heat));
      if (!match) {
        // 新增的選手或班級直接加入
        baseList.push(JSON.parse(JSON.stringify(inItem)));
      } else {
        // 選手已存在：若 incoming 含有有效成績，且 base 尚未有成績，則採納 incoming 成績
        if (hasValidAthleteScore(inItem) && !hasValidAthleteScore(match)) {
          if (inItem.score !== undefined && inItem.score !== null && inItem.score !== '') match.score = inItem.score;
          if (inItem.rawScore !== undefined && inItem.rawScore !== null && inItem.rawScore !== '') match.rawScore = inItem.rawScore;
          if (inItem.foulCount !== undefined) match.foulCount = inItem.foulCount;
          if (inItem.att1 !== undefined && inItem.att1 !== null && inItem.att1 !== '') match.att1 = inItem.att1;
          if (inItem.att2 !== undefined && inItem.att2 !== null && inItem.att2 !== '') match.att2 = inItem.att2;
          if (inItem.att3 !== undefined && inItem.att3 !== null && inItem.att3 !== '') match.att3 = inItem.att3;
          if (inItem.best !== undefined && inItem.best !== null && inItem.best !== '') match.best = inItem.best;
          if (inItem.bestDistance !== undefined && inItem.bestDistance !== null) match.bestDistance = inItem.bestDistance;
          if (inItem.formattedBest) match.formattedBest = inItem.formattedBest;
          if (inItem.formattedFinal) match.formattedFinal = inItem.formattedFinal;
          if (inItem.rank) match.rank = inItem.rank;
          if (inItem.remarks) match.remarks = inItem.remarks;
        } else if (hasValidAthleteScore(inItem) && hasValidAthleteScore(match)) {
          // 雙方皆有成績：若 incoming 較完整或有新數據則補充更新，絕不洗白
          if (inItem.foulCount !== undefined && match.foulCount === 0) match.foulCount = inItem.foulCount;
          if (inItem.att2 && !match.att2) match.att2 = inItem.att2;
          if (inItem.att3 && !match.att3) match.att3 = inItem.att3;
          if (inItem.best && (!match.best || parseFloat(inItem.best) > parseFloat(match.best))) {
            match.best = inItem.best;
            match.formattedBest = inItem.formattedBest || match.formattedBest;
          }
        }
        // 若 incoming 為空白而 base 已有成績，則絕對嚴格保留 base 原有成績！
      }
    });
  });

  return result;
}

// 尋找全站最新有成績登記之賽事項目
function findLatestEventWithScores() {
  try {
    const saved = localStorage.getItem('TQ_LATEST_SCORED_EVENT');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.event && APP_STATE.data && APP_STATE.data.events) {
        const list = getAdminCurrentEventList(parsed.event);
        if (list && list.some(x => hasValidAthleteScore(x))) {
          return parsed;
        }
      }
    }
  } catch (e) {}

  if (!APP_STATE.data || !APP_STATE.data.events) return null;
  const eventKeys = ['grandRelay', '100m_finals', '200m_finals', '100m', '200m', '400m', '800m', '1500m', 'shotPut', 'longJump', 'relay4x200'];
  for (const ev of eventKeys) {
    const list = APP_STATE.data.events[ev];
    if (Array.isArray(list)) {
      const itemWithScore = list.find(x => hasValidAthleteScore(x));
      if (itemWithScore) {
        return {
          event: ev,
          grade: itemWithScore.grade || '七年級',
          gender: ev === 'grandRelay' ? 'all' : (itemWithScore.gender || '男生組')
        };
      }
    }
  }
  return null;
}

// 同步更新即時榜單篩選按鈕列 (UI Pills) 的 active 樣式
function updateLeaderboardFilterPillsUI() {
  const { event, grade, gender } = APP_STATE.leaderboardFilter;
  document.querySelectorAll('#event-pills .filter-pill').forEach(el => {
    el.classList.toggle('active', el.dataset.event === event);
  });
  document.querySelectorAll('#grade-pills .filter-pill').forEach(el => {
    el.classList.toggle('active', el.dataset.grade === grade);
  });
  const genderPills = document.getElementById('gender-pills');
  if (genderPills) {
    genderPills.style.display = (event === 'grandRelay') ? 'none' : 'flex';
  }
  document.querySelectorAll('#gender-pills .filter-pill').forEach(el => {
    el.classList.toggle('active', el.dataset.gender === gender);
  });
}

// 記住使用者目前所選視角與篩選（防止背景自動輪詢或 F5 刷新重置視角）
function saveUserViewSession() {
  try {
    sessionStorage.setItem('TQ_USER_VIEW', JSON.stringify({
      tab: APP_STATE.currentTab,
      subTab: APP_STATE.leaderboardFilter.subTab,
      event: APP_STATE.leaderboardFilter.event,
      grade: APP_STATE.leaderboardFilter.grade,
      gender: APP_STATE.leaderboardFilter.gender,
      selectedClass: APP_STATE.leaderboardFilter.selectedClass
    }));
  } catch (e) {}
}

function initApp() {
  // 嘗試從 LocalStorage 讀取多學年度資料庫，若無則讀取單年度或官方種子資料
  let initialLoaded = false;
  try {
    const yearsStoreRaw = localStorage.getItem('TQ_MEET_YEARS_STORE');
    if (yearsStoreRaw) {
      const parsedStore = JSON.parse(yearsStoreRaw);
      if (parsedStore && parsedStore.years && typeof parsedStore.years === 'object') {
        APP_STATE.years = parsedStore.years;
        const activeYr = parsedStore.activeYear || Object.keys(parsedStore.years)[0] || '115';
        APP_STATE.currentYear = String(activeYr);
        APP_STATE.data = APP_STATE.years[APP_STATE.currentYear];
        initialLoaded = true;
      }
    }
  } catch (e) {
    console.warn('Failed to parse TQ_MEET_YEARS_STORE', e);
  }

  if (!initialLoaded) {
    const savedData = localStorage.getItem('TQ_MEET_DATA_115');
    if (savedData) {
      try {
        const parsed = JSON.parse(savedData);
        const yr = (parsed.meta && parsed.meta.academicYear) ? String(parsed.meta.academicYear) : '115';
        APP_STATE.years = {};
        APP_STATE.years[yr] = parsed;
        APP_STATE.currentYear = yr;
        APP_STATE.data = parsed;
        initialLoaded = true;
      } catch (e) {
        console.warn('Corrupted TQ_MEET_DATA_115', e);
      }
    }
  }

  if (!initialLoaded) {
    const seed = JSON.parse(JSON.stringify(window.INITIAL_MEET_DATA));
    APP_STATE.years = { '115': seed };
    APP_STATE.currentYear = '115';
    APP_STATE.data = seed;
  }

  // 註冊即時時鐘
  startLiveClock();

  // 綁定導覽切換
  setupNavigation();

  // 初始化管理者權限與身分狀態 (未登入時隱藏體育組看板)
  initAdminAuth();
  updateAcademicYearHeaderUI();

  // 🛡️ 成績安全保險箱：從持久保險箱 (TQ_SCORE_VAULT) 自動守護並補齊已登錄之成績
  try {
    const vaultRaw = localStorage.getItem('TQ_SCORE_VAULT');
    if (vaultRaw && APP_STATE.data && APP_STATE.data.events) {
      const vault = JSON.parse(vaultRaw);
      Object.keys(APP_STATE.data.events).forEach(evKey => {
        const list = APP_STATE.data.events[evKey];
        if (Array.isArray(list)) {
          list.forEach(item => {
            if (!hasValidAthleteScore(item) && vault[item.id]) {
              const b = vault[item.id];
              if (b.score !== undefined && b.score !== null && b.score !== '') item.score = b.score;
              if (b.rawScore !== undefined && b.rawScore !== null && b.rawScore !== '') item.rawScore = b.rawScore;
              if (b.foulCount !== undefined) item.foulCount = b.foulCount;
              if (b.att1 !== undefined && b.att1 !== null && b.att1 !== '') item.att1 = b.att1;
              if (b.att2 !== undefined && b.att2 !== null && b.att2 !== '') item.att2 = b.att2;
              if (b.att3 !== undefined && b.att3 !== null && b.att3 !== '') item.att3 = b.att3;
              if (b.best !== undefined && b.best !== null && b.best !== '') item.best = b.best;
              if (b.formattedBest) item.formattedBest = b.formattedBest;
              if (b.formattedFinal) item.formattedFinal = b.formattedFinal;
            }
          });
        }
      });
    }
  } catch (e) {
    console.warn('Vault restore error:', e);
  }

  // 大隊接力 716 與 816 班級人數不足排除（僅在無成績時排除，絕不刪除已登記成績）
  if (APP_STATE.data && APP_STATE.data.events) {
    if (!APP_STATE.data.events.e100m_finals) APP_STATE.data.events.e100m_finals = [];
    if (!APP_STATE.data.events.e200m_finals) APP_STATE.data.events.e200m_finals = [];
    const gr = APP_STATE.data.events.grandRelay;
    if (gr && Array.isArray(gr)) {
      const origCount = gr.length;
      APP_STATE.data.events.grandRelay = gr.filter(x => {
        const is716or816 = (x.classId === '716' || x.classId === '816');
        return !(is716or816 && !hasValidAthleteScore(x));
      });
      if (APP_STATE.data.events.grandRelay.length !== origCount) {
        if (!APP_STATE.years) APP_STATE.years = {};
        APP_STATE.years[APP_STATE.currentYear || '115'] = APP_STATE.data;
        saveLocalData();
      }
    }
  }

  // 🛡️ 線上名冊與本地成績雙向保護合併（上傳新網頁後，絕對不可更動後台已設定好的比賽成績！）
  if (window.INITIAL_MEET_DATA && window.INITIAL_MEET_DATA.events) {
    // 採用嚴格保留成績的合併模式：本地已輸入成績優先，線上名冊補入，空成績絕不覆蓋已登錄成績！
    APP_STATE.data = mergeEventDatasets(APP_STATE.data, window.INITIAL_MEET_DATA);
    if (!APP_STATE.years) APP_STATE.years = {};
    APP_STATE.years[APP_STATE.currentYear || '115'] = APP_STATE.data;
    saveLocalData();
  }

  // 檢查 sessionStorage 中是否有保存的使用者視角設定（防止背景輪詢或 F5 刷新後被重置）
  let viewRestored = false;
  try {
    const savedView = sessionStorage.getItem('TQ_USER_VIEW');
    if (savedView) {
      const parsed = JSON.parse(savedView);
      if (parsed.tab) APP_STATE.currentTab = parsed.tab;
      if (parsed.subTab) APP_STATE.leaderboardFilter.subTab = parsed.subTab;
      if (parsed.event) APP_STATE.leaderboardFilter.event = parsed.event;
      if (parsed.grade) APP_STATE.leaderboardFilter.grade = parsed.grade;
      if (parsed.gender) APP_STATE.leaderboardFilter.gender = parsed.gender;
      if (parsed.selectedClass) APP_STATE.leaderboardFilter.selectedClass = parsed.selectedClass;
      viewRestored = true;
    }
  } catch (e) {}

  if (!viewRestored) {
    // 首次開啟頁面：首頁自動切換至最新有成績之項目；若全站皆無成績，預設大隊接力並保留空白
    const latestScored = findLatestEventWithScores();
    if (latestScored) {
      APP_STATE.leaderboardFilter.event = latestScored.event;
      APP_STATE.leaderboardFilter.grade = latestScored.grade || '七年級';
      APP_STATE.leaderboardFilter.gender = (latestScored.event === 'grandRelay') ? 'all' : (latestScored.gender || '男生組');
    } else {
      APP_STATE.leaderboardFilter.event = 'grandRelay';
      APP_STATE.leaderboardFilter.grade = '七年級';
      APP_STATE.leaderboardFilter.gender = 'all';
    }
  }

  // 初始化各頁面元件
  const genderPills = document.getElementById('gender-pills');
  if (genderPills) {
    genderPills.style.display = (APP_STATE.leaderboardFilter.event === 'grandRelay') ? 'none' : 'flex';
  }
  updateLeaderboardFilterPillsUI();
  initClassPointsDropdown();
  renderLeaderboard();
  initClassSearchOptions();
  renderClassRoster();
  renderMasterSchedule();
  initTeacherDashboard();
  renderTeacherDuties();
  initAdminView();

  // 若使用者先前停留在班級積分榜或特定分頁，復原其呈現
  if (APP_STATE.leaderboardFilter.subTab === 'points') {
    setLeaderboardSubTab('points');
  }
  if (APP_STATE.currentTab && APP_STATE.currentTab !== 'leaderboard') {
    switchTab(APP_STATE.currentTab);
  }

  // 雲端同步檢查 (跨載具自動連線同步)
  if (!APP_STATE.sync.gasUrl) {
    APP_STATE.sync.gasUrl = window.DEFAULT_GAS_URL;
  }
  if (APP_STATE.sync.gasUrl) {
    localStorage.setItem('TQ_GAS_URL', APP_STATE.sync.gasUrl);
    pullDataFromCloud();
    startSyncPolling();
  }
  updateSyncStatusUI();

  // 畫面重新回到前景或獲得焦點時（特別支援手機螢幕喚醒與 iOS Safari BFCache），立即觸發一次雲端檢查，實現 0 延遲
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && APP_STATE.sync.gasUrl) {
      pullDataFromCloud();
    }
  });
  window.addEventListener('focus', () => {
    if (APP_STATE.sync.gasUrl) {
      pullDataFromCloud();
    }
  });
  window.addEventListener('pageshow', () => {
    if (APP_STATE.sync.gasUrl) {
      pullDataFromCloud();
    }
  });

  // 監聽鍵盤快捷鍵 (例如 Esc 離開大螢幕)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && APP_STATE.projectorMode) {
      toggleProjectorMode(false);
    }
  });
}

function saveLocalData() {
  try {
    if (!APP_STATE.years) APP_STATE.years = {};
    if (APP_STATE.currentYear && APP_STATE.data) {
      APP_STATE.years[APP_STATE.currentYear] = APP_STATE.data;
    }
    const storePayload = {
      activeYear: APP_STATE.currentYear || '115',
      years: APP_STATE.years,
      updatedAt: new Date().toISOString()
    };
    localStorage.setItem('TQ_MEET_YEARS_STORE', JSON.stringify(storePayload));
    // 保持舊版單年度相容性
    if (APP_STATE.years['115']) {
      localStorage.setItem('TQ_MEET_DATA_115', JSON.stringify(APP_STATE.years['115']));
    } else if (APP_STATE.data) {
      localStorage.setItem('TQ_MEET_DATA_115', JSON.stringify(APP_STATE.data));
    }

    // 🛡️ 成績持久保險箱：只增不減備份所有已登錄之成績，防止任何網頁更新或跨版本覆蓋
    if (APP_STATE.data && APP_STATE.data.events) {
      const vaultDelta = {};
      Object.keys(APP_STATE.data.events).forEach(evKey => {
        const list = APP_STATE.data.events[evKey];
        if (Array.isArray(list)) {
          list.forEach(item => {
            if (hasValidAthleteScore(item)) {
              vaultDelta[item.id] = {
                score: item.score,
                rawScore: item.rawScore,
                foulCount: item.foulCount,
                att1: item.att1,
                att2: item.att2,
                att3: item.att3,
                best: item.best,
                formattedBest: item.formattedBest,
                formattedFinal: item.formattedFinal
              };
            }
          });
        }
      });
      try {
        const oldVaultRaw = localStorage.getItem('TQ_SCORE_VAULT');
        const oldVault = oldVaultRaw ? JSON.parse(oldVaultRaw) : {};
        const combinedVault = Object.assign({}, oldVault, vaultDelta);
        localStorage.setItem('TQ_SCORE_VAULT', JSON.stringify(combinedVault));
      } catch (e) {}
    }

    showToast('💾 資料已自動保存至本機資料庫');
    if (APP_STATE.sync.gasUrl) {
      pushDataToCloud();
    }
  } catch (err) {
    console.error('Save failed:', err);
    showToast('❌ 儲存失敗：' + err.message, 'error');
  }
}

// 切換作用中學年度（支援歷史紀錄查閱與新賽事運作）
function switchAcademicYear(year) {
  if (!year) return;
  const targetYr = String(year);
  if (!APP_STATE.years || !APP_STATE.years[targetYr]) return;

  // 切換前將當前資料封存至其學年度
  if (APP_STATE.currentYear && APP_STATE.data) {
    APP_STATE.years[APP_STATE.currentYear] = APP_STATE.data;
  }

  APP_STATE.currentYear = targetYr;
  APP_STATE.data = APP_STATE.years[targetYr];
  saveLocalData();

  updateAcademicYearHeaderUI();
  initClassSearchOptions();
  renderLeaderboard();
  renderClassRoster();
  renderMasterSchedule();
  initTeacherDashboard();
  renderTeacherDuties();
  renderAdminEditTable();

  showToast(`📅 已切換至【${targetYr}學年度】賽事紀錄！`);
}

function startLiveClock() {
  const clockEl = document.getElementById('live-clock');
  function update() {
    const now = new Date();
    const yr = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const da = String(now.getDate()).padStart(2, '0');
    const hr = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const se = String(now.getSeconds()).padStart(2, '0');
    if (clockEl) {
      clockEl.textContent = `${yr}/${mo}/${da} ${hr}:${mi}:${se}`;
    }
  }
  update();
  setInterval(update, 1000);
}

function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetTab = item.dataset.tab;
      switchTab(targetTab);
    });
  });
}

function switchTab(tabId) {
  // 歷年成績走廊暫不開放，自動導向即時榜單
  if (tabId === 'history') {
    tabId = 'leaderboard';
  }

  // 體育組裁判執勤看板與後台管理均為管理者專用，未登入前強制跳出登入視窗
  if ((tabId === 'teacher' || tabId === 'admin') && !APP_STATE.isAdminUnlocked) {
    APP_STATE.pendingTabAfterLogin = tabId;
    openAdminAuthModal();
    return;
  }

  APP_STATE.currentTab = tabId;
  saveUserViewSession();
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-pane').forEach(el => {
    el.classList.toggle('active', el.id === `tab-${tabId}`);
  });

  if (tabId === 'leaderboard') renderLeaderboard();
  else if (tabId === 'search') renderClassRoster();
  else if (tabId === 'schedule') renderMasterSchedule();
  else if (tabId === 'teacher') renderTeacherDuties();
  else if (tabId === 'admin') renderAdminEditTable();
}

// ==========================================
// 2. 核心時間換算工具 (如：4分15秒34)
// ==========================================

/**
 * 將秒數轉換為符合台灣田徑賽裁判規格之繁體中文顯示（如：4分15秒34）
 * @param {number} totalSec - 總秒數
 * @returns {string} - 如 "4分15秒34" 或 "12秒35"
 */
function formatSecondsToChinese(totalSec) {
  if (totalSec === null || totalSec === undefined || isNaN(totalSec) || totalSec <= 0) {
    return '--';
  }
  const min = Math.floor(totalSec / 60);
  const secTotal = totalSec % 60;
  let secInt = Math.floor(secTotal);
  let hundredths = Math.round((secTotal - secInt) * 100);

  // 防呆進位
  if (hundredths >= 100) {
    secInt += 1;
    hundredths = 0;
  }
  if (secInt >= 60) {
    min += 1;
    secInt = 0;
  }

  const secStr = secInt < 10 ? '0' + secInt : String(secInt);
  const msStr = hundredths < 10 ? '0' + hundredths : String(hundredths);

  if (min > 0) {
    return `${min}分${secStr}秒${msStr}`;
  } else {
    return `${secInt}秒${msStr}`;
  }
}

/**
 * 將字串（支援 4分15秒34、4:15.34、255.34）解析為總秒數
 */
function parseChineseTimeToSeconds(input) {
  if (!input) return null;
  input = String(input).trim();
  if (!input || input === '--') return null;

  // 格式 1: "4分15秒34" 或 "4分15秒34毫秒"
  let m = input.match(/^(\d+)\s*分\s*(\d+)(?:[.\s秒]+(\d+))?$/);
  if (m) {
    const min = parseInt(m[1], 10);
    const sec = parseInt(m[2], 10);
    let ms = 0;
    if (m[3]) {
      ms = parseFloat('0.' + m[3]);
    }
    return min * 60 + sec + ms;
  }

  // 格式 2: "4分15.34" 或 "4分15.34秒"
  m = input.match(/^(\d+)\s*分\s*([\d.]+)\s*秒?$/);
  if (m) {
    const min = parseInt(m[1], 10);
    const sec = parseFloat(m[2]);
    return min * 60 + sec;
  }

  // 格式 3: "4:15.34" 或 "04:15.34"
  if (input.includes(':')) {
    const parts = input.split(':');
    const min = parseFloat(parts[0]);
    const sec = parseFloat(parts[1]);
    if (!isNaN(min) && !isNaN(sec)) {
      return min * 60 + sec;
    }
  }

  // 格式 4: "12秒35"
  m = input.match(/^(\d+)\s*秒\s*(\d+)$/);
  if (m) {
    const sec = parseInt(m[1], 10);
    const ms = parseFloat('0.' + m[2]);
    return sec + ms;
  }

  // 格式 5: 純秒數 "255.34" 或 "12.35"
  const pure = parseFloat(input);
  return isNaN(pure) ? null : pure;
}

/**
 * 將總秒數拆分為分與秒（供後台輸入框預填）
 */
function splitSecondsToMinSec(totalSec) {
  if (totalSec === null || totalSec === undefined || isNaN(totalSec) || totalSec <= 0) {
    return { min: '', sec: '' };
  }
  const min = Math.floor(totalSec / 60);
  const secTotal = totalSec % 60;
  const sec = secTotal.toFixed(2);
  const secStr = secTotal < 10 ? '0' + sec : sec;
  return {
    min: min > 0 ? String(min) : '',
    sec: secStr
  };
}

function parseDistanceInput(val) {
  if (!val) return null;
  val = String(val).trim().toUpperCase();
  if (['X', 'F', 'NM', 'DNS', '棄權', '犯規'].includes(val)) return null;

  const num = parseFloat(val);
  return isNaN(num) ? null : num;
}

// ==========================================
// 3. 核心競賽規則與計算演算法 (Scoring Algorithms)
// ==========================================

/**
 * 輔助函式：判斷是否為體育班 (716, 816, 916)
 * 班級結尾為 16 均為體育班，其餘 01~15 均為普通班
 */
function isSportsClass(item) {
  if (!item) return false;
  if (item.isSportsClass === true) return true;
  const rawId = String(item.classNo || item.classId || '').trim();
  const digits = rawId.replace(/[^0-9]/g, '');
  if (digits.endsWith('16') || digits === '716' || digits === '816' || digits === '916') return true;
  return false;
}

/**
 * 通用排名計算函式（體育班特殊並列保障規則 - 支援單項賽事體育班多人參賽並列保障）
 * isHigherBetter: 田賽(鉛球/跳遠)=true(數值大勝)；徑賽(跑步/接力)=false(秒數少勝)
 */
function calculateEventWithMultiplePERule(athletes, isHigherBetter = true) {
  // 1. 取得有效成績 (兼容 a.score、a.bestDistance、a.finalSeconds)
  athletes.forEach(a => {
    if (a.score === undefined || a.score === null) {
      if (a.bestDistance !== undefined && a.bestDistance !== null) a.score = a.bestDistance;
      else if (a.finalSeconds !== undefined && a.finalSeconds !== null) a.score = a.finalSeconds;
    }
    if (a.classNo === undefined && a.classId !== undefined) a.classNo = a.classId;
    if (a.classId === undefined && a.classNo !== undefined) a.classId = a.classNo;
  });

  const valid = athletes.filter(a => a.score !== null && !isNaN(a.score) && a.score > 0);
  
  // 區分普通班與體育班
  const getClassStr = a => String(a.classNo || a.classId || '').trim();
  const normal = valid.filter(a => !getClassStr(a).endsWith('16'));
  const pe = valid.filter(a => getClassStr(a).endsWith('16'));

  // 2. 普通班先獨立排序並賦予基準名次 (1, 2, 3...)
  if (isHigherBetter) {
    normal.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.secondBestVal !== undefined && a.secondBestVal !== undefined && b.secondBestVal !== a.secondBestVal) {
        return b.secondBestVal - a.secondBestVal;
      }
      if (b.thirdBestVal !== undefined && a.thirdBestVal !== undefined && b.thirdBestVal !== a.thirdBestVal) {
        return b.thirdBestVal - a.thirdBestVal;
      }
      return 0;
    });
    pe.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.secondBestVal !== undefined && a.secondBestVal !== undefined && b.secondBestVal !== a.secondBestVal) {
        return b.secondBestVal - a.secondBestVal;
      }
      if (b.thirdBestVal !== undefined && a.thirdBestVal !== undefined && b.thirdBestVal !== a.thirdBestVal) {
        return b.thirdBestVal - a.thirdBestVal;
      }
      return 0;
    });
  } else {
    normal.sort((a, b) => a.score - b.score);
    pe.sort((a, b) => a.score - b.score);
  }

  // 設定普通班基礎名次 (名次固定，絕對不可被體育班選手擠壓退後)
  normal.forEach((item, idx) => {
    item.rank = idx + 1;
    item.rankNumber = idx + 1;
    item.rankText = `第 ${idx + 1} 名`;
    item.isSportsClass = false;
    item.isTiedWithSports = false;
  });

  // 3. 處理體育班比對並列
  // 若體育班有多人且成績都高於普通班第一名：
  // pe[0] 並列第 1 名，pe[1] 並列第 2 名，以此類推
  pe.forEach((peAthlete, peIdx) => {
    peAthlete.isSportsClass = true;
    if (normal.length === 0) {
      peAthlete.rank = peIdx + 1;
      peAthlete.rankNumber = peIdx + 1;
      peAthlete.rankText = `第 ${peIdx + 1} 名`;
      peAthlete.isTiedWithSports = false;
      return;
    }

    const peScore = peAthlete.score;
    const top1Normal = normal[0];
    const isPeBetterThanTop1 = isHigherBetter 
      ? (peScore >= top1Normal.score) 
      : (peScore <= top1Normal.score);

    if (isPeBetterThanTop1) {
      // 若體育班第 1 人比普通班第 1 名好 -> 並列第 1 名
      if (peIdx === 0) {
        peAthlete.rank = 1;
        peAthlete.rankNumber = 1;
        peAthlete.rankText = '並列第 1 名';
        peAthlete.isTiedWithSports = true;
        top1Normal.rank = 1;
        top1Normal.rankNumber = 1;
        top1Normal.rankText = '並列第 1 名';
        top1Normal.isTiedWithSports = true;
      } else {
        // 體育班第 2 人如果也比普通班第 1 名好，依照規則與普通班第 2 名【並列第 2 名】
        const targetNormalRank = peIdx + 1;
        peAthlete.rank = targetNormalRank;
        peAthlete.rankNumber = targetNormalRank;
        peAthlete.rankText = `並列第 ${targetNormalRank} 名`;
        peAthlete.isTiedWithSports = true;
        if (normal[peIdx]) {
          normal[peIdx].rank = targetNormalRank;
          normal[peIdx].rankNumber = targetNormalRank;
          normal[peIdx].rankText = `並列第 ${targetNormalRank} 名`;
          normal[peIdx].isTiedWithSports = true;
        }
      }
    } else {
      // 體育班成績未超越普通班第一名，落入一般區間比對
      let matched = false;
      for (let i = 1; i < normal.length; i++) {
        const prev = normal[i - 1];
        const curr = normal[i];
        const isBetween = isHigherBetter
          ? (peScore <= prev.score && peScore >= curr.score)
          : (peScore >= prev.score && peScore <= curr.score);

        if (isBetween) {
          const targetRank = i + 1;
          peAthlete.rank = targetRank;
          peAthlete.rankNumber = targetRank;
          peAthlete.rankText = `並列第 ${targetRank} 名`;
          peAthlete.isTiedWithSports = true;
          curr.rank = targetRank;
          curr.rankNumber = targetRank;
          curr.rankText = `並列第 ${targetRank} 名`;
          curr.isTiedWithSports = true;
          matched = true;
          break;
        }
      }
      if (!matched) {
        const lastRank = normal.length + peIdx + 1;
        peAthlete.rank = lastRank;
        peAthlete.rankNumber = lastRank;
        peAthlete.rankText = `第 ${lastRank} 名`;
        peAthlete.isTiedWithSports = false;
      }
    }
  });

  // 4. 依名次合併輸出
  return [...normal, ...pe].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    // 同名次時（並列），成績較優者列前
    if (b.score !== a.score) return isHigherBetter ? (b.score - a.score) : (a.score - b.score);
    // 同成績同名次時，體育班列前或按組別道次排序
    if (a.isSportsClass && !b.isSportsClass) return -1;
    if (!a.isSportsClass && b.isSportsClass) return 1;
    const heatStrA = String(a.heat || a.flight || '第 1 組');
    const heatStrB = String(b.heat || b.flight || '第 1 組');
    const numA = parseInt(heatStrA.replace(/\D/g, ''), 10) || 1;
    const numB = parseInt(heatStrB.replace(/\D/g, ''), 10) || 1;
    if (numA !== numB) return numA - numB;
    const laneA = parseInt(a.lane || a.order, 10) || 99;
    const laneB = parseInt(b.lane || b.order, 10) || 99;
    return laneA - laneB;
  });
}

const calculateUnifiedRankings = calculateEventWithMultiplePERule;
const applySportsClassTieRanking = calculateEventWithMultiplePERule;

/**
 * 演算法 1: 大隊接力並列排序演算法
 * 普通班獨立排 1~15 名。體育班成績比普通班第 1 名快或相等則「並列第一」，普通班第 2 名維持第二，順位不擠壓；以此類推。
 */
function computeGrandRelayRanks(entries) {
  const list = JSON.parse(JSON.stringify(entries));
  
  // 計算最終時間：原始秒數 + 犯規次數 * 5
  list.forEach(item => {
    item.classNo = item.classNo || item.classId;
    item.isSportsClass = String(item.classNo || '').endsWith('16');
    let raw = parseChineseTimeToSeconds(item.rawScore);
    const fouls = parseInt(item.foulCount) || 0;
    if (raw !== null && !isNaN(raw) && raw > 0) {
      item.rawSeconds = raw;
      item.formattedRaw = formatSecondsToChinese(raw);
      item.finalSeconds = raw + fouls * 5;
      item.formattedFinal = formatSecondsToChinese(item.finalSeconds);
      item.score = item.finalSeconds;
    } else {
      item.rawSeconds = null;
      item.formattedRaw = '--';
      item.finalSeconds = null;
      item.formattedFinal = '--';
      item.score = null;
    }
  });

  const valid = list.filter(x => x.score !== null);
  const unranked = list.filter(x => x.score === null);
  unranked.forEach(x => {
    x.rank = 999;
    x.rankNumber = 999;
    x.rankText = '未出賽/未完賽';
    x.isSportsClass = String(x.classNo || x.classId || '').endsWith('16');
    x.isTiedWithSports = false;
  });

  const ranked = calculateUnifiedRankings(valid, false);
  return [...ranked, ...unranked];
}

/**
 * 演算法 2: 田賽（鉛球、跳遠）三次試擲/試跳最佳成績計算與體育班並列排序
 */
function computeFieldEventRanks(entries) {
  const list = JSON.parse(JSON.stringify(entries));

  list.forEach(item => {
    item.classNo = item.classNo || item.classId;
    item.isSportsClass = String(item.classNo || '').endsWith('16');
    const a1 = parseDistanceInput(item.att1);
    const a2 = parseDistanceInput(item.att2);
    const a3 = parseDistanceInput(item.att3);
    item.numAtt1 = a1;
    item.numAtt2 = a2;
    item.numAtt3 = a3;

    const validAtts = [a1, a2, a3].filter(v => v !== null && v > 0);
    if (validAtts.length > 0) {
      item.bestDistance = Math.max(...validAtts);
      item.formattedBest = item.bestDistance.toFixed(2) + ' 公尺';
      item.score = item.bestDistance;

      // 拆解三次有效成績並降冪排序：[第1佳, 第2佳(次佳), 第3佳]
      const sorted = [a1 || 0, a2 || 0, a3 || 0].sort((x, y) => y - x);
      item.bestVal = sorted[0] || 0;
      item.secondBestVal = sorted[1] || 0;
      item.thirdBestVal = sorted[2] || 0;
      item.secondBestStr = item.secondBestVal > 0 ? item.secondBestVal.toFixed(2) + 'm' : '無';
    } else {
      item.bestDistance = null;
      item.formattedBest = item.att1 || item.att2 || item.att3 ? '無有效成績 (X)' : '--';
      item.score = null;
      item.bestVal = 0;
      item.secondBestVal = 0;
      item.thirdBestVal = 0;
      item.secondBestStr = '無';
    }
    item.tieNote = '';
    item.isTieBroken = false;
  });

  const valid = list.filter(x => x.score !== null);
  const unranked = list.filter(x => x.score === null);
  unranked.forEach(x => {
    x.rank = 999;
    x.rankNumber = 999;
    x.rankText = '--';
    x.isFinalist = false;
    x.isSportsClass = String(x.classNo || x.classId || '').endsWith('16');
    x.isTiedWithSports = false;
  });

  // 使用通用排名計算函式 (田賽 isHigherBetter = true)
  const ranked = calculateUnifiedRankings(valid, true);

  // 決賽優勝判定 (前 8 名優勝，含普通班前 8 名與並列之體育班選手)
  ranked.forEach(item => {
    item.isFinalist = (item.rank <= 8);
  });

  // 標記普通班同儕最佳成績相同時，依靠「第二次最好成績（次佳）」判定勝出之詳細說明
  for (let i = 0; i < ranked.length; i++) {
    const cur = ranked[i];
    const peers = ranked.filter(x => !x.isSportsClass && x.bestVal === cur.bestVal && x.bestVal > 0);
    if (!cur.isSportsClass && peers.length > 1) {
      const idxInPeers = peers.indexOf(cur);
      const nextSame = peers[idxInPeers + 1] || null;
      const prevSame = peers[idxInPeers - 1] || null;

      if (nextSame && cur.secondBestVal > nextSame.secondBestVal) {
        cur.tieNote = `💡 最佳同為 ${cur.bestDistance.toFixed(2)}m，依次佳成績 (${cur.secondBestStr} ＞ ${nextSame.secondBestStr}) 判定列前`;
        cur.isTieBroken = true;
      } else if (prevSame && cur.secondBestVal < prevSame.secondBestVal) {
        cur.tieNote = `最佳同為 ${cur.bestDistance.toFixed(2)}m，次佳成績 (${cur.secondBestStr} ＜ ${prevSame.secondBestStr}) 列後`;
        cur.isTieBroken = true;
      } else if (nextSame && cur.secondBestVal === nextSame.secondBestVal && cur.thirdBestVal > nextSame.thirdBestVal) {
        cur.tieNote = `💡 最佳與次佳皆同，依第三成績 (${cur.thirdBestVal.toFixed(2)}m ＞ ${nextSame.thirdBestVal.toFixed(2)}m) 判定列前`;
        cur.isTieBroken = true;
      }
    }
  }

  return [...ranked, ...unranked];
}

function formatFieldAttempt(attStr, numVal, bestVal, secondBestVal, isTieBroken) {
  if (!attStr || attStr === '--') return '--';
  const trimmed = String(attStr).trim();
  if (trimmed === 'X' || trimmed === 'x' || trimmed === 'F' || trimmed === 'f') {
    return `<span style="color:#ef4444; font-weight:800;" title="試跳/擲犯規無效">X</span>`;
  }
  if (numVal === null || isNaN(numVal) || numVal <= 0) return attStr;

  if (numVal === bestVal && bestVal > 0) {
    return `<span style="color:#0284c7; font-weight:900; background:#e0f2fe; padding:0.18rem 0.5rem; border-radius:4px;" title="最佳成績">★ ${trimmed}m</span>`;
  }
  if (isTieBroken && numVal === secondBestVal && secondBestVal > 0) {
    return `<span style="color:#b45309; font-weight:800; background:#fef3c7; padding:0.18rem 0.5rem; border-radius:4px; border:1px solid #fde68a;" title="第二次最好成績 (次佳判定依據)">次佳 ${trimmed}m</span>`;
  }
  return `${trimmed}m`;
}

/**
 * 演算法 3: 中長跑徑賽 (800M、1500M、400M) 跨組統一計時並列排序
 */
function computeMiddleDistanceRanks(entries) {
  const list = JSON.parse(JSON.stringify(entries));

  list.forEach(item => {
    item.classNo = item.classNo || item.classId;
    item.isSportsClass = String(item.classNo || '').endsWith('16');
    const sec = parseChineseTimeToSeconds(item.score);
    if (sec !== null && sec > 0) {
      item.finalSeconds = sec;
      item.formattedFinal = formatSecondsToChinese(sec);
      item.score = sec;
    } else {
      item.finalSeconds = null;
      item.formattedFinal = item.score || '--';
      item.score = null;
    }
  });

  const valid = list.filter(x => x.score !== null);
  const unranked = list.filter(x => x.score === null);
  unranked.forEach(x => {
    x.rank = 999;
    x.rankNumber = 999;
    x.rankText = '--';
    x.isTop8 = false;
    x.isSportsClass = String(x.classNo || x.classId || '').endsWith('16');
    x.isTiedWithSports = false;
  });

  const ranked = calculateUnifiedRankings(valid, false);
  ranked.forEach(item => {
    item.isTop8 = (item.rank <= 8);
  });

  return [...ranked, ...unranked];
}

/**
 * 演算法 4: 短跑預賽 (100M、200M) 體育班並列與晉級計算
 * 普通班前 12 名保證晉級決賽 (Q)，第 13、14 名標示候補 1、候補 2 (R1, R2)
 * 體育班若並列前 12 名亦獲晉級決賽 (Q)，絕不擠佔普通班之 12 個名額！
 */
function computeSprintRanks(entries) {
  const list = JSON.parse(JSON.stringify(entries));

  list.forEach(item => {
    item.classNo = item.classNo || item.classId;
    item.isSportsClass = String(item.classNo || '').endsWith('16');
    const sec = parseChineseTimeToSeconds(item.score);
    if (sec !== null && sec > 0) {
      item.finalSeconds = sec;
      item.formattedFinal = formatSecondsToChinese(sec);
      item.score = sec;
    } else {
      item.finalSeconds = null;
      item.formattedFinal = item.score || '--';
      item.score = null;
    }
  });

  const valid = list.filter(x => x.score !== null);
  const unranked = list.filter(x => x.score === null);
  unranked.forEach(x => {
    x.rank = 999;
    x.rankNumber = 999;
    x.rankText = '--';
    x.qualification = null;
    x.qualText = '';
    x.isSportsClass = String(x.classNo || x.classId || '').endsWith('16');
    x.isTiedWithSports = false;
  });

  const ranked = calculateUnifiedRankings(valid, false);

  ranked.forEach(item => {
    if (item.rank <= 12) {
      item.qualification = 'Q';
      item.qualText = '晉級決賽';
    } else if (item.rank === 13) {
      item.qualification = 'R1';
      item.qualText = '候補 1';
    } else if (item.rank === 14) {
      item.qualification = 'R2';
      item.qualText = '候補 2';
    } else {
      item.qualification = null;
      item.qualText = '';
    }
  });

  return [...ranked, ...unranked];
}

/**
 * 演算法 5: 4X200M 接力計時決賽體育班並列取前 8 名
 */
function compute4x200RelayRanks(entries) {
  const list = JSON.parse(JSON.stringify(entries));

  list.forEach(item => {
    item.classNo = item.classNo || item.classId;
    item.isSportsClass = String(item.classNo || '').endsWith('16');
    const sec = parseChineseTimeToSeconds(item.score);
    if (sec !== null && sec > 0) {
      item.finalSeconds = sec;
      item.formattedFinal = formatSecondsToChinese(sec);
      item.score = sec;
    } else {
      item.finalSeconds = null;
      item.formattedFinal = item.score || '--';
      item.score = null;
    }
  });

  const valid = list.filter(x => x.score !== null);
  const unranked = list.filter(x => x.score === null);
  unranked.forEach(x => {
    x.rank = 999;
    x.rankNumber = 999;
    x.rankText = '--';
    x.isTop8 = false;
    x.isSportsClass = String(x.classNo || x.classId || '').endsWith('16');
    x.isTiedWithSports = false;
  });

  const ranked = calculateUnifiedRankings(valid, false);
  ranked.forEach(item => {
    item.isTop8 = (item.rank <= 8);
  });

  return [...ranked, ...unranked];
}

/**
 * 演算法 6: 短跑決賽 (100M、200M 決賽) 跨組計時決賽排名與頒獎名單
 * 依決賽完賽秒數由快到慢排序，普通班取前 8 名優勝，前 3 名頒發金銀銅牌
 * 體育班若成績達標依規章並列第一、二、三名或優勝，不佔用普通班前8名配額
 */
function computeSprintFinalsRanks(entries) {
  const list = JSON.parse(JSON.stringify(entries));

  list.forEach(item => {
    item.classNo = item.classNo || item.classId;
    item.isSportsClass = String(item.classNo || '').endsWith('16');
    const sec = parseChineseTimeToSeconds(item.score);
    if (sec !== null && sec > 0) {
      item.finalSeconds = sec;
      item.formattedFinal = formatSecondsToChinese(sec);
      item.score = sec;
    } else {
      item.finalSeconds = null;
      item.formattedFinal = item.score || '--';
      item.score = null;
    }
  });

  const valid = list.filter(x => x.score !== null);
  const unranked = list.filter(x => x.score === null);
  unranked.forEach(x => {
    x.rank = 999;
    x.rankNumber = 999;
    x.rankText = '--';
    x.isTop8 = false;
    x.isFinalist = false;
    x.isSportsClass = String(x.classNo || x.classId || '').endsWith('16');
    x.isTiedWithSports = false;
  });

  const ranked = calculateUnifiedRankings(valid, false);
  ranked.forEach(item => {
    item.isTop8 = (item.rank <= 8);
    item.isFinalist = (item.rank <= 8);
  });

  return [...ranked, ...unranked];
}

// ==========================================
// 4. 前台：即時榜單與頒獎看板 (Live Leaderboard View)
// ==========================================

// 計算取得指定賽事項目、年級、組別之已排序榜單名冊（供即時榜單與正式成績單列印共用）
function getLeaderboardRankedData(event, grade, gender) {
  event = event || APP_STATE.leaderboardFilter.event || 'grandRelay';
  grade = grade || APP_STATE.leaderboardFilter.grade || '七年級';
  gender = gender || APP_STATE.leaderboardFilter.gender || 'all';

  let isSprint = (event === '100m' || event === '200m');
  let isSprintFinals = (event === '100m_finals' || event === '200m_finals');
  let isField = (event === 'shotPut' || event === 'longJump');
  let isGrandRelay = (event === 'grandRelay');
  let is4x200 = (event === 'relay4x200');

  let rawList = [];
  if (isGrandRelay) rawList = APP_STATE.data.events.grandRelay;
  else if (is4x200) rawList = APP_STATE.data.events.relay4x200;
  else if (event === '100m') rawList = APP_STATE.data.events.e100m;
  else if (event === '200m') rawList = APP_STATE.data.events.e200m;
  else if (event === '100m_finals') rawList = APP_STATE.data.events.e100m_finals || [];
  else if (event === '200m_finals') rawList = APP_STATE.data.events.e200m_finals || [];
  else if (event === '400m') rawList = APP_STATE.data.events.e400m;
  else if (event === '800m') rawList = APP_STATE.data.events.e800m;
  else if (event === '1500m') rawList = APP_STATE.data.events.e1500m;
  else if (event === 'shotPut') rawList = APP_STATE.data.events.shotPut;
  else if (event === 'longJump') rawList = APP_STATE.data.events.longJump;

  // 篩選年級與性別 (大隊接力不分男女)
  let filtered = rawList;
  if (grade !== 'all') {
    filtered = filtered.filter(x => x.grade === grade);
  }
  if (gender !== 'all' && !isGrandRelay) {
    filtered = filtered.filter(x => x.gender === gender);
  }

  // 依不同項目執行計算排名（保障各年級獨立排定名次，嚴禁跨年級混班跨級競爭）
  let displayData = [];
  if (grade === 'all') {
    const grades = ['七年級', '八年級', '九年級'];
    grades.forEach(gr => {
      const grFiltered = filtered.filter(x => x.grade === gr);
      if (grFiltered.length > 0) {
        let grRanked = [];
        if (isGrandRelay) grRanked = computeGrandRelayRanks(grFiltered);
        else if (isField) grRanked = computeFieldEventRanks(grFiltered);
        else if (isSprint) grRanked = computeSprintRanks(grFiltered);
        else if (isSprintFinals) grRanked = computeSprintFinalsRanks(grFiltered);
        else if (is4x200) grRanked = compute4x200RelayRanks(grFiltered);
        else grRanked = computeMiddleDistanceRanks(grFiltered);
        displayData.push(...grRanked);
      }
    });
  } else {
    if (isGrandRelay) {
      displayData = computeGrandRelayRanks(filtered);
    } else if (isField) {
      displayData = computeFieldEventRanks(filtered);
    } else if (isSprint) {
      displayData = computeSprintRanks(filtered);
    } else if (isSprintFinals) {
      displayData = computeSprintFinalsRanks(filtered);
    } else if (is4x200) {
      displayData = compute4x200RelayRanks(filtered);
    } else {
      displayData = computeMiddleDistanceRanks(filtered);
    }
  }

  return displayData;
}

function renderLeaderboard() {
  if (APP_STATE.leaderboardFilter.subTab === 'points') {
    renderClassPointsView();
    return;
  }

  const container = document.getElementById('leaderboard-content');
  if (!container) return;

  const { event, grade, gender, sprintView } = APP_STATE.leaderboardFilter;

  let isSprint = (event === '100m' || event === '200m');
  let isSprintFinals = (event === '100m_finals' || event === '200m_finals');
  let isField = (event === 'shotPut' || event === 'longJump');
  let isGrandRelay = (event === 'grandRelay');
  let is4x200 = (event === 'relay4x200');

  const displayData = getLeaderboardRankedData(event, grade, gender);

  let html = '';

  // 1. 頒獎台看板 (Podium)：若目前項目已有有效成績，依成績名次動態呈現頒獎台；若無成績，完全保留空白不顯示頒獎台
  const hasScores = displayData.some(x => hasValidAthleteScore(x));
  const podiumTop3 = hasScores ? displayData.filter(x => x.rankNumber <= 3 && hasValidAthleteScore(x)) : [];
  if (podiumTop3.length > 0 && grade !== 'all') {
    html += renderPodiumSection(podiumTop3, isField);
  }

  // 2. 說明提醒橫幅
  if (isGrandRelay) {
    html += `
      <div class="alert-banner">
        <div class="alert-icon">⚖️</div>
        <div class="alert-content">
          <h4>大隊接力並列排序規範</h4>
          <p>普通班（701~715、801~815、901~915）彼此獨立排序；體育班（716、816、916）若比普通班第 1 名快（或相等）則<strong>並列第一名</strong>，普通班第 2 名維持第二名，其餘順位不遞移；每次犯規加罰 5 秒。成績顯示如：<strong>4分15秒34</strong>。</p>
        </div>
      </div>
    `;
  } else if (isSprint) {
    html += `
      <div class="alert-banner alert-info">
        <div class="alert-icon">⚡</div>
        <div class="alert-content">
          <h4>短跑預賽晉級規範</h4>
          <p>跨組依成績秒數升冪排序，<strong>取前 12 名晉級決賽 (Q)</strong>，第 13、14 名標示<strong>候補 1 (R1)、候補 2 (R2)</strong>。可切換「跨組總排行」或「分組檢視」以利裁判順道次登記。</p>
        </div>
      </div>
    `;
  } else if (isSprintFinals) {
    html += `
      <div class="alert-banner alert-info" style="border-left-color:#f59e0b; background:#fffbeb;">
        <div class="alert-icon">🏆</div>
        <div class="alert-content">
          <h4 style="color:#b45309;">短跑決賽（100M / 200M）競賽與優勢道次規範</h4>
          <p style="color:#78350f;">由預賽跨組總排名前 12 名選手組成：<strong>第 1 組為預賽第 7~12 名、第 2 組為預賽第 1~6 名</strong>，各組依預賽名次排定優勢跑道（組內第 1 名排第 3 道、第 2 名排第 4 道、第 3 名排第 5 道、第 4 名排第 2 道、第 5 名排第 6 道、第 6 名排第 1 道）。決賽以秒數升冪決定最終前 8 名優勝，前 3 名頒發金銀銅牌。</p>
        </div>
      </div>
    `;
  } else if (isField) {
    html += `
      <div class="alert-banner alert-info">
        <div class="alert-icon">📏</div>
        <div class="alert-content">
          <h4>田賽（鉛球、跳遠）成績判定規則</h4>
          <p>每位選手有 3 次試擲 / 試跳機會，以 3 次中之「最佳成績」決定名次（決賽直接取前 8 名優勝）。<strong>若兩位選手最佳成績相同，系統自動比對「第二次最好成績（次佳成績）」較遠者名次列前</strong>；若次佳成績仍相同，則比對第三次成績判定。</p>
        </div>
      </div>
    `;
  }

  // 3. 視角切換器與操作工具列
  if (isSprint) {
    const prelimEvt = event;
    const finalsEvt = event + '_finals';
    html += `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; flex-wrap:wrap; gap:0.5rem;">
        <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
          <span style="font-weight:800; color:var(--text-muted);">預賽榜單視角：</span>
          <button class="btn btn-sm ${sprintView === 'ranking' ? 'btn-primary' : 'btn-secondary'}" onclick="setSprintView('ranking')">
            🏁 跨組總排行檢視 (亮綠晉級名冊)
          </button>
          <button class="btn btn-sm ${sprintView === 'heats' ? 'btn-primary' : 'btn-secondary'}" onclick="setSprintView('heats')">
            📋 依組別道次檢視 (裁判分組登記)
          </button>
        </div>
        <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
          <button class="btn btn-sm btn-secondary" onclick="setLeaderboardEvent('${finalsEvt}')" style="background:#e0f2fe; color:#0369a1; border:1px solid #7dd3fc; font-weight:800;" title="切換至該項目的決賽名單與成績看板">
            🏆 檢視決賽名單與成績
          </button>
        </div>
      </div>
    `;
  } else if (isSprintFinals) {
    const prelimEvt = event.replace('_finals', '');
    html += `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; flex-wrap:wrap; gap:0.5rem;">
        <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
          <span style="font-weight:800; color:var(--text-muted);">決賽榜單視角：</span>
          <button class="btn btn-sm ${sprintView === 'ranking' ? 'btn-primary' : 'btn-secondary'}" onclick="setSprintView('ranking')">
            🏁 決賽總成績排名 (前8名頒獎看板)
          </button>
          <button class="btn btn-sm ${sprintView === 'heats' ? 'btn-primary' : 'btn-secondary'}" onclick="setSprintView('heats')">
            📋 依決賽組別道次檢視 (第1組/第2組)
          </button>
        </div>
        <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
          <button class="btn btn-sm btn-secondary" onclick="setLeaderboardEvent('${prelimEvt}')" style="background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; font-weight:800;" title="切換回預賽成績排行榜">
            💨 返回預賽榜單
          </button>
        </div>
      </div>
    `;
  }

  // 4. 榜單表格
  if ((isSprint || isSprintFinals) && sprintView === 'heats') {
    html += renderSprintHeatsTable(displayData);
  } else {
    html += renderStandardLeaderboardTable(displayData, { isGrandRelay, isField, isSprint, isSprintFinals, is4x200 });
  }

  container.innerHTML = html;
}

function getPodiumAthleteText(item) {
  if (!item) return '';
  // 大隊接力項目：統一固定顯示「大隊接力」（依使用者需求替換舊版之全班接力代表隊/體育班代表隊）
  if (item.event === '大隊接力' || item.eventName === '大隊接力' || (item.id && (String(item.id).startsWith('RELAY_') || String(item.id).startsWith('GR_')))) {
    return '大隊接力';
  }
  // 4x200M 接力項目：統一固定顯示「4X200M 接力」
  if (item.event === '4X200M接力' || item.event === '4X200M 接力' || item.eventName === '4X200M 接力' || (item.id && String(item.id).startsWith('4X200_'))) {
    return '4X200M 接力';
  }
  // 個人田徑項目：優先顯示「座號 + 姓名」
  if (item.name) {
    return (item.bib ? item.bib + ' ' : '') + item.name;
  }
  return item.event || '';
}

function renderPodiumSection(podiumWinners, isField) {
  if (!podiumWinners || podiumWinners.length === 0) return '';

  // 動態排序所有獲獎選手（不寫死 3 張卡片，並列第一時動態擴增為 4 張卡片完整呈現）
  const sorted = [...podiumWinners].sort((a, b) => {
    if (a.rankNumber !== b.rankNumber) return a.rankNumber - b.rankNumber;
    if (a.isSportsClass && !b.isSportsClass) return -1;
    if (!a.isSportsClass && b.isSportsClass) return 1;
    return 0;
  });

  let html = `<div class="podium-container">`;

  sorted.forEach(item => {
    let cardClass = 'podium-bronze';
    let medalEmoji = '🥉';
    let defaultRankText = '第 3 名';

    // 獎牌徽章與背景樣式判斷
    if (item.rankNumber === 1) {
      cardClass = 'podium-gold';
      medalEmoji = '🥇';
      defaultRankText = item.isTiedWithSports ? (item.isSportsClass ? '並列第 1 名 (體育班)' : '並列第 1 名') : '第 1 名';
    } else if (item.rankNumber === 2) {
      cardClass = 'podium-silver';
      medalEmoji = '🥈';
      defaultRankText = item.isTiedWithSports ? (item.isSportsClass ? '並列第 2 名 (體育班)' : '並列第 2 名') : '第 2 名';
    } else if (item.rankNumber === 3) {
      cardClass = 'podium-bronze';
      medalEmoji = '🥉';
      defaultRankText = item.isTiedWithSports ? (item.isSportsClass ? '並列第 3 名 (體育班)' : '並列第 3 名') : '第 3 名';
    }

    const rankText = item.rankText || defaultRankText;
    const scoreText = isField ? item.formattedBest : item.formattedFinal;

    html += `
      <div class="podium-card ${cardClass}">
        <div class="podium-medal">${medalEmoji}</div>
        <div class="podium-rank-text">${rankText}</div>
        <div class="podium-team">
          ${item.classId ? item.classId + ' 班' : ''}
          ${item.isSportsClass ? '<span class="badge badge-sports" style="font-size:0.75rem; vertical-align:middle; margin-left:0.35rem;">體育班</span>' : ''}
        </div>
        <div class="podium-athlete">${getPodiumAthleteText(item)}</div>
        <div class="podium-score">${scoreText}</div>
        <div style="margin-top:0.45rem; display:flex; justify-content:center; gap:0.35rem; flex-wrap:wrap;">
          ${item.isSportsClass ? '<span class="badge badge-sports">體育班</span>' : ''}
          ${item.isTiedWithSports ? '<span class="badge badge-tied">並列</span>' : ''}
          ${isField && item.isTieBroken && item.tieNote && item.tieNote.startsWith('💡') ? `<span class="badge" style="background:#fef3c7; color:#b45309; border:1px solid #fde68a; font-size:0.75rem;">💡 次佳成績判定勝出</span>` : ''}
        </div>
      </div>
    `;
  });

  html += `</div>`;
  return html;
}

function renderStandardLeaderboardTable(data, flags) {
  const { isGrandRelay, isField, isSprint, isSprintFinals, is4x200 } = flags;

  let html = `
    <div class="table-responsive">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:70px; text-align:center;">名次</th>
            ${isGrandRelay ? '<th>參賽年級</th>' : '<th>年級組別</th>'}
            <th>班級</th>
            ${!isGrandRelay && !is4x200 ? '<th>座號/姓名</th>' : ''}
            ${!isField ? '<th>組別/道次</th>' : '<th>出場順序</th>'}
            ${isGrandRelay ? '<th>原始成績 (如: 4分15秒34)</th><th>犯規加罰 (+5秒/次)</th><th>最終成績</th>' : ''}
            ${isField ? '<th style="text-align:center;">第1次試跳/擲</th><th style="text-align:center;">第2次試跳/擲</th><th style="text-align:center;">第3次試跳/擲</th><th style="text-align:center;">有效最佳成績</th>' : ''}
            ${!isGrandRelay && !isField ? (isSprintFinals ? '<th>決賽成績</th>' : '<th>比賽成績</th>') : ''}
            <th style="text-align:center;">狀態標籤 / 備註</th>
          </tr>
        </thead>
        <tbody>
  `;

  if (data.length === 0) {
    html += `<tr><td colspan="9" style="text-align:center; padding:2rem; color:var(--text-muted);">尚無符合條件之選手或賽事資料</td></tr>`;
  } else {
    data.forEach(item => {
      let rankBadge = '';
      if (item.rankNumber === 1) {
        rankBadge = item.isTiedWithSports ? '<span class="badge badge-gold">🥇 並列 1</span>' : '<span class="badge badge-gold">🥇 1</span>';
      } else if (item.rankNumber === 2) {
        rankBadge = item.isTiedWithSports ? '<span class="badge badge-silver">🥈 並列 2</span>' : '<span class="badge badge-silver">🥈 2</span>';
      } else if (item.rankNumber === 3) {
        rankBadge = item.isTiedWithSports ? '<span class="badge badge-bronze">🥉 並列 3</span>' : '<span class="badge badge-bronze">🥉 3</span>';
      } else if (item.rankNumber <= 8) {
        rankBadge = item.isTiedWithSports ? `<strong style="color:var(--primary); font-size:1.05rem;">並列 ${item.rankNumber}</strong>` : `<strong style="color:var(--primary); font-size:1.05rem;">${item.rankNumber}</strong>`;
      } else if (item.rankNumber < 900) {
        rankBadge = item.isTiedWithSports ? `並列 ${item.rankNumber}` : item.rankNumber;
      } else {
        rankBadge = '--';
      }

      let statusBadge = '';
      if (item.isSportsClass) {
        statusBadge += '<span class="badge badge-sports">體育班</span> ';
      }
      if (item.isTiedWithSports || item.isTied) {
        statusBadge += '<span class="badge badge-tied">並列</span> ';
      }
      if (item.qualification === 'Q') {
        statusBadge += '<span class="badge badge-qualified">🟢 晉級決賽</span> ';
      } else if (item.qualification === 'R1') {
        statusBadge += '<span class="badge badge-reserve">🟡 候補 1</span> ';
      } else if (item.qualification === 'R2') {
        statusBadge += '<span class="badge badge-reserve">🟡 候補 2</span> ';
      } else if (item.isFinalist) {
        statusBadge += '<span class="badge badge-qualified">🏆 前8名優勝</span> ';
      }

      let finalSeedInfo = '';
      if (isSprintFinals && item.prelimScore) {
        finalSeedInfo = `<div style="font-size:0.78rem; color:#0369a1; font-weight:700; margin-top:2px;">預賽種子 #${item.seedRank || '-'} (${item.prelimScore})</div>`;
      }

      html += `
        <tr>
          <td style="text-align:center; font-weight:800;">${rankBadge}</td>
          <td><strong>${isGrandRelay || item.gender === '混組' || item.gender === '男女混合' ? item.grade : `${item.grade} ${item.gender}`}</strong></td>
          <td><strong>${item.classId} 班</strong></td>
          ${!isGrandRelay && !is4x200 ? `<td>${item.bib ? '<span style="color:var(--text-muted);">' + item.bib + '</span> ' : ''}${item.name}</td>` : ''}
          ${!isField ? `<td>${item.heat || ''} ${item.lane ? item.lane + '道' : ''}</td>` : `<td>${item.flight || ''} 第 ${item.order} 位</td>`}
          ${isGrandRelay ? `
            <td style="font-family:monospace; font-weight:700;">${item.formattedRaw || '--'}</td>
            <td>${item.foulCount > 0 ? '<span style="color:var(--danger); font-weight:800;">+' + (item.foulCount * 5) + '秒 (' + item.foulCount + '次)</span>' : '<span style="color:var(--text-muted);">無</span>'}</td>
            <td style="font-family:monospace; font-weight:900; font-size:1.15rem; color:#0284c7;">${item.formattedFinal}</td>
          ` : ''}
          ${isField ? `
            <td style="font-family:monospace; text-align:center;">${formatFieldAttempt(item.att1, item.numAtt1, item.bestVal, item.secondBestVal, item.isTieBroken)}</td>
            <td style="font-family:monospace; text-align:center;">${formatFieldAttempt(item.att2, item.numAtt2, item.bestVal, item.secondBestVal, item.isTieBroken)}</td>
            <td style="font-family:monospace; text-align:center;">${formatFieldAttempt(item.att3, item.numAtt3, item.bestVal, item.secondBestVal, item.isTieBroken)}</td>
            <td style="font-family:monospace; font-weight:900; font-size:1.15rem; color:#0284c7; text-align:center;">${item.formattedBest}</td>
          ` : ''}
          ${!isGrandRelay && !isField ? `
            <td style="font-family:monospace; font-weight:900; font-size:1.15rem; color:#0284c7;">${item.formattedFinal}</td>
          ` : ''}
          <td style="text-align:center;">
            ${statusBadge}
            ${finalSeedInfo}
            ${item.tieNote ? `<div style="font-size:0.8rem; color:${item.tieNote.startsWith('💡') ? '#0284c7' : '#64748b'}; font-weight:700; margin-top:0.25rem;">${item.tieNote}</div>` : ''}
            ${!statusBadge && !finalSeedInfo && !item.tieNote ? (item.remarks || '--') : ''}
          </td>
        </tr>
      `;
    });
  }

  html += `</tbody></table></div>`;
  return html;
}

function renderSprintHeatsTable(entries) {
  const heats = {};
  entries.forEach(item => {
    const h = item.heat || '未分組';
    if (!heats[h]) heats[h] = [];
    heats[h].push(item);
  });

  let html = '';
  Object.keys(heats).sort().forEach(heatKey => {
    const list = heats[heatKey];
    list.sort((a, b) => (a.lane || 0) - (b.lane || 0));

    html += `
      <div class="card" style="margin-bottom:1rem;">
        <div class="card-header">
          <div class="card-title">📌 ${heatKey}</div>
          <span style="font-size:0.85rem; color:var(--text-muted);">共 ${list.length} 位選手</span>
        </div>
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width:70px;">道次</th>
                <th>年級組別</th>
                <th>班級</th>
                <th>座號/姓名</th>
                <th>登記成績 (如: 12秒35)</th>
                <th>備註</th>
              </tr>
            </thead>
            <tbody>
    `;

    list.forEach(item => {
      const sec = parseChineseTimeToSeconds(item.score);
      const displayScore = sec ? formatSecondsToChinese(sec) : (item.score || '--');
      html += `
        <tr>
          <td><span class="badge" style="background:#e0f2fe; color:#0369a1; font-size:0.85rem;">第 ${item.lane} 道</span></td>
          <td>${item.gender === '混組' || item.gender === '男女混合' ? item.grade : `${item.grade} ${item.gender}`}</td>
          <td><strong>${item.classId} 班</strong></td>
          <td>${item.bib ? '<span style="color:var(--text-muted);">' + item.bib + '</span> ' : ''}<strong>${item.name}</strong></td>
          <td style="font-family:monospace; font-weight:900; font-size:1.1rem; color:#0284c7;">${displayScore}</td>
          <td>${item.remarks || '--'}</td>
        </tr>
      `;
    });

    html += `</tbody></table></div></div>`;
  });

  return html;
}

// 篩選按鈕操作
function setLeaderboardEvent(evt) {
  if (evt === 'classPoints') {
    setLeaderboardSubTab('points');
    return;
  }
  if (APP_STATE.leaderboardFilter.subTab === 'points') {
    setLeaderboardSubTab('events');
  }

  APP_STATE.leaderboardFilter.event = evt;
  document.querySelectorAll('#event-pills .filter-pill').forEach(el => {
    el.classList.toggle('active', el.dataset.event === evt);
  });

  // 大隊接力為全班性賽事（不分男女組別），自動隱藏性別篩選列以維持介面清爽
  const genderPills = document.getElementById('gender-pills');
  if (genderPills) {
    genderPills.style.display = (evt === 'grandRelay') ? 'none' : 'flex';
  }

  // 大隊接力、鉛球、跳遠或短跑決賽切換時，若年級或組別為全校/全部，自動切換至七年級與男生組，直接呈現該項目的頒獎台看板（避免跨年級混班）
  if ((evt === 'grandRelay' || evt === 'shotPut' || evt === 'longJump' || evt === '100m_finals' || evt === '200m_finals') && APP_STATE.leaderboardFilter.grade === 'all') {
    APP_STATE.leaderboardFilter.grade = '七年級';
    document.querySelectorAll('#grade-pills .filter-pill').forEach(el => {
      el.classList.toggle('active', el.dataset.grade === '七年級');
    });
  }
  if ((evt === 'shotPut' || evt === 'longJump' || evt === '100m_finals' || evt === '200m_finals') && APP_STATE.leaderboardFilter.gender === 'all') {
    APP_STATE.leaderboardFilter.gender = '男生組';
    document.querySelectorAll('#gender-pills .filter-pill').forEach(el => {
      el.classList.toggle('active', el.dataset.gender === '男生組');
    });
  }

  saveUserViewSession();
  renderLeaderboard();
}

function setLeaderboardGrade(gr) {
  APP_STATE.leaderboardFilter.grade = gr;
  document.querySelectorAll('#grade-pills .filter-pill').forEach(el => {
    el.classList.toggle('active', el.dataset.grade === gr);
  });
  // 若切換年級，同步更新班級積分查詢預設班級
  if (gr === '七年級' && APP_STATE.leaderboardFilter.selectedClass && !APP_STATE.leaderboardFilter.selectedClass.startsWith('7') && !APP_STATE.leaderboardFilter.selectedClass.startsWith('all-')) {
    APP_STATE.leaderboardFilter.selectedClass = '701';
  } else if (gr === '八年級' && APP_STATE.leaderboardFilter.selectedClass && !APP_STATE.leaderboardFilter.selectedClass.startsWith('8') && !APP_STATE.leaderboardFilter.selectedClass.startsWith('all-')) {
    APP_STATE.leaderboardFilter.selectedClass = '801';
  } else if (gr === '九年級' && APP_STATE.leaderboardFilter.selectedClass && !APP_STATE.leaderboardFilter.selectedClass.startsWith('9') && !APP_STATE.leaderboardFilter.selectedClass.startsWith('all-')) {
    APP_STATE.leaderboardFilter.selectedClass = '901';
  }
  saveUserViewSession();
  renderLeaderboard();
}

function setLeaderboardGender(gd) {
  APP_STATE.leaderboardFilter.gender = gd;
  document.querySelectorAll('#gender-pills .filter-pill').forEach(el => {
    el.classList.toggle('active', el.dataset.gender === gd);
  });
  saveUserViewSession();
  renderLeaderboard();
}

function setSprintView(view) {
  APP_STATE.leaderboardFilter.sprintView = view;
  renderLeaderboard();
}

function toggleProjectorMode(forceState) {
  APP_STATE.projectorMode = forceState !== undefined ? forceState : !APP_STATE.projectorMode;
  document.body.classList.toggle('projector-mode', APP_STATE.projectorMode);
  const btn = document.getElementById('btn-projector');
  if (btn) {
    btn.classList.toggle('active', APP_STATE.projectorMode);
    btn.innerHTML = APP_STATE.projectorMode ? '🖥️ 退出大螢幕模式 (Esc)' : '🖥️ 大螢幕展示模式';
  }
}

// ==========================================
// 班級運動會總積分查詢與即時重算模組 (Class Points Module)
// ==========================================

// 大會名次配分表
const CLASS_POINTS_CONFIG = {
  individual: { 1: 9, 2: 7, 3: 6, 4: 5, 5: 4, 6: 3, 7: 2, 8: 1 },
  relay: { 1: 18, 2: 14, 3: 12, 4: 10, 5: 8, 6: 6, 7: 4, 8: 2 }
};

/**
 * 遍歷所有已完賽項目前 8 名，0 延遲即時計算全校 48 班與各年級之總積分與得分履歷
 */
function calculateAllClassPointsSummary() {
  const grades = ['七年級', '八年級', '九年級'];
  const summary = {
    byClass: {},
    byGrade: {
      '七年級': [],
      '八年級': [],
      '九年級': []
    },
    allClasses: []
  };

  // 1. 初始化 48 班基本資料
  grades.forEach(gr => {
    const grNum = gr === '七年級' ? 7 : (gr === '八年級' ? 8 : 9);
    for (let c = 1; c <= 16; c++) {
      const cStr = c < 10 ? `0${c}` : `${c}`;
      const classId = `${grNum}${cStr}`;
      const isSportsClass = (c === 16);
      const classObj = {
        classId,
        grade: gr,
        isSportsClass,
        totalPts: 0,
        individualPts: 0,
        relayPts: 0,
        records: []
      };
      summary.byClass[classId] = classObj;
      summary.byGrade[gr].push(classObj);
      summary.allClasses.push(classObj);
    }
  });

  if (!APP_STATE.data || !APP_STATE.data.events) {
    return summary;
  }

  // 2. 項目定義清單
  // 大隊接力為加倍積分 (isRelay: true)；4X200M 接力依大會單項計分表 (isRelay: false)
  const eventDefs = [
    { key: 'grandRelay', isRelay: true, genders: ['all'] },
    { key: 'relay4x200', isRelay: false, genders: ['男生組', '女生組'] },
    { key: 'shotPut', isRelay: false, genders: ['男生組', '女生組'] },
    { key: 'longJump', isRelay: false, genders: ['男生組', '女生組'] },
    { key: '400m', isRelay: false, genders: ['男生組', '女生組'] },
    { key: '800m', isRelay: false, genders: ['男生組', '女生組'] },
    { key: '1500m', isRelay: false, genders: ['男生組'] },
    { key: '100m_finals_or_prelim', isSprint: true, baseKey: '100m', genders: ['男生組', '女生組'] },
    { key: '200m_finals_or_prelim', isSprint: true, baseKey: '200m', genders: ['男生組', '女生組'] }
  ];

  grades.forEach(grade => {
    // 檢查該年級大隊接力出賽班級數（規則：只要大於和等於 15 班即加倍計分；若未達 15 班則依單項 9~1 分計分）
    const grEntriesInGrade = (APP_STATE.data && APP_STATE.data.events && APP_STATE.data.events.grandRelay)
      ? APP_STATE.data.events.grandRelay.filter(x => x.grade === grade)
      : [];
    const isGrandRelayDoubled = (grEntriesInGrade.length >= 15);

    eventDefs.forEach(def => {
      def.genders.forEach(gender => {
        let targetEventKey = def.key;
        if (def.isSprint) {
          const finalsKey = def.baseKey + '_finals';
          const finalsList = (APP_STATE.data.events && APP_STATE.data.events['e' + finalsKey]) || [];
          const hasFinalScores = finalsList.some(x => x.grade === grade && (gender === 'all' || x.gender === gender) && hasValidAthleteScore(x));
          targetEventKey = hasFinalScores ? finalsKey : def.baseKey;
        }

        const rankedData = getLeaderboardRankedData(targetEventKey, grade, gender);
        if (!rankedData || rankedData.length === 0) return;

        rankedData.forEach(item => {
          if (!hasValidAthleteScore(item)) return;
          const rankNum = item.rankNumber;
          if (!rankNum || rankNum < 1 || rankNum > 8) return;

          // 判斷是否加倍計分：
          // 1. 大隊接力 (grandRelay) 只要大於和等於 15 班加倍計分 (18, 14, 12, 10, 8, 6, 4, 2 分)
          // 2. 個人單項與 800M 接力 (4x200m) 前 8 名均為 (9, 7, 6, 5, 4, 3, 2, 1 分)
          const isItemRelayDoubled = (targetEventKey === 'grandRelay' && isGrandRelayDoubled);
          const ptsConfig = isItemRelayDoubled ? CLASS_POINTS_CONFIG.relay : CLASS_POINTS_CONFIG.individual;
          const pts = ptsConfig[rankNum] || 0;
          if (pts <= 0) return;

          const cid = String(item.classId || item.classNo || '').trim();
          const targetClass = summary.byClass[cid];
          if (!targetClass) return;

          if (targetEventKey === 'grandRelay') {
            targetClass.relayPts += pts;
          } else {
            targetClass.individualPts += pts;
          }
          targetClass.totalPts += pts;

          const athleteName = item.name ? (item.bib ? `${item.bib}號 ${item.name}` : item.name) : `${cid}班代表隊`;
          let scoreDisp = '--';
          if (targetEventKey === 'shotPut' || targetEventKey === 'longJump') {
            scoreDisp = item.formattedBest || (item.best ? `${item.best} 公尺` : (item.bestDistance ? `${item.bestDistance} 公尺` : '--'));
          } else if (targetEventKey === 'grandRelay') {
            scoreDisp = item.formattedFinal || (item.finalSeconds ? formatSecondsToChinese(item.finalSeconds) : (item.rawScore || '--'));
          } else {
            scoreDisp = item.formattedFinal || (item.score ? (parseChineseTimeToSeconds(item.score) ? formatSecondsToChinese(parseChineseTimeToSeconds(item.score)) : item.score) : '--');
          }

          targetClass.records.push({
            eventKey: targetEventKey,
            eventName: getEventDisplayName(targetEventKey),
            grade,
            gender: (targetEventKey === 'grandRelay') ? '全班混組' : gender,
            rankNumber: rankNum,
            rankText: item.rankText || `第 ${rankNum} 名`,
            points: pts,
            isRelay: (targetEventKey === 'grandRelay' || targetEventKey === 'relay4x200'),
            isGrandRelayDoubled: isItemRelayDoubled,
            athleteName,
            scoreDisplay: scoreDisp
          });
        });
      });
    });
  });

  // 3. 各年級班級由高分至低分排序並賦予年級排名 (Grade Rank)
  // 🌟 重要規則：體育班 (716/816/916) 獨立計算總分與履歷，但不列入普通班 (01~15班) 排名競爭
  // 普通班獨自爭奪第 1 ~ 15 名；體育班顯示為「體育班 (不列入排名)」
  grades.forEach(gr => {
    const list = summary.byGrade[gr];
    const normalClasses = list.filter(c => !c.isSportsClass);
    const peClasses = list.filter(c => c.isSportsClass);

    // 普通班依照總分由高至低排序並賦予年級排名 (1 ~ 15)
    normalClasses.sort((a, b) => {
      if (b.totalPts !== a.totalPts) return b.totalPts - a.totalPts;
      if (b.relayPts !== a.relayPts) return b.relayPts - a.relayPts;
      return parseInt(a.classId, 10) - parseInt(b.classId, 10);
    });

    normalClasses.forEach((cls, idx) => {
      if (idx > 0 && cls.totalPts === normalClasses[idx - 1].totalPts) {
        cls.gradeRank = normalClasses[idx - 1].gradeRank;
      } else {
        cls.gradeRank = idx + 1;
      }
      cls.rankText = `第 ${cls.gradeRank} 名`;
    });

    normalClasses.forEach(cls => {
      if (cls.totalPts > 0) {
        const samePts = normalClasses.filter(x => x.totalPts === cls.totalPts);
        cls.isTied = samePts.length > 1;
      } else {
        cls.isTied = false;
      }
    });

    // 體育班保留總分與明細，但標記不列入一般排名
    peClasses.forEach(cls => {
      cls.gradeRank = 999;
      cls.rankText = '體育班 (不列入排名)';
      cls.isTied = false;
    });

    // 組合結果：普通班在前 (第 1 ~ 15 名)，體育班在後
    summary.byGrade[gr] = [...normalClasses, ...peClasses];
  });

  // 4. 全校總排行排序 (同樣普通班排名 1~45，體育班獨立不列入排名)
  const normalAll = summary.allClasses.filter(c => !c.isSportsClass);
  const peAll = summary.allClasses.filter(c => c.isSportsClass);

  normalAll.sort((a, b) => {
    if (b.totalPts !== a.totalPts) return b.totalPts - a.totalPts;
    if (b.relayPts !== a.relayPts) return b.relayPts - a.relayPts;
    return parseInt(a.classId, 10) - parseInt(b.classId, 10);
  });
  normalAll.forEach((cls, idx) => {
    if (idx > 0 && cls.totalPts === normalAll[idx - 1].totalPts) {
      cls.schoolRank = normalAll[idx - 1].schoolRank;
    } else {
      cls.schoolRank = idx + 1;
    }
    cls.schoolRankText = `第 ${cls.schoolRank} 名`;
  });

  peAll.forEach(cls => {
    cls.schoolRank = 999;
    cls.schoolRankText = '體育班 (不列入排名)';
    cls.rankText = '體育班 (不列入排名)';
    cls.isTied = false;
  });

  summary.allClasses = [...normalAll, ...peAll];

  return summary;
}

/**
 * 切換即時榜單視角：各單項賽況 (events) vs 班級運動會總積分 (points)
 */
function setLeaderboardSubTab(subTab) {
  APP_STATE.leaderboardFilter.subTab = subTab;
  const eventsView = document.getElementById('leaderboard-events-view');
  const pointsView = document.getElementById('leaderboard-points-view');
  const btnEvents = document.getElementById('subtab-btn-events');
  const btnPoints = document.getElementById('subtab-btn-points');

  if (subTab === 'points') {
    if (eventsView) eventsView.style.display = 'none';
    if (pointsView) pointsView.style.display = 'block';
    if (btnEvents) {
      btnEvents.className = 'btn btn-sm btn-secondary';
      btnEvents.style.background = '#eff6ff';
      btnEvents.style.color = '#2563eb';
      btnEvents.style.border = '1px solid #bfdbfe';
    }
    if (btnPoints) {
      btnPoints.className = 'btn btn-sm btn-primary';
      btnPoints.style.background = '#2563eb';
      btnPoints.style.color = '#ffffff';
      btnPoints.style.border = 'none';
    }
    document.querySelectorAll('#event-pills .filter-pill').forEach(el => {
      el.classList.toggle('active', el.dataset.event === 'classPoints');
    });
    renderClassPointsView();
  } else {
    if (eventsView) eventsView.style.display = 'block';
    if (pointsView) pointsView.style.display = 'none';
    if (btnEvents) {
      btnEvents.className = 'btn btn-sm btn-primary';
      btnEvents.style.background = '';
      btnEvents.style.color = '';
      btnEvents.style.border = '';
    }
    if (btnPoints) {
      btnPoints.className = 'btn btn-sm btn-secondary';
      btnPoints.style.background = '#eff6ff';
      btnPoints.style.color = '#2563eb';
      btnPoints.style.border = '1px solid #bfdbfe';
    }
    document.querySelectorAll('#event-pills .filter-pill').forEach(el => {
      el.classList.toggle('active', el.dataset.event === APP_STATE.leaderboardFilter.event);
    });
    renderLeaderboard();
  }
  saveUserViewSession();
}

/**
 * 初始化班級總積分下拉選單
 */
function initClassPointsDropdown() {
  const sel = document.getElementById('class-points-select');
  if (!sel) return;
  if (sel.options.length > 0) return;

  let html = `
    <optgroup label="🏆 全學年與全校總積分榜">
      <option value="all-7">🏆 七年級班級總積分排行榜 (701~716 班)</option>
      <option value="all-8">🏆 八年級班級總積分排行榜 (801~816 班)</option>
      <option value="all-9">🏆 九年級班級總積分排行榜 (901~916 班)</option>
      <option value="all-school">🏫 全校 48 班總積分總排行榜</option>
    </optgroup>
  `;

  const grades = [
    { name: '七年級', prefix: '7' },
    { name: '八年級', prefix: '8' },
    { name: '九年級', prefix: '9' }
  ];

  grades.forEach(g => {
    html += `<optgroup label="${g.name}各班">`;
    for (let i = 1; i <= 16; i++) {
      const numStr = i < 10 ? `0${i}` : `${i}`;
      const cid = `${g.prefix}${numStr}`;
      const isSports = (i === 16);
      html += `<option value="${cid}">${cid} 班${isSports ? ' (體育班)' : ''}</option>`;
    }
    html += `</optgroup>`;
  });

  sel.innerHTML = html;
}

function onClassPointsSelectChange(val) {
  APP_STATE.leaderboardFilter.selectedClass = val;
  saveUserViewSession();
  renderClassPointsView();
}

function quickSelectClassPoints(val) {
  APP_STATE.leaderboardFilter.selectedClass = val;
  const sel = document.getElementById('class-points-select');
  if (sel) sel.value = val;
  saveUserViewSession();
  renderClassPointsView();
}

/**
 * 動態渲染班級積分查詢畫面 (含 4 大數字指標看板、得分履歷、學年總積分榜)
 */
function renderClassPointsView() {
  const container = document.getElementById('class-points-content');
  if (!container) return;

  initClassPointsDropdown();
  const sel = document.getElementById('class-points-select');

  if (!APP_STATE.leaderboardFilter.selectedClass) {
    const curGr = APP_STATE.leaderboardFilter.grade;
    if (curGr === '八年級') APP_STATE.leaderboardFilter.selectedClass = '801';
    else if (curGr === '九年級') APP_STATE.leaderboardFilter.selectedClass = '901';
    else APP_STATE.leaderboardFilter.selectedClass = '701';
  }

  if (sel && APP_STATE.leaderboardFilter.selectedClass) {
    sel.value = APP_STATE.leaderboardFilter.selectedClass;
  }

  const selected = APP_STATE.leaderboardFilter.selectedClass || '701';
  const summary = calculateAllClassPointsSummary();

  let html = '';

  // 模式 1: 全學年或全校總積分排行榜
  if (selected.startsWith('all-')) {
    let targetList = [];
    let title = '';
    let subtitle = '';

    if (selected === 'all-7') {
      targetList = summary.byGrade['七年級'];
      title = '🏆 七年級班級運動會總積分即時排行榜 (701~716 班)';
      subtitle = '普通班（701~715）依累積總積分排序競爭前三名錦旗；體育班（716）獨立累計不列入排名';
    } else if (selected === 'all-8') {
      targetList = summary.byGrade['八年級'];
      title = '🏆 八年級班級運動會總積分即時排行榜 (801~816 班)';
      subtitle = '普通班（801~815）依累積總積分排序競爭前三名錦旗；體育班（816）獨立累計不列入排名';
    } else if (selected === 'all-9') {
      targetList = summary.byGrade['九年級'];
      title = '🏆 九年級班級運動會總積分即時排行榜 (901~916 班)';
      subtitle = '普通班（901~915）依累積總積分排序競爭前三名錦旗；體育班（916）獨立累計不列入排名';
    } else {
      targetList = summary.allClasses;
      title = '🏫 全校 48 班運動會總積分即時排行榜';
      subtitle = '普通班依累積總積分排序；體育班獨立累計不列入排名';
    }

    html += `
      <div class="card" style="margin-top:0.5rem; border-color:#e2e8f0;">
        <div class="card-header" style="border-bottom:1px solid #f1f5f9; padding-bottom:0.75rem;">
          <div>
            <div class="card-title" style="font-size:1.2rem; color:#0f172a;">${title}</div>
            <div style="font-size:0.85rem; color:#64748b; margin-top:0.25rem;">${subtitle}</div>
          </div>
          <div style="display:flex; gap:0.4rem; flex-wrap:wrap;">
            <button class="btn btn-sm ${selected === 'all-7' ? 'btn-primary' : 'btn-secondary'}" onclick="quickSelectClassPoints('all-7')" style="font-size:0.82rem; font-weight:700;">七年級總榜</button>
            <button class="btn btn-sm ${selected === 'all-8' ? 'btn-primary' : 'btn-secondary'}" onclick="quickSelectClassPoints('all-8')" style="font-size:0.82rem; font-weight:700;">八年級總榜</button>
            <button class="btn btn-sm ${selected === 'all-9' ? 'btn-primary' : 'btn-secondary'}" onclick="quickSelectClassPoints('all-9')" style="font-size:0.82rem; font-weight:700;">九年級總榜</button>
            <button class="btn btn-sm ${selected === 'all-school' ? 'btn-primary' : 'btn-secondary'}" onclick="quickSelectClassPoints('all-school')" style="font-size:0.82rem; font-weight:700;">全校總排行</button>
          </div>
        </div>

        <div class="table-responsive" style="margin-top:0.85rem;">
          <table class="data-table" style="width:100%; text-align:left;">
            <thead>
              <tr style="background:#f8fafc;">
                <th style="width:110px; text-align:center;">名次</th>
                <th>班級名稱</th>
                ${selected === 'all-school' ? '<th>年級</th>' : ''}
                <th style="text-align:right;">單項累計 (含800M接力)</th>
                <th style="text-align:right;">大隊接力得分</th>
                <th style="text-align:right; width:130px;">運動會總積分</th>
                <th style="text-align:center; width:110px;">獲獎人次</th>
                <th style="text-align:center; width:130px;">得分履歷</th>
              </tr>
            </thead>
            <tbody>
    `;

    targetList.forEach((cls) => {
      const rankVal = selected === 'all-school' ? cls.schoolRank : cls.gradeRank;
      let rankBadge = '';
      if (cls.isSportsClass) {
        rankBadge = '<span class="badge badge-sports" style="font-size:0.82rem; font-weight:700;">體育班 (不列入排名)</span>';
      } else if (cls.totalPts > 0) {
        if (rankVal === 1) rankBadge = '<span class="badge badge-gold" style="font-size:0.9rem; font-weight:800;">🥇 第 1 名</span>';
        else if (rankVal === 2) rankBadge = '<span class="badge badge-silver" style="font-size:0.9rem; font-weight:800;">🥈 第 2 名</span>';
        else if (rankVal === 3) rankBadge = '<span class="badge badge-bronze" style="font-size:0.9rem; font-weight:800;">🥉 第 3 名</span>';
        else rankBadge = `<span style="font-weight:700; color:#475569; padding-left:0.4rem;">第 ${rankVal} 名</span>`;
        if (cls.isTied && selected !== 'all-school') {
          rankBadge += '<span class="badge badge-tied" style="font-size:0.72rem; margin-left:0.25rem;">並列</span>';
        }
      } else {
        rankBadge = '<span style="color:#94a3b8; font-size:0.85rem;">尚無積分</span>';
      }

      html += `
        <tr style="${!cls.isSportsClass && rankVal <= 3 && cls.totalPts > 0 ? 'background:#f0fdf4;' : ''}">
          <td style="text-align:center;">${rankBadge}</td>
          <td>
            <strong>${cls.classId} 班</strong>
            ${cls.isSportsClass ? '<span class="badge badge-sports" style="margin-left:0.35rem; font-size:0.75rem;">體育班</span>' : ''}
          </td>
          ${selected === 'all-school' ? `<td><span class="badge" style="background:#e0f2fe; color:#0369a1;">${cls.grade}</span></td>` : ''}
          <td style="text-align:right; font-weight:700; color:#4f46e5;">${cls.individualPts} 分</td>
          <td style="text-align:right; font-weight:700; color:#c2410c;">${cls.relayPts} 分</td>
          <td style="text-align:right;">
            <strong style="font-size:1.22rem; color:${cls.totalPts > 0 ? '#0284c7' : '#94a3b8'};">${cls.totalPts} <span style="font-size:0.85rem;">分</span></strong>
          </td>
          <td style="text-align:center;">
            <span class="badge" style="background:#f1f5f9; color:#475569; font-weight:700;">${cls.records.length} 項</span>
          </td>
          <td style="text-align:center;">
            <button class="btn btn-sm btn-secondary" onclick="quickSelectClassPoints('${cls.classId}')" style="padding:0.25rem 0.65rem; font-size:0.8rem; font-weight:700; background:#f0fdf4; color:#15803d; border-color:#bbf7d0;">
              🔍 查看得分履歷
            </button>
          </td>
        </tr>
      `;
    });

    html += `
            </tbody>
          </table>
        </div>
      </div>
    `;

  } else {
    // 模式 2: 單一班級詳細資訊卡片與得分履歷
    const classObj = summary.byClass[selected];
    if (!classObj) {
      container.innerHTML = `<div class="alert-banner alert-warning">查無此班級 (${selected}) 資料</div>`;
      return;
    }

    html += `
      <!-- 頂部標題列 -->
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.1rem; flex-wrap:wrap; gap:0.6rem;">
        <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
          <h3 style="margin:0; font-size:1.35rem; color:#0f172a; font-weight:900;">
            【${classObj.grade} ${classObj.classId} 班】運動會總積分看板
          </h3>
          ${classObj.isSportsClass ? '<span class="badge badge-sports" style="font-size:0.85rem; padding:0.25rem 0.65rem;">體育班</span>' : ''}
        </div>
        <button class="btn btn-sm btn-secondary" onclick="quickSelectClassPoints('all-${classObj.classId.charAt(0)}')" style="font-weight:700;">
          🏆 查看${classObj.grade}總積分榜
        </button>
      </div>

      <!-- 4 大數字指標看板 (Top Big Metric Cards) -->
      <div class="points-metrics-grid">
        <!-- 卡片 1: 目前總積分 -->
        <div class="points-metric-card card-total">
          <div class="metric-header">
            <span class="metric-icon">🏆</span>
            <span class="metric-label">目前累積總積分</span>
          </div>
          <div class="metric-value-wrap">
            <span class="metric-number">${classObj.totalPts}</span>
            <span class="metric-unit">分</span>
          </div>
          <div class="metric-footer">
            <span>單項累計 <strong>${classObj.individualPts}</strong> 分 ＋ 接力 <strong>${classObj.relayPts}</strong> 分</span>
          </div>
        </div>

        <!-- 卡片 2: 年級排名 -->
        <div class="points-metric-card card-rank">
          <div class="metric-header">
            <span class="metric-icon">📊</span>
            <span class="metric-label">${classObj.grade}即時名次</span>
          </div>
          <div class="metric-value-wrap">
            ${classObj.isSportsClass ? `
              <span class="metric-number" style="font-size:1.3rem; color:#0369a1;">體育班 (不列入排名)</span>
            ` : classObj.totalPts > 0 ? `
              <span class="metric-number">第 ${classObj.gradeRank} 名</span>
              ${classObj.isTied ? '<span class="badge badge-tied" style="font-size:0.8rem; margin-left:0.35rem;">並列</span>' : ''}
            ` : `
              <span class="metric-number" style="color:#94a3b8; font-size:1.6rem;">尚無名次</span>
            `}
          </div>
          <div class="metric-footer">
            <span>${classObj.isSportsClass ? '體育班獨立計算總分，不列入普通班年級名次競爭' : `在 ${classObj.grade} 15 個普通班中`}</span>
          </div>
        </div>

        <!-- 卡片 3: 單項累計 -->
        <div class="points-metric-card card-ind">
          <div class="metric-header">
            <span class="metric-icon">👟</span>
            <span class="metric-label">單項與 800M 接力</span>
          </div>
          <div class="metric-value-wrap">
            <span class="metric-number">${classObj.individualPts}</span>
            <span class="metric-unit">分</span>
          </div>
          <div class="metric-footer">
            <span>田徑單項前 8 名配 9~1 分</span>
          </div>
        </div>

        <!-- 卡片 4: 大隊接力得分 -->
        <div class="points-metric-card card-relay">
          <div class="metric-header">
            <span class="metric-icon">🏃</span>
            <span class="metric-label">大隊接力項目得分</span>
          </div>
          <div class="metric-value-wrap">
            <span class="metric-number">${classObj.relayPts}</span>
            <span class="metric-unit">分</span>
          </div>
          <div class="metric-footer">
            <span>${(APP_STATE.data && APP_STATE.data.events && APP_STATE.data.events.grandRelay && APP_STATE.data.events.grandRelay.filter(x => x.grade === classObj.grade).length >= 15) ? '15 班以上加倍計分 (第1名18分)' : '未達 15 班依單項計分 (第1名9分)'}</span>
          </div>
        </div>
      </div>

      <!-- 下方詳細得獎得分清單（得分履歷） -->
      <div class="card" style="border-color:#e2e8f0;">
        <div class="card-header" style="border-bottom:1px solid #f1f5f9; padding-bottom:0.75rem;">
          <div class="card-title" style="font-size:1.1rem; color:#0f172a;">
            <span>📋 【${classObj.classId} 班】得分履歷與獲獎項目明細</span>
            <span style="font-size:0.85rem; font-weight:normal; color:#64748b; margin-left:0.5rem;">
              （共獲得 <strong>${classObj.records.length}</strong> 項前 8 名優勝）
            </span>
          </div>
        </div>
    `;

    if (classObj.records.length === 0) {
      html += `
        <div style="text-align:center; padding:3rem 1.5rem; color:#64748b;">
          <div style="font-size:3rem; margin-bottom:0.6rem;">🏅</div>
          <h4 style="font-size:1.15rem; color:#334155; margin-bottom:0.4rem; font-weight:800;">目前尚無獲獎積分記錄</h4>
          <p style="font-size:0.9rem; color:#94a3b8; max-width:520px; margin:0 auto; line-height:1.6;">
            當本班選手在個人田徑單項（鉛球、跳遠、100M、200M、400M、800M、1500M）、800M 接力或大隊接力獲得前 8 名完賽成績時，系統將在此 0 延遲即時呈現得分履歷與貢獻分數。
          </p>
        </div>
      `;
    } else {
      html += `
        <div class="table-responsive" style="margin-top:0.75rem;">
          <table class="data-table" style="width:100%; text-align:left;">
            <thead>
              <tr style="background:#f8fafc;">
                <th style="width:50px; text-align:center;">#</th>
                <th>比賽項目</th>
                <th>組別</th>
                <th>獲獎選手姓名與座號</th>
                <th>獲得名次</th>
                <th>大會官方成績紀錄</th>
                <th style="text-align:center; width:130px;">貢獻積分</th>
              </tr>
            </thead>
            <tbody>
      `;

      classObj.records.forEach((rec, idx) => {
        let rankBadge = '';
        if (rec.rankNumber === 1) rankBadge = `<span class="badge badge-gold" style="font-weight:800;">🥇 ${rec.rankText}</span>`;
        else if (rec.rankNumber === 2) rankBadge = `<span class="badge badge-silver" style="font-weight:800;">🥈 ${rec.rankText}</span>`;
        else if (rec.rankNumber === 3) rankBadge = `<span class="badge badge-bronze" style="font-weight:800;">🥉 ${rec.rankText}</span>`;
        else rankBadge = `<span class="badge" style="background:#f1f5f9; color:#334155; font-weight:700;">${rec.rankText}</span>`;

        html += `
          <tr>
            <td style="text-align:center; color:#94a3b8; font-weight:700;">${idx + 1}</td>
            <td><strong>${rec.eventName}</strong></td>
            <td><span class="badge" style="background:#e0f2fe; color:#0369a1;">${rec.gender}</span></td>
            <td><strong>${rec.athleteName}</strong></td>
            <td>${rankBadge}</td>
            <td><span style="font-family:monospace; font-weight:800; color:#0f172a;">${rec.scoreDisplay}</span></td>
            <td style="text-align:center;">
              <span class="badge" style="background:#dcfce7; color:#15803d; font-weight:900; font-size:0.95rem; border:1px solid #86efac; padding:0.3rem 0.75rem;">
                +${rec.points} 分${rec.isGrandRelayDoubled ? ' <span style="font-size:0.75rem; color:#166534;">(加倍)</span>' : ''}
              </span>
            </td>
          </tr>
        `;
      });

      html += `
            </tbody>
          </table>
        </div>
      `;
    }

    html += `
      </div>
    `;
  }

  container.innerHTML = html;
}


// ==========================================
// 5. 前台：班級與賽程查詢 (Class & Schedule Search)
// ==========================================
function isSameDate(eventDate, filterDate) {
  if (!filterDate || filterDate === 'all') return true;
  if (!eventDate) return false;
  // 精準比對月與日，避免 11/2 與 11/20 等子字串誤判
  const matchEvent = eventDate.match(/(\d+)\/(\d+)/);
  const matchFilter = filterDate.match(/(\d+)\/(\d+)/);
  if (!matchEvent || !matchFilter) return eventDate.trim() === filterDate.trim();
  const mEvent = parseInt(matchEvent[1], 10);
  const dEvent = parseInt(matchEvent[2], 10);
  const mFilter = parseInt(matchFilter[1], 10);
  const dFilter = parseInt(matchFilter[2], 10);
  return mEvent === mFilter && dEvent === dFilter;
}

function initClassSearchOptions() {
  const select = document.getElementById('search-class-select');
  if (!select) return;

  let html = '';
  for (let g = 7; g <= 9; g++) {
    html += `<optgroup label="${g}年級">`;
    for (let c = 1; c <= 16; c++) {
      const cid = `${g}${c < 10 ? '0' + c : c}`;
      const isSports = (c === 16);
      html += `<option value="${cid}">${cid} 班 ${isSports ? '★體育班' : ''}</option>`;
    }
    html += `</optgroup>`;
  }
  select.innerHTML = html;
  select.value = APP_STATE.classSearch.classId;
  updateDateDropdownOptions(APP_STATE.classSearch.classId);
}

function onClassChange() {
  const classSelect = document.getElementById('search-class-select');
  if (classSelect) {
    APP_STATE.classSearch.classId = classSelect.value;
    updateDateDropdownOptions(APP_STATE.classSearch.classId);
  }
  renderClassRoster();
}

function onDateChange() {
  const dateSelect = document.getElementById('search-date-select');
  if (dateSelect) {
    APP_STATE.classSearch.date = dateSelect.value;
  }
  renderClassRoster();
}

function showAllDatesForClass() {
  APP_STATE.classSearch.date = 'all';
  const dateSelect = document.getElementById('search-date-select');
  if (dateSelect) dateSelect.value = 'all';
  renderClassRoster();
}

const ALL_MEET_DATES = [
  { val: 'all', label: '📅 全部比賽日期' },
  { val: '11/2', label: '11/2(一) - 8年級跳遠、鉛球決賽', grade: '8' },
  { val: '11/4', label: '11/4(三) - 9年級跳遠、鉛球決賽', grade: '9' },
  { val: '11/5', label: '11/5(四) - 7年級跳遠、鉛球決賽', grade: '7' },
  { val: '11/6', label: '11/6(五) - 7、8、9年級 800M決賽', grade: 'all' },
  { val: '11/10', label: '11/10(二) - 7、8、9年級 100M預賽', grade: 'all' },
  { val: '11/11', label: '11/11(三) - 7、8、9年級 200M預賽', grade: 'all' },
  { val: '11/12', label: '11/12(四) - 7、8、9年級 400M決賽', grade: 'all' },
  { val: '11/13', label: '11/13(五) - 7、8、9年級 1500M決賽', grade: 'all' },
  { val: '11/17', label: '11/17(二) - 7、8、9年級 100M/200M決賽', grade: 'all' },
  { val: '11/20', label: '11/20(五) - 7、8、9年級 4X200M接力決賽', grade: 'all' },
  { val: '12/12', label: '12/12(六) - 校慶大隊接力決賽', grade: 'all' }
];

function updateDateDropdownOptions(classId) {
  const dateSelect = document.getElementById('search-date-select');
  if (!dateSelect) return;
  const gr = classId.charAt(0);

  let html = `<option value="all">📅 全部比賽日期 (顯示 ${classId} 班全部賽程)</option>`;
  ALL_MEET_DATES.slice(1).forEach(d => {
    let hasEvent = false;
    let badge = '';
    if (d.grade === 'all' || d.grade === gr) {
      hasEvent = true;
      badge = ' ★該班有賽程';
    } else {
      badge = ' (該班無出賽)';
    }
    html += `<option value="${d.val}">${d.label}${badge}</option>`;
  });

  const curVal = APP_STATE.classSearch.date;
  dateSelect.innerHTML = html;
  dateSelect.value = curVal;
}

// 輔助函式：取得各競賽項目之統一檢錄地點規範
function getCheckinVenue(eventName) {
  const name = String(eventName || '');
  if (name.includes('鉛球') || name === 'shotPut') return '鉛球場檢錄';
  if (name.includes('跳遠') || name === 'longJump') return '跳遠場檢錄';
  return '操場檢錄';
}

// 輔助函式：取得指定班級之全賽事選手資料庫
function getClassAllAthletes(targetClass) {
  const athletes = [];

  const eventSources = [
    { key: 'e100m', name: '100公尺', round: '預賽', venue: '操場直線跑道', date: '11/10(二)', period: '第六節(女)/第七節(男)' },
    { key: 'e100m_finals', name: '100公尺', round: '決賽', venue: '操場直線跑道', date: '校慶當日', period: '決賽賽程' },
    { key: 'e200m', name: '200公尺', round: '預賽', venue: '操場跑道', date: '11/11(三)', period: '第六節(女)/第七節(男)' },
    { key: 'e200m_finals', name: '200公尺', round: '決賽', venue: '操場跑道', date: '校慶當日', period: '決賽賽程' },
    { key: 'e400m', name: '400公尺', round: '決賽', venue: '操場跑道', date: '11/12(四)', period: '第六節(女)/第七節(男)' },
    { key: 'e800m', name: '800公尺', round: '決賽', venue: '操場跑道', date: '11/6(五)', period: '第六節(女)/第七節(男)' },
    { key: 'e1500m', name: '1500公尺', round: '決賽', venue: '操場跑道', date: '11/13(五)', period: '第六/七節(男)' },
    { key: 'shotPut', name: '鉛球', round: '決賽', venue: '司令台旁鉛球場', date: getFieldDate(targetClass), period: getFieldPeriod(targetClass) },
    { key: 'longJump', name: '跳遠', round: '決賽', venue: '司令台後跳遠沙坑', date: getFieldDate(targetClass), period: getFieldPeriod(targetClass) }
  ];

  eventSources.forEach(src => {
    const list = APP_STATE.data.events[src.key] || [];
    list.filter(x => x.classId === targetClass).forEach(item => {
      let scoreDisplay = '--';
      if (src.key === 'shotPut' || src.key === 'longJump') {
        const a1 = parseDistanceInput(item.att1);
        const a2 = parseDistanceInput(item.att2);
        const a3 = parseDistanceInput(item.att3);
        const validAtts = [a1, a2, a3].filter(v => v !== null && v > 0);
        if (validAtts.length > 0) {
          scoreDisplay = Math.max(...validAtts).toFixed(2) + ' 公尺';
        } else if (item.best) {
          scoreDisplay = item.best + (String(item.best).includes('公尺') || String(item.best).includes('m') ? '' : ' 公尺');
        } else if (item.formattedBest) {
          scoreDisplay = item.formattedBest;
        } else {
          scoreDisplay = '--';
        }
      } else {
        const parsedSec = parseChineseTimeToSeconds(item.score);
        if (parsedSec) scoreDisplay = formatSecondsToChinese(parsedSec);
        else scoreDisplay = item.score || '--';
      }

      athletes.push({
        id: item.id,
        name: item.name,
        bib: item.bib,
        gender: item.gender,
        eventName: src.name,
        round: src.round,
        heatOrFlight: item.heat || item.flight || '--',
        laneOrOrder: item.lane ? `${item.lane} 道` : (item.order ? `第 ${item.order} 位` : '--'),
        date: src.date,
        period: src.period,
        venue: src.venue,
        score: scoreDisplay
      });
    });
  });

  // 4x200M 接力 (比賽日期為 11/20)
  const relay4 = APP_STATE.data.events.relay4x200.filter(x => x.classId === targetClass);
  relay4.forEach(r => {
    const parsed = parseChineseTimeToSeconds(r.score);
    athletes.push({
      id: r.id,
      name: `${targetClass} 班接力代表隊`,
      bib: '',
      gender: r.gender,
      eventName: '4X200M 接力',
      round: '計時決賽',
      heatOrFlight: r.heat,
      laneOrOrder: `${r.lane} 道`,
      date: '11/20(五)',
      period: r.gender === '女生組' ? '第六節' : '第七節',
      venue: '操場跑道',
      score: parsed ? formatSecondsToChinese(parsed) : (r.score || '--')
    });
  });

  // 大隊接力 (比賽日期為 12/12)
  const grand = APP_STATE.data.events.grandRelay.filter(x => x.classId === targetClass);
  grand.forEach(g => {
    const rawSec = parseChineseTimeToSeconds(g.rawScore);
    const finalSec = rawSec ? rawSec + (parseInt(g.foulCount) || 0) * 5 : null;
    athletes.push({
      id: g.id,
      name: `${targetClass} 班全班大隊接力隊`,
      bib: '',
      gender: '全班出賽',
      eventName: '大隊接力',
      round: '計時決賽',
      heatOrFlight: g.heat,
      laneOrOrder: `${g.lane} 道`,
      date: '12/12(六)',
      period: '校慶運動會上午',
      venue: '操場跑道',
      score: finalSec ? formatSecondsToChinese(finalSec) : '--'
    });
  });

  return athletes;
}

function renderClassRoster() {
  const container = document.getElementById('class-roster-container');
  if (!container) return;

  const targetClass = APP_STATE.classSearch.classId;
  const targetDate = APP_STATE.classSearch.date;
  const gr = targetClass.charAt(0);

  const athletes = getClassAllAthletes(targetClass);

  // 精準日期比對篩選 (修正 11/2 與 11/20 誤判問題)
  let displayAthletes = athletes;
  if (targetDate !== 'all') {
    displayAthletes = displayAthletes.filter(x => isSameDate(x.date, targetDate));
  }

  let html = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; flex-wrap:wrap; gap:0.5rem;">
      <h3 style="font-size:1.2rem; font-weight:800; color:#0369a1;">
        🏫 ${targetClass} 班 參賽選手與賽程總表（${targetDate === 'all' ? '全部賽程共 ' + displayAthletes.length + ' 項次' : targetDate + ' 當日出賽 ' + displayAthletes.length + ' 項次'}）
      </h3>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
        <button class="btn btn-secondary btn-sm" onclick="printClassNoticeByDate('${targetClass}')" title="只印該班在指定日期的出賽選手名單與賽程通知">
          📄 按日期列印出賽單
        </button>
        <button class="btn btn-primary btn-sm" onclick="printClassMasterSchedule('${targetClass}')" style="background:#0284c7;" title="將該班全運動會的所有選手項目、節次與檢錄地點完整印出，適合貼在教室公佈欄">
          📋 參賽選手與賽程總表列印 (教室公佈欄)
        </button>
      </div>
    </div>
  `;

  if (displayAthletes.length === 0) {
    let dateNote = '';
    if (targetDate === '11/2') {
      dateNote = `11/2(一) 為 <strong>8年級跳遠、鉛球決賽</strong>。${targetClass} 班為${gr === '9' ? '九' : '七'}年級，該年級田賽日程為 <strong>${gr === '9' ? '11/4(三)' : '11/5(四)'}</strong>。`;
    } else if (targetDate === '11/4') {
      dateNote = `11/4(三) 為 <strong>9年級跳遠、鉛球決賽</strong>。${targetClass} 班為${gr === '8' ? '八' : '七'}年級，該年級田賽日程為 <strong>${gr === '8' ? '11/2(一)' : '11/5(四)'}</strong>。`;
    } else if (targetDate === '11/5') {
      dateNote = `11/5(四) 為 <strong>7年級跳遠、鉛球決賽</strong>。${targetClass} 班為${gr === '9' ? '九' : '八'}年級，該年級田賽日程為 <strong>${gr === '9' ? '11/4(三)' : '11/2(一)'}</strong>。`;
    } else {
      dateNote = `${targetClass} 班在指定日期無任何排定出賽項目。`;
    }

    html += `
      <div class="card" style="text-align:center; padding:2.8rem 1.5rem; background:#ffffff; border:1px solid #e0f2fe; border-radius:12px;">
        <div style="font-size:2.5rem; margin-bottom:0.6rem;">📅</div>
        <h4 style="font-size:1.18rem; font-weight:800; color:#0369a1; margin-bottom:0.4rem;">
          ${targetClass} 班在 ${targetDate} 當日無出賽項目
        </h4>
        <p style="font-size:0.94rem; color:#64748b; margin-bottom:1.2rem; line-height:1.6; max-width:620px; margin-left:auto; margin-right:auto;">
          ${dateNote}
        </p>
        <button class="btn btn-primary" onclick="showAllDatesForClass()">
          👉 切換為「全部比賽日期」查看 ${targetClass} 班完整賽程 (共 ${athletes.length} 項)
        </button>
      </div>
    `;
  } else {
    html += `<div class="roster-grid">`;
    displayAthletes.forEach(a => {
      html += `
        <div class="roster-card">
          <div>
            <div class="roster-card-header">
              <div>
                <span class="badge" style="background:#e0f2fe; color:#0369a1; margin-bottom:0.25rem;">${a.gender}</span>
                <div class="roster-athlete-name">${a.bib ? a.bib + '號 ' : ''}${a.name}</div>
              </div>
              <div class="roster-event-name">${a.eventName}</div>
            </div>
            <div style="font-size:0.88rem; color:var(--text-main); margin-bottom:0.35rem;">
              <strong>組別道次：</strong>${a.heatOrFlight} / ${a.laneOrOrder} (${a.round})
            </div>
            <div style="font-size:0.88rem; color:var(--text-muted); margin-bottom:0.25rem;">
              <strong>比賽地點：</strong>${a.venue}
            </div>
            <div style="font-size:0.88rem; color:#0369a1;">
              <strong>檢錄地點：</strong><span class="badge" style="background:#e0f2fe; color:#0284c7; font-weight:700;">📍 ${getCheckinVenue(a.eventName)}</span>
            </div>
          </div>
          <div class="roster-meta-row">
            <div class="roster-meta-item">📅 ${a.date}</div>
            <div class="roster-meta-item">⏰ ${a.period}</div>
            <div class="roster-meta-item" style="color:var(--danger); font-weight:800;">⏰ 賽前10分鐘完成檢錄</div>
          </div>
        </div>
      `;
    });
    html += `</div>`;
  }

  container.innerHTML = html;
}

function getFieldDate(classId) {
  const gr = classId.charAt(0);
  if (gr === '8') return '11/2(一)';
  if (gr === '9') return '11/4 (三)';
  return '11/5(四)';
}

function getFieldPeriod(classId) {
  return '第六節(女) / 第七節(男)';
}

// ==========================================
// A4 紙本列印引擎 (裁判檢錄單、手寫記錄單、班級出賽單、公佈欄總表)
// ==========================================

function triggerPrintHtml(htmlContent) {
  let printZone = document.getElementById('print-zone');
  if (!printZone) {
    printZone = document.createElement('div');
    printZone.id = 'print-zone';
    printZone.className = 'print-only';
    document.body.appendChild(printZone);
  }
  printZone.innerHTML = htmlContent;
  window.print();
}

// 模式一：【按日期列印出賽單】（只印該班在特定日期的出賽選手名冊）
function printClassNoticeByDate(classId) {
  classId = classId || APP_STATE.classSearch.classId || '701';
  const targetDate = APP_STATE.classSearch.date;
  const allAthletes = getClassAllAthletes(classId);

  let printDates = [];
  if (targetDate !== 'all') {
    printDates = [targetDate];
  } else {
    printDates = Array.from(new Set(allAthletes.map(x => x.date)));
  }

  if (printDates.length === 0) {
    showToast(`⚠️ ${classId} 班在目前選定之日期無任何出賽項目`, 'error');
    return;
  }

  const nowStr = new Date().toLocaleString('zh-TW', { hour12: false });
  let pagesHtml = '';

  printDates.forEach(d => {
    const dayAthletes = allAthletes.filter(x => isSameDate(x.date, d));
    if (dayAthletes.length === 0) return;

    pagesHtml += `
      <div class="print-page">
        <div class="print-doc-header">
          <h2>新北市立頭前國民中學 115學年度校慶運動大會</h2>
          <h3>📄 【${classId} 班】當日選手出賽名冊</h3>
          <div class="print-doc-meta">
            <div>出賽班級：<strong>${classId} 班</strong></div>
            <div>比賽日期：<strong>📅 ${d}</strong></div>
            <div>出賽人次：<strong>共 ${dayAthletes.length} 項次</strong></div>
          </div>
        </div>

        <div class="print-notice-box">
          <strong>📌 選手檢錄與出賽提醒：</strong><br>
          1. 檢錄規定：所有選手請務必於<strong>【賽前 10 分鐘完成檢錄】</strong>。鉛球項目請至<strong>【鉛球場檢錄】</strong>、跳遠項目請至<strong>【跳遠場檢錄】</strong>、其餘徑賽與接力項目統一至<strong>【操場檢錄】</strong>。<br>
          2. 請出賽選手佩戴號碼布，並依照節次提前至指定場地檢錄備賽，唱名三次不到者視同棄權。
        </div>

        <table class="print-table">
          <thead>
            <tr>
              <th style="width:35px;">序</th>
              <th style="width:75px;">出賽節次</th>
              <th style="width:115px;">競賽項目</th>
              <th style="width:55px;">組別</th>
              <th style="width:65px;">座號</th>
              <th style="width:110px;">選手姓名</th>
              <th style="width:110px;">組別 / 道次</th>
              <th style="width:100px;">檢錄地點</th>
              <th>備註說明</th>
            </tr>
          </thead>
          <tbody>
    `;

    dayAthletes.forEach((a, idx) => {
      pagesHtml += `
        <tr>
          <td>${idx + 1}</td>
          <td><strong>${a.period}</strong></td>
          <td style="font-weight:700;">${a.eventName} (${a.round})</td>
          <td>${a.gender}</td>
          <td>${a.bib || '--'}</td>
          <td style="font-weight:700; text-align:left; padding-left:10px;">${a.name}</td>
          <td>${a.heatOrFlight} / ${a.laneOrOrder}</td>
          <td><strong>${getCheckinVenue(a.eventName)}</strong></td>
          <td style="text-align:left; font-size:8.5pt;">${a.score ? '成績: ' + a.score : ''}</td>
        </tr>
      `;
    });

    pagesHtml += `
          </tbody>
        </table>

        <div class="print-signatures">
          <div style="margin-left:auto; font-size:10.5pt; font-weight:700;">班級導師簽名：____________________</div>
        </div>
        <div style="font-size:8pt; color:#666; text-align:right; margin-top:10px;">
          新北市立頭前國民中學 115學年度校慶運動會 ｜ 列印時間：${nowStr}
        </div>
      </div>
    `;
  });

  triggerPrintHtml(pagesHtml);
}

// 模式二：【參賽選手與賽程總表列印】（教室公佈欄張貼專用）
function printClassMasterSchedule(classId) {
  classId = classId || APP_STATE.classSearch.classId || '701';
  const allAthletes = getClassAllAthletes(classId);

  if (allAthletes.length === 0) {
    showToast(`⚠️ ${classId} 班無任何參賽選手資料`, 'error');
    return;
  }

  const nowStr = new Date().toLocaleString('zh-TW', { hour12: false });

  let pageHtml = `
    <div class="print-page">
      <div class="print-doc-header">
        <h2>新北市立頭前國民中學 115學年度校慶運動大會</h2>
        <h3>📋 【${classId} 班】全校慶參賽選手與賽程總表</h3>
        <div class="print-doc-meta">
          <div>參賽班級：<strong>${classId} 班</strong></div>
          <div>賽事項目：<strong>涵蓋田賽、徑賽、接力與大隊接力</strong></div>
          <div>出賽總人次：<strong>共 ${allAthletes.length} 項次</strong></div>
        </div>
      </div>

      <div class="print-notice-box">
        <strong>📌 教室公佈欄張貼提醒（請全班同學詳閱備賽）：</strong><br>
        1. 檢錄規定：所有個人與接力項目選手，一律於<strong>【賽前 10 分鐘完成檢錄】</strong>！唱名三次不到視同棄權。<br>
        2. 檢錄地點分類：鉛球項目請至<strong>【鉛球場檢錄】</strong>、跳遠項目請至<strong>【跳遠場檢錄】</strong>、其餘所有徑賽與接力賽項目統一至<strong>【操場檢錄】</strong>。<br>
        3. 請各項目出賽選手佩戴號碼布準時出場，並請全班同學為參賽同學熱情加油！
      </div>

      <table class="print-table">
        <thead>
          <tr>
            <th style="width:35px;">序</th>
            <th style="width:85px;">比賽日期</th>
            <th style="width:85px;">出賽節次</th>
            <th style="width:105px;">競賽項目</th>
            <th style="width:55px;">組別</th>
            <th style="width:55px;">座號</th>
            <th style="width:105px;">選手姓名</th>
            <th style="width:105px;">組別 / 道次</th>
            <th style="width:95px;">檢錄地點</th>
            <th>備註規範</th>
          </tr>
        </thead>
        <tbody>
  `;

  allAthletes.forEach((a, idx) => {
    pageHtml += `
      <tr>
        <td>${idx + 1}</td>
        <td><strong>${a.date}</strong></td>
        <td><span style="font-weight:700;">${a.period}</span></td>
        <td style="font-weight:700;">${a.eventName}</td>
        <td>${a.gender}</td>
        <td>${a.bib || '--'}</td>
        <td style="font-weight:700; text-align:left; padding-left:10px;">${a.name}</td>
        <td>${a.heatOrFlight} / ${a.laneOrOrder}</td>
        <td><strong>${getCheckinVenue(a.eventName)}</strong></td>
        <td style="text-align:left; font-size:8.5pt;">${a.round}${a.score ? ' (成績: ' + a.score + ')' : ''}</td>
      </tr>
    `;
  });

  pageHtml += `
        </tbody>
      </table>

      <div class="print-signatures">
        <div style="margin-left:auto; font-size:10.5pt; font-weight:700;">班級導師簽名：____________________</div>
      </div>
      <div style="font-size:8pt; color:#666; text-align:right; margin-top:10px;">
        張貼單位：${classId} 班教室公佈欄 ｜ 列印時間：${nowStr}
      </div>
    </div>
  `;

  triggerPrintHtml(pageHtml);
}

// 舊版相容介面
function printClassNotice(classId) {
  printClassNoticeByDate(classId);
}

// 功能 2：紙本檢錄點名單列印功能（同項目+同年級+同組別，依第幾組第幾道排序，列印一份）
function printCheckinRoster(eventKey, grade, gender) {
  eventKey = eventKey || (APP_STATE.adminEdit && APP_STATE.adminEdit.event) || APP_STATE.leaderboardFilter.event || '100m';
  grade = grade || (APP_STATE.adminEdit && APP_STATE.adminEdit.grade) || APP_STATE.leaderboardFilter.grade || '七年級';
  gender = gender || (APP_STATE.adminEdit && APP_STATE.adminEdit.gender) || APP_STATE.leaderboardFilter.gender || '男生組';

  const isGrandRelay = (eventKey === 'grandRelay');
  const isField = (eventKey === 'shotPut' || eventKey === 'longJump');

  let list = getAdminCurrentEventList(eventKey);

  let filtered = list;
  if (grade !== 'all') filtered = filtered.filter(x => x.grade === grade);
  if (gender !== 'all' && !isGrandRelay) filtered = filtered.filter(x => x.gender === gender);

  if (filtered.length === 0) {
    showToast('⚠️ 目前選定之條件無任何出賽選手名單可列印', 'error');
    return;
  }

  // 依照「第幾組」再依「第幾道 / 出場順序」精準排序
  const sortedAthletes = [...filtered].sort((a, b) => {
    const heatStrA = String(a.heat || a.flight || '第 1 組');
    const heatStrB = String(b.heat || b.flight || '第 1 組');
    const numA = parseInt(heatStrA.replace(/\D/g, ''), 10) || 1;
    const numB = parseInt(heatStrB.replace(/\D/g, ''), 10) || 1;
    if (numA !== numB) return numA - numB;

    const laneA = parseInt(a.lane || a.order, 10) || 99;
    const laneB = parseInt(b.lane || b.order, 10) || 99;
    return laneA - laneB;
  });

  const eventName = getEventDisplayName(eventKey);
  const checkinVenue = getCheckinVenue(eventKey);
  const nowStr = new Date().toLocaleString('zh-TW', { hour12: false });

  let rowsHtml = '';
  let lastHeat = null;

  sortedAthletes.forEach((a, idx) => {
    const curHeat = a.heat || a.flight || '第 1 組';
    if (curHeat !== lastHeat) {
      lastHeat = curHeat;
      rowsHtml += `
        <tr style="background:#f1f5f9; font-weight:800;">
          <td colspan="8" style="text-align:left; padding:5px 12px; color:#0369a1; font-size:9.5pt;">
            🚩 【${curHeat}】
          </td>
        </tr>
      `;
    }

    const laneStr = a.lane ? `第 ${a.lane} 道` : (a.order ? `第 ${a.order} 位` : `${idx + 1}`);
    const teamOrName = isGrandRelay ? `${a.classId} 班大隊接力隊` : (eventKey === 'relay4x200' ? `${a.classId} 班接力隊` : (a.name || '--'));

    rowsHtml += `
      <tr>
        <td style="text-align:center;">${idx + 1}</td>
        <td style="text-align:center; font-weight:700; color:#0369a1;">${curHeat}</td>
        <td style="text-align:center;"><strong>${laneStr}</strong></td>
        <td style="text-align:center;"><strong>${a.classId} 班</strong> ${a.isSportsClass ? '(體)' : ''}</td>
        ${!isGrandRelay && eventKey !== 'relay4x200' ? `
          <td style="text-align:center;">${a.bib || '--'}</td>
          <td style="font-weight:700; text-align:left; padding-left:10px;">${a.name || '--'}</td>
        ` : `
          <td colspan="2" style="font-weight:700; text-align:left; padding-left:10px;">${teamOrName}</td>
        `}
        <td style="text-align:center;">
          <span class="print-check-box"></span> 到 &nbsp;
          <span class="print-check-box"></span> 缺
        </td>
        <td style="text-align:center;">
          <span class="print-check-box"></span> 已查驗
        </td>
        <td style="text-align:left; font-size:8.5pt;">${a.remarks || ''}</td>
      </tr>
    `;
  });

  const pageHtml = `
    <div class="print-page">
      <div class="print-doc-header">
        <h2>新北市立頭前國民中學 115學年度校慶運動大會</h2>
        <h3>📋 裁判檢錄點名簽到單</h3>
        <div class="print-doc-meta">
          <div>競賽項目：<strong>${eventName}</strong></div>
          <div>年級組別：<strong>${grade}${isGrandRelay ? '' : (gender !== 'all' ? ' ' + gender : '')}</strong></div>
          <div>檢錄地點：<strong>📍 ${checkinVenue}</strong></div>
          <div>出賽總數：<strong>共 ${sortedAthletes.length} 人/隊</strong></div>
        </div>
      </div>

      <div class="print-notice-box">
        <strong>📌 檢錄重要規定：</strong> 出賽選手請務必於<strong>【賽前 10 分鐘完成檢錄】</strong>。唱名三次未到以棄權論。檢錄時請查驗選手號碼布或學生證，點名完成後由檢錄員引導至起跑道次或田賽場地。
      </div>

      <table class="print-table">
        <thead>
          <tr>
            <th style="width:40px; text-align:center;">序號</th>
            <th style="width:75px; text-align:center;">出賽組別</th>
            <th style="width:75px; text-align:center;">${isField ? '出場順位' : '比賽道次'}</th>
            <th style="width:75px; text-align:center;">班級</th>
            ${!isGrandRelay && eventKey !== 'relay4x200' ? '<th style="width:60px; text-align:center;">座號</th><th style="text-align:left; padding-left:10px;">選手姓名</th>' : '<th colspan="2" style="text-align:left; padding-left:10px;">參賽代表隊</th>'}
            <th style="width:105px; text-align:center;">檢錄到場</th>
            <th style="width:95px; text-align:center;">號碼布/衣</th>
            <th style="width:115px; text-align:left;">備註說明</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>

      <div class="print-signatures">
        <div>檢錄區點名裁判：____________________</div>
        <div>主任裁判／發令簽章：____________________</div>
        <div>體育組長核章：____________________</div>
      </div>
      <div style="font-size:8pt; color:#666; text-align:right; margin-top:10px;">
        列印時間：${nowStr} ｜ 新北市立頭前國中 學務處體育組
      </div>
    </div>
  `;

  triggerPrintHtml(pageHtml);
}

// 功能 3：空白成績記錄表紙本列印（同項目+同年級+同組別，依第幾組第幾道排序，列印一份）
function printBlankScoreSheet(eventKey, grade, gender) {
  eventKey = eventKey || (APP_STATE.adminEdit && APP_STATE.adminEdit.event) || APP_STATE.leaderboardFilter.event || '100m';
  grade = grade || (APP_STATE.adminEdit && APP_STATE.adminEdit.grade) || APP_STATE.leaderboardFilter.grade || '七年級';
  gender = gender || (APP_STATE.adminEdit && APP_STATE.adminEdit.gender) || APP_STATE.leaderboardFilter.gender || '男生組';

  const isGrandRelay = (eventKey === 'grandRelay');
  const isField = (eventKey === 'shotPut' || eventKey === 'longJump');

  let list = getAdminCurrentEventList(eventKey);

  let filtered = list;
  if (grade !== 'all') filtered = filtered.filter(x => x.grade === grade);
  if (gender !== 'all' && !isGrandRelay) filtered = filtered.filter(x => x.gender === gender);

  if (filtered.length === 0) {
    showToast('⚠️ 目前選定之條件無任何出賽選手名單可列印', 'error');
    return;
  }

  // 依照「第幾組」再依「第幾道 / 出場順序」精準排序
  const sortedAthletes = [...filtered].sort((a, b) => {
    const heatStrA = String(a.heat || a.flight || '第 1 組');
    const heatStrB = String(b.heat || b.flight || '第 1 組');
    const numA = parseInt(heatStrA.replace(/\D/g, ''), 10) || 1;
    const numB = parseInt(heatStrB.replace(/\D/g, ''), 10) || 1;
    if (numA !== numB) return numA - numB;

    const laneA = parseInt(a.lane || a.order, 10) || 99;
    const laneB = parseInt(b.lane || b.order, 10) || 99;
    return laneA - laneB;
  });

  const eventName = getEventDisplayName(eventKey);
  const nowStr = new Date().toLocaleString('zh-TW', { hour12: false });

  let rowsHtml = '';
  let lastHeat = null;

  sortedAthletes.forEach((a, idx) => {
    const curHeat = a.heat || a.flight || '第 1 組';
    if (curHeat !== lastHeat) {
      lastHeat = curHeat;
      const colspan = isGrandRelay ? 10 : (isField ? 11 : 11);
      rowsHtml += `
        <tr style="background:#f1f5f9; font-weight:800;">
          <td colspan="${colspan}" style="text-align:left; padding:5px 12px; color:#0369a1; font-size:9.5pt;">
            🚩 【${curHeat}】
          </td>
        </tr>
      `;
    }

    const laneStr = a.lane ? `第 ${a.lane} 道` : (a.order ? `第 ${a.order} 位` : `${idx + 1}`);
    const teamOrName = isGrandRelay ? `${a.classId} 班大隊接力隊` : (eventKey === 'relay4x200' ? `${a.classId} 班接力隊` : (a.name || '--'));

    rowsHtml += `
      <tr>
        <td style="text-align:center;">${idx + 1}</td>
        <td style="text-align:center; font-weight:700; color:#0369a1;">${curHeat}</td>
        <td style="text-align:center;"><strong>${laneStr}</strong></td>
        <td style="text-align:center;"><strong>${a.classId} 班</strong> ${a.isSportsClass ? '(體)' : ''}</td>
        ${!isGrandRelay && eventKey !== 'relay4x200' ? `
          <td style="text-align:center;">${a.bib || '--'}</td>
          <td style="font-weight:700; text-align:left; padding-left:10px;">${a.name || '--'}</td>
        ` : `
          <td colspan="2" style="font-weight:700; text-align:left; padding-left:10px;">${teamOrName}</td>
        `}

        ${isGrandRelay ? `
          <td style="height:32px;"></td>
          <td></td>
          <td></td>
          <td></td>
        ` : ''}

        ${isField ? `
          <td style="height:32px;"></td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
        ` : ''}

        ${!isGrandRelay && !isField ? `
          <td style="height:32px;"></td>
          <td></td>
          <td></td>
          <td></td>
          <td></td>
        ` : ''}

        <td style="text-align:left; font-size:8.5pt;">${a.remarks || ''}</td>
      </tr>
    `;
  });

  const pageHtml = `
    <div class="print-page">
      <div class="print-doc-header">
        <h2>新北市立頭前國民中學 115學年度校慶運動大會</h2>
        <h3>📝 裁判現場手寫成績表記錄單</h3>
        <div class="print-doc-meta">
          <div>競賽項目：<strong>${eventName}</strong></div>
          <div>年級組別：<strong>${grade}${isGrandRelay ? '' : (gender !== 'all' ? ' ' + gender : '')}</strong></div>
          <div>檢錄規定：<strong>【賽前 10 分鐘完成檢錄】</strong></div>
          <div>出賽總數：<strong>共 ${sortedAthletes.length} 人/隊</strong></div>
        </div>
      </div>

      <div class="print-notice-box">
        <strong>📌 裁判填寫注意事項：</strong> 請現場計時/測量裁判於欄位內清晰手寫時間或距離。徑賽採計至小數點後兩位（如 12.35 或 2:35.40），田賽記錄至公分（如 10.97m）。比賽結束由按錶裁判與記錄裁判共同確認無誤後簽名，交回體育組計分台鍵入電腦系統。
      </div>

      <table class="print-table">
        <thead>
          <tr>
            <th style="width:35px; text-align:center;">序</th>
            <th style="width:70px; text-align:center;">組別</th>
            <th style="width:65px; text-align:center;">${isField ? '出場順位' : '道次'}</th>
            <th style="width:75px; text-align:center;">班級</th>
            ${!isGrandRelay && eventKey !== 'relay4x200' ? '<th style="width:55px; text-align:center;">座號</th><th style="width:105px; text-align:left; padding-left:8px;">選手姓名</th>' : '<th colspan="2" style="text-align:left; padding-left:8px;">參賽代表隊</th>'}
            
            ${isGrandRelay ? `
              <th style="width:130px; text-align:center;">現場手計時間<br><span style="font-size:7.5pt; font-weight:normal;">( __分__秒__ )</span></th>
              <th style="width:75px; text-align:center;">犯規次數<br><span style="font-size:7.5pt; font-weight:normal;">(+5秒/次)</span></th>
              <th style="width:110px; text-align:center;">加罰後正式成績</th>
              <th style="width:65px; text-align:center;">現場名次</th>
            ` : ''}

            ${isField ? `
              <th style="width:80px; text-align:center;">第 1 次試跳/擲</th>
              <th style="width:80px; text-align:center;">第 2 次試跳/擲</th>
              <th style="width:80px; text-align:center;">第 3 次試跳/擲</th>
              <th style="width:90px; text-align:center;">有效最佳成績</th>
              <th style="width:65px; text-align:center;">現場名次</th>
            ` : ''}

            ${!isGrandRelay && !isField ? `
              <th style="width:85px; text-align:center;">碼錶計時 (1)</th>
              <th style="width:85px; text-align:center;">碼錶計時 (2)</th>
              <th style="width:95px; text-align:center;">裁判採計成績</th>
              <th style="width:65px; text-align:center;">晉級判定</th>
              <th style="width:60px; text-align:center;">現場名次</th>
            ` : ''}

            <th style="text-align:left;">備註說明</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>

      <div class="print-signatures">
        <div>按錶計時裁判：____________________</div>
        <div>記錄裁判簽章：____________________</div>
        <div>體育組長核章：____________________</div>
      </div>
      <div style="font-size:8pt; color:#666; text-align:right; margin-top:10px;">
        列印時間：${nowStr} ｜ 新北市立頭前國中 學務處體育組
      </div>
    </div>
  `;

  triggerPrintHtml(pageHtml);
}

// 功能：賽事正式成績公告榜單紙本列印
function printOfficialResultsSheet(eventKey, grade, gender) {
  eventKey = eventKey || APP_STATE.leaderboardFilter.event || 'grandRelay';
  grade = grade || APP_STATE.leaderboardFilter.grade || '七年級';
  gender = gender || APP_STATE.leaderboardFilter.gender || 'all';

  const isGrandRelay = (eventKey === 'grandRelay');
  const isField = (eventKey === 'shotPut' || eventKey === 'longJump');
  const isSprint = (eventKey === '100m' || eventKey === '200m');
  const is4x200 = (eventKey === 'relay4x200');

  const rankedData = getLeaderboardRankedData(eventKey, grade, gender);
  const eventName = getEventDisplayName(eventKey);
  const nowStr = new Date().toLocaleString('zh-TW', { hour12: false });

  if (rankedData.length === 0) {
    showToast('⚠️ 目前選定之項目尚無任何成績或選手可列印', 'error');
    return;
  }

  let rowsHtml = '';
  rankedData.forEach((item, idx) => {
    let rankText = item.rankNumber >= 900 ? '--' : `第 ${item.rankNumber} 名`;
    if (item.isTiedWithSports) rankText = `並列第 ${item.rankNumber} 名`;
    if (item.rankNumber === 1) rankText = item.isTiedWithSports ? '🥇 並列第 1 名 (金牌)' : '🥇 第 1 名 (金牌)';
    else if (item.rankNumber === 2) rankText = item.isTiedWithSports ? '🥈 並列第 2 名 (銀牌)' : '🥈 第 2 名 (銀牌)';
    else if (item.rankNumber === 3) rankText = item.isTiedWithSports ? '🥉 並列第 3 名 (銅牌)' : '🥉 第 3 名 (銅牌)';

    let scoreStr = item.formattedFinal || item.formattedBest || (item.score ? (parseChineseTimeToSeconds(item.score) ? formatSecondsToChinese(parseChineseTimeToSeconds(item.score)) : item.score) : '--');
    if (isGrandRelay && item.formattedFinal) scoreStr = item.formattedFinal;
    else if (isField && item.formattedBest) scoreStr = item.formattedBest;

    let laneOrOrder = item.lane ? `${item.heat || ''} ${item.lane}道` : (item.order ? `${item.flight || ''} 第${item.order}位` : '--');
    let teamOrName = isGrandRelay ? `${item.classId} 班大隊接力隊` : (is4x200 ? `${item.classId} 班接力隊` : `${item.bib ? '(' + item.bib + ') ' : ''}${item.name}`);

    let notes = [];
    if (item.isSportsClass) notes.push('體育班');
    if (item.isTiedWithSports) notes.push('並列優勝');
    if (item.foulCount > 0) notes.push(`犯規+${item.foulCount * 5}秒`);
    if (item.qualification === 'Q') notes.push('晉級決賽');
    if (item.remarks) notes.push(item.remarks);

    rowsHtml += `
      <tr>
        <td style="text-align:center; font-weight:700;">${rankText}</td>
        <td style="text-align:center;"><strong>${item.classId} 班</strong></td>
        ${!isGrandRelay && !is4x200 ? `
          <td style="text-align:center;">${item.bib || '--'}</td>
          <td style="font-weight:700; text-align:left; padding-left:8px;">${item.name || '--'}</td>
        ` : `
          <td colspan="2" style="font-weight:700; text-align:left; padding-left:8px;">${teamOrName}</td>
        `}
        <td style="text-align:center;">${laneOrOrder}</td>
        <td style="text-align:center; font-family:monospace; font-weight:900; font-size:10.5pt; color:#0369a1;">${scoreStr}</td>
        <td style="text-align:left; font-size:8.5pt;">${notes.join('、') || '--'}</td>
      </tr>
    `;
  });

  const printHtml = `
    <div class="print-page">
      <div class="print-doc-header">
        <h2>新北市立頭前國民中學 115學年度校慶運動大會</h2>
        <h3>🏆 賽事正式成績公告榜單</h3>
        <div class="print-doc-meta">
          <div>競賽項目：<strong>${eventName}</strong></div>
          <div>年級組別：<strong>${grade}${isGrandRelay ? '' : (gender !== 'all' ? ' ' + gender : '')}</strong></div>
          <div>公告狀態：<strong>正式核定成績</strong></div>
        </div>
      </div>

      <div class="print-notice-box">
        <strong>📌 成績公告注意事項：</strong> 本成績單經裁判組按錶計時／測量無誤並送大會記錄組登錄核定。如有成績疑義，請於公告後 30 分鐘內由各班導師向學務處體育組提出書面複查。
      </div>

      <table class="print-table">
        <thead>
          <tr>
            <th style="width:110px; text-align:center;">核定名次</th>
            <th style="width:65px; text-align:center;">班級</th>
            <th style="width:55px; text-align:center;">座號</th>
            <th style="text-align:left; padding-left:8px;">選手姓名／代表隊</th>
            <th style="width:105px; text-align:center;">出賽組別/道次</th>
            <th style="width:115px; text-align:center;">正式成績</th>
            <th style="width:110px; text-align:left;">狀態標籤 / 備註</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>

      <div class="print-signatures">
        <div>現場記錄裁判：____________________</div>
        <div>終點／田賽裁判長：____________________</div>
        <div>學務處體育組長：____________________</div>
      </div>
      <div style="font-size:8pt; color:#666; text-align:right; margin-top:10px;">
        核定列印時間：${nowStr} ｜ 新北市立頭前國中 學務處體育組
      </div>
    </div>
  `;

  triggerPrintHtml(printHtml);
}

// ==========================================
// 6. 大會賽程總表 (Master Schedule) - 簡潔呈現賽程、場地與規則，裁判職務獨立於裁判看板
// ==========================================
function getEventVenue(eventName) {
  if (eventName.includes('鉛球') && eventName.includes('跳遠')) {
    return '司令台旁鉛球場 / 沙坑';
  }
  if (eventName.includes('鉛球')) return '司令台旁鉛球場';
  if (eventName.includes('跳遠')) return '司令台後跳遠沙坑';
  if (eventName.includes('100M') || eventName.includes('100公尺')) return '操場直線跑道';
  return '操場環形跑道';
}

function renderMasterSchedule() {
  const container = document.getElementById('master-schedule-container');
  if (!container) return;

  const schedule = APP_STATE.data.schedule;

  let html = `
    <div class="table-responsive">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:110px;">比賽日期</th>
            <th style="width:90px; text-align:center;">出賽節次</th>
            <th>年級組別</th>
            <th>競賽項目</th>
            <th>比賽場地</th>
            <th style="text-align:center; width:90px;">賽別</th>
            <th style="text-align:center; width:130px;">優勝名額 / 規則</th>
            <th style="text-align:center; width:130px;">檢錄集合提醒</th>
          </tr>
        </thead>
        <tbody>
  `;

  schedule.forEach(s => {
    const venue = getEventVenue(s.event);
    html += `
      <tr>
        <td><strong>${s.date}</strong></td>
        <td style="text-align:center;"><span class="badge" style="background:#e0f2fe; color:#0369a1; font-size:0.88rem;">${s.period}</span></td>
        <td><strong>${s.group}</strong></td>
        <td style="color:#0284c7; font-weight:800; font-size:1.02rem;">${s.event}</td>
        <td style="color:#475569; font-weight:600;">${venue}</td>
        <td style="text-align:center;"><span class="badge" style="background:#f1f5f9; color:#334155; font-size:0.85rem;">${s.round}</span></td>
        <td style="text-align:center;"><span class="badge badge-qualified" style="font-size:0.85rem;">${s.remarks || '--'}</span></td>
        <td style="text-align:center; color:#ef4444; font-weight:800; font-size:0.85rem;">⏰ 賽前10分鐘【${getCheckinVenue(s.event)}】</td>
      </tr>
    `;
  });

  html += `</tbody></table></div>`;
  container.innerHTML = html;
}

// ==========================================
// 7. 內部工作看板：體育老師專用出勤與 LINE 廣播 (Teacher Duties)
// ==========================================
function initTeacherDashboard() {
  const container = document.getElementById('teacher-pills-container');
  if (!container) return;

  if (!APP_STATE.isAdminUnlocked) {
    container.innerHTML = '';
    return;
  }

  const teachers = Object.keys(APP_STATE.data.teachers);
  let html = '';
  teachers.forEach(tName => {
    const t = APP_STATE.data.teachers[tName];
    html += `
      <div class="teacher-btn ${tName === APP_STATE.selectedTeacher ? 'active' : ''}" onclick="selectTeacher('${tName}')">
        <span>${tName} 老師</span>
        <span class="teacher-duty-count">${t.dutyCount} 節</span>
      </div>
    `;
  });
  container.innerHTML = html;
}

function selectTeacher(tName) {
  if (!APP_STATE.isAdminUnlocked) {
    openAdminAuthModal();
    return;
  }
  APP_STATE.selectedTeacher = tName;
  initTeacherDashboard();
  renderTeacherDuties();
}

function renderTeacherDuties() {
  const container = document.getElementById('teacher-duty-content');
  const pillsContainer = document.getElementById('teacher-pills-container');
  if (!container) return;

  // 未登入管理者時，不顯示任何教師出勤與執勤資訊
  if (!APP_STATE.isAdminUnlocked) {
    if (pillsContainer) pillsContainer.innerHTML = '';
    container.innerHTML = `
      <div style="text-align:center; padding:3.5rem 1.5rem; background:#f8fafc; border-radius:12px; border:2px dashed #cbd5e1; margin-top:1rem;">
        <div style="font-size:3.5rem; margin-bottom:1rem;">🔒</div>
        <h3 style="font-size:1.35rem; font-weight:900; color:#0369a1; margin-bottom:0.5rem;">體育組裁判執勤看板（管理者專用）</h3>
        <p style="color:#64748b; font-size:0.95rem; max-width:500px; margin:0 auto 1.5rem auto; line-height:1.6;">
          本看板記載各教師個人出勤節次、鳴槍、按錶、檢錄執勤崗位與專屬 LINE 通知，需由體育組管理者登入後方可查閱與使用。
        </p>
        <button class="btn btn-primary" onclick="openAdminAuthModal()" style="padding:0.65rem 1.8rem; font-size:1rem; border-radius:9999px;">
          🔑 登入管理者帳號
        </button>
      </div>
    `;
    return;
  }

  const tName = APP_STATE.selectedTeacher;
  const teacher = APP_STATE.data.teachers[tName];
  if (!teacher) return;

  const lineText = generateTeacherLineText(tName, teacher.assignments);

  let html = `
    <!-- 一鍵複製 LINE 廣播橫幅 -->
    <div class="line-copy-box" onclick="copyLineMessage()">
      <div style="display:flex; align-items:center; gap:0.6rem;">
        <span style="font-size:1.5rem;">💬</span>
        <div>
          <div style="font-size:1.1rem;">一鍵複製 ${tName} 老師專屬 LINE 通知文字</div>
          <div style="font-size:0.82rem; opacity:0.95;">點擊即可複製完整執勤時間與崗位，直接貼入體育科群組</div>
        </div>
      </div>
      <span class="btn btn-sm" style="background:#fff; color:#059669; font-weight:800;">點擊複製</span>
    </div>

    <!-- LINE 廣播預覽區 -->
    <div style="margin-bottom:1.5rem;">
      <div style="font-size:0.88rem; font-weight:800; color:var(--text-muted); margin-bottom:0.4rem;">LINE 訊息預覽：</div>
      <div class="line-preview" id="line-preview-text">${lineText}</div>
    </div>

    <!-- 執勤節次明細卡片清單 -->
    <div class="card-header" style="margin-top:1.5rem;">
      <div class="card-title">📅 ${tName} 老師個人出勤時間與執勤崗位清單（共 ${teacher.assignments.length} 節次）</div>
    </div>
    <div class="table-responsive">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:110px;">比賽日期</th>
            <th style="width:85px;">節次</th>
            <th>年級組別</th>
            <th>項目</th>
            <th>賽別</th>
            <th>分配執勤崗位</th>
          </tr>
        </thead>
        <tbody>
  `;

  teacher.assignments.forEach(a => {
    html += `
      <tr>
        <td><strong>${a.date}</strong></td>
        <td><span class="badge" style="background:#e0f2fe; color:#0369a1;">${a.period}</span></td>
        <td>${a.group}</td>
        <td style="color:#0284c7; font-weight:800;">${a.event}</td>
        <td>${a.round}</td>
        <td style="font-weight:800; color:#0369a1;">${a.duty}</td>
      </tr>
    `;
  });

  html += `</tbody></table></div>`;
  container.innerHTML = html;
}

function generateTeacherLineText(teacherName, assignments) {
  let text = `【新北市立頭前國中 115學年度校慶運動大會 裁判出勤通知】\n`;
  text += `敬愛的 ${teacherName} 老師 您好：\n`;
  text += `以下為您在本次校慶田徑賽事之裁判出勤時段與執勤崗位，請提早至指定地點執勤：\n`;
  text += `═══════════════════════\n`;

  assignments.forEach((a, idx) => {
    text += `${idx + 1}. 📅 ${a.date} ${a.period}\n`;
    text += `   ▸ 賽事：${a.group} ${a.event} (${a.round})\n`;
    text += `   ▸ 崗位：${a.duty}\n`;
  });

  text += `═══════════════════════\n`;
  text += `📌 提醒事項：徑賽請提早10分鐘至司令台按錶/鳴槍席；田賽請至跳遠沙坑/鉛球場就位。\n`;
  text += `感謝老師的辛勞付出，預祝大會圓滿順利！\n`;
  text += `學務處體育組 敬啟`;
  return text;
}

function copyLineMessage() {
  const textEl = document.getElementById('line-preview-text');
  if (!textEl) return;
  const text = textEl.innerText;

  navigator.clipboard.writeText(text).then(() => {
    showToast(`✅ 已複製 ${APP_STATE.selectedTeacher} 老師的 LINE 出勤文字！`);
  }).catch(err => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast(`✅ 已複製 ${APP_STATE.selectedTeacher} 老師的 LINE 出勤文字！`);
  });
}

// ==========================================
// 8. 歷年成績走廊與體育班消長趨勢 (History Corridor)
// ==========================================
function renderHistoricalCorridor() {
  const container = document.getElementById('history-corridor-container');
  if (!container) return;

  const html = `
    <div class="trend-grid">
      <!-- 大隊接力歷年走廊 -->
      <div class="trend-card">
        <div class="trend-header">🏃 大隊接力：歷年普通班第一名 vs 體育班成績走廊</div>
        <div style="font-size:0.88rem; color:var(--text-muted); margin-bottom:1rem;">
          對比歷屆（112、113、114學年度）七、八、九年級冠軍紀錄與體育班消長趨勢（格式如：4分15秒34）：
        </div>
        <table class="data-table" style="font-size:0.86rem;">
          <thead>
            <tr>
              <th>學年度</th>
              <th>年級</th>
              <th>普通班第1名 (班級/成績)</th>
              <th>體育班成績 (並列名次)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>112學年度</strong></td>
              <td>七年級</td>
              <td>705班 (3分15秒20)</td>
              <td>716班 (3分08秒30) <span class="badge badge-tied">並列第1</span></td>
            </tr>
            <tr>
              <td><strong>113學年度</strong></td>
              <td>七年級</td>
              <td>703班 (3分12秒45)</td>
              <td>716班 (3分05秒10) <span class="badge badge-tied">並列第1</span></td>
            </tr>
            <tr>
              <td><strong>114學年度</strong></td>
              <td>七年級</td>
              <td>701班 (3分08秒80)</td>
              <td>716班 (3分02秒15) <span class="badge badge-tied">並列第1</span></td>
            </tr>
            <tr>
              <td><strong>112學年度</strong></td>
              <td>九年級</td>
              <td>906班 (2分58秒10)</td>
              <td>916班 (2分54秒30) <span class="badge badge-tied">並列第1</span></td>
            </tr>
            <tr>
              <td><strong>113學年度</strong></td>
              <td>九年級</td>
              <td>902班 (2分55秒30)</td>
              <td>916班 (2分52秒10) <span class="badge badge-tied">並列第1</span></td>
            </tr>
            <tr>
              <td><strong>114學年度</strong></td>
              <td>九年級</td>
              <td>905班 (2分50秒25)</td>
              <td>916班 (2分48秒60) <span class="badge badge-tied">並列第1</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 大會紀錄保持榜 -->
      <div class="trend-card">
        <div class="trend-header">🏅 田徑運動大會紀錄榜</div>
        <ul style="list-style:none; padding:0; font-size:0.9rem;">
          <li style="padding:0.6rem 0; border-bottom:1px solid var(--border); display:flex; justify-content:space-between;">
            <span><strong>九年級男子 100公尺</strong></span>
            <span style="font-family:monospace; color:#0284c7; font-weight:800;">11秒62 (112學年度)</span>
          </li>
          <li style="padding:0.6rem 0; border-bottom:1px solid var(--border); display:flex; justify-content:space-between;">
            <span><strong>九年級女子 100公尺</strong></span>
            <span style="font-family:monospace; color:#0284c7; font-weight:800;">12秒98 (113學年度)</span>
          </li>
          <li style="padding:0.6rem 0; border-bottom:1px solid var(--border); display:flex; justify-content:space-between;">
            <span><strong>八年級男子 800公尺</strong></span>
            <span style="font-family:monospace; color:#0284c7; font-weight:800;">2分18秒30 (114學年度)</span>
          </li>
          <li style="padding:0.6rem 0; border-bottom:1px solid var(--border); display:flex; justify-content:space-between;">
            <span><strong>九年級男子 1500公尺</strong></span>
            <span style="font-family:monospace; color:#0284c7; font-weight:800;">4分42秒15 (113學年度)</span>
          </li>
          <li style="padding:0.6rem 0; border-bottom:1px solid var(--border); display:flex; justify-content:space-between;">
            <span><strong>八年級男子 鉛球</strong></span>
            <span style="font-family:monospace; color:#0284c7; font-weight:800;">12.85 公尺 (111學年度)</span>
          </li>
          <li style="padding:0.6rem 0; border-bottom:1px solid var(--border); display:flex; justify-content:space-between;">
            <span><strong>七年級男子 跳遠</strong></span>
            <span style="font-family:monospace; color:#0284c7; font-weight:800;">5.32 公尺 (114學年度)</span>
          </li>
          <li style="padding:0.6rem 0; border-bottom:1px solid var(--border); display:flex; justify-content:space-between;">
            <span><strong>九年級大隊接力 (體育班)</strong></span>
            <span style="font-family:monospace; color:#0284c7; font-weight:800;">2分46秒80 (113學年度 916班)</span>
          </li>
          <li style="padding:0.6rem 0; display:flex; justify-content:space-between;">
            <span><strong>九年級大隊接力 (普通班)</strong></span>
            <span style="font-family:monospace; color:#0284c7; font-weight:800;">2分50秒25 (114學年度 905班)</span>
          </li>
        </ul>
      </div>
    </div>
  `;

  container.innerHTML = html;
}

// ==========================================
// 9. 後台：成績登錄、犯規調整與時間輸入改進 (Admin)
// ==========================================
function openAdminAuthModal() {
  const modal = document.getElementById('admin-auth-modal');
  if (modal) {
    modal.classList.add('active');
    const uInput = document.getElementById('admin-username-input');
    const pwdInput = document.getElementById('admin-password-input');
    if (uInput) {
      uInput.value = '';
      uInput.focus();
    }
    if (pwdInput) {
      pwdInput.value = '';
    }
  }
}

function closeAdminAuthModal() {
  const modal = document.getElementById('admin-auth-modal');
  if (modal) modal.classList.remove('active');
}

function handleHeaderAuthClick() {
  if (APP_STATE.isAdminUnlocked) {
    logoutAdmin();
  } else {
    openAdminAuthModal();
  }
}

function verifyAdminLogin() {
  const uInput = document.getElementById('admin-username-input');
  const pwdInput = document.getElementById('admin-password-input');
  if (!uInput || !pwdInput) return;

  const uVal = uInput.value.trim();
  const pVal = pwdInput.value.trim();

  if (!uVal || !pVal) {
    showToast('⚠️ 請輸入管理者帳號與密碼', 'warning');
    return;
  }

  // 驗證二組管理者帳密 (完全不顯示提醒文字)
  const matched = APP_STATE.adminAccounts.find(
    acc => acc.username.toLowerCase() === uVal.toLowerCase() && acc.password === pVal
  );

  if (matched) {
    APP_STATE.isAdminUnlocked = true;
    APP_STATE.currentUser = matched;
    try {
      sessionStorage.setItem('tqjh_admin_auth', JSON.stringify({ username: matched.username, name: matched.name }));
    } catch (e) {}

    closeAdminAuthModal();
    updateAdminUIState();
    showToast(`🔓 登入成功！歡迎 ${matched.name}`);

    const target = APP_STATE.pendingTabAfterLogin || 'admin';
    APP_STATE.pendingTabAfterLogin = null;
    switchTab(target);
  } else {
    showToast('❌ 帳號或密碼錯誤，請重新輸入', 'error');
    pwdInput.value = '';
    pwdInput.focus();
  }
}

function logoutAdmin() {
  APP_STATE.isAdminUnlocked = false;
  APP_STATE.isRosterEditUnlocked = false;
  APP_STATE.currentUser = null;
  try {
    sessionStorage.removeItem('tqjh_admin_auth');
  } catch (e) {}

  updateAdminUIState();
  showToast('🔒 管理者已安全登出');

  if (APP_STATE.currentTab === 'teacher' || APP_STATE.currentTab === 'admin') {
    switchTab('leaderboard');
  }
}

function updateAdminUIState() {
  const teacherNav = document.getElementById('nav-teacher-tab');
  const adminNav = document.getElementById('nav-admin-tab');
  const userDisplay = document.getElementById('admin-user-display');
  const headerAuthBtn = document.getElementById('btn-header-auth');

  if (APP_STATE.isAdminUnlocked && APP_STATE.currentUser) {
    // 管理者登入後，在網頁上顯示「體育組裁判執勤看板」
    if (teacherNav) {
      teacherNav.classList.remove('admin-nav-hidden');
      if (teacherNav.style.removeProperty) teacherNav.style.removeProperty('display');
      teacherNav.style.display = '';
    }
    if (adminNav) adminNav.innerHTML = `🔓 後台管理 (${APP_STATE.currentUser.username})`;
    if (userDisplay) userDisplay.textContent = `${APP_STATE.currentUser.username}（${APP_STATE.currentUser.name}）`;
    if (headerAuthBtn) {
      headerAuthBtn.innerHTML = `👤 ${APP_STATE.currentUser.username} (登出)`;
      headerAuthBtn.classList.add('logged-in');
    }
  } else {
    // 未登入時，完全不在網頁上顯示「體育組裁判執勤看板」
    if (teacherNav) {
      teacherNav.classList.add('admin-nav-hidden');
      if (teacherNav.style.setProperty) teacherNav.style.setProperty('display', 'none', 'important');
      teacherNav.style.display = 'none';
    }
    if (adminNav) adminNav.innerHTML = `🔒 後台成績登錄與管理`;
    if (userDisplay) userDisplay.textContent = '未登入';
    if (headerAuthBtn) {
      headerAuthBtn.innerHTML = `🔑 管理者登入`;
      headerAuthBtn.classList.remove('logged-in');
    }
  }

  // 同步刷新體育組內部看板內容權限
  initTeacherDashboard();
  renderTeacherDuties();
}

function initAdminAuth() {
  try {
    const saved = sessionStorage.getItem('tqjh_admin_auth');
    if (saved) {
      const parsed = JSON.parse(saved);
      const matched = APP_STATE.adminAccounts.find(a => a.username.toLowerCase() === parsed.username.toLowerCase());
      if (matched) {
        APP_STATE.isAdminUnlocked = true;
        APP_STATE.currentUser = matched;
      }
    }
  } catch (e) {}

  updateAdminUIState();
}

function initAdminView() {
  const eventSelect = document.getElementById('admin-event-select');
  const gradeSelect = document.getElementById('admin-grade-select');
  const genderSelect = document.getElementById('admin-gender-select');

  if (eventSelect) {
    eventSelect.value = APP_STATE.adminEdit.event;
    eventSelect.addEventListener('change', () => {
      APP_STATE.adminEdit.event = eventSelect.value;
      if (APP_STATE.adminEdit.event === 'grandRelay') {
        APP_STATE.adminEdit.gender = '混組';
        if (genderSelect) genderSelect.value = '混組';
      } else if (APP_STATE.adminEdit.gender === '混組') {
        APP_STATE.adminEdit.gender = '男生組';
        if (genderSelect) genderSelect.value = '男生組';
      }
      renderAdminEditTable();
    });
  }
  if (gradeSelect) {
    gradeSelect.value = APP_STATE.adminEdit.grade;
    gradeSelect.addEventListener('change', () => {
      APP_STATE.adminEdit.grade = gradeSelect.value;
      renderAdminEditTable();
    });
  }
  if (genderSelect) {
    genderSelect.value = APP_STATE.adminEdit.gender;
    genderSelect.addEventListener('change', () => {
      APP_STATE.adminEdit.gender = genderSelect.value;
      renderAdminEditTable();
    });
  }
}

function renderAdminEditTable() {
  const container = document.getElementById('admin-edit-table-container');
  if (!container) return;

  const { event, grade, gender } = APP_STATE.adminEdit;
  const isGrandRelay = (event === 'grandRelay');
  const is4x200 = (event === 'relay4x200');
  const isField = (event === 'shotPut' || event === 'longJump');
  const isDistanceTrack = (event === '800m' || event === '1500m' || event === '400m' || event === 'relay4x200');
  const isSprintTrack = (event === '100m' || event === '200m' || event === '100m_finals' || event === '200m_finals');
  const isSprintPrelim = (event === '100m' || event === '200m');
  const isSprintFinals = (event === '100m_finals' || event === '200m_finals');

  let items = getAdminCurrentEventList(event);

  let filtered = items;
  if (grade !== 'all') filtered = filtered.filter(x => x.grade === grade);
  if (gender !== 'all') filtered = filtered.filter(x => x.gender === gender);

  // 預設先依「組別 (Heat)」再依「道次/出場序 (Lane/Order)」排序顯示
  filtered.sort((a, b) => {
    const heatStrA = String(a.heat || a.flight || '第 1 組');
    const heatStrB = String(b.heat || b.flight || '第 1 組');
    const numHeatA = parseInt(heatStrA.replace(/\D/g, ''), 10) || 1;
    const numHeatB = parseInt(heatStrB.replace(/\D/g, ''), 10) || 1;
    if (numHeatA !== numHeatB) return numHeatA - numHeatB;

    const laneA = (a.lane !== undefined && a.lane !== null && a.lane !== '') ? parseInt(a.lane, 10) : ((a.order !== undefined && a.order !== null && a.order !== '') ? parseInt(a.order, 10) : 99);
    const laneB = (b.lane !== undefined && b.lane !== null && b.lane !== '') ? parseInt(b.lane, 10) : ((b.order !== undefined && b.order !== null && b.order !== '') ? parseInt(b.order, 10) : 99);
    const numLaneA = !isNaN(laneA) ? laneA : 99;
    const numLaneB = !isNaN(laneB) ? laneB : 99;
    if (numLaneA !== numLaneB) return numLaneA - numLaneB;

    const cA = parseInt(String(a.classId || a.classNo || '0').replace(/\D/g, ''), 10) || 0;
    const cB = parseInt(String(b.classId || b.classNo || '0').replace(/\D/g, ''), 10) || 0;
    if (cA !== cB) return cA - cB;

    const bibA = parseInt(String(a.bib || '0').replace(/\D/g, ''), 10) || 0;
    const bibB = parseInt(String(b.bib || '0').replace(/\D/g, ''), 10) || 0;
    return bibA - bibB;
  });

  let examplePrompt = '如：4分15秒34';
  if (event === '800m') examplePrompt = '如：2分35秒40';
  else if (event === '1500m') examplePrompt = '如：4分58秒12';
  else if (isSprintTrack) examplePrompt = isSprintFinals ? '如：12秒10' : '如：12秒35';

  let syncNoticeHtml = '';
  if (!APP_STATE.sync.gasUrl) {
    syncNoticeHtml = `
      <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:10px; padding:0.75rem 1rem; margin-bottom:1rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.6rem;">
        <div style="display:flex; align-items:center; gap:0.5rem; color:#1e40af; font-size:0.88rem; font-weight:700;">
          <span>💡 貼心提醒：目前為【本機單機模式】。在此輸入的成績已妥善保存在本機。若要讓「全校手機/電腦 0 延遲即時同步顯示」：</span>
        </div>
        <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
          <button type="button" class="btn btn-sm btn-primary" onclick="openSyncConfigModal()" style="font-size:0.8rem; padding:0.25rem 0.6rem; font-weight:800;">
            ☁️ 啟用 Google 試算表即時同步 (推薦)
          </button>
          <button type="button" class="btn btn-sm btn-secondary" onclick="exportMeetDataJs()" style="font-size:0.8rem; padding:0.25rem 0.6rem; font-weight:800; background:#e0f2fe; color:#0369a1; border-color:#7dd3fc;">
            📥 匯出 meet_data.js (上傳 GitHub)
          </button>
        </div>
      </div>
    `;
  }

  let html = `
    ${syncNoticeHtml}
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; flex-wrap:wrap; gap:0.5rem;">
      <div style="font-weight:800; color:#0369a1; display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
        <span>📝 正在編輯：${grade} ${isGrandRelay ? '' : gender} - ${getEventDisplayName(event)}（共 ${filtered.length} 筆選手名單）</span>
        ${APP_STATE.isRosterEditUnlocked ? `
          <button type="button" class="btn btn-sm" onclick="lockRosterEdit()" style="background:#ecfdf5; color:#047857; border:1px solid #10b981; font-size:0.8rem; padding:0.25rem 0.6rem; font-weight:800; border-radius:6px; cursor:pointer;" title="點此重新鎖定名冊與分組分道修改權限">
            🔓 名單與道次：已授權解鎖 (點此重新鎖定)
          </button>
        ` : `
          <button type="button" class="btn btn-sm" onclick="promptUnlockRoster()" style="background:#fffbeb; color:#b45309; border:1px solid #f59e0b; font-size:0.8rem; padding:0.25rem 0.6rem; font-weight:800; border-radius:6px; cursor:pointer;" title="若需修改姓名、座號、班級或道次，請輸入密碼 tqjh888 解鎖">
            🔒 名單與道次：已鎖定保護 (點此輸入密碼解鎖)
          </button>
        `}
      </div>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
        ${isSprintPrelim ? `
          <button type="button" class="btn btn-sm btn-primary" onclick="triggerGenerateSprintFinals(APP_STATE.adminEdit.event, APP_STATE.adminEdit.grade, APP_STATE.adminEdit.gender)" style="background:linear-gradient(135deg, #f59e0b, #d97706); border:none; font-weight:800; box-shadow:0 2px 4px rgba(245,158,11,0.25);" title="依目前預賽前 12 名成績自動生成決賽分組與道次（需輸入密碼 tqjh888）">
            ⚡ 一鍵生成決賽名單與道次
          </button>
          <button type="button" class="btn btn-secondary btn-sm" onclick="sortAdminRosterByHeatAndLane()" style="background:#e0f2fe; color:#0369a1; border:1px solid #7dd3fc; font-weight:800;" title="將選手先依組別再依道次排序">
            🔀 依組別道次排序
          </button>
          <button type="button" class="btn btn-secondary btn-sm" onclick="sortAdminRosterByClassAndBib()" style="background:#f0fdf4; color:#166534; border:1px solid #bbf7d0; font-weight:800;" title="依選手班級與座號排序">
            🏫 依班級座號排序
          </button>
        ` : ''}
        ${isSprintFinals ? `
          <button type="button" class="btn btn-sm btn-primary" onclick="triggerGenerateSprintFinals('${event.replace('_finals', '')}', APP_STATE.adminEdit.grade, APP_STATE.adminEdit.gender)" style="background:linear-gradient(135deg, #f59e0b, #d97706); border:none; font-weight:800; box-shadow:0 2px 4px rgba(245,158,11,0.25);" title="重新依預賽前 12 名成績生成決賽分組與道次（需輸入密碼 tqjh888）">
            ⚡ 重新生成決賽名單與道次
          </button>
          <button type="button" class="btn btn-secondary btn-sm" onclick="sortAdminRosterByHeatAndLane()" style="background:#e0f2fe; color:#0369a1; border:1px solid #7dd3fc; font-weight:800;" title="依決賽組別（第1組、第2組）與道次（1~6道）排序">
            🔀 依組別道次排序
          </button>
          <button type="button" class="btn btn-secondary btn-sm" onclick="sortAdminFinalsBySeedRank()" style="background:#fef3c7; color:#92400e; border:1px solid #fde68a; font-weight:800;" title="依預賽跨組總名次（種子第1至第12名）排序">
            🏆 依預賽種子排名排序
          </button>
          <button type="button" class="btn btn-secondary btn-sm" onclick="sortAdminRosterByClassAndBib()" style="background:#f0fdf4; color:#166534; border:1px solid #bbf7d0; font-weight:800;" title="依選手班級與座號排序">
            🏫 依班級座號排序
          </button>
        ` : ''}
        ${!isSprintPrelim && !isSprintFinals ? `
          <button type="button" class="btn btn-secondary btn-sm" onclick="sortAdminRosterByHeatAndLane()" style="background:#e0f2fe; color:#0369a1; border:1px solid #7dd3fc; font-weight:800;" title="將當前賽事所有選手先依「組別」再依「道次/出場序」由小到大自動重新排序並儲存">
            🔀 依組別道次排序
          </button>
          <button type="button" class="btn btn-secondary btn-sm" onclick="sortAdminRosterByClassAndBib()" style="background:#f0fdf4; color:#166534; border:1px solid #bbf7d0; font-weight:800;" title="依選手班級與座號排序">
            🏫 依班級座號排序
          </button>
        ` : ''}
        <button class="btn btn-secondary btn-sm" onclick="printCheckinRoster(APP_STATE.adminEdit.event, APP_STATE.adminEdit.grade, APP_STATE.adminEdit.gender)" title="列印當前賽事的裁判檢錄點名單（含到缺、號碼衣勾選與簽章處）">
          📋 列印檢錄點名單
        </button>
        <button class="btn btn-secondary btn-sm" onclick="printBlankScoreSheet(APP_STATE.adminEdit.event, APP_STATE.adminEdit.grade, APP_STATE.adminEdit.gender)" title="列印現場手寫記錄表">
          📝 列印手寫記錄單
        </button>
        <button class="btn btn-primary btn-sm" onclick="printOfficialResultsSheet(APP_STATE.adminEdit.event, APP_STATE.adminEdit.grade, APP_STATE.adminEdit.gender)" title="列印已登錄成績之正式公告成績單（含金銀銅牌、並列名次與裁判核章）" style="background:#0284c7;">
          🏆 列印正式成績單
        </button>
        <button class="btn btn-primary btn-sm" onclick="saveAdminEdits()" style="background:#047857; font-weight:800;">
          💾 保存名冊與成績並全站同步
        </button>
        <button type="button" class="btn btn-sm btn-primary" onclick="openAddAthleteModal()" style="background:#0284c7; font-weight:800; box-shadow:0 2px 4px rgba(2,132,199,0.28);" title="新增一名參賽選手或大隊接力出賽班級">
          ➕ 新增參賽選手 / 班級
        </button>
        <button type="button" class="btn btn-sm" onclick="clearCurrentEventScores()" style="background:#fff1f2; color:#be123c; border:1px solid #fecdd3; font-weight:800;" title="清空當前選定項目的比賽成績紀錄（選手名冊與分組道次完整保留，需密碼 tqjh888）">
          🧹 清空此項目成績
        </button>
      </div>
    </div>
    ${isGrandRelay ? `
      <div style="background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:0.6rem 0.95rem; margin-bottom:0.85rem; font-size:0.86rem; color:#92400e; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:0.5rem;">
        <span>🏃 <strong>大隊接力出賽提醒：</strong>716、816 班因人數不足已自出賽名冊排除。大隊接力<strong>滿 15 班以上加倍計分（第 1 名 18 分）</strong>；若後續有調整，可點擊上方【➕ 新增參賽選手 / 班級】加入，或點擊每列右側【🗑️】刪除。</span>
      </div>
    ` : ''}
    <div class="table-responsive">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:45px; text-align:center;">編號</th>
            <th style="width:85px; text-align:center;">班級</th>
            ${!isGrandRelay && !is4x200 ? '<th style="width:65px; text-align:center;">座號</th><th style="width:110px;">姓名</th>' : '<th style="width:130px;">參賽代表隊</th>'}
            <th style="width:95px; text-align:center;">${isSprintFinals ? '決賽組別' : (!isField ? '組別' : '輪次/組別')}</th>
            <th style="width:75px; text-align:center;">${isSprintFinals ? '決賽道次' : (!isField ? '道次' : '出場序')}</th>
            ${isSprintFinals ? '<th style="width:110px; text-align:center;">預賽種子成績</th>' : ''}
            ${isGrandRelay ? `
              <th>原始成績 (分 / 秒)</th>
              <th>犯規次數 (+5秒/次)</th>
              <th>最終成績 (加罰後)</th>
            ` : ''}
            ${isDistanceTrack ? `
              <th>比賽成績 (如：${examplePrompt})</th>
            ` : ''}
            ${isSprintTrack ? `
              <th>${isSprintFinals ? '決賽成績 (秒.毫秒，如：12秒10)' : '比賽成績 (秒.毫秒，如：12秒35)'}</th>
            ` : ''}
            ${isField ? `
              <th>第1次試跳/擲</th>
              <th>第2次試跳/擲</th>
              <th>第3次試跳/擲</th>
              <th>有效最佳</th>
            ` : ''}
            <th>備註</th>
            <th style="width:85px; text-align:center;">操作</th>
          </tr>
        </thead>
        <tbody>
  `;

  if (filtered.length === 0) {
    html += `<tr><td colspan="9" style="text-align:center; padding:2rem;">該分類目前無參賽項目名冊</td></tr>`;
  } else {
    const isRosterUnlocked = APP_STATE.isRosterEditUnlocked;
    const lockedStyle = 'background:#f8fafc; color:#64748b; cursor:pointer; border-color:#e2e8f0;';

    filtered.forEach((item, idx) => {
      // 拆解秒數為分與秒
      let totalSec = null;
      if (isGrandRelay) {
        totalSec = parseChineseTimeToSeconds(item.rawScore);
      } else if (!isField) {
        totalSec = parseChineseTimeToSeconds(item.score);
      }
      const splitTime = splitSecondsToMinSec(totalSec);

      html += `
        <tr data-id="${item.id}">
          <td style="text-align:center;">${idx + 1}</td>
          <td style="text-align:center;">
            <input type="text" class="form-control input-row-class" value="${item.classId}" style="width:60px; padding:0.25rem 0.2rem; font-size:0.88rem; font-weight:800; text-align:center; display:inline-block; ${!isRosterUnlocked ? lockedStyle : ''}" ${!isRosterUnlocked ? 'readonly onclick="promptUnlockRoster()" title="🔒 點此輸入密碼 tqjh888 解鎖修改班級"' : 'title="修改班級 (如: 701, 716)"'}>
            ${item.isSportsClass ? '<div class="badge badge-sports" style="font-size:0.68rem; margin-top:2px;">體育班</div>' : ''}
          </td>
          ${!isGrandRelay && !is4x200 ? `
            <td style="text-align:center;">
              <input type="text" class="form-control input-row-bib" value="${item.bib || ''}" placeholder="座號" style="width:50px; padding:0.25rem 0.2rem; font-size:0.85rem; text-align:center; ${!isRosterUnlocked ? lockedStyle : ''}" ${!isRosterUnlocked ? 'readonly onclick="promptUnlockRoster()" title="🔒 點此輸入密碼 tqjh888 解鎖修改座號"' : 'title="修改座號/號碼布"'}>
            </td>
            <td>
              <input type="text" class="form-control input-row-name" value="${item.name || ''}" placeholder="選手姓名" style="width:95px; padding:0.25rem 0.4rem; font-size:0.9rem; font-weight:700; ${!isRosterUnlocked ? lockedStyle : ''}" ${!isRosterUnlocked ? 'readonly onclick="promptUnlockRoster()" title="🔒 點此輸入密碼 tqjh888 解鎖修改選手姓名"' : 'title="修改選手姓名"'}>
            </td>
          ` : `
            <td>
              <input type="text" class="form-control input-row-name" value="${item.name || (isGrandRelay ? `${item.classId} 班大隊接力隊` : `${item.classId} 班接力隊`)}" placeholder="隊伍名稱" style="width:125px; padding:0.25rem 0.4rem; font-size:0.88rem; font-weight:700; ${!isRosterUnlocked ? lockedStyle : ''}" ${!isRosterUnlocked ? 'readonly onclick="promptUnlockRoster()" title="🔒 點此輸入密碼 tqjh888 解鎖修改參賽代表隊"' : 'title="修改參賽隊伍名稱"'}>
            </td>
          `}
          <td style="text-align:center;">
            <input type="text" class="form-control input-row-heat" value="${item.heat || item.flight || ''}" placeholder="如: 第 1 組" style="width:85px; padding:0.25rem 0.35rem; font-size:0.84rem; text-align:center; ${!isRosterUnlocked ? lockedStyle : ''}" ${!isRosterUnlocked ? 'readonly onclick="promptUnlockRoster()" title="🔒 點此輸入密碼 tqjh888 解鎖修改出賽組別"' : 'title="修改出賽組別 (如: 第 1 組)"'}>
          </td>
          <td style="text-align:center;">
            <input type="text" class="form-control input-row-lane" value="${item.lane ? item.lane : (item.order ? item.order : '')}" placeholder="如: 3" style="width:50px; padding:0.25rem 0.2rem; font-size:0.86rem; text-align:center; ${!isRosterUnlocked ? lockedStyle : ''}" ${!isRosterUnlocked ? 'readonly onclick="promptUnlockRoster()" title="🔒 點此輸入密碼 tqjh888 解鎖修改道次/出場順序"' : 'title="修改道次或出場順序 (如: 3 或 第 3 位)"'}>
          </td>
          ${isSprintFinals ? `
            <td style="text-align:center; font-size:0.86rem; color:#0369a1; font-weight:700;">
              ${item.prelimScore ? `${item.prelimScore} <span style="font-size:0.75rem; color:#64748b;">(#${item.seedRank || '-'})</span>` : (item.seedRank ? `#${item.seedRank}` : '--')}
            </td>
          ` : ''}
          
          ${isGrandRelay ? `
            <td>
              <div class="time-input-group">
                <input type="number" min="0" max="59" class="time-input-min input-relay-min" value="${splitTime.min}" placeholder="分" oninput="recalcRelayRow(this)">
                <span class="time-unit-label">分</span>
                <input type="number" min="0" max="59.99" step="0.01" class="time-input-sec input-relay-sec" value="${splitTime.sec}" placeholder="秒.毫秒" oninput="recalcRelayRow(this)">
                <span class="time-unit-label">秒</span>
              </div>
            </td>
            <td>
              <div class="foul-stepper">
                <button type="button" class="foul-btn" onclick="adjustFoul(this, -1)">-</button>
                <span class="foul-val">${item.foulCount || 0}</span>
                <button type="button" class="foul-btn" onclick="adjustFoul(this, 1)">+</button>
              </div>
            </td>
            <td><strong class="relay-final-calc" style="font-family:monospace; color:#0284c7; font-size:1.1rem;">--</strong></td>
          ` : ''}

          ${isDistanceTrack ? `
            <td>
              <div class="time-input-group">
                <input type="number" min="0" max="59" class="time-input-min input-dist-min" value="${splitTime.min}" placeholder="分" oninput="recalcDistRow(this)">
                <span class="time-unit-label">分</span>
                <input type="number" min="0" max="59.99" step="0.01" class="time-input-sec input-dist-sec" value="${splitTime.sec}" placeholder="秒.毫秒" oninput="recalcDistRow(this)">
                <span class="time-unit-label">秒</span>
              </div>
              <span class="time-preview-badge dist-preview" style="margin-left:0.5rem;">${formatSecondsToChinese(totalSec)}</span>
            </td>
          ` : ''}

          ${isSprintTrack ? `
            <td>
              <div class="time-input-group">
                <input type="number" step="0.01" class="time-input-sec input-sprint-sec" style="width:88px;" value="${splitTime.sec || item.score || ''}" placeholder="秒.毫秒" oninput="recalcSprintRow(this)">
                <span class="time-unit-label">秒</span>
              </div>
              <span class="time-preview-badge sprint-preview" style="margin-left:0.5rem;">${totalSec ? formatSecondsToChinese(totalSec) : '--'}</span>
            </td>
          ` : ''}

          ${isField ? `
            <td><input type="text" class="form-control field-att1" style="width:80px; text-align:center; font-family:monospace;" value="${item.att1 || ''}" placeholder="公尺" onchange="recalcFieldRow(this)"></td>
            <td><input type="text" class="form-control field-att2" style="width:80px; text-align:center; font-family:monospace;" value="${item.att2 || ''}" placeholder="公尺" onchange="recalcFieldRow(this)"></td>
            <td><input type="text" class="form-control field-att3" style="width:80px; text-align:center; font-family:monospace;" value="${item.att3 || ''}" placeholder="公尺" onchange="recalcFieldRow(this)"></td>
            <td><strong class="field-best-calc" style="font-family:monospace; color:#0284c7; font-size:1.1rem;">--</strong></td>
          ` : ''}

          <td><input type="text" class="form-control input-row-remarks" style="padding:0.35rem 0.5rem; font-size:0.85rem; min-width:80px;" value="${item.remarks || ''}"></td>
          <td style="text-align:center; white-space:nowrap;">
            <button type="button" class="btn btn-secondary btn-sm" onclick="openEditAthleteModal('${item.id}', '${event}')" title="${isRosterUnlocked ? '修改選手名冊與道次' : '🔒 需先輸入密碼 tqjh888 確認授權方可修改選手名冊與道次'}" style="padding:0.25rem 0.45rem; font-size:0.8rem;">
              ${isRosterUnlocked ? '✏️' : '🔒'}
            </button>
            <button type="button" class="btn btn-sm" onclick="deleteAthleteOrClass('${item.id}', '${event}')" title="刪除此選手或班級出賽資格" style="padding:0.25rem 0.45rem; font-size:0.8rem; background:#fff1f2; color:#be123c; border:1px solid #fecdd3; margin-left:3px; font-weight:800;">
              🗑️
            </button>
          </td>
        </tr>
      `;
    });
  }

  html += `</tbody></table></div>`;
  container.innerHTML = html;

  // 初始化每行的即時計算
  if (isGrandRelay) {
    document.querySelectorAll('.input-relay-sec').forEach(el => recalcRelayRow(el));
  } else if (isDistanceTrack) {
    document.querySelectorAll('.input-dist-sec').forEach(el => recalcDistRow(el));
  } else if (isSprintTrack) {
    document.querySelectorAll('.input-sprint-sec').forEach(el => recalcSprintRow(el));
  } else if (isField) {
    document.querySelectorAll('.field-att1').forEach(el => recalcFieldRow(el));
  }
}

function adjustFoul(btn, delta) {
  const stepper = btn.closest('.foul-stepper');
  const valEl = stepper.querySelector('.foul-val');
  let count = parseInt(valEl.textContent) || 0;
  count = Math.max(0, count + delta);
  valEl.textContent = count;
  const secInput = btn.closest('tr').querySelector('.input-relay-sec');
  recalcRelayRow(secInput);
}

function recalcRelayRow(inputEl) {
  const tr = inputEl.closest('tr');
  const minVal = parseFloat(tr.querySelector('.input-relay-min').value) || 0;
  const secVal = parseFloat(tr.querySelector('.input-relay-sec').value);
  const fouls = parseInt(tr.querySelector('.foul-val').textContent) || 0;
  const finalEl = tr.querySelector('.relay-final-calc');

  if (!isNaN(secVal) && secVal >= 0) {
    const rawTotal = minVal * 60 + secVal;
    const finalTotal = rawTotal + fouls * 5;
    const rawChinese = formatSecondsToChinese(rawTotal);
    const finalChinese = formatSecondsToChinese(finalTotal);
    finalEl.textContent = fouls > 0 ? `${finalChinese} (+${fouls * 5}秒)` : finalChinese;
  } else {
    finalEl.textContent = '--';
  }
}

function recalcDistRow(inputEl) {
  const tr = inputEl.closest('tr');
  const minVal = parseFloat(tr.querySelector('.input-dist-min').value) || 0;
  const secVal = parseFloat(tr.querySelector('.input-dist-sec').value);
  const preview = tr.querySelector('.dist-preview');

  if (!isNaN(secVal) && secVal >= 0) {
    const totalSec = minVal * 60 + secVal;
    preview.textContent = formatSecondsToChinese(totalSec);
  } else {
    preview.textContent = '--';
  }
}

function recalcSprintRow(inputEl) {
  const tr = inputEl.closest('tr');
  const secVal = parseFloat(tr.querySelector('.input-sprint-sec').value);
  const preview = tr.querySelector('.sprint-preview');

  if (!isNaN(secVal) && secVal > 0) {
    preview.textContent = formatSecondsToChinese(secVal);
  } else {
    preview.textContent = '--';
  }
}

function recalcFieldRow(inputEl) {
  const tr = inputEl.closest('tr');
  const a1 = parseDistanceInput(tr.querySelector('.field-att1').value);
  const a2 = parseDistanceInput(tr.querySelector('.field-att2').value);
  const a3 = parseDistanceInput(tr.querySelector('.field-att3').value);
  const valid = [a1, a2, a3].filter(v => v !== null && v > 0);
  const bestEl = tr.querySelector('.field-best-calc');
  if (valid.length > 0) {
    bestEl.textContent = Math.max(...valid).toFixed(2) + 'm';
  } else {
    bestEl.textContent = '--';
  }
}

function getAdminCurrentEventList(eventKey) {
  eventKey = eventKey || APP_STATE.adminEdit.event;
  if (!APP_STATE.data || !APP_STATE.data.events) return [];
  const isGrandRelay = (eventKey === 'grandRelay');
  if (isGrandRelay) return APP_STATE.data.events.grandRelay || [];
  if (eventKey === 'relay4x200') return APP_STATE.data.events.relay4x200 || [];
  if (eventKey === '100m') return APP_STATE.data.events.e100m || [];
  if (eventKey === '200m') return APP_STATE.data.events.e200m || [];
  if (eventKey === '100m_finals') {
    if (!APP_STATE.data.events.e100m_finals) APP_STATE.data.events.e100m_finals = [];
    return APP_STATE.data.events.e100m_finals;
  }
  if (eventKey === '200m_finals') {
    if (!APP_STATE.data.events.e200m_finals) APP_STATE.data.events.e200m_finals = [];
    return APP_STATE.data.events.e200m_finals;
  }
  if (eventKey === '400m') return APP_STATE.data.events.e400m || [];
  if (eventKey === '800m') return APP_STATE.data.events.e800m || [];
  if (eventKey === '1500m') return APP_STATE.data.events.e1500m || [];
  if (eventKey === 'shotPut') return APP_STATE.data.events.shotPut || [];
  if (eventKey === 'longJump') return APP_STATE.data.events.longJump || [];
  return [];
}

// 將表格 DOM 輸入框中的最新變更同步收集至記憶體
function syncAdminDomInputsToState() {
  const rows = document.querySelectorAll('#admin-edit-table-container tbody tr');
  const { event } = APP_STATE.adminEdit;
  const isGrandRelay = (event === 'grandRelay');
  const isField = (event === 'shotPut' || event === 'longJump');
  const isDistanceTrack = (event === '800m' || event === '1500m' || event === '400m' || event === 'relay4x200');
  const isSprintTrack = (event === '100m' || event === '200m' || event === '100m_finals' || event === '200m_finals');

  const list = getAdminCurrentEventList(event);
  if (!list || list.length === 0) return;

  rows.forEach(tr => {
    const id = tr.dataset.id;
    if (!id) return;
    const target = list.find(x => x.id === id);
    if (!target) return;

    if (isGrandRelay) {
      const minInput = tr.querySelector('.input-relay-min');
      const secInput = tr.querySelector('.input-relay-sec');
      const minVal = minInput ? parseFloat(minInput.value) || 0 : 0;
      const secVal = secInput ? parseFloat(secInput.value) : NaN;
      if (!isNaN(secVal) && secVal >= 0) {
        const rawSec = minVal * 60 + secVal;
        target.rawScore = formatSecondsToChinese(rawSec);
      } else {
        target.rawScore = '';
      }
      const foulEl = tr.querySelector('.foul-val');
      target.foulCount = foulEl ? parseInt(foulEl.textContent) || 0 : 0;
    } else if (isDistanceTrack) {
      const minInput = tr.querySelector('.input-dist-min');
      const secInput = tr.querySelector('.input-dist-sec');
      const minVal = minInput ? parseFloat(minInput.value) || 0 : 0;
      const secVal = secInput ? parseFloat(secInput.value) : NaN;
      if (!isNaN(secVal) && secVal >= 0) {
        const rawSec = minVal * 60 + secVal;
        target.score = formatSecondsToChinese(rawSec);
      } else {
        target.score = '';
      }
    } else if (isSprintTrack) {
      const secInput = tr.querySelector('.input-sprint-sec');
      const secVal = secInput ? parseFloat(secInput.value) : NaN;
      if (!isNaN(secVal) && secVal > 0) {
        target.score = formatSecondsToChinese(secVal);
      } else {
        target.score = '';
      }
    } else if (isField) {
      const a1 = tr.querySelector('.field-att1');
      const a2 = tr.querySelector('.field-att2');
      const a3 = tr.querySelector('.field-att3');
      target.att1 = a1 ? a1.value.trim() : '';
      target.att2 = a2 ? a2.value.trim() : '';
      target.att3 = a3 ? a3.value.trim() : '';

      const numA1 = parseDistanceInput(target.att1);
      const numA2 = parseDistanceInput(target.att2);
      const numA3 = parseDistanceInput(target.att3);
      const valids = [numA1, numA2, numA3].filter(v => v !== null && v > 0);
      if (valids.length > 0) {
        const maxVal = Math.max(...valids);
        target.bestDistance = maxVal;
        target.best = maxVal.toFixed(2);
        target.formattedBest = maxVal.toFixed(2) + ' 公尺';
        target.score = maxVal;
      } else {
        target.bestDistance = null;
        target.best = '';
        target.formattedBest = (target.att1 || target.att2 || target.att3) ? '無有效成績 (X)' : '--';
        target.score = null;
      }
    }

    if (APP_STATE.isRosterEditUnlocked) {
      const classInput = tr.querySelector('.input-row-class');
      if (classInput) {
        const cVal = classInput.value.trim();
        if (cVal) {
          target.classId = cVal;
          target.classNo = cVal;
          target.isSportsClass = String(cVal).endsWith('16');
        }
      }

      const heatInput = tr.querySelector('.input-row-heat');
      if (heatInput) {
        const hVal = heatInput.value.trim();
        if (isField) {
          target.flight = hVal;
        } else {
          target.heat = hVal;
        }
      }

      const laneInput = tr.querySelector('.input-row-lane');
      if (laneInput) {
        const lVal = laneInput.value.trim();
        const numVal = parseInt(lVal, 10);
        if (isField) {
          target.order = !isNaN(numVal) ? numVal : lVal;
        } else {
          target.lane = !isNaN(numVal) ? numVal : lVal;
        }
      }

      const nameInput = tr.querySelector('.input-row-name');
      if (nameInput) target.name = nameInput.value.trim();
      const bibInput = tr.querySelector('.input-row-bib');
      if (bibInput) target.bib = bibInput.value.trim();
    }

    const remarkInput = tr.querySelector('.input-row-remarks');
    if (remarkInput) target.remarks = remarkInput.value.trim();
  });
}

// 核心排序：依年級、性別，嚴格先按「組別」再按「道次/出場序」排序
function sortEventListByHeatAndLane(list) {
  if (!list || list.length === 0) return;

  const gradeWeight = { '七年級': 7, '八年級': 8, '九年級': 9 };
  const genderWeight = { '男生組': 1, '女生組': 2, '混組': 3, '男女混合': 3 };

  list.sort((a, b) => {
    // 1. 年級
    const gA = gradeWeight[a.grade] || 99;
    const gB = gradeWeight[b.grade] || 99;
    if (gA !== gB) return gA - gB;

    // 2. 性別
    const sxA = genderWeight[a.gender] || 99;
    const sxB = genderWeight[b.gender] || 99;
    if (sxA !== sxB) return sxA - sxB;

    // 3. 先按組別 (Heat / Flight)
    const heatStrA = String(a.heat || a.flight || '第 1 組');
    const heatStrB = String(b.heat || b.flight || '第 1 組');
    const numHeatA = parseInt(heatStrA.replace(/\D/g, ''), 10) || 1;
    const numHeatB = parseInt(heatStrB.replace(/\D/g, ''), 10) || 1;
    if (numHeatA !== numHeatB) return numHeatA - numHeatB;

    // 4. 同一組別按道次／出場序 (Lane / Order)
    const laneA = (a.lane !== undefined && a.lane !== null && a.lane !== '') ? parseInt(a.lane, 10) : ((a.order !== undefined && a.order !== null && a.order !== '') ? parseInt(a.order, 10) : 99);
    const laneB = (b.lane !== undefined && b.lane !== null && b.lane !== '') ? parseInt(b.lane, 10) : ((b.order !== undefined && b.order !== null && b.order !== '') ? parseInt(b.order, 10) : 99);
    const numLaneA = !isNaN(laneA) ? laneA : 99;
    const numLaneB = !isNaN(laneB) ? laneB : 99;
    if (numLaneA !== numLaneB) return numLaneA - numLaneB;

    // 5. 備用：班級
    const cA = parseInt(String(a.classId || a.classNo || '0').replace(/\D/g, ''), 10) || 0;
    const cB = parseInt(String(b.classId || b.classNo || '0').replace(/\D/g, ''), 10) || 0;
    if (cA !== cB) return cA - cB;

    // 6. 備用：座號
    const bibA = parseInt(String(a.bib || '0').replace(/\D/g, ''), 10) || 0;
    const bibB = parseInt(String(b.bib || '0').replace(/\D/g, ''), 10) || 0;
    return bibA - bibB;
  });
}

// 後台管理員專用排序按鈕觸發函式：先按組別，同一組別按道次排序，並即時儲存同步全站
function sortAdminRosterByHeatAndLane(showSuccessToast = true) {
  const { event } = APP_STATE.adminEdit;
  if (!event || !APP_STATE.data || !APP_STATE.data.events) return;

  // 1. 同步最新 DOM 輸入數值
  syncAdminDomInputsToState();

  // 2. 取得名單並排序
  const list = getAdminCurrentEventList(event);
  if (!list || list.length === 0) {
    if (showSuccessToast) showToast('⚠️ 當前項目尚無選手資料可排序', 'warning');
    return;
  }

  sortEventListByHeatAndLane(list);

  // 3. 儲存並同步至所有視圖與列印模組
  saveLocalData();
  renderAdminEditTable();
  renderLeaderboard();
  renderClassRoster();

  if (showSuccessToast) {
    showToast('🔀 已成功依「組別 ➔ 道次」完成重新排序並同步儲存！');
  }
}

// 後台管理員專用：依預賽跨組總排名 (種子 1~12) 排序決賽名冊
function sortAdminFinalsBySeedRank(showSuccessToast = true) {
  const { event } = APP_STATE.adminEdit;
  if (!event || !APP_STATE.data || !APP_STATE.data.events) return;

  syncAdminDomInputsToState();
  const list = getAdminCurrentEventList(event);
  if (!list || list.length === 0) {
    if (showSuccessToast) showToast('⚠️ 當前項目尚無選手資料可排序', 'warning');
    return;
  }

  list.sort((a, b) => {
    const rA = parseInt(a.seedRank, 10) || 999;
    const rB = parseInt(b.seedRank, 10) || 999;
    if (rA !== rB) return rA - rB;
    const sA = parseChineseTimeToSeconds(a.prelimScore) || 999;
    const sB = parseChineseTimeToSeconds(b.prelimScore) || 999;
    return sA - sB;
  });

  saveLocalData();
  renderAdminEditTable();
  renderLeaderboard();
  renderClassRoster();

  if (showSuccessToast) {
    showToast('🏆 已成功依「預賽成績／種子排名」完成重新排序並同步儲存！');
  }
}

// 後台管理員專用：依班級、座號由小到大排序名冊
function sortAdminRosterByClassAndBib(showSuccessToast = true) {
  const { event } = APP_STATE.adminEdit;
  if (!event || !APP_STATE.data || !APP_STATE.data.events) return;

  syncAdminDomInputsToState();
  const list = getAdminCurrentEventList(event);
  if (!list || list.length === 0) {
    if (showSuccessToast) showToast('⚠️ 當前項目尚無選手資料可排序', 'warning');
    return;
  }

  list.sort((a, b) => {
    const cA = parseInt(String(a.classId || a.classNo || '0').replace(/\D/g, ''), 10) || 0;
    const cB = parseInt(String(b.classId || b.classNo || '0').replace(/\D/g, ''), 10) || 0;
    if (cA !== cB) return cA - cB;

    const bibA = parseInt(String(a.bib || '0').replace(/\D/g, ''), 10) || 0;
    const bibB = parseInt(String(b.bib || '0').replace(/\D/g, ''), 10) || 0;
    return bibA - bibB;
  });

  saveLocalData();
  renderAdminEditTable();
  renderLeaderboard();
  renderClassRoster();

  if (showSuccessToast) {
    showToast('🏫 已成功依「班級 ➔ 座號」完成重新排序並同步儲存！');
  }
}

// 核心功能：預賽前 12 名一鍵自動生成決賽名單、標準道次編配與多維同步
function triggerGenerateSprintFinals(prelimKey, grade, gender) {
  prelimKey = prelimKey || (APP_STATE.adminEdit && APP_STATE.adminEdit.event) || APP_STATE.leaderboardFilter.event || '100m';
  if (prelimKey !== '100m' && prelimKey !== '200m') {
    if (prelimKey.includes('100m')) prelimKey = '100m';
    else if (prelimKey.includes('200m')) prelimKey = '200m';
    else {
      showToast('⚠️ 僅 100M 或 200M 短跑預賽可生成決賽名單與道次', 'warning');
      return;
    }
  }

  grade = grade || (APP_STATE.adminEdit && APP_STATE.adminEdit.grade) || APP_STATE.leaderboardFilter.grade || '七年級';
  gender = gender || (APP_STATE.adminEdit && APP_STATE.adminEdit.gender) || APP_STATE.leaderboardFilter.gender || '男生組';

  if (grade === 'all') {
    alert('⚠️ 請先指定具體的參賽年級（七年級、八年級或九年級），再生成該組決賽名單！');
    return;
  }
  if (gender === 'all') {
    alert('⚠️ 請先指定具體的組別（男生組或女生組），再生成該組決賽名單！');
    return;
  }

  // 1. 安全確認密碼驗證 (tqjh888)
  const pwd = prompt(`🔐 【短跑決賽名單生成安全認證】\n\n即將為【${grade} ${gender} ${getEventDisplayName(prelimKey)}】由預賽成績排名前 12 名選手自動編配決賽分組與標準黃金跑道！\n\n請輸入確認密碼：`);
  if (pwd === null) return;
  if (pwd.trim() !== 'tqjh888') {
    alert('❌ 密碼錯誤！無法生成決賽名單。');
    return;
  }

  // 2. 抓取預賽名單
  const prelimList = (prelimKey === '100m') ? APP_STATE.data.events.e100m : APP_STATE.data.events.e200m;
  if (!prelimList || prelimList.length === 0) {
    alert('⚠️ 系統中查無任何預賽選手名冊！');
    return;
  }

  const prelimFiltered = prelimList.filter(x => x.grade === grade && x.gender === gender);
  if (prelimFiltered.length === 0) {
    alert(`⚠️ 目前【${grade} ${gender}】無預賽選手名單！`);
    return;
  }

  // 取得有效完賽成績並由快到慢排序 (秒數少者列前)
  const sorted = prelimFiltered
    .map(a => {
      const sec = parseChineseTimeToSeconds(a.score);
      return { ...a, parsedSeconds: (sec !== null && sec > 0) ? sec : null };
    })
    .filter(a => a.parsedSeconds !== null && !isNaN(a.parsedSeconds) && a.parsedSeconds > 0)
    .sort((a, b) => a.parsedSeconds - b.parsedSeconds);

  if (sorted.length === 0) {
    alert(`⚠️ 目前【${grade} ${gender} ${getEventDisplayName(prelimKey)}】尚未登錄任何有效完賽成績，無法生成決賽名單！\n請先至後台登錄預賽成績。`);
    return;
  }

  // 防呆提示：若預賽完賽人數不足 12 人
  if (sorted.length < 12) {
    const ok = confirm(`⚠️ 提示警告：\n目前【${grade} ${gender}】完賽人數僅 ${sorted.length} 人（未滿 12 人）。\n\n是否仍要依現有 ${sorted.length} 位選手生成決賽名單與道次？`);
    if (!ok) return;
  }

  // 3. 核心分組與道次分配演算法
  // LANE_ALLOCATION: 各組第 1 快者->第 3 道, 第 2 快者->第 4 道, 第 3 快者->第 5 道, 第 4 快者->第 2 道, 第 5 快者->第 6 道, 第 6 快者->第 1 道
  const LANE_ALLOCATION = {
    1: 3, // 第1快 -> 第3道
    2: 4, // 第2快 -> 第4道
    3: 5, // 第3快 -> 第5道
    4: 2, // 第4快 -> 第2道
    5: 6, // 第5快 -> 第6道
    6: 1  // 第6快 -> 第1道
  };

  const top12 = sorted.slice(0, 12);
  const finalsList = [];
  const finalKey = prelimKey + '_finals';
  const finalEventDisplayName = (prelimKey === '100m') ? '100公尺決賽' : '200公尺決賽';

  if (top12.length <= 6) {
    // 總人數 <= 6 人：全數編入【第 1 組】
    top12.forEach((athlete, index) => {
      const groupRank = index + 1; // 1~6
      finalsList.push({
        id: `${finalKey}_${grade}_${gender}_${index + 1}`,
        grade: athlete.grade,
        gender: athlete.gender,
        event: finalEventDisplayName,
        classId: athlete.classId,
        classNo: athlete.classNo || athlete.classId,
        isSportsClass: athlete.isSportsClass || String(athlete.classId).endsWith('16'),
        heat: '第 1 組',
        lane: LANE_ALLOCATION[groupRank] || (index + 1),
        bib: athlete.bib || '',
        name: athlete.name || '',
        rawName: athlete.rawName || (athlete.bib ? athlete.bib + athlete.name : athlete.name),
        score: '', // 決賽尚未進行，預留空白給現場裁判登記
        prelimScore: athlete.score || (athlete.parsedSeconds ? formatSecondsToChinese(athlete.parsedSeconds) : ''),
        seedRank: index + 1,
        remarks: `預賽種子第 ${index + 1} 名 (${athlete.score || ''})`
      });
    });
  } else {
    // 總人數 7~12 人：強者排在後一組 (第 2 組: 預賽 1~6 名; 第 1 組: 預賽 7~12 名)
    // 【第 2 組】：預賽第 1 名 至 第 6 名 (共 6 人)
    const group2Athletes = top12.slice(0, 6);
    group2Athletes.forEach((athlete, index) => {
      const groupRank = index + 1; // 1~6
      finalsList.push({
        id: `${finalKey}_${grade}_${gender}_${index + 1}`,
        grade: athlete.grade,
        gender: athlete.gender,
        event: finalEventDisplayName,
        classId: athlete.classId,
        classNo: athlete.classNo || athlete.classId,
        isSportsClass: athlete.isSportsClass || String(athlete.classId).endsWith('16'),
        heat: '第 2 組',
        lane: LANE_ALLOCATION[groupRank],
        bib: athlete.bib || '',
        name: athlete.name || '',
        rawName: athlete.rawName || (athlete.bib ? athlete.bib + athlete.name : athlete.name),
        score: '',
        prelimScore: athlete.score || (athlete.parsedSeconds ? formatSecondsToChinese(athlete.parsedSeconds) : ''),
        seedRank: index + 1,
        remarks: `預賽種子第 ${index + 1} 名 (${athlete.score || ''})`
      });
    });

    // 【第 1 組】：預賽第 7 名 至 第 12 名 (共 1~6 人)
    const group1Athletes = top12.slice(6, 12);
    group1Athletes.forEach((athlete, index) => {
      const groupRank = index + 1; // 1~6
      finalsList.push({
        id: `${finalKey}_${grade}_${gender}_${index + 7}`,
        grade: athlete.grade,
        gender: athlete.gender,
        event: finalEventDisplayName,
        classId: athlete.classId,
        classNo: athlete.classNo || athlete.classId,
        isSportsClass: athlete.isSportsClass || String(athlete.classId).endsWith('16'),
        heat: '第 1 組',
        lane: LANE_ALLOCATION[groupRank],
        bib: athlete.bib || '',
        name: athlete.name || '',
        rawName: athlete.rawName || (athlete.bib ? athlete.bib + athlete.name : athlete.name),
        score: '',
        prelimScore: athlete.score || (athlete.parsedSeconds ? formatSecondsToChinese(athlete.parsedSeconds) : ''),
        seedRank: index + 7,
        remarks: `預賽種子第 ${index + 7} 名 (${athlete.score || ''})`
      });
    });
  }

  // 預設依組別 (第 1 組 -> 第 2 組) 和道次 (1 -> 6 道) 排序輸出
  finalsList.sort((a, b) => {
    const numHeatA = parseInt(String(a.heat).replace(/\D/g, ''), 10) || 1;
    const numHeatB = parseInt(String(b.heat).replace(/\D/g, ''), 10) || 1;
    if (numHeatA !== numHeatB) return numHeatA - numHeatB;
    return (parseInt(a.lane, 10) || 99) - (parseInt(b.lane, 10) || 99);
  });

  // 4. 存入全域資料庫 (替換該年級與性別既有決賽名單，保留其他年級組別)
  const finalsArrayKey = (prelimKey === '100m') ? 'e100m_finals' : 'e200m_finals';
  if (!APP_STATE.data.events[finalsArrayKey]) {
    APP_STATE.data.events[finalsArrayKey] = [];
  }
  const remaining = APP_STATE.data.events[finalsArrayKey].filter(x => !(x.grade === grade && x.gender === gender));
  APP_STATE.data.events[finalsArrayKey] = [...remaining, ...finalsList];

  // 5. 本地儲存
  saveLocalData();

  // 6. 自動切換至決賽頁面 (後台、前台榜單、下拉選單同步更新)
  APP_STATE.adminEdit.event = finalKey;
  APP_STATE.adminEdit.grade = grade;
  APP_STATE.adminEdit.gender = gender;
  const adminEventSelect = document.getElementById('admin-event-select');
  if (adminEventSelect) adminEventSelect.value = finalKey;
  const adminGradeSelect = document.getElementById('admin-grade-select');
  if (adminGradeSelect) adminGradeSelect.value = grade;
  const adminGenderSelect = document.getElementById('admin-gender-select');
  if (adminGenderSelect) adminGenderSelect.value = gender;

  APP_STATE.leaderboardFilter.event = finalKey;
  APP_STATE.leaderboardFilter.grade = grade;
  APP_STATE.leaderboardFilter.gender = gender;
  updateLeaderboardFilterPillsUI();

  renderAdminEditTable();
  renderLeaderboard();
  renderClassRoster();

  showToast(`⚡ 成功為【${grade} ${gender}】生成 ${finalEventDisplayName} 共 ${finalsList.length} 位選手分組與黃金道次！已自動切換至決賽名冊。`, 'success');
}

function saveAdminEdits() {
  syncAdminDomInputsToState();

  const { event } = APP_STATE.adminEdit;
  const list = getAdminCurrentEventList(event);
  sortEventListByHeatAndLane(list);

  // 檢查當前項目是否有輸入有效成績，若有則標註為最新成績賽事並連動首頁看板
  const hasScoresNow = list.some(x => hasValidAthleteScore(x));
  if (hasScoresNow) {
    const targetGender = (event === 'grandRelay') ? 'all' : (APP_STATE.adminEdit.gender === '混組' ? '男生組' : APP_STATE.adminEdit.gender);
    const latestInfo = {
      event,
      grade: APP_STATE.adminEdit.grade,
      gender: targetGender
    };
    localStorage.setItem('TQ_LATEST_SCORED_EVENT', JSON.stringify(latestInfo));
    APP_STATE.leaderboardFilter.event = event;
    APP_STATE.leaderboardFilter.grade = APP_STATE.adminEdit.grade;
    APP_STATE.leaderboardFilter.gender = targetGender;
    updateLeaderboardFilterPillsUI();
  }

  saveLocalData();
  renderAdminEditTable();
  renderLeaderboard();
  renderClassRoster();
  if (APP_STATE.isRosterEditUnlocked) {
    showToast('✅ 賽事成績與選手名冊/道次已成功登錄更新！');
  } else {
    showToast('✅ 賽事成績已成功登錄更新！');
  }
}

// 點選各項運動項目後的專屬清空功能 (需密碼 tqjh888)
function clearCurrentEventScores() {
  const pwd = prompt('🔒 安全防護確認：\n\n您即將清空當前選定項目的比賽成績紀錄！\n選手名冊與分組道次將完整保留。\n\n請輸入管理者確認密碼：');
  if (pwd === null) return;
  if (pwd.trim() !== 'tqjh888') {
    alert('❌ 密碼錯誤！無法清空此項目成績。');
    return;
  }

  const { event, grade, gender } = APP_STATE.adminEdit;
  const eventName = getEventDisplayName(event);
  const scopeText = `${grade !== 'all' ? grade + ' ' : ''}${gender !== 'all' && event !== 'grandRelay' ? gender + ' ' : ''}${eventName}`;

  if (!confirm(`⚠️ 最後確認：\n\n確定要清空【${scopeText}】的所有比賽成績紀錄嗎？\n\n（選手姓名、座號、班級與分組分道將完整保留）`)) {
    return;
  }

  const list = getAdminCurrentEventList(event);
  let count = 0;
  list.forEach(item => {
    let match = true;
    if (grade !== 'all' && item.grade !== grade) match = false;
    if (gender !== 'all' && event !== 'grandRelay' && item.gender !== gender) match = false;
    if (match) {
      item.score = '';
      if (item.rawScore !== undefined) item.rawScore = '';
      if (item.foulCount !== undefined) item.foulCount = 0;
      if (item.att1 !== undefined) item.att1 = '';
      if (item.att2 !== undefined) item.att2 = '';
      if (item.att3 !== undefined) item.att3 = '';
      if (item.best !== undefined) item.best = '';
      delete item.formattedBest;
      delete item.bestDistance;
      delete item.finalSeconds;
      delete item.finalScore;
      delete item.formattedFinal;
      delete item.formattedRaw;
      count++;
    }
  });

  // 重新評估全站最新有成績之賽事
  const latest = findLatestEventWithScores();
  if (latest) {
    localStorage.setItem('TQ_LATEST_SCORED_EVENT', JSON.stringify(latest));
    APP_STATE.leaderboardFilter.event = latest.event;
    APP_STATE.leaderboardFilter.grade = latest.grade || '七年級';
    APP_STATE.leaderboardFilter.gender = (latest.event === 'grandRelay') ? 'all' : (latest.gender || '男生組');
  } else {
    localStorage.removeItem('TQ_LATEST_SCORED_EVENT');
    APP_STATE.leaderboardFilter.event = 'grandRelay';
    APP_STATE.leaderboardFilter.grade = '七年級';
    APP_STATE.leaderboardFilter.gender = 'all';
  }
  updateLeaderboardFilterPillsUI();

  saveLocalData();
  renderAdminEditTable();
  renderLeaderboard();
  renderClassRoster();

  showToast(`🧹 已成功清空【${scopeText}】之比賽成績（共 ${count} 筆紀錄重置為空白）`);
}

// ==========================================
// 選手名冊與分組分道安全密碼驗證模組 (密碼: tqjh888)
// ==========================================
let ROSTER_AUTH_CALLBACK = null;

function promptUnlockRoster(callback) {
  if (APP_STATE.isRosterEditUnlocked) {
    if (callback) callback();
    return;
  }
  ROSTER_AUTH_CALLBACK = callback || null;
  const modal = document.getElementById('roster-auth-modal');
  const pwdInput = document.getElementById('roster-auth-password-input');
  const errMsg = document.getElementById('roster-auth-err-msg');
  if (errMsg) errMsg.style.display = 'none';
  if (pwdInput) {
    pwdInput.value = '';
    setTimeout(() => pwdInput.focus(), 100);
  }
  if (modal) modal.classList.add('active');
}

function closeRosterAuthModal() {
  const modal = document.getElementById('roster-auth-modal');
  if (modal) modal.classList.remove('active');
  ROSTER_AUTH_CALLBACK = null;
}

function verifyRosterAuthPassword() {
  const pwdInput = document.getElementById('roster-auth-password-input');
  const errMsg = document.getElementById('roster-auth-err-msg');
  const val = pwdInput ? pwdInput.value.trim() : '';

  if (val === APP_STATE.rosterEditPassword || val === 'tqjh888') {
    APP_STATE.isRosterEditUnlocked = true;
    closeRosterAuthModal();
    showToast('🔓 選手名冊與分組分道修改權限已成功解鎖！');
    renderAdminEditTable();
    if (ROSTER_AUTH_CALLBACK) {
      const cb = ROSTER_AUTH_CALLBACK;
      ROSTER_AUTH_CALLBACK = null;
      cb();
    }
  } else {
    if (errMsg) {
      errMsg.textContent = '❌ 授權密碼錯誤！請輸入密碼 (tqjh888)。';
      errMsg.style.display = 'block';
    }
    if (pwdInput) {
      pwdInput.value = '';
      pwdInput.focus();
    }
  }
}

function lockRosterEdit() {
  APP_STATE.isRosterEditUnlocked = false;
  renderAdminEditTable();
  showToast('🔒 選手名冊與分組分道修改權限已重新鎖定保護');
}

// ==========================================
// 彈出式 Modal：編輯選手個人資料與分組道次
// ==========================================
function openEditAthleteModal(athleteId, eventKey) {
  if (!APP_STATE.isRosterEditUnlocked) {
    promptUnlockRoster(() => {
      openEditAthleteModal(athleteId, eventKey);
    });
    return;
  }

  const modal = document.getElementById('edit-athlete-modal');
  if (!modal) return;

  const ev = eventKey || APP_STATE.adminEdit.event;
  const isGrandRelay = (ev === 'grandRelay');
  const isField = (ev === 'shotPut' || ev === 'longJump');

  let list = getAdminCurrentEventList(ev);

  const target = list.find(x => x.id === athleteId);
  if (!target) return;

  document.getElementById('edit-athlete-id').value = athleteId;
  document.getElementById('edit-athlete-event').value = ev;
  document.getElementById('edit-athlete-class').value = target.classId || target.classNo || '';
  document.getElementById('edit-athlete-bib').value = target.bib || '';
  document.getElementById('edit-athlete-name').value = target.name || '';

  const heatLabel = document.getElementById('edit-athlete-heat-label');
  const laneLabel = document.getElementById('edit-athlete-lane-label');
  if (heatLabel) heatLabel.textContent = isField ? '分組／試跳組別：' : '競賽組別：';
  if (laneLabel) laneLabel.textContent = isField ? '出場順序 (位次)：' : '比賽道次：';

  document.getElementById('edit-athlete-heat').value = target.heat || target.flight || '';
  document.getElementById('edit-athlete-lane').value = (target.lane !== undefined && target.lane !== null) ? target.lane : (target.order || '');
  document.getElementById('edit-athlete-remarks').value = target.remarks || '';

  modal.classList.add('active');
}

function closeEditAthleteModal() {
  const modal = document.getElementById('edit-athlete-modal');
  if (modal) modal.classList.remove('active');
}

function submitAthleteEditModal() {
  if (!APP_STATE.isRosterEditUnlocked) {
    promptUnlockRoster(() => {
      submitAthleteEditModal();
    });
    return;
  }
  const id = document.getElementById('edit-athlete-id').value;
  const ev = document.getElementById('edit-athlete-event').value;
  if (!id || !ev) {
    closeEditAthleteModal();
    return;
  }

  const isGrandRelay = (ev === 'grandRelay');
  const isField = (ev === 'shotPut' || ev === 'longJump');

  let list = getAdminCurrentEventList(ev);

  const target = list.find(x => x.id === id);
  if (!target) {
    closeEditAthleteModal();
    return;
  }

  const cVal = document.getElementById('edit-athlete-class').value.trim();
  const bibVal = document.getElementById('edit-athlete-bib').value.trim();
  const nameVal = document.getElementById('edit-athlete-name').value.trim();
  const heatVal = document.getElementById('edit-athlete-heat').value.trim();
  const laneVal = document.getElementById('edit-athlete-lane').value.trim();
  const remarksVal = document.getElementById('edit-athlete-remarks').value.trim();

  if (cVal) {
    target.classId = cVal;
    target.classNo = cVal;
    target.isSportsClass = String(cVal).endsWith('16');
  }
  target.bib = bibVal;
  if (nameVal) target.name = nameVal;

  if (isField) {
    target.flight = heatVal;
    const numOrder = parseInt(laneVal, 10);
    target.order = !isNaN(numOrder) ? numOrder : laneVal;
  } else {
    target.heat = heatVal;
    const numLane = parseInt(laneVal, 10);
    target.lane = !isNaN(numLane) ? numLane : laneVal;
  }
  target.remarks = remarksVal;

  sortEventListByHeatAndLane(list);

  saveLocalData();
  renderAdminEditTable();
  renderLeaderboard();
  renderClassRoster();
  closeEditAthleteModal();
  showToast(`✅ 選手【${target.name || target.classId}】資料已成功修改並同步！`);
}

// 從 Modal 中刪除當前編輯之選手或班級
function deleteAthleteFromModal() {
  const id = document.getElementById('edit-athlete-id').value;
  const ev = document.getElementById('edit-athlete-event').value || APP_STATE.adminEdit.event;
  if (!id) return;
  closeEditAthleteModal();
  deleteAthleteOrClass(id, ev);
}

// 刪除指定項目中的出賽選手或出賽班級（全面連動檢核表、成績單、總積分與即時榜單）
function deleteAthleteOrClass(athleteId, eventKey) {
  eventKey = eventKey || APP_STATE.adminEdit.event;
  const list = getAdminCurrentEventList(eventKey);
  const target = list.find(x => x.id === athleteId);
  if (!target) {
    showToast('⚠️ 找不到指定的選手或出賽班級資料', 'error');
    return;
  }

  const evName = getEventDisplayName(eventKey);
  const targetName = target.name || (target.classId ? `${target.classId} 班出賽代表隊` : '出賽隊伍');
  const targetClass = target.classId || target.classNo || '';
  const confirmMsg = `確定要刪除【${targetClass} 班 ${targetName}】在【${evName}】的參賽資格嗎？\n\n⚠️ 刪除後將即時全面連動：\n1. 後台成績登錄表\n2. 裁判檢錄點名單與手寫檢核表\n3. 正式成績單與班級賽程表\n4. 即時榜單與班級運動會總積分`;

  if (!confirm(confirmMsg)) return;

  // 先同步現有輸入框資料以免未存成績遺失
  syncAdminDomInputsToState();

  const idx = list.findIndex(x => x.id === athleteId);
  if (idx !== -1) {
    list.splice(idx, 1);
  }

  // 儲存並連動全站所有畫面與報表
  saveLocalData();
  renderAdminEditTable();
  renderLeaderboard();
  renderClassRoster();
  renderMasterSchedule();
  renderTeacherDuties();
  if (APP_STATE.leaderboardFilter.subTab === 'points') {
    renderClassPointsView();
  }

  showToast(`🗑️ 已成功刪除【${targetClass} 班 ${targetName}】！所有畫面與列印報表已全面連動更新。`);
}

// 開啟新增選手 / 大隊接力班級 Modal
function openAddAthleteModal() {
  const modal = document.getElementById('add-athlete-modal');
  if (!modal) return;

  const evSelect = document.getElementById('add-athlete-event');
  const grSelect = document.getElementById('add-athlete-grade');
  const gdSelect = document.getElementById('add-athlete-gender');

  if (evSelect) evSelect.value = APP_STATE.adminEdit.event || 'grandRelay';
  if (grSelect) grSelect.value = (APP_STATE.adminEdit.grade !== 'all') ? APP_STATE.adminEdit.grade : '七年級';
  if (gdSelect) {
    if (evSelect && evSelect.value === 'grandRelay') {
      gdSelect.value = '混組';
    } else {
      gdSelect.value = (APP_STATE.adminEdit.gender !== 'all') ? APP_STATE.adminEdit.gender : '男生組';
    }
  }

  const cInput = document.getElementById('add-athlete-class');
  const bInput = document.getElementById('add-athlete-bib');
  const nInput = document.getElementById('add-athlete-name');
  const hInput = document.getElementById('add-athlete-heat');
  const lInput = document.getElementById('add-athlete-lane');
  const rInput = document.getElementById('add-athlete-remarks');

  if (cInput) cInput.value = '';
  if (bInput) bInput.value = '';
  if (nInput) nInput.value = '';
  if (hInput) hInput.value = '第 1 組';
  if (lInput) lInput.value = '';
  if (rInput) rInput.value = '';

  onAddAthleteEventChange();
  modal.classList.add('active');
}

function closeAddAthleteModal() {
  const modal = document.getElementById('add-athlete-modal');
  if (modal) modal.classList.remove('active');
}

function onAddAthleteEventChange() {
  const evSelect = document.getElementById('add-athlete-event');
  if (!evSelect) return;
  const ev = evSelect.value;
  const isGrandRelay = (ev === 'grandRelay');
  const isRelay4 = (ev === 'relay4x200');
  const isField = (ev === 'shotPut' || ev === 'longJump');

  const gdSelect = document.getElementById('add-athlete-gender');
  const nameLabel = document.getElementById('add-athlete-name-label');
  const heatLabel = document.getElementById('add-athlete-heat-label');
  const laneLabel = document.getElementById('add-athlete-lane-label');

  if (isGrandRelay) {
    if (gdSelect) {
      gdSelect.innerHTML = '<option value="混組">全班出賽 (混組)</option>';
      gdSelect.value = '混組';
      gdSelect.disabled = true;
    }
    if (nameLabel) nameLabel.textContent = '代表隊名稱 (如：701班大隊接力隊)：';
    if (heatLabel) heatLabel.textContent = '競賽組別：';
    if (laneLabel) laneLabel.textContent = '道次：';
  } else if (isRelay4) {
    if (gdSelect) {
      gdSelect.disabled = false;
      gdSelect.innerHTML = '<option value="男生組">男生組</option><option value="女生組">女生組</option>';
      gdSelect.value = '男生組';
    }
    if (nameLabel) nameLabel.textContent = '接力隊名稱 (如：701班接力隊)：';
    if (heatLabel) heatLabel.textContent = '競賽組別：';
    if (laneLabel) laneLabel.textContent = '道次：';
  } else {
    if (gdSelect) {
      gdSelect.disabled = false;
      gdSelect.innerHTML = '<option value="男生組">男生組</option><option value="女生組">女生組</option>';
      gdSelect.value = (APP_STATE.adminEdit && APP_STATE.adminEdit.gender !== 'all') ? APP_STATE.adminEdit.gender : '男生組';
    }
    if (nameLabel) nameLabel.textContent = '選手姓名：';
    if (heatLabel) heatLabel.textContent = isField ? '試跳/擲組別：' : '競賽組別：';
    if (laneLabel) laneLabel.textContent = isField ? '出場順序 (位次)：' : '道次：';
  }

  onAddAthleteClassInput();
}

function onAddAthleteGradeChange() {
  const grSelect = document.getElementById('add-athlete-grade');
  const cInput = document.getElementById('add-athlete-class');
  if (grSelect && cInput && !cInput.value) {
    const gr = grSelect.value;
    const grNum = gr === '七年級' ? 7 : (gr === '八年級' ? 8 : 9);
    cInput.placeholder = `如：${grNum}01, ${grNum}16`;
  }
  onAddAthleteClassInput();
}

function onAddAthleteClassInput() {
  const cInput = document.getElementById('add-athlete-class');
  if (!cInput) return;
  const val = cInput.value.trim();
  const evSelect = document.getElementById('add-athlete-event');
  const ev = evSelect ? evSelect.value : 'grandRelay';
  const isGrandRelay = (ev === 'grandRelay');
  const isRelay4 = (ev === 'relay4x200');
  const nInput = document.getElementById('add-athlete-name');
  const rInput = document.getElementById('add-athlete-remarks');

  if (val.length >= 1) {
    const firstChar = val.charAt(0);
    const grSelect = document.getElementById('add-athlete-grade');
    if (grSelect) {
      if (firstChar === '7') grSelect.value = '七年級';
      else if (firstChar === '8') grSelect.value = '八年級';
      else if (firstChar === '9') grSelect.value = '九年級';
    }
  }

  if (val.endsWith('16') && rInput && !rInput.value) {
    rInput.value = '體育班';
  }
  if (isGrandRelay && nInput && (!nInput.value || nInput.value.includes('大隊接力隊'))) {
    nInput.value = val ? `${val} 班大隊接力隊` : '';
  } else if (isRelay4 && nInput && (!nInput.value || nInput.value.includes('接力隊') || nInput.value.includes('代表隊'))) {
    nInput.value = val ? `${val} 班接力代表隊` : '';
  }
}

function submitAddAthleteModal() {
  const evSelect = document.getElementById('add-athlete-event');
  const grSelect = document.getElementById('add-athlete-grade');
  const gdSelect = document.getElementById('add-athlete-gender');
  const cInput = document.getElementById('add-athlete-class');
  const bInput = document.getElementById('add-athlete-bib');
  const nInput = document.getElementById('add-athlete-name');
  const hInput = document.getElementById('add-athlete-heat');
  const lInput = document.getElementById('add-athlete-lane');
  const rInput = document.getElementById('add-athlete-remarks');

  const evKey = evSelect ? evSelect.value : 'grandRelay';
  const grade = grSelect ? grSelect.value : '七年級';
  const gender = gdSelect ? gdSelect.value : '男生組';
  const classId = cInput ? cInput.value.trim() : '';
  const bib = bInput ? bInput.value.trim() : '';
  const name = nInput ? nInput.value.trim() : '';
  const heat = hInput ? hInput.value.trim() || '第 1 組' : '第 1 組';
  const lane = lInput ? lInput.value.trim() || '1' : '1';
  const remarks = rInput ? rInput.value.trim() : '';

  if (!classId) {
    showToast('⚠️ 請輸入出賽班級代碼（如 701, 716）', 'error');
    if (cInput) cInput.focus();
    return;
  }

  const isRelay = (evKey === 'grandRelay' || evKey === 'relay4x200');
  if (!name && !isRelay) {
    showToast('⚠️ 請輸入選手姓名', 'error');
    if (nInput) nInput.focus();
    return;
  }

  syncAdminDomInputsToState();

  const list = getAdminCurrentEventList(evKey);
  const isSports = String(classId).endsWith('16');
  const isField = (evKey === 'shotPut' || evKey === 'longJump');
  const numLane = parseInt(lane, 10);
  const laneVal = !isNaN(numLane) ? numLane : lane;

  let finalName = name;
  if (!finalName) {
    if (evKey === 'grandRelay') finalName = `${classId} 班大隊接力隊`;
    else if (evKey === 'relay4x200') finalName = `${classId} 班接力代表隊`;
    else finalName = `${classId} 班選手`;
  }

  const newEntry = {
    id: `MANUAL_${evKey}_${classId}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    grade,
    gender: (evKey === 'grandRelay') ? '混組' : gender,
    event: getEventDisplayName(evKey),
    classId,
    classNo: classId,
    bib: bib || '',
    name: finalName,
    heat: heat,
    flight: heat,
    lane: laneVal,
    order: laneVal,
    isSportsClass: isSports,
    rawScore: '',
    foulCount: 0,
    score: '',
    att1: '',
    att2: '',
    att3: '',
    best: '',
    bestDistance: null,
    formattedBest: '',
    rank: '',
    rankNumber: null,
    rankText: '',
    remarks: remarks || (isSports ? '體育班' : '')
  };

  list.push(newEntry);
  sortEventListByHeatAndLane(list);

  // 切換至新增項目的年級與性別以便管理員立即查看
  APP_STATE.adminEdit.event = evKey;
  APP_STATE.adminEdit.grade = grade;
  APP_STATE.adminEdit.gender = (evKey === 'grandRelay') ? '混組' : gender;

  const eventSelect = document.getElementById('admin-event-select');
  const gradeSelect = document.getElementById('admin-grade-select');
  const genderSelect = document.getElementById('admin-gender-select');
  if (eventSelect) eventSelect.value = evKey;
  if (gradeSelect) gradeSelect.value = grade;
  if (genderSelect) genderSelect.value = (evKey === 'grandRelay') ? '混組' : gender;

  saveLocalData();
  renderAdminEditTable();
  renderLeaderboard();
  renderClassRoster();
  renderMasterSchedule();
  renderTeacherDuties();
  if (APP_STATE.leaderboardFilter.subTab === 'points') {
    renderClassPointsView();
  }

  closeAddAthleteModal();
  showToast(`✅ 已成功新增【${classId} 班 ${finalName}】至【${getEventDisplayName(evKey)}】！所有畫面與列印報表已全面連動更新。`);
}

function getEventDisplayName(key) {
  const map = {
    grandRelay: '大隊接力',
    relay4x200: '4X200M 接力',
    '100m': '100公尺預賽',
    '100m_finals': '100公尺決賽',
    '200m': '200公尺預賽',
    '200m_finals': '200公尺決賽',
    '400m': '400公尺決賽',
    '800m': '800公尺決賽',
    '1500m': '1500公尺決賽',
    shotPut: '鉛球決賽',
    longJump: '跳遠決賽'
  };
  return map[key] || key;
}

// 快速帶入示範成績（全數採用如：4分15秒34之標準格式）
function loadRealisticSampleScores() {
  if (!confirm('確定要載入示範成績進行功能展示嗎？這將會更新目前無成績之項目，格式均為如「4分15秒34」。')) return;

  // 大隊接力示範成績 (體育班成績最快，與普通班第一名形成「兩個並列第一」規範展示)
  APP_STATE.data.events.grandRelay.forEach(item => {
    const cNum = parseInt(item.classId.slice(1), 10) || 1;
    if (item.grade === '七年級') {
      if (item.classId === '716') { item.rawScore = '3分00秒80'; item.foulCount = 0; } // 體育班全體最快 -> 並列第一！
      else if (item.classId === '709') { item.rawScore = '3分02秒40'; item.foulCount = 0; } // 普通班第1名 -> 並列第一！
      else if (item.classId === '701') { item.rawScore = '3分05秒10'; item.foulCount = 0; } // 普通班第2名
      else if (item.classId === '705') { item.rawScore = '3分08秒50'; item.foulCount = 0; } // 普通班第3名
      else {
        const sec = 191 + (cNum % 12) * 1.6;
        item.rawScore = formatSecondsToChinese(sec);
        item.foulCount = 0;
      }
    } else if (item.grade === '八年級') {
      if (item.classId === '816') { item.rawScore = '2分54秒20'; item.foulCount = 0; } // 體育班全體最快 -> 並列第一！
      else if (item.classId === '802') { item.rawScore = '2分57秒80'; item.foulCount = 0; } // 普通班第1名 -> 並列第一！
      else if (item.classId === '801') { item.rawScore = '3分01秒20'; item.foulCount = 0; } // 普通班第2名
      else if (item.classId === '805') { item.rawScore = '3分04秒80'; item.foulCount = 0; } // 普通班第3名
      else {
        const sec = 187 + (cNum % 12) * 1.5;
        item.rawScore = formatSecondsToChinese(sec);
        item.foulCount = 0;
      }
    } else if (item.grade === '九年級') {
      if (item.classId === '916') { item.rawScore = '2分42秒50'; item.foulCount = 0; } // 體育班全體最快 -> 並列第一！
      else if (item.classId === '907') { item.rawScore = '2分45秒19'; item.foulCount = 0; } // 普通班第1名 -> 並列第一！
      else if (item.classId === '903') { item.rawScore = '2分49秒20'; item.foulCount = 0; } // 普通班第2名
      else if (item.classId === '904') { item.rawScore = '2分51秒50'; item.foulCount = 0; } // 普通班第3名
      else {
        const sec = 175 + (cNum % 12) * 1.5;
        item.rawScore = formatSecondsToChinese(sec);
        item.foulCount = 0;
      }
    }
  });

  // 800M 示範成績 (如：2分35秒40)
  APP_STATE.data.events.e800m.forEach((item, idx) => {
    if (isSportsClass(item)) {
      const sec = item.gender === '男生組' ? 138.5 : 158.0;
      item.score = formatSecondsToChinese(sec);
    } else {
      const sec = (item.gender === '男生組' ? 142 : 165) + (idx % 15) * 1.8;
      item.score = formatSecondsToChinese(sec);
    }
  });

  // 1500M 示範成績 (如：4分58秒12)
  APP_STATE.data.events.e1500m.forEach((item, idx) => {
    if (isSportsClass(item)) {
      const sec = 278.5;
      item.score = formatSecondsToChinese(sec);
    } else {
      const sec = 286.0 + (idx % 15) * 3.2;
      item.score = formatSecondsToChinese(sec);
    }
  });

  // 400M 示範成績 (如：1分02秒15)
  APP_STATE.data.events.e400m.forEach((item, idx) => {
    if (isSportsClass(item)) {
      const sec = item.gender === '男生組' ? 56.5 : 65.2;
      item.score = formatSecondsToChinese(sec);
    } else {
      const sec = (item.gender === '男生組' ? 59 : 68) + (idx % 15) * 0.8;
      item.score = formatSecondsToChinese(sec);
    }
  });

  // 4X200M 接力示範成績 (如：1分52秒40)
  APP_STATE.data.events.relay4x200.forEach((item, idx) => {
    if (isSportsClass(item)) {
      const sec = item.gender === '男生組' ? 104.5 : 114.2;
      item.score = formatSecondsToChinese(sec);
    } else {
      const sec = (item.gender === '男生組' ? 108 : 118) + (idx % 15) * 1.5;
      item.score = formatSecondsToChinese(sec);
    }
  });

  // 短跑 100M 示範成績 (如：12秒35)
  APP_STATE.data.events.e100m.forEach((item, idx) => {
    if (isSportsClass(item)) {
      const sec = item.gender === '男生組' ? 11.65 : 12.80;
      item.score = formatSecondsToChinese(sec);
    } else {
      const base = item.gender === '男生組' ? 12.10 : 13.50;
      const sec = base + (idx % 15) * 0.15;
      item.score = formatSecondsToChinese(sec);
    }
  });

  // 短跑 200M 示範成績 (如：25秒80)
  APP_STATE.data.events.e200m.forEach((item, idx) => {
    if (isSportsClass(item)) {
      const sec = item.gender === '男生組' ? 24.50 : 27.20;
      item.score = formatSecondsToChinese(sec);
    } else {
      const base = item.gender === '男生組' ? 25.20 : 28.00;
      const sec = base + (idx % 15) * 0.25;
      item.score = formatSecondsToChinese(sec);
    }
  });

  // 鉛球示範成績 (精準展示 716 班 李昱昕 11.02m 與 702 班 吳正龍 10.97m 兩個並列第一規範)
  APP_STATE.data.events.shotPut.forEach((item, idx) => {
    if (isSportsClass(item)) {
      if (item.grade === '七年級' && item.gender === '男生組') {
        if (item.name === '李昱昕' || item.id === 'SHOT_14') {
          item.att1 = '10.85';
          item.att2 = '11.02';
          item.att3 = '10.95';
        } else {
          item.att1 = '9.50';
          item.att2 = '9.85';
          item.att3 = '9.60';
        }
      } else if (item.grade === '八年級' && item.gender === '男生組') {
        item.att1 = '12.10';
        item.att2 = '12.45';
        item.att3 = '12.30';
      } else if (item.grade === '九年級' && item.gender === '男生組') {
        item.att1 = '13.20';
        item.att2 = '13.50';
        item.att3 = '13.40';
      } else {
        item.att1 = '10.50';
        item.att2 = '10.80';
        item.att3 = '10.65';
      }
    } else {
      if (item.grade === '七年級' && item.gender === '男生組') {
        if (item.classId === '702' && (item.name === '吳正龍' || item.id === 'SHOT_4')) {
          item.att1 = '10.55';
          item.att2 = '10.97';
          item.att3 = '10.80';
        } else if (item.classId === '705' && (item.name === '陳虹閔' || item.id === 'SHOT_5')) {
          item.att1 = '10.30';
          item.att2 = '10.67';
          item.att3 = '10.50';
        } else if (item.classId === '701' && (item.name === '蔡裔勝' || item.id === 'SHOT_13')) {
          item.att1 = '9.90';
          item.att2 = '10.20';
          item.att3 = '10.05';
        } else {
          const b = 8.0 + (idx % 8) * 0.25;
          item.att1 = b.toFixed(2);
          item.att2 = (b + 0.15).toFixed(2);
          item.att3 = (b - 0.10).toFixed(2);
        }
      } else {
        const b = 7.5 + (idx % 10) * 0.35;
        item.att1 = b.toFixed(2);
        item.att2 = (b + 0.2).toFixed(2);
        item.att3 = (b + 0.1).toFixed(2);
      }
    }
  });

  // 跳遠示範成績 (確保體育班與普通班第 1 名並列第一，前三名完整頒獎卡片)
  APP_STATE.data.events.longJump.forEach((item, idx) => {
    if (isSportsClass(item)) {
      if (item.grade === '七年級' && item.gender === '男生組') {
        item.att1 = '5.40';
        item.att2 = '5.65';
        item.att3 = '5.50';
      } else if (item.grade === '八年級' && item.gender === '男生組') {
        item.att1 = '5.85';
        item.att2 = '6.10';
        item.att3 = '5.95';
      } else if (item.grade === '九年級' && item.gender === '男生組') {
        item.att1 = '6.20';
        item.att2 = '6.45';
        item.att3 = '6.30';
      } else {
        item.att1 = '4.80';
        item.att2 = '5.10';
        item.att3 = '4.95';
      }
    } else {
      if (item.grade === '七年級' && item.gender === '男生組') {
        if (item.classId === '706' || item.name === '吳威澄') {
          item.att1 = '5.30';
          item.att2 = '5.50';
          item.att3 = '5.42';
        } else if (item.classId === '714' || item.name === '劉書宇') {
          item.att1 = '5.10';
          item.att2 = '5.25';
          item.att3 = '5.15';
        } else if (item.classId === '701' || item.name === '黎賀瑋') {
          item.att1 = '4.88';
          item.att2 = '5.05';
          item.att3 = '4.95';
        } else {
          const b = 4.10 + (idx % 8) * 0.10;
          item.att1 = b.toFixed(2);
          item.att2 = (b + 0.12).toFixed(2);
          item.att3 = (b + 0.05).toFixed(2);
        }
      } else {
        const b = 4.20 + (idx % 10) * 0.12;
        item.att1 = b.toFixed(2);
        item.att2 = (b + 0.10).toFixed(2);
        item.att3 = (b + 0.05).toFixed(2);
      }
    }
  });

  saveLocalData();
  renderLeaderboard();
  renderClassRoster();
  renderAdminEditTable();
  showToast('⚡ 示範成績已成功載入（格式如：4分15秒34）！可前往【即時榜單】查看。');
}

// 清空全站所有競賽項目已登記的比賽成績（選手名冊與分組分道完整保留，需密碼 tqjh888）
function clearAllMatchScores() {
  const pwd = prompt('🔒 安全防護確認：\n\n您即將清空【全校所有競賽項目】已登錄的比賽成績紀錄！\n選手名冊與分組道次將完整保留。\n\n請輸入管理者密碼確認：');
  if (pwd === null) return;
  if (pwd.trim() !== 'tqjh888') {
    alert('❌ 密碼錯誤！無法清空全校成績。');
    return;
  }

  if (!confirm('⚠️ 最後警告：這將會清空全校所有項目（田賽、徑賽、接力、大隊接力）已登記的比賽成績、試跳/擲距離與犯規紀錄。\n\n【選手名冊、班級與分組分道將完整保留不受影響】\n\n確定要清空全站比賽成績嗎？')) return;

  const events = APP_STATE.data && APP_STATE.data.events;
  if (!events) return;

  Object.keys(events).forEach(key => {
    const list = events[key];
    if (Array.isArray(list)) {
      list.forEach(item => {
        item.score = '';
        if (item.rawScore !== undefined) item.rawScore = '';
        if (item.foulCount !== undefined) item.foulCount = 0;
        if (item.att1 !== undefined) item.att1 = '';
        if (item.att2 !== undefined) item.att2 = '';
        if (item.att3 !== undefined) item.att3 = '';
        if (item.best !== undefined) item.best = '';
        delete item.formattedBest;
        delete item.bestDistance;
        delete item.finalSeconds;
        delete item.finalScore;
        delete item.formattedFinal;
        delete item.formattedRaw;
      });
    }
  });

  localStorage.removeItem('TQ_LATEST_SCORED_EVENT');
  APP_STATE.leaderboardFilter.event = 'grandRelay';
  APP_STATE.leaderboardFilter.grade = '七年級';
  APP_STATE.leaderboardFilter.gender = 'all';
  updateLeaderboardFilterPillsUI();

  saveLocalData();
  renderLeaderboard();
  renderClassRoster();
  renderAdminEditTable();
  showToast('🧹 已成功清空全站所有比賽成績（選手名單與分組道次已完整保留）');
}

// 相容舊函式呼叫
function resetToOfficialSeedData() {
  clearAllMatchScores();
}

function updateAcademicYearHeaderUI() {
  const selectEl = document.getElementById('header-academic-year-select');
  const badge = document.getElementById('header-academic-year-badge');
  const curYr = APP_STATE.currentYear || (APP_STATE.data && APP_STATE.data.meta && APP_STATE.data.meta.academicYear) || '115';

  if (!APP_STATE.years) APP_STATE.years = {};
  if (!APP_STATE.years[curYr] && APP_STATE.data) {
    APP_STATE.years[curYr] = APP_STATE.data;
  }

  const availableYears = Object.keys(APP_STATE.years).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  if (!availableYears.includes(curYr)) {
    availableYears.push(curYr);
  }

  if (selectEl) {
    selectEl.innerHTML = availableYears.map(yr => {
      return `<option value="${yr}" ${yr === curYr ? 'selected' : ''}>${yr}學年度校慶</option>`;
    }).join('');
    selectEl.value = curYr;
  }

  if (badge) {
    badge.textContent = `${curYr}學年度校慶`;
  }

  // 同步更新大會賽程總表標題
  const scheduleTitle = document.querySelector('#tab-schedule .card-title');
  if (scheduleTitle) {
    scheduleTitle.textContent = `📅 ${curYr}學年度校慶單項田徑賽賽程總表`;
  }

  // 同步更新列印通知單標題
  const printH2 = document.querySelector('.print-header h2');
  if (printH2) {
    printH2.textContent = `新北市立頭前國民中學 ${curYr}學年度校慶運動大會`;
  }
}

// 建立新學年度 (自動封存當前年度)
function createNewAcademicYear() {
  const newYear = prompt('請輸入欲建立的新學年度（如 116 或 117）：', '116');
  if (!newYear) return;

  const yrStr = String(newYear).trim();
  const confirmGen = confirm(`系統將自動生成【${yrStr}學年度】七、八、九年級各 16 個班（共48班，716/816/916為體育班）之全新賽事框架。\n\n舊學年度（如 ${APP_STATE.currentYear}）資料將自動完整封存，您可隨時由上方選單切換查閱。\n確定建立嗎？`);
  if (!confirmGen) return;

  const newData = JSON.parse(JSON.stringify(window.INITIAL_MEET_DATA));
  newData.meta.academicYear = yrStr;
  newData.meta.meetTitle = `新北市立頭前國民中學${yrStr}學年度校慶運動大會田徑賽事`;

  Object.keys(newData.events).forEach(k => {
    newData.events[k].forEach(item => {
      item.score = '';
      item.rawScore = '';
      item.foulCount = 0;
      item.att1 = '';
      item.att2 = '';
      item.att3 = '';
      item.rank = '';
    });
  });

  if (!APP_STATE.years) APP_STATE.years = {};
  if (APP_STATE.currentYear && APP_STATE.data) {
    APP_STATE.years[APP_STATE.currentYear] = APP_STATE.data;
  }

  APP_STATE.years[yrStr] = newData;
  APP_STATE.currentYear = yrStr;
  APP_STATE.data = newData;
  saveLocalData();

  updateAcademicYearHeaderUI();
  initClassSearchOptions();
  renderLeaderboard();
  renderClassRoster();
  renderMasterSchedule();
  initTeacherDashboard();
  renderTeacherDuties();
  renderAdminEditTable();
  showToast(`🎉 已成功建立【${yrStr}學年度】全新賽事框架！舊學年度已安全封存。`);
}

// JSON 匯出與匯入 (支援多學年度全量備份與還原)
function exportDataAsJSON() {
  if (!APP_STATE.years) APP_STATE.years = {};
  if (APP_STATE.currentYear && APP_STATE.data) {
    APP_STATE.years[APP_STATE.currentYear] = APP_STATE.data;
  }

  const exportPayload = {
    version: '2.0',
    exportedAt: new Date().toISOString(),
    activeYear: APP_STATE.currentYear || '115',
    availableYears: Object.keys(APP_STATE.years),
    years: APP_STATE.years,
    meta: APP_STATE.data ? APP_STATE.data.meta : null,
    events: APP_STATE.data ? APP_STATE.data.events : null
  };

  const jsonStr = JSON.stringify(exportPayload, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `頭前國中_校慶田徑賽_全學年完整備份_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('📥 全學年完整備份 JSON 檔案已下載！');
}

// 一鍵匯出為 meet_data.js（上傳覆蓋 GitHub 倉庫，直接讓全校所有裝置立即看到最新成績）
function exportMeetDataJs() {
  if (!APP_STATE.data) {
    showToast('❌ 目前尚無賽事資料可匯出', 'error');
    return;
  }
  if (!APP_STATE.data.meta) APP_STATE.data.meta = {};
  APP_STATE.data.meta.updatedAt = new Date().toISOString();

  const content = 'window.INITIAL_MEET_DATA = ' + JSON.stringify(APP_STATE.data, null, 2) + ';\n';
  const blob = new Blob([content], { type: 'application/javascript;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'meet_data.js';
  a.click();
  URL.revokeObjectURL(url);
  showToast('📥 已成功匯出 meet_data.js！將此檔案上傳到 GitHub，其他電腦載具開啟即可看到最新成績！');
}
window.exportMeetDataJs = exportMeetDataJs;

// 手動從線上 INITIAL_MEET_DATA 強制同步
function syncWithOnlineSeedData() {
  if (!window.INITIAL_MEET_DATA) {
    alert('目前線上無初始資料檔');
    return;
  }
  if (!confirm('確定要從線上重新載入大會最新資料與成績嗎？\n這將會以 GitHub 上的最新版本更新此裝置。')) {
    return;
  }
  APP_STATE.data = JSON.parse(JSON.stringify(window.INITIAL_MEET_DATA));
  if (!APP_STATE.years) APP_STATE.years = {};
  APP_STATE.years[APP_STATE.currentYear || '115'] = APP_STATE.data;
  saveLocalData();
  renderLeaderboard();
  renderClassRoster();
  renderMasterSchedule();
  renderAdminEditTable();
  showToast('✅ 已成功從線上同步最新成績！');
}
window.syncWithOnlineSeedData = syncWithOnlineSeedData;

function importDataFromJSON(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (!confirm(`確定要匯入備份檔「${file.name}」嗎？\n這將會還原備份中的所有學年度與賽事成績。`)) {
    event.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (parsed.years && typeof parsed.years === 'object') {
        APP_STATE.years = parsed.years;
        const activeYr = parsed.activeYear || Object.keys(parsed.years)[0] || '115';
        APP_STATE.currentYear = String(activeYr);
        APP_STATE.data = APP_STATE.years[APP_STATE.currentYear];
      } else if (parsed.meta && parsed.events) {
        const yr = String((parsed.meta && parsed.meta.academicYear) || '115');
        if (!APP_STATE.years) APP_STATE.years = {};
        APP_STATE.years[yr] = parsed;
        APP_STATE.currentYear = yr;
        APP_STATE.data = parsed;
      } else {
        alert('匯入失敗：該檔案非本系統專用的賽事備份 JSON 檔案。');
        return;
      }

      saveLocalData();
      updateAcademicYearHeaderUI();
      initClassSearchOptions();
      renderLeaderboard();
      renderClassRoster();
      renderMasterSchedule();
      initTeacherDashboard();
      renderTeacherDuties();
      renderAdminEditTable();
      showToast('📤 賽事資料已成功自 JSON 完整還原！');
    } catch (err) {
      alert('匯入解析失敗：' + err.message);
    } finally {
      event.target.value = '';
    }
  };
  reader.readAsText(file);
}

// ==========================================
// 9.5 Excel 一鍵匯入全校賽程與選手名單模組 (SheetJS Client-Side Import)
// ==========================================

function openExcelImportModal() {
  if (!APP_STATE.isAdminUnlocked) {
    openAdminAuthModal();
    showToast('🔒 請先以管理者身分登入後再進行 Excel 匯入');
    return;
  }

  const modal = document.getElementById('excel-import-modal');
  if (!modal) return;

  const curYr = (APP_STATE.data && APP_STATE.data.meta && APP_STATE.data.meta.academicYear) ? parseInt(APP_STATE.data.meta.academicYear) : 115;
  const yearInput = document.getElementById('excel-academic-year-input');
  if (yearInput) yearInput.value = isNaN(curYr) ? '116' : String(curYr + 1);

  const fileInput = document.getElementById('excel-file-input');
  if (fileInput) fileInput.value = '';

  const msgEl = document.getElementById('excel-import-msg');
  if (msgEl) msgEl.innerHTML = '';

  const previewEl = document.getElementById('excel-import-preview');
  if (previewEl) previewEl.style.display = 'none';

  const btnApply = document.getElementById('btn-apply-excel');
  if (btnApply) btnApply.disabled = true;

  APP_STATE.importedExcelData = null;

  bindExcelDropZone();
  modal.classList.add('active');
}

function closeExcelImportModal() {
  const modal = document.getElementById('excel-import-modal');
  if (modal) modal.classList.remove('active');
  APP_STATE.importedExcelData = null;
}

function bindExcelDropZone() {
  const dropZone = document.getElementById('excel-drop-zone');
  if (!dropZone || dropZone._dragBound) return;
  dropZone._dragBound = true;

  ['dragenter', 'dragover'].forEach(name => {
    dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-over');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length > 0) {
      processExcelFile(dt.files[0]);
    }
  });
}

function handleExcelFileInput(e) {
  if (e.target.files && e.target.files.length > 0) {
    processExcelFile(e.target.files[0]);
  }
}

function processExcelFile(file) {
  const msgEl = document.getElementById('excel-import-msg');
  const previewEl = document.getElementById('excel-import-preview');
  const btnApply = document.getElementById('btn-apply-excel');
  const filenameEl = document.getElementById('preview-filename');
  const statsGrid = document.getElementById('preview-stats-grid');
  const yearInput = document.getElementById('excel-academic-year-input');

  if (!file) return;

  const validExts = ['.xlsx', '.xls'];
  const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
  if (!validExts.includes(ext)) {
    if (msgEl) msgEl.innerHTML = `<span style="color:#ef4444; font-weight:700;">❌ 檔案格式不支援！請選取 .xlsx 或 .xls 的 Excel 檔案。</span>`;
    return;
  }

  if (typeof XLSX === 'undefined') {
    if (msgEl) msgEl.innerHTML = `<span style="color:#ef4444; font-weight:700;">❌ 系統尚未載入 Excel 解析核心，請檢查網路連線或 xlsx.full.min.js。</span>`;
    return;
  }

  if (msgEl) msgEl.innerHTML = `<span style="color:#0284c7; font-weight:700;">⏳ 正在解析 Excel 內容，請稍候...</span>`;
  if (btnApply) btnApply.disabled = true;

  const yearVal = yearInput ? (yearInput.value.trim() || '116') : '116';

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: 'array' });
      const parsedData = parseExcelMeetWorkbook(wb, yearVal);

      APP_STATE.importedExcelData = parsedData;

      if (filenameEl) filenameEl.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;

      if (statsGrid) {
        const stats = [
          { label: '設定學年度', val: `${parsedData.meta.academicYear} 學年` },
          { label: '大會賽程', val: `${parsedData.schedule.length} 節次` },
          { label: '100M 選手', val: `${parsedData.events.e100m.length} 人` },
          { label: '200M 選手', val: `${parsedData.events.e200m.length} 人` },
          { label: '400M 選手', val: `${parsedData.events.e400m.length} 人` },
          { label: '800M 選手', val: `${parsedData.events.e800m.length} 人` },
          { label: '1500M 選手', val: `${parsedData.events.e1500m.length} 人` },
          { label: '鉛球 選手', val: `${parsedData.events.shotPut.length} 人` },
          { label: '跳遠 選手', val: `${parsedData.events.longJump.length} 人` },
          { label: '4X200M 接力', val: `${parsedData.events.relay4x200.length} 隊` },
          { label: '大隊接力', val: `${parsedData.events.grandRelay.length} 隊` },
          { label: '裁判師資庫', val: `${Object.keys(parsedData.teachers).length} 位` }
        ];

        statsGrid.innerHTML = stats.map(s => `
          <div class="excel-stat-badge">
            <span class="stat-label">${s.label}</span>
            <span class="stat-val">${s.val}</span>
          </div>
        `).join('');
      }

      if (previewEl) previewEl.style.display = 'block';
      if (msgEl) msgEl.innerHTML = `<span style="color:#16a34a; font-weight:700;">🎉 檔案解析成功！已成功分析各項名冊與賽程，請點選下方按鈕啟用。</span>`;
      if (btnApply) btnApply.disabled = false;

    } catch (err) {
      console.error(err);
      if (msgEl) msgEl.innerHTML = `<span style="color:#ef4444; font-weight:700;">❌ 解析失敗：${err.message || '工作表格式不符'}</span>`;
      if (previewEl) previewEl.style.display = 'none';
      if (btnApply) btnApply.disabled = true;
    }
  };

  reader.onerror = function() {
    if (msgEl) msgEl.innerHTML = `<span style="color:#ef4444; font-weight:700;">❌ 檔案讀取失敗，請重新嘗試。</span>`;
  };

  reader.readAsArrayBuffer(file);
}

function parseExcelMeetWorkbook(wb, academicYear) {
  if (!academicYear) academicYear = '116';
  const sheetNames = wb.SheetNames;

  function splitStudent(raw) {
    if (!raw) return { bib: '', name: '' };
    raw = String(raw).trim();
    const m = raw.match(/^(\d+)[.\s]*(.+)$/);
    if (m) {
      return { bib: m[1], name: m[2].trim() };
    }
    return { bib: '', name: raw };
  }

  function getSheet(pattern, excludePattern) {
    const found = sheetNames.find(n => {
      if (excludePattern && n.includes(excludePattern)) return false;
      return n.includes(pattern);
    });
    return found ? wb.Sheets[found] : null;
  }

  // 1. 賽程-工作分配
  const sSchedule = getSheet('賽程');
  const scheduleRows = sSchedule ? XLSX.utils.sheet_to_json(sSchedule, { header: 'A', defval: '' }) : [];
  const schedule = [];
  let curDate = '';

  for (let r = 2; r < scheduleRows.length; r++) {
    const row = scheduleRows[r];
    if (row.A && String(row.A).trim()) curDate = String(row.A).trim();
    const period = String(row.B || '').trim();
    const group = String(row.C || '').trim();
    const event = String(row.D || '').trim();
    if (!group && !event) continue;

    schedule.push({
      id: `SCH_${r + 1}`,
      date: curDate,
      period: period,
      group: group,
      event: event,
      round: String(row.E || '').trim(),
      remarks: String(row.F || '').trim(),
      leave: String(row.G || '').trim(),
      duty: String(row.H || '').trim(),
      volunteers: String(row.I || '').trim(),
      misc: String(row.J || '').trim()
    });
  }

  // 補齊同前節裁判
  for (let i = 0; i < schedule.length; i++) {
    if (!schedule[i].duty && i > 0 && schedule[i].date === schedule[i - 1].date) {
      schedule[i].duty = `同前節（${schedule[i - 1].duty}）`;
    }
  }

  // 通用單項徑賽解析 (100M, 200M, 400M)
  function parseTrackRows(sheet, eventName, keyPrefix) {
    if (!sheet) return [];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 'A', defval: '' });
    const list = [];
    rows.forEach((r, idx) => {
      const grade = String(r.A || '').trim();
      const ev = String(r.C || '').trim();
      if (['七年級', '八年級', '九年級'].includes(grade) && ev.includes(eventName.slice(0, 3))) {
        const { bib, name } = splitStudent(r.G);
        const laneVal = parseInt(r.F, 10);
        list.push({
          id: `${keyPrefix}_${idx + 1}`,
          grade: grade,
          gender: String(r.B || '').trim(),
          event: eventName,
          classId: String(r.D || '').trim(),
          isSportsClass: String(r.D || '').endsWith('16'),
          heat: String(r.E || '').trim(),
          lane: isNaN(laneVal) ? String(r.F || '').trim() : laneVal,
          bib: bib,
          name: name,
          rawName: String(r.G || '').trim(),
          score: '',
          rank: ''
        });
      }
    });
    return list;
  }

  // 800M / 1500M 中長跑 (姓名在 E 欄，組別在 F 欄)
  function parseMiddleDistanceRows(sheet, eventName, keyPrefix) {
    if (!sheet) return [];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 'A', defval: '' });
    const list = [];
    rows.forEach((r, idx) => {
      const grade = String(r.A || '').trim();
      const ev = String(r.C || '').trim();
      if (['七年級', '八年級', '九年級'].includes(grade) && ev.includes(eventName.slice(0, 3))) {
        const { bib, name } = splitStudent(r.E);
        let heatVal = String(r.F || '').trim();
        if (heatVal && !heatVal.startsWith('第')) heatVal = `第 ${heatVal} 組`;
        list.push({
          id: `${keyPrefix}_${idx + 1}`,
          grade: grade,
          gender: String(r.B || '').trim(),
          event: eventName,
          classId: String(r.D || '').trim(),
          isSportsClass: String(r.D || '').endsWith('16'),
          heat: heatVal,
          lane: null,
          bib: bib,
          name: name,
          rawName: String(r.E || '').trim(),
          score: '',
          rank: ''
        });
      }
    });
    return list;
  }

  // 鉛球 / 跳遠 (田賽)
  function parseFieldRows(sheet, eventName, keyPrefix) {
    if (!sheet) return [];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 'A', defval: '' });
    const list = [];
    let curKey = null;
    let curFlight = 1;
    let prevOrder = 0;

    rows.forEach((r, idx) => {
      const grade = String(r.A || '').trim();
      const ev = String(r.C || '').trim();
      if (['七年級', '八年級', '九年級'].includes(grade) && ev.includes(eventName)) {
        const gender = String(r.B || '').trim();
        const key = `${grade}_${gender}`;
        const order = parseInt(r.F, 10) || 1;
        if (key !== curKey) {
          curKey = key;
          curFlight = 1;
          prevOrder = order;
        } else {
          if (order < prevOrder) curFlight += 1;
          prevOrder = order;
        }

        const { bib, name } = splitStudent(r.G);
        list.push({
          id: `${keyPrefix}_${idx + 1}`,
          grade: grade,
          gender: gender,
          event: eventName,
          classId: String(r.D || '').trim(),
          isSportsClass: String(r.D || '').endsWith('16'),
          flight: `第 ${curFlight} 組`,
          order: order,
          bib: bib,
          name: name,
          rawName: String(r.G || '').trim(),
          att1: '',
          att2: '',
          att3: '',
          best: '',
          rank: ''
        });
      }
    });
    return list;
  }

  // 4X200M 接力 (A~G 欄為女生組，I~O 欄為男生組)
  function parse4x200Relay(sheet) {
    if (!sheet) return [];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 'A', defval: '' });
    const list = [];

    const ranges = [
      { grade: '七年級', start: 3, end: 18 },
      { grade: '八年級', start: 21, end: 36 },
      { grade: '九年級', start: 39, end: 54 }
    ];

    ranges.forEach(r => {
      let curHeatF = '';
      let curHeatM = '';
      for (let i = r.start; i <= r.end && i < rows.length; i++) {
        const row = rows[i];
        if (row.A && String(row.A).trim()) curHeatF = String(row.A).trim();
        if (row.I && String(row.I).trim()) curHeatM = String(row.I).trim();

        // 女生組
        const classF = String(row.C || '').trim();
        if (classF && /^\d{3}$/.test(classF)) {
          const laneF = parseInt(row.B, 10);
          list.push({
            id: `4X200_F_${i + 1}`,
            grade: r.grade,
            gender: '女生組',
            event: '4X200M接力',
            classId: classF,
            isSportsClass: classF.endsWith('16'),
            heat: curHeatF.startsWith('第') ? curHeatF : `第 ${curHeatF} 組`,
            lane: isNaN(laneF) ? String(row.B || '').trim() : laneF,
            score: '',
            rank: ''
          });
        }

        // 男生組
        const classM = String(row.K || '').trim();
        if (classM && /^\d{3}$/.test(classM)) {
          const laneM = parseInt(row.J, 10);
          list.push({
            id: `4X200_M_${i + 1}`,
            grade: r.grade,
            gender: '男生組',
            event: '4X200M接力',
            classId: classM,
            isSportsClass: classM.endsWith('16'),
            heat: curHeatM.startsWith('第') ? curHeatM : `第 ${curHeatM} 組`,
            lane: isNaN(laneM) ? String(row.J || '').trim() : laneM,
            score: '',
            rank: ''
          });
        }
      }
    });

    return list;
  }

  // 大隊接力
  function parseGrandRelay(sheet) {
    const list = [];
    if (sheet) {
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 'A', defval: '' });
      let curGrade = '';
      let curHeat = '';

      rows.forEach((r, idx) => {
        const a = String(r.A || '').trim();
        if (a.includes('七年級')) curGrade = '七年級';
        else if (a.includes('八年級')) curGrade = '八年級';
        else if (a.includes('九年級')) curGrade = '九年級';

        if (a.includes('第1組') || a.includes('第一組')) curHeat = '第 1 組';
        else if (a.includes('第2組') || a.includes('第二組')) curHeat = '第 2 組';

        const laneVal = parseInt(r.B, 10);
        const rawClass = String(r.C || '').trim();
        const m = rawClass.match(/(\d{3})/);
        if (curGrade && m && !isNaN(laneVal)) {
          const cid = m[1];
          list.push({
            id: `GR_${cid}`,
            grade: curGrade,
            gender: '混組',
            event: '大隊接力',
            classId: cid,
            isSportsClass: cid.endsWith('16'),
            heat: curHeat || '第 1 組',
            lane: laneVal,
            rawScore: '',
            foulCount: 0,
            finalScore: '',
            rank: '',
            remarks: ''
          });
        }
      });
    }

    // 若 Excel 內未列出或讀取筆數不全，確保各年級 16 班皆有預設項目
    if (list.length === 0) {
      for (let g = 7; g <= 9; g++) {
        const grText = `${g === 7 ? '七' : (g === 8 ? '八' : '九')}年級`;
        for (let c = 1; c <= 16; c++) {
          const cid = `${g}${c < 10 ? '0' + c : c}`;
          list.push({
            id: `GR_${cid}`,
            grade: grText,
            gender: '混組',
            event: '大隊接力',
            classId: cid,
            isSportsClass: (c === 16),
            heat: c <= 8 ? '第 1 組' : '第 2 組',
            lane: ((c - 1) % 8) + 1,
            rawScore: '',
            foulCount: 0,
            finalScore: '',
            rank: '',
            remarks: ''
          });
        }
      }
    }
    return list;
  }

  // 體育老師工作分配
  const teachers = {
    '忠哲': { assignments: [], dutyCount: 0 },
    '騰毅': { assignments: [], dutyCount: 0 },
    '兆裕': { assignments: [], dutyCount: 0 },
    '承瑋': { assignments: [], dutyCount: 0 },
    '惠芳': { assignments: [], dutyCount: 0 },
    '黃威': { assignments: [], dutyCount: 0 },
    '嘉慶': { assignments: [], dutyCount: 0 },
    '淑靜': { assignments: [], dutyCount: 0 },
    '明昌': { assignments: [], dutyCount: 0 },
    '聰達': { assignments: [], dutyCount: 0 },
    '蕭豐': { assignments: [], dutyCount: 0 },
    '虔怡': { assignments: [], dutyCount: 0 }
  };

  const tNames = Object.keys(teachers);
  schedule.forEach(item => {
    tNames.forEach(tName => {
      if (item.duty && item.duty.includes(tName)) {
        let dutyRole = '大會裁判';
        if (item.duty.includes(`${tName}、`)) {
          const m = item.duty.match(new RegExp(`${tName}[^、，]*?[、，]?(.+?)(?:\\s|$|[、，])`));
          if (m && m[1]) dutyRole = m[1].replace(/[、，]/g, '').trim();
        }
        if (item.duty.includes(`${tName}按錶`)) dutyRole = '終點按錶計時';
        else if (item.duty.includes(`${tName}鳴槍`)) dutyRole = '發令鳴槍裁判';
        else if (item.duty.includes(`${tName}檢錄`)) dutyRole = '檢錄區裁判';
        else if (item.duty.includes(`${tName}跳遠`)) dutyRole = '跳遠裁判/量測';
        else if (item.duty.includes(`${tName}騰毅鉛球`) || item.duty.includes(`${tName}、騰毅鉛球`)) dutyRole = '鉛球裁判/量測';

        teachers[tName].assignments.push({
          date: item.date,
          period: item.period,
          event: item.event,
          group: item.group,
          venue: item.event.includes('跳遠') ? '跳遠沙坑' : (item.event.includes('鉛球') ? '鉛球場' : '操場跑道'),
          dutyRole: dutyRole,
          fullDutyText: item.duty
        });
      }
    });
  });

  tNames.forEach(tName => {
    teachers[tName].dutyCount = teachers[tName].assignments.length;
  });

  return {
    meta: {
      meetTitle: `新北市立頭前國民中學${academicYear}學年度校慶運動大會田徑賽事`,
      academicYear: String(academicYear),
      importedAt: new Date().toISOString()
    },
    schedule: schedule,
    teachers: teachers,
    events: {
      e100m: parseTrackRows(getSheet('100M'), '100公尺', '100M'),
      e200m: parseTrackRows(getSheet('200M'), '200公尺', '200M'),
      e400m: parseTrackRows(getSheet('400M'), '400公尺', '400M'),
      e800m: parseMiddleDistanceRows(getSheet('800M', '接力'), '800公尺', '800M'),
      e1500m: parseMiddleDistanceRows(getSheet('1500M'), '1500公尺', '1500M'),
      shotPut: parseFieldRows(getSheet('鉛球'), '鉛球', 'SP'),
      longJump: parseFieldRows(getSheet('跳遠'), '跳遠', 'LJ'),
      relay4x200: parse4x200Relay(getSheet('800M接力') || getSheet('4X200') || getSheet('接力')),
      grandRelay: parseGrandRelay(getSheet('大隊接力'))
    }
  };
}

function applyImportedExcelMeetData() {
  if (!APP_STATE.importedExcelData) {
    showToast('⚠️ 尚未解析 Excel 資料或解析未完成', 'error');
    return;
  }

  const yr = String(APP_STATE.importedExcelData.meta.academicYear || '116');
  if (!confirm(`確定要將【${yr}學年度】賽事名冊與賽程設為目前運作中的賽事嗎？\n舊學年度（如 ${APP_STATE.currentYear}）資料將自動完整封存，您可隨時由上方選單切換查閱！`)) {
    return;
  }

  // 1. 自動封存當前工作中的學年度資料
  if (!APP_STATE.years) APP_STATE.years = {};
  if (APP_STATE.currentYear && APP_STATE.data) {
    APP_STATE.years[APP_STATE.currentYear] = APP_STATE.data;
  }

  // 2. 登記新學年度資料並切換為當前作用中學年度
  APP_STATE.years[yr] = APP_STATE.importedExcelData;
  APP_STATE.currentYear = yr;
  APP_STATE.data = APP_STATE.importedExcelData;
  saveLocalData();

  // 3. 全面刷新所有介面元件
  updateAcademicYearHeaderUI();
  initClassSearchOptions();
  renderLeaderboard();
  renderClassRoster();
  renderMasterSchedule();
  initTeacherDashboard();
  renderTeacherDuties();
  renderAdminEditTable();

  APP_STATE.importedExcelData = null;
  closeExcelImportModal();
  showToast(`🎉 成功啟用【${yr}學年度】！舊學年度已安全封存，可隨時由上方選單切換查閱。`);
}


// ==========================================
// 10. 多人雲端即時同步方案 (Google Apps Script / Sheets Sync)
// ==========================================
function openSyncConfigModal() {
  const modal = document.getElementById('sync-config-modal');
  if (!modal) return;
  modal.classList.add('active');
  const urlInput = document.getElementById('gas-url-input');
  const toggle = document.getElementById('gas-polling-toggle');
  if (urlInput) urlInput.value = APP_STATE.sync.gasUrl;
  if (toggle) toggle.checked = APP_STATE.sync.pollingEnabled;
}

function closeSyncConfigModal() {
  const modal = document.getElementById('sync-config-modal');
  if (modal) modal.classList.remove('active');
}

function saveSyncConfig() {
  const urlInput = document.getElementById('gas-url-input');
  const toggle = document.getElementById('gas-polling-toggle');

  if (urlInput) {
    APP_STATE.sync.gasUrl = urlInput.value.trim();
    localStorage.setItem('TQ_GAS_URL', APP_STATE.sync.gasUrl);
    if (!APP_STATE.data) APP_STATE.data = {};
    if (!APP_STATE.data.meta) APP_STATE.data.meta = {};
    APP_STATE.data.meta.gasUrl = APP_STATE.sync.gasUrl;
    if (APP_STATE.years && APP_STATE.currentYear && APP_STATE.years[APP_STATE.currentYear]) {
      APP_STATE.years[APP_STATE.currentYear].meta.gasUrl = APP_STATE.sync.gasUrl;
    }
    saveLocalData();
  }
  if (toggle) {
    APP_STATE.sync.pollingEnabled = toggle.checked;
    localStorage.setItem('TQ_POLLING_ENABLED', String(toggle.checked));
  }

  if (APP_STATE.sync.pollingEnabled && APP_STATE.sync.gasUrl) {
    startSyncPolling();
    pushDataToCloud();
  } else {
    stopSyncPolling();
  }

  updateSyncStatusUI();
  closeSyncConfigModal();
  showToast('⚙️ 雲端同步設定已更新！已與 Google 試算表連線！');
}

function startSyncPolling() {
  stopSyncPolling();
  if (!APP_STATE.sync.gasUrl) return;

  APP_STATE.sync.countdown = 5;
  APP_STATE.sync.intervalId = setInterval(() => {
    APP_STATE.sync.countdown--;
    if (APP_STATE.sync.countdown <= 0) {
      APP_STATE.sync.countdown = 5;
      pullDataFromCloud();
    }
    updateSyncCountdownUI();
  }, 1000);
}

function stopSyncPolling() {
  if (APP_STATE.sync.intervalId) {
    clearInterval(APP_STATE.sync.intervalId);
    APP_STATE.sync.intervalId = null;
  }
}

function updateSyncCountdownUI() {
  const pill = document.getElementById('header-sync-pill');
  if (!pill) return;
  if (APP_STATE.sync.pollingEnabled && APP_STATE.sync.gasUrl) {
    pill.innerHTML = `<span class="status-dot syncing"></span><span>同步中 (${APP_STATE.sync.countdown}s)</span>`;
  }
}

function updateSyncStatusUI() {
  const pill = document.getElementById('header-sync-pill');
  if (!pill) return;
  if (APP_STATE.sync.gasUrl && APP_STATE.sync.pollingEnabled) {
    pill.innerHTML = `<span class="status-dot syncing"></span><span>同步中 (${APP_STATE.sync.countdown}s)</span>`;
  } else {
    pill.innerHTML = `<span class="status-dot"></span><span>單機/離線模式</span>`;
  }
}

// 嚴格防快取取得雲端最新成績（全面阻絕手機 Safari / Chrome 假日快取阻擋）
async function pullDataFromCloud(isManualForce = false) {
  if (!APP_STATE.sync.gasUrl || (APP_STATE.sync.isSyncing && !isManualForce)) return;

  APP_STATE.sync.isSyncing = true;
  try {
    // 🛡️ 1. 在 API 網址後方強制加入微秒時間戳記與隨機字串，徹底瓦解手機端與中繼快取 (Cache Busting)
    const sep = APP_STATE.sync.gasUrl.includes('?') ? '&' : '?';
    const cacheBusterUrl = `${APP_STATE.sync.gasUrl}${sep}_t=${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    // 🛡️ 2. Google Apps Script 屬於跨網域 Web App，不支援 HTTP OPTIONS 預檢請求。
    // 透過在網址後方帶入微秒時間戳記與亂數，即可 100% 瓦解所有快取，同時保持 CORS 簡易請求直連成功！
    const res = await fetch(cacheBusterUrl);

    if (!res.ok) {
      throw new Error(`網路回應異常: HTTP ${res.status}`);
    }

    const json = await res.json();
    APP_STATE.sync.isSyncing = false;

    if (json && json.status === 'success') {
      if (json.data) {
        const localScores = countTotalScoresInDataset(APP_STATE.data);
        const cloudScores = countTotalScoresInDataset(json.data);
        if (localScores > 0 && cloudScores === 0) {
          console.log(`[SafeSync] 本機有 ${localScores} 筆成績，而雲端尚無成績，自動將本機成績推送到雲端保護資料！`);
          pushDataToCloud();
          return;
        }

        if (json.lastUpdated !== APP_STATE.sync.lastSyncedTime || isManualForce) {
          APP_STATE.sync.lastSyncedTime = json.lastUpdated;
          // 🛡️ 若管理員正在後台輸入成績，先暫存 DOM 輸入框數據避免被覆蓋
          if (APP_STATE.currentTab === 'admin') {
            syncAdminDomInputsToState();
          }

          // 🛡️ 雙向安全成績合併：以本地已登記成績為基準，與雲端最新成績合併，絕不讓任何有效成績被空白覆蓋！
          APP_STATE.data = mergeEventDatasets(APP_STATE.data, json.data);
          if (!APP_STATE.years) APP_STATE.years = {};
          APP_STATE.years[APP_STATE.currentYear || '115'] = APP_STATE.data;
          localStorage.setItem('TQ_MEET_DATA_115', JSON.stringify(APP_STATE.data));

          // 若本機持有雲端尚未收錄之有效成績，自動將合併後的完整資料推送至雲端保護
          const mergedScores = countTotalScoresInDataset(APP_STATE.data);
          if (mergedScores > cloudScores) {
            pushDataToCloud();
          }
          
          // 🛡️ 初次進入網站且尚未點選特定項目時，自動切換至最新有成績之賽事，避免首頁留白讓人誤以為成績消失
          if (!sessionStorage.getItem('TQ_USER_VIEW')) {
            const latest = findLatestEventWithScores();
            if (latest) {
              APP_STATE.leaderboardFilter.event = latest.event;
              APP_STATE.leaderboardFilter.grade = latest.grade || '七年級';
              APP_STATE.leaderboardFilter.gender = (latest.event === 'grandRelay') ? 'all' : (latest.gender || '男生組');
              updateLeaderboardFilterPillsUI();
            }
          }
          
          // 🛡️ 絕不干擾使用者正在瀏覽的賽事項目與篩選條件！保持既有視角
          if (APP_STATE.currentTab === 'leaderboard') {
            renderLeaderboard();
            if (APP_STATE.leaderboardFilter.subTab === 'points') {
              renderClassPointsView();
            }
          } else if (APP_STATE.currentTab === 'search') {
            renderClassRoster();
          } else if (APP_STATE.currentTab === 'admin') {
            renderAdminEditTable();
          }
          console.log('Synchronized new data from Google Sheets safely with strict cache-busting.');
          if (isManualForce) {
            showToast('⚡ 已透過防快取通道強制同步雲端最新成績！');
          }
        }
      } else if (APP_STATE.data) {
        pushDataToCloud();
      }
    }
  } catch (err) {
    APP_STATE.sync.isSyncing = false;
    console.warn('Sync poll failed:', err);
    if (isManualForce) {
      showToast('⚠️ 雲端同步失敗，請檢查網路連線', 'error');
    }
  }
}

// 別名相容：支援使用者提示詞要求的 fetchLatestScores 命名
function fetchLatestScores(isManualForce) {
  return pullDataFromCloud(isManualForce);
}
if (typeof window !== 'undefined') {
  window.fetchLatestScores = fetchLatestScores;
}

function pushDataToCloud() {
  if (!APP_STATE.sync.gasUrl) return;

  const sep = APP_STATE.sync.gasUrl.includes('?') ? '&' : '?';
  const cacheBusterUrl = `${APP_STATE.sync.gasUrl}${sep}_t=${Date.now()}`;

  fetch(cacheBusterUrl, {
    method: 'POST',
    mode: 'no-cors',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8'
    },
    body: JSON.stringify(APP_STATE.data)
  }).then(() => {
    APP_STATE.sync.lastSyncedTime = new Date().toISOString();
    console.log('Pushed data to cloud Google Sheets successfully.');
  }).catch(err => {
    console.error('Push data failed:', err);
  });
}

// 從瀏覽器歷史記憶（localStorage 與 TQ_SCORE_VAULT）救回/還原已登記之成績並同步推送到雲端
function recoverLocalScores() {
  let recoveredCount = 0;
  const storeRaw = localStorage.getItem('TQ_MEET_YEARS_STORE');
  const singleRaw = localStorage.getItem('TQ_MEET_DATA_115');
  const vaultRaw = localStorage.getItem('TQ_SCORE_VAULT');

  // 1. 從安全保險箱 (TQ_SCORE_VAULT) 優先比對恢復
  if (vaultRaw && APP_STATE.data && APP_STATE.data.events) {
    try {
      const vault = JSON.parse(vaultRaw);
      Object.keys(APP_STATE.data.events).forEach(evKey => {
        const currentList = APP_STATE.data.events[evKey];
        if (Array.isArray(currentList)) {
          currentList.forEach(target => {
            if (!hasValidAthleteScore(target) && vault[target.id]) {
              const b = vault[target.id];
              if (b.score !== undefined && b.score !== null && b.score !== '') target.score = b.score;
              if (b.rawScore !== undefined && b.rawScore !== null && b.rawScore !== '') target.rawScore = b.rawScore;
              if (b.foulCount !== undefined) target.foulCount = b.foulCount;
              if (b.att1 !== undefined && b.att1 !== null && b.att1 !== '') target.att1 = b.att1;
              if (b.att2 !== undefined && b.att2 !== null && b.att2 !== '') target.att2 = b.att2;
              if (b.att3 !== undefined && b.att3 !== null && b.att3 !== '') target.att3 = b.att3;
              if (b.best !== undefined && b.best !== null && b.best !== '') target.best = b.best;
              if (b.formattedBest) target.formattedBest = b.formattedBest;
              if (b.formattedFinal) target.formattedFinal = b.formattedFinal;
              recoveredCount++;
            }
          });
        }
      });
    } catch (e) {}
  }

  const candidates = [];
  if (storeRaw) {
    try {
      const parsed = JSON.parse(storeRaw);
      if (parsed && parsed.years && parsed.years['115']) candidates.push(parsed.years['115']);
      if (parsed && parsed.data) candidates.push(parsed.data);
    } catch (e) {}
  }
  if (singleRaw) {
    try {
      const parsed = JSON.parse(singleRaw);
      if (parsed && parsed.events) candidates.push(parsed);
    } catch (e) {}
  }

  candidates.forEach(cand => {
    if (!cand || !cand.events) return;
    Object.keys(cand.events).forEach(evKey => {
      const candList = cand.events[evKey];
      const currentList = APP_STATE.data && APP_STATE.data.events && APP_STATE.data.events[evKey];
      if (Array.isArray(candList) && Array.isArray(currentList)) {
        candList.forEach(candItem => {
          if (hasValidAthleteScore(candItem)) {
            const target = currentList.find(x => x.id === candItem.id || (x.classId === candItem.classId && x.name === candItem.name));
            if (target && !hasValidAthleteScore(target)) {
              if (candItem.att1) target.att1 = candItem.att1;
              if (candItem.att2) target.att2 = candItem.att2;
              if (candItem.att3) target.att3 = candItem.att3;
              if (candItem.best) target.best = candItem.best;
              if (candItem.score) target.score = candItem.score;
              if (candItem.rawScore) target.rawScore = candItem.rawScore;
              if (candItem.foulCount !== undefined) target.foulCount = candItem.foulCount;
              recoveredCount++;
            }
          }
        });
      }
    });
  });

  if (recoveredCount > 0) {
    saveLocalData();
    renderAdminEditTable();
    renderLeaderboard();
    pushDataToCloud();
    alert(`🎉 成功從本機暫存中尋回並恢復 ${recoveredCount} 筆比賽成績！\n已自動保存並推送到 Google 雲端！`);
  } else {
    alert('🔍 本機暫存目前無其他已登錄之歷史成績。\n\n提示：\n1. 請確認上方【組別】是否選為「男生組」或「女生組」（鉛球分為男生與女生組，若選「混組」會顯示空白）。\n2. 若是在另一台電腦輸入的，請在該台電腦上執行此功能。\n3. 可打開 Google 試算表，從「檔案」->「版本歷史紀錄」尋回先前紀錄。');
  }
}
window.recoverLocalScores = recoverLocalScores;

function showGasTutorialModal() {
  const modal = document.getElementById('gas-tutorial-modal');
  if (modal) modal.classList.add('active');
}

function closeGasTutorialModal() {
  const modal = document.getElementById('gas-tutorial-modal');
  if (modal) modal.classList.remove('active');
}

// 浮動提示 Toast 工具
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span>${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.4s';
    setTimeout(() => toast.remove(), 400);
  }, 2800);
}

window.triggerGenerateSprintFinals = triggerGenerateSprintFinals;
window.sortAdminFinalsBySeedRank = sortAdminFinalsBySeedRank;
window.sortAdminRosterByClassAndBib = sortAdminRosterByClassAndBib;
window.sortAdminRosterByHeatAndLane = sortAdminRosterByHeatAndLane;
window.computeSprintFinalsRanks = computeSprintFinalsRanks;

// 頁面載入完成後啟動
window.addEventListener('DOMContentLoaded', () => {
  initApp();
});
