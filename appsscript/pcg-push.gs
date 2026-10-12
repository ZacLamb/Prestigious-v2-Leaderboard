/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PCG Leaderboard — sheet push
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Sends this spreadsheet's commission tab to the leaderboard on a timer.
 *
 *  WHY THIS EXISTS
 *  The leaderboard used to read the spreadsheet directly from Google. That
 *  needs the file shared "anyone with the link", and a Workspace policy that
 *  forbids external sharing silently revokes it — every read then returns 401
 *  and the board freezes. This script reverses the direction: it runs as the
 *  sheet's owner, so the spreadsheet can stay completely private and no
 *  sharing setting can break it.
 *
 *  HOW TO INSTALL  (do this in each spreadsheet, NY and Miami)
 *   1. Extensions → Apps Script.
 *   2. Click the + next to "Files" → Script. Name it  PCGPush.
 *      ⚠️  Add it as a NEW file. Do not paste over an existing script — the
 *          submission and consolidation logic already in there is unrelated
 *          and must stay exactly as it is.
 *   3. Paste this whole file in and Save.
 *   4. Fill in the three values in CONFIG below.
 *   5. Run  pcgPushNow  once. Approve the permissions prompt when it appears.
 *      It should finish with "Pushed N rows".
 *   6. Run  pcgInstallTrigger  once. That's it — it now pushes every 15
 *      minutes on its own.
 *
 *  If a push ever fails, Google emails the sheet owner automatically.
 *  Run  pcgPushNow  by hand to see the error immediately.
 * ═══════════════════════════════════════════════════════════════════════════
 */

var CONFIG = {
  /** The leaderboard's Railway URL, no trailing slash. */
  APP_URL: 'https://YOUR-APP.up.railway.app',

  /** Which office this spreadsheet is. Exactly 'ny' or 'miami'. */
  OFFICE: 'ny',

  /**
   * Must match INGEST_SECRET in Railway.
   * This is NOT the dashboard admin password — it only lets this script
   * deliver rows, and it unlocks no commission figures.
   */
  SECRET: 'PASTE_INGEST_SECRET_HERE',

  /**
   * The tab to send, by gid — the number after #gid= in the URL when that tab
   * is open. gid is used rather than the name so renaming the tab can't break
   * the push. Leave as null to use the tab named below instead.
   *   New York: 644411698      Miami: 177844678
   */
  TAB_GID: 644411698,

  /** Only used when TAB_GID is null. */
  TAB_NAME: 'Commision',

  /** Row holding the column headers. Almost always 1. */
  HEADER_ROW: 1,
};

var TRIGGER_HANDLER = 'pcgPushNow';
var TRIGGER_MINUTES = 15;

/** Locate the tab to send, by gid when given and by name otherwise. */
function pcgFindSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  if (CONFIG.TAB_GID !== null && CONFIG.TAB_GID !== undefined && CONFIG.TAB_GID !== '') {
    var all = ss.getSheets();
    for (var i = 0; i < all.length; i++) {
      if (String(all[i].getSheetId()) === String(CONFIG.TAB_GID)) return all[i];
    }
    var names = [];
    for (var j = 0; j < all.length; j++) {
      names.push(all[j].getName() + ' (gid ' + all[j].getSheetId() + ')');
    }
    throw new Error('No tab with gid ' + CONFIG.TAB_GID + '. Tabs here: ' + names.join(', '));
  }

  var byName = ss.getSheetByName(CONFIG.TAB_NAME);
  if (!byName) throw new Error('No tab named "' + CONFIG.TAB_NAME + '".');
  return byName;
}

/**
 * Read the tab and POST it.
 *
 * getDisplayValues is deliberate: it sends each cell exactly as the sheet
 * shows it, which is what the CSV export produced. getValues would hand back
 * live Date objects and raw numbers that JSON turns into UTC timestamps,
 * shifting deals across day boundaries on the way.
 */
function pcgPushNow() {
  if (CONFIG.APP_URL.indexOf('YOUR-APP') !== -1) {
    throw new Error('Set CONFIG.APP_URL to the leaderboard URL first.');
  }
  if (CONFIG.SECRET.indexOf('PASTE_INGEST') !== -1) {
    throw new Error('Set CONFIG.SECRET to the INGEST_SECRET value from Railway first.');
  }
  if (CONFIG.OFFICE !== 'ny' && CONFIG.OFFICE !== 'miami') {
    throw new Error('CONFIG.OFFICE must be exactly "ny" or "miami" — got "' + CONFIG.OFFICE + '".');
  }

  var sheet = pcgFindSheet_();
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();

  if (lastRow < CONFIG.HEADER_ROW + 1) {
    throw new Error('Tab "' + sheet.getName() + '" has no data rows below the header.');
  }

  var values = sheet
    .getRange(CONFIG.HEADER_ROW, 1, lastRow - CONFIG.HEADER_ROW + 1, lastCol)
    .getDisplayValues();

  var response = UrlFetchApp.fetch(CONFIG.APP_URL + '/api/ingest/' + CONFIG.OFFICE, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Ingest-Secret': CONFIG.SECRET },
    payload: JSON.stringify({ tab: sheet.getName(), gid: sheet.getSheetId(), values: values }),
    muteHttpExceptions: true,
  });

  var code = response.getResponseCode();
  var body = response.getContentText();

  if (code < 200 || code >= 300) {
    // Thrown, not logged: a trigger that throws gets an automatic failure
    // email, so a silently broken push can't go unnoticed for weeks.
    throw new Error('Leaderboard rejected the push (HTTP ' + code + '): ' + body);
  }

  Logger.log('Pushed ' + (values.length - 1) + ' rows from "' + sheet.getName() + '" → ' + body);
  return body;
}

/** Install the recurring push. Safe to run twice — it replaces its own trigger. */
function pcgInstallTrigger() {
  pcgRemoveTrigger();
  ScriptApp.newTrigger(TRIGGER_HANDLER).timeBased().everyMinutes(TRIGGER_MINUTES).create();
  Logger.log('Installed: pushing every ' + TRIGGER_MINUTES + ' minutes.');
}

/** Stop the recurring push. Leaves every other trigger in this project alone. */
function pcgRemoveTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log('Removed ' + removed + ' push trigger(s).');
}

/** Print what this script sees, without sending anything. */
function pcgDiagnose() {
  var sheet = pcgFindSheet_();
  var headers = sheet.getRange(CONFIG.HEADER_ROW, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  Logger.log('Office:   ' + CONFIG.OFFICE);
  Logger.log('Tab:      ' + sheet.getName() + ' (gid ' + sheet.getSheetId() + ')');
  Logger.log('Rows:     ' + (sheet.getLastRow() - CONFIG.HEADER_ROW) + ' below the header');
  Logger.log('Headers:  ' + headers.join(' | '));
  Logger.log('Posting to: ' + CONFIG.APP_URL + '/api/ingest/' + CONFIG.OFFICE);
}
