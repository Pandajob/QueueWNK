import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'

import HosxpConnection from '#models/hosxp_connection'
import MophCredential from '#models/moph_credential'
import AlertTemplate from '#models/alert_template'
import {
  DepartmentSetting,
  Notification,
  PollerSetting,
  VisitState,
  Watermark,
} from '#models/poller_models'
import { HosxpClient } from '#services/hosxp_client'
import { MophClient } from '#services/moph_client'
import type { AlertCaseKey, PlaceholderKey } from '#services/alert_cases'

/** ห้องที่ไม่ใช่จุดรอตรวจ ไม่ควรแจ้งเตือนไม่ว่าจะตั้งค่าไว้ยังไง */
const NEVER_NOTIFY = new Set(['999', '009'])

/** สถานะที่ถือว่ายังรออยู่ — ค่า 2 ยังไม่ยืนยันความหมาย จึงไม่ส่ง */
const WAITING_STATUS = 1

const MAX_ATTEMPTS = 3

export type QueueRow = {
  vn: string
  hn: string
  fullname: string | null
  depq: string | null
  dep: string | null
  opd_dep: string | null
  status: number | null
  time_visit: string | null
  time_visit_opd: string | null
  dep_name: string | null
}

export type CycleResult = {
  scanned: number
  created: number
  sent: number
  failed: number
  skipped: number
  dryRun: boolean
  note?: string
}

function maskCid(cid: string) {
  return cid.length === 13 ? `${cid.slice(0, 4)}xxxxx${cid.slice(9)}` : '***'
}

export class QueuePoller {
  /** รันหนึ่งรอบ — ตรวจจับแล้วส่ง */
  async runCycle(): Promise<CycleResult> {
    const empty: CycleResult = {
      scanned: 0,
      created: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      dryRun: true,
    }

    const [connection, credential, settings] = await Promise.all([
      HosxpConnection.active(),
      MophCredential.active(),
      PollerSetting.current(),
    ])

    if (!connection?.password) {
      return { ...empty, dryRun: settings.dryRun, note: 'ยังไม่ได้ตั้งค่า HOSxP' }
    }

    await AlertTemplate.ensureSeeded()

    const client = await HosxpClient.connect({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      username: connection.username,
      password: connection.password,
      charset: connection.charset,
    })

    try {
      const rows = await this.#fetchToday(client)
      await this.#syncDepartments(rows)

      const created = await this.#detect(rows, settings)
      const dispatch = await this.#dispatch(client, credential, settings)

      await Watermark.set('last_cycle_at', DateTime.now().toISO())

      return {
        scanned: rows.length,
        created,
        dryRun: settings.dryRun,
        ...dispatch,
      }
    } finally {
      await client.close()
    }
  }

  /**
   * ดึงคิวของวันนี้ทั้งหมด
   *
   * ไม่ใช้ watermark กรองเพราะเหตุการณ์ "ใกล้ถึงคิว" เกิดจากการที่ *คนอื่น*
   * ขยับออกไป แถวของคนที่รออยู่จะไม่เปลี่ยนเลย ถ้ากรองด้วย time_visit
   * จะไม่มีวันเห็นและไม่มีวันแจ้งเตือน
   *
   * วันหนึ่งมีร้อยกว่าแถว การอ่านทั้งหมดทุกรอบจึงถูกกว่าการพลาดเหตุการณ์
   */
  async #fetchToday(client: HosxpClient): Promise<QueueRow[]> {
    const started = Date.now()
    const { from, to } = this.#vnRangeForToday()

    // กรองด้วยช่วง vn เป็นหลัก ไม่ใช่ date_visit
    //
    // date_visit ไม่มี index (ยืนยันด้วย SHOW INDEX) การกรองด้วยมันคือ full scan
    // ทั้งตาราง 237k แถว 88MB ทุก 15 วินาทีบนเครื่องหลักของโรงพยาบาล
    //
    // vn เป็น PK และมีรูปแบบ YYMMDDHHMMSS (พ.ศ.) จึงใช้ range scan บน PK ได้
    // ตรวจกับข้อมูลจริงย้อนหลัง 14 วันแล้วว่าจำนวนแถวตรงกับ date_visit ทุกวัน
    // (ดู `node ace hosxp:server-info`) แต่ยังคง date_visit ไว้เป็นตัวกรองซ้ำ
    // เผื่อมีแถวที่ vn ไม่ตรงรูปแบบ จะได้ไม่หลุดเข้ามา
    const rows = await client.select<QueueRow>(
      `SELECT q.vn, q.hn, q.fullname, q.depq, q.dep, q.opd_dep, q.status,
              q.time_visit, q.time_visit_opd, k.department AS dep_name
         FROM ovst_queue_server q
         LEFT JOIN kskdepartment k ON k.depcode = q.dep
        WHERE q.vn >= ? AND q.vn <= ?
          AND q.date_visit = CURDATE()
        ORDER BY q.time_visit`,
      [from, to]
    )

    const elapsed = Date.now() - started
    if (elapsed > 1000) {
      logger.warn(
        { elapsed, rows: rows.length, from, to },
        'อ่าน ovst_queue_server ช้ากว่า 1 วินาที — ตรวจว่า range scan บน PK ยังทำงานอยู่'
      )
    }

    return rows
  }

  /** vn ของ HOSxP คือ YYMMDDHHMMSS โดย YY เป็นปี พ.ศ. สองหลักท้าย */
  #vnRangeForToday() {
    const now = DateTime.now().setZone('Asia/Bangkok')
    const buddhistYear = String((now.year + 543) % 100).padStart(2, '0')
    const prefix = `${buddhistYear}${now.toFormat('MMdd')}`

    return { from: `${prefix}000000`, to: `${prefix}999999` }
  }

  /** เก็บรายชื่อห้องที่เจอไว้ให้ตั้งค่าเปิด/ปิดได้ ตั้งต้นปิดทั้งหมด */
  async #syncDepartments(rows: QueueRow[]) {
    const seen = new Map<string, string | null>()
    for (const row of rows) {
      if (row.dep && !NEVER_NOTIFY.has(row.dep)) seen.set(row.dep, row.dep_name)
    }
    if (!seen.size) return

    const existing = await DepartmentSetting.query().whereIn('depcode', [...seen.keys()])
    const have = new Set(existing.map((d) => d.depcode))

    for (const [depcode, name] of seen) {
      if (have.has(depcode)) continue
      await DepartmentSetting.create({ depcode, name, isEnabled: false })
    }
  }

  /** เทียบกับ snapshot รอบก่อน แล้วสร้างรายการที่ต้องส่ง */
  async #detect(rows: QueueRow[], settings: PollerSetting) {
    const enabled = new Set(
      (await DepartmentSetting.query().where('is_enabled', true)).map((d) => d.depcode)
    )

    const states = new Map(
      (await VisitState.query().whereIn('vn', rows.map((r) => r.vn).slice(0, 5000))).map((s) => [
        s.vn,
        s,
      ])
    )

    // จำนวนคนที่รออยู่ข้างหน้าในห้องเดียวกัน — นับเอง ไม่พึ่ง wait_dep
    // เพราะยังยืนยันความหมายของคอลัมน์นั้นไม่ได้
    const aheadByVn = new Map<string, number>()
    const byDep = new Map<string, QueueRow[]>()
    for (const row of rows) {
      if (!row.dep || row.status !== WAITING_STATUS) continue
      const list = byDep.get(row.dep) ?? []
      list.push(row)
      byDep.set(row.dep, list)
    }
    for (const list of byDep.values()) {
      list.sort((a, b) => (a.time_visit ?? '').localeCompare(b.time_visit ?? ''))
      list.forEach((row, index) => aheadByVn.set(row.vn, index))
    }

    let created = 0

    for (const row of rows) {
      const previous = states.get(row.vn)
      const notifiable =
        row.dep !== null &&
        !NEVER_NOTIFY.has(row.dep) &&
        enabled.has(row.dep) &&
        row.status === WAITING_STATUS

      const events: AlertCaseKey[] = []

      if (notifiable) {
        if (!previous) {
          events.push('queue_notify')
        } else if (previous.dep !== row.dep || previous.depq !== row.depq) {
          events.push('queue_changed')
        }

        const ahead = aheadByVn.get(row.vn)
        if (
          ahead !== undefined &&
          ahead <= settings.nearThreshold &&
          previous?.lastNotifiedWaiting == null &&
          !events.includes('queue_notify')
        ) {
          events.push('queue_near')
        }
      }

      for (const caseKey of events) {
        if (await this.#queue(row, caseKey, aheadByVn.get(row.vn) ?? 0)) created++
      }

      await this.#saveState(
        row,
        previous,
        events.includes('queue_near') ? (aheadByVn.get(row.vn) ?? 0) : undefined
      )
    }

    return created
  }

  /** เขียนรายการที่จะส่งลงคิว dedup_key เป็น UNIQUE จึงกันซ้ำได้แม้รอบซ้อนกัน */
  async #queue(row: QueueRow, caseKey: AlertCaseKey, ahead: number) {
    const template = await AlertTemplate.findBy('case_key', caseKey)
    if (!template?.isEnabled) return false

    const discriminator = caseKey === 'queue_near' ? 'near' : `${row.dep ?? ''}-${row.depq ?? ''}`
    const dedupKey = `${row.vn}:${caseKey}:${discriminator}`

    const values: Partial<Record<PlaceholderKey, string>> = {
      name: row.fullname ?? '',
      queue_no: row.depq ?? '',
      queue_waiting: String(ahead),
      hn_no: row.hn,
      service: row.dep_name ?? row.dep ?? '',
    }

    // cid ยังไม่ใส่ตอนนี้ ไปอ่านสด ๆ ตอนส่ง จะได้ไม่สำเนาเลขบัตรมาเก็บอีกที่
    const payload = template.buildPayload('', values)
    delete payload.cid

    // กันซ้ำที่ระดับฐานข้อมูล ไม่ใช่เช็คก่อนแล้วค่อย insert
    // เพราะสองรอบที่ทำงานซ้อนกันจะเช็คผ่านทั้งคู่แล้วส่งซ้ำ
    //
    // ใช้ ON DUPLICATE KEY UPDATE ที่ไม่เปลี่ยนอะไร แทน INSERT IGNORE
    // เพราะ INSERT IGNORE กลืน error อื่นด้วย เช่นข้อมูลยาวเกินคอลัมน์
    // แบบนี้จะกลืนเฉพาะกรณี dedup_key ซ้ำเท่านั้น
    const result = await db.rawQuery(
      `INSERT INTO notifications
         (dedup_key, vn, hn, case_key, dep, depq, payload, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NOW(), NOW())
       ON DUPLICATE KEY UPDATE dedup_key = dedup_key`,
      [dedupKey, row.vn, row.hn, caseKey, row.dep, row.depq, JSON.stringify(payload)]
    )

    // mysql2 คืน [ResultSetHeader, fields] — แถวใหม่ได้ affectedRows = 1
    // ส่วนที่ชนแล้วไม่เปลี่ยนอะไรได้ 0
    const header = Array.isArray(result) ? result[0] : result
    return (header?.affectedRows ?? 0) === 1
  }

  async #saveState(row: QueueRow, previous: VisitState | undefined, notifiedWaiting?: number) {
    const visitDate = DateTime.now().setZone('Asia/Bangkok').startOf('day')

    if (!previous) {
      await VisitState.create({
        vn: row.vn,
        visitDate,
        hn: row.hn,
        depq: row.depq,
        dep: row.dep,
        status: row.status,
        timeVisit: row.time_visit,
        lastNotifiedWaiting: notifiedWaiting ?? null,
      })
      return
    }

    previous.merge({
      depq: row.depq,
      dep: row.dep,
      status: row.status,
      timeVisit: row.time_visit,
      lastNotifiedWaiting: notifiedWaiting ?? previous.lastNotifiedWaiting,
    })
    await previous.save()
  }

  /** ส่งรายการที่ค้างอยู่ */
  async #dispatch(client: HosxpClient, credential: MophCredential | null, settings: PollerSetting) {
    const result = { sent: 0, failed: 0, skipped: 0 }

    const pending = await Notification.query()
      .where('status', 'pending')
      .where('attempts', '<', MAX_ATTEMPTS)
      .orderBy('id', 'asc')
      .limit(50)

    if (!pending.length) return result

    if (settings.isQuietNow()) {
      logger.info(
        `อยู่ในช่วงงดส่ง ${settings.quietStart}–${settings.quietEnd} — พัก ${pending.length} รายการไว้ก่อน`
      )
      return result
    }

    const moph =
      credential?.clientKey && credential?.secretKey
        ? new MophClient({
            baseUrl: credential.baseUrl,
            clientKey: credential.clientKey,
            secretKey: credential.secretKey,
          })
        : null

    for (const notification of pending) {
      const cid = await this.#resolveCid(client, notification.hn)

      if (!cid) {
        notification.merge({
          status: 'skipped',
          lastError: 'ไม่พบเลขบัตรประชาชน 13 หลักของ HN นี้',
        })
        await notification.save()
        result.skipped++
        continue
      }

      const payload = { ...notification.payload, cid }

      if (settings.dryRun) {
        logger.info(
          {
            vn: notification.vn,
            cid: maskCid(cid),
            case: notification.caseKey,
            depq: notification.depq,
          },
          'DRY RUN — ถ้าเปิดใช้งานจริงจะส่งรายการนี้'
        )
        notification.merge({ status: 'skipped', lastError: 'DRY RUN — ไม่ได้ส่งจริง' })
        await notification.save()
        result.skipped++
        continue
      }

      if (!moph) {
        notification.merge({ status: 'skipped', lastError: 'ยังไม่ได้ตั้งค่า MOPH Alert' })
        await notification.save()
        result.skipped++
        continue
      }

      notification.attempts++

      try {
        const response = await moph.sendTemplate(payload)
        const code = response.body?.message_code ?? response.status

        notification.mophCode = code

        if (code === 200) {
          notification.merge({ status: 'sent', sentAt: DateTime.now(), lastError: null })
          result.sent++
        } else {
          const message = response.body?.message ?? response.raw.slice(0, 200)

          // 404 = ไม่มี template / ไม่พบ LINE id / cid ไม่ได้ลงทะเบียนหมอพร้อม
          // ลองใหม่ก็ได้ผลเดิม ปิดเคสเลยดีกว่าวนซ้ำ
          notification.merge({
            status: code === 404 || notification.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
            lastError: message,
          })
          result.failed++
        }
      } catch (error) {
        notification.merge({
          status: notification.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          lastError: error.message,
        })
        result.failed++
      }

      await notification.save()
    }

    return result
  }

  /** อ่านเลขบัตรสด ๆ จาก HOSxP ไม่เก็บสำเนาไว้ในฐานเรา */
  async #resolveCid(client: HosxpClient, hn: string) {
    const rows = await client.select<{ cid: string | null }>(
      `SELECT cid FROM patient WHERE hn = ? LIMIT 1`,
      [hn]
    )
    const cid = rows[0]?.cid ?? ''
    return /^\d{13}$/.test(cid) ? cid : null
  }
}
