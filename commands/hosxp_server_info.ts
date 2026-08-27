import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { DateTime } from 'luxon'

/**
 * ตอบว่าเครื่องที่ต่ออยู่เป็น master หรือ replica และ query ของเราหนักแค่ไหน
 * ใช้ตัดสินใจว่าจะชี้ไปเครื่องหลักหรือเครื่องสำรอง
 *
 *   docker compose run --rm web node ace hosxp:server-info
 */
export default class HosxpServerInfo extends BaseCommand {
  static commandName = 'hosxp:server-info'
  static description = 'ตรวจว่าเป็น master หรือ replica และวัดต้นทุน query ของ poller'
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

    this.logger.info(`เครื่อง ${settings.host}:${settings.port}`)

    // --- master หรือ replica ------------------------------------------------
    const vars = await client.select<{ Variable_name: string; Value: string }>(
      `SHOW VARIABLES WHERE Variable_name IN
       ('read_only','super_read_only','server_id','log_bin','hostname','max_connections')`
    )
    for (const v of vars) {
      this.logger.log(`    ${v.Variable_name} = ${v.Value}`)
    }

    const readOnly = vars.find((v) => v.Variable_name === 'read_only')?.Value
    this.logger.info(
      readOnly === 'ON'
        ? '  → read_only = ON ปกติหมายถึงเครื่องนี้เป็น replica'
        : '  → read_only = OFF ปกติหมายถึงเครื่องนี้เป็นเครื่องหลักที่รับการเขียน'
    )

    // ต้องมีสิทธิ์ REPLICATION CLIENT ซึ่ง user แบบ SELECT อย่างเดียวไม่มี
    try {
      const slave = await client.select(`SHOW SLAVE STATUS`)
      if (slave.length) {
        const row = slave[0] as Record<string, unknown>
        this.logger.log(`    Master_Host = ${row.Master_Host}`)
        this.logger.log(`    Slave_IO_Running = ${row.Slave_IO_Running}`)
        this.logger.log(`    Slave_SQL_Running = ${row.Slave_SQL_Running}`)
        this.logger.log(`    Seconds_Behind_Master = ${row.Seconds_Behind_Master}`)
      } else {
        this.logger.log('    SHOW SLAVE STATUS ว่าง — ไม่ได้เป็น replica ของใคร')
      }
    } catch (error) {
      this.logger.log(`    SHOW SLAVE STATUS: ${error.code ?? error.message} (ต้องมีสิทธิ์ REPLICATION CLIENT)`)
    }

    // --- ต้นทุน query ที่ poller ใช้จริง ---------------------------------------
    this.logger.info('ต้นทุน query ที่ poller ยิงทุก 15 วินาที')

    const timed = async (label: string, run: () => Promise<unknown>) => {
      const started = Date.now()
      try {
        const result = (await run()) as unknown[]
        const rows = Array.isArray(result) ? result.length : 0
        this.logger.log(`    ${label}: ${Date.now() - started} ms (${rows} แถว)`)
      } catch (error) {
        this.logger.log(`    ${label}: ล้มเหลว ${error.message}`)
      }
    }

    const now = DateTime.now().setZone('Asia/Bangkok')
    const prefix = `${String((now.year + 543) % 100).padStart(2, '0')}${now.toFormat('MMdd')}`

    const selectClause = `SELECT q.vn, q.hn, q.fullname, q.depq, q.dep, q.opd_dep, q.status,
              q.time_visit, q.time_visit_opd, k.department AS dep_name
         FROM ovst_queue_server q
         LEFT JOIN kskdepartment k ON k.depcode = q.dep`

    for (const round of [1, 2, 3]) {
      await timed(`รอบ ${round} — กรองด้วย date_visit (ไม่มี index)`, () =>
        client.select(`${selectClause} WHERE q.date_visit = CURDATE() ORDER BY q.time_visit`)
      )
      await timed(`รอบ ${round} — กรองด้วยช่วง vn (PK)`, () =>
        client.select(
          `${selectClause} WHERE q.vn >= ? AND q.vn <= ? AND q.date_visit = CURDATE()
            ORDER BY q.time_visit`,
          [`${prefix}000000`, `${prefix}999999`]
        )
      )
    }

    await timed('อ่าน cid จาก hn หนึ่งราย', () =>
      client.select(`SELECT cid FROM patient WHERE hn = ? LIMIT 1`, ['000000000'])
    )

    // --- ตารางที่เราแตะใหญ่แค่ไหน ---------------------------------------------
    this.logger.info('ขนาดตารางที่เกี่ยวข้อง')
    try {
      const sizes = await client.select(
        `SELECT TABLE_NAME, TABLE_ROWS,
                ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024) AS mb
           FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('ovst_queue_server','patient','ovst')`,
        [settings.database]
      )
      for (const s of sizes as Record<string, unknown>[]) {
        this.logger.log(`    ${s.TABLE_NAME}: ~${s.TABLE_ROWS} แถว, ${s.mb} MB`)
      }
    } catch (error) {
      this.logger.log(`    อ่านขนาดไม่ได้: ${error.message}`)
    }

    // --- พิสูจน์ว่า vn ใช้แทน date_visit ได้ไหม ---------------------------------
    //
    // date_visit ไม่มี index การกรองด้วยมันคือ full scan ทุกรอบ
    // vn เป็น PK และดูเหมือนเป็น YYMMDDHHMMSS (พ.ศ.) ถ้าจริงก็ใช้ range scan ได้
    // แต่ถ้าเดาผิดจะพลาดคิวแบบเงียบ ๆ จึงต้องนับเทียบกันก่อน
    this.logger.info('พิสูจน์ว่า vn สอดคล้องกับ date_visit ทุกวันไหม')
    try {
      const compare = await client.select<{
        d: string
        by_date: number
        by_vn: number
      }>(
        `SELECT DATE(date_visit) AS d,
                COUNT(*) AS by_date,
                SUM(CASE WHEN vn >= CONCAT(
                      LPAD(MOD(YEAR(date_visit) + 543, 100), 2, '0'),
                      DATE_FORMAT(date_visit, '%m%d'), '000000')
                     AND vn <  CONCAT(
                      LPAD(MOD(YEAR(date_visit) + 543, 100), 2, '0'),
                      DATE_FORMAT(date_visit, '%m%d'), '999999')
                    THEN 1 ELSE 0 END) AS by_vn
           FROM ovst_queue_server
          WHERE date_visit >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
          GROUP BY DATE(date_visit)
          ORDER BY d DESC`
      )

      let mismatch = 0
      for (const row of compare) {
        const ok = Number(row.by_date) === Number(row.by_vn)
        if (!ok) mismatch++
        this.logger.log(
          `    ${row.d}: date_visit=${row.by_date} vn-range=${row.by_vn} ${ok ? 'ตรงกัน' : '← ไม่ตรง'}`
        )
      }

      this.logger.info(
        mismatch === 0
          ? '  → ทุกวันตรงกัน ใช้ vn range scan แทนได้อย่างปลอดภัย'
          : `  → มี ${mismatch} วันที่ไม่ตรง ห้ามใช้ vn แทน date_visit`
      )
    } catch (error) {
      this.logger.log(`    เทียบไม่ได้: ${error.message}`)
    }

    // --- index บนคอลัมน์ที่เรากรอง ---------------------------------------------
    this.logger.info('index ของ ovst_queue_server')
    try {
      const indexes = await client.select(`SHOW INDEX FROM ovst_queue_server`)
      for (const i of indexes as Record<string, unknown>[]) {
        this.logger.log(`    ${i.Key_name} (${i.Seq_in_index}) → ${i.Column_name}`)
      }
    } catch (error) {
      this.logger.log(`    อ่าน index ไม่ได้: ${error.message}`)
    }

    await client.close()
  }
}
