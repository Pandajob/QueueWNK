import { DateTime } from 'luxon'
import type { HosxpClient } from '#services/hosxp_client'
import { isReadOnlyStatement } from '#services/hosxp_client'
import { NotifyDataset } from '#models/notify_system'
import { withHosxp } from '#services/hosxp_session'

/** กันเผลอเขียน query ที่คืนมาเป็นแสนแถวแล้วดูดหน่วยความจำ */
export const MAX_ROWS = 200

/** ถ้าเกินนี้ถือว่า query หนักเกินจะเอาไปวิ่งซ้ำ ๆ บนเครื่องหลักของโรงพยาบาล */
export const SLOW_MS = 3_000

export type DatasetResult = {
  rows: Record<string, unknown>[]
  columns: string[]
  durationMs: number
  truncated: boolean
}

export class DatasetError extends Error {}

/**
 * ครอบ SQL ของผู้ใช้ด้วย LIMIT อีกชั้น
 *
 * ผู้ใช้ใส่ LIMIT เองก็ยังครอบ เพราะ LIMIT ชั้นนอกไม่ทำให้ผลลัพธ์เปลี่ยน
 * ถ้าชั้นในน้อยกว่าอยู่แล้ว แต่กันกรณีลืมใส่ได้แน่นอน
 *
 * ครอบได้เฉพาะ SELECT/WITH — `SHOW COLUMNS FROM x` เอาไปใส่ใน derived table
 * ไม่ได้ จะกลายเป็น syntax error ส่วนพวกนั้นคืนผลไม่กี่แถวอยู่แล้ว ปล่อยผ่านไป
 *
 * ตัด `;` ท้ายออกก่อน ไม่งั้นจะกลายเป็น syntax error ตอนครอบ
 */
export function wrapWithLimit(sql: string, limit = MAX_ROWS + 1) {
  const inner = sql.trim().replace(/;+\s*$/, '')
  if (!/^(select|with)\b/i.test(inner)) return inner

  return `SELECT * FROM (${inner}) AS dataset_result LIMIT ${limit}`
}

/**
 * วิ่ง SQL ของชุดข้อมูลกับ HOSxP
 *
 * ด่านความปลอดภัยสามชั้น ตามลำดับ
 *   1. HosxpClient ยอมเฉพาะคำสั่งที่ขึ้นต้นด้วย SELECT/SHOW/… และปิด multipleStatements
 *   2. สิทธิ์ระดับ MySQL เป็น GRANT SELECT อย่างเดียว
 *   3. LIMIT ชั้นนอกกันผลลัพธ์บานปลาย
 *
 * ที่ยังทำไม่ได้: กำหนด statement timeout ฝั่งเซิร์ฟเวอร์ เพราะ MariaDB ต้องใช้
 * `SET STATEMENT max_statement_time=… FOR SELECT …` ซึ่งขึ้นต้นด้วย SET
 * แล้วจะโดนด่านที่ 1 ปฏิเสธ — จึงได้แค่วัดเวลาแล้วเตือนว่าช้า
 */
export async function runDatasetSql(client: HosxpClient, sql: string): Promise<DatasetResult> {
  if (!sql.trim()) throw new DatasetError('ยังไม่ได้ใส่คำสั่ง SQL')

  if (!isReadOnlyStatement(sql)) {
    throw new DatasetError(
      'รับเฉพาะคำสั่งอ่านข้อมูล (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH) — ระบบนี้ห้ามเขียนลงฐาน HOSxP'
    )
  }

  const started = Date.now()
  const rows = await client.select(wrapWithLimit(sql))
  const durationMs = Date.now() - started

  const truncated = rows.length > MAX_ROWS

  return {
    rows: truncated ? rows.slice(0, MAX_ROWS) : rows,
    columns: rows.length ? Object.keys(rows[0]) : [],
    durationMs,
    truncated,
  }
}

/** วิ่งชุดข้อมูลที่บันทึกไว้ พร้อมอัปเดตสถิติการรันล่าสุด */
export async function runDataset(dataset: NotifyDataset): Promise<DatasetResult> {
  const result = await withHosxp((client) => runDatasetSql(client, dataset.sqlText)).catch(
    async (error: Error) => {
      dataset.merge({
        lastRunAt: DateTime.now(),
        lastError: error.message.slice(0, 500),
        lastRowCount: null,
        lastDurationMs: null,
      })
      await dataset.save()
      throw error
    }
  )

  if (!result) throw new DatasetError('ยังไม่ได้ตั้งค่าการเชื่อมต่อ HOSxP')

  dataset.merge({
    lastRunAt: DateTime.now(),
    lastRowCount: result.rows.length,
    lastDurationMs: result.durationMs,
    // จำชื่อคอลัมน์ไว้ให้ตัวแก้ไขการ์ดเสนอเป็นตัวเลือก
    lastColumns: result.columns.length ? result.columns : dataset.lastColumns,
    lastError: null,
  })
  await dataset.save()

  return result
}
