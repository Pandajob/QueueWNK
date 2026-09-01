import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/** ตารางเวลาและรอบส่งนัดหมายละเอียดสุดระดับนาที ตรวจทุก 60 วินาทีจึงพอ */
const TICK_INTERVAL_MS = 60_000

/**
 * worker ของระบบ MOPH Notify — ตารางเวลาส่งซ้ำ เฝ้าระวังโรค 506 และแจ้งเตือนนัดหมาย
 *
 * แยกจาก `queue:watch` เพราะจังหวะต่างกันมาก (นาที เทียบกับ 15 วินาที)
 * และที่สำคัญกว่านั้นคือ query ของ CDCU กับชุดข้อมูลเป็นของที่ผู้ดูแลเขียนเอง
 * ไม่ควรมีโอกาสไปถ่วงงานคิวซึ่งเป็นงานที่ผู้ป่วยรออยู่จริง
 */
export default class NotifyWatch extends BaseCommand {
  static commandName = 'notify:watch'
  static description = 'ส่งข้อความตามตารางเวลา เฝ้าระวังเคส 506 และแจ้งเตือนนัดหมาย'
  static options: CommandOptions = { startApp: true, staysAlive: true }

  @flags.boolean({ description: 'รันรอบเดียวแล้วออก ใช้ตอนทดสอบ' })
  declare once: boolean

  #stopping = false

  async run() {
    const { default: WorkerHeartbeat } = await import('#models/worker_heartbeat')
    const { ScheduleRunner } = await import('#services/schedule_runner')
    const { CdcuWatcher } = await import('#services/cdcu_watcher')
    const { DbSyncWatcher } = await import('#services/db_sync_watcher')
    const { AppointmentReminder } = await import('#services/appointment_reminder')

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        this.logger.info(`ได้รับ ${signal} — กำลังปิดอย่างเรียบร้อย`)
        this.#stopping = true
      })
    }

    const schedules = new ScheduleRunner()
    const cdcu = new CdcuWatcher()
    const dbSync = new DbSyncWatcher()
    const appointments = new AppointmentReminder()

    if (this.once) {
      await this.#cycle(schedules, cdcu, dbSync, appointments, WorkerHeartbeat)
      await this.terminate()
      return
    }

    this.logger.info(`เริ่มทำงาน ตรวจทุก ${TICK_INTERVAL_MS / 1000} วินาที`)

    while (!this.#stopping) {
      await this.#cycle(schedules, cdcu, dbSync, appointments, WorkerHeartbeat)
      await this.#sleep(TICK_INTERVAL_MS)
    }

    await this.terminate()
  }

  async #cycle(
    schedules: InstanceType<typeof import('#services/schedule_runner').ScheduleRunner>,
    cdcu: InstanceType<typeof import('#services/cdcu_watcher').CdcuWatcher>,
    dbSync: InstanceType<typeof import('#services/db_sync_watcher').DbSyncWatcher>,
    appointments: InstanceType<
      typeof import('#services/appointment_reminder').AppointmentReminder
    >,
    WorkerHeartbeat: typeof import('#models/worker_heartbeat').default
  ) {
    const parts: string[] = []
    let failed = false

    // สามงานนี้ไม่เกี่ยวกัน งานหนึ่งพังอีกสองงานต้องยังทำงานต่อ
    try {
      const result = await schedules.tick()
      if (result.due) {
        this.logger.info(
          `ตารางเวลา: ถึงรอบ ${result.due} · ส่ง ${result.sent} · ล้มเหลว ${result.failed}`
        )
      }
      parts.push(`ตารางเวลา ${result.due} รอบ`)
    } catch (error) {
      failed = true
      this.logger.error(`ตารางเวลาล้มเหลว: ${error.message}`)
      parts.push(`ตารางเวลาล้มเหลว: ${error.message}`)
    }

    try {
      const result = await cdcu.tick()
      if (result.sent) {
        this.logger.info(`CDCU: เคสใหม่ ${result.matched} · แจ้งแล้ว ${result.sent}`)
      }
      parts.push(result.note ?? `CDCU ${result.scanned} เคส`)
    } catch (error) {
      failed = true
      this.logger.error(`CDCU ล้มเหลว: ${error.message}`)
      parts.push(`CDCU ล้มเหลว: ${error.message}`)
    }

    try {
      const result = await dbSync.tick()
      if (result.checked) {
        this.logger.info(`เทียบฐานข้อมูล: ${result.verdict} · ส่ง ${result.sent}`)
        parts.push(`เทียบฐานข้อมูล ${result.verdict}`)
      } else if (result.note) {
        parts.push(`เทียบฐานข้อมูล — ${result.note}`)
      }
    } catch (error) {
      failed = true
      this.logger.error(`เทียบฐานข้อมูลล้มเหลว: ${error.message}`)
      parts.push(`เทียบฐานข้อมูลล้มเหลว: ${error.message}`)
    }

    try {
      const result = await appointments.tick()
      if (result.queued) {
        this.logger.info(`นัดหมาย: นัด ${result.scanned} ราย · ตั้งคิว ${result.queued}`)
      }
      if (result.note) parts.push(`นัดหมาย — ${result.note}`)
      else if (result.scanned) parts.push(`นัดหมาย ${result.queued}/${result.scanned}`)
    } catch (error) {
      failed = true
      this.logger.error(`นัดหมายล้มเหลว: ${error.message}`)
      parts.push(`นัดหมายล้มเหลว: ${error.message}`)
    }

    await WorkerHeartbeat.beat(
      NotifyWatch.commandName,
      failed ? 'error' : 'running',
      parts.join(' · ')
    ).catch(() => {})
  }

  /** หลับแบบตื่นทันทีเมื่อได้สัญญาณปิด ไม่ต้องรอครบรอบ */
  #sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms)
      const check = setInterval(() => {
        if (this.#stopping) {
          clearTimeout(timer)
          clearInterval(check)
          resolve()
        }
      }, 250)
      timer.unref?.()
    })
  }
}
