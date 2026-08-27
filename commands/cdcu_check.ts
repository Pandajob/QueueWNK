import { DateTime } from 'luxon'

import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

import type { SurveilRow } from '#services/cdcu_watcher'

/**
 * ดูว่าข้อความ 506 ที่จะเข้ากลุ่มหน้าตาเป็นอย่างไร และส่งทดสอบได้
 *
 *   docker compose exec web node ace cdcu:check
 *   docker compose exec web node ace cdcu:check --demo
 *   docker compose exec web node ace cdcu:check --demo --send
 *   docker compose exec web node ace cdcu:check --send
 *   docker compose exec web node ace cdcu:check --days 7
 *   docker compose exec web node ace cdcu:check --from 1/8/2569 --to 24/8/2569 --send
 *
 * มีเพราะตัวเฝ้าระวังจะส่งก็ต่อเมื่อมีเคส 506 "แถวใหม่" เข้ามาจริง ๆ
 * ซึ่งบางวันไม่มีเลย และเราไม่เขียนอะไรลง HOSxP เพื่อสร้างเคสปลอมเด็ดขาด
 * ตัวนี้จึงหยิบเคสที่มีอยู่แล้วมาประกอบข้อความด้วยการตั้งค่าชุดเดียวกัน
 *
 * ไม่แตะ watermark และไม่บันทึก cdcu_seen — รันกี่ครั้งก็ไม่ทำให้เคสจริงหาย
 * และไม่ติด throttle กับช่วงงดส่ง เพราะเป็นการสั่งด้วยมือ
 */
export default class CdcuCheck extends BaseCommand {
  static commandName = 'cdcu:check'
  static description = 'ดูและทดสอบส่งข้อความเฝ้าระวังโรค 506'
  static options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'ส่งเข้ากลุ่ม LINE จริง' })
  declare send: boolean

  @flags.boolean({ description: 'ใช้ข้อมูลสมมติแทนเคสจริง' })
  declare demo: boolean

  @flags.number({ description: 'ใช้เคสล่าสุดกี่ราย (ค่าตั้งต้น 3 · ถ้าระบุช่วงวันที่เป็น 200)' })
  declare limit: number

  @flags.number({ description: 'ย้อนหลังกี่วันนับจากวันนี้' })
  declare days: number

  @flags.string({ description: 'ตั้งแต่วันที่ เช่น 1/8/2569 หรือ 2026-08-01' })
  declare from: string

  @flags.string({ description: 'ถึงวันที่ (ค่าตั้งต้นคือวันนี้)' })
  declare to: string

  async run() {
    const { CdcuSetting, NotifyGroup } = await import('#models/notify_system')
    const { CdcuWatcher, revealOf } = await import('#services/cdcu_watcher')
    const { dispatch } = await import('#services/notify_dispatcher')

    const settings = await CdcuSetting.current()
    const reveal = revealOf(settings)
    const watcher = new CdcuWatcher()
    const ranged = Boolean(this.days || this.from || this.to)
    const limit = Math.min(Math.max(this.limit || (ranged ? 200 : 3), 1), 500)

    this.logger.info(
      'ตัวเลือกที่เปิดอยู่: ' +
        [
          `ชื่อ ${reveal.includeName ? 'เปิด' : 'ปิด'}`,
          `HN ${reveal.includeHn ? 'เปิด' : 'ปิด'}`,
          `เบอร์โทร ${reveal.includePhone ? 'เปิด' : 'ปิด'}`,
        ].join(' · ')
    )

    let rows: SurveilRow[]
    let rangeLabel = ''

    if (this.demo) {
      rows = demoRows()
      this.logger.info(`ใช้ข้อมูลสมมติ ${rows.length} ราย`)
    } else if (ranged) {
      let from: string
      let to: string
      try {
        to = this.to ? isoDate(this.to) : DateTime.now().setZone('Asia/Bangkok').toISODate()!
        from = this.from
          ? isoDate(this.from)
          : DateTime.fromISO(to).minus({ days: Math.max(this.days || 7, 1) - 1 }).toISODate()!
      } catch (error) {
        this.logger.error(error.message)
        this.exitCode = 1
        return
      }

      if (from > to) {
        this.logger.error(`ช่วงวันที่กลับหัว — ${from} มาหลัง ${to}`)
        this.exitCode = 1
        return
      }

      const found = await watcher.casesBetween(from, to, limit).catch(() => null)
      if (!found) {
        this.logger.error('อ่านทะเบียน 506 จาก HOSxP ไม่ได้')
        this.exitCode = 1
        return
      }

      rangeLabel = `${thaiDate(from)} – ${thaiDate(to)}`

      // กรองด้วยรายการโรคที่เฝ้าจริง ไม่งั้นตัวอย่างจะไม่ตรงกับที่ระบบจะส่งเอง
      rows = found.filter((row) => settings.watches(row.code506))
      const dropped = found.length - rows.length

      if (!rows.length) {
        this.logger.error(
          `ช่วง ${rangeLabel} ไม่มีเคสที่อยู่ในรายการโรคที่เฝ้า` +
            (dropped ? ` (มี ${dropped} เคสแต่เป็นโรคที่ไม่ได้เฝ้า)` : '')
        )
        this.exitCode = 1
        return
      }

      this.logger.info(
        `ช่วง ${rangeLabel} — ใช้ ${rows.length} ราย` +
          (dropped ? ` ข้าม ${dropped} รายที่ไม่ได้อยู่ในรายการโรคที่เฝ้า` : '') +
          (found.length === limit ? ` (ชนเพดาน ${limit} เพิ่ม --limit ถ้าต้องการมากกว่านี้)` : '')
      )
    } else {
      const recent = await watcher.recentCases(90, limit).catch(() => null)
      if (!recent) {
        this.logger.error('อ่านทะเบียน 506 จาก HOSxP ไม่ได้')
        this.exitCode = 1
        return
      }
      if (!recent.length) {
        this.logger.error('ไม่มีเคส 506 ใน 90 วันล่าสุด — ลอง --demo แทน')
        this.exitCode = 1
        return
      }
      // recentCases เรียงใหม่ไปเก่า พลิกกลับให้เหมือนตอนแจ้งจริงที่ไล่ตาม sv_number
      rows = [...recent].reverse()
      this.logger.info(`ใช้เคสจริงล่าสุด ${rows.length} ราย`)
    }

    if (!this.demo) this.logger.info('ไม่บันทึกว่าแจ้งแล้ว และไม่ขยับตัวนับของตัวเฝ้าระวัง')

    // ย้อนหลังหลายวันมักยาวเกินหนึ่งข้อความ ซอยตามจำนวนเคสจนกว่าจะพอดีเพดาน
    const chunks = chunkRows(rows, (part) => watcher.buildMessage(part, reveal))

    for (const [index, part] of chunks.entries()) {
      const text = watcher.buildMessage(part, reveal)
      this.logger.log('')
      if (chunks.length > 1) this.logger.info(`— ข้อความที่ ${index + 1}/${chunks.length} —`)
      for (const row of text.split('\n')) this.logger.log(`  ${row}`)
    }

    this.logger.log('')
    this.logger.info(
      `รวม ${rows.length} ราย · ${chunks.length} ข้อความ` +
        (chunks.length > 1 ? ' (เพดาน 4,000 ตัวอักษรต่อข้อความ)' : '')
    )

    if (!this.send) {
      this.logger.info('ยังไม่ได้ส่ง — ใส่ --send ถ้าจะส่งเข้ากลุ่มจริง')
      return
    }

    if (!settings.groupId) {
      this.logger.error('ยังไม่ได้เลือกกลุ่ม LINE ในหน้า CDCU')
      this.exitCode = 1
      return
    }

    const group = await NotifyGroup.find(settings.groupId)
    if (!group) {
      this.logger.error(`ไม่พบกลุ่ม id ${settings.groupId}`)
      this.exitCode = 1
      return
    }

    let sent = 0
    for (const [index, part] of chunks.entries()) {
      // ติดป้ายให้ชัดว่าเป็นการทดสอบ ไม่งั้นทีมสอบสวนโรคจะนึกว่ามีเคสใหม่จริง
      const head =
        '🧪 ทดสอบระบบแจ้งเตือน — ไม่ใช่เคสใหม่' +
        (rangeLabel ? `\nเคสย้อนหลังช่วง ${rangeLabel}` : '') +
        (chunks.length > 1 ? `\nข้อความที่ ${index + 1}/${chunks.length}` : '')

      const outcome = await dispatch({
        groups: [group],
        body: `${head}\n\n${watcher.buildMessage(part, reveal)}`,
        source: 'manual',
        subject: rangeLabel ? `ทดสอบ CDCU ย้อนหลัง ${rangeLabel}` : 'ทดสอบข้อความ CDCU',
      })

      if (outcome.sent) sent += 1
      else this.logger.error(`ข้อความที่ ${index + 1} ส่งไม่สำเร็จ`)
    }

    if (sent === chunks.length) {
      this.logger.success(`ส่งเข้ากลุ่ม "${group.name}" แล้ว ${sent} ข้อความ`)
    } else {
      this.logger.error(`ส่งได้ ${sent} จาก ${chunks.length} ข้อความ — ดูสาเหตุที่หน้าประวัติการส่ง`)
      this.exitCode = 1
    }
  }
}

/**
 * รับได้ทั้ง 2026-08-01 และ 1/8/2569 — ทีมงานคิดเป็น พ.ศ. แต่ HOSxP เก็บเป็น ค.ศ.
 * ปีไหนเกิน 2400 ถือว่าเป็น พ.ศ. แล้วลบ 543 ให้
 */
function isoDate(input: string) {
  const text = input.trim()

  const slash = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  const dash = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)

  let year: number
  let month: number
  let day: number

  if (slash) [, day, month, year] = slash.map(Number) as unknown as [never, number, number, number]
  else if (dash) [, year, month, day] = dash.map(Number) as unknown as [never, number, number, number]
  else throw new Error(`อ่านวันที่ "${input}" ไม่ออก — ใช้แบบ 1/8/2569 หรือ 2026-08-01`)

  if (year > 2400) year -= 543

  const date = DateTime.fromObject({ year, month, day }, { zone: 'Asia/Bangkok' })
  if (!date.isValid) throw new Error(`วันที่ "${input}" ไม่มีอยู่จริง`)

  return date.toISODate()!
}

function thaiDate(iso: string) {
  const date = DateTime.fromISO(iso)
  return `${date.day}/${date.month}/${date.year + 543}`
}

/** ซอยรายการเคสให้แต่ละข้อความไม่เกินเพดานที่ dispatcher จะตัดทิ้ง */
function chunkRows(rows: SurveilRow[], build: (part: SurveilRow[]) => string, max = 3800) {
  const chunks: SurveilRow[][] = []
  let current: SurveilRow[] = []

  for (const row of rows) {
    const next = [...current, row]
    if (current.length && [...build(next)].length > max) {
      chunks.push(current)
      current = [row]
    } else {
      current = next
    }
  }

  if (current.length) chunks.push(current)
  return chunks
}

/** ข้อมูลสมมติ ชื่อกับเบอร์ไม่ใช่ของใครจริง ใช้ดูรูปแบบข้อความได้โดยไม่แตะข้อมูลผู้ป่วย */
function demoRows(): SurveilRow[] {
  const base = {
    pdx: 'A90',
    report_date: '2569-01-01',
    vstdate: null,
    ptstat: '1',
    status_name: 'กำลังรักษา',
    last_update: null,
  }

  return [
    {
      ...base,
      sv_number: 900001,
      code506: 66,
      disease_name: 'ไข้เลือดออก',
      hn: '000123456',
      moo: '4',
      tambon: 'ตำบลตัวอย่างหนึ่ง',
      department: 'OPD',
      pname: 'นาย',
      fname: 'ทดสอบ',
      lname: 'ระบบหนึ่ง',
      mobile_phone: '081-000-0001',
      home_phone: null,
    },
    {
      ...base,
      sv_number: 900002,
      code506: 66,
      disease_name: 'ไข้เลือดออก',
      hn: '000987654',
      moo: '2',
      tambon: 'ตำบลตัวอย่างสอง',
      department: 'ER',
      pname: 'นางสาว',
      fname: 'ทดสอบ',
      lname: 'ระบบสอง',
      mobile_phone: null,
      home_phone: '044-000002',
    },
    {
      ...base,
      sv_number: 900003,
      code506: 27,
      disease_name: 'อาหารเป็นพิษ',
      hn: '000555111',
      moo: null,
      tambon: 'ตำบลตัวอย่างสาม',
      department: 'OPD',
      pname: 'เด็กหญิง',
      fname: 'ทดสอบ',
      lname: 'ระบบสาม',
      mobile_phone: '089-000-0003',
      home_phone: null,
    },
  ] as SurveilRow[]
}
