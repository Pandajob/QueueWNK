import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'

import HosxpConnection from '#models/hosxp_connection'
import { DbHost, DbSyncSetting, MESSAGE_STYLE_LABELS } from '#models/db_sync'
import { NotifyGroup } from '#models/notify_system'
import { DbSyncWatcher, buildSyncMessage } from '#services/db_sync_watcher'
import { METRICS, ROLE_LABELS, VERDICT_LABELS } from '#services/db_sync_checker'
import { dbSyncValidator } from '#validators/notify'
import { audit, diff } from '#services/audit'

/** จำนวนแถวเปล่าที่เตรียมไว้ให้กรอกเครื่องใหม่ */
const BLANK_ROWS = 2

type HostRow = {
  id?: number
  label?: string
  host?: string
  port?: number
  username?: string
  password?: string
  enabled?: '1' | '0'
}

export default class DbSyncController {
  async index({ view }: HttpContext) {
    const settings = await DbSyncSetting.current()
    const connection = await HosxpConnection.active()

    await this.#seedFromActive(connection)

    const [hosts, groups] = await Promise.all([
      DbHost.ordered(),
      NotifyGroup.query().where('is_active', true).orderBy('name'),
    ])
    const lastReport = settings.lastReport

    return view.render('pages/settings/db_sync', {
      settings,
      hosts,
      groups,
      connection,
      lastReport,
      checkedAtLabel: lastReport
        ? DateTime.fromISO(lastReport.checkedAt)
            .setZone('Asia/Bangkok')
            .toFormat('dd/MM/yyyy HH:mm:ss')
        : null,
      metrics: METRICS,
      verdictLabels: VERDICT_LABELS,
      roleLabels: ROLE_LABELS,
      messageStyles: Object.entries(MESSAGE_STYLE_LABELS).map(([value, label]) => ({
        value,
        label,
      })),
      // ดัชนีของแถวเปล่าที่ต่อท้าย ต้องไม่ชนกับแถวที่มีอยู่ ไม่งั้นค่าจะทับกันตอน submit
      blankIndexes: Array.from({ length: BLANK_ROWS }, (_, i) => hosts.length + i),
    })
  }

  async save(ctx: HttpContext) {
    const { request, response, session } = ctx
    const data = await request.validateUsing(dbSyncValidator)

    const settings = await DbSyncSetting.current()
    const before = settings.serialize()

    settings.merge({
      isEnabled: Boolean(data.isEnabled),
      groupId: data.groupId ?? null,
      checkEveryMinutes: data.checkEveryMinutes,
      lagWarnSeconds: data.lagWarnSeconds,
      rowGapWarn: data.rowGapWarn,
      gtidLagWarn: data.gtidLagWarn,
      throttleMinutes: data.throttleMinutes,
      notifyOnRecover: Boolean(data.notifyOnRecover),
      digestAt: data.digestAt || null,
      messageStyle: data.messageStyle,
      cardColor: data.cardColor,
    })
    await settings.save()

    const changed = await this.#saveHosts(data.hosts ?? [])

    await audit(ctx, {
      action: 'update',
      entity: 'db_sync',
      entityId: settings.id,
      summary: 'แก้ไขการเฝ้าเครื่องฐานข้อมูล' + (changed ? ` · ${changed}` : ''),
      changes: diff(before, settings.serialize()),
    })

    if (settings.isEnabled && !settings.groupId) {
      session.flash('error', 'เปิดการเฝ้าแล้วแต่ยังไม่ได้เลือกกลุ่ม LINE — ยังไม่มีข้อความออกไปไหน')
    } else {
      session.flash('success', 'บันทึกแล้ว')
    }

    return response.redirect().toRoute('settings.dbsync')
  }

  /** ตรวจเดี๋ยวนี้ ไม่ส่งเข้ากลุ่ม */
  async check({ response, session }: HttpContext) {
    const settings = await DbSyncSetting.current()
    const report = await new DbSyncWatcher().check(settings)

    if (!report) {
      session.flash('error', 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ HOSxP')
    } else if (report.verdict === 'no_data') {
      session.flash('error', 'ยังไม่ได้เพิ่มเครื่องที่จะเฝ้า')
    } else if (report.shouldAlert) {
      session.flash('error', report.headline)
    } else {
      session.flash('success', report.headline)
    }

    return response.redirect().toRoute('settings.dbsync')
  }

  /** ตรวจแล้วส่งผลเข้ากลุ่มทันที ใช้ทดสอบว่าข้อความหน้าตาเป็นอย่างไร */
  async send(ctx: HttpContext) {
    const { response, session } = ctx
    const settings = await DbSyncSetting.current()
    const watcher = new DbSyncWatcher()
    const report = await watcher.check(settings)

    if (!report || report.verdict === 'no_data') {
      session.flash('error', 'ยังไม่มีผลตรวจให้ส่ง')
      return response.redirect().toRoute('settings.dbsync')
    }

    const outcome = await watcher.sendNow(settings, report)

    await audit(ctx, {
      action: 'send',
      entity: 'db_sync',
      entityId: settings.id,
      summary: `ส่งผลตรวจฐานข้อมูลเข้ากลุ่มเอง — ${report.verdict}`,
    })

    if (outcome.error) session.flash('error', outcome.error)
    else session.flash('success', 'ส่งเข้ากลุ่มแล้ว')

    return response.redirect().toRoute('settings.dbsync')
  }

  /** ดูข้อความที่จะส่งโดยไม่ส่งจริง */
  async preview({ response, session }: HttpContext) {
    const settings = await DbSyncSetting.current()
    const report = await new DbSyncWatcher().check(settings)

    if (!report || report.verdict === 'no_data') {
      session.flash('error', 'ยังไม่มีผลตรวจให้ดู')
    } else {
      session.flash('preview', buildSyncMessage(report))
    }

    return response.redirect().toRoute('settings.dbsync')
  }

  /**
   * ตารางว่าง = ยังไม่เคยตั้งค่า ใส่เครื่องที่ poller ใช้อยู่ให้หนึ่งแถว
   *
   * เริ่มจากเครื่องเดียวมีประโยชน์กว่าเริ่มจากศูนย์ — หน้าเว็บมีของให้ดูทันที
   * และผู้ใช้แค่เติมเครื่องที่เหลือ ไม่ต้องพิมพ์ค่าที่ระบบรู้อยู่แล้วซ้ำ
   */
  async #seedFromActive(connection: HosxpConnection | null) {
    if (!connection) return
    if ((await DbHost.query().count('* as total'))[0].$extras.total > 0) return

    await DbHost.create({
      label: connection.label || 'เครื่องที่ระบบใช้อยู่',
      host: connection.host,
      port: connection.port,
      isEnabled: true,
      sortOrder: 0,
    })
  }

  /**
   * บันทึกรายการเครื่อง
   *
   * ล้างช่อง host แล้วบันทึก = ลบเครื่องนั้น — ตั้งใจไม่ทำปุ่มลบแยก เพราะฟอร์มนี้
   * มีแถวไม่กี่แถวและการมีปุ่มลบทีละแถวแปลว่าต้องมีฟอร์มซ้อนฟอร์ม
   */
  async #saveHosts(rows: HostRow[]) {
    const notes: string[] = []
    let order = 0

    for (const row of rows) {
      const existing = row.id ? await DbHost.find(row.id) : null
      const host = (row.host ?? '').trim()

      if (!host) {
        if (existing) {
          notes.push(`ลบ ${existing.host}`)
          await existing.delete()
        }
        continue
      }

      const target = existing ?? new DbHost()
      const isNew = !existing

      target.label = (row.label ?? '').trim() || host
      target.host = host
      target.port = row.port ?? 3306
      target.username = (row.username ?? '').trim() || null
      target.isEnabled = row.enabled !== '0'
      target.sortOrder = order++

      // ว่าง = ใช้ของเดิม (หรือใช้รหัสร่วมถ้ายังไม่เคยตั้ง)
      if (row.password) target.password = row.password

      await target.save()
      if (isNew) notes.push(`เพิ่ม ${host}`)
    }

    return notes.join(' · ')
  }
}
