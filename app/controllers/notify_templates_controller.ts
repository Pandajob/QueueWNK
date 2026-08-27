import type { HttpContext } from '@adonisjs/core/http'

import { NotifyDataset, NotifyGroup, NotifySchedule, NotifyTemplate } from '#models/notify_system'
import { BUILTIN_PLACEHOLDERS, unknownPlaceholders } from '#services/notify_templating'
import { renderTemplateNow } from '#services/schedule_runner'
import { dispatch } from '#services/notify_dispatcher'
import { ALERT_WHEN_LABELS, BLOCK_LABELS, BLOCK_TYPES, parseBlocks } from '#services/flex_builder'
import { manualSendValidator, templateValidator } from '#validators/notify'
import { audit, diff } from '#services/audit'

type TemplateData = Awaited<ReturnType<(typeof templateValidator)['validate']>>

/** โครงการ์ดสำเร็จรูป ให้กดใช้แทนการเริ่มจากหน้าว่าง */
const PRESETS = [
  {
    key: 'daily_summary',
    name: 'สรุปยอดประจำวัน',
    blocks: [
      { type: 'header', title: 'สรุปผู้รับบริการ', subtitle: '{date} {time} น.' },
      { type: 'hero', label: 'ผู้รับบริการทั้งหมด', value: '{total}', unit: 'ราย' },
      { type: 'bars', title: 'แยกตามแผนก', datasetKey: '' },
      { type: 'divider' },
      { type: 'rows', title: 'งานอื่น ๆ', datasetKey: '' },
    ],
  },
  {
    key: 'simple_alert',
    name: 'แจ้งเตือนสั้น',
    blocks: [
      { type: 'header', title: 'แจ้งเตือน', subtitle: '{datetime}' },
      { type: 'text', text: 'รายละเอียด…' },
    ],
  },
]

export default class NotifyTemplatesController {
  async index({ view }: HttpContext) {
    const templates = await NotifyTemplate.query().preload('dataset').orderBy('name')
    return view.render('pages/notify/templates', { templates })
  }

  async create({ view }: HttpContext) {
    return view.render('pages/notify/template_form', { item: null, ...(await this.#options()) })
  }

  async edit({ params, view, response, session }: HttpContext) {
    const item = await NotifyTemplate.find(params.id)

    if (!item) {
      session.flash('error', 'ไม่พบเทมเพลตนี้')
      return response.redirect().toRoute('notify.templates')
    }

    return view.render('pages/notify/template_form', { item, ...(await this.#options()) })
  }

  async #options() {
    const datasets = await NotifyDataset.query().orderBy('name')

    return {
      datasets,
      builtins: BUILTIN_PLACEHOLDERS,
      blockTypes: BLOCK_TYPES.map((type) => ({ type, label: BLOCK_LABELS[type] })),
      alertWhen: Object.entries(ALERT_WHEN_LABELS).map(([value, label]) => ({ value, label })),
      presets: PRESETS,
      // ให้ตัวแก้ไขรู้ว่าแต่ละชุดข้อมูลมีคอลัมน์อะไร จะได้เลือกจาก dropdown
      datasetColumns: Object.fromEntries(datasets.map((d) => [d.key, d.lastColumns])),
    }
  }

  async store(ctx: HttpContext) {
    const { request, response, session } = ctx
    const data = await request.validateUsing(templateValidator)

    if (await NotifyTemplate.findBy('key', data.key)) {
      session.flash('error', `มีเทมเพลตชื่อย่อ "${data.key}" อยู่แล้ว`)
      return response.redirect().back()
    }

    const invalid = this.#validateShape(data)
    if (invalid) {
      session.flash('error', invalid)
      return response.redirect().back()
    }

    const template = await NotifyTemplate.create(this.#attributes(data))

    await audit(ctx, {
      action: 'create',
      entity: 'template',
      entityId: template.id,
      summary: `เพิ่มเทมเพลต "${template.name}"`,
    })

    session.flash('success', `เพิ่มเทมเพลต "${template.name}" แล้ว`)
    return response.redirect().toRoute('notify.templates')
  }

  async update(ctx: HttpContext) {
    const { params, request, response, session } = ctx
    const template = await NotifyTemplate.find(params.id)

    if (!template) {
      session.flash('error', 'ไม่พบเทมเพลตนี้')
      return response.redirect().toRoute('notify.templates')
    }

    const data = await request.validateUsing(templateValidator)
    const clash = await NotifyTemplate.findBy('key', data.key)

    if (clash && clash.id !== template.id) {
      session.flash('error', `มีเทมเพลตชื่อย่อ "${data.key}" อยู่แล้ว`)
      return response.redirect().back()
    }

    const invalid = this.#validateShape(data)
    if (invalid) {
      session.flash('error', invalid)
      return response.redirect().back()
    }

    const before = template.serialize()

    template.merge(this.#attributes(data))
    await template.save()

    await audit(ctx, {
      action: 'update',
      entity: 'template',
      entityId: template.id,
      summary: `แก้ไขเทมเพลต "${template.name}"`,
      changes: diff(before, template.serialize()),
    })

    session.flash('success', 'บันทึกแล้ว')
    return response.redirect().toRoute('notify.templates')
  }

  async destroy(ctx: HttpContext) {
    const { params, response, session } = ctx
    const template = await NotifyTemplate.find(params.id)

    if (!template) {
      session.flash('error', 'ไม่พบเทมเพลตนี้')
      return response.redirect().toRoute('notify.templates')
    }

    // ตารางเวลาผูกกับเทมเพลตแบบ CASCADE — ลบเทมเพลตแล้วรอบส่งหายไปด้วย
    // ต้องบอกก่อน ไม่ใช่ให้มารู้ตอนข้อความไม่ออกตามเวลา
    const schedules = await NotifySchedule.query().where('template_id', template.id)

    if (schedules.length) {
      session.flash(
        'error',
        `ลบไม่ได้ — มีตารางเวลา ${schedules.length} รอบใช้เทมเพลตนี้อยู่ ` +
          `(${schedules.map((s) => s.name).join(', ')}) ลบตารางเวลาก่อน`
      )
      return response.redirect().toRoute('notify.templates')
    }

    const name = template.name
    await template.delete()

    await audit(ctx, {
      action: 'delete',
      entity: 'template',
      entityId: params.id,
      summary: `ลบเทมเพลต "${name}"`,
    })

    session.flash('success', `ลบเทมเพลต "${name}" แล้ว`)
    return response.redirect().toRoute('notify.templates')
  }

  /** เช็คเงื่อนไขที่ขึ้นกับชนิดข้อความ ซึ่ง VineJS อย่างเดียวบอกไม่ได้ */
  #validateShape(data: TemplateData) {
    if (data.messageType === 'text') {
      return data.body?.trim() ? null : 'ข้อความธรรมดาต้องมีเนื้อความ'
    }

    if (!parseBlocks(data.flexBlocks).length) return 'การ์ด Flex ต้องมีอย่างน้อยหนึ่งบล็อก'
    if (!data.altText?.trim()) return 'การ์ด Flex ต้องมีข้อความย่อ (altText)'

    return null
  }

  #attributes(data: TemplateData) {
    return {
      key: data.key,
      name: data.name,
      datasetId: data.datasetId ?? null,
      messageType: data.messageType,
      body: data.body ?? '',
      altText: data.altText ?? null,
      flexBlocks: data.messageType === 'flex' ? parseBlocks(data.flexBlocks) : null,
      flexColor: data.flexColor ?? '#00857c',
      isEnabled: Boolean(data.isEnabled),
    }
  }

  /**
   * แสดงข้อความที่จะได้จริง โดยวิ่งชุดข้อมูลด้วย แต่ยังไม่ส่งออกไปไหน
   *
   * ใช้ค่าที่กำลังกรอกอยู่ในฟอร์ม ไม่ใช่ค่าที่บันทึกไว้ — จะได้ลองปรับการ์ด
   * กี่รอบก็ได้ก่อนเซฟทับของเดิม เหมือนปุ่มทดสอบในหน้าตั้งค่าอื่น
   */
  async preview({ params, request, response }: HttpContext) {
    const template = (await NotifyTemplate.find(params.id)) ?? new NotifyTemplate()

    try {
      const data = await request.validateUsing(templateValidator)
      template.merge(this.#attributes(data))
    } catch {
      // ฟอร์มยังกรอกไม่ครบ — ดูตัวอย่างจากค่าที่บันทึกไว้แทน
      if (!template.id) return response.ok({ ok: false, error: 'กรอกข้อมูลให้ครบก่อนดูตัวอย่าง' })
    }

    try {
      const { body, data: result, resolved } = await renderTemplateNow(template)

      return response.ok({
        ok: true,
        messageType: template.messageType,
        body,
        blocks: resolved ?? null,
        accent: template.flexColor,
        altText: template.altText,
        rows: result?.rows.length ?? 0,
        missing:
          template.messageType === 'text'
            ? unknownPlaceholders(template.body, result?.columns ?? [])
            : [],
      })
    } catch (error) {
      return response.ok({ ok: false, error: error.message })
    }
  }

  /** หน้าเลือกกลุ่มแล้วกดส่งเดี๋ยวนี้ */
  async sendForm({ params, view, response, session }: HttpContext) {
    const template = await NotifyTemplate.find(params.id)

    if (!template) {
      session.flash('error', 'ไม่พบเทมเพลตนี้')
      return response.redirect().toRoute('notify.templates')
    }

    return view.render('pages/notify/template_send', {
      item: template,
      groups: await NotifyGroup.query().where('is_active', true).orderBy('name'),
    })
  }

  async send(ctx: HttpContext) {
    const { request, response, session } = ctx
    const data = await request.validateUsing(manualSendValidator)

    const template = await NotifyTemplate.find(data.templateId)
    if (!template) {
      session.flash('error', 'ไม่พบเทมเพลตนี้')
      return response.redirect().toRoute('notify.templates')
    }

    const groups = await NotifyGroup.query().whereIn('id', data.groups)

    try {
      const { body, messages } = await renderTemplateNow(template)
      const outcome = await dispatch({
        groups,
        body,
        messages,
        source: 'manual',
        subject: template.name,
        templateId: template.id,
      })

      await audit(ctx, {
        action: 'send',
        entity: 'template',
        entityId: template.id,
        summary:
          `ส่ง "${template.name}" เข้า ${groups.length} กลุ่ม — ` +
          `สำเร็จ ${outcome.sent} ล้มเหลว ${outcome.failed} ข้าม ${outcome.skipped}`,
      })

      session.flash(
        outcome.failed ? 'error' : 'success',
        `ส่งสำเร็จ ${outcome.sent} กลุ่ม · ล้มเหลว ${outcome.failed} · ข้าม ${outcome.skipped}`
      )
    } catch (error) {
      session.flash('error', `ส่งไม่สำเร็จ: ${error.message}`)
    }

    return response.redirect().toRoute('notify.history')
  }
}
