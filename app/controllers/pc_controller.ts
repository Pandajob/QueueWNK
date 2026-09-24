import { DateTime } from 'luxon'
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'

import { NotifyGroup, PcSetting } from '#models/notify_system'
import { PcWatcher, PC_GROUPS } from '#services/pc_watcher'
import { pcValidator } from '#validators/notify'
import { audit, diff } from '#services/audit'

export default class PcController {
  async index({ view }: HttpContext) {
    const settings = await PcSetting.current()
    const watcher = new PcWatcher()

    /**
     * ไม่นับจำนวนผู้ป่วยทั้งฐานตรงนี้ — query นั้นไล่การวินิจฉัยย้อนหลัง 1 ปี
     * ใช้เวลาราว 6 วินาที ถ้ารอจะบล็อกหน้าเว็บ ให้ JS ยิงไปที่ปลายทาง volume
     * เองหลังหน้าโหลดเสร็จ
     */
    const [groups, pending, seenCount] = await Promise.all([
      NotifyGroup.query().where('is_active', true).orderBy('name'),
      settings.seeded ? watcher.findNew(settings).catch(() => null) : Promise.resolve([]),
      db.from('pc_seen').count('* as total').first(),
    ])

    return view.render('pages/notify/pc', {
      settings,
      groups,
      pending,
      pcGroups: PC_GROUPS,
      seenCount: Number(seenCount?.total ?? 0),
      hosxpDown: pending === null,
    })
  }

  async save(ctx: HttpContext) {
    const { request, response, session } = ctx
    const data = await request.validateUsing(pcValidator)
    const settings = await PcSetting.current()
    const before = settings.serialize()

    const wasEnabled = settings.isEnabled
    const willEnable = Boolean(data.isEnabled)

    settings.merge({
      isEnabled: willEnable,
      groupId: data.groupId ?? null,
      notifyImmediate: Boolean(data.notifyImmediate),
      notifyDaily: Boolean(data.notifyDaily),
      sendAt: data.sendAt,
      allGroups: Boolean(data.allGroups),
      groupCodes: data.allGroups ? null : (data.groupCodes ?? []),
      lookbackDays: data.lookbackDays,
      maxPerRun: data.maxPerRun,
      includeHn: Boolean(data.includeHn),
      includeName: Boolean(data.includeName),
      includeAddress: Boolean(data.includeAddress),
      includePhone: Boolean(data.includePhone),
      excludeDead: Boolean(data.excludeDead),
    })
    await settings.save()

    await audit(ctx, {
      action: 'update',
      entity: 'pc',
      entityId: settings.id,
      summary: 'แก้ไขการตั้งค่าแจ้งเตือนผู้ป่วยประคับประคอง',
      changes: diff(before, settings.serialize()),
    })

    if (willEnable && !settings.groupId) {
      session.flash('error', 'เปิดใช้งานแล้วแต่ยังไม่ได้เลือกกลุ่ม LINE — ยังไม่มีข้อความออกไปไหน')
    } else if (willEnable && !settings.seeded) {
      session.flash(
        'error',
        'เปิดใช้งานแล้ว แต่ยังไม่ได้รับทราบผู้ป่วยเดิม — กดปุ่มด้านล่างก่อน ไม่งั้นจะยังไม่ส่งอะไรออกไป'
      )
    } else if (willEnable && !wasEnabled) {
      const modes = [
        settings.notifyImmediate ? 'แจ้งทันทีเมื่อพบ' : null,
        settings.notifyDaily ? `สรุปรายวัน ${settings.sendAt} น.` : null,
      ].filter(Boolean)
      session.flash(
        'success',
        modes.length
          ? `เปิดใช้งานแล้ว — ${modes.join(' · ')}`
          : 'เปิดใช้งานแล้ว แต่ยังไม่ได้เลือกโหมดแจ้งเตือน'
      )
    } else {
      session.flash('success', 'บันทึกแล้ว')
    }

    return response.redirect().toRoute('notify.pc')
  }

  /**
   * รับทราบผู้ป่วยเดิมทั้งหมดโดยไม่ส่งแจ้งเตือน
   *
   * ต้องเป็นการกดของคน ไม่ทำให้เองเงียบ ๆ เพราะเป็นการตัดสินใจว่าจะไม่แจ้ง
   * ผู้ป่วยที่มีอยู่แล้วราวพันกว่าราย คนกดควรเห็นตัวเลขก่อน
   */
  async seed(ctx: HttpContext) {
    const { response, session } = ctx
    const settings = await PcSetting.current()

    const marked = await new PcWatcher().seed(settings).catch(() => null)

    if (marked === null) {
      session.flash('error', 'อ่านข้อมูลจาก HOSxP ไม่ได้ — ยังไม่ได้รับทราบรายใด')
      return response.redirect().toRoute('notify.pc')
    }

    await audit(ctx, {
      action: 'update',
      entity: 'pc',
      entityId: settings.id,
      summary: `รับทราบผู้ป่วยประคับประคองรายเดิม ${marked} ราย (ไม่ได้ส่งแจ้งเตือน)`,
    })

    session.flash(
      'success',
      `รับทราบผู้ป่วยเดิม ${marked} ราย แล้ว — ตั้งแต่นี้จะแจ้งเฉพาะรายใหม่เท่านั้น`
    )
    return response.redirect().toRoute('notify.pc')
  }

  /** สั่งส่งสรุปเดี๋ยวนี้โดยไม่รอเวลาที่ตั้งไว้ */
  async runNow(ctx: HttpContext) {
    const { response, session } = ctx
    const settings = await PcSetting.current()

    if (!settings.groupId) {
      session.flash('error', 'ยังไม่ได้เลือกกลุ่ม LINE')
      return response.redirect().toRoute('notify.pc')
    }

    const result = await new PcWatcher().runNow(settings)

    await audit(ctx, {
      action: 'send',
      entity: 'pc',
      entityId: settings.id,
      summary: `สั่งส่งสรุปผู้ป่วยประคับประคองเดี๋ยวนี้ — พบ ${result.found} ราย ส่ง ${result.sent}`,
    })

    if (result.note) session.flash('error', result.note)
    else if (!result.found) session.flash('success', 'ไม่มีผู้ป่วยรายใหม่ในช่วงนี้ ไม่ได้ส่ง')
    else if (result.sent) session.flash('success', `ส่งแล้ว — ${result.found} ราย`)
    else session.flash('error', `พบ ${result.found} ราย แต่ส่งไม่สำเร็จ ดูที่หน้าประวัติการส่ง`)

    return response.redirect().toRoute('notify.pc')
  }

  /** จำนวนผู้ป่วยเข้าเกณฑ์ทั้งฐาน แยกตามกลุ่ม — เรียกจาก JS หลังหน้าโหลดเสร็จ */
  async volume({ response }: HttpContext) {
    const settings = await PcSetting.current()

    // ใช้เกณฑ์ผู้เสียชีวิตชุดเดียวกับตอน seed ตัวเลขบนหน้าจะได้ตรงกับที่กดแล้วได้จริง
    const data = await new PcWatcher()
      .volumeByGroup(undefined, settings.excludeDead)
      .catch(() => null)
    if (!data) return response.json({ ok: false })

    return response.json({ ok: true, ...data })
  }

  /** เวลาปัจจุบันฝั่งเซิร์ฟเวอร์ ใช้บอกว่าอีกนานแค่ไหนจะถึงรอบสรุป */
  static nowLabel() {
    return DateTime.now().setZone('Asia/Bangkok').toFormat('HH:mm')
  }
}
