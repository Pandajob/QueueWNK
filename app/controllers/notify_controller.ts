import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'

import WorkerHeartbeat from '#models/worker_heartbeat'
import {
  CdcuSeen,
  CdcuSetting,
  NotifyAuditLog,
  NotifyDataset,
  NotifyGroup,
  NotifyMessage,
  NotifySchedule,
  NotifyTemplate,
} from '#models/notify_system'

/** แดชบอร์ด ประวัติการส่ง และประวัติการแก้ไข */
export default class NotifyController {
  async dashboard({ view }: HttpContext) {
    const since7 = DateTime.now().minus({ days: 7 }).toSQL({ includeOffset: false })!
    const startOfToday = DateTime.now().setZone('Asia/Bangkok').startOf('day').toSQL({
      includeOffset: false,
    })!

    const [
      groups,
      schedules,
      templates,
      datasets,
      todayCounts,
      weekCounts,
      recent,
      failing,
      cdcu,
      cdcuToday,
      heartbeat,
    ] = await Promise.all([
      NotifyGroup.query().orderBy('name'),
      NotifySchedule.query().preload('template').orderBy('run_at'),
      NotifyTemplate.query().count('* as total').first(),
      NotifyDataset.query().count('* as total').first(),
      NotifyMessage.query()
        .select('status')
        .count('* as total')
        .where('created_at', '>=', startOfToday)
        .groupBy('status'),
      NotifyMessage.query()
        .select('status')
        .count('* as total')
        .where('created_at', '>=', since7)
        .groupBy('status'),
      NotifyMessage.query().orderBy('id', 'desc').limit(8),
      NotifyMessage.query().where('status', 'failed').orderBy('id', 'desc').limit(5),
      CdcuSetting.current(),
      CdcuSeen.query().where('created_at', '>=', startOfToday).count('* as total').first(),
      WorkerHeartbeat.findBy('name', 'notify:watch'),
    ])

    const tally = (rows: NotifyMessage[]) => {
      const out: Record<string, number> = { sent: 0, failed: 0, skipped: 0 }
      for (const row of rows) out[row.status] = Number(row.$extras.total)
      return out
    }

    const now = DateTime.now().setZone('Asia/Bangkok')

    return view.render('pages/notify/dashboard', {
      groups,
      usableGroups: groups.filter((g) => g.isUsable).length,
      schedules,
      dueToday: schedules.filter((s) => s.isEnabled).length,
      templateCount: Number(templates?.$extras.total ?? 0),
      datasetCount: Number(datasets?.$extras.total ?? 0),
      today: tally(todayCounts),
      week: tally(weekCounts),
      recent,
      failing,
      cdcu,
      cdcuToday: Number(cdcuToday?.$extras.total ?? 0),
      heartbeat,
      now,
    })
  }

  // --- ประวัติการส่ง ---------------------------------------------------------

  async history({ view, request }: HttpContext) {
    const status = request.input('status', 'all')
    const source = request.input('source', 'all')
    const page = Number(request.input('page', 1))

    const query = NotifyMessage.query().orderBy('id', 'desc')
    if (status !== 'all') query.where('status', status)
    if (source !== 'all') query.where('source', source)

    const messages = await query.paginate(page, 40)
    messages.baseUrl('/notify/history')
    messages.queryString({ status, source })

    const counts = await NotifyMessage.query()
      .select('status')
      .count('* as total')
      .groupBy('status')
    const summary: Record<string, number> = {}
    for (const row of counts) summary[row.status] = Number(row.$extras.total)

    return view.render('pages/notify/history', { messages, status, source, summary })
  }

  /** ดูข้อความเต็มของรายการเดียว */
  async showMessage({ params, view, response, session }: HttpContext) {
    const message = await NotifyMessage.find(params.id)

    if (!message) {
      session.flash('error', 'ไม่พบรายการนี้')
      return response.redirect().toRoute('notify.history')
    }

    return view.render('pages/notify/message', { item: message })
  }

  // --- ประวัติการแก้ไข -------------------------------------------------------

  async audit({ view, request }: HttpContext) {
    const entity = request.input('entity', 'all')
    const page = Number(request.input('page', 1))

    const query = NotifyAuditLog.query().orderBy('id', 'desc')
    if (entity !== 'all') query.where('entity', entity)

    const logs = await query.paginate(page, 50)
    logs.baseUrl('/notify/audit')
    logs.queryString({ entity })

    const entities = await db
      .from('notify_audit_logs')
      .select('entity')
      .count('* as total')
      .groupBy('entity')
      .orderBy('entity')

    return view.render('pages/notify/audit', { logs, entity, entities })
  }
}
