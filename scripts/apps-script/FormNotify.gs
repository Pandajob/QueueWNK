/**
 * รับคำตอบจาก Google Form แล้วส่งการ์ดเข้ากลุ่ม LINE ผ่าน MOPH Notify
 *
 * วิธีติดตั้ง
 *   1. เปิดฟอร์ม → เมนูสามจุดมุมขวาบน → Apps Script
 *   2. สร้างไฟล์ FlexPurple.gs กับ FormNotify.gs วางโค้ดลงไป
 *   3. Project Settings → Script Properties ใส่ MOPH_BASE_URL / MOPH_CLIENT_KEY / MOPH_SECRET_KEY
 *   4. เลือกฟังก์ชัน setupTrigger แล้วกด Run หนึ่งครั้ง (จะขออนุญาตเข้าถึงฟอร์มกับอินเทอร์เน็ต)
 *   5. ลองส่งฟอร์มจริงหนึ่งใบ
 *
 * ถ้าติดสคริปต์ไว้กับ Sheet ที่เก็บคำตอบแทนฟอร์มก็ใช้ได้ โค้ดอ่านได้ทั้งสองแบบ
 */

/* ================================================================
 *  ปรับตรงนี้
 * ================================================================ */

const FORM = {
  // หัวการ์ด เว้นว่างไว้จะใช้ชื่อฟอร์ม
  title: '',

  // ไม่ต้องส่งคำถามพวกนี้เข้ากลุ่ม (เทียบแบบมีคำนี้อยู่ในชื่อคำถาม)
  skipQuestions: ['เลขบัตรประชาชน', 'เบอร์โทร'],

  // คำตอบยาวเกินนี้จะถูกตัด กันการ์ดทะลุเพดาน 10 KB
  maxAnswerChars: 300,

  // แสดงมากสุดกี่คำถาม ที่เหลือจะบอกว่ายังมีอีกกี่ข้อ
  maxQuestions: 15,

  /**
   * ถ้าคำตอบไหนมีคำเหล่านี้ ถือว่าด่วน
   * จะยิงข้อความล้วนไปก่อนหนึ่งครั้ง แล้วค่อยตามด้วยการ์ด
   * เพราะบนคิวของ MOPH Notify การ์ดเข้ากลุ่มช้ากว่าข้อความล้วนราว 19 นาที
   */
  urgentWords: ['ด่วน', 'ฉุกเฉิน', 'เร่งด่วน'],

  // ลิงก์ปุ่มท้ายการ์ด เว้นว่างไว้จะไม่มีปุ่ม
  buttonLabel: 'ดูคำตอบทั้งหมด',
  buttonUrl: '',
}

/* ================================================================
 *  ตัวรับ trigger
 * ================================================================ */

function onFormSubmit(e) {
  const data = readSubmission_(e)
  const urgent = isUrgent_(data.items)

  // เรื่องด่วนต้องแยกคำขอ ถ้ายัดรวมกับการ์ดในคำขอเดียวจะโดนดองไปด้วยกันทั้งคู่
  if (urgent) {
    notifyText(
      '🔴 ' + data.title + ' — มีรายการด่วน\n' +
        data.items
          .slice(0, 3)
          .map(function (it) { return it.q + ': ' + it.a })
          .join('\n') +
        '\n(การ์ดรายละเอียดตามมาอีกสักครู่)'
    )
  }

  notify(buildFormCard_(data, urgent))
}

/** สร้าง trigger ให้ ลบของเดิมก่อนกันซ้ำ */
function setupTrigger() {
  const existing = ScriptApp.getProjectTriggers()
  existing.forEach(function (t) {
    if (t.getHandlerFunction() === 'onFormSubmit') ScriptApp.deleteTrigger(t)
  })

  const form = tryActiveForm_()
  if (form) {
    ScriptApp.newTrigger('onFormSubmit').forForm(form).onFormSubmit().create()
    console.log('ตั้ง trigger กับฟอร์ม "' + form.getTitle() + '" แล้ว')
    return
  }

  const sheet = SpreadsheetApp.getActive()
  if (!sheet) throw new Error('สคริปต์นี้ต้องผูกกับ Google Form หรือ Sheet ที่เก็บคำตอบ')
  ScriptApp.newTrigger('onFormSubmit').forSpreadsheet(sheet).onFormSubmit().create()
  console.log('ตั้ง trigger กับชีต "' + sheet.getName() + '" แล้ว')
}

/**
 * ลองดูหน้าตาการ์ดจากคำตอบล่าสุด โดยไม่ส่งเข้ากลุ่ม
 * เปิด Execution log แล้วเอา JSON ไปวางที่ developers.line.biz/flex-simulator
 */
function previewLatest() {
  const form = tryActiveForm_()
  if (!form) throw new Error('ใช้ได้เฉพาะตอนที่สคริปต์ผูกกับฟอร์ม')

  const responses = form.getResponses()
  if (!responses.length) throw new Error('ฟอร์มนี้ยังไม่มีคำตอบเลย')

  const data = readSubmission_({ response: responses[responses.length - 1] })
  preview(buildFormCard_(data, isUrgent_(data.items)))
}

/**
 * ส่งข้อความล้วนทดสอบเข้ากลุ่มจริง — ถึงภายในไม่กี่นาที
 * ใช้ตัวนี้ยืนยันว่าคีย์ผูกกับกลุ่มที่ถูกต้อง ก่อนไปลุ้นการ์ดที่ช้ากว่า
 */
function sendTestText() {
  notifyText('ทดสอบการเชื่อมต่อจาก Google Form — ' + thaiStamp_(new Date(), true))
  console.log('ส่งแล้ว รอสักครู่แล้วดูในกลุ่ม')
}

/**
 * ส่งการ์ดทดสอบจากคำตอบล่าสุดเข้ากลุ่มจริง
 * การ์ดเข้าคิวคนละสายกับข้อความล้วน ปกติช้ากว่าราว 19 นาที อย่าเพิ่งคิดว่าพัง
 */
function sendTestCard() {
  const form = tryActiveForm_()
  if (!form) throw new Error('ใช้ได้เฉพาะตอนที่สคริปต์ผูกกับฟอร์ม')

  const responses = form.getResponses()
  if (!responses.length) throw new Error('ฟอร์มนี้ยังไม่มีคำตอบเลย')

  const data = readSubmission_({ response: responses[responses.length - 1] })
  notify(buildFormCard_(data, isUrgent_(data.items)))
  console.log('ส่งการ์ดแล้ว — การ์ดเข้ากลุ่มช้ากว่าข้อความล้วน รอได้ถึงราว 19 นาที')
}

/* ================================================================
 *  อ่านคำตอบ
 * ================================================================ */

function tryActiveForm_() {
  try {
    return FormApp.getActiveForm()
  } catch (err) {
    // สคริปต์ผูกกับชีต ไม่ใช่ฟอร์ม
    return null
  }
}

function readSubmission_(e) {
  if (e && e.response && e.response.getItemResponses) return fromForm_(e.response)
  if (e && e.range) return fromSheet_(e)
  throw new Error('ไม่พบข้อมูลคำตอบ — ฟังก์ชันนี้ต้องถูกเรียกจาก trigger "เมื่อมีการส่งฟอร์ม"')
}

function fromForm_(response) {
  const form = tryActiveForm_()
  return {
    title: FORM.title || (form ? form.getTitle() : 'คำตอบใหม่'),
    submittedAt: response.getTimestamp(),
    email: response.getRespondentEmail ? response.getRespondentEmail() : '',
    items: response
      .getItemResponses()
      .map(function (ir) {
        return { q: ir.getItem().getTitle(), a: flatten_(ir.getResponse()) }
      })
      .filter(keep_),
  }
}

function fromSheet_(e) {
  // ใช้หัวคอลัมน์จริงแทน e.namedValues เพราะ namedValues ไม่รับประกันลำดับ
  const sheet = e.range.getSheet()
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]

  const items = []
  for (let i = 0; i < header.length; i++) {
    const q = String(header[i] || '').trim()
    if (!q || /^(ประทับเวลา|timestamp)$/i.test(q)) continue
    items.push({ q: q, a: flatten_(e.values[i]) })
  }

  return {
    title: FORM.title || sheet.getName(),
    submittedAt: new Date(),
    email: '',
    items: items.filter(keep_),
  }
}

/** คำตอบอาจเป็นสตริง อาร์เรย์ (checkbox) หรืออาร์เรย์ซ้อน (grid) */
function flatten_(value) {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) {
    return value
      .map(flatten_)
      .filter(function (v) { return v !== '' })
      .join(', ')
  }
  if (value instanceof Date) {
    return thaiStamp_(value, true)
  }
  return String(value).trim()
}

function keep_(item) {
  if (!item.a) return false
  return !FORM.skipQuestions.some(function (word) {
    return word && item.q.indexOf(word) >= 0
  })
}

function isUrgent_(items) {
  return items.some(function (it) {
    return FORM.urgentWords.some(function (w) {
      return w && (it.a.indexOf(w) >= 0 || it.q.indexOf(w) >= 0)
    })
  })
}

/* ================================================================
 *  สร้างการ์ด
 * ================================================================ */

function buildFormCard_(data, urgent) {
  const shown = data.items.slice(0, FORM.maxQuestions)
  const rest = data.items.length - shown.length

  const rows = shown.map(function (it) {
    const a = it.a.length > FORM.maxAnswerChars ? it.a.slice(0, FORM.maxAnswerChars) + ' …' : it.a
    // คำตอบสั้นจัดเป็นสองคอลัมน์ คำตอบยาวขึ้นบรรทัดใหม่เต็มความกว้าง
    return a.length > 40 ? [it.q + '\n' + a] : [it.q, a]
  })

  const stamp = thaiStamp_(data.submittedAt, true)

  const notes = []
  if (rest > 0) notes.push({ text: 'ยังมีอีก ' + rest + ' ข้อที่ไม่ได้แสดงในการ์ดนี้', level: 'info' })

  return buildCard({
    icon: urgent ? '🔴' : '🟣',
    title: data.title,
    subtitle: 'ส่งเมื่อ ' + stamp,
    level: urgent ? 'bad' : 'info',
    status: urgent ? 'มีรายการที่ระบุว่าด่วน' : 'ได้รับคำตอบใหม่ ' + data.items.length + ' ข้อ',
    chips: data.email ? [{ label: data.email, filled: true }] : [],
    sections: [{ title: 'รายละเอียดคำตอบ', rows: rows }],
    notes: notes,
    buttons: FORM.buttonUrl ? [{ label: FORM.buttonLabel, url: FORM.buttonUrl }] : [],
    footer: 'Google Form',
  })
}
