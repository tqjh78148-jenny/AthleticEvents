/**
 * 頭前國中 115學年度校慶運動會 - Google 試算表即時同步 Google Apps Script (GAS)
 * 
 * 【部屬教學】：
 * 1. 在 Google 雲端硬碟建立一份新的 Google 試算表（例如命名為「頭前國中校慶運動會成績資料庫」）。
 * 2. 點選試算表上方選單「擴充功能」 -> 「Apps Script」。
 * 3. 刪除原有預設程式碼，將本檔案全部內容複製並貼上到程式碼編輯區。
 * 4. 點選右上角「部署」按鈕 -> 選擇「新增部署作業」。
 * 5. 點選左側齒輪圖示 -> 選擇「網頁應用程式 (Web App)」。
 *    - 說明：可輸入「頭前國中田徑賽同步 API」
 *    - 執行身分：選擇「我 (您的 Google 帳號)」
 *    - 誰可以存取：務必選擇「所有人 (Anyone)」
 * 6. 點選「部署」，並授予應用程式存取權限。
 * 7. 複製產生的「網頁應用程式網址 (Web App URL)」，貼回本系統【後台管理】->【多人即時同步設定】中即可！
 */

var SHEET_NAME = "MeetData";

function getOrCreateSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1).setValue("meet_json");
    sheet.getRange(1, 2).setValue("last_updated");
  }
  return sheet;
}

/**
 * 處理 GET 請求：前端每 5 秒自動輪詢（polling）拉取最新賽事成績
 */
function doGet(e) {
  try {
    var sheet = getOrCreateSheet();
    var jsonStr = sheet.getRange(2, 1).getValue();
    var lastUpdated = sheet.getRange(2, 2).getValue();
    
    var responseData = {
      status: "success",
      lastUpdated: lastUpdated || new Date().toISOString(),
      data: jsonStr ? JSON.parse(jsonStr) : null
    };
    
    return ContentService.createTextOutput(JSON.stringify(responseData))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * 處理 POST 請求：後台裁判/組長鍵入成績後上傳同步
 */
function doPost(e) {
  try {
    var postBody = "";
    if (e.postData && e.postData.contents) {
      postBody = e.postData.contents;
    }
    
    var payload = JSON.parse(postBody);
    var sheet = getOrCreateSheet();
    var nowIso = new Date().toISOString();
    
    // 儲存最新的完整 JSON 資料與更新時間戳記
    sheet.getRange(2, 1).setValue(JSON.stringify(payload));
    sheet.getRange(2, 2).setValue(nowIso);
    
    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      message: "成績資料已成功同步儲存至 Google 試算表",
      timestamp: nowIso
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}
