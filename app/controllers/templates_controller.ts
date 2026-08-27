import type { HttpContext } from '@adonisjs/core/http'
import AlertTemplate from '#models/alert_template'
import {
  ALERT_CASES,
  PLACEHOLDER_LABELS,
  SAMPLE_VALUES,
  renderTemplate,
  unknownPlaceholders,
  type AlertCaseKey,
} from '#services/alert_cases'
import vine from '@vinejs/vine'

const templateValidator = vine.compile(
  vine.object({
    header: vine.string().trim().minLength(1).maxLength(200),
    lineText: vine.string().trim().minLength(1).maxLength(2000),
    messageTitle: vine.string().trim().minLength(1).maxLength(200),
    messageHtml: vine.string().trim().minLength(1).maxLength(4000),
    messageText: vine.string().trim().minLength(1).maxLength(200),
    checkUrl: vine.string().trim().url({ require_protocol: true }).optional().nullable(),
    threshold: vine.number().range([1, 99]).optional(),
    isEnabled: vine.accepted().optional(),
  })
)

export default class TemplatesController {
  async index({ view }: HttpContext) {
    await AlertTemplate.ensureSeeded()
    const templates = await AlertTemplate.all()

    // เรียงตามลำดับที่คนอ่านเข้าใจ ไม่ใช่ตาม id
    const order: AlertCaseKey[] = ['welcome', 'queue_notify', 'queue_near', 'queue_changed']
    templates.sort((a, b) => order.indexOf(a.caseKey) - order.indexOf(b.caseKey))

    return view.render('pages/settings/templates', { templates, cases: ALERT_CASES })
  }

  async edit({ params, view, response, session }: HttpContext) {
    await AlertTemplate.ensureSeeded()
    const template = await AlertTemplate.findBy('case_key', params.key)

    if (!template) {
      session.flash('error', 'ไม่พบเคสการแจ้งเตือนนี้')
      return response.redirect().toRoute('templates.index')
    }

    return view.render('pages/settings/template_form', {
      // ตั้งชื่อ item ไม่ใช่ template — Edge ใช้ชื่อ template เป็นตัวแปรภายในของมันเอง
      item: template,
      definition: template.definition,
      placeholderLabels: PLACEHOLDER_LABELS,
      preview: this.#preview(template),
    })
  }

  async update({ params, request, response, session }: HttpContext) {
    const template = await AlertTemplate.findBy('case_key', params.key)
    if (!template) {
      session.flash('error', 'ไม่พบเคสการแจ้งเตือนนี้')
      return response.redirect().toRoute('templates.index')
    }

    const data = await request.validateUsing(templateValidator)
    const allowed = template.definition.placeholders

    // เตือนถ้าใช้ตัวยึดที่เคสนี้ไม่มีข้อมูลให้ — ไม่งั้นผู้ป่วยจะได้ข้อความที่มี {xxx} ติดไปด้วย
    const bad = [
      ...unknownPlaceholders(data.header, allowed),
      ...unknownPlaceholders(data.lineText, allowed),
      ...unknownPlaceholders(data.messageTitle, allowed),
      ...unknownPlaceholders(data.messageHtml, allowed),
      ...unknownPlaceholders(data.messageText, allowed),
    ]

    if (bad.length) {
      session.flash(
        'error',
        `เคสนี้ไม่มีข้อมูลสำหรับตัวยึด ${[...new Set(bad)].map((b) => `{${b}}`).join(', ')} — ` +
          `ถ้าบันทึกไป ผู้ป่วยจะเห็นวงเล็บปีกกาติดไปในข้อความ`
      )
      return response.redirect().withQs().back()
    }

    template.merge({
      header: data.header,
      lineText: data.lineText,
      messageTitle: data.messageTitle,
      messageHtml: data.messageHtml,
      messageText: data.messageText,
      checkUrl: data.checkUrl || null,
      threshold: data.threshold ?? template.threshold,
      isEnabled: Boolean(data.isEnabled),
    })
    await template.save()

    session.flash('success', `บันทึกข้อความ “${template.definition.label}” แล้ว`)
    return response.redirect().toRoute('templates.index')
  }

  /** พรีวิวด้วยค่าตัวอย่าง ให้เห็นว่าข้อความจริงจะออกมาหน้าตาแบบไหน */
  #preview(template: AlertTemplate) {
    const values = { ...SAMPLE_VALUES, url: template.checkUrl ?? '' }

    return {
      header: renderTemplate(template.header, values),
      lineText: renderTemplate(template.lineText, values),
      messageTitle: renderTemplate(template.messageTitle, values),
      messageHtml: renderTemplate(template.messageHtml, values),
      messageText: renderTemplate(template.messageText, values),
    }
  }
}
