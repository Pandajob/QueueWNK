import { DateTime } from 'luxon'

import HosxpConnection from '#models/hosxp_connection'
import { DbHost } from '#models/db_sync'
import type { HostStatus } from '#models/db_sync'
import { HosxpClient } from '#services/hosxp_client'

/**
 * เทียบว่าเครื่องฐานข้อมูลหลายเครื่องมีข้อมูล "เท่ากัน" ไหม
 *
 * ทำไมไม่ใช้ `SHOW SLAVE STATUS` ซึ่งเป็นคำตอบที่ตรงกว่า — เพราะ user ที่เราใช้
 * มีแค่ `SELECT` อ่าน status ของ replication ไม่ได้ (ต้อง REPLICATION CLIENT)
 * และเราตั้งใจไม่ขอสิทธิ์เพิ่มกับฐานโรงพยาบาล จึงวัดจาก "ผลลัพธ์" แทน "กลไก"
 * คือนับแถวของวันนี้ในตารางที่ใช้งานจริงแล้วเอามาเทียบกัน
 *
 * วิธีนี้บอกได้ในสิ่งที่คนถามอยากรู้จริง ๆ ว่า "ถ้าไปดูจากเครื่องนี้จะเห็นเท่ากันไหม"
 */

/**
 * ตารางที่เอามานับ — เลือกจากที่ขยับตลอดวันและถามด้วย index ได้
 *
 * ทุกตัวยกเว้น ipt กรองด้วยช่วง `vn` ซึ่งเป็น PK (range scan ~5 ms)
 * ไม่ใช้ `date_visit`/`vstdate` เพราะไม่มี index จะกลายเป็น full scan
 * เครื่องละ 300+ ms ทุกรอบ — ดู docs/queue-detection.md
 */
type Metric = {
  key: string
  label: string
  /** ตารางที่นับ ใช้อธิบายในหน้าเว็บ */
  table: string
  sql: string
  /** true = ใช้ช่วง vn ของวันนี้เป็นพารามิเตอร์ */
  byVnRange: boolean
}

export const METRICS: Metric[] = [
  {
    key: 'vn_stat',
    label: 'ผู้รับบริการวันนี้',
    table: 'vn_stat',
    sql: `SELECT COUNT(*) AS n, MAX(vn) AS mx FROM vn_stat WHERE vn BETWEEN ? AND ?`,
    byVnRange: true,
  },
  {
    key: 'ovst',
    label: 'ทะเบียนตรวจ',
    table: 'ovst',
    sql: `SELECT COUNT(*) AS n, MAX(vn) AS mx FROM ovst WHERE vn BETWEEN ? AND ?`,
    byVnRange: true,
  },
  {
    key: 'queue',
    label: 'คิวห้องตรวจ',
    table: 'ovst_queue_server',
    sql: `SELECT COUNT(*) AS n, MAX(vn) AS mx FROM ovst_queue_server WHERE vn BETWEEN ? AND ?`,
    byVnRange: true,
  },
  {
    key: 'orders',
    label: 'รายการยา/ค่าใช้จ่าย',
    table: 'opitemrece',
    sql: `SELECT COUNT(*) AS n, MAX(vn) AS mx FROM opitemrece WHERE vn BETWEEN ? AND ?`,
    byVnRange: true,
  },
  {
    key: 'ipt',
    label: 'ผู้ป่วยในรับใหม่',
    table: 'ipt',
    sql: `SELECT COUNT(*) AS n, MAX(an) AS mx FROM ipt WHERE regdate = CURDATE()`,
    byVnRange: false,
  },
]

/** นาฬิกาห่างกันเกินนี้ถือว่าผิดปกติ — vn สร้างจากเวลาเครื่อง เพี้ยนแล้วชนกันได้ */
export const CLOCK_SKEW_WARN_SECONDS = 120

/**
 * บทบาทของเครื่องในวง replication
 *
 * เดาจากสิ่งที่ user สิทธิ์ SELECT มองเห็น: `gtid_slave_pos` ไม่ว่าง หรือ
 * `Slave_running = ON` แปลว่าเครื่องนี้รับจากคนอื่น · `Slaves_connected > 0`
 * แปลว่ามีคนรับจากเครื่องนี้
 */
export type ReplicaRole = 'source' | 'replica' | 'both' | 'standalone' | 'unknown'

export const ROLE_LABELS: Record<ReplicaRole, string> = {
  source: 'แหล่งหลัก',
  replica: 'ตัวตาม',
  both: 'ทั้งรับทั้งส่ง',
  standalone: 'เดี่ยว',
  unknown: '—',
}

export type Replication = {
  role: ReplicaRole
  /** ค่าเต็มของ gtid_current_pos เช่น `0-1-650047893` */
  gtidCurrent: string | null
  gtidSlave: string | null
  /** domain → ลำดับ transaction ล่าสุด — เอาไปเทียบข้ามเครื่องได้ตรง ๆ */
  gtidSeq: Record<string, number>
  /** สายที่รับข้อมูลเข้ามากำลังเดินอยู่ไหม (null = เครื่องนี้ไม่ได้เป็นตัวตาม) */
  slaveRunning: boolean | null
  slavesConnected: number | null
  /** > 0 = เครื่องนี้เคยมีสายรับข้อมูลต่ออยู่จริง ใช้แยกตัวตามออกจากเครื่องต้นทาง */
  receivedHeartbeats: number | null
  binlogFormat: string | null
  logSlaveUpdates: boolean | null
  uptimeSeconds: number | null
  /**
   * เป็นตัวตามแต่ยังรับการเขียนได้
   *
   * ไม่ใช่ error ของวันนี้ แต่เป็นทางที่ข้อมูลจะแยกกันในอนาคต — ใครเผลอเขียน
   * ลงตัวตามโดยตรง แถวนั้นจะไม่มีวันไหลกลับไปหาแหล่งหลัก
   */
  writableReplica: boolean
}

/**
 * แกะ `0-1-650047893,1-2-77` เป็น { '0': 650047893, '1': 77 }
 *
 * ตัวเลขกลางคือ server ที่เป็นต้นทางของ transaction ไม่ใช่ตัวเครื่องที่ตอบ
 * จึงไม่เอามาใช้ — ที่เทียบกันได้จริงคือ domain กับลำดับ
 */
export function parseGtid(pos: string | null | undefined): Record<string, number> {
  if (!pos) return {}

  const out: Record<string, number> = {}
  for (const part of pos.split(',')) {
    const [domain, , seq] = part.trim().split('-')
    const value = Number(seq)
    if (domain === undefined || !Number.isFinite(value)) continue
    out[domain] = Math.max(out[domain] ?? 0, value)
  }
  return out
}

export type HostProbe = {
  id: number | null
  label: string
  host: string
  port: number
  ok: boolean
  error: string | null
  hostname: string | null
  serverId: string | null
  readOnly: boolean | null
  logBin: boolean | null
  /** เวลาที่เครื่องนั้นบอก */
  dbNow: string | null
  /** บวก = เครื่องนั้นเดินเร็วกว่าเรา */
  clockSkewSeconds: number | null
  durationMs: number | null
  /** key ของ METRICS → จำนวนแถว */
  counts: Record<string, number | null>
  /** key ของ METRICS → ค่าสูงสุด (vn หรือ an) */
  latest: Record<string, string | null>
  replication: Replication | null
  /** ตามหลังเครื่องที่นำอยู่กี่ transaction (null = เทียบไม่ได้) */
  gtidLag: number | null
  status: HostStatus
}

export type MetricGap = {
  metric: string
  label: string
  best: number
  value: number
  gap: number
}

export type SyncVerdict = 'ok' | 'lagging' | 'diverged' | 'unreachable' | 'no_data'

export const VERDICT_LABELS: Record<SyncVerdict, string> = {
  ok: 'ทุกเครื่องตรงกัน',
  lagging: 'มีเครื่องตามหลัง',
  diverged: 'ข้อมูลแยกทางกัน',
  unreachable: 'มีเครื่องต่อไม่ได้',
  no_data: 'ยังไม่มีข้อมูล',
}

export type SyncReport = {
  checkedAt: string
  hosts: HostProbe[]
  verdict: SyncVerdict
  /** สรุปหนึ่งบรรทัด อ่านแล้วรู้เรื่องโดยไม่ต้องดูตาราง */
  headline: string
  /** เครื่องไหนตามหลังตารางไหนเท่าไร */
  gapsByHost: Record<string, MetricGap[]>
  /** ช่วงเวลาที่ห่างกันจาก vn ล่าสุด */
  lagSeconds: number | null
  /** นาฬิกาห่างกันมากที่สุดกี่วินาที */
  clockSpreadSeconds: number | null
  /** ตามหลังกันมากที่สุดกี่ transaction */
  gtidLagMax: number | null
  /** เครื่องที่ตั้งเป็นตัวตามไว้แต่สายรับข้อมูลหยุดเดิน */
  stoppedReplicas: string[]
  /** เครื่องที่เป็นตัวตามแต่ยังเขียนได้ — ไม่ใช่ error วันนี้ แต่เป็นความเสี่ยง */
  writableReplicas: string[]
  /** true = ควรบอกทีมงาน */
  shouldAlert: boolean
  /** ใช้เทียบว่า "ปัญหาเดิมหรือปัญหาใหม่" ตอนคุม throttle */
  signature: string
}

export type SyncThresholds = {
  lagWarnSeconds: number
  rowGapWarn: number
  /** ตามหลังกี่ transaction ถึงจะเตือน */
  gtidLagWarn: number
}

/** vn/an เป็น YYMMDDHHMMSS — เอาส่วนเวลามาเทียบกันเป็นวินาที */
export function vnGapSeconds(older: string, newer: string) {
  const toSeconds = (vn: string) => {
    const time = vn.slice(6)
    if (time.length !== 6) return null
    const h = Number(time.slice(0, 2))
    const m = Number(time.slice(2, 4))
    const s = Number(time.slice(4, 6))
    return Number.isNaN(h + m + s) ? null : h * 3600 + m * 60 + s
  }

  const a = toSeconds(older)
  const b = toSeconds(newer)
  return a === null || b === null ? null : b - a
}

/** ช่วง vn ของวันนี้ — ปีเป็น พ.ศ. สองหลักท้าย */
export function vnRangeToday(now = DateTime.now().setZone('Asia/Bangkok')) {
  const prefix = `${String((now.year + 543) % 100).padStart(2, '0')}${now.toFormat('MMdd')}`
  return [`${prefix}000000`, `${prefix}999999`] as const
}

type Credentials = {
  database: string
  username: string
  password: string
  charset: string
}

/**
 * อ่านสถานะ replication เท่าที่ user สิทธิ์ SELECT มองเห็น
 *
 * `SHOW SLAVE STATUS` ต้องมี REPLICATION CLIENT ซึ่งเราไม่ขอ แต่ตัวเลขที่สำคัญที่สุด
 * อยู่ในที่ที่อ่านได้อยู่แล้ว — `@@gtid_current_pos` บอกว่าเครื่องนี้ทำ transaction
 * ถึงลำดับไหน เอาไปลบกันข้ามเครื่องได้ตรง ๆ ว่า "ตามหลังกี่รายการ"
 * แม่นกว่าการนับแถวมาก เพราะนับแถวบอกได้แค่ตารางที่เรานึกออกว่าจะนับ
 *
 * `SHOW GLOBAL STATUS` ก็ไม่ต้องใช้สิทธิ์พิเศษ จึงรู้ได้ว่าสายรับข้อมูลยังเดินอยู่ไหม
 */
async function readReplication(
  client: HosxpClient,
  vars: { readOnly: boolean | null; binlogFormat: string | null; logSlaveUpdates: boolean | null }
): Promise<Replication> {
  const [pos] = await client.select<{
    current_pos: string | null
    slave_pos: string | null
  }>(`SELECT @@global.gtid_current_pos AS current_pos, @@global.gtid_slave_pos AS slave_pos`)

  const status = await client.select<{ Variable_name: string; Value: string }>(
    `SHOW GLOBAL STATUS WHERE Variable_name IN
       ('Slave_running','Slaves_connected','Slave_received_heartbeats','Uptime')`
  )
  const stat = (name: string) => status.find((s) => s.Variable_name === name)?.Value ?? null
  const num = (name: string) => (stat(name) === null ? null : Number(stat(name)))

  const slavePos = pos?.slave_pos || null
  const slaveRunningRaw = stat('Slave_running')
  const slavesConnected = num('Slaves_connected')
  const heartbeats = num('Slave_received_heartbeats')

  /**
   * เป็นตัวตามจริงหรือเปล่า
   *
   * ครั้งแรกใช้ `gtid_slave_pos` ไม่ว่างเป็นเกณฑ์ แล้วเจอว่าเครื่องต้นทางก็มีค่านี้
   * (ตัวแปรค้างอยู่จาก topology เดิม และ `log_slave_updates` พาลำดับวิ่งไปทั่ว)
   * เลยไปเตือนว่า "replication หยุด" ที่เครื่องต้นทางซึ่งไม่เคยมีสายรับตั้งแต่แรก
   *
   * `Slave_received_heartbeats` ตรงกว่า — นับเฉพาะตอนที่มีสายรับข้อมูลต่ออยู่จริง
   * เครื่องต้นทางจะเป็น 0 ตลอด ส่วนตัวตามที่เพิ่งหยุดจะยังค้างค่าเดิมไว้
   * จึงแยกออกได้ว่า "ไม่เคยเป็นตัวตาม" กับ "เป็นตัวตามแต่หยุดไปแล้ว"
   */
  const isReplica = slaveRunningRaw === 'ON' || (heartbeats ?? 0) > 0
  const hasReplicas = (slavesConnected ?? 0) > 0

  const role: ReplicaRole = isReplica
    ? hasReplicas
      ? 'both'
      : 'replica'
    : hasReplicas
      ? 'source'
      : 'standalone'

  return {
    role,
    gtidCurrent: pos?.current_pos || null,
    gtidSlave: slavePos,
    gtidSeq: parseGtid(pos?.current_pos),
    slaveRunning: isReplica ? slaveRunningRaw === 'ON' : null,
    slavesConnected,
    receivedHeartbeats: heartbeats,
    binlogFormat: vars.binlogFormat,
    logSlaveUpdates: vars.logSlaveUpdates,
    uptimeSeconds: num('Uptime'),
    writableReplica: isReplica && vars.readOnly === false,
  }
}

/**
 * ต่อเครื่องหนึ่งแล้วเก็บตัวเลขมา
 *
 * ไม่ throw — เครื่องต่อไม่ได้คือ "ผลการตรวจ" อย่างหนึ่ง ไม่ใช่ข้อผิดพลาดของเรา
 */
export async function probeHost(
  target: {
    id: number | null
    label: string
    host: string
    port: number
    username?: string | null
    password?: string | null
  },
  shared: Credentials,
  now = DateTime.now().setZone('Asia/Bangkok')
): Promise<HostProbe> {
  const probe: HostProbe = {
    id: target.id,
    label: target.label,
    host: target.host,
    port: target.port,
    ok: false,
    error: null,
    hostname: null,
    serverId: null,
    readOnly: null,
    logBin: null,
    dbNow: null,
    clockSkewSeconds: null,
    durationMs: null,
    counts: {},
    latest: {},
    replication: null,
    gtidLag: null,
    status: 'unreachable',
  }

  const started = Date.now()
  let client: HosxpClient | null = null

  try {
    client = await HosxpClient.connect({
      host: target.host,
      port: target.port,
      database: shared.database,
      username: target.username || shared.username,
      password: target.password || shared.password,
      charset: shared.charset,
    })
  } catch (error) {
    probe.error = `${error.code ?? ''} ${error.message}`.trim()
    probe.durationMs = Date.now() - started
    return probe
  }

  try {
    const vars = await client.select<{ Variable_name: string; Value: string }>(
      `SHOW VARIABLES WHERE Variable_name IN
         ('hostname','server_id','read_only','log_bin','binlog_format','log_slave_updates')`
    )
    const get = (name: string) => vars.find((v) => v.Variable_name === name)?.Value ?? null
    const onOff = (name: string) => (get(name) === null ? null : get(name) === 'ON')

    probe.hostname = get('hostname')
    probe.serverId = get('server_id')
    probe.readOnly = onOff('read_only')
    probe.logBin = onOff('log_bin')

    probe.replication = await readReplication(client, {
      readOnly: probe.readOnly,
      binlogFormat: get('binlog_format'),
      logSlaveUpdates: onOff('log_slave_updates'),
    })

    const [clock] = await client.select<{ db_now: string }>(`SELECT NOW() AS db_now`)
    probe.dbNow = clock?.db_now ?? null
    if (probe.dbNow) {
      const theirs = DateTime.fromSQL(probe.dbNow, { zone: 'Asia/Bangkok' })
      if (theirs.isValid) probe.clockSkewSeconds = Math.round(theirs.diff(now, 'seconds').seconds)
    }

    const range = vnRangeToday(now)
    for (const metric of METRICS) {
      const [row] = await client.select<{ n: number; mx: string | null }>(
        metric.sql,
        metric.byVnRange ? [...range] : []
      )
      probe.counts[metric.key] = row ? Number(row.n) : null
      probe.latest[metric.key] = row?.mx ? String(row.mx) : null
    }

    probe.ok = true
    probe.status = 'ok'
  } catch (error) {
    probe.error = String(error?.message ?? error).slice(0, 400)
  } finally {
    await client.close()
  }

  probe.durationMs = Date.now() - started
  return probe
}

/**
 * ตัดสินจากตัวเลขที่เก็บมา
 *
 * "ตามหลัง" กับ "แยกทาง" ไม่เหมือนกัน — ตามหลังคือเครื่องหนึ่งน้อยกว่าทุกตาราง
 * เดี๋ยว replication ตามมาก็หาย แต่แยกทางคือเครื่อง A มากกว่าในตารางหนึ่ง
 * ส่วนเครื่อง B มากกว่าในอีกตารางหนึ่ง แปลว่ามีคนเขียนคนละที่แล้วไม่ไหลถึงกัน
 * ซึ่งรอไปก็ไม่หายเอง ต้องให้ DBA เข้ามาดู
 */
export function compareProbes(probes: HostProbe[], thresholds: SyncThresholds): SyncReport {
  const checkedAt = DateTime.now().setZone('Asia/Bangkok').toISO()!
  const usable = probes.filter((p) => p.ok)
  const unreachable = probes.filter((p) => !p.ok)

  const base: SyncReport = {
    checkedAt,
    hosts: probes,
    verdict: 'no_data',
    headline: 'ยังไม่มีเครื่องให้ตรวจ',
    gapsByHost: {},
    lagSeconds: null,
    clockSpreadSeconds: null,
    gtidLagMax: null,
    stoppedReplicas: [],
    writableReplicas: [],
    shouldAlert: false,
    signature: 'no_data',
  }

  if (!probes.length) return base

  if (!usable.length) {
    return {
      ...base,
      verdict: 'unreachable',
      headline: `ต่อไม่ได้ทั้ง ${probes.length} เครื่อง`,
      shouldAlert: true,
      signature: `unreachable:${unreachable
        .map((p) => p.host)
        .sort()
        .join(',')}`,
    }
  }

  // --- ส่วนต่างรายตาราง ------------------------------------------------------
  const gapsByHost: Record<string, MetricGap[]> = {}
  const leadersByMetric: Record<string, string[]> = {}

  for (const metric of METRICS) {
    const values = usable
      .map((p) => ({ host: p.host, value: p.counts[metric.key] }))
      .filter((v): v is { host: string; value: number } => typeof v.value === 'number')

    if (values.length < 2) continue

    const best = Math.max(...values.map((v) => v.value))
    leadersByMetric[metric.key] = values.filter((v) => v.value === best).map((v) => v.host)

    for (const item of values) {
      if (item.value === best) continue
      gapsByHost[item.host] = [
        ...(gapsByHost[item.host] ?? []),
        {
          metric: metric.key,
          label: metric.label,
          best,
          value: item.value,
          gap: best - item.value,
        },
      ]
    }
  }

  // แยกทาง = มีอย่างน้อยสองเครื่องที่ต่างก็เป็นผู้นำในตารางที่อีกฝ่ายตามหลัง
  const behindHosts = Object.keys(gapsByHost)
  const diverged = behindHosts.some((host) =>
    Object.values(leadersByMetric).some((leaders) => leaders.length === 1 && leaders[0] === host)
  )

  // --- ความห่างเชิงเวลา ------------------------------------------------------
  let lagSeconds: number | null = null
  for (const metric of METRICS) {
    if (!metric.byVnRange) continue

    const stamps = usable
      .map((p) => p.latest[metric.key])
      .filter((v): v is string => typeof v === 'string' && v.length === 12)

    if (stamps.length < 2) continue

    const newest = stamps.reduce((a, b) => (a > b ? a : b))
    const oldest = stamps.reduce((a, b) => (a < b ? a : b))
    const gap = vnGapSeconds(oldest, newest)
    if (gap !== null && (lagSeconds === null || gap > lagSeconds)) lagSeconds = gap
  }

  // --- นาฬิกา ----------------------------------------------------------------
  const skews = usable
    .map((p) => p.clockSkewSeconds)
    .filter((v): v is number => typeof v === 'number')
  const clockSpreadSeconds = skews.length > 1 ? Math.max(...skews) - Math.min(...skews) : null

  // --- replication -----------------------------------------------------------
  // เทียบ GTID ทีละ domain — เครื่องที่ตามหลัง domain ไหนก็ตามถือว่าตามหลังเท่านั้น
  const domains = new Set(usable.flatMap((p) => Object.keys(p.replication?.gtidSeq ?? {})))

  for (const probe of usable) probe.gtidLag = null

  for (const domain of domains) {
    const seen = usable
      .map((p) => ({ probe: p, seq: p.replication?.gtidSeq[domain] }))
      .filter((v): v is { probe: HostProbe; seq: number } => typeof v.seq === 'number')

    if (seen.length < 2) continue

    const best = Math.max(...seen.map((v) => v.seq))
    for (const { probe, seq } of seen) {
      const lag = best - seq
      if (probe.gtidLag === null || lag > probe.gtidLag) probe.gtidLag = lag
    }
  }

  const gtidLags = usable.map((p) => p.gtidLag).filter((v): v is number => typeof v === 'number')
  const gtidLagMax = gtidLags.length ? Math.max(...gtidLags) : null

  // ตั้งเป็นตัวตามไว้แต่สายรับข้อมูลหยุด — นี่คือทางที่ข้อมูลแยกกันแบบเงียบ ๆ
  const stoppedReplicas = usable
    .filter((p) => p.replication?.slaveRunning === false)
    .map((p) => p.host)

  const writableReplicas = usable.filter((p) => p.replication?.writableReplica).map((p) => p.host)

  // --- ปักธงสถานะรายเครื่อง --------------------------------------------------
  for (const probe of probes) {
    if (!probe.ok) {
      probe.status = 'unreachable'
      continue
    }
    probe.status = gapsByHost[probe.host]?.length ? 'behind' : 'ok'
  }

  const maxGap = Math.max(
    0,
    ...Object.values(gapsByHost)
      .flat()
      .map((g) => g.gap)
  )

  const verdict: SyncVerdict = unreachable.length
    ? 'unreachable'
    : diverged
      ? 'diverged'
      : behindHosts.length
        ? 'lagging'
        : 'ok'

  const shouldAlert =
    unreachable.length > 0 ||
    diverged ||
    stoppedReplicas.length > 0 ||
    maxGap > thresholds.rowGapWarn ||
    (gtidLagMax !== null && gtidLagMax > thresholds.gtidLagWarn) ||
    (lagSeconds !== null && lagSeconds > thresholds.lagWarnSeconds) ||
    (clockSpreadSeconds !== null && clockSpreadSeconds > CLOCK_SKEW_WARN_SECONDS)

  const headline = (() => {
    if (unreachable.length) {
      return `ต่อไม่ได้ ${unreachable.length} เครื่อง (${unreachable.map((p) => p.host).join(', ')})`
    }
    if (stoppedReplicas.length) {
      return `replication หยุดเดินที่ ${stoppedReplicas.join(', ')}`
    }
    if (diverged) return 'ข้อมูลแยกทางกัน — คนละเครื่องมีของที่อีกเครื่องไม่มี'
    if (behindHosts.length) {
      return (
        `มีเครื่องตามหลัง ${maxGap} แถว` + (lagSeconds ? ` · ห่างกัน ${lagSeconds} วินาที` : '')
      )
    }
    if (gtidLagMax !== null && gtidLagMax > thresholds.gtidLagWarn) {
      return `ข้อมูลวันนี้เท่ากัน แต่ตามหลัง ${gtidLagMax.toLocaleString()} รายการ`
    }
    return `ทุกเครื่อง (${usable.length}) มีข้อมูลตรงกัน`
  })()

  return {
    checkedAt,
    hosts: probes,
    verdict,
    headline,
    gapsByHost,
    lagSeconds,
    clockSpreadSeconds,
    gtidLagMax,
    stoppedReplicas,
    writableReplicas,
    shouldAlert,
    // ปัญหาคนละเรื่องต้องแจ้งได้ทันทีแม้เพิ่งแจ้งเรื่องก่อนไป จึงใส่ทั้งชนิดและตัวเครื่อง
    signature: [
      verdict,
      unreachable
        .map((p) => p.host)
        .sort()
        .join(','),
      behindHosts.sort().join(','),
      stoppedReplicas.slice().sort().join(','),
    ].join('|'),
  }
}

/** โหลดเครื่องที่เปิดเฝ้าไว้แล้วตรวจทั้งชุด */
export async function runSyncCheck(thresholds: SyncThresholds): Promise<SyncReport | null> {
  const settings = await HosxpConnection.active()
  if (!settings?.password) return null

  const shared: Credentials = {
    database: settings.database,
    username: settings.username,
    password: settings.password,
    charset: settings.charset,
  }

  const hosts = await DbHost.ordered().where('is_enabled', true)

  const now = DateTime.now().setZone('Asia/Bangkok')
  const probes: HostProbe[] = []

  // ต่อทีละเครื่อง ไม่ขนานกัน — งานนี้ไม่รีบ และการยิงพร้อมกันทำให้
  // ตัวเลข "ห่างกันกี่วินาที" อ่านยากขึ้นโดยไม่ได้อะไรกลับมา
  for (const host of hosts) {
    probes.push(
      await probeHost(
        {
          id: host.id,
          label: host.label,
          host: host.host,
          port: host.port,
          username: host.username,
          password: host.password,
        },
        shared,
        now
      )
    )
  }

  const report = compareProbes(probes, thresholds)

  // จำผลไว้ที่แถวของเครื่อง หน้าเว็บจะได้บอกสถานะได้แม้ยังไม่ได้กดตรวจ
  for (const host of hosts) {
    const probe = report.hosts.find((p) => p.id === host.id)
    if (!probe) continue

    host.lastCheckedAt = DateTime.now()
    host.lastStatus = probe.status
    host.lastNote = probe.ok
      ? (report.gapsByHost[probe.host] ?? [])
          .map((g) => `${g.label} ตามหลัง ${g.gap}`)
          .join(' · ') || 'ตรงกับเครื่องอื่น'
      : probe.error
    await host.save()
  }

  return report
}
