/**
 * 頭前國中 115學年度校慶運動大會田徑賽事 - 智慧賽務與即時榜單核心系統 (app.js)
 * 遵循教育部與頭前國中校慶運動會規程、並列排序演算法、多人雲端同步與分權設計
 * 
 * 最新更新：
 * 1. 大隊接力、800M、1500M、400M、4x200M 接力輸入全面支援中文「分、秒」格式（如：4分15秒34）
 * 2. 移除校名簡稱標籤，維持大會官方正式全名
 * 3. 全站套用明亮清爽活力風格（Bright Fresh Blue & Emerald）
 */

// 應用程式全域狀態
const APP_STATE = {
  data: null,
  currentYear: '115',
  years: {},
  currentTab: 'leaderboard',
  isAdminUnlocked: false,
  currentUser: null,
  pendingTabAfterLogin: null,
  adminAccounts: [
    { username: 'tqjh888', password: 'tqjh888', name: '體育組管理員' },
    { username: 'jenny', password: '123456789', name: 'Jenny 管理員' }
  ],
  projectorMode: false,
  
  // 榜單篩選
  leaderboardFilter: {
    event: 'grandRelay', // grandRelay, relay4x200, 100m, 200m, 400m, 800m, 1500m, shotPut, longJump
    grade: 'all',        // all, 七年級, 八年級, 九年級
    gender: 'all',       // all, 男生組, 女生組, 混組
    sprintView: 'ranking' // ranking (總排晉級), heats (分組分道)
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

  // 多人雲端即時同步設定
  sync: {
    gasUrl: localStorage.getItem('TQ_GAS_URL') || '',
    pollingEnabled: localStorage.getItem('TQ_POLLING_ENABLED') === 'true',
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

  // 自動校正示範數據（確保體育班 916/816/716 最快，與普通班第 1 名形成兩個並列第一）
  if (APP_STATE.data && APP_STATE.data.events) {
    if (APP_STATE.data.events.grandRelay) {
      const r916 = APP_STATE.data.events.grandRelay.find(x => x.classId === '916');
      if (r916 && (!r916.rawScore || r916.rawScore === '2分47秒80')) {
        r916.rawScore = '2分42秒50';
      }
    }
    
    // 自動同步最新大隊接力 (grandRelay)、鉛球 (shotPut) 與跳遠 (longJump) 種子示範數據
    if (window.INITIAL_MEET_DATA && window.INITIAL_MEET_DATA.events) {
      const hasGrandRelayScores = APP_STATE.data.events.grandRelay && APP_STATE.data.events.grandRelay.some(x => x.classId === '907' && x.rawScore);
      if (!hasGrandRelayScores && window.INITIAL_MEET_DATA.events.grandRelay) {
        APP_STATE.data.events.grandRelay = JSON.parse(JSON.stringify(window.INITIAL_MEET_DATA.events.grandRelay));
      }

      const hasJumpScores = APP_STATE.data.events.longJump && APP_STATE.data.events.longJump.some(x => x.att1 || x.att2 || x.att3 || x.best);
      if (!hasJumpScores && window.INITIAL_MEET_DATA.events.longJump) {
        APP_STATE.data.events.longJump = JSON.parse(JSON.stringify(window.INITIAL_MEET_DATA.events.longJump));
      }

      const hasSpFullScores = APP_STATE.data.events.shotPut && APP_STATE.data.events.shotPut.some(x => x.grade === '八年級' && (x.att1 || x.att2 || x.best));
      if (!hasSpFullScores && window.INITIAL_MEET_DATA.events.shotPut) {
        APP_STATE.data.events.shotPut = JSON.parse(JSON.stringify(window.INITIAL_MEET_DATA.events.shotPut));
      }
    }

    // 鉛球七年級男生組數據精準校正
    if (APP_STATE.data.events.shotPut) {
      const sp14 = APP_STATE.data.events.shotPut.find(x => x.id === 'SHOT_14' || (x.classId === '716' && x.name === '李昱昕'));
      const sp4 = APP_STATE.data.events.shotPut.find(x => x.id === 'SHOT_4' || (x.classId === '702' && x.name === '吳正龍'));
      const sp5 = APP_STATE.data.events.shotPut.find(x => x.id === 'SHOT_5' || (x.classId === '705' && x.name === '陳虹閔'));
      const sp13 = APP_STATE.data.events.shotPut.find(x => x.id === 'SHOT_13' || (x.classId === '701' && x.name === '蔡裔勝'));

      if (sp14) { sp14.att1 = '10.85'; sp14.att2 = '11.02'; sp14.att3 = '10.95'; sp14.best = '11.02'; }
      if (sp4) { sp4.att1 = '10.55'; sp4.att2 = '10.97'; sp4.att3 = '10.80'; sp4.best = '10.97'; }
      if (sp5) { sp5.att1 = '10.30'; sp5.att2 = '10.67'; sp5.att3 = '10.50'; sp5.best = '10.67'; }
      if (sp13) { sp13.att1 = '9.90'; sp13.att2 = '10.20'; sp13.att3 = '10.05'; sp13.best = '10.20'; }
    }

    // 跳遠七年級男生組數據精準校正
    if (APP_STATE.data.events.longJump) {
      const j15 = APP_STATE.data.events.longJump.find(x => x.id === 'JUMP_15' || (x.classId === '716' && x.name === '陳奕巽'));
      const j4 = APP_STATE.data.events.longJump.find(x => x.id === 'JUMP_4' || (x.classId === '706' && x.name === '吳威澄'));
      const j5 = APP_STATE.data.events.longJump.find(x => x.id === 'JUMP_5' || (x.classId === '714' && x.name === '劉書宇'));
      const j8 = APP_STATE.data.events.longJump.find(x => x.id === 'JUMP_8' || (x.classId === '701' && x.name === '黎賀瑋'));

      if (j15) { j15.att1 = '5.40'; j15.att2 = '5.65'; j15.att3 = '5.50'; j15.best = '5.65'; }
      if (j4) { j4.att1 = '5.30'; j4.att2 = '5.50'; j4.att3 = '5.42'; j4.best = '5.50'; }
      if (j5) { j5.att1 = '5.10'; j5.att2 = '5.25'; j5.att3 = '5.15'; j5.best = '5.25'; }
      if (j8) { j8.att1 = '4.88'; j8.att2 = '5.05'; j8.att3 = '4.95'; j8.best = '5.05'; }
    }

    saveLocalData();
  }

  // 初始化各頁面元件
  renderLeaderboard();
  initClassSearchOptions();
  renderClassRoster();
  renderMasterSchedule();
  initTeacherDashboard();
  renderTeacherDuties();
  initAdminView();

  // 雲端同步檢查
  if (APP_STATE.sync.pollingEnabled && APP_STATE.sync.gasUrl) {
    startSyncPolling();
  }
  updateSyncStatusUI();

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
 * 通用排名計算函式（體育班特殊並列保障規則）
 * isHigherBetter: 田賽(鉛球/跳遠)=true(數值大勝)；徑賽(跑步/接力)=false(秒數少勝)
 */
function calculateUnifiedRankings(athletes, isHigherBetter = true) {
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
  const normalAthletes = valid.filter(a => !getClassStr(a).endsWith('16'));
  const peAthletes = valid.filter(a => getClassStr(a).endsWith('16'));

  // 2. 普通班先獨立排序
  if (isHigherBetter) {
    normalAthletes.sort((a, b) => b.score - a.score);
  } else {
    normalAthletes.sort((a, b) => a.score - b.score);
  }

  // 設定普通班基礎名次
  normalAthletes.forEach((item, idx) => {
    item.rank = idx + 1;
    item.rankNumber = idx + 1;
    item.rankText = `第 ${idx + 1} 名`;
    item.isSportsClass = false;
    item.isTiedWithSports = false;
  });

  // 3. 體育班比對並列
  peAthletes.forEach(pe => {
    pe.isSportsClass = true;
    if (normalAthletes.length === 0) {
      pe.rank = 1;
      pe.rankNumber = 1;
      pe.rankText = '第 1 名';
      pe.isTiedWithSports = false;
      return;
    }

    const peScore = pe.score;
    const top1 = normalAthletes[0];

    const isPeBetterThanTop1 = isHigherBetter 
      ? (peScore >= top1.score) 
      : (peScore <= top1.score);

    if (isPeBetterThanTop1) {
      // 體育班勝過或等於普通班第1名 -> 並列第 1 名
      pe.rank = 1;
      pe.rankNumber = 1;
      pe.rankText = '並列第 1 名';
      pe.isTiedWithSports = true;
      top1.rank = 1;
      top1.rankNumber = 1;
      top1.rankText = '並列第 1 名';
      top1.isTiedWithSports = true;
    } else {
      let matched = false;
      for (let i = 1; i < normalAthletes.length; i++) {
        const prev = normalAthletes[i - 1];
        const curr = normalAthletes[i];

        const isBetween = isHigherBetter
          ? (peScore <= prev.score && peScore >= curr.score)
          : (peScore >= prev.score && peScore <= curr.score);

        if (isBetween) {
          pe.rank = i + 1;
          pe.rankNumber = i + 1;
          pe.rankText = `並列第 ${i + 1} 名`;
          pe.isTiedWithSports = true;
          curr.rank = i + 1;
          curr.rankNumber = i + 1;
          curr.rankText = `並列第 ${i + 1} 名`;
          curr.isTiedWithSports = true;
          matched = true;
          break;
        }
      }

      if (!matched) {
        const lastRank = normalAthletes.length + 1;
        pe.rank = lastRank;
        pe.rankNumber = lastRank;
        pe.rankText = `第 ${lastRank} 名`;
        pe.isTiedWithSports = false;
      }
    }
  });

  // 4. 合併輸出，按名次排序
  return [...normalAthletes, ...peAthletes].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    // 同名次時（並列），體育班可排在同名次區塊的第一位或依成績排序
    return isHigherBetter ? (b.score - a.score) : (a.score - b.score);
  });
}

// 相容別名
const applySportsClassTieRanking = calculateUnifiedRankings;

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

// ==========================================
// 4. 前台：即時榜單與頒獎看板 (Live Leaderboard View)
// ==========================================
function renderLeaderboard() {
  const container = document.getElementById('leaderboard-content');
  if (!container) return;

  const { event, grade, gender, sprintView } = APP_STATE.leaderboardFilter;

  let displayData = [];
  let isSprint = (event === '100m' || event === '200m');
  let isField = (event === 'shotPut' || event === 'longJump');
  let isGrandRelay = (event === 'grandRelay');
  let is4x200 = (event === 'relay4x200');

  let rawList = [];
  if (isGrandRelay) rawList = APP_STATE.data.events.grandRelay;
  else if (is4x200) rawList = APP_STATE.data.events.relay4x200;
  else if (event === '100m') rawList = APP_STATE.data.events.e100m;
  else if (event === '200m') rawList = APP_STATE.data.events.e200m;
  else if (event === '400m') rawList = APP_STATE.data.events.e400m;
  else if (event === '800m') rawList = APP_STATE.data.events.e800m;
  else if (event === '1500m') rawList = APP_STATE.data.events.e1500m;
  else if (event === 'shotPut') rawList = APP_STATE.data.events.shotPut;
  else if (event === 'longJump') rawList = APP_STATE.data.events.longJump;

  // 篩選年級與性別
  let filtered = rawList;
  if (grade !== 'all') {
    filtered = filtered.filter(x => x.grade === grade);
  }
  if (gender !== 'all') {
    filtered = filtered.filter(x => x.gender === gender);
  }

  // 依不同項目執行計算排名
  if (isGrandRelay) {
    displayData = computeGrandRelayRanks(filtered);
  } else if (isField) {
    displayData = computeFieldEventRanks(filtered);
  } else if (isSprint) {
    displayData = computeSprintRanks(filtered);
  } else if (is4x200) {
    displayData = compute4x200RelayRanks(filtered);
  } else {
    displayData = computeMiddleDistanceRanks(filtered);
  }

  let html = '';

  // 1. 頒獎台看板 (Podium)
  const podiumTop3 = displayData.filter(x => x.rankNumber <= 3);
  if (podiumTop3.length > 0) {
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

  // 3. 視角切換器 (短跑預賽專用)
  if (isSprint) {
    html += `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; flex-wrap:wrap; gap:0.5rem;">
        <span style="font-weight:800; color:var(--text-muted);">榜單顯示視角切換：</span>
        <div style="display:flex; gap:0.5rem;">
          <button class="btn btn-sm ${sprintView === 'ranking' ? 'btn-primary' : 'btn-secondary'}" onclick="setSprintView('ranking')">
            🏁 跨組總排行檢視 (亮綠晉級名冊)
          </button>
          <button class="btn btn-sm ${sprintView === 'heats' ? 'btn-primary' : 'btn-secondary'}" onclick="setSprintView('heats')">
            📋 依組別道次檢視 (裁判分組登記)
          </button>
        </div>
      </div>
    `;
  }

  // 4. 榜單表格
  if (isSprint && sprintView === 'heats') {
    html += renderSprintHeatsTable(filtered);
  } else {
    html += renderStandardLeaderboardTable(displayData, { isGrandRelay, isField, isSprint, is4x200 });
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
  const { isGrandRelay, isField, isSprint, is4x200 } = flags;

  let html = `
    <div class="table-responsive">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:70px; text-align:center;">名次</th>
            <th>年級組別</th>
            <th>班級</th>
            ${!isGrandRelay && !is4x200 ? '<th>座號/姓名</th>' : ''}
            ${!isField ? '<th>組別/道次</th>' : '<th>出場順序</th>'}
            ${isGrandRelay ? '<th>原始成績 (如: 4分15秒34)</th><th>犯規加罰 (+5秒/次)</th><th>最終成績</th>' : ''}
            ${isField ? '<th style="text-align:center;">第1次試跳/擲</th><th style="text-align:center;">第2次試跳/擲</th><th style="text-align:center;">第3次試跳/擲</th><th style="text-align:center;">有效最佳成績</th>' : ''}
            ${!isGrandRelay && !isField ? '<th>比賽成績</th>' : ''}
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

      html += `
        <tr>
          <td style="text-align:center; font-weight:800;">${rankBadge}</td>
          <td>${item.grade} ${item.gender}</td>
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
            ${item.tieNote ? `<div style="font-size:0.8rem; color:${item.tieNote.startsWith('💡') ? '#0284c7' : '#64748b'}; font-weight:700; margin-top:0.25rem;">${item.tieNote}</div>` : ''}
            ${!statusBadge && !item.tieNote ? (item.remarks || '--') : ''}
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
          <td>${item.grade} ${item.gender}</td>
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
  APP_STATE.leaderboardFilter.event = evt;
  document.querySelectorAll('#event-pills .filter-pill').forEach(el => {
    el.classList.toggle('active', el.dataset.event === evt);
  });

  // 鉛球或跳遠切換時，若年級或組別為全校/全部，自動切換至七年級男生組，直接呈現該項目的頒獎台看板
  if ((evt === 'shotPut' || evt === 'longJump') && APP_STATE.leaderboardFilter.grade === 'all') {
    APP_STATE.leaderboardFilter.grade = '七年級';
    document.querySelectorAll('#grade-pills .filter-pill').forEach(el => {
      el.classList.toggle('active', el.dataset.grade === '七年級');
    });
  }
  if ((evt === 'shotPut' || evt === 'longJump') && APP_STATE.leaderboardFilter.gender === 'all') {
    APP_STATE.leaderboardFilter.gender = '男生組';
    document.querySelectorAll('#gender-pills .filter-pill').forEach(el => {
      el.classList.toggle('active', el.dataset.gender === '男生組');
    });
  }

  renderLeaderboard();
}

function setLeaderboardGrade(gr) {
  APP_STATE.leaderboardFilter.grade = gr;
  document.querySelectorAll('#grade-pills .filter-pill').forEach(el => {
    el.classList.toggle('active', el.dataset.grade === gr);
  });
  renderLeaderboard();
}

function setLeaderboardGender(gd) {
  APP_STATE.leaderboardFilter.gender = gd;
  document.querySelectorAll('#gender-pills .filter-pill').forEach(el => {
    el.classList.toggle('active', el.dataset.gender === gd);
  });
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

function renderClassRoster() {
  const container = document.getElementById('class-roster-container');
  if (!container) return;

  const targetClass = APP_STATE.classSearch.classId;
  const targetDate = APP_STATE.classSearch.date;
  const gr = targetClass.charAt(0);

  const athletes = [];

  const eventSources = [
    { key: 'e100m', name: '100公尺', round: '預賽', venue: '操場直線跑道', date: '11/10(二)', period: '第六節(女)/第七節(男)' },
    { key: 'e200m', name: '200公尺', round: '預賽', venue: '操場跑道', date: '11/11(三)', period: '第六節(女)/第七節(男)' },
    { key: 'e400m', name: '400公尺', round: '決賽', venue: '操場跑道', date: '11/12(四)', period: '第六節(女)/第七節(男)' },
    { key: 'e800m', name: '800公尺', round: '決賽', venue: '操場跑道', date: '11/6(五)', period: '第六節(女)/第七節(男)' },
    { key: 'e1500m', name: '1500公尺', round: '決賽', venue: '操場跑道', date: '11/13(五)', period: '第六/七節(男)' },
    { key: 'shotPut', name: '鉛球', round: '決賽', venue: '司令台旁鉛球場', date: getFieldDate(targetClass), period: getFieldPeriod(targetClass) },
    { key: 'longJump', name: '跳遠', round: '決賽', venue: '司令台後跳遠沙坑', date: getFieldDate(targetClass), period: getFieldPeriod(targetClass) }
  ];

  eventSources.forEach(src => {
    const list = APP_STATE.data.events[src.key] || [];
    list.filter(x => x.classId === targetClass).forEach(item => {
      let scoreDisplay = item.score || item.formattedBest || '--';
      const parsedSec = parseChineseTimeToSeconds(item.score);
      if (parsedSec) scoreDisplay = formatSecondsToChinese(parsedSec);

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
      gender: '男女混合',
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
      <button class="btn btn-secondary" onclick="printClassNotice('${targetClass}')">
        🖨️ 列印班級選手出賽與檢錄通知單
      </button>
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
            <div style="font-size:0.88rem; color:var(--text-muted);">
              <strong>比賽地點：</strong>${a.venue}
            </div>
          </div>
          <div class="roster-meta-row">
            <div class="roster-meta-item">📅 ${a.date}</div>
            <div class="roster-meta-item">⏰ ${a.period}</div>
            <div class="roster-meta-item" style="color:var(--danger); font-weight:800;">提前20分鐘檢錄</div>
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

function printClassNotice(classId) {
  window.print();
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
        <td style="text-align:center; color:#ef4444; font-weight:800; font-size:0.85rem;">⏰ 賽前20分鐘檢錄</td>
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
  let items = [];

  const isGrandRelay = (event === 'grandRelay');
  const is4x200 = (event === 'relay4x200');
  const isField = (event === 'shotPut' || event === 'longJump');
  const isDistanceTrack = (event === '800m' || event === '1500m' || event === '400m' || event === 'relay4x200');
  const isSprintTrack = (event === '100m' || event === '200m');

  if (isGrandRelay) items = APP_STATE.data.events.grandRelay;
  else if (is4x200) items = APP_STATE.data.events.relay4x200;
  else if (event === '100m') items = APP_STATE.data.events.e100m;
  else if (event === '200m') items = APP_STATE.data.events.e200m;
  else if (event === '400m') items = APP_STATE.data.events.e400m;
  else if (event === '800m') items = APP_STATE.data.events.e800m;
  else if (event === '1500m') items = APP_STATE.data.events.e1500m;
  else if (event === 'shotPut') items = APP_STATE.data.events.shotPut;
  else if (event === 'longJump') items = APP_STATE.data.events.longJump;

  let filtered = items;
  if (grade !== 'all') filtered = filtered.filter(x => x.grade === grade);
  if (gender !== 'all') filtered = filtered.filter(x => x.gender === gender);

  let examplePrompt = '如：4分15秒34';
  if (event === '800m') examplePrompt = '如：2分35秒40';
  else if (event === '1500m') examplePrompt = '如：4分58秒12';
  else if (isSprintTrack) examplePrompt = '如：12秒35';

  let html = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem; flex-wrap:wrap; gap:0.5rem;">
      <div style="font-weight:800; color:#0369a1;">
        📝 正在編輯：${grade} ${gender} - ${getEventDisplayName(event)}（共 ${filtered.length} 筆，輸入時間支援【${examplePrompt}】）
      </div>
      <div style="display:flex; gap:0.5rem;">
        <button class="btn btn-primary" onclick="saveAdminEdits()">💾 保存輸入成績</button>
      </div>
    </div>
    <div class="table-responsive">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:60px;">編號</th>
            <th>班級</th>
            ${!isGrandRelay && !is4x200 ? '<th>座號/姓名</th>' : ''}
            ${!isField ? '<th>組別/道次</th>' : '<th>分組/順序</th>'}
            ${isGrandRelay ? `
              <th>原始成績 (分 / 秒)</th>
              <th>犯規次數 (+5秒/次)</th>
              <th>最終成績 (加罰後)</th>
            ` : ''}
            ${isDistanceTrack ? `
              <th>比賽成績 (如：${examplePrompt})</th>
            ` : ''}
            ${isSprintTrack ? `
              <th>比賽成績 (秒.毫秒，如：12秒35)</th>
            ` : ''}
            ${isField ? `
              <th>第1次試跳/擲</th>
              <th>第2次試跳/擲</th>
              <th>第3次試跳/擲</th>
              <th>有效最佳</th>
            ` : ''}
            <th>備註</th>
          </tr>
        </thead>
        <tbody>
  `;

  if (filtered.length === 0) {
    html += `<tr><td colspan="8" style="text-align:center; padding:2rem;">該分類目前無參賽項目名冊</td></tr>`;
  } else {
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
          <td>${idx + 1}</td>
          <td><strong>${item.classId} 班</strong> ${item.isSportsClass ? '<span class="badge badge-sports">體育班</span>' : ''}</td>
          ${!isGrandRelay && !is4x200 ? `
            <td>
              <div style="display:flex; gap:0.35rem; align-items:center;">
                <input type="text" class="form-control input-row-bib" value="${item.bib || ''}" placeholder="號碼" style="width:65px; padding:0.25rem 0.35rem; font-size:0.84rem; text-align:center;" title="號碼布/座號">
                <input type="text" class="form-control input-row-name" value="${item.name || ''}" placeholder="選手姓名" style="width:90px; padding:0.25rem 0.45rem; font-size:0.9rem; font-weight:700;" title="選手姓名 (可直接修改或建檔)">
              </div>
            </td>
          ` : ''}
          ${!isField ? `<td>${item.heat || ''} ${item.lane ? item.lane + '道' : ''}</td>` : `<td>${item.flight || ''} 第 ${item.order} 位</td>`}
          
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
            <td><input type="text" class="form-control field-att1" style="width:85px; text-align:center; font-family:monospace;" value="${item.att1 || ''}" placeholder="公尺" onchange="recalcFieldRow(this)"></td>
            <td><input type="text" class="form-control field-att2" style="width:85px; text-align:center; font-family:monospace;" value="${item.att2 || ''}" placeholder="公尺" onchange="recalcFieldRow(this)"></td>
            <td><input type="text" class="form-control field-att3" style="width:85px; text-align:center; font-family:monospace;" value="${item.att3 || ''}" placeholder="公尺" onchange="recalcFieldRow(this)"></td>
            <td><strong class="field-best-calc" style="font-family:monospace; color:#0284c7; font-size:1.1rem;">--</strong></td>
          ` : ''}

          <td><input type="text" class="form-control input-row-remarks" style="padding:0.35rem 0.6rem; font-size:0.86rem;" value="${item.remarks || ''}"></td>
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

function saveAdminEdits() {
  const rows = document.querySelectorAll('#admin-edit-table-container tbody tr');
  const { event } = APP_STATE.adminEdit;

  const isGrandRelay = (event === 'grandRelay');
  const isField = (event === 'shotPut' || event === 'longJump');
  const isDistanceTrack = (event === '800m' || event === '1500m' || event === '400m' || event === 'relay4x200');
  const isSprintTrack = (event === '100m' || event === '200m');

  rows.forEach(tr => {
    const id = tr.dataset.id;
    if (!id) return;

    let target = null;
    let list = [];
    if (isGrandRelay) list = APP_STATE.data.events.grandRelay;
    else if (event === 'relay4x200') list = APP_STATE.data.events.relay4x200;
    else if (event === '100m') list = APP_STATE.data.events.e100m;
    else if (event === '200m') list = APP_STATE.data.events.e200m;
    else if (event === '400m') list = APP_STATE.data.events.e400m;
    else if (event === '800m') list = APP_STATE.data.events.e800m;
    else if (event === '1500m') list = APP_STATE.data.events.e1500m;
    else if (event === 'shotPut') list = APP_STATE.data.events.shotPut;
    else if (event === 'longJump') list = APP_STATE.data.events.longJump;

    target = list.find(x => x.id === id);
    if (!target) return;

    if (isGrandRelay) {
      const minVal = parseFloat(tr.querySelector('.input-relay-min').value) || 0;
      const secVal = parseFloat(tr.querySelector('.input-relay-sec').value);
      if (!isNaN(secVal) && secVal >= 0) {
        const rawSec = minVal * 60 + secVal;
        target.rawScore = formatSecondsToChinese(rawSec); // 存成 4分15秒34 格式
      } else {
        target.rawScore = '';
      }
      target.foulCount = parseInt(tr.querySelector('.foul-val').textContent) || 0;
    } else if (isDistanceTrack) {
      const minVal = parseFloat(tr.querySelector('.input-dist-min').value) || 0;
      const secVal = parseFloat(tr.querySelector('.input-dist-sec').value);
      if (!isNaN(secVal) && secVal >= 0) {
        const rawSec = minVal * 60 + secVal;
        target.score = formatSecondsToChinese(rawSec); // 存成 2分35秒40 格式
      } else {
        target.score = '';
      }
    } else if (isSprintTrack) {
      const secVal = parseFloat(tr.querySelector('.input-sprint-sec').value);
      if (!isNaN(secVal) && secVal > 0) {
        target.score = formatSecondsToChinese(secVal); // 存成 12秒35 格式
      } else {
        target.score = '';
      }
    } else if (isField) {
      target.att1 = tr.querySelector('.field-att1').value.trim();
      target.att2 = tr.querySelector('.field-att2').value.trim();
      target.att3 = tr.querySelector('.field-att3').value.trim();
    }

    const nameInput = tr.querySelector('.input-row-name');
    if (nameInput) target.name = nameInput.value.trim();
    const bibInput = tr.querySelector('.input-row-bib');
    if (bibInput) target.bib = bibInput.value.trim();

    const remarkInput = tr.querySelector('.input-row-remarks');
    if (remarkInput) target.remarks = remarkInput.value.trim();
  });

  saveLocalData();
  renderLeaderboard();
  renderClassRoster();
  showToast('✅ 賽事成績已成功登錄更新！');
}

function getEventDisplayName(key) {
  const map = {
    grandRelay: '大隊接力',
    relay4x200: '4X200M 接力',
    '100m': '100公尺預賽',
    '200m': '200公尺預賽',
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

function resetToOfficialSeedData() {
  if (!confirm('⚠️ 警告：這將會清除所有目前鍵入的成績與修改，還原至 115 學年度官方初始空白名單。確定要重置嗎？')) return;
  localStorage.removeItem('TQ_MEET_DATA_115');
  localStorage.removeItem('TQ_MEET_YEARS_STORE');
  const seed = JSON.parse(JSON.stringify(window.INITIAL_MEET_DATA));
  APP_STATE.years = { '115': seed };
  APP_STATE.currentYear = '115';
  APP_STATE.data = seed;
  saveLocalData();
  updateAcademicYearHeaderUI();
  initClassSearchOptions();
  renderLeaderboard();
  renderClassRoster();
  renderMasterSchedule();
  initTeacherDashboard();
  renderTeacherDuties();
  renderAdminEditTable();
  showToast('🔄 已成功重置至 115 學年度官方名單');
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
  }
  if (toggle) {
    APP_STATE.sync.pollingEnabled = toggle.checked;
    localStorage.setItem('TQ_POLLING_ENABLED', String(toggle.checked));
  }

  if (APP_STATE.sync.pollingEnabled && APP_STATE.sync.gasUrl) {
    startSyncPolling();
  } else {
    stopSyncPolling();
  }

  updateSyncStatusUI();
  closeSyncConfigModal();
  showToast('⚙️ 雲端同步設定已更新！');
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

function pullDataFromCloud() {
  if (!APP_STATE.sync.gasUrl || APP_STATE.sync.isSyncing) return;

  APP_STATE.sync.isSyncing = true;
  fetch(APP_STATE.sync.gasUrl)
    .then(res => res.json())
    .then(res => {
      APP_STATE.sync.isSyncing = false;
      if (res && res.status === 'success' && res.data) {
        if (res.lastUpdated !== APP_STATE.sync.lastSyncedTime) {
          APP_STATE.sync.lastSyncedTime = res.lastUpdated;
          APP_STATE.data = res.data;
          localStorage.setItem('TQ_MEET_DATA_115', JSON.stringify(APP_STATE.data));
          renderLeaderboard();
          renderClassRoster();
          console.log('Synchronized new data from Google Sheets.');
        }
      }
    })
    .catch(err => {
      APP_STATE.sync.isSyncing = false;
      console.warn('Sync poll failed:', err);
    });
}

function pushDataToCloud() {
  if (!APP_STATE.sync.gasUrl) return;

  fetch(APP_STATE.sync.gasUrl, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(APP_STATE.data)
  }).then(() => {
    APP_STATE.sync.lastSyncedTime = new Date().toISOString();
    console.log('Pushed data to cloud Google Sheets successfully.');
  }).catch(err => {
    console.error('Push data failed:', err);
  });
}

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

// 頁面載入完成後啟動
window.addEventListener('DOMContentLoaded', () => {
  initApp();
});
