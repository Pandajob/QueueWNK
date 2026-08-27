import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'

import WorkerHeartbeat from '#models/worker_heartbeat'
import { NotifyGroup, NotifyOpsSetting } from '#models/notify_system'
import { Watermark } from '#models/poller_models'
import { dispatch } from '#services/notify_dispatcher'
import { scrubCid } from '#services/notify_client'

/** เรื่องที่เตือนได้ ใช้เป็น key ของ throttle ด้วย */
export type OpsEvent = 'poller_error' | 'send_failure' | 'recovered' | 'restarted'

const THROTTLE_PREFIX = 'ops:last:'

/** จำว่ารอบก่อนระบบปกติหรือพัง ไว้ตัดสินว่าควรส่งข้อความ "กลับมาแล้ว" ไหม */
const STATE_KEY = 'ops:state'

type OpsState = 'ok' | 'error'

function stamp() {
  return DateTime.now().setZone('Asia/Bangkok').toFormat('dd/MM/yyyy HH:mm')
}

/**
 * ส่งสถานะของระบบเข้ากลุ่ม LINE ของทีมงานผ่าน MOPH Notify
 *
 * กติกาที่ต้องไม่พัง:
 *   1. ห้ามมีข้อมูลผู้ป่วยในข้อความ — กลุ่มแชทมีคนอ่านหลายคน และไม่ใช่ทุกคน
 *      มีสิทธิ์เห็นข้อมูลผู้ป่วย จึงส่งได้แค่ตัวเลขสรุปกับข้อความ error ของระบบ
 *   2. ห้ามทำให้ poller ล้ม — ถ้าส่งแจ้งเตือนไม่ได้ก็แค่ log ทิ้งไว้
 *      การแจ้งเตือนล่มไม่ควรลากงานหลักล่มตาม
 *   3. ห้ามสแปม — poller วนทุก 15 วินาที ถ้า HOSxP ล่มจะเข้าเงื่อนไขทุกรอบ
 */
export class OpsAlerter {
  /** worker เพิ่งขึ้นมา — ถ้ารอบก่อนหายไปนานแปลว่าเพิ่งล่มมา */
  async workerStarted(workerName: string) {
    const previous = await WorkerHeartbeat.findBy('name', workerName).catch(() => null)
    if (!previous || !previous.isStale) return

    const downFor = Math.round(DateTime.now().diff(previous.lastBeatAt, 'minutes').minutes)

    await this.#send(
      'restarted',
      (s) => s.onRestart,
      `⚠️ QueueWNK — worker กลับมาทำงานแล้ว\n` +
        `เวลา ${stamp()}\n` +
        `ก่อนหน้านี้เงียบไปประมาณ ${downFor} นาที (สัญญาณสุดท้าย ` +
        `${previous.lastBeatAt.setZone('Asia/Bangkok').toFormat('dd/MM/yyyy HH:mm')})\n` +
        `สถานะตอนนั้น: ${previous.status}${previous.message ? ` — ${previous.message}` : ''}`
    )
  }

  /** รอบนี้พัง */
  async cycleFailed(message: string) {
    await Watermark.set(STATE_KEY, 'error' satisfies OpsState)

    await this.#send(
      'poller_error',
      (s) => s.onError,
      `🔴 QueueWNK — poller ทำงานไม่สำเร็จ\n` + `เวลา ${stamp()}\n` + message
    )
  }

  /** รอบนี้ผ่าน — เช็คว่าต้องบอกว่ากลับมาปกติไหม และมีรายการส่งไม่ผ่านไหม */
  async cycleOk(result: { sent: number; failed: number; skipped: number }) {
    const state = ((await Watermark.get(STATE_KEY)) ?? 'ok') as OpsState

    if (state === 'error') {
      await Watermark.set(STATE_KEY, 'ok' satisfies OpsState)
      await this.#send(
        'recovered',
        (s) => s.onRecover,
        `🟢 QueueWNK — กลับมาทำงานปกติแล้ว\nเวลา ${stamp()}`
      )
    }

    if (result.failed > 0) {
      await this.#send(
        'send_failure',
        (s) => s.onSendFailure,
        `🟠 QueueWNK — ส่งแจ้งเตือนไม่ผ่าน ${result.failed} รายการ\n` +
          `เวลา ${stamp()}\n` +
          `รอบนี้ส่งสำเร็จ ${result.sent} · ข้าม ${result.skipped}\n` +
          `ดูรายละเอียดที่หน้า /log`
      )
    }
  }

  /**
   * ส่งจริง ผ่านด่านสามชั้น: เลือกกลุ่มไว้ไหม / เรื่องนี้เปิดเตือนไหม / เพิ่งเตือนไปหรือยัง
   *
   * กลืน error ทุกกรณี — ดูหมายเหตุข้อ 2 ด้านบน
   */
  async #send(event: OpsEvent, wants: (s: NotifyOpsSetting) => boolean, text: string) {
    try {
      const settings = await NotifyOpsSetting.current()
      if (!settings.groupId || !wants(settings)) return

      const group = await NotifyGroup.find(settings.groupId)
      if (!group?.isUsable) return

      const throttleKey = `${THROTTLE_PREFIX}${event}`
      const last = await Watermark.get(throttleKey)

      if (last) {
        const elapsed = DateTime.now().diff(DateTime.fromISO(last), 'minutes').minutes
        if (elapsed < settings.throttleMinutes) {
          logger.debug(
            { event, elapsed: Math.round(elapsed), throttle: settings.throttleMinutes },
            'ข้ามการแจ้งเตือนทีมงาน — เพิ่งเตือนเรื่องนี้ไป'
          )
          return
        }
      }

      const outcome = await dispatch({
        groups: [group],
        body: text,
        source: 'ops',
        subject: event,
      })

      // จับเวลา throttle เฉพาะตอนส่งสำเร็จ ส่งไม่ออกแล้วมานับว่าเตือนแล้วคือหลอกตัวเอง
      if (outcome.sent) {
        await Watermark.set(throttleKey, DateTime.now().toISO()!)
        logger.info({ event }, 'แจ้งเตือนทีมงานเข้ากลุ่ม LINE แล้ว')
      }
    } catch (error) {
      logger.warn(
        { event, error: scrubCid(String(error?.message ?? error)) },
        'แจ้งเตือนทีมงานล้มเหลว'
      )
    }
  }
}
