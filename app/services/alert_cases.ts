/**
 * เคสการแจ้งเตือน 4 แบบตามที่ MOPH Alert Template v3.1 รองรับ
 *
 * เอกสารแบ่งเป็น 6 แบบ แต่แบบ 2/3 และ 5/6 ใช้ค่า `template` เดียวกัน
 * ต่างกันแค่มี url ตรวจสอบคิวหรือไม่ ที่นี่จึงรวมเป็นเคสเดียวแล้วให้ url
 * เป็นตัวตัดสิน — ใส่ url = ได้การ์ดที่มีปุ่ม, เว้นว่าง = ไม่มีปุ่ม
 */

export type PlaceholderKey = 'name' | 'queue_no' | 'queue_waiting' | 'hn_no' | 'service' | 'url'

export const PLACEHOLDER_LABELS: Record<PlaceholderKey, string> = {
  name: 'คำนำหน้า ชื่อ นามสกุล',
  queue_no: 'เลขคิว',
  queue_waiting: 'จำนวนคิวที่รออยู่ข้างหน้า',
  hn_no: 'หมายเลข HN',
  service: 'ชื่อห้องตรวจ/แผนก',
  url: 'ลิงก์ตรวจสอบคิว',
}

export type AlertCaseKey = 'welcome' | 'queue_notify' | 'queue_near' | 'queue_changed'

export type AlertCase = {
  label: string
  description: string
  /** ค่าที่ส่งไปใน field `template` ต้องตรงตัวอักษรเป๊ะ ปลายทางใช้ match */
  mophTemplate: string
  placeholders: PlaceholderKey[]
  supportsUrl: boolean
  defaults: {
    header: string
    lineText: string
    messageTitle: string
    messageHtml: string
    messageText: string
  }
}

export const ALERT_CASES: Record<AlertCaseKey, AlertCase> = {
  welcome: {
    label: 'ยินดีต้อนรับ',
    description: 'ส่งตอนผู้ป่วยลงทะเบียนเข้ารับบริการครั้งแรกของวัน',
    mophTemplate: 'ยินดีต้อนรับ',
    placeholders: ['name'],
    supportsUrl: false,
    defaults: {
      header: 'ยินดีต้อนรับ',
      lineText:
        'สวัสดีคุณ {name} ยินดีต้อนรับเข้าสู่บริการของโรงพยาบาล หากมีข้อสงสัยสอบถามเจ้าหน้าที่ได้เลย',
      messageTitle: 'ยินดีต้อนรับ',
      messageHtml:
        '<div><strong>สวัสดีคุณ {name} ยินดีต้อนรับเข้าสู่บริการของโรงพยาบาล</strong></div>',
      messageText: 'ยินดีต้อนรับ',
    },
  },

  queue_notify: {
    label: 'แจ้งเตือนคิว',
    description: 'ส่งตอนผู้ป่วยได้รับคิว',
    mophTemplate: 'แจ้งเตือนคิว',
    placeholders: ['name', 'queue_no', 'hn_no', 'service', 'url'],
    supportsUrl: true,
    defaults: {
      header: 'แจ้งเตือนคิว',
      lineText: 'คิวที่ {queue_no} บริการ {service}',
      messageTitle: 'แจ้งเตือนคิว',
      messageHtml: '<div><strong>คิวที่ {queue_no} บริการ {service}</strong></div>',
      messageText: 'แจ้งเตือนคิว',
    },
  },

  queue_near: {
    label: 'ใกล้ถึงคิวของคุณแล้ว',
    description: 'ส่งเมื่อจำนวนคิวที่รออยู่ข้างหน้าเหลือน้อยกว่าที่กำหนด',
    mophTemplate: 'ใกล้ถึงคิวของคุณแล้ว',
    placeholders: ['name', 'queue_no', 'queue_waiting', 'hn_no', 'service', 'url'],
    supportsUrl: true,
    defaults: {
      header: 'ใกล้ถึงคิวของคุณแล้ว',
      lineText: 'รออีก {queue_waiting} คิว คิวที่ {queue_no} บริการ {service}',
      messageTitle: 'ใกล้ถึงคิวของคุณแล้ว',
      messageHtml:
        '<div><strong>รออีก {queue_waiting} คิว คิวที่ {queue_no} บริการ {service}</strong></div>',
      messageText: 'ใกล้ถึงคิวของคุณแล้ว',
    },
  },

  queue_changed: {
    label: 'คิวของท่านมีการเปลี่ยนแปลง',
    description: 'ส่งเมื่อเลขคิวหรือห้องตรวจเปลี่ยน',
    mophTemplate: 'คิวของท่านมีการเปลี่ยนแปลง',
    placeholders: ['name', 'queue_no', 'queue_waiting', 'hn_no', 'service', 'url'],
    supportsUrl: true,
    defaults: {
      header: 'คิวของท่านมีการเปลี่ยนแปลง',
      lineText: 'คิวของท่านมีการเปลี่ยนแปลง คิวที่ {queue_no} บริการ {service}',
      messageTitle: 'คิวของท่านมีการเปลี่ยนแปลง',
      messageHtml:
        '<div><strong>คิวของท่านมีการเปลี่ยนแปลง คิวที่ {queue_no} บริการ {service}</strong></div>',
      messageText: 'คิวของท่านมีการเปลี่ยนแปลง',
    },
  },
}

export const ALERT_CASE_KEYS = Object.keys(ALERT_CASES) as AlertCaseKey[]

/** ค่าตัวอย่างสำหรับพรีวิวและหน้าทดสอบ */
export const SAMPLE_VALUES: Record<PlaceholderKey, string> = {
  name: 'นางสมศรี ใจดี',
  queue_no: '01-A001',
  queue_waiting: '3',
  hn_no: '065-088698',
  service: 'แผนกอายุรกรรม ห้องตรวจ 2',
  url: '',
}

/**
 * แทนค่า {placeholder} ในข้อความ
 *
 * ตัวยึดที่ไม่รู้จักจะถูกทิ้งไว้ตามเดิม ไม่ลบทิ้งเงียบ ๆ
 * เพื่อให้เห็นตอนพรีวิวว่าพิมพ์ชื่อตัวแปรผิด
 */
export function renderTemplate(text: string, values: Partial<Record<PlaceholderKey, string>>) {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key as PlaceholderKey]
    return value === undefined ? match : value
  })
}

/** หา placeholder ที่ใช้ในข้อความแต่เคสนี้ไม่รองรับ */
export function unknownPlaceholders(text: string, allowed: PlaceholderKey[]) {
  const used = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
  return [...new Set(used.filter((k) => !allowed.includes(k as PlaceholderKey)))]
}
