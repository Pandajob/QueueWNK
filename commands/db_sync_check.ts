import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * เทียบเครื่องฐานข้อมูลที่ตั้งไว้ในหน้าเว็บ แล้วพิมพ์ผลออกมา
 *
 *   docker compose exec web node ace db:sync-check
 *   docker compose exec web node ace db:sync-check --send    (ส่งเข้ากลุ่มด้วย)
 *
 * ต่างจาก `hosxp:compare-hosts` ตรงที่ตัวนั้นให้พิมพ์ host เอาเองเพื่อ "เลือกเครื่อง"
 * ส่วนตัวนี้อ่านรายชื่อจากที่ตั้งค่าไว้ และใช้เกณฑ์เดียวกับที่ worker ใช้ตัดสิน
 * — เอาไว้ตรวจว่าที่ตั้งค่าไว้ให้ผลอย่างที่คิดจริงไหมก่อนเปิดใช้งานอัตโนมัติ
 */
export default class DbSyncCheck extends BaseCommand {
  static commandName = 'db:sync-check'
  static description = 'เทียบข้อมูลระหว่างเครื่องฐานข้อมูลที่ตั้งค่าไว้'
  static options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'ส่งผลเข้ากลุ่ม LINE ด้วย' })
  declare send: boolean

  async run() {
    const { DbSyncSetting } = await import('#models/db_sync')
    const { DbSyncWatcher, buildSyncMessage } = await import('#services/db_sync_watcher')
    const { METRICS } = await import('#services/db_sync_checker')

    const settings = await DbSyncSetting.current()
    const watcher = new DbSyncWatcher()
    const report = await watcher.check(settings)

    if (!report) {
      this.logger.error('ยังไม่ได้ตั้งค่าการเชื่อมต่อ HOSxP')
      this.exitCode = 1
      return
    }

    if (report.verdict === 'no_data') {
      this.logger.error('ยังไม่ได้เพิ่มเครื่องที่จะเฝ้า — ไปที่ ระบบ → เทียบเครื่องฐานข้อมูล')
      this.exitCode = 1
      return
    }

    for (const probe of report.hosts) {
      this.logger.info(`${probe.label} (${probe.host}:${probe.port})`)

      if (!probe.ok) {
        this.logger.log(`    ต่อไม่ได้: ${probe.error}`)
        continue
      }

      this.logger.log(`    hostname   = ${probe.hostname}  server_id = ${probe.serverId}`)
      this.logger.log(
        `    read_only  = ${probe.readOnly ? 'ON' : 'OFF'}  นาฬิกาต่างจากเรา ${probe.clockSkewSeconds} วิ`
      )
      for (const metric of METRICS) {
        this.logger.log(`    ${metric.label.padEnd(22)} ${probe.counts[metric.key] ?? '—'}`)
      }

      const gaps = report.gapsByHost[probe.host] ?? []
      if (gaps.length) {
        this.logger.log(`    ตามหลัง: ${gaps.map((g) => `${g.label} ${g.gap}`).join(' · ')}`)
      }
    }

    if (report.shouldAlert) this.logger.warning(report.headline)
    else this.logger.success(report.headline)

    // เพดาน 10 KB ต่อข้อความ LINE นับเป็นไบต์ ภาษาไทยตัวละ 3 ไบต์ จึงต้องวัดของจริง
    const { buildSyncFlex } = await import('#services/db_sync_flex')
    const limit = 10 * 1024
    for (const [index, message] of buildSyncFlex(report, settings.cardColor).entries()) {
      const size = Buffer.byteLength(JSON.stringify(message), 'utf8')
      const line = `การ์ดใบที่ ${index + 1}: ${size.toLocaleString()} จากเพดาน ${limit.toLocaleString()} ไบต์`
      if (size > limit) this.logger.error(`${line} — เกิน`)
      else this.logger.success(line)
    }

    if (!this.send) {
      this.logger.info('ข้อความที่จะส่ง (ยังไม่ได้ส่ง) — ใส่ --send ถ้าจะส่งจริง')
      this.logger.log('')
      for (const line of buildSyncMessage(report).split('\n')) this.logger.log(`  ${line}`)
      return
    }

    const outcome = await watcher.sendNow(settings, report)
    if (outcome.error) {
      this.logger.error(outcome.error)
      this.exitCode = 1
      return
    }
    this.logger.success(`ส่งเข้ากลุ่มแล้ว ${outcome.sent} กลุ่ม`)
  }
}
