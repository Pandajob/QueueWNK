import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * เครื่องมือหาสาเหตุตอนการ์ด Flex ไม่โผล่ในกลุ่ม
 *
 * MOPH Notify ตอบ 200 ตั้งแต่รับเรื่อง แล้วค่อยส่งต่อให้ LINE อีกทอด
 * ถ้า LINE ปฏิเสธการ์ด เราจะไม่รู้เลยจากฝั่งเรา — คำสั่งนี้เอา payload จริง
 * มากางให้ดู และยิงทีละชิ้นเพื่อไล่หาว่าบล็อกไหนทำพัง
 *
 *   node ace notify:debug-flex --dump
 *   node ace notify:debug-flex --probe-group=5
 */
export default class NotifyDebugFlex extends BaseCommand {
  static commandName = 'notify:debug-flex'
  static description = 'กาง payload การ์ด Flex และยิงทดสอบทีละชิ้น'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'คีย์เทมเพลต' })
  declare template: string

  @flags.boolean({ description: 'พิมพ์ payload ที่จะส่งออกไปจริง' })
  declare dump: boolean

  @flags.number({ description: 'ยิงชุดทดสอบเข้ากลุ่มนี้จริง (ข้อความจะโผล่ในกลุ่ม)' })
  declare probeGroup: number

  @flags.number({
    description: 'ส่งเทมเพลตจริงผ่านทางเดินปกติ เพื่อดูว่าตัวถอยไปข้อความธรรมดาทำงาน',
  })
  declare sendGroup: number

  async run() {
    const { NotifyTemplate, NotifyGroup } = await import('#models/notify_system')
    const { renderTemplateNow } = await import('#services/schedule_runner')
    const { MophNotifyClient } = await import('#services/notify_client')

    const key = this.template || 'daily_summary'
    const template = await NotifyTemplate.findBy('key', key)
    if (!template) {
      this.logger.error(`ไม่พบเทมเพลต ${key}`)
      return
    }

    const rendered = await renderTemplateNow(template)

    if (this.dump) {
      this.logger.info('payload ที่จะส่งออกไป')
      console.log(JSON.stringify(rendered.messages, null, 1))

      // LINE นับเป็นไบต์ ไม่ใช่ตัวอักษร — ภาษาไทยกินตัวละ 3 ไบต์ใน UTF-8
      // ถ้าวัดด้วย .length จะได้ตัวเลขที่ต่ำกว่าความจริงเกือบเท่าตัว
      // เพดานนับต่อข้อความ ไม่ใช่ต่อคำขอ — การ์ดที่ตัดเป็นหลายใบจึงได้โควตาใบละก้อน
      const limit = 10 * 1024

      for (const [index, message] of (rendered.messages ?? []).entries()) {
        const bytes = Buffer.byteLength(JSON.stringify(message), 'utf8')
        const line = `การ์ดใบที่ ${index + 1}: ${bytes.toLocaleString()} ไบต์ จากเพดาน ${limit.toLocaleString()}`
        if (bytes > limit) this.logger.error(line + ' — เกิน')
        else this.logger.success(line)
      }

      this.logger.info('ข้อความสำรอง — กลุ่มที่รับการ์ดไม่ได้จะได้อันนี้แทน')
      console.log(rendered.body)
    }

    // เดินทางเดียวกับปุ่ม "ส่งเดี๋ยวนี้" ในหน้าเว็บ รวมถึงตัวถอยไปข้อความธรรมดา
    if (this.sendGroup) {
      const { dispatch } = await import('#services/notify_dispatcher')
      const target = await NotifyGroup.find(this.sendGroup)

      if (!target) {
        this.logger.error('ไม่พบกลุ่มนี้')
        return
      }

      const outcome = await dispatch({
        groups: [target],
        body: rendered.body,
        messages: rendered.messages,
        source: 'manual',
        subject: template.name,
        templateId: template.id,
      })

      const record = outcome.messages[0]
      this.logger.info(
        `${target.name}: ${record.status} · ${target.supportsFlex ? 'ส่งเป็นการ์ด' : 'ส่งเป็นข้อความธรรมดา'}` +
          (record.error ? ` · ${record.error}` : '')
      )
      return
    }

    if (!this.probeGroup) return

    const group = await NotifyGroup.find(this.probeGroup)
    if (!group?.isUsable) {
      this.logger.error('กลุ่มนี้ใช้ไม่ได้')
      return
    }

    const client = new MophNotifyClient({
      baseUrl: group.baseUrl,
      clientKey: group.clientKey!,
      secretKey: group.secretKey!,
    })

    // รอบแรกพิสูจน์แล้วว่า flex ที่ถูก spec ทุกอย่างก็ไม่เข้ากลุ่ม แต่ MOPH ตอบ 200
    // รอบนี้ไล่ว่ารูปแบบที่ MOPH รับจริงคืออะไร ไม่ใช่ว่าการ์ดเราผิดตรงไหน
    const bubble = (rendered.messages?.[0] as any)?.contents
    const simple = {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'text', text: 'ทดสอบการ์ด', wrap: true }],
      },
    }

    const probes: { name: string; messages: any[] }[] = [
      // ลอกลำดับคีย์ตามคู่มือเป๊ะ ๆ — altText, contents, type (type อยู่ท้ายสุด)
      // และส่ง text นำหน้าในคำขอเดียวกันแบบที่คู่มือทำ
      {
        name: 'A ลอกตัวอย่างในคู่มือ (text + flex ในคำขอเดียว)',
        messages: [
          { type: 'text', text: 'probe A — text นำ' },
          { altText: 'probe A', contents: { ...simple, size: 'mega' }, type: 'flex' },
        ],
      },
      // API ไทยหลายเจ้าห่อ contents เป็นสตริง JSON แทน object
      {
        name: 'B contents เป็นสตริง JSON',
        messages: [{ type: 'flex', altText: 'probe B', contents: JSON.stringify(simple) }],
      },
      // เผื่อ MOPH ตรวจ altText แบบเข้มแล้วทิ้งเงียบเมื่อมีอักษรไทย
      {
        name: 'C altText อังกฤษล้วน',
        messages: [{ type: 'flex', altText: 'probe C', contents: simple }],
      },
      // เผื่อว่ารับเฉพาะ message เดียวต่อคำขอ และต้องเป็น flex ล้วน ๆ ไม่มี size
      {
        name: 'D flex เปล่าที่สุดเท่าที่ทำได้',
        messages: [
          {
            type: 'flex',
            altText: 'probe D',
            contents: {
              type: 'bubble',
              body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'D' }] },
            },
          },
        ],
      },
    ]

    for (const probe of probes) {
      if (!probe.messages.length) continue
      const response = await client.send(probe.messages)
      const code = response.body?.message_code ?? response.status
      const line = `${probe.name}: HTTP ${response.status} · code ${code} · ${response.body?.message ?? response.raw.slice(0, 200)}`
      if (code === 200) this.logger.success(line)
      else this.logger.error(line)
    }

    if (bubble) this.logger.info('ถ้าทุกอันตอบ Success แต่เห็นไม่ครบในกลุ่ม แปลว่า LINE ทิ้งเงียบ')
  }
}
