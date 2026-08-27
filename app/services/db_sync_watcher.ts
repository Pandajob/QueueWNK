import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'

import { DbSyncSetting } from '#models/db_sync'
import { NotifyGroup } from '#models/notify_system'
import { Watermark } from '#models/poller_models'
import { dispatch } from '#services/notify_dispatcher'
import { scrubCid } from '#services/notify_client'
import { CLOCK_SKEW_WARN_SECONDS, METRICS, ROLE_LABELS, runSyncCheck } from '#services/db_sync_checker'
import type { SyncReport } from '#services/db_sync_checker'
import { buildSyncFlex } from '#services/db_sync_flex'

const LAST_CHECK_KEY = 'dbsync:last_check_at'
const LAST_SENT_KEY = 'dbsync:last_sent_at'
const LAST_SIGNATURE_KEY = 'dbsync:last_signature'
const LAST_DIGEST_KEY = 'dbsync:last_digest_on'

/**
 * เคยเตือนไปแล้วหรือยัง — เก็บแยกจาก signature เพราะไม่ใช่ทุกความต่างจะถึงขั้นเตือน
 * ถ้าใช้ verdict ตัดสิน จะส่ง "กลับมาปกติแล้ว" ทั้งที่ไม่เคยบอกว่ามีปัญหา
 */
const STATE_KEY = 'dbsync:state'

type AlertState = 'ok' | 'warn'

export type DbSyncTickResult = {
  checked: boolean
  verdict?: SyncReport['verdict']
  sent: number
  note?: string
}

function stamp(iso?: string) {
  const at = iso ? DateTime.fromISO(iso) : DateTime.now()
  return at.setZone('Asia/Bangkok').toFormat('dd/MM/yyyy HH:mm')
}

const VERDICT_ICON: Record<SyncReport['verdict'], string> = {
  ok: '🟢',
  lagging: '🟠',
  diverged: '🔴',
  unreachable: '🔴',
  no_data: '⚪',
}

/**
 * ข้อความที่เข้ากลุ่ม
 *
 * เป็นข้อความธรรมดา ไม่ใช่การ์ด Flex โดยตั้งใจ — ปลายทางดองการ์ดไว้ราว 19 นาที
 * (ดู notify_client.ts) ซึ่งยอมรับไม่ได้กับเรื่องที่ต้องรีบรู้อย่างฐานข้อมูลไม่ตรงกัน
 * ความสวยไม่คุ้มกับการรู้ช้าครึ่งชั่วโมง
 */
export function buildSyncMessage(report: SyncReport, title = 'ตรวจฐานข้อมูลระหว่างเครื่อง') {
  const lines: string[] = [
    `${VERDICT_ICON[report.verdict]} QueueWNK — ${title}`,
    stamp(report.checkedAt),
    '',
    report.headline,
  ]

  const down = report.hosts.filter((h) => !h.ok)
  if (down.length) {
    lines.push('')
    for (const host of down) {
      lines.push(`✖ ${host.label} (${host.host}) ต่อไม่ได้`)
      if (host.error) lines.push(`   ${host.error}`)
    }
  }

  const up = report.hosts.filter((h) => h.ok)
  if (up.length) {
    lines.push('')
    for (const host of up) {
      const gaps = report.gapsByHost[host.host] ?? []
      const rep = host.replication
      const mark = gaps.length || rep?.slaveRunning === false ? '△' : '✔'
      const identity = [
        host.hostname ?? host.host,
        host.serverId ? `server_id ${host.serverId}` : null,
        rep ? ROLE_LABELS[rep.role] : null,
        host.readOnly === null ? null : host.readOnly ? 'อ่านอย่างเดียว' : 'รับการเขียน',
      ]
        .filter(Boolean)
        .join(' · ')

      lines.push(`${mark} ${identity}`)
      lines.push(
        '   ' +
          METRICS.map((m) => `${m.label} ${host.counts[m.key] ?? '—'}`).join(' · ')
      )

      const repParts = [
        rep?.gtidCurrent ? `GTID ${rep.gtidCurrent}` : null,
        host.gtidLag ? `ตามหลัง ${host.gtidLag.toLocaleString()} รายการ` : null,
        rep?.slaveRunning === false ? 'สายรับข้อมูลหยุด' : null,
      ].filter(Boolean)
      if (repParts.length) lines.push('   ' + repParts.join(' · '))

      if (gaps.length) {
        lines.push('   ตามหลัง: ' + gaps.map((g) => `${g.label} ${g.gap} แถว`).join(' · '))
      }
    }
  }

  if (report.lagSeconds) lines.push('', `รายการล่าสุดห่างกัน ${report.lagSeconds} วินาที`)

  if (report.stoppedReplicas.length) {
    lines.push(
      '',
      `🔴 replication หยุดเดินที่ ${report.stoppedReplicas.join(', ')} — ` +
        `ตั้งแต่นี้ไปข้อมูลจะเริ่มแยกกัน ยิ่งช้ายิ่งตามยาก`
    )
  }

  if (report.writableReplicas.length) {
    lines.push(
      '',
      `⚠️ ${report.writableReplicas.join(', ')} เป็นตัวตามแต่ยังเขียนได้ — ` +
        `ถ้ามีใครเขียนลงเครื่องนี้ตรง ๆ แถวนั้นจะไม่ไหลกลับไปหาแหล่งหลัก`
    )
  }

  if (report.clockSpreadSeconds !== null && report.clockSpreadSeconds > CLOCK_SKEW_WARN_SECONDS) {
    lines.push(
      '',
      `⚠️ นาฬิกาของเครื่องต่างกัน ${report.clockSpreadSeconds} วินาที — vn สร้างจากเวลาเครื่อง ` +
        `ต่างกันมากแล้วเลขซ้ำกันได้`
    )
  }

  if (report.verdict === 'diverged') {
    lines.push(
      '',
      'แต่ละเครื่องมีแถวที่อีกเครื่องไม่มี รอไปไม่หายเอง — ให้ DBA ตรวจ replication'
    )
  }

  return lines.join('\n')
}

/**
 * เฝ้าว่าเครื่องฐานข้อมูลยังตรงกันอยู่ไหม
 *
 * แยกจาก OpsAlerter เพราะคนละคำถาม — OpsAlerter ตอบว่า "ระบบเราทำงานอยู่ไหม"
 * ตัวนี้ตอบว่า "ข้อมูลที่ระบบเราอ่านมาถูกต้องไหม" ซึ่งพังได้ทั้งที่เราทำงานปกติดี
 */
export class DbSyncWatcher {
  /**
   * ตรวจหนึ่งรอบแล้วจำผลไว้
   *
   * แยกจาก tick() เพื่อให้ปุ่ม "ตรวจเดี๋ยวนี้" ในหน้าเว็บใช้ได้โดยไม่ไปยุ่งกับ
   * ตัวนับ throttle และไม่ทำให้รอบอัตโนมัติเลื่อน
   */
  async check(settings: DbSyncSetting) {
    const report = await runSyncCheck({
      lagWarnSeconds: settings.lagWarnSeconds,
      rowGapWarn: settings.rowGapWarn,
      gtidLagWarn: settings.gtidLagWarn,
    })

    if (report) {
      settings.lastReport = report
      await settings.save()
    }
    return report
  }

  async tick(now = DateTime.now().setZone('Asia/Bangkok')): Promise<DbSyncTickResult> {
    const settings = await DbSyncSetting.current()
    if (!settings.isEnabled) return { checked: false, sent: 0, note: 'ปิดการเฝ้าอยู่' }

    if (!(await this.#due(settings, now))) return { checked: false, sent: 0 }

    await Watermark.set(LAST_CHECK_KEY, now.toISO()!)

    const report = await this.check(settings)
    if (!report) {
      return { checked: false, sent: 0, note: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ HOSxP' }
    }
    if (report.verdict === 'no_data') {
      return { checked: true, verdict: report.verdict, sent: 0, note: 'ยังไม่ได้เพิ่มเครื่องที่จะเฝ้า' }
    }

    const sent = await this.#maybeSend(settings, report, now)
    return { checked: true, verdict: report.verdict, sent }
  }

  async #due(settings: DbSyncSetting, now: DateTime) {
    const last = await Watermark.get(LAST_CHECK_KEY)
    if (!last) return true

    const elapsed = now.diff(DateTime.fromISO(last), 'minutes').minutes
    return elapsed >= settings.checkEveryMinutes
  }

  /**
   * ตัดสินว่าจะพูดหรือเงียบ
   *
   * ลำดับสำคัญ: รายงานประจำวันมาก่อน เพราะถ้ามีปัญหาพอดีในเวลานั้น
   * เราอยากให้ข้อความประจำวันบอกความจริง ไม่ใช่ถูก throttle กลืนไปทั้งคู่
   */
  async #maybeSend(settings: DbSyncSetting, report: SyncReport, now: DateTime) {
    if (!settings.groupId) return 0

    const group = await NotifyGroup.find(settings.groupId)
    if (!group?.isUsable) return 0

    /**
     * `isDigest` ตัดสินว่าจะเป็นการ์ดหรือข้อความ ตามที่ตั้งไว้ในหน้าเว็บ
     *
     * ส่ง body ไปด้วยเสมอแม้จะเป็นการ์ด — ประวัติการส่งเก็บ body และกลุ่มที่
     * ปิดสวิตช์รับการ์ดไว้จะถอยไปใช้ข้อความนี้แทน ไม่ใช่ส่งการ์ดออกไปแล้วเงียบหาย
     */
    const send = async (body: string, subject: string, isDigest = false) => {
      const outcome = await dispatch({
        groups: [group],
        body,
        messages: settings.wantsCard(isDigest)
          ? buildSyncFlex(report, settings.cardColor)
          : undefined,
        source: 'dbsync',
        subject,
      })
      return outcome.sent
    }

    // --- รายงานประจำวัน ------------------------------------------------------
    if (await this.#digestDue(settings, now)) {
      const sent = await send(
        buildSyncMessage(report, 'รายงานฐานข้อมูลประจำวัน'),
        `รายงานประจำวัน — ${report.verdict}`,
        true
      )
      if (sent) {
        await Watermark.set(LAST_DIGEST_KEY, now.toISODate()!)
        // รายงานประจำวันบอกสถานะครบแล้ว ไม่ต้องยิงซ้ำด้วยข้อความเตือน
        await Watermark.set(LAST_SENT_KEY, now.toISO()!)
        await Watermark.set(LAST_SIGNATURE_KEY, report.signature)
        await Watermark.set(STATE_KEY, report.shouldAlert ? 'warn' : 'ok')
      }
      return sent
    }

    const state = ((await Watermark.get(STATE_KEY)) ?? 'ok') as AlertState

    // --- กลับมาปกติ ----------------------------------------------------------
    if (!report.shouldAlert) {
      await Watermark.set(STATE_KEY, 'ok' satisfies AlertState)
      await Watermark.set(LAST_SIGNATURE_KEY, report.signature)
      if (state === 'ok' || !settings.notifyOnRecover) return 0

      const sent = await send(buildSyncMessage(report, 'ฐานข้อมูลกลับมาตรงกันแล้ว'), 'กลับมาปกติ')
      if (sent) await Watermark.set(LAST_SENT_KEY, now.toISO()!)
      return sent
    }

    // --- มีปัญหา -------------------------------------------------------------
    // ปัญหาคนละเรื่องกับรอบก่อนต้องบอกทันที ไม่ต้องรอครบ throttle
    // เช่นเมื่อกี้แค่ตามหลัง ตอนนี้ต่อไม่ได้ — คนละความรุนแรงกันมาก
    const previous = await Watermark.get(LAST_SIGNATURE_KEY)
    if (state === 'warn' && report.signature === previous && (await this.#throttled(settings, now))) {
      logger.debug({ signature: report.signature }, 'ข้ามการเตือนฐานข้อมูล — เพิ่งเตือนเรื่องเดิมไป')
      return 0
    }

    const sent = await send(buildSyncMessage(report), report.headline.slice(0, 200))
    await Watermark.set(STATE_KEY, 'warn' satisfies AlertState)
    await Watermark.set(LAST_SIGNATURE_KEY, report.signature)
    if (sent) await Watermark.set(LAST_SENT_KEY, now.toISO()!)
    return sent
  }

  async #throttled(settings: DbSyncSetting, now: DateTime) {
    const last = await Watermark.get(LAST_SENT_KEY)
    if (!last) return false

    return now.diff(DateTime.fromISO(last), 'minutes').minutes < settings.throttleMinutes
  }

  async #digestDue(settings: DbSyncSetting, now: DateTime) {
    if (!settings.digestAt) return false

    const [hour, minute] = settings.digestAt.split(':').map(Number)
    if (Number.isNaN(hour) || Number.isNaN(minute)) return false

    if (now < now.set({ hour, minute, second: 0, millisecond: 0 })) return false

    return (await Watermark.get(LAST_DIGEST_KEY)) !== now.toISODate()
  }

  /**
   * ส่งผลตรวจเข้ากลุ่มทันทีตามคำสั่งคน — ไม่ผ่าน throttle ไม่ขยับตัวนับ
   *
   * นับเป็น digest เรื่องรูปแบบ เพราะคนกดปุ่มเองมักกดเพื่อดูว่าการ์ดหน้าตาเป็นยังไง
   */
  async sendNow(settings: DbSyncSetting, report: SyncReport) {
    if (!settings.groupId) return { sent: 0, error: 'ยังไม่ได้เลือกกลุ่ม LINE' }

    const group = await NotifyGroup.find(settings.groupId)
    if (!group?.isUsable) return { sent: 0, error: 'กลุ่มถูกปิดใช้งาน หรือยังไม่ได้ใส่ key' }

    try {
      const outcome = await dispatch({
        groups: [group],
        body: buildSyncMessage(report, 'ตรวจฐานข้อมูล (สั่งเอง)'),
        messages: settings.wantsCard(true) ? buildSyncFlex(report, settings.cardColor) : undefined,
        source: 'dbsync',
        subject: 'ตรวจเอง',
      })
      return { sent: outcome.sent, error: outcome.failed ? 'ส่งไม่ผ่าน — ดูประวัติการส่ง' : null }
    } catch (error) {
      return { sent: 0, error: scrubCid(String(error?.message ?? error)) }
    }
  }
}
