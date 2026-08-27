import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'

import { NotifyGroup, NotifyMessage } from '#models/notify_system'
import { MophNotifyClient } from '#services/notify_client'
import { dispatch } from '#services/notify_dispatcher'
import { groupValidator } from '#validators/notify'
import { audit, diff } from '#services/audit'

export default class NotifyGroupsController {
  async index({ view }: HttpContext) {
    const groups = await NotifyGroup.query().orderBy('name')

    // นับการส่งของแต่ละกลุ่มไว้แสดงในตาราง
    const counts = await NotifyMessage.query()
      .select('group_id')
      .count('* as total')
      .groupBy('group_id')

    const sends: Record<number, number> = {}
    for (const row of counts) {
      if (row.groupId != null) sends[row.groupId] = Number(row.$extras.total)
    }

    return view.render('pages/notify/groups', { groups, sends })
  }

  async create({ view }: HttpContext) {
    return view.render('pages/notify/group_form', { item: null })
  }

  async edit({ params, view, response, session }: HttpContext) {
    const item = await NotifyGroup.find(params.id)

    if (!item) {
      session.flash('error', 'ไม่พบกลุ่มนี้')
      return response.redirect().toRoute('notify.groups')
    }

    return view.render('pages/notify/group_form', { item })
  }

  async store(ctx: HttpContext) {
    const { request, response, session } = ctx
    const data = await request.validateUsing(groupValidator)

    if (!data.clientKey || !data.secretKey) {
      session.flash('error', 'กลุ่มใหม่ต้องกรอก Client_ID และ Secret')
      return response.redirect().back()
    }

    const group = await NotifyGroup.create({
      name: data.name,
      hcode: data.hcode ?? null,
      baseUrl: data.baseUrl,
      clientKey: data.clientKey,
      secretKey: data.secretKey,
      note: data.note ?? null,
      isActive: Boolean(data.isActive),
      supportsFlex: Boolean(data.supportsFlex),
    })

    await audit(ctx, {
      action: 'create',
      entity: 'group',
      entityId: group.id,
      summary: `เพิ่มกลุ่ม LINE "${group.name}"`,
    })

    session.flash('success', `เพิ่มกลุ่ม "${group.name}" แล้ว`)
    return response.redirect().toRoute('notify.groups')
  }

  async update(ctx: HttpContext) {
    const { params, request, response, session } = ctx
    const group = await NotifyGroup.find(params.id)

    if (!group) {
      session.flash('error', 'ไม่พบกลุ่มนี้')
      return response.redirect().toRoute('notify.groups')
    }

    const data = await request.validateUsing(groupValidator)
    const before = group.serialize()

    group.merge({
      name: data.name,
      hcode: data.hcode ?? null,
      baseUrl: data.baseUrl,
      note: data.note ?? null,
      isActive: Boolean(data.isActive),
      supportsFlex: Boolean(data.supportsFlex),
    })

    // ว่างไว้ = ไม่เปลี่ยน key เดิม
    if (data.clientKey) group.clientKey = data.clientKey
    if (data.secretKey) group.secretKey = data.secretKey

    await group.save()

    await audit(ctx, {
      action: 'update',
      entity: 'group',
      entityId: group.id,
      summary: `แก้ไขกลุ่ม LINE "${group.name}"`,
      changes: diff(before, group.serialize()),
    })

    session.flash('success', 'บันทึกแล้ว')
    return response.redirect().toRoute('notify.groups')
  }

  async destroy(ctx: HttpContext) {
    const { params, response, session } = ctx
    const group = await NotifyGroup.find(params.id)

    if (!group) {
      session.flash('error', 'ไม่พบกลุ่มนี้')
      return response.redirect().toRoute('notify.groups')
    }

    const name = group.name
    await group.delete()

    await audit(ctx, {
      action: 'delete',
      entity: 'group',
      entityId: params.id,
      summary: `ลบกลุ่ม LINE "${name}"`,
    })

    session.flash('success', `ลบกลุ่ม "${name}" แล้ว — ประวัติการส่งเดิมยังอยู่`)
    return response.redirect().toRoute('notify.groups')
  }

  /** ตรวจ key โดยไม่มีข้อความโผล่ในกลุ่ม */
  async test(ctx: HttpContext) {
    const { request, response } = ctx
    const data = await request.validateUsing(groupValidator)
    const stored = ctx.params.id ? await NotifyGroup.find(ctx.params.id) : null

    const clientKey = data.clientKey || stored?.clientKey
    const secretKey = data.secretKey || stored?.secretKey

    if (!clientKey || !secretKey) {
      return response.ok({
        ok: false,
        checks: [{ label: 'Key', status: 'fail', detail: 'ยังไม่ได้กรอก Client_ID หรือ Secret' }],
      })
    }

    const result = await new MophNotifyClient({
      baseUrl: data.baseUrl,
      clientKey,
      secretKey,
    }).verify()

    if (stored) {
      stored.merge({
        lastTestedAt: DateTime.now(),
        lastTestOk: result.ok,
        lastTestError: result.ok
          ? null
          : result.checks.find((c) => c.status === 'fail')?.detail ?? null,
      })
      await stored.save()
    }

    return response.ok(result)
  }

  /**
   * ส่งข้อความจริงเข้ากลุ่ม — แยกจากปุ่มทดสอบ key โดยตั้งใจ
   * เพราะทุกคนในกลุ่มจะเห็น จึงต้องเป็นการกดที่ผู้ใช้เจตนา
   */
  async sendTest(ctx: HttpContext) {
    const { params, response } = ctx
    const group = await NotifyGroup.find(params.id)

    if (!group?.isUsable) {
      return response.ok({
        ok: false,
        checks: [
          { label: 'ส่งข้อความทดสอบ', status: 'fail', detail: 'กลุ่มถูกปิดใช้งานหรือยังไม่มี key' },
        ],
      })
    }

    const now = DateTime.now().setZone('Asia/Bangkok')
    const outcome = await dispatch({
      groups: [group],
      source: 'manual',
      subject: 'ทดสอบการเชื่อมต่อ',
      body:
        `✅ QueueWNK — ทดสอบการเชื่อมต่อ\n` +
        `เวลา ${now.toFormat('dd/MM/yyyy HH:mm')}\n` +
        `ถ้าเห็นข้อความนี้ในกลุ่ม แปลว่ากลุ่ม "${group.name}" พร้อมใช้งานแล้ว`,
    })

    await audit(ctx, {
      action: 'test',
      entity: 'group',
      entityId: group.id,
      summary: `ส่งข้อความทดสอบเข้ากลุ่ม "${group.name}"`,
    })

    const message = outcome.messages[0]

    return response.ok({
      ok: outcome.sent > 0,
      checks: [
        outcome.sent
          ? {
              label: 'ส่งข้อความทดสอบ',
              status: 'ok',
              detail: 'ส่งแล้ว — เปิดกลุ่ม LINE ดูว่าข้อความขึ้นหรือไม่',
            }
          : {
              label: 'ส่งข้อความทดสอบ',
              status: 'fail',
              detail: message?.error ?? 'ส่งไม่สำเร็จ',
            },
      ],
    })
  }
}
