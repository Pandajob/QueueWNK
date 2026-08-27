import type { HttpContext } from '@adonisjs/core/http'
import { NotifyAuditLog } from '#models/notify_system'
import type { AuditAction } from '#models/notify_system'

/** ค่าที่ห้ามโผล่ในประวัติการแก้ไข — เก็บแค่ว่า "เปลี่ยน" ไม่เก็บว่าเปลี่ยนเป็นอะไร */
const SECRET_FIELDS = /key|secret|password|token/i

const REDACTED = '•••'

export type Changes = Record<string, { from: unknown; to: unknown }>

/**
 * เทียบค่าก่อน/หลัง แล้วคืนเฉพาะฟิลด์ที่เปลี่ยนจริง
 *
 * ฟิลด์ที่เป็นความลับถูกแทนด้วย ••• ทั้งสองฝั่ง — ประวัติการแก้ไขมีไว้ตอบว่า
 * "ใครแตะอะไรเมื่อไร" ไม่ใช่ที่เก็บ secret อีกชุดหนึ่ง
 */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): Changes {
  const changes: Changes = {}

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key]
    const to = after[key]
    if (JSON.stringify(from) === JSON.stringify(to)) continue

    changes[key] = SECRET_FIELDS.test(key)
      ? { from: from == null ? null : REDACTED, to: to == null ? null : REDACTED }
      : { from: from ?? null, to: to ?? null }
  }

  return changes
}

export type RecordInput = {
  action: AuditAction
  entity: string
  entityId?: string | number | null
  summary: string
  changes?: Changes | null
}

/**
 * บันทึกว่าใครทำอะไร
 *
 * ห้าม throw — การบันทึกประวัติล้มเหลวไม่ควรทำให้การกระทำที่ผู้ใช้ตั้งใจทำล้มตาม
 * (แต่จะขึ้น log ไว้ให้เห็นว่ามีช่องโหว่)
 */
export async function audit(ctx: HttpContext, input: RecordInput) {
  try {
    const user = ctx.auth?.user

    await NotifyAuditLog.create({
      userId: user?.id ?? null,
      userEmail: user?.email ?? 'unknown',
      action: input.action,
      entity: input.entity,
      entityId: input.entityId == null ? null : String(input.entityId),
      summary: input.summary.slice(0, 255),
      changes: input.changes && Object.keys(input.changes).length ? input.changes : null,
      ip: ctx.request.ip(),
    })
  } catch (error) {
    ctx.logger.warn({ err: error }, 'บันทึกประวัติการแก้ไขไม่สำเร็จ')
  }
}
