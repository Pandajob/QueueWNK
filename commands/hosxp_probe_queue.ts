import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * ตอบคำถามเดียว: โรงพยาบาลนี้บันทึกการออกคิวไว้ที่ไหน
 *
 * HOSxP มีสองกลไกที่เป็นไปได้ และแต่ละที่ตั้งค่าใช้ไม่เหมือนกัน
 *   1. INSERT แถวใหม่ลง opd_queue ทุกครั้งที่ออกคิว
 *   2. UPDATE ทับบนแถว ovst เดิม (cur_dep / cur_dep_time / oqueue)
 *
 * สองแบบนี้ต้องเขียน poller คนละวิธี แบบแรกตาม id/เวลาที่เพิ่มขึ้นได้
 * แบบสองไม่มีแถวใหม่ให้ตาม ต้องเทียบสถานะกับรอบก่อนหน้า
 *
 *   docker compose run --rm web node ace hosxp:probe-queue
 */
export default class HosxpProbeQueue extends BaseCommand {
  static commandName = 'hosxp:probe-queue'
  static description = 'ตรวจว่าการออกคิวถูกบันทึกไว้ที่ตารางไหน'
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

    // --- 1. opd_queue มีการใช้งานจริงไหม -------------------------------------
    this.logger.info('1) opd_queue วันนี้')
    try {
      show(
        await client.select(
          `SELECT COUNT(*) AS rows_today,
                  MIN(queue_time) AS first_at,
                  MAX(queue_time) AS last_at,
                  COUNT(DISTINCT depcode) AS departments
             FROM opd_queue WHERE queue_date = CURDATE()`
        )
      )
      this.logger.info('   ตัวอย่าง 5 แถวล่าสุด')
      show(
        await client.select(
          `SELECT opd_queue_id, vn, queue_no, queue_time, depcode, next_dep
             FROM opd_queue WHERE queue_date = CURDATE()
            ORDER BY queue_time DESC LIMIT 5`
        )
      )
    } catch (error) {
      this.logger.error(`   อ่านไม่ได้: ${error.message}`)
    }

    // --- 2. ovst เก็บสถานะคิวบนแถว visit ไหม ----------------------------------
    this.logger.info('2) ovst วันนี้ — คิวที่เก็บบนแถว visit')
    try {
      show(
        await client.select(
          `SELECT COUNT(*) AS visits,
                  SUM(CASE WHEN oqueue IS NOT NULL AND oqueue > 0 THEN 1 ELSE 0 END) AS has_oqueue,
                  SUM(CASE WHEN cur_dep IS NOT NULL AND cur_dep <> '' THEN 1 ELSE 0 END) AS has_cur_dep,
                  SUM(CASE WHEN cur_dep_time IS NOT NULL THEN 1 ELSE 0 END) AS has_cur_dep_time,
                  SUM(CASE WHEN main_dep_queue IS NOT NULL AND main_dep_queue > 0 THEN 1 ELSE 0 END) AS has_main_dep_queue,
                  SUM(CASE WHEN rx_queue IS NOT NULL AND rx_queue > 0 THEN 1 ELSE 0 END) AS has_rx_queue
             FROM ovst WHERE vstdate = CURDATE()`
        )
      )
      this.logger.info('   ตัวอย่าง 5 รายล่าสุด')
      show(
        await client.select(
          `SELECT vn, vsttime, oqueue, cur_dep, cur_dep_time, last_dep, main_dep, main_dep_queue
             FROM ovst WHERE vstdate = CURDATE()
            ORDER BY vsttime DESC LIMIT 5`
        )
      )
    } catch (error) {
      this.logger.error(`   อ่านไม่ได้: ${error.message}`)
    }

    // --- 3. คนกำลังรออยู่แต่ละห้องตรวจ ----------------------------------------
    this.logger.info('3) จำนวนคนต่อห้องตรวจวันนี้ (ใช้คำนวณคิวที่รออยู่)')
    try {
      show(
        await client.select(
          `SELECT o.cur_dep, k.department, COUNT(*) AS waiting
             FROM ovst o
             LEFT JOIN kskdepartment k ON k.depcode = o.cur_dep
            WHERE o.vstdate = CURDATE() AND o.cur_dep IS NOT NULL AND o.cur_dep <> ''
            GROUP BY o.cur_dep, k.department
            ORDER BY waiting DESC LIMIT 12`
        )
      )
    } catch (error) {
      this.logger.error(`   อ่านไม่ได้: ${error.message}`)
    }

    // --- 3.5 ovst_queue_server — ตารางที่โรงพยาบาลระบุว่าเก็บเลขคิวจริง --------
    this.logger.info('3.5) ovst_queue_server วันนี้')
    try {
      show(
        await client.select(
          `SELECT COUNT(*) AS rows_today,
                  COUNT(DISTINCT vn) AS distinct_vn,
                  COUNT(DISTINCT dep) AS departments,
                  SUM(CASE WHEN depq IS NOT NULL AND depq <> '' THEN 1 ELSE 0 END) AS has_depq,
                  MIN(time_visit) AS first_at,
                  MAX(time_visit) AS last_at
             FROM ovst_queue_server WHERE date_visit = CURDATE()`
        )
      )

      this.logger.info('   ตัวอย่าง 8 แถวล่าสุด')
      show(
        await client.select(
          `SELECT vn, opdq, depq, dep, opd_dep, status, wait_dep,
                  time_visit, time_visit_opd, station_id, check_in
             FROM ovst_queue_server WHERE date_visit = CURDATE()
            ORDER BY time_visit DESC LIMIT 8`
        )
      )

      this.logger.info('   หนึ่ง visit มีกี่แถว')
      show(
        await client.select(
          `SELECT rows_per_vn, COUNT(*) AS visits FROM (
             SELECT vn, COUNT(*) AS rows_per_vn
               FROM ovst_queue_server WHERE date_visit = CURDATE() GROUP BY vn
           ) t GROUP BY rows_per_vn ORDER BY rows_per_vn`
        )
      )

      this.logger.info('   ค่า status ที่พบ')
      show(
        await client.select(
          `SELECT status, COUNT(*) AS n FROM ovst_queue_server
            WHERE date_visit = CURDATE() GROUP BY status ORDER BY n DESC`
        )
      )

      this.logger.info('   depq เทียบกับ dep')
      show(
        await client.select(
          `SELECT dep, depq, COUNT(*) AS n FROM ovst_queue_server
            WHERE date_visit = CURDATE() GROUP BY dep, depq ORDER BY n DESC LIMIT 12`
        )
      )
    } catch (error) {
      this.logger.error(`   อ่านไม่ได้: ${error.message}`)
    }

    // --- 3.6 ovst_queue_server_time — ประวัติการเคลื่อนย้ายรายจุดบริการ -------
    this.logger.info('3.6) ovst_queue_server_time วันนี้')
    try {
      show(
        await client.select(
          `SELECT COUNT(*) AS rows_today,
                  COUNT(DISTINCT vn) AS distinct_vn,
                  COUNT(DISTINCT station_id) AS stations,
                  SUM(CASE WHEN time_finish IS NULL THEN 1 ELSE 0 END) AS still_open
             FROM ovst_queue_server_time WHERE date_visit = CURDATE()`
        )
      )

      this.logger.info('   หนึ่ง visit มีกี่แถว')
      show(
        await client.select(
          `SELECT rows_per_vn, COUNT(*) AS visits FROM (
             SELECT vn, COUNT(*) AS rows_per_vn
               FROM ovst_queue_server_time WHERE date_visit = CURDATE() GROUP BY vn
           ) t GROUP BY rows_per_vn ORDER BY rows_per_vn`
        )
      )

      this.logger.info('   ตัวอย่างเส้นทางของ visit ที่ผ่านหลายจุด')
      const [busiest] = await client.select<{ vn: string }>(
        `SELECT vn FROM ovst_queue_server_time WHERE date_visit = CURDATE()
          GROUP BY vn ORDER BY COUNT(*) DESC LIMIT 1`
      )
      if (busiest) {
        show(
          await client.select(
            `SELECT vn, station_id, station, dep, depq, stationno, status, time_start, time_finish
               FROM ovst_queue_server_time
              WHERE date_visit = CURDATE() AND vn = ?
              ORDER BY time_start`,
            [busiest.vn]
          )
        )
      }

      this.logger.info('   ค่า status ที่พบ')
      show(
        await client.select(
          `SELECT status, COUNT(*) AS n,
                  SUM(CASE WHEN time_finish IS NULL THEN 1 ELSE 0 END) AS open_rows
             FROM ovst_queue_server_time WHERE date_visit = CURDATE()
            GROUP BY status ORDER BY n DESC`
        )
      )

      this.logger.info('   จุดบริการที่ใช้งานวันนี้')
      show(
        await client.select(
          `SELECT station_id, station, dep, COUNT(*) AS n
             FROM ovst_queue_server_time WHERE date_visit = CURDATE()
            GROUP BY station_id, station, dep ORDER BY n DESC LIMIT 12`
        )
      )
    } catch (error) {
      this.logger.error(`   อ่านไม่ได้: ${error.message}`)
    }

    // --- 4. ตารางคิวอื่นที่อาจถูกใช้แทน ---------------------------------------
    this.logger.info('4) ตารางคิวอื่น — มีข้อมูลวันนี้ไหม')
    const others = [
      ['opd_dep_queue', 'queue_date'],
      ['opd_previsit_queue', 'vstdate'],
      ['ovst_queue_token', 'token_date'],
      ['rx_queue_dispense', 'vstdate'],
    ] as const

    for (const [table, dateColumn] of others) {
      try {
        const [row] = await client.select<{ n: number }>(
          `SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`${dateColumn}\` = CURDATE()`
        )
        this.logger.log(`    ${table}: ${row.n} แถววันนี้`)
      } catch (error) {
        this.logger.log(`    ${table}: ${error.code ?? error.message}`)
      }
    }

    await client.close()
  }
}
