import { DateTime } from 'luxon'
import logger from '@adonisjs/core/services/logger'

import { NotifyDataset, NotifySchedule } from '#models/notify_system'
import type { NotifyTemplate } from '#models/notify_system'
import { runDataset } from '#services/dataset_runner'
import type { DatasetResult } from '#services/dataset_runner'
import { renderNotifyTemplate } from '#services/notify_templating'
import {
  blocksToPlainText,
  buildFlexMessages,
  buildScope,
  resolveBlocks,
} from '#services/flex_builder'
import type { FlexBlock, ResolvedBlock } from '#services/flex_builder'
import { dispatch } from '#services/notify_dispatcher'
import type { LineMessage } from '#services/notify_client'

export type ScheduleTickResult = {
  due: number
  sent: number
  failed: number
}

export type RenderedTemplate = {
  /** ข้อความอ่านง่าย ใช้เก็บลงประวัติเสมอ */
  body: string
  /** มีเฉพาะตอนเป็นการ์ด Flex */
  messages?: LineMessage[]
  data: DatasetResult | null
  resolved?: ResolvedBlock[]
}

/**
 * วิ่งทุกชุดข้อมูลที่การ์ดอ้างถึง — ชุดเดียวกันถูกอ้างหลายบล็อกก็วิ่งครั้งเดียว
 * ไม่งั้นการ์ดที่มี 4 บล็อกจากชุดเดียวกันจะยิง query ซ้ำ 4 รอบใส่เครื่องโรงพยาบาล
 */
async function runReferencedDatasets(blocks: FlexBlock[]) {
  const keys = new Set(
    blocks
      .map((block) => ('datasetKey' in block ? block.datasetKey : undefined))
      .filter((key): key is string => !!key)
  )

  const datasets: Record<string, DatasetResult> = {}

  for (const key of keys) {
    const dataset = await NotifyDataset.findBy('key', key)
    if (dataset?.isEnabled) datasets[key] = await runDataset(dataset)
  }

  return datasets
}

/** เตรียมข้อความของเทมเพลตหนึ่งอัน — วิ่งชุดข้อมูลถ้ามี แล้วแทนค่า */
export async function renderTemplateNow(template: NotifyTemplate): Promise<RenderedTemplate> {
  let data: DatasetResult | null = null

  if (template.datasetId) {
    await template.load('dataset')
    if (template.dataset?.isEnabled) {
      data = await runDataset(template.dataset)
    }
  }

  if (template.messageType !== 'flex') {
    return { body: renderNotifyTemplate(template.body, data), data }
  }

  const blocks = template.blocks
  const scope = buildScope(data, await runReferencedDatasets(blocks))
  const resolved = resolveBlocks(blocks, scope)

  const altText = renderNotifyTemplate(template.altText || template.name, data)

  return {
    body: blocksToPlainText(resolved),
    // บล็อก "ขึ้นการ์ดใหม่" ทำให้ได้หลายชิ้น — ข้อความธรรมดายังเป็นชิ้นเดียวเสมอ
    messages: buildFlexMessages(altText, resolved, template.flexColor),
    data,
    resolved,
  }
}

export class ScheduleRunner {
  /**
   * ตรวจว่ามีรอบไหนถึงเวลาส่งแล้วบ้าง
   *
   * เรียกได้บ่อยเท่าไรก็ได้ — `isDue()` เทียบกับ `last_run_at` จึงส่งซ้ำไม่ได้
   * ในรอบเดียวกัน และถ้า worker ดับข้ามเวลานัด พอฟื้นมาจะยังส่งให้ (สายดีกว่าหาย)
   */
  async tick(now = DateTime.now().setZone('Asia/Bangkok')): Promise<ScheduleTickResult> {
    const result: ScheduleTickResult = { due: 0, sent: 0, failed: 0 }

    const schedules = await NotifySchedule.query()
      .where('is_enabled', true)
      .preload('template')
      .preload('groups')

    for (const schedule of schedules) {
      if (!schedule.isDue(now)) continue
      result.due++

      try {
        if (!schedule.template?.isEnabled) {
          throw new Error('เทมเพลตถูกปิดใช้งาน')
        }

        const targets = schedule.groups.filter((group) => group.isUsable)
        if (!targets.length) {
          throw new Error('ไม่มีกลุ่มที่ใช้งานได้')
        }

        const { body, messages } = await renderTemplateNow(schedule.template)

        const outcome = await dispatch({
          groups: targets,
          body,
          messages,
          source: 'schedule',
          subject: schedule.name,
          scheduleId: schedule.id,
          templateId: schedule.templateId,
        })

        result.sent += outcome.sent
        result.failed += outcome.failed

        schedule.merge({
          lastRunAt: DateTime.now(),
          lastStatus: outcome.failed ? 'partial' : 'sent',
          lastError: outcome.failed ? `ส่งไม่ผ่าน ${outcome.failed} กลุ่ม` : null,
        })
        await schedule.save()
      } catch (error) {
        result.failed++

        // จับเวลาไว้ด้วยแม้จะพัง ไม่งั้นจะลองใหม่ทุก 60 วินาทีไปจนสิ้นวัน
        schedule.merge({
          lastRunAt: DateTime.now(),
          lastStatus: 'failed',
          lastError: String(error?.message ?? error).slice(0, 500),
        })
        await schedule.save()

        logger.warn({ schedule: schedule.name, err: error }, 'ส่งตามตารางเวลาไม่สำเร็จ')
      }
    }

    return result
  }
}
