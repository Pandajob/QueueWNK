import type { HttpContext } from '@adonisjs/core/http'

import { CdcuSeen, CdcuSetting, NotifyGroup } from '#models/notify_system'
import { CdcuWatcher } from '#services/cdcu_watcher'
import { cdcuValidator } from '#validators/notify'
import { audit, diff } from '#services/audit'

export default class CdcuController {
  async index({ view, request }: HttpContext) {
    const days = Math.min(Number(request.input('days', 30)) || 30, 365)
    const watcher = new CdcuWatcher()

    // HOSxP อาจต่อไม่ได้ชั่วคราว — หน้าตั้งค่ายังต้องเปิดดูได้
    const [settings, groups, cases, summary, diseases] = await Promise.all([
      CdcuSetting.current(),
      NotifyGroup.query().where('is_active', true).orderBy('name'),
      watcher.recentCases(days).catch(() => null),
      watcher.summaryByDisease(days).catch(() => null),
      watcher.diseases().catch(() => null),
    ])

    const notified = await CdcuSeen.query().orderBy('id', 'desc').limit(200)
    const notifiedBySv = new Map(notified.map((row) => [row.svNumber, row]))

    return view.render('pages/notify/cdcu', {
      settings,
      groups,
      cases,
      summary,
      diseases,
      notifiedBySv,
      days,
      hosxpDown: cases === null,
    })
  }

  async save(ctx: HttpContext) {
    const { request, response, session } = ctx
    const data = await request.validateUsing(cdcuValidator)
    const settings = await CdcuSetting.current()
    const before = settings.serialize()

    const wasEnabled = settings.isEnabled
    const willEnable = Boolean(data.isEnabled)

    settings.merge({
      isEnabled: willEnable,
      groupId: data.groupId ?? null,
      watchAll: Boolean(data.watchAll),
      watchedCodes: data.watchAll ? null : (data.watchedCodes ?? []),
      includeHn: Boolean(data.includeHn),
      includeName: Boolean(data.includeName),
      includePhone: Boolean(data.includePhone),
      quietStart: data.quietStart,
      quietEnd: data.quietEnd,
      throttleMinutes: data.throttleMinutes,
    })
    await settings.save()

    await audit(ctx, {
      action: 'update',
      entity: 'cdcu',
      entityId: settings.id,
      summary: 'แก้ไขการตั้งค่าเฝ้าระวังโรค 506',
      changes: diff(before, settings.serialize()),
    })

    if (willEnable && !settings.groupId) {
      session.flash('error', 'เปิดใช้งานแล้วแต่ยังไม่ได้เลือกกลุ่ม LINE — ยังไม่มีข้อความออกไปไหน')
    } else if (willEnable && !wasEnabled) {
      session.flash(
        'success',
        'เปิดการเฝ้าระวังแล้ว — รอบแรกจะตั้งหลักที่เคสล่าสุด แล้วแจ้งเฉพาะเคสที่เข้ามาหลังจากนี้'
      )
    } else {
      session.flash('success', 'บันทึกแล้ว')
    }

    return response.redirect().toRoute('notify.cdcu')
  }
}
