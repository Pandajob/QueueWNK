import type { HttpContext } from '@adonisjs/core/http'
import HosxpConnection from '#models/hosxp_connection'
import MophCredential from '#models/moph_credential'
import WorkerHeartbeat, { HEARTBEAT_STALE_SECONDS } from '#models/worker_heartbeat'
import User from '#models/user'
import { DbHost, DbSyncSetting } from '#models/db_sync'
import { VERDICT_LABELS } from '#services/db_sync_checker'
import { DateTime } from 'luxon'

export type StatusTile = {
  title: string
  state: 'ok' | 'warn' | 'fail'
  headline: string
  detail?: string
  href?: string
  linkText?: string
}

/**
 * ผลทดสอบที่เก่ากว่านี้ ไม่นับว่าเป็นคำตอบของ "ตอนนี้"
 *
 * ปุ่มทดสอบในหน้าตั้งค่าเป็นการทดสอบครั้งเดียวแล้วเก็บผลไว้ ไม่ใช่การเฝ้าต่อเนื่อง
 * ถ้าปล่อยให้ผลเมื่อเดือนที่แล้วขึ้นไฟเขียวอยู่ หน้านี้จะบอกว่า "เชื่อมต่อได้"
 * ต่อไปเรื่อย ๆ แม้ฐานข้อมูลจะล่มไปแล้ว ซึ่งอันตรายกว่าไม่มีหน้านี้เลย
 */
const TEST_FRESH_HOURS = 24

export default class StatusController {
  async index({ view }: HttpContext) {
    const [hosxp, moph, worker, notifyWorker, userCount, dbSync, hostCount] = await Promise.all([
      HosxpConnection.active(),
      MophCredential.active(),
      WorkerHeartbeat.findBy('name', 'queue:watch'),
      WorkerHeartbeat.findBy('name', 'notify:watch'),
      User.query().count('* as total').first(),
      DbSyncSetting.current(),
      DbHost.query().where('is_enabled', true).count('* as total').first(),
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
      this.#dbSyncTile(dbSync, Number(hostCount?.$extras.total ?? 0)),
    ]

    return view.render('pages/status', {
      tiles,
      hosxp,
      moph,
      worker,
      dbSync,
      staleAfter: HEARTBEAT_STALE_SECONDS,
      userCount: Number(userCount?.$extras.total ?? 0),
    })
  }

  /**
   * ผลทดสอบเก่าแค่ไหน และควรเชื่อไหม
   *
   * คืน null เมื่อไม่เคยทดสอบ เพื่อให้ผู้เรียกแยกได้ระหว่าง "ไม่เคยทดสอบ"
   * กับ "ทดสอบแล้วแต่นานมาแล้ว" ซึ่งต้องบอกผู้ใช้คนละแบบ
   */
  #testAge(testedAt: DateTime | null) {
    if (!testedAt) return null

    const hours = DateTime.now().diff(testedAt, 'hours').hours
    const when = testedAt.setZone('Asia/Bangkok').toFormat('dd/MM/yyyy HH:mm')

    if (hours < 1) return { stale: false, when, ago: 'ไม่ถึงชั่วโมงที่แล้ว' }
    if (hours < 24) return { stale: false, when, ago: `${Math.round(hours)} ชั่วโมงที่แล้ว` }

    return { stale: hours > TEST_FRESH_HOURS, when, ago: `${Math.round(hours / 24)} วันที่แล้ว` }
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
    const age = this.#testAge(hosxp.lastTestedAt)

    if (hosxp.lastTestOk === null || !age) {
      return {
        title: 'ฐานข้อมูล HOSxP',
        state: 'warn',
        headline: 'ตั้งค่าแล้ว แต่ยังไม่เคยทดสอบ',
        detail: where,
        href: '/settings/hosxp',
        linkText: 'ทดสอบการเชื่อมต่อ',
      }
    }

    if (!hosxp.lastTestOk) {
      return {
        title: 'ฐานข้อมูล HOSxP',
        state: 'fail',
        headline: 'เชื่อมต่อไม่ได้',
        detail: `${hosxp.lastTestError ?? where} · ทดสอบเมื่อ ${age.when}`,
        href: '/settings/hosxp',
        linkText: 'ทดสอบอีกครั้ง',
      }
    }

    /**
     * เคยผ่าน แต่ผลเก่าเกินไป
     *
     * ไม่ขึ้นไฟเขียว เพราะไฟเขียวแปลว่า "ตอนนี้ต่อได้" ซึ่งเราไม่รู้จริง
     * ตัวที่รู้จริงคือ "เทียบเครื่องฐานข้อมูล" ที่ยิงจริงทุกรอบ จึงชี้ไปทางนั้น
     */
    if (age.stale) {
      return {
        title: 'ฐานข้อมูล HOSxP',
        state: 'warn',
        headline: `ผลทดสอบเก่าแล้ว (${age.ago})`,
        detail: `${where} · ทดสอบล่าสุด ${age.when} — ผลนี้ไม่ได้บอกสถานะตอนนี้`,
        href: '/settings/hosxp',
        linkText: 'ทดสอบอีกครั้ง',
      }
    }

    return {
      title: 'ฐานข้อมูล HOSxP',
      state: 'ok',
      headline: 'เชื่อมต่อได้',
      detail: `${where} · ทดสอบเมื่อ ${age.ago}`,
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

    const age = this.#testAge(moph.lastTestedAt)

    if (moph.lastTestOk === null || !age) {
      return {
        title: 'MOPH Alert',
        state: 'warn',
        headline: 'ตั้งค่าแล้ว แต่ยังไม่เคยทดสอบ',
        detail: moph.baseUrl,
        href: '/settings/moph',
        linkText: 'ทดสอบ key',
      }
    }

    if (!moph.lastTestOk) {
      return {
        title: 'MOPH Alert',
        state: 'fail',
        headline: 'key มีปัญหา',
        detail: `${moph.lastTestError ?? moph.baseUrl} · ทดสอบเมื่อ ${age.when}`,
        href: '/settings/moph',
        linkText: 'ทดสอบอีกครั้ง',
      }
    }

    if (age.stale) {
      return {
        title: 'MOPH Alert',
        state: 'warn',
        headline: `ผลทดสอบเก่าแล้ว (${age.ago})`,
        detail: `${moph.baseUrl} · ทดสอบล่าสุด ${age.when} — ผลนี้ไม่ได้บอกสถานะตอนนี้`,
        href: '/settings/moph',
        linkText: 'ทดสอบอีกครั้ง',
      }
    }

    return {
      title: 'MOPH Alert',
      state: 'ok',
      headline: 'key ใช้งานได้',
      detail: `${moph.baseUrl} · ทดสอบเมื่อ ${age.ago}`,
      href: '/settings/moph',
      linkText: 'ทดสอบอีกครั้ง',
    }
  }

  /**
   * เทียบเครื่องฐานข้อมูล
   *
   * ตัวนี้เป็นสัญญาณ "สด" ตัวเดียวที่หน้านี้มีเรื่องฐานข้อมูล — worker ยิงจริง
   * ไปทุกเครื่องตามรอบที่ตั้งไว้ ต่างจากไทล์ HOSxP ที่เป็นผลทดสอบที่คนกดเก็บไว้
   * เดิมไทล์นี้มีแต่ในหน้า "ตั้งค่า" คนที่เปิดหน้าสถานะจึงไม่เห็นว่ามันตรวจอยู่
   */
  #dbSyncTile(settings: DbSyncSetting, hostCount: number): StatusTile {
    const href = '/settings/db-sync'
    const report = settings.lastReport

    if (!hostCount) {
      return {
        title: 'เทียบเครื่องฐานข้อมูล',
        state: 'warn',
        headline: 'ยังไม่ได้เพิ่มเครื่องที่จะเฝ้า',
        href,
        linkText: 'เพิ่มเครื่อง',
      }
    }

    if (!report) {
      return {
        title: 'เทียบเครื่องฐานข้อมูล',
        state: 'warn',
        headline: `เฝ้า ${hostCount} เครื่อง · ยังไม่เคยตรวจ`,
        detail: settings.isEnabled ? undefined : 'ยังไม่ได้เปิดการเฝ้าอัตโนมัติ',
        href,
        linkText: 'ตรวจเดี๋ยวนี้',
      }
    }

    const checkedAt = DateTime.fromISO(report.checkedAt, { zone: 'Asia/Bangkok' })
    const minutesAgo = checkedAt.isValid
      ? Math.round(DateTime.now().diff(checkedAt, 'minutes').minutes)
      : null
    const when = checkedAt.isValid ? checkedAt.toFormat('dd/MM/yyyy HH:mm') : report.checkedAt
    const verdict = VERDICT_LABELS[report.verdict] ?? report.verdict

    if (!settings.isEnabled) {
      return {
        title: 'เทียบเครื่องฐานข้อมูล',
        state: 'warn',
        headline: 'ปิดการเฝ้าอัตโนมัติอยู่',
        detail: `ผลครั้งล่าสุด: ${report.headline} · ${when}`,
        href,
        linkText: 'เปิดการเฝ้า',
      }
    }

    if (report.shouldAlert) {
      return {
        title: 'เทียบเครื่องฐานข้อมูล',
        state: 'fail',
        headline: verdict,
        detail: `${report.headline} · ตรวจเมื่อ ${when}`,
        href,
        linkText: 'ดูรายละเอียด',
      }
    }

    /**
     * เปิดเฝ้าไว้แต่ผลไม่ขยับ = ตัวเฝ้าไม่ได้เดิน
     *
     * เผื่อไว้สองเท่าของรอบที่ตั้ง กันกรณีรอบหนึ่งกินเวลานานกว่าปกติ
     * ถ้าไม่ดักไว้ หน้านี้จะโชว์ผลเก่าเป็นไฟเขียวค้างอยู่ตลอด
     */
    const allowance = Math.max(settings.checkEveryMinutes * 2, 10)
    if (minutesAgo !== null && minutesAgo > allowance) {
      return {
        title: 'เทียบเครื่องฐานข้อมูล',
        state: 'warn',
        headline: `ไม่ได้ตรวจมา ${minutesAgo} นาที`,
        detail: `ตั้งไว้ให้ตรวจทุก ${settings.checkEveryMinutes} นาที — ตัวเฝ้าอาจไม่ได้เดิน · ผลล่าสุด ${when}`,
        href,
        linkText: 'ตรวจเดี๋ยวนี้',
      }
    }

    return {
      title: 'เทียบเครื่องฐานข้อมูล',
      state: 'ok',
      headline: `${verdict} (${hostCount} เครื่อง)`,
      detail:
        minutesAgo !== null && minutesAgo < 1
          ? `${report.headline} · ตรวจเมื่อครู่นี้`
          : `${report.headline} · ตรวจเมื่อ ${minutesAgo} นาทีที่แล้ว`,
      href,
      linkText: 'ดูรายละเอียด',
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
      return {
        title,
        state: 'fail',
        headline: 'ทำงานผิดพลาด',
        detail: worker.message ?? undefined,
        href,
      }
    }

    if (worker.status === 'waiting_config') {
      return {
        title,
        state: 'warn',
        headline: 'รอการตั้งค่า',
        detail: worker.message ?? undefined,
        href,
      }
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
