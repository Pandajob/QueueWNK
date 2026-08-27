import type { DatasetResult } from '#services/dataset_runner'
import { builtinValues, datasetValues } from '#services/notify_templating'

/**
 * การ์ด Flex ถูกเก็บเป็น "รายการบล็อก" ไม่ใช่ Flex JSON ดิบ
 *
 * เหตุผล: ผู้ดูแลต้องแก้ได้จากหน้าเว็บโดยไม่ต้องรู้จัก schema ของ LINE
 * และถ้าวันหนึ่ง LINE เปลี่ยนรูปแบบ เราแก้ที่ตัวแปลงจุดเดียว
 * ไม่ต้องไล่แก้การ์ดที่โรงพยาบาลสร้างไว้ทีละอัน
 */
/**
 * เมื่อไรถึงทำแถวเป็นสีแดง
 *
 * `zero`    — แผนกที่วันนี้ไม่มีคนมารับบริการ ศูนย์คือเรื่องผิดปกติ
 * `nonzero` — งานที่ค้างอยู่ เช่นยังไม่ลง Dx ศูนย์คือเรื่องดี ไม่ใช่ศูนย์ต่างหากที่ต้องรีบ
 */
export type AlertWhen = 'none' | 'zero' | 'nonzero'

const ALERT_WHEN: AlertWhen[] = ['none', 'zero', 'nonzero']

export const ALERT_WHEN_LABELS: Record<AlertWhen, string> = {
  none: 'ไม่ทำสีแดง',
  zero: 'แดงเมื่อค่าเป็น 0',
  nonzero: 'แดงเมื่อค่ามากกว่า 0',
}

export type FlexBlock =
  | { type: 'header'; title: string; subtitle?: string }
  | { type: 'hero'; label?: string; value: string; unit?: string; caption?: string }
  | {
      type: 'bars'
      title?: string
      datasetKey?: string
      labelColumn?: string
      valueColumn?: string
      alertWhen?: AlertWhen
    }
  | {
      type: 'rows'
      title?: string
      datasetKey?: string
      labelColumn?: string
      valueColumn?: string
      alertWhen?: AlertWhen
    }
  | { type: 'text'; text: string; tone?: 'normal' | 'muted' | 'warn' }
  | { type: 'divider' }
  | { type: 'pagebreak' }
  | { type: 'button'; label: string; url: string }

export type BlockType = FlexBlock['type']

export const BLOCK_LABELS: Record<BlockType, string> = {
  header: 'หัวการ์ด',
  hero: 'ตัวเลขเด่น',
  bars: 'รายการพร้อมแถบ',
  rows: 'รายการคู่ ป้าย–ค่า',
  text: 'ข้อความ',
  divider: 'เส้นคั่น',
  pagebreak: 'ขึ้นการ์ดใหม่',
  button: 'ปุ่มลิงก์',
}

export const BLOCK_TYPES = Object.keys(BLOCK_LABELS) as BlockType[]

/** ยาวกว่านี้ LINE ก็แสดงไม่ไหว และไม่ควรให้ยัดอะไรยาว ๆ ลง DB ผ่านฟอร์ม */
const MAX_BLOCKS = 40
const MAX_FIELD = 300

function str(value: unknown, max = MAX_FIELD) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/**
 * อ่านบล็อกจาก JSON ที่ฟอร์มส่งมา แล้วเก็บเฉพาะฟิลด์ที่รู้จัก
 *
 * ตัวแก้ไขเป็น JavaScript ฝั่งหน้าเว็บ ซึ่งส่งอะไรมาก็ได้ — ค่าที่ผ่านตรงนี้
 * จะถูกเอาไปประกอบเป็น payload ส่งออกไปหา LINE จึงต้องคัดทีละฟิลด์
 * ไม่ใช่รับ object ดิบไปทั้งก้อน
 *
 * ปุ่มลิงก์รับเฉพาะ http/https — LINE ไม่รับ scheme อื่นอยู่แล้ว
 * และ javascript: ในลิงก์ที่เจ้าหน้าที่กดต่อในหน้าเว็บเราเองก็ไม่ควรมี
 */
export function parseBlocks(raw: string | null | undefined): FlexBlock[] {
  if (!raw?.trim()) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) return []

  const blocks: FlexBlock[] = []

  for (const entry of parsed.slice(0, MAX_BLOCKS)) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>

    switch (item.type) {
      case 'header':
        blocks.push({ type: 'header', title: str(item.title), subtitle: str(item.subtitle) })
        break

      case 'hero':
        blocks.push({
          type: 'hero',
          label: str(item.label),
          value: str(item.value),
          unit: str(item.unit),
          caption: str(item.caption),
        })
        break

      case 'bars':
      case 'rows':
        blocks.push({
          type: item.type,
          title: str(item.title),
          datasetKey: str(item.datasetKey, 60),
          labelColumn: str(item.labelColumn, 60),
          valueColumn: str(item.valueColumn, 60),
          // zeroRed คือชื่อเดิมตอนที่ยังมีแค่สองสถานะ การ์ดเก่ายังส่งค่านี้มา
          alertWhen: ALERT_WHEN.includes(item.alertWhen as AlertWhen)
            ? (item.alertWhen as AlertWhen)
            : item.zeroRed
              ? 'zero'
              : 'none',
        })
        break

      case 'text':
        blocks.push({
          type: 'text',
          text: str(item.text, 1000),
          tone:
            item.tone === 'muted' || item.tone === 'warn'
              ? (item.tone as 'muted' | 'warn')
              : 'normal',
        })
        break

      case 'divider':
        blocks.push({ type: 'divider' })
        break

      case 'pagebreak':
        blocks.push({ type: 'pagebreak' })
        break

      case 'button': {
        const url = str(item.url, 1000)
        blocks.push({
          type: 'button',
          label: str(item.label),
          url: /^https?:\/\//i.test(url) ? url : '',
        })
        break
      }
    }
  }

  return blocks
}

/** ผลลัพธ์กลาง — ใช้สร้างทั้ง Flex จริงและตัวอย่างในหน้าเว็บ จะได้ตรงกันเสมอ */
export type ResolvedBlock =
  | { kind: 'header'; title: string; subtitle: string }
  | { kind: 'hero'; label: string; value: string; unit: string; caption: string }
  // alert คำนวณเสร็จตั้งแต่ตอน resolve — ตัววาดทั้งฝั่ง Flex ฝั่งหน้าเว็บ
  // และฝั่งข้อความธรรมดา อ่านค่าเดียวกัน ไม่ต้องรู้กติกาซ้ำกันสามที่
  | {
      kind: 'bars'
      title: string
      rows: { label: string; value: string; percent: number; alert: boolean }[]
    }
  | {
      kind: 'rows'
      title: string
      rows: { label: string; value: string; alert: boolean }[]
    }
  | { kind: 'text'; text: string; tone: 'normal' | 'muted' | 'warn' }
  | { kind: 'divider' }
  | { kind: 'pagebreak' }
  | { kind: 'button'; label: string; url: string }

const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g

/** ชุดข้อมูลที่บล็อกอ้างถึงได้ คีย์คือ key ของชุดข้อมูล */
export type DataScope = {
  /** ค่าจากแถวแรกของชุดข้อมูลหลัก + ค่า builtin */
  values: Record<string, string>
  /** ผลลัพธ์เต็มของแต่ละชุดข้อมูล ใช้กับบล็อกที่แสดงหลายแถว */
  datasets: Record<string, DatasetResult>
}

export function buildScope(
  primary: DatasetResult | null,
  datasets: Record<string, DatasetResult> = {}
): DataScope {
  return {
    values: { ...builtinValues(primary?.rows.length ?? 0), ...datasetValues(primary) },
    datasets,
  }
}

function fill(text: string | undefined, scope: DataScope) {
  if (!text) return ''
  return text.replace(PLACEHOLDER, (_m, name: string) => scope.values[name] ?? '')
}

/** ตัวเลขที่อ่านจากคอลัมน์อาจเป็น string มี comma มาด้วย */
function toNumber(value: unknown) {
  const n = Number(String(value ?? '').replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

/**
 * แถวนี้ต้องทำสีแดงไหม
 *
 * ดูจากค่าที่แสดงจริง ไม่ใช่จาก toNumber() เพราะตัวนั้นคืน 0 ให้ทุกอย่างที่
 * แปลงเป็นตัวเลขไม่ได้ — ถ้าดูแค่นั้น คอลัมน์ที่เป็นข้อความจะกลายเป็นแดงยกแถบ
 * ค่าที่ไม่ใช่ตัวเลขจึงไม่เข้าเงื่อนไขทั้งสองแบบ
 */
function isAlert(value: string, when: AlertWhen | undefined) {
  if (when !== 'zero' && when !== 'nonzero') return false

  const text = value.replace(/,/g, '').trim()
  if (text === '' || !Number.isFinite(Number(text))) return false

  return when === 'zero' ? Number(text) === 0 : Number(text) > 0
}

function tableRows(
  block: { datasetKey?: string; labelColumn?: string; valueColumn?: string },
  scope: DataScope
) {
  const result = block.datasetKey ? scope.datasets[block.datasetKey] : undefined
  if (!result?.rows.length) return []

  const columns = result.columns
  const labelColumn = block.labelColumn || columns[0]
  const valueColumn = block.valueColumn || columns[1] || columns[0]

  return result.rows.map((row) => ({
    label: String(row[labelColumn] ?? ''),
    value: String(row[valueColumn] ?? ''),
    raw: toNumber(row[valueColumn]),
  }))
}

/** แทนค่าตัวยึดและดึงข้อมูลจากชุดข้อมูลให้ครบ ก่อนเอาไปวาด */
export function resolveBlocks(blocks: FlexBlock[], scope: DataScope): ResolvedBlock[] {
  const resolved: ResolvedBlock[] = []

  for (const block of blocks) {
    switch (block.type) {
      case 'header':
        resolved.push({
          kind: 'header',
          title: fill(block.title, scope),
          subtitle: fill(block.subtitle, scope),
        })
        break

      case 'hero':
        resolved.push({
          kind: 'hero',
          label: fill(block.label, scope),
          value: fill(block.value, scope),
          unit: fill(block.unit, scope),
          caption: fill(block.caption, scope),
        })
        break

      case 'bars': {
        const rows = tableRows(block, scope)
        // สเกลแถบเทียบกับค่าสูงสุดในชุด ไม่ใช่ค่าคงที่
        // ไม่งั้นวันที่ตัวเลขน้อยแถบจะสั้นจนดูไม่ออกว่าอันไหนมากกว่ากัน
        const max = Math.max(1, ...rows.map((r) => r.raw))

        resolved.push({
          kind: 'bars',
          title: fill(block.title, scope),
          rows: rows.map((r) => ({
            label: r.label,
            value: r.value,
            percent: Math.max(0, Math.min(100, Math.round((r.raw / max) * 100))),
            alert: isAlert(r.value, block.alertWhen),
          })),
        })
        break
      }

      case 'rows':
        resolved.push({
          kind: 'rows',
          title: fill(block.title, scope),
          rows: tableRows(block, scope).map((r) => ({
            label: r.label,
            value: r.value,
            alert: isAlert(r.value, block.alertWhen),
          })),
        })
        break

      case 'text':
        resolved.push({
          kind: 'text',
          text: fill(block.text, scope),
          tone: block.tone ?? 'normal',
        })
        break

      case 'divider':
        resolved.push({ kind: 'divider' })
        break

      case 'pagebreak':
        resolved.push({ kind: 'pagebreak' })
        break

      case 'button':
        resolved.push({
          kind: 'button',
          label: fill(block.label, scope),
          url: fill(block.url, scope),
        })
        break
    }
  }

  return resolved
}

const TONE_COLOR = {
  normal: '#1c2530',
  muted: '#667080',
  warn: '#b02a2a',
} as const

/** สีของแถวที่เข้าเงื่อนไข "ทำสีแดง" */
const ALERT_COLOR = '#d02d2d'

/**
 * LINE จำกัด JSON ของข้อความ Flex ไว้ 10 KB และการ์ดสรุปมีหลายสิบแถว
 * ทุกคีย์ที่ใส่ซ้ำทุกแถวจึงกินโควตาจริง — ตัวช่วยนี้ตัดคีย์ที่เป็นค่าว่างทิ้ง
 * จะได้ใส่แบบมีเงื่อนไขได้โดยไม่ต้องเขียน spread ซ้อนให้อ่านยาก
 */
function compact<T extends Record<string, unknown>>(node: T) {
  for (const key of Object.keys(node)) {
    if (node[key] === undefined) delete node[key]
  }
  return node
}

function barRow(
  row: { label: string; value: string; percent: number; alert: boolean },
  accent: string
) {
  const alert = row.alert

  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'md',
    alignItems: 'center',
    contents: [
      compact({
        type: 'text',
        text: row.label,
        size: 'sm',
        color: alert ? ALERT_COLOR : '#3f4a57',
        weight: alert ? 'bold' : undefined,
        flex: 4,
        wrap: false,
      }),
      {
        type: 'box',
        layout: 'vertical',
        flex: 5,
        backgroundColor: '#e9edf1',
        height: '8px',
        cornerRadius: '4px',
        contents: [
          {
            type: 'box',
            layout: 'vertical',
            // LINE ไม่ยอมรับ width: "0%" — ค่าน้อยสุดต้องยังวาดได้
            width: `${Math.max(row.percent, 1)}%`,
            backgroundColor: alert ? ALERT_COLOR : accent,
            height: '8px',
            cornerRadius: '4px',
            contents: [{ type: 'filler' }],
          },
        ],
      },
      {
        type: 'text',
        text: row.value,
        size: 'sm',
        align: 'end',
        weight: 'bold',
        color: alert ? ALERT_COLOR : '#1c2530',
        flex: 2,
      },
    ],
  }
}

function sectionTitle(title: string) {
  return {
    type: 'text',
    text: title,
    size: 'sm',
    weight: 'bold',
    color: '#1c2530',
    margin: 'lg',
  }
}

/**
 * แปลงบล็อกเป็น Flex bubble ตามรูปแบบของ LINE
 *
 * header ตัวแรกกลายเป็นส่วนหัวของ bubble ส่วน button ตัวสุดท้ายกลายเป็น footer
 * ที่เหลืออยู่ใน body ตามลำดับที่ผู้ใช้จัดไว้
 */
export function buildBubble(resolved: ResolvedBlock[], accent = '#00857c') {
  const header = resolved.find((b) => b.kind === 'header')
  const button = [...resolved].reverse().find((b) => b.kind === 'button')

  const body: unknown[] = []

  for (const block of resolved) {
    if (block === header || block === button) continue

    switch (block.kind) {
      case 'header':
        // หัวการ์ดอันที่สองเป็นต้นไปวาดเป็นหัวข้อในเนื้อการ์ดแทน
        body.push(sectionTitle(block.title))
        if (block.subtitle) {
          body.push({ type: 'text', text: block.subtitle, size: 'xs', color: '#667080' })
        }
        break

      case 'hero':
        body.push({
          type: 'box',
          layout: 'vertical',
          margin: 'md',
          contents: [
            ...(block.label
              ? [{ type: 'text', text: block.label, size: 'sm', color: '#667080', align: 'center' }]
              : []),
            {
              type: 'text',
              text: block.value || '-',
              size: '3xl',
              weight: 'bold',
              align: 'center',
              color: accent,
            },
            ...(block.unit
              ? [{ type: 'text', text: block.unit, size: 'xs', color: '#667080', align: 'center' }]
              : []),
            ...(block.caption
              ? [
                  {
                    type: 'text',
                    text: block.caption,
                    size: 'xxs',
                    color: '#8b93a0',
                    align: 'center',
                    wrap: true,
                  },
                ]
              : []),
          ],
        })
        break

      case 'bars':
        if (block.title) body.push(sectionTitle(block.title))
        for (const row of block.rows) body.push(barRow(row, accent))
        break

      case 'rows':
        if (block.title) body.push(sectionTitle(block.title))
        for (const row of block.rows) {
          const alert = row.alert

          body.push({
            type: 'box',
            layout: 'horizontal',
            margin: 'sm',
            contents: [
              compact({
                type: 'text',
                text: row.label,
                size: 'sm',
                color: alert ? ALERT_COLOR : '#3f4a57',
                weight: alert ? 'bold' : undefined,
                flex: 6,
                wrap: true,
              }),
              {
                type: 'text',
                text: row.value,
                size: 'sm',
                weight: 'bold',
                align: 'end',
                color: alert ? ALERT_COLOR : '#1c2530',
                flex: 4,
              },
            ],
          })
        }
        break

      case 'text':
        body.push({
          type: 'text',
          text: block.text || ' ',
          size: 'sm',
          wrap: true,
          margin: 'md',
          color: TONE_COLOR[block.tone],
        })
        break

      case 'divider':
        body.push({ type: 'separator', margin: 'lg' })
        break

      case 'pagebreak':
        // splitPages() ตัดไปแล้วก่อนถึงตรงนี้ ถ้ายังเจอแปลว่าเรียก buildBubble ตรง ๆ
        break

      case 'button':
        // ปุ่มที่ไม่ใช่อันสุดท้ายวางในเนื้อการ์ด
        body.push({
          type: 'button',
          style: 'secondary',
          height: 'sm',
          margin: 'md',
          action: { type: 'uri', label: block.label || 'เปิด', uri: block.url },
        })
        break
    }
  }

  const bubble: Record<string, unknown> = {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      contents: body.length ? body : [{ type: 'text', text: ' ', size: 'sm' }],
    },
  }

  if (header) {
    bubble.header = {
      type: 'box',
      layout: 'vertical',
      backgroundColor: accent,
      paddingAll: '16px',
      contents: [
        {
          type: 'text',
          text: header.title || ' ',
          weight: 'bold',
          size: 'md',
          color: '#ffffff',
          wrap: true,
        },
        ...(header.subtitle
          ? [{ type: 'text', text: header.subtitle, size: 'xs', color: '#ffffffcc', wrap: true }]
          : []),
      ],
    }
  }

  if (button && button.url) {
    bubble.footer = {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: accent,
          height: 'sm',
          action: { type: 'uri', label: button.label || 'เปิด', uri: button.url },
        },
      ],
    }
  }

  return bubble
}

/** ข้อความ Flex หนึ่งชิ้นพร้อมส่ง */
export function buildFlexMessage(altText: string, bubble: unknown) {
  return { type: 'flex', altText: altText.slice(0, 400) || 'แจ้งเตือน', contents: bubble }
}

/** LINE รับได้ 5 ข้อความต่อหนึ่งคำขอ */
const MAX_PAGES = 5

/**
 * ตัดบล็อกเป็นหน้า ๆ ตามบล็อก "ขึ้นการ์ดใหม่"
 *
 * LINE จำกัด JSON ของข้อความ Flex ไว้ 10 KB **ต่อหนึ่งข้อความ** ไม่ใช่ต่อคำขอ
 * การ์ดสรุปที่มีหลายสิบแถวจึงยัดใบเดียวไม่พอ (วัดได้ 13 KB) ต้องแยกใบ
 * ซึ่งอ่านง่ายกว่าด้วย — สองการ์ดสั้น ๆ ดีกว่ากำแพงตัวเลขใบเดียว
 *
 * หัวการ์ดของหน้าแรกถูกยกไปใส่ทุกหน้า ไม่งั้นการ์ดใบที่สองจะลอยมาโดยไม่มีบริบท
 * ว่าเป็นรายงานอะไรของวันไหน
 */
export function splitPages(resolved: ResolvedBlock[]): ResolvedBlock[][] {
  const pages: ResolvedBlock[][] = [[]]

  for (const block of resolved) {
    if (block.kind === 'pagebreak') {
      if (pages.length >= MAX_PAGES) continue
      if (pages[pages.length - 1].length) pages.push([])
      continue
    }

    pages[pages.length - 1].push(block)
  }

  const filled = pages.filter((page) => page.length)
  if (filled.length < 2) return filled.length ? filled : [[]]

  const header = filled[0].find((b) => b.kind === 'header')
  if (!header) return filled

  return filled.map((page, index) =>
    index === 0 || page.some((b) => b.kind === 'header') ? page : [header, ...page]
  )
}

/**
 * ข้อความ Flex ทั้งชุดพร้อมส่ง หนึ่งชิ้นต่อหนึ่งการ์ด
 *
 * altText ของใบที่สองเป็นต้นไปเติมเลขหน้า เพราะ LINE เอา altText ไปขึ้นใน
 * รายการแชทกับ notification — ถ้าเหมือนกันหมดจะดูเหมือนส่งซ้ำ
 */
export function buildFlexMessages(altText: string, resolved: ResolvedBlock[], accent?: string) {
  const pages = splitPages(resolved)

  return pages.map((page, index) =>
    buildFlexMessage(
      pages.length > 1 ? `${altText} (${index + 1}/${pages.length})` : altText,
      buildBubble(page, accent)
    )
  )
}

/** แถบยาวสุด 10 ตัว — ยาวกว่านี้บรรทัดจะตัดในจอมือถือ */
const BAR_WIDTH = 10

/**
 * ข้อความสำรอง — ใช้บันทึกลงประวัติการส่ง และใช้ส่งจริงเมื่อกลุ่มรับการ์ดไม่ได้
 *
 * ประวัติต้องอ่านรู้เรื่องโดยไม่ต้องเปิด LINE จึงแปลงการ์ดเป็นข้อความธรรมดาเก็บไว้
 * (Flex JSON ดิบอ่านไม่ออกและยาวเกินกว่าจะมีประโยชน์ในตาราง)
 *
 * บล็อกแถบใส่ █ ต่อท้ายด้วย เพราะฟอนต์ใน LINE ไม่ใช่ความกว้างคงที่
 * จะจัดคอลัมน์ด้วยช่องว่างไม่ได้ แต่ █ กว้างเท่ากันทุกตัว เทียบกันเองได้อยู่
 */
export function blocksToPlainText(resolved: ResolvedBlock[]) {
  const lines: string[] = []

  for (const block of resolved) {
    switch (block.kind) {
      case 'header':
        lines.push(block.title, ...(block.subtitle ? [block.subtitle] : []), '')
        break
      case 'hero':
        lines.push(`${block.label} ${block.value} ${block.unit}`.trim())
        if (block.caption) lines.push(block.caption)
        lines.push('')
        break
      case 'bars':
        if (block.title) lines.push(block.title)
        for (const row of block.rows) {
          // ข้อความธรรมดาทำสีแดงไม่ได้ ใช้ ⚠ แทนให้สะดุดตาพอกัน
          const mark = row.alert ? '⚠ ' : ''
          const filled = Math.round((row.percent / 100) * BAR_WIDTH)
          const bar = filled > 0 ? '  ' + '█'.repeat(filled) : ''
          lines.push(`  ${mark}${row.label} — ${row.value}${bar}`)
        }
        lines.push('')
        break
      case 'rows':
        if (block.title) lines.push(block.title)
        for (const row of block.rows) {
          lines.push(`  ${row.alert ? '⚠ ' : ''}${row.label} — ${row.value}`)
        }
        lines.push('')
        break
      case 'text':
        lines.push(block.text, '')
        break
      case 'divider':
        lines.push('—'.repeat(20))
        break
      case 'pagebreak':
        // ข้อความธรรมดาไม่มีเรื่องเพดานขนาด ส่งชิ้นเดียวจบ ใช้เส้นคั่นแทน
        lines.push('', '—'.repeat(20), '')
        break
      case 'button':
        lines.push(`${block.label}: ${block.url}`)
        break
    }
  }

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
