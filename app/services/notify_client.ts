import type { TestCheck, TestResult } from '#services/hosxp_tester'

export type NotifyConfig = {
  baseUrl: string
  clientKey: string
  secretKey: string
}

export type NotifyResponse = {
  message: string
  message_code: number
}

/** ข้อความรูปแบบ LINE — ตอนนี้ใช้แค่ text ก็พอสำหรับแจ้งเตือนทีมงาน */
export type LineMessage = { type: 'text'; text: string } | Record<string, unknown>

/**
 * ปลายทางคือกลุ่มแชท ไม่ใช่ผู้ป่วยรายคน — ตัดเลข 13 หลักทิ้งก่อนส่งเสมอ
 *
 * ข้อความ error จาก mysql หรือจาก MOPH Alert บางทีมีค่าที่เราส่งไปติดมาด้วย
 * ถ้าเผลอมี cid ปนมาจะกลายเป็นข้อมูลผู้ป่วยหลุดเข้ากลุ่มที่มีคนอ่านหลายคน
 * กันไว้ที่ชั้นล่างสุดตรงนี้ จะได้ไม่ต้องไว้ใจว่าทุกจุดที่เรียกใช้ระวังครบ
 */
export function scrubCid(text: string) {
  return text.replace(/\d{13}/g, 'xxxxxxxxxxxxx')
}

/**
 * เดินทั่วทั้งก้อนข้อความแล้วกรองเฉพาะค่าที่เป็นสตริง
 *
 * การ์ด Flex เป็น object ซ้อนหลายชั้น ถ้า scrub ด้วยการ stringify ทั้งก้อน
 * แล้วค่อยแทนที่ ตัวเลข 13 หลักที่เป็น number literal จะกลายเป็น xxx
 * แล้ว JSON.parse กลับไม่ได้ — เดินทีละค่าจึงปลอดภัยกว่า
 */
export function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubCid(value) as T
  if (Array.isArray(value)) return value.map(scrubDeep) as T

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = scrubDeep(item)
    return out as T
  }

  return value
}

export class MophNotifyClient {
  constructor(private config: NotifyConfig) {}

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
    let parsed: NotifyResponse | null = null
    try {
      parsed = JSON.parse(text)
    } catch {
      // ปลายทางตอบไม่ใช่ JSON — เก็บ text ดิบไว้ให้ debug
    }

    return { status: response.status, body: parsed, raw: text }
  }

  /**
   * ปลายทางมีคิวแยกกัน — คำขอที่มี flex ปนอยู่เข้ากลุ่มช้ากว่า text ล้วนราว 19 นาที
   * และช้าทั้งคำขอ ไม่ใช่แค่ตัวการ์ด ถ้าเอา text ยัดรวมมาด้วยจะถูกดองไปด้วย
   * อยากให้ข้อความด่วนถึงทันทีต้องเรียกแยกคำขอ อย่ารวมใน messages ชุดเดียว
   */
  send(messages: LineMessage[]) {
    return this.post('/api/notify/send', { messages })
  }

  sendText(text: string) {
    return this.send([{ type: 'text', text: scrubCid(text).slice(0, 4000) }])
  }

  /**
   * ตรวจ key โดยไม่ให้มีข้อความโผล่ในกลุ่ม
   *
   * ยิงคำขอที่ไม่มี messages มาด้วย ปลายทางตรวจ key ก่อนตรวจ body:
   *   - "Unauthorized"       → key ผิด
   *   - "require messages"   → key ถูก (ผ่านด่าน auth มาแล้วถึงมาบ่นเรื่อง body)
   *
   * ไม่มีอะไรถูกส่งเข้ากลุ่มทั้งสองกรณี ถ้าอยากเห็นของจริงต้องกดปุ่ม
   * "ส่งข้อความทดสอบ" แยกต่างหาก
   */
  async verify(): Promise<TestResult> {
    const checks: TestCheck[] = []

    let result: Awaited<ReturnType<typeof this.post>>
    try {
      result = await this.post('/api/notify/send', {})
    } catch (error) {
      return {
        ok: false,
        checks: [
          {
            label: 'เชื่อมต่อ MOPH Notify',
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
      label: 'เชื่อมต่อ MOPH Notify',
      status: 'ok',
      detail: `${this.config.baseUrl} ตอบกลับ HTTP ${result.status}`,
    })

    const code = result.body?.message_code ?? result.status
    const message = result.body?.message ?? result.raw.slice(0, 200)

    if (/require messages/i.test(message)) {
      checks.push({
        label: 'ตรวจสอบ key',
        status: 'ok',
        detail: 'key ใช้งานได้ (ปลายทางผ่านด่าน auth แล้วมาบ่นว่าไม่ได้ส่งข้อความมา ตามที่คาดไว้)',
      })
      return { ok: true, checks }
    }

    if (/unauthorized/i.test(message) || code === 401) {
      checks.push({
        label: 'ตรวจสอบ key',
        status: 'fail',
        detail:
          'client-key หรือ secret-key ไม่ถูกต้อง — คัดลอกใหม่จาก CMS MOPH Notify ' +
          'เมนู "กลุ่มบอท" (จะเห็น key ต่อเมื่อกลุ่มมีสถานะ "อนุมัติ" แล้ว)',
      })
      return { ok: false, checks }
    }

    checks.push({
      label: 'ตรวจสอบ key',
      status: 'warn',
      detail: `ได้ผลลัพธ์ที่ไม่รู้จัก: code ${code} — ${message}`,
    })
    return { ok: false, checks }
  }
}
