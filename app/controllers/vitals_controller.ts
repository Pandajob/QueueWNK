import { DateTime } from 'luxon'
import type { HttpContext } from '@adonisjs/core/http'

import { NotifyGroup, VitalsSetting } from '#models/notify_system'
import { VitalsWatcher } from '#services/vitals_watcher'
import { vitalsValidator } from '#validators/notify'
import { audit, diff } from '#services/audit'

export default class VitalsController {
  async index({ view }: HttpContext) {
    const settings = await VitalsSetting.current()
    const watcher = new VitalsWatcher()
    const now = DateTime.now().setZone('Asia/Bangkok')
    const window = watcher.windowFor(settings, now)

    // HOSxP อาจต่อไม่ได้ชั่วคราว — หน้าตั้งค่ายังต้องเปิดดูได้
    /**
     * ไม่คำนวณจำนวนรายต่อวันตรงนี้ — query นั้นใช้เวลา 4.4 วินาทีเพราะต้อง
     * ไล่ 30 วันแล้ว join กับรายชื่อผู้ป่วยความดันเดิม ถ้ารอจะบล็อกหน้าเว็บ
     * ให้ JS ยิงไปที่ปลายทาง preview เองหลังหน้าโหลดเสร็จ
     */
    const [groups, cases, departments] = await Promise.all([
      NotifyGroup.query().where('is_active', true).orderBy('name'),
      watcher.fetch(settings, window.from, window.to).catch(() => null),
      watcher.departments().catch(() => null),
    ])

    return view.render('pages/notify/vitals', {
      settings,
      groups,
      cases,
      departments,
      window,
      hosxpDown: cases === null,
    })
  }

  async save(ctx: HttpContext) {
    const { request, response, session } = ctx
    const data = await request.validateUsing(vitalsValidator)
    const settings = await VitalsSetting.current()
    const before = settings.serialize()

    const wasEnabled = settings.isEnabled
    const willEnable = Boolean(data.isEnabled)

    settings.merge({
      isEnabled: willEnable,
      groupId: data.groupId ?? null,
      sysThreshold: data.sysThreshold,
      diaThreshold: data.diaThreshold,
      allDepartments: Boolean(data.allDepartments),
      departmentCodes: data.allDepartments ? null : (data.departmentCodes ?? []),
      includeHn: Boolean(data.includeHn),
      includeName: Boolean(data.includeName),
      includeAddress: Boolean(data.includeAddress),
      includePhone: Boolean(data.includePhone),
      excludeKnownHt: Boolean(data.excludeKnownHt),
      sendAt: data.sendAt,
    })
    await settings.save()

    await audit(ctx, {
      action: 'update',
      entity: 'vitals',
      entityId: settings.id,
      summary: 'แก้ไขการตั้งค่ารายงานความดันสูง',
      changes: diff(before, settings.serialize()),
    })

    if (willEnable && !settings.groupId) {
      session.flash('error', 'เปิดใช้งานแล้วแต่ยังไม่ได้เลือกกลุ่ม LINE — ยังไม่มีข้อความออกไปไหน')
    } else if (willEnable && !wasEnabled) {
      session.flash('success', `เปิดใช้งานแล้ว — รายงานรอบแรกจะออกเวลา ${settings.sendAt} น.`)
    } else {
      session.flash('success', 'บันทึกแล้ว')
    }

    return response.redirect().toRoute('notify.vitals')
  }

  /**
   * สั่งส่งรายงานเดี๋ยวนี้โดยไม่รอเวลาที่ตั้งไว้
   *
   * ใช้ตรรกะเดียวกับรอบอัตโนมัติทุกอย่าง รวมถึงช่วงข้อมูลและการกรองแผนก
   * ส่งแล้วช่วงข้อมูลจะขยับตาม รอบของวันนี้จึงไม่ยิงซ้ำอีก
   */
  async runNow(ctx: HttpContext) {
    const { response, session } = ctx
    const settings = await VitalsSetting.current()

    if (!settings.groupId) {
      session.flash('error', 'ยังไม่ได้เลือกกลุ่ม LINE')
      return response.redirect().toRoute('notify.vitals')
    }

    const result = await new VitalsWatcher().runNow(settings)

    await audit(ctx, {
      action: 'send',
      entity: 'vitals',
      entityId: settings.id,
      summary: `สั่งส่งรายงานความดันสูงเดี๋ยวนี้ — พบ ${result.matched} ราย ส่ง ${result.sent}`,
    })

    if (result.note) session.flash('error', result.note)
    else if (!result.matched) session.flash('success', 'ไม่มีรายที่เข้าเกณฑ์ในช่วงนี้ ไม่ได้ส่ง')
    else if (result.sent) session.flash('success', `ส่งแล้ว — ${result.matched} ราย`)
    else session.flash('error', `พบ ${result.matched} ราย แต่ส่งไม่สำเร็จ ดูที่หน้าประวัติการส่ง`)

    return response.redirect().toRoute('notify.vitals')
  }

  /**
   * ดูว่าเกณฑ์ที่กำลังจะตั้งจะได้กี่รายต่อวัน โดยไม่ต้องบันทึกก่อน
   *
   * เรียกจาก JS ในหน้าตั้งค่าตอนคนแก้ค่าเกณฑ์ ให้เห็นผลทันที
   */
  async preview({ request, response }: HttpContext) {
    const sys = Math.min(Math.max(Number(request.input('sys', 139)) || 139, 100), 250)
    const dia = Math.min(Math.max(Number(request.input('dia', 90)) || 90, 60), 150)

    const excludeKnownHt = request.input('ht', '1') !== '0'

    const rows = await new VitalsWatcher()
      .volumeAtThreshold(sys, dia, excludeKnownHt)
      .catch(() => null)
    if (!rows) return response.json({ ok: false })

    return response.json({
      ok: true,
      sys,
      dia,
      excludeKnownHt,
      ...(rows[0] ?? { total: 0, per_day: 0 }),
    })
  }
}
