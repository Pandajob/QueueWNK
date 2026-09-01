import { DateTime } from 'luxon'
import type { HttpContext } from '@adonisjs/core/http'

import AppointmentSetting from '#models/appointment'
import { AppointmentReminder, DEFAULT_HTML, DEFAULT_TEXT } from '#services/appointment_reminder'
import { appointmentValidator } from '#validators/notify'
import { audit, diff } from '#services/audit'

export default class AppointmentController {
  async index({ view }: HttpContext) {
    const settings = await AppointmentSetting.current()
    const reminder = new AppointmentReminder()

    const target = DateTime.now()
      .setZone('Asia/Bangkok')
      .plus({ days: settings.daysAhead })
      .toISODate()!

    // HOSxP อาจต่อไม่ได้ชั่วคราว — หน้าตั้งค่ายังต้องเปิดแก้ได้
    const [clinics, upcoming] = await Promise.all([
      reminder.clinics().catch(() => null),
      reminder.fetch(target, 2000).catch(() => null),
    ])

    // ตัวอย่างข้อความจากนัดจริงรายแรกที่อยู่ในคลินิกที่เปิดไว้
    const sampleRow = upcoming?.find((row) => settings.watches(row.clinic)) ?? upcoming?.[0]
    const preview = sampleRow ? reminder.build(sampleRow, settings, target) : null

    return view.render('pages/appointment', {
      settings,
      clinics,
      target,
      totalUpcoming: upcoming?.length ?? null,
      matched: upcoming?.filter((row) => settings.watches(row.clinic)).length ?? null,
      preview,
      defaults: { text: DEFAULT_TEXT, html: DEFAULT_HTML },
      hosxpDown: clinics === null,
    })
  }

  async save(ctx: HttpContext) {
    const { request, response, session } = ctx
    const data = await request.validateUsing(appointmentValidator)
    const settings = await AppointmentSetting.current()
    const before = settings.serialize()

    const wasEnabled = settings.isEnabled
    const willEnable = Boolean(data.isEnabled)
    const willSendForReal = willEnable && !data.dryRun

    settings.merge({
      isEnabled: willEnable,
      dryRun: Boolean(data.dryRun),
      daysAhead: data.daysAhead,
      sendAt: data.sendAt,
      allClinics: Boolean(data.allClinics),
      clinicCodes: data.allClinics ? null : (data.clinicCodes ?? []),
      messageTitle: data.messageTitle,
      messageText: data.messageText,
      messageHtml: data.messageHtml,
    })
    await settings.save()

    await audit(ctx, {
      action: 'update',
      entity: 'appointment',
      entityId: settings.id,
      summary: 'แก้ไขการตั้งค่าแจ้งเตือนนัดหมาย',
      changes: diff(before, settings.serialize()),
    })

    if (willSendForReal && (!wasEnabled || before.dryRun)) {
      session.flash(
        'success',
        `เปิดส่งจริงแล้ว — รอบถัดไปเวลา ${settings.sendAt} ข้อความจะถึงผู้ป่วยจริง ` +
          'ตรวจข้อความตัวอย่างให้แน่ใจก่อน'
      )
    } else if (willEnable && !wasEnabled) {
      session.flash('success', 'เปิดใช้งานแล้ว — dry run ยังเปิดอยู่ ยังไม่มีข้อความถึงผู้ป่วย')
    } else {
      session.flash('success', 'บันทึกแล้ว')
    }

    return response.redirect().toRoute('appointment.index')
  }
}
