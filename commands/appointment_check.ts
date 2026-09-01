import { DateTime } from 'luxon'

import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

import type { AppointmentRow } from '#services/appointment_reminder'

/**
 * ดูว่าข้อความแจ้งเตือนนัดที่จะส่งถึงผู้ป่วยหน้าตาเป็นอย่างไร
 *
 *   docker compose exec web node ace appointment:check
 *   docker compose exec web node ace appointment:check --days 3
 *   docker compose exec web node ace appointment:check --date 5/9/2569
 *   docker compose exec web node ace appointment:check --queue
 *
 * ตั้งต้นเป็นการดูอย่างเดียว ไม่เขียนอะไรและไม่ส่งอะไรทั้งสิ้น
 * ใส่ --queue ถึงจะตั้งคิวข้อความจริง ซึ่งตัวส่งของ queue:watch จะหยิบไปส่ง
 * (ถ้า dry run ยังเปิดอยู่ก็ยังไม่ถึงผู้ป่วย)
 */
export default class AppointmentCheck extends BaseCommand {
  static commandName = 'appointment:check'
  static description = 'ดูข้อความแจ้งเตือนนัดหมายก่อนเปิดใช้จริง'
  static options: CommandOptions = { startApp: true }

  @flags.number({ description: 'ล่วงหน้ากี่วันนับจากวันนี้ (ค่าตั้งต้นตามที่ตั้งไว้ในระบบ)' })
  declare days: number

  @flags.string({ description: 'ระบุวันนัดตรง ๆ เช่น 5/9/2569 หรือ 2026-09-05' })
  declare date: string

  @flags.number({ description: 'ดูกี่ราย (ค่าตั้งต้น 3)', default: 3 })
  declare limit: number

  @flags.boolean({ description: 'ตั้งคิวข้อความจริง ไม่ใช่แค่ดู' })
  declare queue: boolean

  async run() {
    const { default: AppointmentSetting } = await import('#models/appointment')
    const { AppointmentReminder, timeLabel } = await import('#services/appointment_reminder')

    const settings = await AppointmentSetting.current()
    const reminder = new AppointmentReminder()

    let target: string
    try {
      target = this.date
        ? isoDate(this.date)
        : DateTime.now()
            .setZone('Asia/Bangkok')
            .plus({ days: this.days ?? settings.daysAhead })
            .toISODate()!
    } catch (error) {
      this.logger.error(error.message)
      this.exitCode = 1
      return
    }

    this.logger.info(
      [
        `สถานะ ${settings.isEnabled ? 'เปิดใช้งาน' : 'ปิดอยู่'}`,
        `dry run ${settings.dryRun ? 'เปิด' : 'ปิด'}`,
        `ส่งเวลา ${settings.sendAt}`,
        `ล่วงหน้า ${settings.daysAhead} วัน`,
        settings.allClinics ? 'ทุกคลินิก' : `เลือก ${(settings.clinicCodes ?? []).length} คลินิก`,
      ].join(' · ')
    )

    const rows = await reminder.fetch(target).catch(() => null)
    if (!rows) {
      this.logger.error('อ่านนัดหมายจาก HOSxP ไม่ได้ — ตรวจการตั้งค่าที่ /settings/hosxp')
      this.exitCode = 1
      return
    }

    if (!rows.length) {
      this.logger.warning(`วันที่ ${target} ไม่มีนัดเลย`)
      return
    }

    const watched = rows.filter((r) => settings.watches(r.clinic))
    const noTime = rows.filter((r) => !timeLabel(r.nexttime)).length

    this.logger.info(
      `วันที่ ${target} — นัดทั้งหมด ${rows.length} ราย · อยู่ในคลินิกที่เปิดไว้ ${watched.length} ราย` +
        (noTime ? ` · ไม่ระบุเวลา ${noTime} ราย` : '')
    )

    this.#byClinic(rows)

    // แสดงตัวอย่างข้อความ ปิดบังชื่อไว้ ไม่ให้ข้อมูลผู้ป่วยไหลลง log
    const sample = watched.slice(0, Math.max(this.limit, 1))
    for (const row of sample) {
      const message = reminder.build(row, settings, target)
      this.logger.log('')
      this.logger.info(`— HN ${maskHn(row.hn)} · ${row.clinic_name ?? '?'} —`)
      this.logger.log(`  หัวข้อ : ${message.title}`)
      for (const line of message.text.split('\n')) this.logger.log(`  ข้อความ: ${line}`)
    }

    if (!this.queue) {
      this.logger.log('')
      this.logger.info('ยังไม่ได้ตั้งคิวอะไร — ใส่ --queue ถ้าจะให้ส่งจริงตามการตั้งค่า')
      return
    }

    const result = await reminder.queueAll(watched, settings, target)
    this.logger.success(
      `ตั้งคิวแล้ว ${result.queued} รายการ · ข้าม ${result.skipped} (ตั้งคิวไว้แล้วหรือคลินิกไม่ได้เปิด)`
    )
    this.logger.info(
      settings.dryRun
        ? 'dry run เปิดอยู่ — ตัวส่งจะบันทึกว่าข้ามไป ไม่มีข้อความถึงผู้ป่วย'
        : '⚠️ dry run ปิดอยู่ — queue:watch จะส่งถึงผู้ป่วยจริงภายในไม่กี่วินาที'
    )
  }

  #byClinic(rows: AppointmentRow[]) {
    const count = new Map<string, number>()
    for (const row of rows) {
      const key = row.clinic_name?.trim() || '(ไม่ระบุคลินิก)'
      count.set(key, (count.get(key) ?? 0) + 1)
    }
    const sorted = [...count.entries()].sort((a, b) => b[1] - a[1])
    for (const [name, n] of sorted) this.logger.log(`  ${String(n).padStart(4)}  ${name}`)
  }
}

/** ปิดบัง HN ใน log — ไม่จำเป็นต้องเห็นเต็มเพื่อตรวจข้อความ */
function maskHn(hn: string) {
  return hn.length <= 3 ? hn : `${'*'.repeat(hn.length - 3)}${hn.slice(-3)}`
}

/** รับได้ทั้ง 2026-09-05 และ 5/9/2569 — ปีเกิน 2400 ถือว่าเป็น พ.ศ. */
function isoDate(input: string) {
  const text = input.trim()
  const slash = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  const dash = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)

  let year: number
  let month: number
  let day: number

  if (slash) {
    day = Number(slash[1])
    month = Number(slash[2])
    year = Number(slash[3])
  } else if (dash) {
    year = Number(dash[1])
    month = Number(dash[2])
    day = Number(dash[3])
  } else {
    throw new Error(`อ่านวันที่ "${input}" ไม่ออก — ใช้รูปแบบ 5/9/2569 หรือ 2026-09-05`)
  }

  if (year > 2400) year -= 543

  const parsed = DateTime.fromObject({ year, month, day }, { zone: 'Asia/Bangkok' })
  if (!parsed.isValid) throw new Error(`วันที่ "${input}" ไม่มีอยู่จริง`)
  return parsed.toISODate()!
}
