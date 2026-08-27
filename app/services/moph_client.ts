import type { TestCheck, TestResult } from '#services/hosxp_tester'

export type MophConfig = {
  baseUrl: string
  clientKey: string
  secretKey: string
}

export type MophResponse = {
  message: string
  message_code: number
}

/** ชื่อ template ต้องตรงตัวอักษรไทยเป๊ะ ระบบปลายทางใช้ค่านี้ match */
export const TEMPLATES = {
  welcome: 'ยินดีต้อนรับ',
  queueNotify: 'แจ้งเตือนคิว',
  queueNear: 'ใกล้ถึงคิวของคุณแล้ว',
  queueChanged: 'คิวของท่านมีการเปลี่ยนแปลง',
} as const

export class MophClient {
  constructor(private config: MophConfig) {}

  private async post(path: string, body: unknown) {
    const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'client-key': this.config.clientKey,
        'secret-key': this.config.secretKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })

    const text = await response.text()
    let parsed: MophResponse | null = null
    try {
      parsed = JSON.parse(text)
    } catch {
      // ปลายทางตอบไม่ใช่ JSON — เก็บ text ดิบไว้ให้ debug
    }

    return { status: response.status, body: parsed, raw: text }
  }

  sendTemplate(payload: Record<string, unknown>) {
    return this.post('/alert/v3.1/template', payload)
  }

  sendFreeForm(payload: Record<string, unknown>) {
    return this.post('/alert/v3.1/messages', payload)
  }

  /**
   * ตรวจว่า client-key / secret-key ถูกต้องไหม โดยไม่ส่งข้อความถึงผู้ป่วยจริง
   *
   * วิธี: ยิง template ด้วย cid ที่ไม่มีทางมีอยู่จริง (0000000000000)
   *   - 401 "client-key or secret-key incorrect" → key ผิด
   *   - 401 "Hospital Logo is empty"             → key ถูก แต่ยังไม่ได้อัปโหลดโลโก้ใน CMS
   *   - 404 "Error template"                     → key ถูก (แค่หา cid ไม่เจอ ตามคาด)
   *
   * ปลายทางตรวจ key ก่อนตรวจ cid เสมอ เลยแยกสองกรณีนี้ออกจากกันได้
   * โดยไม่มีข้อความหลุดไปหาใคร
   */
  async verify(): Promise<TestResult> {
    const checks: TestCheck[] = []
    const probeCid = '0000000000000'

    let result: Awaited<ReturnType<typeof this.post>>
    try {
      result = await this.sendTemplate({
        cid: probeCid,
        name: 'ทดสอบการเชื่อมต่อ',
        template: TEMPLATES.welcome,
        header: 'ทดสอบการเชื่อมต่อ',
        text: 'ทดสอบการเชื่อมต่อจากระบบแจ้งเตือนคิว',
        message_title: 'ทดสอบการเชื่อมต่อ',
        message_html: '<div>ทดสอบการเชื่อมต่อ</div>',
        message_text: 'ทดสอบการเชื่อมต่อ',
        message_type: 'HPT',
      })
    } catch (error) {
      return {
        ok: false,
        checks: [
          {
            label: 'เชื่อมต่อ MOPH Alert',
            status: 'fail',
            detail:
              error.name === 'TimeoutError'
                ? 'หมดเวลารอ 20 วินาที — ตรวจว่าเครื่องนี้ออกอินเทอร์เน็ต/ผ่าน proxy ไปยัง moph.go.th ได้'
                : error.message,
          },
        ],
      }
    }

    checks.push({
      label: 'เชื่อมต่อ MOPH Alert',
      status: 'ok',
      detail: `${this.config.baseUrl} ตอบกลับ HTTP ${result.status}`,
    })

    const code = result.body?.message_code ?? result.status
    const message = result.body?.message ?? result.raw.slice(0, 200)

    if (code === 401 && /client-key or secret-key/i.test(message)) {
      checks.push({
        label: 'ตรวจสอบ key',
        status: 'fail',
        detail: 'client-key หรือ secret-key ไม่ถูกต้อง — คัดลอกใหม่จาก CMS MOPH ALERTING',
      })
      return { ok: false, checks }
    }

    if (code === 401 && /Hospital Logo/i.test(message)) {
      checks.push({ label: 'ตรวจสอบ key', status: 'ok', detail: 'key ใช้งานได้' })
      checks.push({
        label: 'โลโก้โรงพยาบาล',
        status: 'fail',
        detail:
          'ยังไม่ได้อัปโหลดโลโก้ใน CMS MOPH ALERTING — การ์ดแจ้งเตือนจะส่งไม่ออกจนกว่าจะอัปโหลด',
      })
      return { ok: false, checks }
    }

    if (code === 404) {
      checks.push({
        label: 'ตรวจสอบ key',
        status: 'ok',
        detail: `key ใช้งานได้ (ปลายทางตอบ 404 เพราะหา cid ทดสอบไม่เจอ ตามที่คาดไว้)`,
      })
      return { ok: true, checks }
    }

    if (code === 200) {
      checks.push({
        label: 'ตรวจสอบ key',
        status: 'warn',
        detail:
          `key ใช้งานได้ แต่ปลายทางตอบ 200 กับ cid ทดสอบ ${probeCid} ` +
          `ซึ่งไม่ควรมีอยู่จริง — ตรวจสอบกับผู้ดูแล MOPH ว่ามีข้อความถูกส่งออกไปหรือไม่`,
      })
      return { ok: true, checks }
    }

    checks.push({
      label: 'ตรวจสอบ key',
      status: 'warn',
      detail: `ได้ผลลัพธ์ที่ไม่รู้จัก: code ${code} — ${message}`,
    })
    return { ok: false, checks }
  }
}
