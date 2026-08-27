import type { HttpContext } from '@adonisjs/core/http'
import HosxpConnection from '#models/hosxp_connection'
import MophCredential from '#models/moph_credential'
import WorkerHeartbeat, { HEARTBEAT_STALE_SECONDS } from '#models/worker_heartbeat'
import User from '#models/user'
import { DateTime } from 'luxon'

export type StatusTile = {
  title: string
  state: 'ok' | 'warn' | 'fail'
  headline: string
  detail?: string
  href?: string
  linkText?: string
}

export default class StatusController {
  async index({ view }: HttpContext) {
    const [hosxp, moph, worker, notifyWorker, userCount] = await Promise.all([
      HosxpConnection.active(),
      MophCredential.active(),
      WorkerHeartbeat.findBy('name', 'queue:watch'),
      WorkerHeartbeat.findBy('name', 'notify:watch'),
      User.query().count('* as total').first(),
    ])

    const tiles: StatusTile[] = [
      this.#hosxpTile(hosxp),
      this.#mophTile(moph),
      this.#workerTile(worker, {
        title: 'ตัวเฝ้าดูคิว (worker)',
        container: 'worker',
        staleAfter: HEARTBEAT_STALE_SECONDS,
      }),
      this.#workerTile(notifyWorker, {
        title: 'ตัวเฝ้าดู MOPH Notify',
        container: 'notify',
        // เต้นทุก 60 วินาที ให้เผื่อรอบที่ query ชุดข้อมูลกินเวลานานหน่อย
        staleAfter: 180,
        href: '/notify',
      }),
    ]

    return view.render('pages/status', {
      tiles,
      hosxp,
      moph,
      worker,
      staleAfter: HEARTBEAT_STALE_SECONDS,
      userCount: Number(userCount?.$extras.total ?? 0),
    })
  }

  #hosxpTile(hosxp: HosxpConnection | null): StatusTile {
    if (!hosxp) {
      return {
        title: 'ฐานข้อมูล HOSxP',
        state: 'fail',
        headline: 'ยังไม่ได้ตั้งค่า',
        href: '/settings/hosxp',
        linkText: 'ไปตั้งค่า',
      }
    }

    const where = `${hosxp.host}:${hosxp.port}/${hosxp.database}`

    if (hosxp.lastTestOk === null) {
      return {
        title: 'ฐานข้อมูล HOSxP',
        state: 'warn',
        headline: 'ตั้งค่าแล้ว แต่ยังไม่เคยทดสอบ',
        detail: where,
        href: '/settings/hosxp',
        linkText: 'ทดสอบการเชื่อมต่อ',
      }
    }

    return {
      title: 'ฐานข้อมูล HOSxP',
      state: hosxp.lastTestOk ? 'ok' : 'fail',
      headline: hosxp.lastTestOk ? 'เชื่อมต่อได้' : 'เชื่อมต่อไม่ได้',
      detail: hosxp.lastTestOk ? where : (hosxp.lastTestError ?? where),
      href: '/settings/hosxp',
      linkText: 'ทดสอบอีกครั้ง',
    }
  }

  #mophTile(moph: MophCredential | null): StatusTile {
    if (!moph) {
      return {
        title: 'MOPH Alert',
        state: 'fail',
        headline: 'ยังไม่ได้ตั้งค่า',
        href: '/settings/moph',
        linkText: 'ไปตั้งค่า',
      }
    }

    if (moph.lastTestOk === null) {
      return {
        title: 'MOPH Alert',
        state: 'warn',
        headline: 'ตั้งค่าแล้ว แต่ยังไม่เคยทดสอบ',
        detail: moph.baseUrl,
        href: '/settings/moph',
        linkText: 'ทดสอบ key',
      }
    }

    return {
      title: 'MOPH Alert',
      state: moph.lastTestOk ? 'ok' : 'fail',
      headline: moph.lastTestOk ? 'key ใช้งานได้' : 'key มีปัญหา',
      detail: moph.lastTestOk ? moph.baseUrl : (moph.lastTestError ?? moph.baseUrl),
      href: '/settings/moph',
      linkText: 'ทดสอบอีกครั้ง',
    }
  }

  /**
   * @param staleAfter สองตัวนี้เต้นคนละจังหวะ — คิวทุก 15 วินาที
   *   ส่วน notify ทุก 60 วินาที ใช้เกณฑ์ขาดการติดต่อร่วมกันไม่ได้
   */
  #workerTile(
    worker: WorkerHeartbeat | null,
    options: { title: string; container: string; staleAfter: number; href?: string }
  ): StatusTile {
    const { title, container, staleAfter, href } = options

    if (!worker) {
      return {
        title,
        state: 'fail',
        headline: 'ไม่เคยรายงานตัว',
        detail: `container \`${container}\` อาจไม่ได้รันอยู่ — ตรวจด้วย docker compose ps`,
        href,
      }
    }

    const secondsAgo = Math.round(DateTime.now().diff(worker.lastBeatAt, 'seconds').seconds)

    if (secondsAgo > staleAfter) {
      return {
        title,
        state: 'fail',
        headline: `ขาดการติดต่อ ${secondsAgo} วินาที`,
        detail: `สัญญาณล่าสุดเกิน ${staleAfter} วินาที — process อาจตายหรือค้าง`,
        href,
      }
    }

    if (worker.status === 'error') {
      return { title, state: 'fail', headline: 'ทำงานผิดพลาด', detail: worker.message ?? undefined, href }
    }

    if (worker.status === 'waiting_config') {
      return { title, state: 'warn', headline: 'รอการตั้งค่า', detail: worker.message ?? undefined, href }
    }

    return {
      title,
      state: 'ok',
      headline: `ทำงานปกติ (${secondsAgo} วินาทีที่แล้ว)`,
      detail: `เดินไปแล้ว ${Number(worker.cycles).toLocaleString()} รอบ`,
      href,
    }
  }
}
