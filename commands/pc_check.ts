import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * ตรวจผู้ป่วยกลุ่มประคับประคองที่ยังไม่เคยแจ้ง แล้วพิมพ์ผลออกมา
 *
 *   docker compose exec web node ace pc:check
 *   docker compose exec web node ace pc:check --days 30
 *   docker compose exec web node ace pc:check --seed    (รับทราบรายเดิม ไม่ส่ง)
 *   docker compose exec web node ace pc:check --send    (ส่งเข้ากลุ่มจริง)
 *   docker compose exec web node ace pc:check --visits  (กวาดการมา รพ. ลง pc_visits)
 *
 * ไว้ตรวจว่าเกณฑ์ที่ตั้งไว้ให้ผลอย่างที่คิดก่อนเปิดใช้งานอัตโนมัติ
 */
export default class PcCheck extends BaseCommand {
  static commandName = 'pc:check'
  static description = 'ตรวจผู้ป่วยกลุ่มประคับประคองที่เข้าเกณฑ์และยังไม่เคยแจ้ง'
  static options: CommandOptions = { startApp: true }

  @flags.number({ description: 'ย้อนหลังกี่วัน (ไม่ใส่ = ใช้ค่าที่ตั้งไว้ในหน้าเว็บ)' })
  declare days?: number

  @flags.boolean({ description: 'รับทราบรายเดิมทั้งหมดโดยไม่ส่งแจ้งเตือน' })
  declare seed: boolean

  @flags.boolean({ description: 'ส่งเข้ากลุ่ม LINE จริง' })
  declare send: boolean

  @flags.boolean({ description: 'กวาดการมาโรงพยาบาลของผู้ป่วยในทะเบียนลง pc_visits' })
  declare visits: boolean

  async run() {
    const { PcSetting } = await import('#models/notify_system')
    const { PcWatcher } = await import('#services/pc_watcher')

    const settings = await PcSetting.current()
    const watcher = new PcWatcher()

    if (this.visits) {
      const result = await watcher.syncVisits()
      if (result.note) this.logger.warning(result.note)
      else {
        this.logger.success(
          `กวาด ${result.patients} ราย · มา รพ. ${result.visits} ครั้ง · HOSxP บันทึกเสียชีวิต ${result.deaths} ราย`
        )
      }
      return
    }

    if (this.seed) {
      const marked = await watcher.seed(settings)
      this.logger.success(`รับทราบผู้ป่วยเดิม ${marked} ราย แล้ว — ไม่ได้ส่งข้อความออกไป`)
      return
    }

    if (this.send) {
      if (!settings.groupId) {
        this.logger.error('ยังไม่ได้เลือกกลุ่ม LINE ในหน้าตั้งค่า')
        this.exitCode = 1
        return
      }
      const result = await watcher.runNow(settings)
      if (result.note) this.logger.error(result.note)
      else this.logger.success(`พบ ${result.found} ราย · ส่ง ${result.sent}`)
      return
    }

    const rows = await watcher.findNew(settings, this.days).catch(() => null)
    if (rows === null) {
      this.logger.error('อ่านข้อมูลจาก HOSxP ไม่ได้')
      this.exitCode = 1
      return
    }

    if (!settings.seeded) {
      this.logger.warning(
        'ยังไม่ได้รับทราบผู้ป่วยเดิม — ตัวเลขข้างล่างคือผู้ป่วยทั้งหมดที่เข้าเกณฑ์ ไม่ใช่รายใหม่'
      )
    }

    if (!rows.length) {
      this.logger.info('ไม่มีผู้ป่วยรายใหม่ในช่วงนี้')
      return
    }

    this.logger.info(`พบ ${rows.length} ราย (ย้อนหลัง ${this.days ?? settings.lookbackDays} วัน)`)

    const byGroup = new Map<string, number>()
    for (const row of rows) {
      byGroup.set(row.group.label, (byGroup.get(row.group.label) ?? 0) + 1)
    }

    for (const [label, n] of [...byGroup.entries()].sort((a, b) => b[1] - a[1])) {
      this.logger.log(`    ${label.padEnd(36)} ${n}`)
    }

    this.logger.log('')
    for (const row of rows.slice(0, 20)) {
      const name = [row.pname, row.fname, row.lname].filter(Boolean).join('')
      this.logger.log(
        `    ${row.hn}  ${row.icd10.padEnd(6)} ${row.group.label.padEnd(30)} ` +
          `${row.src}  ${name}  ${row.hospsub_name ?? ''}`
      )
    }
    if (rows.length > 20) this.logger.log(`    … และอีก ${rows.length - 20} ราย`)
  }
}
