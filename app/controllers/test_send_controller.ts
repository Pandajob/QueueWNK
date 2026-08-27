import type { HttpContext } from '@adonisjs/core/http'
import AlertTemplate from '#models/alert_template'
import MophCredential from '#models/moph_credential'
import { MophClient } from '#services/moph_client'
import {
  ALERT_CASES,
  ALERT_CASE_KEYS,
  PLACEHOLDER_LABELS,
  SAMPLE_VALUES,
  type AlertCaseKey,
  type PlaceholderKey,
} from '#services/alert_cases'
import vine from '@vinejs/vine'
import logger from '@adonisjs/core/services/logger'

const testValidator = vine.compile(
  vine.object({
    caseKey: vine.enum(ALERT_CASE_KEYS),
    cid: vine.string().trim().regex(/^\d{13}$/),
    name: vine.string().trim().maxLength(200).optional(),
    queue_no: vine.string().trim().maxLength(50).optional(),
    queue_waiting: vine.string().trim().maxLength(10).optional(),
    hn_no: vine.string().trim().maxLength(50).optional(),
    service: vine.string().trim().maxLength(200).optional(),
    url: vine.string().trim().maxLength(500).optional(),
  })
)

function maskCid(cid: string) {
  return `${cid.slice(0, 4)}xxxxx${cid.slice(9)}`
}

export default class TestSendController {
  async index({ view, request }: HttpContext) {
    await AlertTemplate.ensureSeeded()

    const caseKey = (request.input('case') ?? 'queue_notify') as AlertCaseKey
    const selected = ALERT_CASE_KEYS.includes(caseKey) ? caseKey : 'queue_notify'
    const template = await AlertTemplate.findBy('case_key', selected)
    const credential = await MophCredential.active()

    return view.render('pages/test_send', {
      cases: ALERT_CASES,
      caseKeys: ALERT_CASE_KEYS,
      selected,
      // ชื่อ item ไม่ใช่ template — Edge ใช้ชื่อ template เป็นตัวแปรภายในของมันเอง
      item: template,
      definition: ALERT_CASES[selected],
      placeholderLabels: PLACEHOLDER_LABELS,
      samples: SAMPLE_VALUES,
      hasCredential: Boolean(credential?.clientKey && credential?.secretKey),
    })
  }

  /** ประกอบ payload แล้วคืนกลับไปให้ดู โดยไม่ส่งอะไรออกไปเลย */
  async preview({ request, response }: HttpContext) {
    const { payload } = await this.#build(request)
    return response.ok({ ok: true, payload })
  }

  /**
   * ส่งจริง — ข้อความจะไปถึง LINE หมอพร้อมของเจ้าของเลขบัตรที่กรอก
   * หน้าเว็บต้องเตือนให้ชัดก่อนกดปุ่มนี้
   */
  async send({ request, response }: HttpContext) {
    const credential = await MophCredential.active()

    if (!credential?.clientKey || !credential?.secretKey) {
      return response.ok({
        ok: false,
        checks: [
          { label: 'ตั้งค่า MOPH Alert', status: 'fail', detail: 'ยังไม่ได้ตั้งค่า client-key / secret-key' },
        ],
      })
    }

    const { payload, cid } = await this.#build(request)

    const client = new MophClient({
      baseUrl: credential.baseUrl,
      clientKey: credential.clientKey,
      secretKey: credential.secretKey,
    })

    // log ไว้เสมอว่าใครถูกส่งทดสอบ (เลขบัตรปิดบัง) — ต้องตามรอยได้ภายหลัง
    logger.info({ cid: maskCid(cid), template: payload.template }, 'ส่งข้อความทดสอบ MOPH Alert')

    let result: Awaited<ReturnType<MophClient['sendTemplate']>>
    try {
      result = await client.sendTemplate(payload)
    } catch (error) {
      return response.ok({
        ok: false,
        checks: [{ label: 'ส่งข้อความ', status: 'fail', detail: error.message }],
      })
    }

    const code = result.body?.message_code ?? result.status
    const message = result.body?.message ?? result.raw.slice(0, 300)

    const checks = [
      {
        label: 'ปลายทางตอบกลับ',
        status: code === 200 ? 'ok' : 'fail',
        detail: `code ${code} — ${message}`,
      },
    ]

    if (code === 200) {
      checks.push({
        label: 'ผลลัพธ์',
        status: 'ok',
        detail: `ส่งถึง ${maskCid(cid)} แล้ว ตรวจสอบที่ LINE หมอพร้อมของเลขบัตรนี้`,
      })
    } else if (code === 404) {
      checks.push({
        label: 'ผลลัพธ์',
        status: 'fail',
        detail:
          'ปลายทางตอบ 404 ซึ่งหมายถึงอย่างใดอย่างหนึ่งใน 3 กรณี: ไม่มี template นี้, ' +
          'ไม่พบ LINE user id, หรือเลขบัตรนี้ยังไม่ได้ลงทะเบียนหมอพร้อม — เอกสารไม่ได้แยกให้',
      })
    } else if (code === 401 && /Hospital Logo/i.test(message)) {
      checks.push({
        label: 'ผลลัพธ์',
        status: 'fail',
        detail: 'ยังไม่ได้อัปโหลดโลโก้โรงพยาบาลใน CMS MOPH ALERTING',
      })
    }

    return response.ok({ ok: code === 200, checks, payload })
  }

  async #build(request: HttpContext['request']) {
    const data = await request.validateUsing(testValidator)
    await AlertTemplate.ensureSeeded()

    const template = await AlertTemplate.findByOrFail('case_key', data.caseKey)

    const values: Partial<Record<PlaceholderKey, string>> = {
      name: data.name,
      queue_no: data.queue_no,
      queue_waiting: data.queue_waiting,
      hn_no: data.hn_no,
      service: data.service,
      url: data.url,
    }

    return { payload: template.buildPayload(data.cid, values), cid: data.cid }
  }
}
