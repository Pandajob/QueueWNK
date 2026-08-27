import { test } from '@japa/runner'
import { DateTime } from 'luxon'

import { compareProbes, vnGapSeconds, vnRangeToday, METRICS } from '#services/db_sync_checker'
import { parseGtid } from '#services/db_sync_checker'
import type { HostProbe, Replication } from '#services/db_sync_checker'
import { buildSyncFlex } from '#services/db_sync_flex'
import { buildSyncMessage } from '#services/db_sync_watcher'
import { dbSyncValidator } from '#validators/notify'

const THRESHOLDS = { lagWarnSeconds: 60, rowGapWarn: 5, gtidLagWarn: 2000 }

/** ค่าตั้งต้นของเครื่องที่ replication ปกติดี */
function replication(overrides: Partial<Replication> = {}): Replication {
  return {
    role: 'replica',
    gtidCurrent: '0-1-1000',
    gtidSlave: '0-1-1000',
    gtidSeq: { '0': 1000 },
    slaveRunning: true,
    slavesConnected: 0,
    receivedHeartbeats: 42,
    binlogFormat: 'ROW',
    logSlaveUpdates: true,
    uptimeSeconds: 1000,
    writableReplica: false,
    ...overrides,
  }
}

/** เครื่องที่ตอบครบทุกตารางด้วยตัวเลขที่กำหนด */
function probe(host: string, counts: Partial<Record<string, number>>, extra: Partial<HostProbe> = {}) {
  const filled: Record<string, number | null> = {}
  const latest: Record<string, string | null> = {}

  for (const metric of METRICS) {
    filled[metric.key] = counts[metric.key] ?? 0
    latest[metric.key] = '690805120000'
  }

  return {
    id: null,
    label: host,
    host,
    port: 3306,
    ok: true,
    error: null,
    hostname: host,
    serverId: '1',
    readOnly: false,
    logBin: true,
    dbNow: '2026-08-05 12:00:00',
    clockSkewSeconds: 0,
    durationMs: 10,
    counts: filled,
    latest,
    replication: replication(),
    gtidLag: null,
    status: 'ok',
    ...extra,
  } satisfies HostProbe as HostProbe
}

function down(host: string, error = 'Access denied') {
  return {
    ...probe(host, {}),
    ok: false,
    error,
    hostname: null,
    serverId: null,
    readOnly: null,
    logBin: null,
    dbNow: null,
    clockSkewSeconds: null,
    counts: {},
    latest: {},
    replication: null,
    gtidLag: null,
    status: 'unreachable',
  } satisfies HostProbe as HostProbe
}

const same = { vn_stat: 392, ovst: 392, queue: 316, orders: 2655, ipt: 12 }

test.group('เทียบเครื่องฐานข้อมูล', () => {
  test('ตัวเลขเท่ากันทุกตาราง = ตรงกัน ไม่ต้องเตือน', ({ assert }) => {
    const report = compareProbes([probe('a', same), probe('b', same)], THRESHOLDS)

    assert.equal(report.verdict, 'ok')
    assert.isFalse(report.shouldAlert)
    assert.deepEqual(report.gapsByHost, {})
    assert.equal(report.hosts[0].status, 'ok')
  })

  test('เครื่องเดียวก็ไม่มีอะไรให้เทียบ ถือว่าปกติ', ({ assert }) => {
    const report = compareProbes([probe('a', same)], THRESHOLDS)

    assert.equal(report.verdict, 'ok')
    assert.isFalse(report.shouldAlert)
  })

  test('ตามหลังนิดเดียวยังไม่เตือน แต่บอกว่าตามหลัง', ({ assert }) => {
    const report = compareProbes(
      [probe('a', same), probe('b', { ...same, queue: 314 })],
      THRESHOLDS
    )

    assert.equal(report.verdict, 'lagging')
    assert.isFalse(report.shouldAlert, 'ต่างกัน 2 แถว ต่ำกว่าเกณฑ์ 5')
    assert.equal(report.gapsByHost.b[0].gap, 2)
    assert.equal(report.hosts[1].status, 'behind')
  })

  test('ตามหลังเกินเกณฑ์แล้วเตือน', ({ assert }) => {
    const report = compareProbes(
      [probe('a', same), probe('b', { ...same, queue: 300 })],
      THRESHOLDS
    )

    assert.equal(report.verdict, 'lagging')
    assert.isTrue(report.shouldAlert)
  })

  test('ต่างคนต่างมีของที่อีกฝ่ายไม่มี = แยกทางกัน เตือนทันทีแม้ส่วนต่างเล็ก', ({ assert }) => {
    // a นำตาราง vn_stat · b นำตาราง orders — รอไปก็ไม่หายเอง
    const report = compareProbes(
      [probe('a', { ...same, orders: 2650 }), probe('b', { ...same, vn_stat: 390 })],
      { lagWarnSeconds: 60, rowGapWarn: 1000, gtidLagWarn: 2000 }
    )

    assert.equal(report.verdict, 'diverged')
    assert.isTrue(report.shouldAlert, 'แยกทางกันต้องเตือนไม่ว่าเกณฑ์จะหลวมแค่ไหน')
  })

  test('ต่อไม่ได้แม้เครื่องเดียวก็เตือน', ({ assert }) => {
    const report = compareProbes([probe('a', same), down('c')], THRESHOLDS)

    assert.equal(report.verdict, 'unreachable')
    assert.isTrue(report.shouldAlert)
    assert.include(report.headline, 'c')
  })

  test('ต่อไม่ได้ทุกเครื่อง', ({ assert }) => {
    const report = compareProbes([down('a'), down('b')], THRESHOLDS)

    assert.equal(report.verdict, 'unreachable')
    assert.isTrue(report.shouldAlert)
  })

  test('ไม่มีเครื่องเลย = ไม่มีข้อมูล ไม่ใช่ปัญหา', ({ assert }) => {
    const report = compareProbes([], THRESHOLDS)

    assert.equal(report.verdict, 'no_data')
    assert.isFalse(report.shouldAlert)
  })

  test('นาฬิกาต่างกันมากก็เตือน แม้ข้อมูลตรงกัน', ({ assert }) => {
    const report = compareProbes(
      [probe('a', same, { clockSkewSeconds: 0 }), probe('b', same, { clockSkewSeconds: 400 })],
      THRESHOLDS
    )

    assert.equal(report.verdict, 'ok', 'ข้อมูลยังตรงกันอยู่')
    assert.isTrue(report.shouldAlert, 'แต่นาฬิกาเพี้ยนต้องบอก')
    assert.equal(report.clockSpreadSeconds, 400)
  })

  test('รายการล่าสุดห่างกันเกินเกณฑ์ก็เตือน', ({ assert }) => {
    const a = probe('a', same)
    const b = probe('b', same)
    b.latest.queue = '690805115500' // เก่ากว่า 5 นาที

    const report = compareProbes([a, b], THRESHOLDS)

    assert.equal(report.lagSeconds, 300)
    assert.isTrue(report.shouldAlert)
  })

  test('อาการต่างกันได้ signature ต่างกัน — throttle จะได้ไม่กลืนเรื่องใหม่', ({ assert }) => {
    const lagging = compareProbes(
      [probe('a', same), probe('b', { ...same, queue: 200 })],
      THRESHOLDS
    )
    const offline = compareProbes([probe('a', same), down('b')], THRESHOLDS)

    assert.notEqual(lagging.signature, offline.signature)
  })
})

test.group('replication', () => {
  test('แกะ GTID เป็น domain → ลำดับ', ({ assert }) => {
    assert.deepEqual(parseGtid('0-1-650047893'), { '0': 650047893 })
    assert.deepEqual(parseGtid('0-1-100,1-2-77'), { '0': 100, '1': 77 })
  })

  test('GTID ว่างหรือพังไม่ทำให้ระเบิด', ({ assert }) => {
    assert.deepEqual(parseGtid(null), {})
    assert.deepEqual(parseGtid(''), {})
    assert.deepEqual(parseGtid('ขยะ'), {})
  })

  test('คิดว่าตามหลังกี่ transaction จาก GTID', ({ assert }) => {
    const a = probe('a', same, { replication: replication({ gtidSeq: { '0': 1000 } }) })
    const b = probe('b', same, { replication: replication({ gtidSeq: { '0': 940 } }) })

    const report = compareProbes([a, b], THRESHOLDS)

    assert.equal(report.hosts[0].gtidLag, 0)
    assert.equal(report.hosts[1].gtidLag, 60)
    assert.equal(report.gtidLagMax, 60)
    assert.isFalse(report.shouldAlert, '60 รายการ ต่ำกว่าเกณฑ์ 2000')
  })

  test('ตามหลังเกินเกณฑ์ก็เตือน แม้จำนวนแถววันนี้เท่ากัน', ({ assert }) => {
    const report = compareProbes(
      [
        probe('a', same, { replication: replication({ gtidSeq: { '0': 900000 } }) }),
        probe('b', same, { replication: replication({ gtidSeq: { '0': 800000 } }) }),
      ],
      THRESHOLDS
    )

    assert.equal(report.verdict, 'ok', 'ตารางวันนี้ยังเท่ากัน')
    assert.isTrue(report.shouldAlert)
    assert.include(report.headline, 'ตามหลัง')
  })

  test('เทียบแยกราย domain ไม่เอาลำดับข้าม domain มาลบกัน', ({ assert }) => {
    const report = compareProbes(
      [
        probe('a', same, { replication: replication({ gtidSeq: { '0': 100, '1': 5 } }) }),
        probe('b', same, { replication: replication({ gtidSeq: { '0': 100, '1': 5 } }) }),
      ],
      THRESHOLDS
    )

    assert.equal(report.gtidLagMax, 0)
  })

  test('สายรับข้อมูลหยุด = เตือนทันทีไม่สนเกณฑ์', ({ assert }) => {
    const report = compareProbes(
      [
        probe('a', same, { replication: replication({ role: 'source', slaveRunning: null }) }),
        probe('b', same, { replication: replication({ slaveRunning: false }) }),
      ],
      { lagWarnSeconds: 99999, rowGapWarn: 99999, gtidLagWarn: 99999 }
    )

    assert.deepEqual(report.stoppedReplicas, ['b'])
    assert.isTrue(report.shouldAlert)
    assert.include(report.headline, 'replication หยุดเดิน')
  })

  test('ตัวตามที่ยังเขียนได้ = บอกไว้ แต่ไม่ปลุกทีมงาน', ({ assert }) => {
    // เป็นความเสี่ยงเชิงตั้งค่า ไม่ใช่เหตุการณ์ — เตือนทุกรอบก็มีแต่จะถูกมองข้าม
    const report = compareProbes(
      [
        probe('a', same, { replication: replication({ role: 'source', slaveRunning: null }) }),
        probe('b', same, { replication: replication({ writableReplica: true }) }),
      ],
      THRESHOLDS
    )

    assert.deepEqual(report.writableReplicas, ['b'])
    assert.isFalse(report.shouldAlert)
  })

  test('สายรับหยุดทำให้ signature ต่างจากตอนปกติ', ({ assert }) => {
    const healthy = compareProbes([probe('a', same), probe('b', same)], THRESHOLDS)
    const stopped = compareProbes(
      [probe('a', same), probe('b', same, { replication: replication({ slaveRunning: false }) })],
      THRESHOLDS
    )

    assert.notEqual(healthy.signature, stopped.signature)
  })
})

test.group('การ์ดฐานข้อมูล', () => {
  test('ได้ข้อความ flex ที่ไม่เกินเพดาน 10 KB', ({ assert }) => {
    const report = compareProbes(
      [probe('a', same), probe('b', { ...same, queue: 300 }), down('c')],
      THRESHOLDS
    )
    const messages = buildSyncFlex(report)

    assert.isAbove(messages.length, 0)
    for (const message of messages) {
      const size = Buffer.byteLength(JSON.stringify(message), 'utf8')
      assert.isBelow(size, 10 * 1024, `การ์ดใหญ่เกินไป ${size} ไบต์`)
      assert.equal((message as Record<string, unknown>).type, 'flex')
    }
  })

  test('contents ต้องเป็น object ไม่ใช่ string — ปลายทางดร็อปเงียบถ้าส่งเป็น string', ({ assert }) => {
    const report = compareProbes([probe('a', same), probe('b', same)], THRESHOLDS)

    for (const message of buildSyncFlex(report)) {
      assert.isObject((message as Record<string, unknown>).contents)
    }
  })

  test('altText บอกผลตรวจ คนที่ปิดการแสดงการ์ดยังรู้เรื่อง', ({ assert }) => {
    const report = compareProbes([probe('a', same), down('c')], THRESHOLDS)
    const alt = (buildSyncFlex(report)[0] as Record<string, unknown>).altText as string

    assert.include(alt, 'ต่อไม่ได้')
  })

  test('เครื่องเยอะและมีปัญหาพร้อมกัน การ์ดต้องแตกใบเอง ไม่ทะลุเพดาน', ({ assert }) => {
    // เคสจริงที่เคยพัง — สามเครื่องใส่รายละเอียดครบทำให้ใบเดียว 10,388 ไบต์
    const many = Array.from({ length: 6 }, (_, i) =>
      probe(`เครื่องที่ยาวมากเพื่อกินที่หมายเลข-${i}.hospital.local`, { ...same, queue: 300 - i }, {
        clockSkewSeconds: 400,
        replication: replication({
          gtidCurrent: `0-${i}-65004789${i}`,
          gtidSeq: { '0': 650047890 - i * 1000 },
          slaveRunning: false,
          writableReplica: true,
          slavesConnected: 2,
        }),
      })
    )

    const messages = buildSyncFlex(compareProbes(many, THRESHOLDS))

    assert.isAbove(messages.length, 0)
    for (const message of messages) {
      const size = Buffer.byteLength(JSON.stringify(message), 'utf8')
      assert.isBelow(size, 10 * 1024, `ข้อความใหญ่เกินไป ${size} ไบต์`)
    }
  })

  test('GTID ที่ตรงกันทุกเครื่องบอกทีเดียว ไม่ซ้ำทุกกล่อง', ({ assert }) => {
    const report = compareProbes([probe('a', same), probe('b', same), probe('c', same)], THRESHOLDS)
    const json = JSON.stringify(buildSyncFlex(report))

    assert.equal(json.split('0-1-1000').length - 1, 1, 'GTID เดียวกันไม่ควรโผล่ซ้ำ')
  })

  test('เครื่องเดียวไม่ต้องมีใบตารางเทียบ', ({ assert }) => {
    const one = buildSyncFlex(compareProbes([probe('a', same)], THRESHOLDS))
    const two = buildSyncFlex(compareProbes([probe('a', same), probe('b', same)], THRESHOLDS))

    assert.isBelow(JSON.stringify(one).length, JSON.stringify(two).length)
  })
})

test.group('vn', () => {
  test('แปลงส่วนเวลาของ vn มาเทียบกันเป็นวินาที', ({ assert }) => {
    assert.equal(vnGapSeconds('690805120000', '690805120030'), 30)
    assert.equal(vnGapSeconds('690805120000', '690805130000'), 3600)
    assert.equal(vnGapSeconds('690805120000', '690805120000'), 0)
  })

  test('vn ที่สั้นเกินไปคืน null ไม่ใช่ตัวเลขมั่ว', ({ assert }) => {
    assert.isNull(vnGapSeconds('6908', '690805120000'))
  })

  test('ช่วง vn ของวันนี้เป็นปี พ.ศ. สองหลักท้าย', ({ assert }) => {
    const [from, to] = vnRangeToday(DateTime.fromISO('2026-08-05T10:00:00', { zone: 'Asia/Bangkok' }))

    assert.equal(from, '690805000000')
    assert.equal(to, '690805999999')
  })
})

/**
 * ฟอร์มส่งมาเป็น string ทั้งหมด และ bodyparser ตั้งไว้ว่า
 * `convertEmptyStringsToNull` — ช่องที่ผู้ใช้ไม่กรอกจะมาถึงเป็น null ไม่ใช่ ''
 * เทสต์ชุดนี้จำลองรูปร่างนั้นให้ตรง เพราะเป็นจุดที่ validator หลุดได้ง่ายที่สุด
 */
test.group('ฟอร์มเทียบเครื่องฐานข้อมูล', () => {
  const base = {
    isEnabled: '1',
    groupId: '5',
    checkEveryMinutes: '10',
    lagWarnSeconds: '60',
    rowGapWarn: '5',
    gtidLagWarn: '2000',
    throttleMinutes: '30',
    notifyOnRecover: '1',
    messageStyle: 'digest',
    cardColor: '#6d28d9',
  }

  test('แถวที่กรอกครบผ่านและแปลงเป็นตัวเลขให้', async ({ assert }) => {
    const data = await dbSyncValidator.validate({
      ...base,
      digestAt: '08:00',
      hosts: [{ id: '2', label: 'หลัก', host: '192.0.2.12', port: '3306', enabled: '1' }],
    })

    assert.equal(data.checkEveryMinutes, 10)
    assert.equal(data.hosts?.[0].id, 2)
    assert.equal(data.hosts?.[0].port, 3306)
    assert.equal(data.hosts?.[0].host, '192.0.2.12')
  })

  test('ช่องที่เว้นว่างมาถึงเป็น null ต้องไม่ทำให้ฟอร์มพัง', async ({ assert }) => {
    const data = await dbSyncValidator.validate({
      ...base,
      groupId: null,
      digestAt: null,
      hosts: [
        // แถวเปล่าที่เตรียมไว้ให้กรอกเครื่องใหม่ แต่ผู้ใช้ไม่ได้กรอก
        { id: null, label: null, host: null, port: '3306', username: null, password: null, enabled: '1' },
      ],
    })

    assert.isUndefined(data.groupId)
    assert.isUndefined(data.digestAt)
    assert.isUndefined(data.hosts?.[0].host, 'ไม่มี host = แถวนี้ถูกข้าม/ลบทีหลัง')
  })

  test('ไม่ส่ง hosts มาเลยก็ยังบันทึกตั้งค่าได้', async ({ assert }) => {
    const data = await dbSyncValidator.validate(base)
    assert.isUndefined(data.hosts)
  })

  test('เวลารายงานประจำวันต้องเป็น HH:MM', async ({ assert }) => {
    await assert.rejects(() => dbSyncValidator.validate({ ...base, digestAt: '8 โมง' }))
  })
})

test.group('ข้อความแจ้งเตือนฐานข้อมูล', () => {
  test('มีตัวเลขของทุกเครื่องและบอกว่าเครื่องไหนตามหลัง', ({ assert }) => {
    const report = compareProbes(
      [probe('a', same), probe('b', { ...same, queue: 300 })],
      THRESHOLDS
    )
    const text = buildSyncMessage(report)

    assert.include(text, 'QueueWNK')
    assert.include(text, '392')
    assert.include(text, '300')
    assert.include(text, 'ตามหลัง')
  })

  test('เครื่องที่ต่อไม่ได้ต้องมีสาเหตุติดไปด้วย', ({ assert }) => {
    const report = compareProbes([probe('a', same), down('c', 'Access denied')], THRESHOLDS)
    const text = buildSyncMessage(report)

    assert.include(text, 'ต่อไม่ได้')
    assert.include(text, 'Access denied')
  })

  test('แยกทางกันต้องบอกให้ตาม DBA ไม่ใช่ปล่อยให้รอ', ({ assert }) => {
    const report = compareProbes(
      [probe('a', { ...same, orders: 2650 }), probe('b', { ...same, vn_stat: 390 })],
      THRESHOLDS
    )

    assert.include(buildSyncMessage(report), 'DBA')
  })
})
