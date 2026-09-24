import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * ดูว่าข้อความแจ้งเตือนความดันสูงที่จะเข้ากลุ่มหน้าตาเป็นอย่างไร
 *
 *   docker compose exec web node ace vitals:check
 *   docker compose exec web node ace vitals:check --sys 180 --dia 120
 *   docker compose exec web node ace vitals:check --volume
 *
 * ดูอย่างเดียว ไม่ส่งอะไรและไม่เขียน vitals_seen — รันกี่ครั้งก็ได้
 * ให้ตัวจริงทำงานโดยเปิดใช้งานในหน้าเว็บแล้วปล่อยให้ notify:watch ทำรอบเอง
 */
export default class VitalsCheck extends BaseCommand {
  static commandName = 'vitals:check'
  static description = 'ดูข้อความแจ้งเตือนความดันสูงก่อนเปิดใช้จริง'
  static options: CommandOptions = { startApp: true }

  @flags.number({ description: 'เกณฑ์ค่าบน (ค่าตั้งต้นตามที่ตั้งไว้ในระบบ)' })
  declare sys: number

  @flags.number({ description: 'เกณฑ์ค่าล่าง (ค่าตั้งต้นตามที่ตั้งไว้ในระบบ)' })
  declare dia: number

  @flags.boolean({ description: 'แสดงเฉพาะจำนวนรายต่อวันที่แต่ละเกณฑ์' })
  declare volume: boolean

  /**
   * ย้อนดูข้อความของช่วงที่ผ่านมาแล้ว โดยไม่แตะสถานะการส่ง
   *
   * ช่วงปกติคือ "ตั้งแต่รอบที่แล้ว" ซึ่งหลังส่งไปแล้วจะเหลือไม่กี่นาที
   * ทำให้ดูตัวอย่างข้อความไม่ได้ แฟล็กนี้ย้อนกลับไปตามจำนวนชั่วโมงที่ระบุแทน
   */
  @flags.number({ description: 'ย้อนดูข้อความของกี่ชั่วโมงที่ผ่านมา (ไม่ส่งอะไรทั้งสิ้น)' })
  declare hours: number

  async run() {
    const { VitalsSetting } = await import('#models/notify_system')
    const { VitalsWatcher } = await import('#services/vitals_watcher')

    const settings = await VitalsSetting.current()
    const watcher = new VitalsWatcher()

    if (this.sys) settings.sysThreshold = this.sys
    if (this.dia) settings.diaThreshold = this.dia

    if (this.volume) {
      this.logger.info('จำนวนรายต่อวัน ย้อนหลัง 30 วัน')
      for (const [sys, dia] of [
        [140, 90],
        [160, 100],
        [180, 120],
      ]) {
        const rows = await watcher.volumeAtThreshold(sys, dia)
        const row = rows?.[0]
        this.logger.log(
          `  ${sys}/${dia}  →  ${row?.per_day ?? '?'} ราย/วัน (รวม ${row?.total ?? '?'})`
        )
      }
      return
    }

    const { DateTime } = await import('luxon')
    const now = DateTime.now().setZone('Asia/Bangkok')
    const { from, to } = this.hours
      ? { from: now.minus({ hours: this.hours }), to: now }
      : watcher.windowFor(settings, now)
    const cases = await watcher.fetch(settings, from, to).catch(() => null)

    if (!cases) {
      this.logger.error('อ่านข้อมูลจาก HOSxP ไม่ได้')
      this.exitCode = 1
      return
    }

    const watched = cases.filter((row) => settings.watches(row.dep))

    this.logger.info(
      `ช่วง ${from.toFormat('dd/MM HH:mm')} – ${to.toFormat('dd/MM HH:mm')} น. · ` +
        `เกณฑ์ บน>${settings.sysThreshold} หรือ ล่าง>${settings.diaThreshold} · ` +
        `เข้าเกณฑ์ ${cases.length} ราย` +
        (settings.allDepartments ? '' : ` · อยู่ในแผนกที่เฝ้า ${watched.length} ราย`)
    )

    if (!watched.length) {
      this.logger.info('ไม่มีรายที่เข้าเกณฑ์ — ไม่มีข้อความให้แสดง')
      return
    }

    const { blocksToPlainText, buildFlexMessages } = await import('#services/flex_builder')
    const { PURPLE } = await import('#services/vitals_watcher')

    const batches = watcher.batchesFor(watched)
    this.logger.info(`จะส่ง ${batches.length} ข้อความ แยกตามสถานพยาบาลรอง`)

    for (const [index, batch] of batches.entries()) {
      const blocks = watcher.flexBlocksFor(batch, settings, from, to)
      const flex = buildFlexMessages(batch.title, blocks, PURPLE)
      const json = JSON.stringify(flex)

      this.logger.log('')
      this.logger.log(
        `━━━ ข้อความที่ ${index + 1}/${batches.length} · ${batch.title} · ` +
          `${batch.rows.length} ราย · การ์ด ${flex.length} ใบ · Flex ${json.length} bytes ━━━`
      )
      this.logger.log(blocksToPlainText(blocks))
    }

    this.logger.log('')
    this.logger.info('ข้อความข้างบนยังไม่ได้ส่งไปไหน (แสดงเป็นข้อความสำรองของการ์ด Flex)')
  }
}
