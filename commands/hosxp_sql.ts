import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * วิ่ง SELECT กับ HOSxP จากบรรทัดคำสั่ง — เอาไว้สำรวจตอนออกแบบชุดข้อมูล
 *
 * ผ่าน HosxpClient เหมือนทุกที่ จึงเขียนอะไรลงฐานโรงพยาบาลไม่ได้
 *
 *   docker compose exec web node ace hosxp:sql "SELECT COUNT(*) n FROM ovst"
 */
export default class HosxpSql extends BaseCommand {
  static commandName = 'hosxp:sql'
  static description = 'วิ่งคำสั่งอ่านข้อมูลกับ HOSxP หนึ่งคำสั่ง'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'คำสั่ง SELECT' })
  declare sql: string

  async run() {
    const { withHosxp } = await import('#services/hosxp_session')
    const { runDatasetSql } = await import('#services/dataset_runner')

    try {
      const result = await withHosxp((client) => runDatasetSql(client, this.sql))

      if (!result) {
        this.logger.error('ยังไม่ได้ตั้งค่าการเชื่อมต่อ HOSxP')
        this.exitCode = 1
        return
      }

      this.logger.info(`${result.rows.length} แถว · ${result.durationMs} ms`)
      for (const row of result.rows) {
        this.logger.log(
          '  ' +
            Object.entries(row)
              .map(([k, v]) => `${k}=${v ?? 'NULL'}`)
              .join('  ')
        )
      }
      if (result.truncated) this.logger.warning('ผลลัพธ์ถูกตัด — มีมากกว่าที่แสดง')
    } catch (error) {
      this.logger.error(error.message)
      this.exitCode = 1
    }
  }
}
