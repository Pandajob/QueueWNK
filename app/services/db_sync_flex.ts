import { DateTime } from 'luxon'

import { METRICS, ROLE_LABELS, VERDICT_LABELS } from '#services/db_sync_checker'
import type { HostProbe, SyncReport } from '#services/db_sync_checker'
import type { LineMessage } from '#services/notify_client'

/**
 * การ์ด Flex ของรายงานฐานข้อมูล
 *
 * เขียนแยกจาก flex_builder.ts โดยตั้งใจ — ตัวนั้นสร้างการ์ดจากบล็อกที่ผู้ใช้ลากเอง
 * โครงจึงเป็น "ป้าย + ค่า" ทีละแถว ส่วนการ์ดนี้เป็นตารางเทียบเครื่อง × ตาราง
 * ซึ่งดัดตัวนั้นให้ทำได้ก็จะได้ของที่อ่านยากกว่าเขียนใหม่ และการ์ดนี้ผู้ใช้แก้ไม่ได้อยู่แล้ว
 */

/** โทนม่วง — สีสถานะจงใจอยู่นอกโทน จะได้อ่านออกว่าเป็นสถานะไม่ใช่การตกแต่ง */
const C = {
  deep: '#3b0f6f',
  main: '#6d28d9',
  soft: '#a78bfa',
  tint: '#f6f3ff',
  line: '#e5dcfa',
  ink: '#2a1055',
  body: '#4a3b6b',
  muted: '#8578a3',
  onDark: '#efe8ff',
  ok: '#15803d',
  warn: '#b45309',
  bad: '#be123c',
} as const

const VERDICT_TONE: Record<SyncReport['verdict'], { color: string; icon: string }> = {
  ok: { color: C.ok, icon: '✓' },
  lagging: { color: C.warn, icon: '!' },
  diverged: { color: C.bad, icon: '✕' },
  unreachable: { color: C.bad, icon: '✕' },
  no_data: { color: C.muted, icon: '–' },
}

/** LINE นับเป็นไบต์ ไม่ใช่ตัวอักษร — ภาษาไทยตัวละ 3 ไบต์ */
const MAX_BYTES = 10 * 1024
const MAX_BUBBLES = 12

function bytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** ตัดคีย์ที่เป็น undefined ทิ้ง ทุกคีย์ที่ซ้ำทุกแถวกินโควตา 10 KB จริง */
function compact<T extends Record<string, unknown>>(node: T) {
  for (const key of Object.keys(node)) if (node[key] === undefined) delete node[key]
  return node
}

function text(value: string, opts: Record<string, unknown> = {}) {
  return compact({ type: 'text', text: value, ...opts })
}

/** ป้ายกลม ๆ บอกบทบาทหรือสถานะ */
function chip(label: string, color: string, filled = false) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: filled ? color : undefined,
    borderColor: color,
    borderWidth: '1px',
    cornerRadius: '10px',
    paddingAll: '3px',
    paddingStart: '8px',
    paddingEnd: '8px',
    flex: 0,
    contents: [text(label, { size: 'xxs', color: filled ? '#ffffff' : color, weight: 'bold' })],
  }
}

/** แถวสองคอลัมน์ ป้ายซ้าย ค่าขวา */
function pair(label: string, value: string, tone: string = C.ink, bold = false) {
  return {
    type: 'box',
    layout: 'horizontal',
    margin: 'sm',
    contents: [
      text(label, { size: 'xs', color: C.muted, flex: 5 }),
      text(value, {
        size: 'xs',
        color: tone,
        weight: bold ? 'bold' : undefined,
        align: 'end',
        flex: 4,
        wrap: true,
      }),
    ],
  }
}

function divider(margin = 'md') {
  return { type: 'separator', margin, color: C.line }
}

/** หัวการ์ดสีเข้ม ใช้ซ้ำทุกใบเพื่อให้รู้ว่ามาจากชุดเดียวกัน */
function header(title: string, subtitle: string, accent: string) {
  return {
    type: 'box',
    layout: 'vertical',
    backgroundColor: accent,
    paddingAll: '16px',
    contents: [
      text(title, { color: '#ffffff', weight: 'bold', size: 'md' }),
      text(subtitle, { color: C.onDark, size: 'xxs', margin: 'xs' }),
    ],
  }
}

/** แถบสรุปผลใต้หัวการ์ด */
function verdictBar(report: SyncReport) {
  const tone = VERDICT_TONE[report.verdict]

  return {
    type: 'box',
    layout: 'horizontal',
    backgroundColor: C.tint,
    cornerRadius: '8px',
    paddingAll: '10px',
    alignItems: 'center',
    contents: [
      {
        type: 'box',
        layout: 'vertical',
        backgroundColor: tone.color,
        cornerRadius: '11px',
        width: '22px',
        height: '22px',
        flex: 0,
        justifyContent: 'center',
        contents: [
          text(tone.icon, { color: '#ffffff', size: 'sm', align: 'center', weight: 'bold' }),
        ],
      },
      {
        type: 'box',
        layout: 'vertical',
        margin: 'md',
        contents: [
          text(VERDICT_LABELS[report.verdict], { size: 'sm', weight: 'bold', color: tone.color }),
          text(report.headline, { size: 'xxs', color: C.body, wrap: true, margin: 'xs' }),
        ],
      },
    ],
  }
}

function shortName(probe: HostProbe) {
  return probe.hostname?.split('.')[0] ?? probe.host.split('.').pop() ?? probe.host
}

/**
 * กล่องหนึ่งเครื่อง — ตัวตน บทบาท และตัวเลข replication
 *
 * ใส่เฉพาะสิ่งที่ผิดปกติหรือบอกอะไรใหม่ ไม่ใส่ทุกค่าที่เก็บมาได้ — การ์ดสามเครื่อง
 * แบบใส่หมดโดนเพดาน 10 KB พอดี และแถวที่เขียนว่า "ปกติ" ทุกวันก็ไม่มีใครอ่าน
 * `commonGtid` คือค่าที่ทุกเครื่องตรงกัน ถ้ามีจะย้ายไปบอกทีเดียวท้ายการ์ดแทน
 */
function hostCard(probe: HostProbe, report: SyncReport, commonGtid: string | null) {
  const rep = probe.replication
  const gaps = report.gapsByHost[probe.host] ?? []

  const statusChip = !probe.ok
    ? chip('ต่อไม่ได้', C.bad, true)
    : gaps.length
      ? chip(`ตามหลัง ${Math.max(...gaps.map((g) => g.gap))} แถว`, C.warn, true)
      : chip('ตรงกัน', C.ok, true)

  const rows: unknown[] = [
    {
      type: 'box',
      layout: 'horizontal',
      alignItems: 'center',
      contents: [
        {
          type: 'box',
          layout: 'vertical',
          flex: 1,
          contents: [
            text(shortName(probe), { size: 'sm', weight: 'bold', color: C.ink }),
            text(probe.host, { size: 'xxs', color: C.muted, margin: 'xs' }),
          ],
        },
        statusChip,
      ],
    },
  ]

  if (!probe.ok) {
    rows.push(
      text(probe.error ?? 'ไม่ทราบสาเหตุ', { size: 'xxs', color: C.bad, wrap: true, margin: 'sm' })
    )
    return box(rows)
  }

  const badges: unknown[] = []
  if (rep) badges.push(chip(ROLE_LABELS[rep.role], C.main))
  if (probe.serverId) badges.push(chip(`id ${probe.serverId}`, C.soft))
  if (probe.readOnly === false)
    badges.push(chip('เขียนได้', rep?.writableReplica ? C.warn : C.soft))
  if (rep?.slaveRunning === false) badges.push(chip('สายรับหยุด', C.bad, true))

  if (badges.length) {
    rows.push({
      type: 'box',
      layout: 'horizontal',
      margin: 'md',
      spacing: 'xs',
      contents: badges,
    })
  }

  // GTID ที่ตรงกันทุกเครื่องย้ายไปบอกทีเดียวท้ายการ์ด ตรงนี้เหลือเฉพาะตัวที่ต่าง
  if (rep?.gtidCurrent && rep.gtidCurrent !== commonGtid) {
    rows.push(pair('GTID', rep.gtidCurrent, C.body))
  }
  if (probe.gtidLag) {
    rows.push(pair('ตามหลัง', `${probe.gtidLag.toLocaleString()} รายการ`, C.warn, true))
  }
  if (rep?.slaveRunning === false) {
    rows.push(pair('สายรับข้อมูล', 'หยุดเดิน', C.bad, true))
  }
  if (rep?.slavesConnected) {
    rows.push(pair('มีตัวตามต่ออยู่', `${rep.slavesConnected} เครื่อง`, C.body))
  }
  // นาฬิกาตรงกันคือเรื่องปกติ เขียนทุกวันก็ไม่มีใครอ่าน บอกเฉพาะตอนเริ่มเพี้ยน
  if (probe.clockSkewSeconds !== null && Math.abs(probe.clockSkewSeconds) > 30) {
    rows.push(
      pair(
        'นาฬิกาต่างจากเรา',
        `${probe.clockSkewSeconds} วิ`,
        Math.abs(probe.clockSkewSeconds) > 120 ? C.bad : C.warn,
        true
      )
    )
  }

  return box(rows)
}

function box(contents: unknown[]) {
  return {
    type: 'box',
    layout: 'vertical',
    margin: 'md',
    paddingAll: '12px',
    backgroundColor: '#ffffff',
    borderColor: C.line,
    borderWidth: '1px',
    cornerRadius: '10px',
    contents,
  }
}

/**
 * ตารางเทียบข้อมูลวันนี้ — แถวคือตาราง คอลัมน์คือเครื่อง
 *
 * ค่าที่ไม่เท่ากับเครื่องที่นำอยู่ทำสีส้ม จะได้กวาดตาหาจุดที่ต่างได้ในวินาทีเดียว
 */
function comparisonTable(report: SyncReport) {
  const up = report.hosts.filter((h) => h.ok)
  if (up.length < 2) return null

  const head = {
    type: 'box',
    layout: 'horizontal',
    contents: [
      text('ข้อมูลวันนี้', { size: 'xxs', color: C.muted, flex: 5, weight: 'bold' }),
      ...up.map((probe) =>
        text(shortName(probe), {
          size: 'xxs',
          color: C.main,
          align: 'end',
          flex: 3,
          weight: 'bold',
        })
      ),
    ],
  }

  const rows = METRICS.map((metric) => {
    const values = up.map((probe) => probe.counts[metric.key] ?? null)
    const numbers = values.filter((v): v is number => typeof v === 'number')
    const best = numbers.length ? Math.max(...numbers) : null

    return {
      type: 'box',
      layout: 'horizontal',
      margin: 'sm',
      contents: [
        text(metric.label, { size: 'xxs', color: C.body, flex: 5, wrap: true }),
        ...values.map((value) => {
          const behind = typeof value === 'number' && best !== null && value < best
          return text(value === null ? '—' : value.toLocaleString(), {
            size: 'xxs',
            color: behind ? C.warn : C.ink,
            weight: behind ? 'bold' : undefined,
            align: 'end',
            flex: 3,
          })
        }),
      ],
    }
  })

  return box([head, divider('sm'), ...rows])
}

/** ข้อสังเกตที่ไม่ถึงขั้นเตือน แต่ควรรู้ */
function notesBox(report: SyncReport) {
  const notes: string[] = []

  if (report.writableReplicas.length) {
    notes.push(
      `⚠ ${report.writableReplicas.join(', ')} เป็นตัวตามแต่ยังเขียนได้ — ` +
        `ถ้ามีใครเขียนลงเครื่องนี้ตรง ๆ แถวนั้นจะไม่ไหลกลับไปหาแหล่งหลัก`
    )
  }
  if (report.verdict === 'diverged') {
    notes.push('⚠ แต่ละเครื่องมีแถวที่อีกเครื่องไม่มี รอไปไม่หายเอง ต้องให้ DBA ตรวจ replication')
  }
  if (report.clockSpreadSeconds !== null && report.clockSpreadSeconds > 120) {
    notes.push(
      `⚠ นาฬิกาต่างกัน ${report.clockSpreadSeconds} วินาที — vn สร้างจากเวลาเครื่อง ` +
        'ต่างกันมากแล้วเลขซ้ำกันได้'
    )
  }

  if (!notes.length) return null

  return {
    type: 'box',
    layout: 'vertical',
    margin: 'md',
    paddingAll: '12px',
    backgroundColor: '#fff8ed',
    cornerRadius: '10px',
    contents: notes.map((note, index) =>
      text(note, { size: 'xxs', color: C.body, wrap: true, margin: index ? 'sm' : undefined })
    ),
  }
}

function bubble(head: unknown, body: unknown[], footer?: string) {
  return compact({
    type: 'bubble',
    size: 'mega',
    header: head,
    body: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#fbfaff',
      paddingAll: '14px',
      contents: body,
    },
    footer: footer
      ? {
          type: 'box',
          layout: 'vertical',
          backgroundColor: '#fbfaff',
          paddingAll: '12px',
          paddingTop: '0px',
          contents: [text(footer, { size: 'xxs', color: C.muted, wrap: true, align: 'center' })],
        }
      : undefined,
  })
}

/** GTID ที่ทุกเครื่องตรงกัน — ไม่ตรงกันหรือมีเครื่องต่อไม่ได้จะคืน null */
function sharedGtid(report: SyncReport) {
  const values = report.hosts.filter((h) => h.ok).map((h) => h.replication?.gtidCurrent ?? null)
  if (!values.length || values.some((v) => v === null)) return null

  return values.every((v) => v === values[0]) ? values[0] : null
}

/**
 * งบไบต์ต่อ bubble หนึ่งใบ
 *
 * เผื่อไว้จากเพดาน 10 KB สำหรับเปลือก message กับ carousel ที่จะมาห่ออีกที
 * ถ้าไม่เผื่อ ใบที่วัดแล้วพอดีเป๊ะจะไปเกินตอนถูกห่อ
 */
const BUBBLE_BUDGET = MAX_BYTES - 400

/**
 * สร้างการ์ด
 *
 * ใบแรกคือภาพรวม ตามด้วยการ์ดรายเครื่อง แล้วปิดท้ายด้วยตารางเทียบข้อมูล
 * การ์ดรายเครื่องล้นใบแรกเมื่อไรจะขึ้นใบใหม่ให้เอง — เคยเจอมาแล้วว่าสามเครื่อง
 * ที่มีปัญหาพร้อมกันทำให้ใบเดียวทะลุ 10 KB แล้วปลายทางปฏิเสธทั้งข้อความ
 */
export function buildSyncFlex(report: SyncReport, accent: string = C.main): LineMessage[] {
  const stamp = DateTime.fromISO(report.checkedAt)
    .setZone('Asia/Bangkok')
    .toFormat('dd/MM/yyyy HH:mm')

  const common = sharedGtid(report)
  const head = (suffix = '') =>
    header(`🗄 เทียบเครื่องฐานข้อมูล${suffix}`, `${stamp} · ${report.hosts.length} เครื่อง`, accent)

  const notes = notesBox(report)

  // ใบแรกได้แถบสรุปกับข้อสังเกตไปก่อน ที่เหลือค่อยเติมการ์ดเครื่องจนกว่าจะเต็ม
  const pages: unknown[][] = []
  let page: unknown[] = [verdictBar(report), ...(notes ? [notes] : [])]
  let opening = true

  for (const probe of report.hosts) {
    const card = hostCard(probe, report, common)
    const candidate = [...page, card]

    // ใบที่ยังไม่มีการ์ดเครื่องเลยต้องรับใบนี้ไปก่อน ไม่งั้นจะวนไม่จบ
    const hasCard = page.length > (opening ? (notes ? 2 : 1) : 0)
    if (hasCard && bytes(bubble(head(), candidate)) > BUBBLE_BUDGET) {
      pages.push(page)
      page = [card]
      opening = false
      continue
    }

    page = candidate
  }

  pages.push(page)

  const footer =
    common !== null
      ? `ทุกเครื่องอยู่ที่ GTID ${common}`
      : report.gtidLagMax
        ? `ตามหลังกันมากที่สุด ${report.gtidLagMax.toLocaleString()} รายการ (นับจาก GTID)`
        : undefined

  const bubbles = pages.map((contents, index) =>
    bubble(head(index ? ' (ต่อ)' : ''), contents, index === pages.length - 1 ? footer : undefined)
  )

  const table = comparisonTable(report)
  if (table) {
    bubbles.push(
      bubble(
        header('📊 ข้อมูลวันนี้', 'นับแถวจากตารางที่ใช้งานจริงแล้วเอามาเทียบ', accent),
        [table],
        'ตัวเลขสีส้ม = น้อยกว่าเครื่องที่นับได้มากที่สุด'
      )
    )
  }

  return packBubbles(bubbles.slice(0, MAX_BUBBLES), `เทียบฐานข้อมูล — ${report.headline}`)
}

/**
 * ยัด bubble ลงข้อความให้พอดีเพดาน 10 KB ต่อข้อความ
 *
 * ใบเดียวที่ยังเกินก็ยังส่งไป — ให้ปลายทางปฏิเสธแล้วขึ้นในประวัติการส่ง
 * ดีกว่าเราตัดเนื้อหาทิ้งเงียบ ๆ แล้วคนอ่านไม่รู้ว่าหายไป
 */
function packBubbles(bubbles: unknown[], altText: string): LineMessage[] {
  const messages: LineMessage[] = []
  let batch: unknown[] = []

  const flush = () => {
    if (!batch.length) return
    messages.push({
      type: 'flex',
      altText: altText.slice(0, 400),
      contents: batch.length === 1 ? batch[0] : { type: 'carousel', contents: batch },
    })
    batch = []
  }

  for (const item of bubbles) {
    const next = [...batch, item]
    const wrapped = {
      type: 'flex',
      altText,
      contents: next.length === 1 ? next[0] : { type: 'carousel', contents: next },
    }

    if (batch.length && bytes(wrapped) > MAX_BYTES) {
      flush()
      batch = [item]
      continue
    }
    batch = next
  }

  flush()

  // มีหลายข้อความแล้วบอกลำดับไว้ ไม่งั้นแจ้งเตือนจะขึ้นข้อความเดียวกันซ้ำ ๆ
  if (messages.length > 1) {
    messages.forEach((message, index) => {
      ;(message as Record<string, unknown>).altText =
        `${altText} (${index + 1}/${messages.length})`.slice(0, 400)
    })
  }

  return messages
}
