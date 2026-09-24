import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'

import { NotifyGroup, VitalsSetting } from '#models/notify_system'
import { blocksToPlainText, buildFlexMessages } from '#services/flex_builder'
import type { ResolvedBlock } from '#services/flex_builder'
import type { HosxpClient } from '#services/hosxp_client'
import { withHosxp } from '#services/hosxp_session'
import { dispatch } from '#services/notify_dispatcher'
import type { LineMessage } from '#services/notify_client'

/**
 * รายงานผู้รับบริการที่ความดันโลหิตสูง เข้ากลุ่มเจ้าหน้าที่วันละครั้ง
 *
 * อ่านผลคัดกรองแรกรับจาก `opdscreen` ของ HOSxP แล้วส่งรายที่ความดันเกินเกณฑ์
 * รวมเป็นข้อความเดียวเข้ากลุ่ม LINE ผ่าน MOPH Notify ตามเวลาที่ตั้งไว้
 *
 * ช่วงข้อมูลของแต่ละรอบคือ "ตั้งแต่รอบที่แล้วถึงตอนนี้" ไม่ใช่ตั้งแต่เที่ยงคืน
 * รายที่คัดกรองหลังเวลาส่งของวันนี้จึงไปโผล่ในรอบของวันถัดไป ไม่มีใครหล่นหาย
 * และไม่มีใครถูกแจ้งซ้ำสองรอบ
 *
 * ⚠️ เป็นการแจ้งเตือนเชิงคลินิก ไม่ใช่การวินิจฉัย — ค่าที่วัดครั้งเดียวที่จุดคัดกรอง
 *    สูงได้จากหลายสาเหตุ ทั้งเพิ่งเดินมา กังวล หรือปลอกแขนผิดขนาด
 */

/** อ่านทีละไม่เกินเท่านี้ต่อรอบ */
const BATCH = 300

/**
 * สีม่วงของการ์ด — ชุดเดียวกับการ์ด Flex อื่นของโรงพยาบาลนี้
 * (`scripts/apps-script/FlexPurple.gs` ใช้สามสีนี้เหมือนกัน)
 */
export const PURPLE = '#6d28d9'

/**
 * จำนวนผู้ป่วยต่อการ์ดหนึ่งใบ และจำนวนใบต่อหนึ่งข้อความ
 *
 * LINE จำกัด JSON ของข้อความ Flex ไว้ 10 KB ต่อหนึ่งข้อความ และ `splitPages`
 * ตัดที่ 5 ใบ — **บล็อกที่เกินใบที่ 5 ถูกโยนทิ้งเงียบ ๆ** จึงต้องคุมจำนวน
 * ผู้ป่วยต่อหนึ่งชุดไม่ให้เกิน 8 × 5 ถ้าเกินก็แยกเป็นอีกข้อความ
 */
const PER_CARD = 8
const MAX_CARDS = 5
const PER_BATCH = PER_CARD * MAX_CARDS

/**
 * กรองค่าที่เป็นไปไม่ได้ทางสรีรวิทยาออกก่อนเสมอ
 *
 * ในฐานจริงของโรงพยาบาลนี้ 90 วันย้อนหลังมีค่าพิมพ์ผิดราว 30 แถวจาก 25,798
 * — ค่าบนสูงสุดที่เจอคือ 2136 ค่าล่างสูงสุด 874 และมี 14 แถวที่ค่าล่างมากกว่าค่าบน
 *
 * แถวพวกนี้น้อยมากก็จริง แต่เรียงตามค่าความดันแล้วมันขึ้นไปอยู่บนสุดของข้อความ
 * ทุกครั้ง กลุ่มจะเห็น "2136/874" เป็นบรรทัดแรกแล้วเลิกเชื่อถือทั้งระบบภายในไม่กี่ครั้ง
 * ค่าที่กรองทิ้งไม่ได้หายไปไหน ยังอยู่ใน HOSxP ให้แก้ที่ต้นทาง
 */
const PLAUSIBLE = `s.bps BETWEEN 50 AND 300 AND s.bpd BETWEEN 30 AND 200 AND s.bps > s.bpd`

export type VitalsRow = {
  vn: string
  hn: string | null
  screened_at: string | Date | null
  vsttime: string | null
  bps: number | null
  bpd: number | null
  pulse: number | null
  dep: string | null
  department: string | null
  pname: string | null
  fname: string | null
  lname: string | null
  addr: string | null
  tel: string | null
  hospsub: string | null
  hospsub_name: string | null
  /** 1 = สถานพยาบาลรองอยู่ในอำเภอเดียวกับโรงพยาบาล — เจ้าหน้าที่ตามเยี่ยมเองได้ */
  in_district: number | null
}

/** ผู้ป่วยหนึ่งชุดที่จะส่งเป็นข้อความหนึ่งฉบับ */
export type VitalsBatch = {
  key: string
  title: string
  rows: VitalsRow[]
}

/**
 * ไม่หยิบ cid มาด้วยเด็ดขาด — ปลายทางเป็นกลุ่มแชทที่มีคนอ่านหลายคน
 *
 * `hospsub` มาจาก `vn_stat` คือสถานพยาบาลรองที่ผู้ป่วยขึ้นทะเบียนไว้
 * ต่อกับ `hospcode` เพื่อเอาชื่อ รพ.สต. มาแสดง ว่างได้ไม่เป็นไร (ราว 10% ของแถว)
 * เพราะสิ่งที่ใช้ตามตัวจริง ๆ คือที่อยู่
 *
 * ที่อยู่ประกอบจาก `patient` แล้ว join `thaiaddress` เอาชื่อตำบล/อำเภอ/จังหวัด
 * (codetype 3 = ตำบล, 2 = อำเภอ, 1 = จังหวัด) ระดับอำเภอต้องใช้ tmbpart = '00'
 * ระดับจังหวัดต้องใช้ amppart = '00' ด้วย
 *
 * ใส่จังหวัด**เฉพาะคนต่างจังหวัด** โดยเทียบกับจังหวัดของโรงพยาบาลเองที่อ่านจาก
 * `opdconfig.hospitalcode` — ไม่ฮาร์ดโค้ด โรงพยาบาลอื่นเอาไปใช้ได้เลย
 * ราว 13% ของรายที่เข้าเกณฑ์เป็นคนต่างจังหวัด ถ้าไม่บอกจังหวัดจะตามตัวผิดที่
 * (มี ต.บางเลน อ.บางใหญ่ ที่เป็นนนทบุรี ปนอยู่ในรายงานของโรงพยาบาลในโคราช)
 * ส่วนคนในจังหวัดเดียวกันไม่ต้องใส่ ประหยัดที่ให้ข้อความไม่ต้องแบ่งหลายฉบับเกินจำเป็น
 */
const SELECT_VITALS = `
  SELECT s.vn, s.hn, s.vsttime,
         TIMESTAMP(s.vstdate, COALESCE(s.vsttime, '00:00:00')) AS screened_at,
         s.bps, s.bpd, s.pulse,
         o.cur_dep AS dep, k.department,
         p.pname, p.fname, p.lname,
         CONCAT_WS(' ',
           NULLIF(p.addrpart, ''),
           CASE WHEN NULLIF(p.moopart, '') IS NULL THEN NULL ELSE CONCAT('ม.', p.moopart) END,
           CASE WHEN t.name IS NULL THEN NULL ELSE CONCAT('ต.', t.name) END,
           CASE WHEN a.name IS NULL THEN NULL ELSE CONCAT('อ.', a.name) END,
           CASE
             WHEN c.name IS NULL THEN NULL
             WHEN p.chwpart = hc.chwpart THEN NULL
             ELSE CONCAT('จ.', c.name)
           END
         ) AS addr,
         COALESCE(NULLIF(p.mobile_phone_number, ''), NULLIF(p.hometel, '')) AS tel,
         v.hospsub, h.name AS hospsub_name,
         CASE
           WHEN h.chwpart = hc.chwpart AND h.amppart = hc.amppart THEN 1
           ELSE 0
         END AS in_district
    FROM opdscreen s
    LEFT JOIN ovst o ON o.vn = s.vn
    LEFT JOIN vn_stat v ON v.vn = s.vn
    LEFT JOIN kskdepartment k ON k.depcode = o.cur_dep
    LEFT JOIN patient p ON p.hn = s.hn
    LEFT JOIN hospcode h ON h.hospcode = v.hospsub
    LEFT JOIN thaiaddress t
           ON t.chwpart = p.chwpart AND t.amppart = p.amppart
          AND t.tmbpart = p.tmbpart AND t.codetype = '3'
    LEFT JOIN thaiaddress a
           ON a.chwpart = p.chwpart AND a.amppart = p.amppart
          AND a.tmbpart = '00' AND a.codetype = '2'
    LEFT JOIN thaiaddress c
           ON c.chwpart = p.chwpart AND c.amppart = '00'
          AND c.tmbpart = '00' AND c.codetype = '1'
    LEFT JOIN opdconfig oc ON 1 = 1
    LEFT JOIN hospcode hc ON hc.hospcode = oc.hospitalcode
`

export type VitalsTickResult = {
  scanned: number
  matched: number
  sent: number
  note?: string
}

/** ระดับความรุนแรงตามเกณฑ์ที่ใช้กันทั่วไป ใช้ทำเครื่องหมายหน้าบรรทัด */
export type Severity = { rank: number; label: string; icon: string }

export function severityOf(bps: number | null, bpd: number | null): Severity {
  const s = bps ?? 0
  const d = bpd ?? 0
  if (s >= 180 || d >= 120) return { rank: 3, label: 'วิกฤต', icon: '🔴' }
  if (s >= 160 || d >= 100) return { rank: 2, label: 'สูงมาก', icon: '🟠' }
  return { rank: 1, label: 'สูง', icon: '🟡' }
}

/** `pname` ของ HOSxP ต่อกับชื่อโดยไม่เว้นวรรค เช่น "นาย" + "สมชาย" */
export function fullName(row: Pick<VitalsRow, 'pname' | 'fname' | 'lname'>) {
  const name = [row.fname, row.lname]
    .map((value) => (value ?? '').trim())
    .filter(Boolean)
    .join(' ')

  if (!name) return ''
  return `${(row.pname ?? '').trim()}${name}`
}

/** 08:29:52 → 08:29 — วินาทีไม่มีความหมายกับคนอ่าน */
export function timeLabel(raw: string | null) {
  if (!raw) return ''
  const [h, m] = raw.split(':')
  if (h === undefined || m === undefined) return ''
  return `${h}:${m}`
}

/** ค่าความดันของ HOSxP เป็น double เช่น 140.000 — ปัดเป็นจำนวนเต็มก่อนแสดง */
export function bpLabel(bps: number | null, bpd: number | null) {
  const s = bps === null || bps === undefined ? '?' : String(Math.round(bps))
  const d = bpd === null || bpd === undefined ? '?' : String(Math.round(bpd))
  return `${s}/${d}`
}

/** บางแถวคีย์มาหลายเบอร์คั่นด้วยจุลภาค เอาเบอร์แรกพอ */
export function phoneOf(raw: string | null) {
  if (!raw) return ''
  return raw.split(/[,;/]/)[0].trim().slice(0, 20)
}

export class VitalsWatcher {
  /**
   * ช่วงข้อมูลของรอบถัดไป — ตั้งแต่รอบที่แล้วถึงตอนนี้
   *
   * รอบแรกที่ยังไม่เคยส่ง ให้ย้อนไปหนึ่งวันเต็มนับจากเวลาส่ง ไม่ใช่ย้อนไม่จำกัด
   * ไม่งั้นรอบแรกจะกวาดผู้ป่วยความดันสูงทั้งฐานมาใส่ข้อความเดียว
   */
  windowFor(settings: VitalsSetting, now = DateTime.now().setZone('Asia/Bangkok')) {
    const [h, m] = settings.sendAt.split(':').map(Number)
    const fallback = now
      .minus({ days: 1 })
      .set({ hour: h || 0, minute: m || 0, second: 0, millisecond: 0 })

    const from = settings.lastRunAt?.setZone('Asia/Bangkok') ?? fallback
    return { from, to: now }
  }

  /** ถึงเวลาส่งของวันนี้แล้วหรือยัง และวันนี้ส่งไปหรือยัง */
  isDue(settings: VitalsSetting, now = DateTime.now().setZone('Asia/Bangkok')) {
    const [h, m] = settings.sendAt.split(':').map(Number)
    if (!Number.isFinite(h) || !Number.isFinite(m)) return false

    const dueAt = now.set({ hour: h, minute: m, second: 0, millisecond: 0 })
    if (now < dueAt) return false

    return settings.lastRunDate?.toISODate() !== now.toISODate()
  }

  /**
   * HN ที่เคยได้รับการวินิจฉัยความดันโลหิตสูงมาก่อน
   *
   * แยกเป็น query ที่สองโดยตั้งใจ ไม่ใช้ EXISTS ซ้อนในคำสั่งหลัก — วัดกับฐานจริง
   * แล้วแบบซ้อนใช้ 7.4 วินาที ส่วนแบบนี้ 0.1 วินาที เพราะ `ovstdiag` มี 3.8 ล้านแถว
   * และ subquery แบบ correlated วิ่งใหม่ทุกแถวของผลลัพธ์
   *
   * ดูทั้ง OPD (`ovstdiag`) และ IPD (`iptdiag`) เพราะบางคนถูกวินิจฉัยตอนนอน รพ.
   * `I10%` ครอบคลุม I10 กับ I109 ซึ่งเป็นความดันสูงชนิดปฐมภูมิทั้งคู่
   * (I11–I15 เป็นภาวะแทรกซ้อนจากความดัน ไม่ได้รวมไว้ตามที่ระบุมาว่าเอา I10)
   */
  async knownHypertensiveHns(hns: string[], client: HosxpClient): Promise<Set<string>> {
    const unique = [...new Set(hns.filter(Boolean))]
    if (!unique.length) return new Set()

    const marks = unique.map(() => '?').join(',')
    const rows = await client.select<{ hn: string }>(
      `SELECT DISTINCT hn FROM ovstdiag WHERE icd10 LIKE 'I10%' AND hn IN (${marks})
       UNION
       SELECT DISTINCT hn FROM iptdiag WHERE icd10 LIKE 'I10%' AND hn IN (${marks})`,
      [...unique, ...unique]
    )

    return new Set(rows.map((row) => row.hn))
  }

  /**
   * อ่านรายที่เข้าเกณฑ์ในช่วงเวลาที่กำหนด
   *
   * กรองคนที่เคยวินิจฉัย I10 ออกตรงนี้ ไม่ใช่ที่ผู้เรียก เพื่อให้หน้าเว็บ คำสั่ง
   * และรอบส่งจริงเห็นรายชื่อชุดเดียวกันเสมอ
   */
  async fetch(settings: VitalsSetting, from: DateTime, to: DateTime, client?: HosxpClient) {
    const sql = `${SELECT_VITALS}
        WHERE s.vstdate BETWEEN ? AND ?
          AND TIMESTAMP(s.vstdate, COALESCE(s.vsttime, '00:00:00')) > ?
          AND TIMESTAMP(s.vstdate, COALESCE(s.vsttime, '00:00:00')) <= ?
          AND ${PLAUSIBLE}
          AND (s.bps > ? OR s.bpd > ?)
        ORDER BY s.bps DESC
        LIMIT ${BATCH}`

    const bindings = [
      from.toISODate(),
      to.toISODate(),
      from.toFormat('yyyy-MM-dd HH:mm:ss'),
      to.toFormat('yyyy-MM-dd HH:mm:ss'),
      settings.sysThreshold,
      settings.diaThreshold,
    ]

    const run = async (c: HosxpClient) => {
      const rows = await c.select<VitalsRow>(sql, bindings)
      if (!settings.excludeKnownHt || !rows.length) return rows

      const known = await this.knownHypertensiveHns(
        rows.map((row) => row.hn ?? ''),
        c
      )
      return rows.filter((row) => !row.hn || !known.has(row.hn))
    }

    if (client) return run(client)
    return withHosxp(run)
  }

  /**
   * จำนวนรายต่อวันที่จะเข้าเกณฑ์ ถ้าใช้เกณฑ์ที่กำลังจะตั้ง
   *
   * มีไว้ให้คนตั้งค่าเห็นปริมาณจริงก่อนกดเปิด
   */
  async volumeAtThreshold(sys: number, dia: number, excludeKnownHt = true, days = 30) {
    /**
     * ตัดผู้ป่วยเดิมด้วย LEFT JOIN กับรายชื่อ HN ที่เคยวินิจฉัย I10
     *
     * ช้ากว่าแบบไม่กรองมาก (4.4 วินาที เทียบกับ 0.2) เพราะต้องไล่ทั้ง 30 วัน
     * จึงเรียกจากฝั่ง JS หลังหน้าโหลดเสร็จ ไม่บล็อกการเปิดหน้า
     */
    const join = excludeKnownHt
      ? `LEFT JOIN (
           SELECT DISTINCT hn FROM ovstdiag WHERE icd10 LIKE 'I10%'
           UNION
           SELECT DISTINCT hn FROM iptdiag WHERE icd10 LIKE 'I10%'
         ) ht ON ht.hn = s.hn`
      : ''
    const where = excludeKnownHt ? 'AND ht.hn IS NULL' : ''

    return withHosxp((client) =>
      client.select<{ total: number; per_day: number }>(
        `SELECT COUNT(*) AS total, ROUND(COUNT(*) / ?, 1) AS per_day
           FROM opdscreen s
           ${join}
          WHERE s.vstdate BETWEEN DATE_SUB(CURDATE(), INTERVAL ? DAY) AND CURDATE()
            AND ${PLAUSIBLE}
            AND (s.bps > ? OR s.bpd > ?)
            ${where}`,
        [days, days, sys, dia]
      )
    )
  }

  /** แผนกที่มีการคัดกรองจริงในช่วงที่ผ่านมา ใช้ให้เลือกว่าจะเฝ้าแผนกไหน */
  async departments(days = 30) {
    return withHosxp((client) =>
      client.select<{ dep: string; department: string | null; n: number }>(
        `SELECT o.cur_dep AS dep, k.department, COUNT(*) AS n
           FROM opdscreen s
           JOIN ovst o ON o.vn = s.vn
           LEFT JOIN kskdepartment k ON k.depcode = o.cur_dep
          WHERE s.vstdate >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
            AND s.bps > 0
          GROUP BY o.cur_dep, k.department
          ORDER BY n DESC
          LIMIT 60`,
        [days]
      )
    )
  }

  /** ตรวจรอบเดียว — ส่งจริงเมื่อถึงเวลาที่ตั้งไว้และวันนี้ยังไม่ได้ส่ง */
  async tick(): Promise<VitalsTickResult> {
    const empty: VitalsTickResult = { scanned: 0, matched: 0, sent: 0 }

    const settings = await VitalsSetting.current()
    if (!settings.isEnabled) return { ...empty, note: 'ปิดใช้งานอยู่' }
    if (!settings.groupId) return { ...empty, note: 'ยังไม่ได้เลือกกลุ่ม LINE' }

    const now = DateTime.now().setZone('Asia/Bangkok')
    if (!this.isDue(settings, now)) return empty

    return this.runNow(settings, now)
  }

  /**
   * ทำรอบส่งทันทีโดยไม่สนว่าถึงเวลาหรือยัง
   *
   * ใช้ทั้งจากรอบอัตโนมัติและจากปุ่มสั่งส่งในหน้าเว็บ ตรรกะเดียวกันทุกอย่าง
   */
  async runNow(
    settings: VitalsSetting,
    now = DateTime.now().setZone('Asia/Bangkok')
  ): Promise<VitalsTickResult> {
    const empty: VitalsTickResult = { scanned: 0, matched: 0, sent: 0 }
    const { from, to } = this.windowFor(settings, now)

    const rows = await this.fetch(settings, from, to).catch(() => null)
    if (rows === null) return { ...empty, note: 'อ่านข้อมูลจาก HOSxP ไม่ได้' }

    const matched = rows.filter((row) => settings.watches(row.dep))

    let sent = 0
    if (matched.length) {
      const group = await NotifyGroup.find(settings.groupId!)

      if (group) {
        /**
         * ส่งแยกชุดละข้อความ — รพ.สต. ในอำเภอได้ของตัวเองใบเดียวจบ
         * ที่เหลือรวมเป็นชุดเดียว
         *
         * ส่ง Flex กับข้อความธรรมดาไปพร้อมกัน ตัวส่งเลือกเองตาม
         * `group.supportsFlex` และเก็บข้อความธรรมดาลงประวัติเสมอ
         */
        for (const batch of this.batchesFor(matched)) {
          const blocks = this.flexBlocksFor(batch, settings, from, to)

          const outcome = await dispatch({
            groups: [group],
            body: blocksToPlainText(blocks),
            messages: buildFlexMessages(
              `ความดันสูง ${batch.title} ${batch.rows.length} ราย`,
              blocks,
              PURPLE
            ) as LineMessage[],
            source: 'vitals',
            subject: `ความดันสูง · ${batch.title} ${batch.rows.length} ราย`,
          })
          sent += outcome.sent
        }
      }

      for (const row of matched) await this.#markSeen(row, sent > 0)
    }

    /**
     * บันทึกเวลารอบนี้เสมอ แม้ไม่มีใครเข้าเกณฑ์
     *
     * ถ้าไม่บันทึก รอบถัดไปจะกวาดช่วงเดิมซ้ำ และ isDue จะยิงใหม่ทุกนาทีจนหมดวัน
     */
    settings.merge({
      lastRunDate: now.startOf('day'),
      lastRunAt: to,
      lastRunNote:
        `${from.toFormat('dd/MM HH:mm')}–${to.toFormat('dd/MM HH:mm')} · ` +
        `พบ ${matched.length} ราย · ส่ง ${sent}`,
    })
    await settings.save()

    return { scanned: rows.length, matched: matched.length, sent }
  }

  /**
   * เก็บเคสไว้ให้ระบบติดตามอาการใช้ต่อ และกันแจ้งซ้ำถ้ารอบถูกสั่งซ้ำ
   *
   * เก็บ snapshot ของชื่อ ที่อยู่ เบอร์โทร และ รพ.สต. ณ วันที่แจ้ง ไม่ใช่ค่าปัจจุบัน
   * เพราะงานติดตามต้องรู้ว่าตอนนั้นเขาอยู่ที่ไหน ไม่ใช่ที่อยู่ที่อาจถูกแก้ทีหลัง
   *
   * ไม่เก็บเลขบัตรประชาชน ไม่ได้ดึงมาตั้งแต่ชั้น SQL อยู่แล้ว
   */
  async #markSeen(row: VitalsRow, notified: boolean) {
    await db
      .rawQuery(
        `INSERT INTO vitals_seen
           (vn, hn, bps, bpd, dep, vstdate, notified, created_at,
            pname, fname, lname, addr, tel, hospsub, hospsub_name, in_district, screened_at)
         VALUES (?, ?, ?, ?, ?, CURDATE(), ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE notified = GREATEST(notified, VALUES(notified))`,
        [
          row.vn,
          row.hn,
          row.bps === null ? null : Math.round(row.bps),
          row.bpd === null ? null : Math.round(row.bpd),
          row.dep,
          notified ? 1 : 0,
          row.pname,
          row.fname,
          row.lname,
          row.addr,
          row.tel,
          row.hospsub,
          row.hospsub_name,
          row.in_district === 1 ? 1 : 0,
          row.screened_at ?? null,
        ]
      )
      .catch((error) =>
        logger.warn({ vn: row.vn, err: error.message }, 'บันทึก vitals_seen ไม่ได้')
      )
  }

  /**
   * แบ่งผู้ป่วยเป็นชุด ๆ ตามที่จะส่งจริง
   *
   * รพ.สต. ในอำเภอเดียวกับโรงพยาบาลได้ชุดของตัวเองแยกใบ เพราะเป็นคนที่ตามเยี่ยม
   * ได้จริง ส่วนที่เหลือ — คนที่ไม่มี hospsub และคนที่ขึ้นทะเบียนไว้นอกอำเภอ —
   * รวมเป็นชุดเดียว เพราะแยกไปก็ได้ใบละคนสองคนที่ไม่มีใครรับไปทำต่ออยู่ดี
   * (ของจริงมีสถานพยาบาลรองต่างกันถึง 145 แห่งใน 30 วัน แต่ในอำเภอมีแค่ 12 แห่ง)
   *
   * ชุดที่ใหญ่เกินหนึ่งข้อความจะถูกซอยต่อพร้อมเลขกำกับ
   */
  batchesFor(rows: VitalsRow[]): VitalsBatch[] {
    const local = new Map<string, VitalsRow[]>()
    const rest: VitalsRow[] = []

    for (const row of rows) {
      const name = row.hospsub_name?.trim()
      if (row.in_district === 1 && name) local.set(name, [...(local.get(name) ?? []), row])
      else rest.push(row)
    }

    const batches: VitalsBatch[] = [...local.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([title, list]) => ({ key: title, title, rows: list }))

    if (rest.length) batches.push({ key: 'other', title: 'ผู้ป่วยรายอื่น', rows: rest })

    // ซอยชุดที่ใหญ่เกินหนึ่งข้อความ ไม่งั้น splitPages จะโยนคนท้าย ๆ ทิ้งเงียบ ๆ
    return batches.flatMap((batch) => {
      if (batch.rows.length <= PER_BATCH) return [batch]

      const chunks: VitalsBatch[] = []
      for (let i = 0; i < batch.rows.length; i += PER_BATCH) {
        const part = Math.floor(i / PER_BATCH) + 1
        const total = Math.ceil(batch.rows.length / PER_BATCH)
        chunks.push({
          key: `${batch.key}:${part}`,
          title: `${batch.title} (${part}/${total})`,
          rows: batch.rows.slice(i, i + PER_BATCH),
        })
      }
      return chunks
    })
  }

  /**
   * บล็อกของการ์ด Flex หนึ่งชุด
   *
   * ใช้ตัวสร้างการ์ดตัวเดียวกับตารางเวลาและ db-sync จึงได้หน้าตาชุดเดียวกัน
   * ทั้งระบบ และได้ข้อความสำรองแบบอ่านรู้เรื่องฟรีจาก `blocksToPlainText`
   * สำหรับกลุ่มที่รับการ์ดไม่ได้และสำหรับเก็บลงประวัติ
   */
  flexBlocksFor(
    batch: VitalsBatch,
    settings: VitalsSetting,
    from: DateTime,
    to: DateTime
  ): ResolvedBlock[] {
    const blocks: ResolvedBlock[] = [
      {
        kind: 'header',
        title: `🩺 ความดันสูง · ${batch.title}`,
        subtitle:
          `${batch.rows.length} ราย · เกณฑ์ บน>${settings.sysThreshold} หรือ ล่าง>${settings.diaThreshold}\n` +
          `ช่วง ${from.toFormat('dd/MM HH:mm')} – ${to.toFormat('dd/MM HH:mm')} น.`,
      },
    ]

    const sorted = [...batch.rows].sort((a, b) => (b.bps ?? 0) - (a.bps ?? 0))

    sorted.forEach((row, index) => {
      if (index > 0 && index % PER_CARD === 0) blocks.push({ kind: 'pagebreak' })

      const severity = severityOf(row.bps, row.bpd)
      const name = settings.includeName ? fullName(row) : ''
      const fallback = settings.includeHn && row.hn ? `HN ${row.hn}` : 'ผู้รับบริการ'

      blocks.push({
        kind: 'rows',
        title: '',
        rows: [
          {
            label: `${severity.icon} ${name || fallback}`,
            value: `${bpLabel(row.bps, row.bpd)} mmHg`,
            // ระบายสีเตือนเฉพาะระดับสูงมากขึ้นไป ถ้าเตือนทุกคนก็เท่ากับไม่เตือนใคร
            alert: severity.rank >= 2,
          },
        ],
      })

      const detail = [
        name && settings.includeHn && row.hn ? `HN ${row.hn}` : null,
        settings.includeAddress && row.addr ? row.addr : null,
        settings.includePhone && phoneOf(row.tel) ? `โทร ${phoneOf(row.tel)}` : null,
      ].filter(Boolean)

      if (detail.length) blocks.push({ kind: 'text', text: detail.join(' · '), tone: 'muted' })
    })

    blocks.push({ kind: 'divider' })
    blocks.push({
      kind: 'text',
      text: 'เป็นค่าคัดกรองแรกรับ ไม่ใช่การวินิจฉัย กรุณาตรวจซ้ำก่อนพิจารณา',
      tone: 'warn',
    })

    return blocks
  }
}
