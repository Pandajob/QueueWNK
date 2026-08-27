import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { DateTime } from 'luxon'

/**
 * เทียบเครื่องฐานข้อมูลหลายเครื่องเคียงข้างกัน เพื่อตัดสินใจว่าจะชี้ poller ไปที่ไหน
 *
 * ใช้ user/รหัสเดียวกับที่ตั้งไว้ในหน้าเว็บ เปลี่ยนแค่ host
 *
 *   docker compose run --rm web node ace hosxp:compare-hosts --hosts=192.0.2.11,192.0.2.12
 *
 * ตัวเลขที่สำคัญที่สุดคือ "ข้อมูลล่าสุด" — ถ้าเครื่องหนึ่งมีคิวใหม่กว่าอีกเครื่อง
 * ส่วนต่างนั้นคือ replication lag ที่จะทำให้แจ้งเตือนช้าไปเท่านั้นวินาที
 */
export default class HosxpCompareHosts extends BaseCommand {
  static commandName = 'hosxp:compare-hosts'
  static description = 'เทียบเครื่องฐานข้อมูลหลายเครื่อง — ตัวตน ความสด และความเร็ว'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'รายชื่อ host คั่นด้วย , (ไม่ระบุ = ใช้เครื่องที่ตั้งค่าไว้)' })
  declare hosts?: string

  @flags.number({ description: 'จำนวนรอบที่วัดความเร็ว', default: 3 })
  declare rounds: number

  async run() {
    const { default: HosxpConnection } = await import('#models/hosxp_connection')
    const { HosxpClient } = await import('#services/hosxp_client')
    const { vnGapSeconds } = await import('#services/db_sync_checker')

    const settings = await HosxpConnection.active()
    if (!settings?.password) {
      this.logger.error('ยังไม่ได้ตั้งค่าการเชื่อมต่อ HOSxP')
      this.exitCode = 1
      return
    }

    const hosts = this.hosts
      ? this.hosts
          .split(',')
          .map((h) => h.trim())
          .filter(Boolean)
      : [settings.host]

    const now = DateTime.now().setZone('Asia/Bangkok')
    const prefix = `${String((now.year + 543) % 100).padStart(2, '0')}${now.toFormat('MMdd')}`
    const range = [`${prefix}000000`, `${prefix}999999`]

    type Report = {
      host: string
      hostname?: string
      serverId?: string
      readOnly?: string
      logBin?: string
      rowsToday?: number
      latestVn?: string
      latestTime?: string
      dbNow?: string
      medianMs?: number
      error?: string
    }

    const reports: Report[] = []

    for (const host of hosts) {
      const report: Report = { host }

      let client: InstanceType<typeof HosxpClient> | null = null
      try {
        client = await HosxpClient.connect({
          host,
          port: settings.port,
          database: settings.database,
          username: settings.username,
          password: settings.password,
          charset: settings.charset,
        })
      } catch (error) {
        report.error = `${error.code ?? ''} ${error.message}`.trim()
        reports.push(report)
        continue
      }

      try {
        const vars = await client.select<{ Variable_name: string; Value: string }>(
          `SHOW VARIABLES WHERE Variable_name IN ('hostname','server_id','read_only','log_bin')`
        )
        const get = (n: string) => vars.find((v) => v.Variable_name === n)?.Value
        report.hostname = get('hostname')
        report.serverId = get('server_id')
        report.readOnly = get('read_only')
        report.logBin = get('log_bin')

        // ความสดของข้อมูล — ตัวชี้วัดที่ตัดสินใจได้จริง
        const [fresh] = await client.select<{
          n: number
          latest_vn: string | null
          latest_time: string | null
          db_now: string
        }>(
          `SELECT COUNT(*) AS n,
                  MAX(vn) AS latest_vn,
                  MAX(time_visit) AS latest_time,
                  NOW() AS db_now
             FROM ovst_queue_server
            WHERE vn >= ? AND vn <= ? AND date_visit = CURDATE()`,
          range
        )
        report.rowsToday = Number(fresh.n)
        report.latestVn = fresh.latest_vn ?? undefined
        report.latestTime = fresh.latest_time ?? undefined
        report.dbNow = fresh.db_now

        // ความเร็วของ query ที่ poller ใช้จริง
        const timings: number[] = []
        for (let i = 0; i < this.rounds; i++) {
          const started = Date.now()
          await client.select(
            `SELECT q.vn, q.hn, q.fullname, q.depq, q.dep, q.opd_dep, q.status,
                    q.time_visit, q.time_visit_opd, k.department AS dep_name
               FROM ovst_queue_server q
               LEFT JOIN kskdepartment k ON k.depcode = q.dep
              WHERE q.vn >= ? AND q.vn <= ? AND q.date_visit = CURDATE()
              ORDER BY q.time_visit`,
            range
          )
          timings.push(Date.now() - started)
        }
        timings.sort((a, b) => a - b)
        report.medianMs = timings[Math.floor(timings.length / 2)]
      } catch (error) {
        report.error = error.message
      } finally {
        await client.close()
      }

      reports.push(report)
    }

    // --- แสดงผล -------------------------------------------------------------
    for (const r of reports) {
      this.logger.info(`${r.host}`)
      if (r.error) {
        this.logger.log(`    ต่อไม่ได้: ${r.error}`)
        continue
      }
      this.logger.log(`    hostname       = ${r.hostname}`)
      this.logger.log(`    server_id      = ${r.serverId}`)
      this.logger.log(
        `    read_only      = ${r.readOnly}  ${r.readOnly === 'ON' ? '(replica)' : '(รับการเขียน)'}`
      )
      this.logger.log(`    log_bin        = ${r.logBin}`)
      this.logger.log(`    เวลาในเครื่อง   = ${r.dbNow}`)
      this.logger.log(`    คิววันนี้        = ${r.rowsToday} แถว`)
      this.logger.log(`    vn ล่าสุด       = ${r.latestVn ?? '—'}`)
      this.logger.log(`    time_visit ล่าสุด = ${r.latestTime ?? '—'}`)
      this.logger.log(`    query poller    = ${r.medianMs} ms (median จาก ${this.rounds} รอบ)`)
    }

    // --- สรุปส่วนต่าง ---------------------------------------------------------
    const usable = reports.filter((r) => !r.error && r.latestVn)
    if (usable.length < 2) return

    this.logger.info('ส่วนต่างระหว่างเครื่อง')

    const newest = usable.reduce((a, b) => ((a.latestVn ?? '') > (b.latestVn ?? '') ? a : b))

    for (const r of usable) {
      if (r.host === newest.host) {
        this.logger.log(`    ${r.host}: ข้อมูลใหม่ที่สุด`)
        continue
      }

      const rowGap = (newest.rowsToday ?? 0) - (r.rowsToday ?? 0)
      const lag = vnGapSeconds(r.latestVn!, newest.latestVn!)

      this.logger.log(
        `    ${r.host}: ตามหลัง ${rowGap} แถว` +
          (lag === null ? '' : ` · คิวล่าสุดเก่ากว่า ${lag} วินาที`)
      )
    }

    const behind = usable.filter((r) => r.host !== newest.host)
    if (behind.every((r) => (newest.rowsToday ?? 0) === (r.rowsToday ?? 0))) {
      this.logger.info('  → ทุกเครื่องมีข้อมูลเท่ากันในวินาทีที่วัด')
    } else {
      this.logger.warning('  → มีเครื่องที่ข้อมูลตามหลัง การแจ้งเตือนจะช้าตามส่วนต่างนั้น')
    }
  }
}
