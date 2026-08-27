import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import {
  ALERT_CASES,
  ALERT_CASE_KEYS,
  renderTemplate,
  type AlertCaseKey,
  type PlaceholderKey,
} from '#services/alert_cases'

export default class AlertTemplate extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare caseKey: AlertCaseKey

  @column()
  declare header: string

  @column()
  declare lineText: string

  @column()
  declare messageTitle: string

  @column()
  declare messageHtml: string

  @column()
  declare messageText: string

  @column()
  declare checkUrl: string | null

  @column()
  declare isEnabled: boolean

  @column()
  declare threshold: number | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  get definition() {
    return ALERT_CASES[this.caseKey]
  }

  /**
   * ประกอบ payload ตามสเปค MOPH Alert Template v3.1
   *
   * ส่ง field เท่าที่เคสนั้นต้องใช้ ไม่ยัดทุก field ไปหมด
   * เพราะเอกสารระบุ field ที่จำเป็นต่างกันในแต่ละ template
   */
  buildPayload(cid: string, values: Partial<Record<PlaceholderKey, string>>) {
    const definition = this.definition
    const url = this.checkUrl?.trim() || values.url?.trim() || ''
    const merged = { ...values, url }

    const payload: Record<string, string> = {
      cid,
      name: merged.name ?? '',
      template: definition.mophTemplate,
      header: renderTemplate(this.header, merged),
      text: renderTemplate(this.lineText, merged),
      message_title: renderTemplate(this.messageTitle, merged),
      message_html: renderTemplate(this.messageHtml, merged),
      message_text: renderTemplate(this.messageText, merged),
      message_type: 'HPT',
    }

    if (definition.placeholders.includes('queue_no')) payload.queue_no = merged.queue_no ?? ''
    if (definition.placeholders.includes('hn_no')) payload.hn_no = merged.hn_no ?? ''
    if (definition.placeholders.includes('service')) payload.service = merged.service ?? ''
    if (definition.placeholders.includes('queue_waiting')) {
      payload.queue_waiting = merged.queue_waiting ?? ''
    }
    if (definition.supportsUrl) payload.url = url

    return payload
  }

  /** สร้างแถวที่ยังไม่มีจากค่าเริ่มต้น เรียกได้ซ้ำโดยไม่ทับของเดิม */
  static async ensureSeeded() {
    const existing = await this.query().select('case_key')
    const have = new Set(existing.map((row) => row.caseKey))

    for (const key of ALERT_CASE_KEYS) {
      if (have.has(key)) continue

      const defaults = ALERT_CASES[key].defaults
      await this.create({
        caseKey: key,
        header: defaults.header,
        lineText: defaults.lineText,
        messageTitle: defaults.messageTitle,
        messageHtml: defaults.messageHtml,
        messageText: defaults.messageText,
        checkUrl: null,
        isEnabled: true,
        threshold: key === 'queue_near' ? 3 : null,
      })
    }
  }
}
