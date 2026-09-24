import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'

import { NotifyGroup, PcSetting } from '#models/notify_system'
import { blocksToPlainText, buildFlexMessages } from '#services/flex_builder'
import type { ResolvedBlock } from '#services/flex_builder'
import type { HosxpClient } from '#services/hosxp_client'
import { withHosxp } from '#services/hosxp_session'
import { dispatch } from '#services/notify_dispatcher'
import type { LineMessage } from '#services/notify_client'
/**
 * สีของการ์ด — เขียวอมฟ้า ไม่ใช้ม่วงเหมือนรายงานความดัน
 *
 * ปลายทางเป็นกลุ่มเดียวกันได้ ถ้าใช้สีเดียวกันเจ้าหน้าที่จะแยกไม่ออกว่า
 * การ์ดที่เด้งขึ้นมาเป็นเรื่องความดันหรือเรื่องประคับประคอง ซึ่งเป็นงานคนละทีม
 * เปลี่ยนสีได้ที่ค่านี้ค่าเดียว
 */
export const PC_COLOR = '#0d9488'

/**
 * แจ้งเตือนผู้ป่วยกลุ่มประคับประคอง (Palliative Care)
 *
 * อ่านรหัสวินิจฉัยจาก `ovstdiag` (ผู้ป่วยนอก) และ `iptdiag` (ผู้ป่วยใน)
 * แล้วแจ้งเมื่อพบผู้ป่วยที่เข้าเกณฑ์โรคกลุ่มนี้ เข้ากลุ่ม LINE ผ่าน MOPH Notify
 *
 * ⚠️ ต่างจากรายงานความดันในเรื่องที่สำคัญที่สุด
 *    ความดันคือ "ค่าที่วัดครั้งนั้น" คนเดิมมาวัดใหม่ก็เป็นเคสใหม่ได้
 *    แต่โรคกลุ่มนี้เป็นโรคเรื้อรัง ผู้ป่วยมะเร็งคนหนึ่งมาโรงพยาบาลปีละหลายสิบครั้ง
 *    (ในฐานนี้ 1 ปี มะเร็ง 143 คน แต่มีการวินิจฉัย 556 ครั้ง)
 *    ถ้าแจ้งทุกครั้งที่เจอรหัส กลุ่มจะถูกน้ำท่วมแล้วปิดเสียงภายในวันเดียว
 *    จึงกันซ้ำด้วย **HN** — ผู้ป่วยหนึ่งคนแจ้งครั้งเดียวตลอดกาล
 *
 * ⚠️ เป็นการคัดกรองจากรหัสวินิจฉัย ไม่ใช่การตัดสินว่าผู้ป่วยเข้าสู่ระยะประคับประคอง
 *    การประเมินจริงต้องใช้ดุลยพินิจของแพทย์ร่วมกับเครื่องมืออื่น
 */

/** อ่านทีละไม่เกินเท่านี้ต่อรอบ */
const BATCH = 500

/** ช่วงที่ใช้ตอน "รับทราบผู้ป่วยเดิม" — เท่ากับรายงานที่ใช้กันอยู่ */
const SEED_DAYS = 365

/** กวาดการมาโรงพยาบาลของผู้ป่วยในทะเบียนถี่แค่ไหน */
const VISIT_SYNC_MINUTES = 5

/** รอบแรกที่ pc_visits ยังว่าง ย้อนไปเท่านี้ — พอสำหรับนับ "มาครั้งที่เท่าไหร่" ตั้งแต่พบ */
const VISIT_BACKFILL_DAYS = 365

const PER_CARD = 8
const MAX_CARDS = 5
const PER_BATCH = PER_CARD * MAX_CARDS

/**
 * เกณฑ์โรค เขียนเป็นช่วง [lo, hi) — คือ >= lo และ < hi
 *
 * ใช้ช่วงแทน LEFT(icd10,3) หรือ LIKE เพราะ `ovstdiag` มี 3.8 ล้านแถวและมี index
 * อยู่ที่คอลัมน์ icd10 — การเทียบแบบช่วงใช้ index ได้ (อ่าน 1.6 แสนแถว)
 * ส่วน LEFT() หุ้มคอลัมน์ไว้ในฟังก์ชัน index ใช้ไม่ได้แล้วต้องไล่อ่านทั้งตาราง
 * วัดจริงแล้วต่างกัน 6 วินาที กับ 0.02 วินาที
 *
 * HOSxP เก็บรหัสแบบไม่มีจุด (C34.9 เก็บเป็น C349) ช่วงจึงครอบรหัสย่อยให้เอง
 */
export type PcGroup = {
  key: string
  ord: number
  label: string
  /** รหัสที่แสดงให้คนอ่าน */
  codes: string
  ranges: [string, string][]
  /** รหัสที่ต้องตัดออกแม้อยู่ในช่วง */
  exclude?: string[]
}

/**
 * จัดกลุ่มตามที่ทีมประคับประคองใช้รายงาน — 9 กลุ่ม ผู้ป่วยหนึ่งคนนับได้กลุ่มเดียว
 *
 * ผู้ป่วยที่มีรหัสเข้าเกณฑ์หลายโรคให้อยู่กลุ่มที่ `ord` น้อยที่สุด (มะเร็งมาก่อน)
 * ตรงกับกติกา "วินิจฉัยเข้าเกณฑ์มากกว่า 1 โรค ให้นับเป็น 1"
 *
 * กลุ่ม `neuro` รวมหลอดเลือดสมองกับสมองเสื่อมไว้ด้วยกันตามรายงาน แต่เกณฑ์
 * ประเมินต่างกัน (NIHSS กับ PPS) — ฝั่งระบบติดตามแยกด้วยรหัส ICD อีกที
 */
export const PC_GROUPS: PcGroup[] = [
  {
    key: 'cancer',
    ord: 1,
    label: 'มะเร็ง',
    codes: 'C00-C96, D37-D48',
    ranges: [
      ['C00', 'C97'],
      ['D37', 'D49'],
    ],
  },
  {
    key: 'neuro',
    ord: 2,
    label: 'ระบบประสาท',
    codes: 'I60-I69, F03',
    ranges: [
      ['I60', 'I70'],
      ['F03', 'F04'],
    ],
  },
  {
    key: 'ckd',
    ord: 3,
    label: 'ไตวายเรื้อรังระยะสุดท้าย',
    codes: 'N18.5',
    ranges: [['N185', 'N186']],
  },
  { key: 'copd', ord: 4, label: 'ถุงลมโป่งพอง', codes: 'J44', ranges: [['J44', 'J45']] },
  { key: 'chf', ord: 5, label: 'หัวใจล้มเหลว', codes: 'I50', ranges: [['I50', 'I51']] },
  {
    key: 'liver',
    ord: 6,
    label: 'ตับล้มเหลว',
    codes: 'K72, K70.4, K71.7',
    ranges: [
      ['K72', 'K73'],
      ['K704', 'K705'],
      ['K717', 'K718'],
    ],
  },
  {
    key: 'hiv',
    ord: 7,
    label: 'เอดส์',
    codes: 'B20-B24 (ยกเว้น B23.0, B23.1)',
    ranges: [['B20', 'B25']],
    exclude: ['B230', 'B231'],
  },
  { key: 'frailty', ord: 8, label: 'ผู้สูงอายุ', codes: 'R54', ranges: [['R54', 'R55']] },
  {
    key: 'peds',
    ord: 9,
    label: 'ผู้ป่วยเด็ก',
    codes: 'Q89, P07',
    ranges: [
      ['Q89', 'Q90'],
      ['P07', 'P08'],
    ],
  },
]

const BY_KEY = new Map(PC_GROUPS.map((g) => [g.key, g]))

/** รหัสนี้อยู่กลุ่มไหน — คืน null ถ้าไม่เข้าเกณฑ์ใดเลย */
export function groupOf(icd10: string | null): PcGroup | null {
  if (!icd10) return null
  const code = icd10.trim().toUpperCase()

  for (const g of PC_GROUPS) {
    if (g.exclude?.includes(code)) continue
    for (const [lo, hi] of g.ranges) {
      if (code >= lo && code < hi) return g
    }
  }
  return null
}

/**
 * สร้างเงื่อนไข SQL จากกลุ่มที่เลือกไว้
 *
 * ค่าที่ต่อเข้าไปเป็นค่าคงที่ในไฟล์นี้ทั้งหมด ไม่ได้มาจากผู้ใช้ — ผู้ใช้เลือกได้แค่
 * "คีย์" ของกลุ่ม ซึ่งถูกตรวจกับ BY_KEY ก่อน จึงไม่มีทางฉีด SQL เข้ามาได้
 */
function whereForGroups(groups: PcGroup[]) {
  const parts = groups.flatMap((g) =>
    g.ranges.map(([lo, hi]) => {
      const base = `d.icd10 >= '${lo}' AND d.icd10 < '${hi}'`
      if (!g.exclude?.length) return `(${base})`
      const list = g.exclude.map((c) => `'${c}'`).join(', ')
      return `(${base} AND d.icd10 NOT IN (${list}))`
    })
  )
  return parts.length ? `(${parts.join(' OR ')})` : '(1 = 0)'
}

export type PcHit = {
  hn: string
  vn: string | null
  icd10: string
  dxdate: string | Date | null
  src: 'OPD' | 'IPD'
}

export type PcRow = PcHit & {
  group: PcGroup
  pname: string | null
  fname: string | null
  lname: string | null
  addr: string | null
  tel: string | null
  death: string | null
  hospsub: string | null
  hospsub_name: string | null
  in_district: number | null
}

export type PcTickResult = {
  found: number
  sent: number
  daily: number
  note?: string
}

export type PcVisitSyncResult = {
  /** ผู้ป่วยในทะเบียนที่กวาดให้ */
  patients: number
  /** แถวการมาโรงพยาบาลที่เขียน/อัปเดต */
  visits: number
  /** รายที่ HOSxP บันทึกว่าเสียชีวิต */
  deaths: number
  skipped?: boolean
  note?: string
}

/** `pname` ของ HOSxP ต่อกับชื่อโดยไม่เว้นวรรค เช่น "นาย" + "สมชาย" */
export function fullName(row: Pick<PcRow, 'pname' | 'fname' | 'lname'>) {
  const name = [row.fname, row.lname]
    .map((v) => (v ?? '').trim())
    .filter(Boolean)
    .join(' ')
  if (!name) return ''
  return `${(row.pname ?? '').trim()}${name}`
}

export function phoneOf(raw: string | null) {
  if (!raw) return ''
  return raw.split(/[,;/]/)[0].trim().slice(0, 20)
}

function dateLabel(value: string | Date | null) {
  if (!value) return ''
  const d = value instanceof Date ? DateTime.fromJSDate(value) : DateTime.fromSQL(String(value))
  if (!d.isValid) return ''
  return `${d.toFormat('dd/MM')}/${d.year + 543}`
}

export class PcWatcher {
  #visitsSyncedAt: DateTime | null = null

  /** กลุ่มโรคที่เปิดเฝ้าอยู่ */
  groupsFor(settings: PcSetting): PcGroup[] {
    if (settings.allGroups) return PC_GROUPS
    return (settings.groupCodes ?? []).map((k) => BY_KEY.get(k)).filter((g): g is PcGroup => !!g)
  }

  /**
   * รหัสวินิจฉัยที่เข้าเกณฑ์ในช่วงที่กำหนด — ยังไม่กรองว่าเคยพบแล้วหรือยัง
   *
   * คืนแถวดิบระดับ "การวินิจฉัย" ผู้ป่วยคนเดียวอาจมีหลายแถว
   */
  async #hits(groups: PcGroup[], days: number, client: HosxpClient): Promise<PcHit[]> {
    if (!groups.length) return []
    const where = whereForGroups(groups)

    return client.select<PcHit>(
      `SELECT d.hn, d.vn, d.icd10, d.vstdate AS dxdate, 'OPD' AS src
         FROM ovstdiag d
        WHERE d.vstdate >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
          AND d.hn IS NOT NULL AND d.hn <> ''
          AND ${where}
       UNION ALL
       SELECT d.hn, i.vn, d.icd10, i.regdate AS dxdate, 'IPD' AS src
         FROM iptdiag d
         JOIN ipt i ON i.an = d.an
        WHERE i.regdate >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
          AND d.hn IS NOT NULL AND d.hn <> ''
          AND ${where}
        ORDER BY dxdate DESC
        LIMIT ${BATCH * 20}`,
      [days, days]
    )
  }

  /**
   * เติมรายละเอียดผู้ป่วยให้เฉพาะ HN ที่ต้องใช้
   *
   * แยกเป็น query ที่สองโดยตั้งใจ ไม่ join ตั้งแต่คำสั่งแรก — คำสั่งแรกกวาด
   * การวินิจฉัยเป็นแสนแถว ถ้าลาก patient กับ thaiaddress ไปด้วยจะช้ามาก
   * ส่วนตรงนี้ยิงด้วยรายชื่อ HN ไม่กี่สิบตัว ใช้ index ของ patient ตรง ๆ
   */
  async #details(hns: string[], vns: string[], client: HosxpClient) {
    const unique = [...new Set(hns.filter(Boolean))]
    if (!unique.length) return { people: new Map(), sites: new Map() }

    const marks = unique.map(() => '?').join(',')
    const people = await client.select<Record<string, any>>(
      `SELECT p.hn, p.pname, p.fname, p.lname, p.death,
              CONCAT_WS(' ',
                NULLIF(p.addrpart, ''),
                CASE WHEN NULLIF(p.moopart,'') IS NULL THEN NULL ELSE CONCAT('ม.', p.moopart) END,
                CASE WHEN t.name IS NULL THEN NULL ELSE CONCAT('ต.', t.name) END,
                CASE WHEN a.name IS NULL THEN NULL ELSE CONCAT('อ.', a.name) END,
                CASE WHEN c.name IS NULL OR p.chwpart = hc.chwpart THEN NULL
                     ELSE CONCAT('จ.', c.name) END
              ) AS addr,
              COALESCE(NULLIF(p.mobile_phone_number,''), NULLIF(p.hometel,'')) AS tel
         FROM patient p
         LEFT JOIN thaiaddress t ON t.chwpart=p.chwpart AND t.amppart=p.amppart
                                AND t.tmbpart=p.tmbpart AND t.codetype='3'
         LEFT JOIN thaiaddress a ON a.chwpart=p.chwpart AND a.amppart=p.amppart
                                AND a.tmbpart='00' AND a.codetype='2'
         LEFT JOIN thaiaddress c ON c.chwpart=p.chwpart AND c.amppart='00'
                                AND c.tmbpart='00' AND c.codetype='1'
         LEFT JOIN opdconfig oc ON 1 = 1
         LEFT JOIN hospcode hc ON hc.hospcode = oc.hospitalcode
        WHERE p.hn IN (${marks})`,
      unique
    )

    const cleanVns = [...new Set(vns.filter(Boolean))]
    const sites = cleanVns.length
      ? await client.select<Record<string, any>>(
          `SELECT v.vn, v.hospsub, h.name AS hospsub_name,
                  CASE WHEN h.chwpart = hc.chwpart AND h.amppart = hc.amppart THEN 1 ELSE 0 END
                    AS in_district
             FROM vn_stat v
             LEFT JOIN hospcode h ON h.hospcode = v.hospsub
             LEFT JOIN opdconfig oc ON 1 = 1
             LEFT JOIN hospcode hc ON hc.hospcode = oc.hospitalcode
            WHERE v.vn IN (${cleanVns.map(() => '?').join(',')})`,
          cleanVns
        )
      : []

    return {
      people: new Map(people.map((r) => [String(r.hn), r])),
      sites: new Map(sites.map((r) => [String(r.vn), r])),
    }
  }

  /** HN ที่เคยบันทึกไว้แล้ว — อ่านจากฐานของแอป ไม่ใช่ HOSxP */
  async #alreadySeen(hns: string[]): Promise<Set<string>> {
    if (!hns.length) return new Set()
    const rows = await db
      .from('pc_seen')
      .select('hn')
      .whereIn('hn', [...new Set(hns)])
    return new Set(rows.map((r) => String(r.hn)))
  }

  /**
   * ผู้ป่วยที่เข้าเกณฑ์และ**ยังไม่เคยพบมาก่อน**
   *
   * ยุบให้เหลือคนละหนึ่งแถว โดยเลือกการวินิจฉัยที่กลุ่มโรคมาก่อน (ord น้อยสุด)
   * เพื่อให้คนที่เป็นทั้งมะเร็งและ COPD ถูกจัดอยู่กลุ่มมะเร็ง ตรงกับรายงานที่ใช้อยู่
   */
  async findNew(settings: PcSetting, days?: number, client?: HosxpClient): Promise<PcRow[]> {
    const groups = this.groupsFor(settings)
    const window = days ?? settings.lookbackDays

    const run = async (c: HosxpClient) => {
      const hits = await this.#hits(groups, window, c)
      if (!hits.length) return []

      // ยุบเหลือคนละแถว — กลุ่มที่ ord น้อยกว่าชนะ ถ้าเท่ากันเอาวินิจฉัยล่าสุด
      const best = new Map<string, PcRow>()
      for (const hit of hits) {
        const group = groupOf(hit.icd10)
        if (!group) continue

        const hn = String(hit.hn)
        const current = best.get(hn)
        if (current && current.group.ord <= group.ord) continue

        best.set(hn, { ...hit, hn, group } as PcRow)
      }

      const candidates = [...best.values()]
      const seen = await this.#alreadySeen(candidates.map((r) => r.hn))
      const fresh = candidates.filter((r) => !seen.has(r.hn))
      if (!fresh.length) return []

      const { people, sites } = await this.#details(
        fresh.map((r) => r.hn),
        fresh.map((r) => r.vn ?? ''),
        c
      )

      const filled = fresh.map((r) => {
        const p = people.get(r.hn) ?? {}
        const s = r.vn ? (sites.get(String(r.vn)) ?? {}) : {}
        return {
          ...r,
          pname: p.pname ?? null,
          fname: p.fname ?? null,
          lname: p.lname ?? null,
          addr: p.addr ?? null,
          tel: p.tel ?? null,
          death: p.death ?? null,
          hospsub: s.hospsub ?? null,
          hospsub_name: s.hospsub_name ?? null,
          in_district: s.in_district ?? 0,
        } as PcRow
      })

      const alive = settings.excludeDead ? filled.filter((r) => r.death !== 'Y') : filled

      // กลุ่มโรคมาก่อน แล้วค่อยวันวินิจฉัยล่าสุด — เคสหนักขึ้นก่อนในข้อความ
      return alive.sort(
        (a, b) =>
          a.group.ord - b.group.ord || String(b.dxdate ?? '').localeCompare(String(a.dxdate ?? ''))
      )
    }

    if (client) return run(client)
    return withHosxp(run) as Promise<PcRow[]>
  }

  /**
   * รับทราบผู้ป่วยเดิมทั้งหมดโดยไม่ส่งแจ้งเตือน
   *
   * ต้องทำก่อนเปิดใช้งานเสมอ — ตอนเปิดครั้งแรกในฐานนี้มีผู้ป่วยเข้าเกณฑ์อยู่แล้ว
   * ราว 1,600 ราย ถ้าไม่รับทราบไว้ก่อน รอบแรกจะยิงทั้งหมดออกกลุ่มทีเดียว
   */
  async seed(settings: PcSetting): Promise<number> {
    const rows = await this.findNew(settings, SEED_DAYS)
    for (const row of rows) await this.#markSeen(row, false)

    settings.merge({ seeded: true, seededAt: DateTime.now().setZone('Asia/Bangkok') })
    await settings.save()

    return rows.length
  }

  /** ถึงเวลาส่งสรุปรายวันแล้วหรือยัง และวันนี้ส่งไปหรือยัง */
  isDue(settings: PcSetting, now = DateTime.now().setZone('Asia/Bangkok')) {
    const [h, m] = settings.sendAt.split(':').map(Number)
    if (!Number.isFinite(h) || !Number.isFinite(m)) return false

    const dueAt = now.set({ hour: h, minute: m, second: 0, millisecond: 0 })
    if (now < dueAt) return false

    return settings.lastRunDate?.toISODate() !== now.toISODate()
  }

  /** ตรวจรอบเดียว — เรียกจาก worker ทุกนาที */
  async tick(now = DateTime.now().setZone('Asia/Bangkok')): Promise<PcTickResult> {
    const empty: PcTickResult = { found: 0, sent: 0, daily: 0 }

    const settings = await PcSetting.current()
    if (!settings.isEnabled) return { ...empty, note: 'ปิดใช้งานอยู่' }
    if (!settings.groupId) return { ...empty, note: 'ยังไม่ได้เลือกกลุ่ม LINE' }

    /**
     * ยังไม่รับทราบผู้ป่วยเดิม = ยังส่งไม่ได้
     *
     * ไม่ seed ให้เองเงียบ ๆ ตรงนี้ เพราะการรับทราบคนไข้ 1,600 รายเป็นการตัดสินใจ
     * ที่คนต้องเห็นตัวเลขก่อน หน้าเว็บมีปุ่มให้กด
     */
    if (!settings.seeded) {
      return { ...empty, note: 'ยังไม่ได้รับทราบผู้ป่วยเดิม — เปิดหน้าตั้งค่าแล้วกดปุ่ม' }
    }

    const rows = await this.findNew(settings).catch(() => null)
    if (rows === null) return { ...empty, note: 'อ่านข้อมูลจาก HOSxP ไม่ได้' }

    let sent = 0
    let daily = 0

    // --- แจ้งทันที ----------------------------------------------------------
    if (settings.notifyImmediate && rows.length) {
      const take = rows.slice(0, Math.max(settings.maxPerRun, 1))
      sent = await this.#send(settings, take, 'พบผู้ป่วยรายใหม่', now)
      for (const row of take) await this.#markSeen(row, sent > 0)

      if (rows.length > take.length) {
        logger.info(
          { held: rows.length - take.length },
          'ผู้ป่วย PC เกินเพดานต่อรอบ — ที่เหลือจะแจ้งรอบถัดไป'
        )
      }
    }

    // --- สรุปรายวัน ---------------------------------------------------------
    if (settings.notifyDaily && this.isDue(settings, now)) {
      daily = await this.#sendDaily(settings, now)

      settings.merge({ lastRunDate: now.startOf('day'), lastRunAt: now })
      await settings.save()
    }

    /**
     * โหมดแจ้งทันทีปิดอยู่ แต่ต้องบันทึกว่าพบแล้ว ไม่งั้นสรุปรายวันจะนับซ้ำ
     * ทุกวันไปเรื่อย ๆ เพราะไม่มีอะไรบอกว่าคนกลุ่มนี้เคยถูกรายงานไปแล้ว
     */
    if (!settings.notifyImmediate && settings.notifyDaily && daily > 0) {
      for (const row of rows) await this.#markSeen(row, true)
    }

    if (sent || daily) {
      settings.merge({
        lastRunAt: now,
        lastRunNote: `พบ ${rows.length} ราย · แจ้งทันที ${sent} · สรุปรายวัน ${daily}`,
      })
      await settings.save()
    }

    return { found: rows.length, sent, daily }
  }

  /**
   * สั่งส่งสรุปเดี๋ยวนี้จากหน้าเว็บ
   *
   * ใช้ตรรกะเดียวกับรอบอัตโนมัติ ส่งแล้วรอบของวันนี้จะไม่ยิงซ้ำอีก
   */
  async runNow(settings: PcSetting, now = DateTime.now().setZone('Asia/Bangkok')) {
    if (!settings.seeded) {
      return { found: 0, sent: 0, note: 'ยังไม่ได้รับทราบผู้ป่วยเดิม' }
    }

    const rows = await this.findNew(settings).catch(() => null)
    if (rows === null) return { found: 0, sent: 0, note: 'อ่านข้อมูลจาก HOSxP ไม่ได้' }
    if (!rows.length) return { found: 0, sent: 0 }

    const sent = await this.#send(settings, rows.slice(0, PER_BATCH * 3), 'สรุปผู้ป่วยรายใหม่', now)
    for (const row of rows) await this.#markSeen(row, sent > 0)

    settings.merge({
      lastRunDate: now.startOf('day'),
      lastRunAt: now,
      lastRunNote: `สั่งส่งเอง · พบ ${rows.length} ราย · ส่ง ${sent}`,
    })
    await settings.save()

    return { found: rows.length, sent }
  }

  /** สรุปรายวัน — รวมรายใหม่ของวันนั้นเป็นข้อความเดียว */
  async #sendDaily(settings: PcSetting, now: DateTime) {
    const rows = await this.findNew(settings).catch(() => null)
    if (!rows?.length) return 0

    return this.#send(settings, rows.slice(0, PER_BATCH * 3), 'สรุปผู้ป่วยรายใหม่', now)
  }

  /** ส่งเข้ากลุ่ม แบ่งชุดตาม รพ.สต. แบบเดียวกับรายงานความดัน */
  async #send(settings: PcSetting, rows: PcRow[], headline: string, now: DateTime) {
    if (!rows.length || !settings.groupId) return 0

    const group = await NotifyGroup.find(settings.groupId)
    if (!group) return 0

    let sent = 0
    for (const batch of this.batchesFor(rows)) {
      const blocks = this.flexBlocksFor(batch, settings, headline, now)

      const outcome = await dispatch({
        groups: [group],
        body: blocksToPlainText(blocks),
        messages: buildFlexMessages(
          `ประคับประคอง ${batch.rows.length} ราย ${batch.title}`.trim(),
          blocks,
          PC_COLOR
        ) as LineMessage[],
        source: 'pc',
        subject: `ประคับประคอง · ${batch.rows.length} ราย ${batch.title}`.trim(),
      })
      sent += outcome.sent
    }
    return sent
  }

  /**
   * แบ่งเป็นข้อความตามขนาด ไม่แบ่งตาม รพ.สต.
   *
   * เดิมแยกชุดให้ รพ.สต. ในอำเภอได้ใบของตัวเองเหมือนรายงานความดัน แต่งานนี้
   * ไม่เหมือนกัน — ผู้ป่วยประคับประคองทั้งอำเภอมีไม่กี่รายต่อวัน แยกแล้วได้ใบละ
   * คนสองคนเต็มกลุ่มไปหมด และทีมที่ดูแลเป็นทีมกลางของโรงพยาบาลทีมเดียว
   * ไม่ใช่ต่างคนต่างตามเหมือนงานความดัน จึงรวมเป็นชุดเดียวแล้วซอยตามขนาด
   *
   * ชื่อ รพ.สต. ยังอยู่ในบรรทัดรายละเอียดของแต่ละคน ไม่ได้หายไปไหน
   */
  batchesFor(rows: PcRow[]) {
    if (rows.length <= PER_BATCH) return [{ key: 'all', title: '', rows }]

    // ซอยชุดที่ใหญ่เกินหนึ่งข้อความ ไม่งั้น splitPages จะโยนคนท้าย ๆ ทิ้งเงียบ ๆ
    const chunks: { key: string; title: string; rows: PcRow[] }[] = []
    const total = Math.ceil(rows.length / PER_BATCH)

    for (let i = 0; i < rows.length; i += PER_BATCH) {
      const part = Math.floor(i / PER_BATCH) + 1
      chunks.push({
        key: `all:${part}`,
        title: `(${part}/${total})`,
        rows: rows.slice(i, i + PER_BATCH),
      })
    }
    return chunks
  }

  flexBlocksFor(
    batch: { title: string; rows: PcRow[] },
    settings: PcSetting,
    headline: string,
    now: DateTime
  ): ResolvedBlock[] {
    const blocks: ResolvedBlock[] = [
      {
        kind: 'header',
        title: `🕊️ ผู้ป่วยประคับประคอง ${batch.title}`.trim(),
        subtitle:
          `${headline} ${batch.rows.length} ราย\n` +
          `${now.toFormat('dd/MM')}/${now.year + 543} ${now.toFormat('HH:mm')} น.`,
      },
    ]

    batch.rows.forEach((row, index) => {
      if (index > 0 && index % PER_CARD === 0) blocks.push({ kind: 'pagebreak' })

      const name = settings.includeName ? fullName(row) : ''
      const fallback = settings.includeHn && row.hn ? `HN ${row.hn}` : 'ผู้ป่วย'

      blocks.push({
        kind: 'rows',
        title: '',
        rows: [
          {
            label: `${name || fallback}`,
            value: row.group.label,
            // ทุกรายในกลุ่มนี้สำคัญเท่ากัน ไม่ระบายสีเตือนให้รก
            alert: false,
          },
        ],
      })

      const detail = [
        `${row.icd10} · ${row.src === 'IPD' ? 'ผู้ป่วยใน' : 'ผู้ป่วยนอก'} ${dateLabel(row.dxdate)}`,
        name && settings.includeHn && row.hn ? `HN ${row.hn}` : null,
        settings.includeAddress && row.addr ? row.addr : null,
        settings.includePhone && phoneOf(row.tel) ? `โทร ${phoneOf(row.tel)}` : null,
        row.hospsub_name ?? null,
      ].filter(Boolean)

      blocks.push({ kind: 'text', text: detail.join(' · '), tone: 'muted' })
    })

    blocks.push({ kind: 'divider' })
    blocks.push({
      kind: 'text',
      text: 'คัดกรองจากรหัสวินิจฉัย ไม่ใช่การตัดสินว่าเข้าสู่ระยะประคับประคอง กรุณาประเมินซ้ำ',
      tone: 'warn',
    })

    return blocks
  }

  /** บันทึกว่าพบผู้ป่วยรายนี้แล้ว — กันแจ้งซ้ำและเป็นทะเบียนให้งานติดตามใช้ต่อ */
  async #markSeen(row: PcRow, notified: boolean) {
    await db
      .rawQuery(
        `INSERT INTO pc_seen
           (hn, grp, icd10, dxdate, src, pname, fname, lname, addr, tel,
            hospsub, hospsub_name, in_district, notified, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE notified = GREATEST(notified, VALUES(notified))`,
        [
          row.hn,
          row.group.key,
          row.icd10,
          row.dxdate instanceof Date
            ? DateTime.fromJSDate(row.dxdate).toISODate()
            : (row.dxdate ?? null),
          row.src,
          row.pname,
          row.fname,
          row.lname,
          row.addr,
          row.tel,
          row.hospsub,
          row.hospsub_name,
          row.in_district === 1 ? 1 : 0,
          notified ? 1 : 0,
        ]
      )
      .catch((error) => logger.warn({ hn: row.hn, err: error.message }, 'บันทึก pc_seen ไม่ได้'))
  }

  /**
   * กวาดการมาโรงพยาบาลของผู้ป่วยในทะเบียนลง `pc_visits` ให้ระบบติดตามใช้
   *
   * ระบบติดตาม (bpfollow) ไม่ต่อ HOSxP โดยตรงตามที่ออกแบบไว้ แต่ทีมประคับประคอง
   * ต้องรู้ทันทีเมื่อผู้ป่วยในทะเบียนมาโรงพยาบาล และต้องนับได้ว่ามาครั้งที่เท่าไหร่
   * ตั้งแต่รับเข้า จึงให้ worker ตัวนี้ซึ่งต่อ HOSxP อยู่แล้วเป็นคนกวาดมาให้
   *
   * ทำงานแยกจาก `tick()` และไม่สนว่าแจ้งเตือน LINE เปิดอยู่หรือไม่ — เป็นข้อมูล
   * สำหรับหน้าเว็บ ไม่ได้ส่งอะไรออกนอกระบบ
   *
   * ทะเบียน = `pc_seen` (ที่ระบบนี้คัดให้) รวมกับ `bp_pc_patients` (ที่ทีมเพิ่มเอง
   * ในระบบติดตาม) ตารางหลังเป็นของ bpfollow — อ่านอย่างเดียว และถ้ายังไม่มี
   * ตาราง (bpfollow รุ่นเก่า) ก็ข้ามไปเงียบ ๆ
   *
   * ระหว่างทางเช็ก `patient.death` ให้ด้วย เพราะทะเบียนนี้เป็นทะเบียนผู้ป่วยระยะท้าย
   * การเสียชีวิตคือเหตุการณ์ปกติที่ต้องรู้ ไม่ใช่ข้อยกเว้น
   */
  async syncVisits(now = DateTime.now().setZone('Asia/Bangkok')): Promise<PcVisitSyncResult> {
    if (
      this.#visitsSyncedAt &&
      now.diff(this.#visitsSyncedAt, 'minutes').minutes < VISIT_SYNC_MINUTES
    ) {
      return { patients: 0, visits: 0, deaths: 0, skipped: true }
    }
    this.#visitsSyncedAt = now

    const hns = await this.#registryHns()
    if (!hns.length) return { patients: 0, visits: 0, deaths: 0, note: 'ทะเบียนว่าง' }

    // ย้อนกลับไปสามวันจากแถวล่าสุด — เผื่อรอบก่อนกวาดตอนที่วันนั้นยังไม่จบ
    const last = await db.from('pc_visits').max('vstdate as d').first()
    const lastDate = last?.d ? DateTime.fromJSDate(new Date(last.d)) : null
    const since = lastDate?.isValid
      ? lastDate.minus({ days: 3 }).toISODate()!
      : now.minus({ days: VISIT_BACKFILL_DAYS }).toISODate()!

    return withHosxp(async (client) => {
      let visits = 0
      let deaths = 0

      for (let i = 0; i < hns.length; i += 500) {
        const chunk = hns.slice(i, i + 500)
        const marks = chunk.map(() => '?').join(',')

        // ix_hn_vstdate ของ ovst ครอบทั้งสองเงื่อนไข อ่านเฉพาะแถวของคนในทะเบียน
        const rows = await client.select<Record<string, any>>(
          `SELECT o.hn, o.vn, NULLIF(o.an, '') AS an, o.vstdate, o.vsttime,
                  COALESCE(k.department, o.main_dep) AS dept
             FROM ovst o
             LEFT JOIN kskdepartment k ON k.depcode = o.main_dep
            WHERE o.vstdate >= ? AND o.hn IN (${marks})`,
          [since, ...chunk]
        )

        for (const r of rows) {
          await db
            .rawQuery(
              `INSERT INTO pc_visits (hn, vn, an, vstdate, vsttime, dept, kind, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
               ON DUPLICATE KEY UPDATE an = VALUES(an), dept = VALUES(dept), kind = VALUES(kind)`,
              [
                String(r.hn),
                String(r.vn),
                r.an ?? null,
                r.vstdate,
                r.vsttime ?? null,
                r.dept ? String(r.dept).slice(0, 128) : null,
                r.an ? 'IPD' : 'OPD',
              ]
            )
            .then(() => visits++)
            .catch((error) =>
              logger.warn({ vn: r.vn, err: error.message }, 'บันทึก pc_visits ไม่ได้')
            )
        }

        /**
         * ผู้เสียชีวิตตาม HOSxP — เขียนลง pc_seen เฉพาะรายที่ยังไม่มีค่า
         *
         * `death.death_place` ของ HOSxP เป็นรหัส 43 แฟ้ม (1 = ในสถานพยาบาล
         * 2 = นอกสถานพยาบาล) แต่ในฐานนี้กรอกน้อยมาก ระบบติดตามจึงถือบันทึก
         * ของทีมเป็นหลัก ค่านี้เป็นแค่คำใบ้ว่า HOSxP รู้แล้ว
         */
        const dead = await client.select<Record<string, any>>(
          `SELECT p.hn, p.deathday, d.death_place
             FROM patient p
             LEFT JOIN death d ON d.hn = p.hn
            WHERE p.death = 'Y' AND p.hn IN (${marks})`,
          chunk
        )
        for (const r of dead) {
          const place = r.death_place === '1' ? 'hospital' : r.death_place === '2' ? 'home' : null
          const changed = await db
            .from('pc_seen')
            .where('hn', String(r.hn))
            .whereNull('death_on')
            .update({ death_on: r.deathday ?? now.toISODate(), death_place: place })
          deaths += Number(changed) || 0
        }
      }

      await db
        .from('pc_settings')
        .update({ visits_synced_at: now.toFormat('yyyy-MM-dd HH:mm:ss') })
        .catch(() => {})

      return { patients: hns.length, visits, deaths }
    }) as Promise<PcVisitSyncResult>
  }

  /** HN ทั้งหมดในทะเบียน — ของระบบนี้รวมกับที่ทีมเพิ่มเองในระบบติดตาม */
  async #registryHns(): Promise<string[]> {
    const own = await db.from('pc_seen').select('hn')
    const set = new Set(own.map((r) => String(r.hn)))

    // ตารางของ bpfollow — อาจยังไม่มีถ้ายังไม่ได้ปล่อยรุ่นที่เพิ่มผู้ป่วยเองได้
    const manual = await db
      .from('bp_pc_patients')
      .select('hn')
      .catch(() => [] as { hn: string }[])
    for (const r of manual) set.add(String(r.hn))

    return [...set].filter(Boolean)
  }

  /** HN ที่เสียชีวิตแล้ว — แบ่งยิงทีละก้อน กัน IN list ยาวเกินไป */
  async #deadHns(hns: string[], client: HosxpClient): Promise<Set<string>> {
    const dead = new Set<string>()
    const unique = [...new Set(hns.filter(Boolean))]

    for (let i = 0; i < unique.length; i += 1000) {
      const chunk = unique.slice(i, i + 1000)
      const rows = await client.select<{ hn: string }>(
        `SELECT hn FROM patient WHERE death = 'Y' AND hn IN (${chunk.map(() => '?').join(',')})`,
        chunk
      )
      for (const row of rows) dead.add(String(row.hn))
    }
    return dead
  }

  /**
   * จำนวนผู้ป่วยเข้าเกณฑ์ทั้งหมดย้อนหลัง 1 ปี แยกตามกลุ่ม — ใช้แสดงในหน้าตั้งค่า
   *
   * ต้องตัดผู้เสียชีวิตด้วยเกณฑ์เดียวกับตอน seed ไม่งั้นหน้าเว็บจะบอกว่ามี 1,724 ราย
   * แล้วพอกดปุ่มกลับรับทราบไป 1,649 ราย ตัวเลขไม่ตรงกันบนปุ่มที่กดแล้วย้อนยาก
   *
   * ช้าราว 6 วินาที เพราะไล่ทั้งปี จึงเรียกจาก JS หลังหน้าโหลดเสร็จ ไม่บล็อกหน้า
   */
  async volumeByGroup(days = SEED_DAYS, excludeDead = true) {
    return withHosxp(async (client) => {
      const hits = await this.#hits(PC_GROUPS, days, client)

      const best = new Map<string, PcGroup>()
      for (const hit of hits) {
        const g = groupOf(hit.icd10)
        if (!g) continue
        const current = best.get(String(hit.hn))
        if (!current || g.ord < current.ord) best.set(String(hit.hn), g)
      }

      if (excludeDead) {
        const dead = await this.#deadHns([...best.keys()], client)
        for (const hn of dead) best.delete(hn)
      }

      const counts = new Map<string, number>()
      for (const g of best.values()) counts.set(g.key, (counts.get(g.key) ?? 0) + 1)

      return {
        total: best.size,
        groups: PC_GROUPS.map((g) => ({ key: g.key, label: g.label, n: counts.get(g.key) ?? 0 })),
      }
    })
  }
}
