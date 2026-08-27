/**
 * แจ้งเตือนเข้ากลุ่ม LINE ผ่าน MOPH Notify ด้วยการ์ด Flex โทนม่วง
 * Google Apps Script — ไฟล์นี้เป็นตัวสร้างการ์ดกับตัวส่ง ไม่ต้องแก้อะไร
 *
 * ต้องตั้งค่าที่ Project Settings → Script Properties สามค่า
 *   MOPH_BASE_URL      เช่น https://<host ของ MOPH Notify>
 *   MOPH_CLIENT_KEY
 *   MOPH_SECRET_KEY
 *
 * อย่าพิมพ์คีย์ลงในไฟล์ — แชร์สคริปต์ให้คนอื่นเมื่อไรคีย์ติดไปด้วยทันที
 */

/* ================================================================
 *  1) จานสี — ม่วงเป็นแกน สีอื่นเอาไว้แยกความหมาย
 * ================================================================ */

const P = {
  // แกนม่วง ไล่จากเข้มไปอ่อน
  deep: '#3b0f6f', // หัวการ์ด
  main: '#6d28d9', // สีหลัก ปุ่ม ป้าย
  soft: '#a78bfa', // ตัวหนังสือบนพื้นเข้ม
  tint: '#f6f3ff', // พื้นกล่อง
  line: '#e5dcfa', // เส้นคั่น
  ink: '#2a1055', // ตัวหนังสือหลัก
  body: '#4a3b6b', // ตัวหนังสือรอง
  muted: '#8578a3', // ป้ายกำกับ
  onDark: '#efe8ff', // ตัวหนังสือบนหัวการ์ด

  // สีสถานะ จงใจอยู่นอกโทนม่วง จะได้อ่านออกว่าเป็นสถานะไม่ใช่การตกแต่ง
  ok: '#15803d',
  warn: '#b45309',
  bad: '#be123c',
  info: '#2563eb',

  // ชุดสีสำหรับป้ายหลายอัน วนใช้ตามลำดับ
  wheel: ['#6d28d9', '#0891b2', '#059669', '#d97706', '#db2777', '#4f46e5'],
}

/** แถบสีรุ้งใต้หัวการ์ด — ไล่จากม่วงเข้มออกไปหาสีอื่น ให้ม่วงยังเป็นตัวนำ */
const RAINBOW = ['#3b0f6f', '#6d28d9', '#8b5cf6', '#a78bfa', '#22d3ee', '#f472b6']

function tone_(level) {
  const map = {
    ok: { color: P.ok, icon: '✓' },
    warn: { color: P.warn, icon: '!' },
    bad: { color: P.bad, icon: '✕' },
    info: { color: P.info, icon: 'i' },
  }
  return map[level] || { color: P.main, icon: '•' }
}

/* ================================================================
 *  2) ชิ้นส่วนการ์ด
 * ================================================================ */

/** ตัดคีย์ที่เป็น undefined ทิ้ง — ทุกคีย์ที่ซ้ำทุกแถวกินโควตาขนาดข้อความจริง */
function compact_(node) {
  Object.keys(node).forEach(function (k) {
    if (node[k] === undefined) delete node[k]
  })
  return node
}

function text_(value, opts) {
  return compact_(Object.assign({ type: 'text', text: String(value) }, opts || {}))
}

/** ป้ายกลม ๆ  filled = พื้นทึบ ไม่ใส่ = ขอบอย่างเดียว */
function chip_(label, color, filled) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: filled ? color : undefined,
    borderColor: color,
    borderWidth: '1px',
    cornerRadius: '12px',
    paddingAll: '3px',
    paddingStart: '9px',
    paddingEnd: '9px',
    flex: 0,
    contents: [text_(label, { size: 'xxs', weight: 'bold', color: filled ? '#ffffff' : color })],
  }
}

function chipRow_(chips) {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    spacing: 'xs',
    contents: chips.map(function (c, i) {
      return chip_(c.label, c.color || P.wheel[i % P.wheel.length], c.filled)
    }),
  }
}

/** แถบสีบาง ๆ หลายสี วางใต้หัวการ์ด */
function rainbow_() {
  return {
    type: 'box',
    layout: 'horizontal',
    height: '4px',
    contents: RAINBOW.map(function (color) {
      return { type: 'box', layout: 'vertical', backgroundColor: color, contents: [{ type: 'filler' }] }
    }),
  }
}

/** แถวสองคอลัมน์ ป้ายซ้าย ค่าขวา */
function pair_(label, value, tone, bold) {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'sm',
    contents: [
      text_(label, { size: 'sm', color: P.muted, flex: 4 }),
      text_(value, {
        size: 'sm',
        color: tone || P.ink,
        weight: bold ? 'bold' : undefined,
        align: 'end',
        flex: 5,
        wrap: true,
      }),
    ],
  }
}

/** หัวการ์ด พื้นม่วงเข้ม */
function header_(title, subtitle, icon) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: P.deep,
    paddingAll: '16px',
    paddingBottom: '14px',
    contents: [
      {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          icon ? text_(icon, { size: 'lg', flex: 0, color: P.soft }) : null,
          text_(title, { size: 'lg', weight: 'bold', color: '#ffffff', wrap: true }),
        ].filter(Boolean),
      },
      subtitle ? text_(subtitle, { size: 'xs', color: P.soft, margin: 'xs', wrap: true }) : null,
    ].filter(Boolean),
  }
}

/** แถบสรุปสถานะ พื้นอ่อน ขีดสีเข้มด้านซ้าย */
function statusBar_(message, level) {
  const t = tone_(level)
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'lg',
    spacing: 'md',
    paddingAll: '10px',
    cornerRadius: '8px',
    backgroundColor: P.tint,
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: '4px',
        backgroundColor: t.color,
        cornerRadius: '2px',
        contents: [{ type: 'filler' }],
      },
      text_(t.icon + '  ' + message, {
        size: 'sm',
        weight: 'bold',
        color: t.color,
        wrap: true,
        flex: 1,
      }),
    ],
  }
}

/** กล่องหัวข้อ + แถวป้าย/ค่า */
function section_(title, rows, accent) {
  const color = accent || P.main
  const head = {
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        width: '3px',
        backgroundColor: color,
        cornerRadius: '2px',
        contents: [{ type: 'filler' }],
      },
      text_(title, { size: 'xs', weight: 'bold', color: color }),
    ],
  }

  return {
    type: 'box',
    layout: 'vertical',
    margin: 'lg',
    paddingAll: '12px',
    cornerRadius: '8px',
    backgroundColor: P.tint,
    contents: [head].concat(
      rows.map(function (r) {
        // ใส่มาช่องเดียว = ข้อความยาวเต็มความกว้าง (คำตอบแบบเรียงความจัดชิดขวาแล้วอ่านยาก)
        if (r.length === 1) {
          return text_(r[0], { size: 'sm', color: P.ink, wrap: true, margin: 'sm' })
        }
        return pair_(r[0], r[1], r[2], r[3])
      })
    ),
  }
}

/**
 * ตาราง — หัวคอลัมน์ไล่สีตาม RAINBOW แถวสลับพื้นอ่อน
 * ช่องหนึ่งช่องเป็นสตริง หรือ { v: 'ค่า', color: '#...' } ถ้าอยากย้อมเฉพาะช่องนั้น
 */
function table_(head, rows, flexes) {
  const widths =
    flexes ||
    head.map(function (_, i) {
      return i === 0 ? 4 : 3
    })

  const cell = function (value, i, opts) {
    const raw = value && typeof value === 'object' ? value : { v: value }
    const shown = raw.v === undefined || raw.v === null || raw.v === '' ? '—' : raw.v
    return text_(
      shown,
      Object.assign(
        {
          size: 'xxs',
          flex: widths[i],
          align: i === 0 ? 'start' : 'end',
          color: raw.color || P.body,
        },
        opts || {}
      )
    )
  }

  const headRow = {
    type: 'box',
    layout: 'horizontal',
    paddingAll: '8px',
    backgroundColor: P.deep,
    contents: head.map(function (h, i) {
      return cell(h, i, {
        weight: 'bold',
        color: i === 0 ? '#ffffff' : RAINBOW[(i + 2) % RAINBOW.length],
      })
    }),
  }

  const bodyRows = rows.map(function (r, n) {
    return {
      type: 'box',
      layout: 'horizontal',
      paddingAll: '8px',
      backgroundColor: n % 2 ? '#ffffff' : P.tint,
      contents: r.map(function (v, i) {
        return cell(v, i, i === 0 ? { color: P.ink, weight: 'bold' } : undefined)
      }),
    }
  })

  return {
    type: 'box',
    layout: 'vertical',
    margin: 'lg',
    cornerRadius: '8px',
    borderColor: P.line,
    borderWidth: '1px',
    contents: [headRow].concat(bodyRows),
  }
}

/** กล่องข้อสังเกต สีตามระดับ */
function note_(message, level) {
  const t = tone_(level || 'warn')
  return {
    type: 'box',
    layout: 'vertical',
    margin: 'lg',
    paddingAll: '10px',
    cornerRadius: '8px',
    backgroundColor: '#ffffff',
    borderColor: t.color,
    borderWidth: '1px',
    contents: [text_(t.icon + '  ' + message, { size: 'xxs', color: t.color, wrap: true })],
  }
}

function buttons_(items) {
  return {
    type: 'box',
    layout: 'vertical',
    spacing: 'sm',
    margin: 'lg',
    contents: items.map(function (b, i) {
      return {
        type: 'button',
        height: 'sm',
        style: i === 0 ? 'primary' : 'secondary',
        color: i === 0 ? P.main : undefined,
        action: { type: 'uri', label: b.label, uri: b.url },
      }
    }),
  }
}

/* ================================================================
 *  3) ประกอบการ์ด
 * ================================================================ */

/**
 * buildCard({
 *   title, subtitle, icon, heroUrl,
 *   level: 'ok' | 'warn' | 'bad' | 'info',
 *   status: 'ข้อความสรุปหนึ่งบรรทัด',
 *   chips: [{ label, color, filled }],
 *   sections: [{ title, accent, rows: [[ป้าย, ค่า, สี, ตัวหนา]] }],
 *   table: { head: [...], rows: [[...]], flexes: [...] },
 *   notes: [{ text, level }],
 *   buttons: [{ label, url }],
 *   footer: 'ข้อความท้ายการ์ด',
 * })
 */
function buildCard(opts) {
  const body = [rainbow_()]

  if (opts.status) body.push(statusBar_(opts.status, opts.level))
  if (opts.chips && opts.chips.length) body.push(chipRow_(opts.chips))

  const sections = opts.sections || []
  sections.forEach(function (s) {
    body.push(section_(s.title, s.rows || [], s.accent))
  })

  if (opts.table && opts.table.rows && opts.table.rows.length) {
    body.push(table_(opts.table.head, opts.table.rows, opts.table.flexes))
  }

  const notes = opts.notes || []
  notes.forEach(function (n) {
    body.push(note_(n.text, n.level))
  })

  if (opts.buttons && opts.buttons.length) body.push(buttons_(opts.buttons))

  const stamp = thaiStamp_(new Date(), true)

  const bubble = compact_({
    type: 'bubble',
    size: 'mega',
    header: header_(opts.title, opts.subtitle, opts.icon),
    hero: opts.heroUrl
      ? {
          type: 'image',
          url: opts.heroUrl,
          size: 'full',
          aspectRatio: '20:9',
          aspectMode: 'cover',
        }
      : undefined,
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      paddingTop: '0px',
      contents: body,
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      backgroundColor: P.tint,
      contents: [
        text_((opts.footer ? opts.footer + '  ·  ' : '') + stamp, {
          size: 'xxs',
          color: P.muted,
          align: 'center',
          wrap: true,
        }),
      ],
    },
  })

  // altText คือสิ่งที่โผล่ใน notification bar และบนเครื่องที่แสดงการ์ดไม่ได้ จำกัด 400 ตัว
  const alt = (opts.title + (opts.status ? ' — ' + opts.status : '')).slice(0, 380)

  return { type: 'flex', altText: alt, contents: bubble }
}

/* ================================================================
 *  4) ส่งออก
 * ================================================================ */

/** ปลายทางเป็นกลุ่มที่มีคนอ่านหลายคน ตัดเลข 13 หลักทิ้งก่อนเสมอ กันเลขบัตรหลุด */
function scrub_(value) {
  if (typeof value === 'string') return value.replace(/\d{13}/g, 'xxxxxxxxxxxxx')
  if (Array.isArray(value)) return value.map(scrub_)
  if (value && typeof value === 'object') {
    const out = {}
    Object.keys(value).forEach(function (k) {
      out[k] = scrub_(value[k])
    })
    return out
  }
  return value
}

/**
 * วันเวลาแบบไทย พ.ศ.
 *
 * formatDate ให้ ค.ศ. อย่างเดียว จึงบวก 543 แล้วยัดเลขปีลงไปในรูปแบบเลย
 * ตัวเลขไม่ใช่อักษรควบคุมของ formatDate มันจึงผ่านออกมาตรง ๆ ไม่ถูกตีความ
 */
function thaiStamp_(date, withTime) {
  const year = Number(Utilities.formatDate(date, 'Asia/Bangkok', 'yyyy')) + 543
  if (!withTime) return Utilities.formatDate(date, 'Asia/Bangkok', 'd/M/' + year)
  return Utilities.formatDate(date, 'Asia/Bangkok', 'd/M/' + year + ' HH:mm') + ' น.'
}

function bytes_(value) {
  return Utilities.newBlob(JSON.stringify(value)).getBytes().length
}

/** ส่งการ์ด (ใบเดียวหรือหลายใบ) — คืน HTTP status */
function notify(cards) {
  return send_(Array.isArray(cards) ? cards : [cards])
}

/** ส่งข้อความล้วน — เรื่องด่วนใช้อันนี้ ถึงเร็วกว่าการ์ดมาก */
function notifyText(message) {
  return send_([{ type: 'text', text: String(message).slice(0, 4000) }])
}

const MAX_BYTES = 10 * 1024

function send_(messages) {
  const props = PropertiesService.getScriptProperties()
  const payloadMessages = scrub_(messages).slice(0, 5)

  payloadMessages.forEach(function (m, i) {
    // ปลายทางนับเป็นไบต์ ไม่ใช่ตัวอักษร ภาษาไทยตัวละ 3 ไบต์ — ต้องวัดของจริง
    const size = bytes_(m)
    if (size > MAX_BYTES) {
      throw new Error(
        'ข้อความที่ ' +
          (i + 1) +
          ' ใหญ่ ' +
          size +
          ' ไบต์ เกินเพดาน ' +
          MAX_BYTES +
          ' — ตัดข้อความในการ์ดออก หรือแยกเป็นหลายการ์ด'
      )
    }
  })

  const res = UrlFetchApp.fetch(need_(props, 'MOPH_BASE_URL').replace(/\/+$/, '') + '/api/notify/send', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'client-key': need_(props, 'MOPH_CLIENT_KEY'),
      'secret-key': need_(props, 'MOPH_SECRET_KEY'),
    },
    payload: JSON.stringify({ messages: payloadMessages }),
    muteHttpExceptions: true,
  })

  const code = res.getResponseCode()
  const body = res.getContentText()
  console.log('MOPH Notify → HTTP ' + code + ' ' + body)

  // โยน error เพื่อให้ trigger ส่งอีเมลแจ้งเมื่อพัง ไม่งั้นจะเงียบหายไปเฉย ๆ
  if (code >= 300) throw new Error('ส่งไม่สำเร็จ HTTP ' + code + ' — ' + body)
  return code
}

function need_(props, key) {
  const value = props.getProperty(key)
  if (!value) throw new Error('ยังไม่ได้ตั้งค่า ' + key + ' ที่ Project Settings → Script Properties')
  return value
}

/**
 * ตรวจว่าคีย์ใช้ได้ไหม โดยไม่ให้มีข้อความโผล่ในกลุ่ม
 *
 * ยิงคำขอที่ไม่มี messages ไป ปลายทางตรวจคีย์ก่อนตรวจเนื้อข้อความ
 *   "require messages" → คีย์ถูก (ผ่านด่านมาแล้วถึงมาบ่นว่าไม่ได้ส่งอะไรมา)
 *   "Unauthorized"     → คีย์ผิด หรือใส่ URL ของ MOPH Alert (t2c) แทน Notify (t2f)
 * ไม่มีอะไรถูกส่งเข้ากลุ่มทั้งสองกรณี
 */
function verifyKeys() {
  const props = PropertiesService.getScriptProperties()
  const res = UrlFetchApp.fetch(need_(props, 'MOPH_BASE_URL').replace(/\/+$/, '') + '/api/notify/send', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'client-key': need_(props, 'MOPH_CLIENT_KEY'),
      'secret-key': need_(props, 'MOPH_SECRET_KEY'),
    },
    payload: '{}',
    muteHttpExceptions: true,
  })

  const body = res.getContentText()
  console.log('HTTP ' + res.getResponseCode() + ' ' + body)

  if (/require messages/i.test(body)) {
    console.log('✓ คีย์ใช้งานได้ ตั้งค่าครบแล้ว')
    return true
  }
  if (/unauthorized/i.test(body) || res.getResponseCode() === 401) {
    console.log('✕ คีย์ไม่ผ่าน — ตรวจว่า MOPH_BASE_URL เป็น morpromt2f (Notify) ไม่ใช่ t2c (Alert)')
    return false
  }
  console.log('? ปลายทางตอบมาแบบที่ไม่รู้จัก อ่านข้อความข้างบนประกอบ')
  return false
}

/**
 * พิมพ์ JSON ของการ์ดลง log โดยไม่ส่ง
 * เอาไปวางที่ developers.line.biz/flex-simulator เพื่อดูหน้าตาและปรับสีก่อนส่งจริง
 */
function preview(card) {
  const json = JSON.stringify(card.contents, null, 2)
  console.log(json)
  console.log('ขนาด ' + bytes_(card) + ' ไบต์')
  return json
}
