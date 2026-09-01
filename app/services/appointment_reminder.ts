import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'

import AppointmentSetting from '#models/appointment'
import { withHosxp } from '#services/hosxp_session'

/**
 * แจ้งเตือนล่วงหน้าว่าพรุ่งนี้มีนัด ผ่านหมอพร้อม
 *
 * ต่างจากแจ้งเตือนคิวตรงจังหวะ — คิวเป็นเหตุการณ์ที่เกิดแล้วต้องรีบบอก
 * ส่วนนัดหมายเป็นรอบวันละครั้ง จึงอยู่กับ notify:watch ไม่ใช่ queue:watch
 *
 * ตัวนี้ทำหน้าที่ "ตั้งคิวข้อความ" อย่างเดียว ไม่ได้ส่งเอง — เขียนลงตาราง
 * notifications แล้วปล่อยให้ตัวส่งเดิมของ queue:watch จัดการ จะได้ใช้
 * dry run ช่วงงดส่ง การนับ attempt หน้าบันทึกการส่ง และปุ่มส่งใหม่ร่วมกัน
 * โดยไม่ต้องเขียนซ้ำ
 *
 * ⚠️ ต้องมี queue:watch รันอยู่ด้วย ไม่งั้นข้อความจะค้างเป็น pending
 */

/** ไม่หยิบ cid มาด้วยเด็ดขาด ตัวส่งจะไปอ่านสด ๆ ตอนจะส่งจริง */
const SELECT_APPOINTMENTS = `
  SELECT o.oapp_id, o.hn, o.nextdate, o.nexttime,
         o.clinic, cl.name AS clinic_name,
         p.pname, p.fname, p.lname
    FROM oapp o
    LEFT JOIN clinic cl ON cl.clinic = o.clinic
    LEFT JOIN patient p ON p.hn = o.hn
`

export type AppointmentRow = {
  oapp_id: number
  hn: string
  nextdate: string | Date
  nexttime: string | null
  clinic: string | null
  clinic_name: string | null
  pname: string | null
  fname: string | null
  lname: string | null
}

export type AppointmentTickResult = {
  scanned: number
  queued: number
  skipped: number
  note?: string
}

const THAI_MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
]

/** ๒ ก.ย. ๒๕๖๙ → "2 กันยายน 2569" — ผู้ป่วยอ่าน พ.ศ. */
export function thaiFullDate(iso: string) {
  const d = DateTime.fromISO(iso)
  if (!d.isValid) return iso
  return `${d.day} ${THAI_MONTHS[d.month - 1]} ${d.year + 543}`
}

/**
 * HOSxP ใช้ 00:00:01 เป็นค่าสมมติว่า "ไม่ได้ระบุเวลา" ไม่ใช่เที่ยงคืนจริง
 * ปล่อยผ่านแล้วผู้ป่วยจะได้ข้อความว่านัดเวลา 00:00 น.
 */
export function timeLabel(raw: string | null): string | null {
  if (!raw) return null
  const [h, m] = raw.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  if (h === 0) return null
  return `${String(h).padStart(2, '0')}.${String(m).padStart(2, '0')} น.`
}

export function fullName(row: Pick<AppointmentRow, 'pname' | 'fname' | 'lname'>) {
  const name = `${row.pname ?? ''}${row.fname ?? ''} ${row.lname ?? ''}`.trim()
  return name || 'ผู้รับบริการ'
}

export const DEFAULT_TEXT = 'คุณ{name} มีนัดพบแพทย์วันที่ {date} {time} ที่ {clinic} กรุณามาตามนัด'

export const DEFAULT_HTML =
  '<div><strong>แจ้งเตือนนัดหมาย</strong></div>' +
  '<div>คุณ{name}</div>' +
  '<div>วันที่ {date} {time}</div>' +
  '<div>แผนก {clinic}</div>' +
  '<div>กรุณามาตามนัด หากมาไม่ได้กรุณาแจ้งเจ้าหน้าที่ล่วงหน้า</div>'

export const PLACEHOLDERS = ['name', 'date', 'time', 'clinic', 'hn'] as const

export function fillTemplate(text: string, values: Record<string, string>) {
  return (
    text
      // จับทุกอย่างในวงเล็บปีกกา ไม่ใช่แค่ \w — ไม่งั้นถ้าเจ้าหน้าที่พิมพ์ {ชื่อ}
      // เป็นภาษาไทย ตัวยึดจะหลุดไปถึงผู้ป่วยทั้งวงเล็บ
      .replace(/\{([^}]+)\}/g, (_, key: string) => values[key.trim()] ?? '')
      // ตัวยึดที่ว่าง เช่น {time} ตอนไม่ระบุเวลา ทิ้งช่องว่างซ้อนไว้
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  )
}

export class AppointmentReminder {
  /**
   * ถึงเวลาส่งของวันนี้หรือยัง และวันนี้ส่งไปแล้วหรือยัง
   *
   * เทียบเป็นเวลาไทยเสมอ ไม่พึ่ง TZ ของเครื่อง
   */
  #isDue(settings: AppointmentSetting, now: DateTime) {
    const [h, m] = settings.sendAt.split(':').map(Number)
    if (!Number.isFinite(h) || !Number.isFinite(m)) return false

    const dueAt = now.set({ hour: h, minute: m, second: 0, millisecond: 0 })
    if (now < dueAt) return false

    const today = now.toISODate()
    return settings.lastRunDate?.toISODate() !== today
  }

  async tick(): Promise<AppointmentTickResult> {
    const empty: AppointmentTickResult = { scanned: 0, queued: 0, skipped: 0 }
    const settings = await AppointmentSetting.current()

    if (!settings.isEnabled) return { ...empty, note: 'ปิดใช้งานอยู่' }

    const now = DateTime.now().setZone('Asia/Bangkok')
    if (!this.#isDue(settings, now)) return empty

    return this.runNow(settings, now)
  }

  /**
   * ทำรอบส่งทันทีโดยไม่สนว่าถึงเวลาที่ตั้งไว้หรือยัง
   *
   * ใช้ทั้งจากรอบอัตโนมัติและจากปุ่มสั่งส่งในหน้าเว็บ ตรรกะเดียวกันทุกอย่าง
   * รวมถึง dry run การกรองคลินิก และการกันส่งซ้ำด้วย dedup_key
   */
  async runNow(settings: AppointmentSetting, now = DateTime.now().setZone('Asia/Bangkok')) {
    const empty: AppointmentTickResult = { scanned: 0, queued: 0, skipped: 0 }
    const target = now.plus({ days: Math.max(settings.daysAhead, 0) }).toISODate()!
    const rows = await this.fetch(target).catch(() => null)

    if (rows === null) return { ...empty, note: 'อ่านนัดหมายจาก HOSxP ไม่ได้' }

    const result = await this.queueAll(rows, settings, target)

    // บันทึกว่าวันนี้รันแล้ว แม้จะไม่มีนัดเลย ไม่งั้นจะวนตรวจซ้ำทุกนาทีจนหมดวัน
    settings.merge({
      lastRunDate: now.startOf('day'),
      lastRunAt: now,
      lastRunNote: `นัดวันที่ ${target} · ${result.scanned} ราย · ตั้งคิว ${result.queued} · ข้าม ${result.skipped}`,
    })
    await settings.save()

    return { ...result, target }
  }

  /** อ่านนัดของวันที่ระบุ คืน null เมื่อต่อ HOSxP ไม่ได้ */
  async fetch(isoDate: string, limit = 1000) {
    return withHosxp((client) =>
      client.select<AppointmentRow>(
        `${SELECT_APPOINTMENTS} WHERE o.nextdate = ? ORDER BY o.oapp_id LIMIT ?`,
        [isoDate, limit]
      )
    )
  }

  /** รายชื่อคลินิกที่มีนัดจริงในช่วงข้างหน้า เอาไว้ให้เลือกในหน้าตั้งค่า */
  async clinics(daysAhead = 60) {
    return withHosxp((client) =>
      client.select<{ clinic: string; name: string; n: number }>(
        `SELECT o.clinic, COALESCE(cl.name, o.clinic) AS name, COUNT(*) AS n
           FROM oapp o
           LEFT JOIN clinic cl ON cl.clinic = o.clinic
          WHERE o.nextdate BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
          GROUP BY o.clinic, cl.name
          ORDER BY n DESC`,
        [daysAhead]
      )
    )
  }

  /** ประกอบข้อความของนัดหนึ่งรายการ */
  build(row: AppointmentRow, settings: AppointmentSetting, isoDate: string) {
    const time = timeLabel(row.nexttime)
    const values: Record<string, string> = {
      name: fullName(row),
      date: thaiFullDate(isoDate),
      time: time ? `เวลา ${time}` : '',
      clinic: row.clinic_name?.trim() || 'โรงพยาบาล',
      hn: row.hn,
    }

    return {
      title: fillTemplate(settings.messageTitle || 'แจ้งเตือนนัดหมาย', values),
      text: fillTemplate(settings.messageText || DEFAULT_TEXT, values),
      html: fillTemplate(settings.messageHtml || DEFAULT_HTML, values),
    }
  }

  /**
   * เขียนลงคิวข้อความ — dedup_key กันซ้ำที่ระดับฐานข้อมูล
   * รันซ้ำกี่รอบผู้ป่วยก็ได้ข้อความเดียว
   */
  async queueAll(rows: AppointmentRow[], settings: AppointmentSetting, isoDate: string) {
    const result: AppointmentTickResult = { scanned: rows.length, queued: 0, skipped: 0 }

    for (const row of rows) {
      if (!settings.watches(row.clinic)) {
        result.skipped++
        continue
      }

      const message = this.build(row, settings, isoDate)

      // payload ไม่มี cid ตัวส่งจะไปอ่านสดจาก HOSxP เอง
      const payload = {
        message_title: message.title,
        message_text: message.text,
        message_html: message.html,
      }

      // dry run ของนัดหมายต้องตัดจบตั้งแต่ตรงนี้
      //
      // ตัวส่งใน queue:watch อ่าน dryRun ของ PollerSetting เท่านั้น ไม่รู้จักของนัดหมาย
      // ถ้าเขียนเป็น pending ทั้งที่ตั้ง dry run ไว้ โรงพยาบาลที่ปิด dry run ของคิวไปแล้ว
      // (คือทุกที่ที่ใช้งานจริง) จะส่งถึงผู้ป่วยทันที ตรงข้ามกับที่ผู้ตั้งค่าสั่งไว้
      const status = settings.dryRun ? 'skipped' : 'pending'
      const note = settings.dryRun ? 'DRY RUN — ไม่ได้ส่งจริง' : null

      const inserted = await db.rawQuery(
        `INSERT IGNORE INTO notifications
           (dedup_key, vn, hn, case_key, dep, depq, payload, status, attempts,
            last_error, created_at, updated_at)
         VALUES (?, ?, ?, 'appointment', ?, NULL, ?, ?, 0, ?, NOW(), NOW())`,
        [
          `oapp:${row.oapp_id}`,
          `oapp:${row.oapp_id}`,
          row.hn,
          row.clinic,
          JSON.stringify(payload),
          status,
          note,
        ]
      )

      // INSERT IGNORE ที่ชนกับ dedup_key เดิมจะได้ affectedRows = 0
      if (inserted?.[0]?.affectedRows) result.queued++
      else result.skipped++
    }

    return result
  }
}
