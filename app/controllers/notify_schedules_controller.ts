import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'

import { NotifyGroup, NotifySchedule, NotifyTemplate } from '#models/notify_system'
import { scheduleValidator } from '#validators/notify'
import { audit, diff } from '#services/audit'

export const WEEKDAYS = [
  { value: 1, label: 'จันทร์' },
  { value: 2, label: 'อังคาร' },
  { value: 3, label: 'พุธ' },
  { value: 4, label: 'พฤหัสบดี' },
  { value: 5, label: 'ศุกร์' },
  { value: 6, label: 'เสาร์' },
  { value: 7, label: 'อาทิตย์' },
]

export default class NotifySchedulesController {
  async index({ view }: HttpContext) {
    const schedules = await NotifySchedule.query()
      .preload('template')
      .preload('groups')
      .orderBy('run_at')

    return view.render('pages/notify/schedules', {
      schedules,
      weekdays: WEEKDAYS,
      now: DateTime.now().setZone('Asia/Bangkok'),
    })
  }

  async create({ view }: HttpContext) {
    return view.render('pages/notify/schedule_form', {
      item: null,
      selectedGroups: [],
      ...(await this.#options()),
    })
  }

  async edit({ params, view, response, session }: HttpContext) {
    const item = await NotifySchedule.query().where('id', params.id).preload('groups').first()

    if (!item) {
      session.flash('error', 'ไม่พบตารางเวลานี้')
      return response.redirect().toRoute('notify.schedules')
    }

    return view.render('pages/notify/schedule_form', {
      item,
      selectedGroups: item.groups.map((g) => g.id),
      ...(await this.#options()),
    })
  }

  async store(ctx: HttpContext) {
    const { request, response, session } = ctx
    const data = await request.validateUsing(scheduleValidator)

    const schedule = await NotifySchedule.create(this.#attributes(data))
    await schedule.related('groups').sync(data.groups ?? [])

    await audit(ctx, {
      action: 'create',
      entity: 'schedule',
      entityId: schedule.id,
      summary: `เพิ่มตารางเวลา "${schedule.name}" (${schedule.scheduleLabel})`,
    })

    session.flash('success', `เพิ่มตารางเวลา "${schedule.name}" แล้ว`)
    return response.redirect().toRoute('notify.schedules')
  }

  async update(ctx: HttpContext) {
    const { params, request, response, session } = ctx
    const schedule = await NotifySchedule.find(params.id)

    if (!schedule) {
      session.flash('error', 'ไม่พบตารางเวลานี้')
      return response.redirect().toRoute('notify.schedules')
    }

    const data = await request.validateUsing(scheduleValidator)
    const before = schedule.serialize()

    schedule.merge(this.#attributes(data))
    await schedule.save()
    await schedule.related('groups').sync(data.groups ?? [])

    await audit(ctx, {
      action: 'update',
      entity: 'schedule',
      entityId: schedule.id,
      summary: `แก้ไขตารางเวลา "${schedule.name}"`,
      changes: diff(before, schedule.serialize()),
    })

    session.flash('success', 'บันทึกแล้ว')
    return response.redirect().toRoute('notify.schedules')
  }

  async destroy(ctx: HttpContext) {
    const { params, response, session } = ctx
    const schedule = await NotifySchedule.find(params.id)

    if (!schedule) {
      session.flash('error', 'ไม่พบตารางเวลานี้')
      return response.redirect().toRoute('notify.schedules')
    }

    const name = schedule.name
    await schedule.delete()

    await audit(ctx, {
      action: 'delete',
      entity: 'schedule',
      entityId: params.id,
      summary: `ลบตารางเวลา "${name}"`,
    })

    session.flash('success', `ลบตารางเวลา "${name}" แล้ว`)
    return response.redirect().toRoute('notify.schedules')
  }

  /** เปิด/ปิดจากหน้ารายการโดยไม่ต้องเข้าไปแก้ */
  async toggle(ctx: HttpContext) {
    const { params, response, session } = ctx
    const schedule = await NotifySchedule.find(params.id)

    if (!schedule) {
      session.flash('error', 'ไม่พบตารางเวลานี้')
      return response.redirect().toRoute('notify.schedules')
    }

    schedule.isEnabled = !schedule.isEnabled
    await schedule.save()

    await audit(ctx, {
      action: 'toggle',
      entity: 'schedule',
      entityId: schedule.id,
      summary: `${schedule.isEnabled ? 'เปิด' : 'ปิด'}ตารางเวลา "${schedule.name}"`,
    })

    session.flash('success', `${schedule.isEnabled ? 'เปิด' : 'ปิด'} "${schedule.name}" แล้ว`)
    return response.redirect().toRoute('notify.schedules')
  }

  #attributes(data: Awaited<ReturnType<(typeof scheduleValidator)['validate']>>) {
    return {
      name: data.name,
      templateId: data.templateId,
      frequency: data.frequency,
      runAt: data.runAt,
      daysOfWeek: data.frequency === 'weekly' ? data.daysOfWeek ?? [] : null,
      dayOfMonth: data.frequency === 'monthly' ? data.dayOfMonth ?? 1 : null,
      isEnabled: Boolean(data.isEnabled),
    }
  }

  async #options() {
    return {
      templates: await NotifyTemplate.query().where('is_enabled', true).orderBy('name'),
      groups: await NotifyGroup.query().where('is_active', true).orderBy('name'),
      weekdays: WEEKDAYS,
    }
  }
}
