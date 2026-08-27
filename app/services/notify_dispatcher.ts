import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'

import { NotifyGroup, NotifyMessage } from '#models/notify_system'
import type { MessageSource } from '#models/notify_system'
import { MophNotifyClient, scrubCid, scrubDeep } from '#services/notify_client'
import type { LineMessage } from '#services/notify_client'

export type DispatchInput = {
  groups: NotifyGroup[]
  /** ข้อความแบบอ่านง่าย ใช้เก็บลงประวัติเสมอ และใช้ส่งจริงถ้าไม่ได้ให้ messages มา */
  body: string
  /** ข้อความรูปแบบ LINE เต็ม ๆ เช่นการ์ด Flex — ไม่ใส่ = ส่งเป็น text ธรรมดา */
  messages?: LineMessage[]
  source: MessageSource
  subject?: string | null
  scheduleId?: number | null
  templateId?: number | null
}

export type DispatchResult = {
  sent: number
  failed: number
  skipped: number
  messages: NotifyMessage[]
}

/**
 * ส่งข้อความหนึ่งชิ้นไปหลายกลุ่ม แล้วบันทึกผลทุกกลุ่มลงประวัติการส่ง
 *
 * บันทึกทั้งที่ส่งสำเร็จและไม่สำเร็จ — ประวัติที่มีแต่ของที่สำเร็จใช้สืบหาสาเหตุไม่ได้
 * และเก็บ body ตามที่ส่งออกจริง (ผ่าน scrubCid แล้ว) ไม่ใช่เทมเพลตดิบ
 * เพราะเทมเพลตแก้ทีหลังได้ แต่ประวัติต้องบอกว่าตอนนั้นส่งอะไรออกไป
 */
export async function dispatch(input: DispatchInput): Promise<DispatchResult> {
  const body = scrubCid(input.body).slice(0, 4000)
  // การ์ด Flex ก็ต้องผ่านตัวกรองเลขบัตรเหมือนกัน ค่าในการ์ดมาจาก HOSxP ตรง ๆ
  const payload = input.messages?.length ? scrubDeep(input.messages) : null
  const result: DispatchResult = { sent: 0, failed: 0, skipped: 0, messages: [] }

  if (!payload && !body.trim()) {
    logger.warn({ source: input.source }, 'ข้อความว่าง — ไม่ส่ง')
    return result
  }

  for (const group of input.groups) {
    const base = {
      groupId: group.id,
      groupName: group.name,
      source: input.source,
      scheduleId: input.scheduleId ?? null,
      templateId: input.templateId ?? null,
      subject: input.subject ?? null,
      body,
    }

    if (!group.isUsable) {
      result.messages.push(
        await NotifyMessage.create({
          ...base,
          status: 'skipped',
          error: 'กลุ่มถูกปิดใช้งาน หรือยังไม่ได้ใส่ key',
        })
      )
      result.skipped++
      continue
    }

    try {
      const client = new MophNotifyClient({
        baseUrl: group.baseUrl,
        clientKey: group.clientKey!,
        secretKey: group.secretKey!,
      })

      // กลุ่มที่ปลายทางไม่ส่งการ์ดต่อ ให้ถอยไปใช้ข้อความธรรมดาที่แปลงไว้แล้ว
      // ไม่ใช่ส่งการ์ดออกไปแล้วบันทึกว่าสำเร็จทั้งที่ไม่มีใครได้เห็น
      const useFlex = Boolean(payload) && group.supportsFlex
      const response = useFlex ? await client.send(payload!) : await client.sendText(body)

      const code = response.body?.message_code ?? response.status

      if (code === 200) {
        result.messages.push(
          await NotifyMessage.create({
            ...base,
            status: 'sent',
            responseCode: code,
            error: payload && !useFlex ? 'กลุ่มนี้ตั้งไว้ว่ารับการ์ดไม่ได้ — ส่งเป็นข้อความธรรมดาแทน' : null,
            sentAt: DateTime.now(),
          })
        )
        result.sent++

        group.lastSentAt = DateTime.now()
        await group.save()
      } else {
        result.messages.push(
          await NotifyMessage.create({
            ...base,
            status: 'failed',
            responseCode: code,
            error: (response.body?.message ?? response.raw).slice(0, 500),
          })
        )
        result.failed++
      }
    } catch (error) {
      result.messages.push(
        await NotifyMessage.create({
          ...base,
          status: 'failed',
          error: String(error?.message ?? error).slice(0, 500),
        })
      )
      result.failed++
    }
  }

  return result
}
