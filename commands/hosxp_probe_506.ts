import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * สำรวจว่าทะเบียนรายงาน 506 (เฝ้าระวังโรคติดต่อ) ของโรงพยาบาลนี้อยู่ที่ไหน
 * และหน้า CDCU ควรอ่านคอลัมน์อะไร
 *
 * ไม่เดาชื่อตารางล่วงหน้า — ไล่จาก SHOW TABLES แล้วดูว่าอันไหนมีข้อมูลจริง
 * เพราะ HOSxP แต่ละที่เปิดใช้โมดูลไม่เหมือนกัน (ตอนสำรวจคิวก็เจอว่า
 * opd_queue มี 0 แถว ทั้งที่เป็นตารางมาตรฐาน)
 *
 *   docker compose run --rm web node ace hosxp:probe-506
 */
export default class HosxpProbe506 extends BaseCommand {
  static commandName = 'hosxp:probe-506'
  static description = 'สำรวจทะเบียนรายงาน 506 สำหรับหน้า CDCU'
  static options: CommandOptions = { startApp: true }

  async run() {
    const { default: HosxpConnection } = await import('#models/hosxp_connection')
    const { HosxpClient } = await import('#services/hosxp_client')

    const settings = await HosxpConnection.active()
    if (!settings?.password) {
      this.logger.error('ยังไม่ได้ตั้งค่าการเชื่อมต่อ HOSxP')
      this.exitCode = 1
      return
    }

    const client = await HosxpClient.connect({
      host: settings.host,
      port: settings.port,
      database: settings.database,
      username: settings.username,
      password: settings.password,
      charset: settings.charset,
    })

    const show = (rows: Record<string, unknown>[]) => {
      if (!rows.length) {
        this.logger.log('    (ไม่มีข้อมูล)')
        return
      }
      for (const row of rows) {
        this.logger.log(
          '    ' +
            Object.entries(row)
              .map(([k, v]) => `${k}=${v ?? 'NULL'}`)
              .join('  ')
        )
      }
    }

    try {
      // --- 1. ตารางที่ชื่อเกี่ยวกับ 506 / epidem ---------------------------
      this.logger.info('1) ตารางที่ชื่อเข้าข่าย')

      const raw = await client.select<Record<string, string>>('SHOW TABLES')
      const all = raw.map((r) => Object.values(r)[0])
      const candidates = all.filter((t) => /506|epidem|surveil|notifi.*dis/i.test(t))

      this.logger.log(`    พบ ${candidates.length} ตาราง จากทั้งหมด ${all.length}`)
      for (const table of candidates) this.logger.log(`      ${table}`)

      // --- 2. ตารางไหนมีข้อมูลจริง ----------------------------------------
      this.logger.info('2) จำนวนแถวของแต่ละตาราง')

      const live: string[] = []
      for (const table of candidates) {
        try {
          const [row] = await client.select<{ n: number }>(
            `SELECT COUNT(*) AS n FROM \`${table}\``
          )
          this.logger.log(`    ${table}: ${row.n}`)
          if (Number(row.n) > 0) live.push(table)
        } catch (error) {
          this.logger.log(`    ${table}: อ่านไม่ได้ — ${error.code ?? error.message}`)
        }
      }

      // --- 3. โครงสร้างและข้อมูลล่าสุดของตารางที่มีข้อมูล -------------------
      for (const table of live) {
        this.logger.info(`3) ${table} — คอลัมน์`)
        const columns = await client.select<{ Field: string; Type: string; Key: string }>(
          `SHOW COLUMNS FROM \`${table}\``
        )
        this.logger.log(
          '    ' +
            columns
              .map((c) => `${c.Field}:${c.Type}${c.Key ? `(${c.Key})` : ''}`)
              .join('  ')
        )

        // หาคอลัมน์วันที่ไว้เรียงลำดับ — ชื่อไม่เหมือนกันทุกตาราง
        const dateColumn = columns.find((c) =>
          /^(report_date|date_report|vstdate|date|onset_date|create_date|d_date)$/i.test(c.Field)
        )?.Field

        if (dateColumn) {
          this.logger.info(`   ช่วงเวลาใน ${dateColumn}`)
          show(
            await client.select(
              `SELECT MIN(\`${dateColumn}\`) AS first_at,
                      MAX(\`${dateColumn}\`) AS last_at,
                      SUM(CASE WHEN \`${dateColumn}\` >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                               THEN 1 ELSE 0 END) AS last_30_days,
                      SUM(CASE WHEN \`${dateColumn}\` = CURDATE() THEN 1 ELSE 0 END) AS today
                 FROM \`${table}\``
            )
          )

          this.logger.info('   5 แถวล่าสุด')
          show(
            await client.select(
              `SELECT * FROM \`${table}\` ORDER BY \`${dateColumn}\` DESC LIMIT 5`
            )
          )
        } else {
          this.logger.info('   5 แถวแรก (ไม่พบคอลัมน์วันที่ที่รู้จัก)')
          show(await client.select(`SELECT * FROM \`${table}\` LIMIT 5`))
        }
      }
    } catch (error) {
      this.logger.error(`สำรวจไม่สำเร็จ: ${error.message}`)
      this.exitCode = 1
    } finally {
      await client.close()
    }
  }
}
