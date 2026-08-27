import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

const POLL_INTERVAL_MS = 15_000

/**
 * Poller — อ่านคิวจาก HOSxP แล้วส่งแจ้งเตือนผ่าน MOPH Alert
 *
 * ต้องรันแค่ instance เดียว ไม่งั้นสองตัวจะตรวจเจอเหตุการณ์เดียวกันพร้อมกัน
 * (dedup_key ที่เป็น UNIQUE กันการส่งซ้ำไว้อีกชั้นแล้ว แต่ก็ไม่ควรรันซ้อน)
 */
export default class QueueWatch extends BaseCommand {
  static commandName = 'queue:watch'
  static description = 'เฝ้าดูคิวใน HOSxP แล้วส่งแจ้งเตือนผ่าน MOPH Alert'
  static options: CommandOptions = { startApp: true, staysAlive: true }

  @flags.boolean({ description: 'รันรอบเดียวแล้วออก ใช้ตอนทดสอบ' })
  declare once: boolean

  #stopping = false

  async run() {
    const { default: WorkerHeartbeat } = await import('#models/worker_heartbeat')
    const { QueuePoller } = await import('#services/queue_poller')
    const { OpsAlerter } = await import('#services/ops_alerter')

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        this.logger.info(`ได้รับ ${signal} — กำลังปิดอย่างเรียบร้อย`)
        this.#stopping = true
      })
    }

    const poller = new QueuePoller()
    const alerter = new OpsAlerter()

    // ต้องเช็คก่อน beat แรก ไม่งั้นจะทับสัญญาณเก่าจนดูไม่ออกว่าเพิ่งหายไปนาน
    await alerter.workerStarted(QueueWatch.commandName)

    if (this.once) {
      await this.#cycle(poller, WorkerHeartbeat, alerter)
      await this.terminate()
      return
    }

    this.logger.info(`เริ่มทำงาน poll ทุก ${POLL_INTERVAL_MS / 1000} วินาที`)

    while (!this.#stopping) {
      await this.#cycle(poller, WorkerHeartbeat, alerter)
      await this.#sleep(POLL_INTERVAL_MS)
    }

    await this.terminate()
  }

  async #cycle(
    poller: InstanceType<typeof import('#services/queue_poller').QueuePoller>,
    WorkerHeartbeat: typeof import('#models/worker_heartbeat').default,
    alerter: InstanceType<typeof import('#services/ops_alerter').OpsAlerter>
  ) {
    try {
      const result = await poller.runCycle()

      if (result.note) {
        this.logger.warning(`${result.note} — ตั้งค่าที่ /settings`)
        await WorkerHeartbeat.beat(QueueWatch.commandName, 'waiting_config', result.note)
        // ยังตั้งค่าไม่ครบไม่ใช่ความผิดปกติ เป็นสถานะระหว่างติดตั้ง ไม่ต้องปลุกใคร
        return
      }

      const summary =
        `อ่าน ${result.scanned} คิว · สร้างใหม่ ${result.created} · ` +
        `ส่ง ${result.sent} · ล้มเหลว ${result.failed} · ข้าม ${result.skipped}` +
        (result.dryRun ? ' · DRY RUN' : '')

      if (result.created || result.sent || result.failed) {
        this.logger.info(summary)
      }

      await WorkerHeartbeat.beat(
        QueueWatch.commandName,
        result.dryRun ? 'idle' : 'running',
        summary
      )

      await alerter.cycleOk(result)
    } catch (error) {
      this.logger.error(`รอบนี้ล้มเหลว: ${error.message}`)
      await WorkerHeartbeat.beat(QueueWatch.commandName, 'error', error.message).catch(() => {})
      await alerter.cycleFailed(error.message)
    }
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
