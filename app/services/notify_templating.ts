import { DateTime } from 'luxon'
import type { DatasetResult } from '#services/dataset_runner'

/**
 * ตัวยึดที่ใช้ได้เสมอ ไม่ต้องมีชุดข้อมูล
 */
export const BUILTIN_PLACEHOLDERS = {
  date: 'วันที่วันนี้ เช่น 04/08/2569',
  date_iso: 'วันที่แบบ 2026-08-04',
  time: 'เวลาตอนส่ง เช่น 16:30',
  datetime: 'วันที่และเวลา',
  weekday: 'ชื่อวัน เช่น วันอังคาร',
  rows: 'จำนวนแถวที่ชุดข้อมูลคืนมา',
} as const

const THAI_WEEKDAYS = [
  'วันจันทร์',
  'วันอังคาร',
  'วันพุธ',
  'วันพฤหัสบดี',
  'วันศุกร์',
  'วันเสาร์',
  'วันอาทิตย์',
]

export function builtinValues(rowCount: number, now = DateTime.now().setZone('Asia/Bangkok')) {
  return {
    date: `${now.toFormat('dd/MM')}/${now.year + 543}`,
    date_iso: now.toFormat('yyyy-MM-dd'),
    time: now.toFormat('HH:mm'),
    datetime: `${now.toFormat('dd/MM')}/${now.year + 543} ${now.toFormat('HH:mm')}`,
    weekday: THAI_WEEKDAYS[now.weekday - 1] ?? '',
    rows: String(rowCount),
  } as Record<string, string>
}

/**
 * ตัวยึดที่ชุดข้อมูลให้มา
 *
 * แถวแรกกลายเป็น {ชื่อคอลัมน์} ตรง ๆ — เหมาะกับ query ที่คืนค่าสรุปแถวเดียว
 * เช่น `SELECT COUNT(*) AS visits, SUM(...) AS revenue`
 *
 * ส่วน {each:...} ใช้กับ query ที่คืนหลายแถว จะวนพิมพ์ทีละบรรทัด
 */
export function datasetValues(result: DatasetResult | null) {
  const values: Record<string, string> = {}
  if (!result?.rows.length) return values

  for (const [key, value] of Object.entries(result.rows[0])) {
    values[key] = value == null ? '' : String(value)
  }
  return values
}

const EACH_BLOCK = /\{each\}([\s\S]*?)\{\/each\}/g
const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g

/**
 * แทนค่าลงเทมเพลต
 *
 * รองรับสองแบบ
 *   {ชื่อคอลัมน์}                 — ค่าจากแถวแรก หรือค่า builtin
 *   {each} … {ชื่อคอลัมน์} … {/each} — วนทุกแถวของชุดข้อมูล
 *
 * ตัวยึดที่ไม่รู้จักจะถูกแทนด้วยค่าว่าง ไม่ปล่อย {xxx} ติดไปให้คนอ่านเห็น
 */
export function renderNotifyTemplate(body: string, result: DatasetResult | null) {
  const rows = result?.rows ?? []
  const scope = { ...builtinValues(rows.length), ...datasetValues(result) }

  const withLoops = body.replace(EACH_BLOCK, (_match, inner: string) => {
    if (!rows.length) return ''

    return rows
      .map((row) => {
        const rowScope: Record<string, string> = { ...scope }
        for (const [key, value] of Object.entries(row)) {
          rowScope[key] = value == null ? '' : String(value)
        }
        return inner.replace(PLACEHOLDER, (_m, name: string) => rowScope[name] ?? '')
      })
      .join('')
  })

  return withLoops.replace(PLACEHOLDER, (_m, name: string) => scope[name] ?? '').trim()
}

/** ตัวยึดที่เทมเพลตใช้อยู่แต่ไม่มีใครให้ค่า — เอาไว้เตือนตอนบันทึก */
export function unknownPlaceholders(body: string, availableColumns: string[]) {
  const known = new Set([...Object.keys(BUILTIN_PLACEHOLDERS), ...availableColumns])
  const used = new Set<string>()

  for (const match of body.matchAll(PLACEHOLDER)) used.add(match[1])

  return [...used].filter((name) => !known.has(name))
}
