import type { HttpContext } from '@adonisjs/core/http'
import {
  DepartmentSetting,
  Notification,
  PollerSetting,
} from '#models/poller_models'
import { ALERT_CASES } from '#services/alert_cases'
import { audit } from '#services/audit'
import vine from '@vinejs/vine'
import { DateTime } from 'luxon'

const settingsValidator = vine.compile(
  vine.object({
    dryRun: vine.accepted().optional(),
    quietStart: vine.string().regex(/^\d{2}:\d{2}$/),
    quietEnd: vine.string().regex(/^\d{2}:\d{2}$/),
    nearThreshold: vine.number().range([1, 50]),
    departments: vine.array(vine.string()).optional(),
  })
)

/** จำกัดเป็นตัวเลือกที่ตายตัว กันพิมพ์ 0 แล้วลบทั้งตาราง */
const clearOldValidator = vine.compile(
  vine.object({
    days: vine.number().in([7, 30, 90, 180, 365]),
  })
)

export default class PollerController {
  async settings({ view }: HttpContext) {
    const settings = await PollerSetting.current()
    const departments = await DepartmentSetting.query().orderBy('depcode', 'asc')

    return view.render('pages/poller_settings', { settings, departments })
  }

  async saveSettings({ request, response, session }: HttpContext) {
    const data = await request.validateUsing(settingsValidator)
    const settings = await PollerSetting.current()

    const wasDryRun = settings.dryRun

    settings.merge({
      dryRun: Boolean(data.dryRun),
      quietStart: data.quietStart,
      quietEnd: data.quietEnd,
      nearThreshold: data.nearThreshold,
    })
    await settings.save()

    const enabled = new Set(data.departments ?? [])
    const all = await DepartmentSetting.all()
    for (const department of all) {
      const shouldEnable = enabled.has(department.depcode)
      if (department.isEnabled !== shouldEnable) {
        department.isEnabled = shouldEnable
        await department.save()
      }
    }

    // การปิด dry run แปลว่าข้อความจะเริ่มถึงผู้ป่วยจริง ต้องบอกให้ชัด
    if (wasDryRun && !settings.dryRun) {
      session.flash('success', 'ปิดโหมดทดสอบแล้ว — ตั้งแต่นี้ข้อความจะถูกส่งถึงผู้ป่วยจริง')
    } else {
      session.flash('success', 'บันทึกการตั้งค่าแล้ว')
    }

    return response.redirect().toRoute('poller.settings')
  }

  async log({ view, request }: HttpContext) {
    const status = request.input('status')
    const page = Number(request.input('page', 1))

    const query = Notification.query().orderBy('id', 'desc')
    if (status && status !== 'all') query.where('status', status)

    const notifications = await query.paginate(page, 50)
    notifications.baseUrl('/log')
    if (status) notifications.queryString({ status })

    const counts = await Notification.query()
      .select('status')
      .count('* as total')
      .groupBy('status')

    const summary: Record<string, number> = {}
    for (const row of counts) {
      summary[row.status] = Number(row.$extras.total)
    }
    summary.all = Object.values(summary).reduce((sum, value) => sum + value, 0)

    // ตารางนี้ส่วนใหญ่มีแต่รายการที่ส่งสำเร็จ คอลัมน์หมายเหตุกับปุ่มส่งใหม่
    // จึงว่างทั้งแถวเป็นร้อย ๆ บรรทัด — ซ่อนไปเลยถ้าหน้านี้ไม่มีอะไรจะใส่
    const rows = notifications.all()
    const hasNotes = rows.some((row) => Boolean(row.lastError))
    const hasFailed = rows.some((row) => row.status === 'failed')

    const oldest = await Notification.query().orderBy('id', 'asc').first()

    return view.render('pages/log', {
      notifications,
      cases: ALERT_CASES,
      status: status ?? 'all',
      summary,
      hasNotes,
      hasFailed,
      oldest,
    })
  }

  /** ตั้งรายการที่ล้มเหลวกลับเป็น pending ให้ poller หยิบไปลองใหม่ */
  async retry({ params, response, session }: HttpContext) {
    const notification = await Notification.find(params.id)

    if (!notification) {
      session.flash('error', 'ไม่พบรายการนี้')
      return response.redirect().toRoute('poller.log')
    }

    notification.merge({ status: 'pending', attempts: 0, lastError: null, mophCode: null })
    await notification.save()

    session.flash('success', `ตั้งรายการ ${notification.vn} ให้ส่งใหม่แล้ว`)
    return response.redirect().back()
  }

  /** ล้าง state ของวันนี้ ใช้ตอนทดสอบ ไม่แตะฐาน HOSxP */
  async resetToday({ response, session }: HttpContext) {
    const today = DateTime.now().setZone('Asia/Bangkok').startOf('day').toSQLDate()

    const removed = await Notification.query()
      .whereIn('status', ['skipped', 'failed'])
      .where('created_at', '>=', today!)
      .delete()

    session.flash('success', `ล้างรายการที่ข้าม/ล้มเหลวของวันนี้แล้ว ${removed} รายการ`)
    return response.redirect().toRoute('poller.log')
  }

  /**
   * ลบบันทึกการส่งที่เก่ากว่าที่เลือก
   *
   * ปลอดภัยเพราะ poller อ่านคิวเฉพาะ `date_visit = CURDATE()` — vn ของวันเก่า
   * ไม่มีทางกลับเข้ามาในรอบสแกน การลบแถวจึงไม่ทำให้ dedup_key หลุดแล้วส่งซ้ำ
   * ด้วยเหตุนี้จึงบังคับขั้นต่ำ 7 วัน ไม่ให้เผลอลบของวันนี้
   */
  async clearOld(ctx: HttpContext) {
    const { request, response, session } = ctx
    const { days } = await request.validateUsing(clearOldValidator)

    const cutoff = DateTime.now().setZone('Asia/Bangkok').startOf('day').minus({ days })

    const removed = await Notification.query().where('created_at', '<', cutoff.toSQL()!).delete()

    const count = Number(removed) || 0

    await audit(ctx, {
      action: 'delete',
      entity: 'notifications',
      summary: `ล้างบันทึกการส่งที่เก่ากว่า ${days} วัน — ${count} รายการ`,
    })

    if (count) {
      session.flash(
        'success',
        `ลบบันทึกก่อนวันที่ ${cutoff.toFormat('dd/MM')}/${cutoff.year + 543} แล้ว ${count.toLocaleString()} รายการ`
      )
    } else {
      session.flash('success', `ไม่มีบันทึกที่เก่ากว่า ${days} วัน — ไม่ได้ลบอะไร`)
    }

    return response.redirect().toRoute('poller.log')
  }
}
