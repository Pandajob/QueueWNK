// =====================================================================
//  ฟอร์มสมัครใช้บริการ HIS — บันทึกลง Google Sheet แล้วแจ้งเข้ากลุ่มแชท
//  Google Apps Script
//
//  ใช้คู่กับไฟล์ HTML ชื่อ Index ในโปรเจกต์เดียวกัน
// =====================================================================

// ชื่อที่ขึ้นบนหน้าเว็บ — โรงพยาบาลอื่นแก้บรรทัดนี้บรรทัดเดียว
var HOSPITAL_NAME = 'โรงพยาบาลวังน้ำเขียว';

// ╔══════════════════════════════════════════════════════════════════╗
// ║  ตั้งค่าที่ Project Settings → Script Properties (ไม่ใส่ในโค้ด)  ║
// ╚══════════════════════════════════════════════════════════════════╝
//
// เก็บกุญแจไว้ใน Script Properties ไม่ฝังในไฟล์ เพราะไฟล์นี้ถูกก๊อปไปวาง
// ส่งต่อ และแปะในแชทได้ง่ายมาก กุญแจที่ฝังในโค้ดจะหลุดสักวันหนึ่งเสมอ
// ตั้งค่าเสร็จแล้วเปลี่ยนกุญแจได้โดยไม่ต้องแก้โค้ด
//
//   MOPH_BASE_URL     https://morpromt2f.moph.go.th
//   MOPH_CLIENT_KEY   client-key ของกลุ่ม
//   MOPH_SECRET_KEY   secret-key ของกลุ่ม
//   TELEGRAM_TOKEN    token จาก @BotFather   (ใส่เมื่อเปิดใช้ Telegram)
//   TELEGRAM_CHAT_ID  id ของกลุ่ม เช่น -100...  (ใส่เมื่อเปิดใช้ Telegram)
//
// วิธีขอกุญแจ MOPH Notify
//   1) สร้างกลุ่ม LINE ตั้งชื่อลงท้ายด้วย HC ตามด้วย hoscode 5 หลัก
//   2) เชิญบัญชี "LINE หมอพร้อม" เข้ากลุ่ม
//   3) ให้ admin หน่วยบริการอนุมัติใน CMS MOPH Notify เมนู "กลุ่มบอท"
//   4) กลุ่มขึ้นสถานะ "อนุมัติ" แล้วจะเห็น client-key / secret-key
//
// ⚠️ MOPH Notify ไม่มีช่อง "ส่งถึงใคร" เหมือน LINE Messaging API
//    กลุ่มปลายทางผูกมากับคู่กุญแจแล้ว จะเปลี่ยนกลุ่มต้องเปลี่ยนกุญแจ

var TELEGRAM_ENABLED = true;
var MOPH_NOTIFY_ENABLED = false; // เปลี่ยนเป็น true เมื่อใส่กุญแจครบแล้ว

// =====================================================================

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('สมัครใช้บริการ HIS ' + HOSPITAL_NAME)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ── MAIN: รับข้อมูลสมัคร ─────────────────────────────────────────────
function submitRegistration(formData) {
  try {
    // 1) บันทึกลง Google Sheet
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName('ลงทะเบียน');
    if (!sheet) sheet = ss.insertSheet('ลงทะเบียน');

    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        'วันที่สมัคร','Username','รหัสผ่าน','ชื่อ','นามสกุล',
        'วันเดือนปีเกิด','เลขบัตรประชาชน','เลขใบประกอบวิชาชีพ',
        'ตำแหน่ง','วันที่เริ่มปฏิบัติงาน','เบอร์โทรติดต่อ','Email','สถานะ'
      ]);
      const hdr = sheet.getRange(1, 1, 1, 13);
      hdr.setBackground('#1a5c2a');
      hdr.setFontColor('white');
      hdr.setFontWeight('bold');
      sheet.setFrozenRows(1);
      sheet.setColumnWidths(1, 13, 155);
    }

    const rowNum = sheet.getLastRow() + 1;
    sheet.appendRow([
      toBEDateTime(new Date()),
      formData.username,
      formData.password || '',
      formData.fname || '',
      formData.lname || '',
      toBEDate(formData.birthdate),
      formData.idCard,
      formData.licenseNo || '-',
      formData.position,
      toBEDate(formData.startDate),
      formData.phone,
      formData.contact,
      'รอดำเนินการ'
    ]);

    // 2) ส่งแจ้งเตือน (ไม่หยุดถ้า fail — คนสมัครต้องได้รับคำตอบว่าบันทึกแล้ว
    //    ต่อให้กลุ่มแชทมีปัญหา ข้อมูลอยู่ใน Sheet ครบแล้ว)
    try {
      const sheetUrl = ss.getUrl() + '#gid=' + sheet.getSheetId();
      if (TELEGRAM_ENABLED) sendTelegram(formData, rowNum, sheetUrl);
      if (MOPH_NOTIFY_ENABLED) sendMophNotify(formData, rowNum, sheetUrl);
    } catch (notifyErr) {
      console.error('Notify error:', notifyErr.toString());
    }

    return { success: true };
  } catch (e) {
    return { success: false, message: e.toString() };
  }
}

// ── TELEGRAM ──────────────────────────────────────────────────────────
function sendTelegram(d, row, sheetUrl) {
  var props = PropertiesService.getScriptProperties();
  var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm น.');
  var fullName = ((d.fname || '') + ' ' + (d.lname || '')).trim();

  var text = scrub_(
    '🏥 *แจ้งเตือน — สมัครใช้บริการ HIS ใหม่*\n' +
    '━━━━━━━━━━━━\n' +
    '👤 *Username:* `' + d.username + '`\n' +
    '🙍 ชื่อ-สกุล: ' + fullName + '\n' +
    '💼 ตำแหน่ง: ' + d.position + '\n' +
    '🗓 วันเริ่มงาน: ' + toBEDate(d.startDate) + '\n' +
    '📞 เบอร์โทร: ' + d.phone + '\n' +
    '📧 Email: ' + d.contact + '\n' +
    '🔒 บัตรประชาชน: ' + maskId(d.idCard) + '\n' +
    '━━━━━━━━━━━━\n' +
    '🕐 ' + now + '\n' +
    '📊 [เปิด Google Sheet](' + sheetUrl + ')'
  );

  var res = UrlFetchApp.fetch(
    'https://api.telegram.org/bot' + need_(props, 'TELEGRAM_TOKEN') + '/sendMessage',
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        chat_id: need_(props, 'TELEGRAM_CHAT_ID'),
        text: text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      }),
      muteHttpExceptions: true
    }
  );
  console.log('Telegram → HTTP ' + res.getResponseCode() + ' ' + res.getContentText());
}

// ── MOPH NOTIFY (แทน LINE Messaging API เดิม) ─────────────────────────
//
// ต่างจาก LINE Messaging API สามอย่าง
//   1. ยืนยันตัวด้วยสองกุญแจใน header ไม่ใช่ Bearer token ตัวเดียว
//   2. ไม่มีช่อง "to" — กลุ่มปลายทางผูกมากับคู่กุญแจตั้งแต่ตอนขออนุมัติแล้ว
//   3. ยิงไป morpromt2f.moph.go.th ไม่ใช่ api.line.me
//
// ส่งเป็น text ล้วนโดยตั้งใจ — ปลายทางมีคิวแยกกัน คำขอที่มีการ์ด Flex ปนอยู่
// เข้ากลุ่มช้ากว่าราว 19 นาที และช้าทั้งคำขอ ไม่ใช่แค่ตัวการ์ด
function sendMophNotify(d, row, sheetUrl) {
  var props = PropertiesService.getScriptProperties();
  var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm น.');
  var fullName = ((d.fname || '') + ' ' + (d.lname || '')).trim();

  var text =
    '🏥 แจ้งเตือน — สมัครใช้บริการ HIS ใหม่\n' +
    '──────────────────────\n' +
    '👤 Username: ' + d.username + '\n' +
    '🙍 ชื่อ-สกุล: ' + fullName + '\n' +
    '💼 ตำแหน่ง: ' + d.position + '\n' +
    '🗓 วันเริ่มงาน: ' + toBEDate(d.startDate) + '\n' +
    '📞 เบอร์โทร: ' + d.phone + '\n' +
    '📧 Email: ' + d.contact + '\n' +
    '🔒 บัตรประชาชน: ' + maskId(d.idCard) + '\n' +
    '──────────────────────\n' +
    '🕐 ' + now + '\n' +
    '📊 Google Sheet:\n' + sheetUrl;

  sendNotifyText_(props, text);
}

/**
 * ส่งข้อความตัวอักษรเข้ากลุ่มผ่าน MOPH Notify
 *
 * scrub_ ตัดเลข 13 หลักทิ้งที่ชั้นล่างสุดก่อนออกเสมอ ไม่ต้องไว้ใจว่าทุกจุด
 * ที่เรียกใช้จำได้ว่าต้อง mask — ปลายทางเป็นกลุ่มแชทที่มีคนอ่านหลายคน
 * และข้อความ error ที่เผลอต่อท้ายมาก็อาจมีเลขบัตรติดมาได้
 */
function sendNotifyText_(props, text) {
  var safe = scrub_(String(text)).slice(0, 4000);

  var res = UrlFetchApp.fetch(
    need_(props, 'MOPH_BASE_URL').replace(/\/+$/, '') + '/api/notify/send',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'client-key': need_(props, 'MOPH_CLIENT_KEY'),
        'secret-key': need_(props, 'MOPH_SECRET_KEY')
      },
      payload: JSON.stringify({ messages: [{ type: 'text', text: safe }] }),
      muteHttpExceptions: true
    }
  );

  var code = res.getResponseCode();
  var body = res.getContentText();
  console.log('MOPH Notify → HTTP ' + code + ' ' + body);

  if (code >= 300) throw new Error('ส่งไม่สำเร็จ HTTP ' + code + ' — ' + body);
  return code;
}

// ── ตรวจกุญแจโดยไม่ให้มีข้อความโผล่ในกลุ่ม ────────────────────────────
//
// ยิงคำขอที่ไม่มี messages ปลายทางตรวจกุญแจก่อนตรวจ body เสมอ
//   "Unauthorized"     → กุญแจผิด
//   "require messages" → กุญแจถูก (ผ่านด่านมาแล้วถึงมาบ่นเรื่อง body)
// ทั้งสองกรณีไม่มีอะไรเข้ากลุ่ม
function verifyMophKeys() {
  var props = PropertiesService.getScriptProperties();
  var res = UrlFetchApp.fetch(
    need_(props, 'MOPH_BASE_URL').replace(/\/+$/, '') + '/api/notify/send',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'client-key': need_(props, 'MOPH_CLIENT_KEY'),
        'secret-key': need_(props, 'MOPH_SECRET_KEY')
      },
      payload: JSON.stringify({}),
      muteHttpExceptions: true
    }
  );

  var body = res.getContentText();
  if (/require messages/i.test(body)) {
    Logger.log('✅ กุญแจใช้งานได้ (ไม่มีข้อความเข้ากลุ่ม)');
  } else if (/unauthorized/i.test(body) || res.getResponseCode() === 401) {
    Logger.log('❌ กุญแจไม่ถูกต้อง — คัดลอกใหม่จาก CMS MOPH Notify เมนู "กลุ่มบอท"');
  } else {
    Logger.log('⚠️ ผลลัพธ์ที่ไม่รู้จัก: HTTP ' + res.getResponseCode() + ' ' + body);
  }
}

// ── ทดสอบส่งจริง (รันใน GAS Editor) ──────────────────────────────────
function testNotification() {
  var dummy = {
    username : 'test.admin',
    fname    : 'ทดสอบ',
    lname    : 'ระบบ',
    position : 'พยาบาลวิชาชีพ',
    startDate: '2025-03-01',
    phone    : '0812345678',
    contact  : 'test@hospital.go.th',
    idCard   : '1234567890123',
    licenseNo: '12345'
  };
  var url = SpreadsheetApp.getActiveSpreadsheet().getUrl();
  if (TELEGRAM_ENABLED) sendTelegram(dummy, 99, url);
  if (MOPH_NOTIFY_ENABLED) sendMophNotify(dummy, 99, url);
  Logger.log('ส่งข้อความทดสอบแล้ว — ข้อความนี้เข้ากลุ่มจริง');
}

// ── Helper: อ่านค่าจาก Script Properties พร้อมบอกให้ชัดเมื่อยังไม่ได้ตั้ง ──
function need_(props, key) {
  var value = props.getProperty(key);
  if (!value) {
    throw new Error('ยังไม่ได้ตั้งค่า ' + key + ' ที่ Project Settings → Script Properties');
  }
  return value;
}

// ── Helper: ตัดเลข 13 หลักทิ้งก่อนส่งออกนอกระบบ ──────────────────────
function scrub_(value) {
  if (typeof value === 'string') return value.replace(/\d{13}/g, 'xxxxxxxxxxxxx');
  if (Array.isArray(value)) return value.map(scrub_);
  if (value && typeof value === 'object') {
    var out = {};
    Object.keys(value).forEach(function (k) { out[k] = scrub_(value[k]); });
    return out;
  }
  return value;
}

// ── Helper: mask เลขบัตร เพื่อความเป็นส่วนตัว ────────────────────────
function maskId(id) {
  if (!id || id.length < 4) return '***';
  return id.slice(0,1) + '-XXXX-XXXXX-XX-' + id.slice(-1);
}

// ── Helper: แปลงวันที่ YYYY-MM-DD → DD/MM/พ.ศ. ──────────────────────
function toBEDate(dateStr) {
  if (!dateStr) return '-';
  var p = String(dateStr).split('-');
  if (p.length < 3) return dateStr;
  return p[2] + '/' + p[1] + '/' + (parseInt(p[0]) + 543);
}

// ── Helper: วันเวลาปัจจุบันเป็น DD/MM/พ.ศ. HH:MM:SS ─────────────────
function toBEDateTime(d) {
  var zone = 'Asia/Bangkok';
  var dd = Utilities.formatDate(d, zone, 'dd');
  var mo = Utilities.formatDate(d, zone, 'MM');
  var yy = parseInt(Utilities.formatDate(d, zone, 'yyyy')) + 543;
  var tm = Utilities.formatDate(d, zone, 'HH:mm:ss');
  return dd + '/' + mo + '/' + yy + ' ' + tm + ' น.';
}
