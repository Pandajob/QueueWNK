import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'

import { CdcuSetting, NotifyGroup } from '#models/notify_system'
import { Watermark } from '#models/poller_models'
import type { HosxpClient } from '#services/hosxp_client'
import { withHosxp } from '#services/hosxp_session'
import { dispatch } from '#services/notify_dispatcher'

/** จำว่าอ่านทะเบียน 506 ถึงเลขไหนแล้ว */
const WATERMARK_KEY = 'cdcu:last_sv_number'

/** เวลาที่ส่งข้อความ CDCU ล่าสุด ใช้คุม throttle */
const LAST_SENT_KEY = 'cdcu:last_sent_at'

/** อ่านทีละไม่เกินเท่านี้ กันกรณีมีคนคีย์ย้อนหลังทีเดียวเป็นร้อยเคส */
const BATCH = 100

export type SurveilRow = {
  sv_number: number
  hn: string | null
  code506: number | null
  disease_name: string | null
  pdx: string | null
  report_date: string | null
  vstdate: string | null
  ptstat: string | null
  status_name: string | null
  moo: string | null
  tambon: string | null
  department: string | null
  last_update: string | null
  pname: string | null
  fname: string | null
  lname: string | null
  mobile_phone: string | null
  home_phone: string | null
}

/**
 * ทะเบียน 506 ของ HOSxP อยู่ที่ `surveil_member`
 *
 * `sv_number` เป็น int PK ที่เพิ่มขึ้นเรื่อย ๆ จึงใช้เป็น watermark ได้ตรง ๆ
 * ต่างจากคิวที่ต้องสแกนทั้งวันทุกรอบ เพราะเคส 506 คือ "แถวใหม่" จริง ๆ
 * ไม่ใช่การขยับสถานะบนแถวเดิม
 *
 * `codetype = '3'` ใน thaiaddress คือระดับตำบล (1 = จังหวัด, 2 = อำเภอ)
 *
 * `surveil_member` ไม่มีชื่อผู้ป่วย มีแต่ hn กับ cid จึงต้อง join `patient`
 * เอาชื่อกับเบอร์โทรมา — เลือกเป็นคอลัมน์ ๆ ไม่หยิบ `s.cid` มาด้วยเด็ดขาด
 */
const SELECT_CASES = `
  SELECT s.sv_number, s.hn, s.code506, n.name AS disease_name, s.pdx,
         s.report_date, s.vstdate, s.ptstat, r.name AS status_name,
         s.moo, a.name AS tambon, s.department, s.last_update,
         p.pname, p.fname, p.lname,
         p.mobile_phone_number AS mobile_phone, p.hometel AS home_phone
    FROM surveil_member s
    LEFT JOIN name506 n ON n.code = s.code506
    LEFT JOIN report506status r ON r.code = s.ptstat
    LEFT JOIN patient p ON p.hn = s.hn
    LEFT JOIN thaiaddress a
           ON a.chwpart = s.chwpart AND a.amppart = s.amppart
          AND a.tmbpart = s.tmbpart AND a.codetype = '3'
`

/** ข้อมูลที่ระบุตัวผู้ป่วยได้ ส่วนไหนยอมให้ออกนอกระบบบ้าง */
export type CdcuReveal = {
  includeHn: boolean
  includeName: boolean
  includePhone: boolean
}

export function revealOf(settings: CdcuSetting): CdcuReveal {
  return {
    includeHn: settings.includeHn,
    includeName: settings.includeName,
    includePhone: settings.includePhone,
  }
}

/** `pname` ของ HOSxP ต่อกับชื่อโดยไม่เว้นวรรค เช่น "นาย" + "สมชาย" */
export function fullName(row: Pick<SurveilRow, 'pname' | 'fname' | 'lname'>) {
  const name = [row.fname, row.lname]
    .map((value) => (value ?? '').trim())
    .filter(Boolean)
    .join(' ')

  if (!name) return ''
  return `${(row.pname ?? '').trim()}${name}`
}

/**
 * เบอร์มือถือมาก่อนเบอร์บ้าน เคสระบาดต้องโทรตามให้ติดตั้งแต่รอบแรก
 * บางแถวคีย์มาหลายเบอร์คั่นด้วยจุลภาค เอาเบอร์แรกพอ
 */
export function phoneOf(row: Pick<SurveilRow, 'mobile_phone' | 'home_phone'>) {
  const raw = (row.mobile_phone ?? '').trim() || (row.home_phone ?? '').trim()
  if (!raw) return ''
  return raw.split(/[,;/]/)[0].trim().slice(0, 20)
}

export type CdcuTickResult = {
  scanned: number
  matched: number
  sent: number
  note?: string
}

export class CdcuWatcher {
  /** เคสล่าสุดสำหรับแสดงในหน้าเว็บ — ไม่เกี่ยวกับการแจ้งเตือน */
  async recentCases(days = 30, limit = 100) {
    return withHosxp((client) =>
      client.select<SurveilRow>(
        `${SELECT_CASES}
          WHERE s.report_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
          ORDER BY s.sv_number DESC
          LIMIT ?`,
        [days, limit]
      )
    )
  }

  /**
   * เคสตามช่วงวันที่รายงาน ใช้ตอนย้อนดู/ย้อนส่งช่วงที่ระบบยังไม่ได้เฝ้า
   *
   * เรียงจากเก่าไปใหม่ตาม sv_number ให้เหมือนลำดับที่ตัวเฝ้าระวังเจอของจริง
   */
  async casesBetween(from: string, to: string, limit = 200) {
    return withHosxp((client) =>
      client.select<SurveilRow>(
        `${SELECT_CASES}
          WHERE s.report_date BETWEEN ? AND ?
          ORDER BY s.sv_number
          LIMIT ?`,
        [from, to, limit]
      )
    )
  }

  /** สรุปรายโรคในช่วงที่ผ่านมา ใช้ทำแดชบอร์ดหน้า CDCU */
  async summaryByDisease(days = 30) {
    return withHosxp((client) =>
      client.select<{ code506: number; disease_name: string | null; cases: number }>(
        `SELECT s.code506, n.name AS disease_name, COUNT(*) AS cases
           FROM surveil_member s
           LEFT JOIN name506 n ON n.code = s.code506
          WHERE s.report_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
          GROUP BY s.code506, n.name
          ORDER BY cases DESC
          LIMIT 30`,
        [days]
      )
    )
  }

  /** รายชื่อโรคทั้งหมดในระบบ ใช้ให้เลือกว่าจะเฝ้าโรคไหน */
  async diseases() {
    return withHosxp((client) =>
      client.select<{ code: number; name: string }>(
        `SELECT code, name FROM name506 ORDER BY code506`
      )
    )
  }

  /** ตรวจรอบเดียว */
  async tick(): Promise<CdcuTickResult> {
    const empty: CdcuTickResult = { scanned: 0, matched: 0, sent: 0 }

    const settings = await CdcuSetting.current()
    if (!settings.isEnabled) return { ...empty, note: 'ปิดการเฝ้าระวังอยู่' }
    if (!settings.groupId) return { ...empty, note: 'ยังไม่ได้เลือกกลุ่ม LINE' }

    // อยู่ในช่วงงดส่ง — ไม่ขยับ watermark เลย รอบหลังจะเห็นเคสเดิมครบ
    if (settings.isQuietNow()) return { ...empty, note: 'อยู่ในช่วงงดส่ง' }

    const result = await withHosxp(async (client) => this.#scan(client, settings))
    return result ?? { ...empty, note: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ HOSxP' }
  }

  async #scan(client: HosxpClient, settings: CdcuSetting): Promise<CdcuTickResult> {
    const last = await Watermark.get(WATERMARK_KEY)

    // รอบแรกให้ตั้งหลักที่เคสล่าสุด ไม่งั้นจะยิงทะเบียนย้อนหลังหมื่นกว่าเคสเข้ากลุ่มรวดเดียว
    if (last === null) {
      const [row] = await client.select<{ max_sv: number | null }>(
        `SELECT MAX(sv_number) AS max_sv FROM surveil_member`
      )
      const baseline = String(row?.max_sv ?? 0)
      await Watermark.set(WATERMARK_KEY, baseline)

      logger.info({ baseline }, 'CDCU — ตั้งหลักที่เคสล่าสุด จะแจ้งเฉพาะเคสที่เข้ามาหลังจากนี้')
      return { scanned: 0, matched: 0, sent: 0, note: 'ตั้งหลักครั้งแรก' }
    }

    const rows = await client.select<SurveilRow>(
      `${SELECT_CASES}
        WHERE s.sv_number > ?
        ORDER BY s.sv_number
        LIMIT ${BATCH}`,
      [Number(last)]
    )

    if (!rows.length) return { scanned: 0, matched: 0, sent: 0 }

    const fresh: SurveilRow[] = []
    for (const row of rows) {
      if (await this.#markSeen(row)) fresh.push(row)
    }

    const matched = fresh.filter((row) => settings.watches(row.code506))

    let sent = 0
    if (matched.length && !(await this.#throttled(settings))) {
      const group = await NotifyGroup.find(settings.groupId!)

      if (group) {
        const outcome = await dispatch({
          groups: [group],
          body: this.buildMessage(matched, revealOf(settings)),
          source: 'cdcu',
          subject: `เคส 506 ใหม่ ${matched.length} ราย`,
        })
        sent = outcome.sent

        if (outcome.sent) await Watermark.set(LAST_SENT_KEY, DateTime.now().toISO()!)
      }
    }

    // ขยับ watermark หลังบันทึก cdcu_seen แล้วเท่านั้น
    await Watermark.set(WATERMARK_KEY, String(rows[rows.length - 1].sv_number))

    return { scanned: rows.length, matched: matched.length, sent }
  }

  /** true = เพิ่งเห็นครั้งแรก */
  async #markSeen(row: SurveilRow) {
    const result = await db.rawQuery(
      `INSERT INTO cdcu_seen (sv_number, code506, disease_name, report_date, notified, created_at)
       VALUES (?, ?, ?, ?, 0, NOW())
       ON DUPLICATE KEY UPDATE sv_number = sv_number`,
      [row.sv_number, row.code506, row.disease_name?.slice(0, 255) ?? null, row.report_date]
    )

    const header = Array.isArray(result) ? result[0] : result
    return (header?.affectedRows ?? 0) === 1
  }

  async #throttled(settings: CdcuSetting) {
    const last = await Watermark.get(LAST_SENT_KEY)
    if (!last) return false

    const elapsed = DateTime.now().diff(DateTime.fromISO(last), 'minutes').minutes
    return elapsed < settings.throttleMinutes
  }

  /**
   * ข้อความที่จะเข้ากลุ่ม
   *
   * ทุกอย่างที่ระบุตัวผู้ป่วยได้เป็นตัวเลือกที่ต้องเปิดเอง — ชื่อ HN เบอร์โทร
   * เปิดเมื่อกลุ่มปลายทางมีแต่คนที่มีสิทธิ์เข้าถึงข้อมูลผู้ป่วยเท่านั้น
   *
   * เลขบัตรประชาชนไม่มีทางหลุด ไม่ได้ดึงมาตั้งแต่ชั้น SQL ทั้งที่ surveil_member
   * มีคอลัมน์ cid อยู่ และ dispatcher ยังตัดเลข 13 หลักทิ้งซ้ำอีกชั้น
   */
  buildMessage(rows: SurveilRow[], reveal: CdcuReveal) {
    const now = DateTime.now().setZone('Asia/Bangkok')
    const header =
      `🦠 เคสเฝ้าระวังโรค (506) ใหม่ ${rows.length} ราย\n` +
      `${now.toFormat('dd/MM')}/${now.year + 543} ${now.toFormat('HH:mm')}`

    const byDisease = new Map<string, SurveilRow[]>()
    for (const row of rows) {
      const key = row.disease_name ?? `รหัส ${row.code506 ?? '-'}`
      byDisease.set(key, [...(byDisease.get(key) ?? []), row])
    }

    const blocks = [...byDisease.entries()].map(([disease, list]) => {
      const lines = list.map((row) => {
        const where = [row.tambon ? `ต.${row.tambon}` : null, row.moo ? `ม.${row.moo}` : null]
          .filter(Boolean)
          .join(' ')

        const phone = phoneOf(row)

        return (
          '  • ' +
          [
            reveal.includeName ? fullName(row) : null,
            reveal.includeHn && row.hn ? `HN ${row.hn}` : null,
            reveal.includePhone && phone ? `☎ ${phone}` : null,
            where || null,
            row.department,
            row.status_name,
          ]
            .filter(Boolean)
            .join(' · ')
        )
      })

      return `\n${disease} — ${list.length} ราย\n${lines.join('\n')}`
    })

    return `${header}\n${blocks.join('\n')}\n\nดูรายละเอียดที่หน้า CDCU ในระบบ`
  }
}
