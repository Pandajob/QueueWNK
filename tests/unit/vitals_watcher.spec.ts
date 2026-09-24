import { DateTime } from 'luxon'
import { test } from '@japa/runner'

import {
  VitalsWatcher,
  bpLabel,
  fullName,
  phoneOf,
  severityOf,
  timeLabel,
} from '#services/vitals_watcher'
import type { VitalsRow } from '#services/vitals_watcher'
import { blocksToPlainText } from '#services/flex_builder'
import type { VitalsSetting } from '#models/notify_system'

/** พอสำหรับ buildMessage/windowFor/isDue ซึ่งอ่านแต่ฟิลด์ธรรมดา ไม่แตะฐานข้อมูล */
function settingsOf(overrides: Partial<VitalsSetting> = {}) {
  return {
    sysThreshold: 139,
    diaThreshold: 90,
    sendAt: '15:00',
    lastRunAt: null,
    lastRunDate: null,
    includeHn: true,
    includeName: true,
    includeAddress: true,
    includePhone: true,
    ...overrides,
  } as VitalsSetting
}

function rowOf(overrides: Partial<VitalsRow> = {}): VitalsRow {
  return {
    vn: '690902082952',
    hn: '0123814',
    screened_at: '2026-09-02 08:29:52',
    vsttime: '08:29:52',
    bps: 150,
    bpd: 95,
    pulse: 76,
    dep: '001',
    department: 'ห้องตรวจโรคทั่วไป',
    pname: 'นาย',
    fname: 'สมชาย',
    lname: 'ใจดี',
    addr: '83 ม.2 ต.อุดมทรัพย์ อ.วังน้ำเขียว',
    tel: '0829078762',
    hospsub: '02847',
    hospsub_name: 'โรงพยาบาลส่งเสริมสุขภาพตำบลบะใหญ่',
    in_district: 1,
    ...overrides,
  }
}

const bkk = (iso: string) => DateTime.fromISO(iso, { zone: 'Asia/Bangkok' })

test.group('ระดับความรุนแรงของความดัน', () => {
  test('เข้าเกณฑ์วิกฤตเมื่อค่าบนถึง 180 หรือค่าล่างถึง 120', ({ assert }) => {
    assert.equal(severityOf(180, 80).rank, 3)
    assert.equal(severityOf(150, 120).rank, 3)
  })

  test('ค่าล่างอย่างเดียวก็ดันขึ้นระดับได้ ไม่ต้องรอค่าบน', ({ assert }) => {
    // 164/125 เป็นเคสจริงที่เจอในฐาน ค่าบนยังไม่ถึง 180 แต่ค่าล่างเกิน 120
    assert.equal(severityOf(164, 125).rank, 3)
    assert.equal(severityOf(150, 100).rank, 2)
  })

  test('ค่าว่างไม่ทำให้พัง', ({ assert }) => {
    assert.equal(severityOf(null, null).rank, 1)
  })
})

test.group('การแสดงค่า', () => {
  test('HOSxP เก็บความดันเป็น double ต้องปัดก่อนแสดง', ({ assert }) => {
    // ของจริงในฐานเป็น double(15,3) — ปล่อยไว้จะได้ "140.000/90.000"
    assert.equal(bpLabel(140.0, 90.0), '140/90')
    assert.equal(bpLabel(180.4, 119.6), '180/120')
  })

  test('เวลาตัดวินาทีทิ้ง', ({ assert }) => {
    assert.equal(timeLabel('08:29:52'), '08:29')
    assert.equal(timeLabel(null), '')
  })

  test('pname ต่อกับชื่อโดยไม่เว้นวรรค', ({ assert }) => {
    assert.equal(fullName({ pname: 'นาย', fname: 'สมชาย', lname: 'ใจดี' }), 'นายสมชาย ใจดี')
    assert.equal(fullName({ pname: null, fname: null, lname: null }), '')
  })

  test('เบอร์โทรที่คีย์มาหลายเบอร์ เอาเบอร์แรกพอ', ({ assert }) => {
    assert.equal(phoneOf('0812345678,0898765432'), '0812345678')
    assert.equal(phoneOf(null), '')
  })
})

test.group('ช่วงข้อมูลของแต่ละรอบ', () => {
  test('รอบแรกย้อนไปหนึ่งวันเต็มนับจากเวลาส่ง ไม่ใช่ย้อนทั้งฐาน', ({ assert }) => {
    const { from } = new VitalsWatcher().windowFor(settingsOf(), bkk('2026-09-02T15:00'))
    assert.equal(from.toFormat('yyyy-MM-dd HH:mm'), '2026-09-01 15:00')
  })

  test('รอบถัดไปเริ่มจากเวลาที่ส่งรอบที่แล้ว', ({ assert }) => {
    // นี่คือหัวใจของ "ข้อมูลหลัง 15.00 ของวันนี้ ไปรวมกับวันถัดไป"
    const settings = settingsOf({ lastRunAt: bkk('2026-09-02T15:00') })
    const { from, to } = new VitalsWatcher().windowFor(settings, bkk('2026-09-03T15:00'))

    assert.equal(from.toFormat('yyyy-MM-dd HH:mm'), '2026-09-02 15:00')
    assert.equal(to.toFormat('yyyy-MM-dd HH:mm'), '2026-09-03 15:00')
  })

  test('รายที่คัดกรอง 16:30 ของวันนี้ อยู่ในช่วงของรอบพรุ่งนี้', ({ assert }) => {
    const settings = settingsOf({ lastRunAt: bkk('2026-09-02T15:00') })
    const { from, to } = new VitalsWatcher().windowFor(settings, bkk('2026-09-03T15:00'))
    const screened = bkk('2026-09-02T16:30')

    assert.isTrue(screened > from && screened <= to)
  })
})

test.group('จังหวะการส่งรายวัน', () => {
  test('ยังไม่ถึงเวลาก็ยังไม่ส่ง', ({ assert }) => {
    assert.isFalse(new VitalsWatcher().isDue(settingsOf(), bkk('2026-09-02T14:59')))
  })

  test('ถึงเวลาแล้วและวันนี้ยังไม่ได้ส่ง', ({ assert }) => {
    assert.isTrue(new VitalsWatcher().isDue(settingsOf(), bkk('2026-09-02T15:00')))
  })

  test('วันนี้ส่งไปแล้วไม่ส่งซ้ำ', ({ assert }) => {
    const settings = settingsOf({ lastRunDate: bkk('2026-09-02T00:00') })
    assert.isFalse(new VitalsWatcher().isDue(settings, bkk('2026-09-02T16:00')))
  })

  test('เลยเวลาไปแล้วแต่ยังไม่ได้ส่ง ก็ยังส่งให้ ไม่ข้ามรอบ', ({ assert }) => {
    // เซิร์ฟเวอร์รีสตาร์ตคร่อมเวลาส่ง — รอบนั้นต้องไม่หายไปเฉย ๆ
    assert.isTrue(new VitalsWatcher().isDue(settingsOf(), bkk('2026-09-02T18:20')))
  })
})

test.group('การแบ่งชุดส่งตามสถานพยาบาลรอง', () => {
  const batches = (rows: VitalsRow[]) => new VitalsWatcher().batchesFor(rows)

  test('รพ.สต. ในอำเภอได้ชุดของตัวเองแยกใบ', ({ assert }) => {
    const result = batches([
      rowOf(),
      rowOf({ vn: 'x2', hospsub: '02849', hospsub_name: 'รพ.สต.ไทยสามัคคี', in_district: 1 }),
    ])

    assert.lengthOf(result, 2)
    assert.deepEqual(
      result.map((b) => b.title),
      ['โรงพยาบาลส่งเสริมสุขภาพตำบลบะใหญ่', 'รพ.สต.ไทยสามัคคี']
    )
  })

  test('เรียงชุดที่มีคนเยอะไว้ก่อน', ({ assert }) => {
    const result = batches([
      rowOf({ vn: 'a', hospsub_name: 'รพ.สต. ก' }),
      rowOf({ vn: 'b', hospsub_name: 'รพ.สต. ข' }),
      rowOf({ vn: 'c', hospsub_name: 'รพ.สต. ข' }),
    ])

    assert.equal(result[0].title, 'รพ.สต. ข')
    assert.equal(result[0].rows.length, 2)
  })

  test('คนไม่มี hospsub กับคนนอกอำเภอ รวมเป็นชุดเดียว', ({ assert }) => {
    const result = batches([
      rowOf(),
      rowOf({ vn: 'x2', hospsub: null, hospsub_name: null, in_district: 0 }),
      rowOf({ vn: 'x3', hospsub: '11111', hospsub_name: 'โรงพยาบาลมหาราช', in_district: 0 }),
    ])

    const other = result.find((b) => b.key === 'other')
    assert.exists(other)
    assert.equal(other!.title, 'ผู้ป่วยรายอื่น')
    assert.lengthOf(other!.rows, 2)
  })

  test('ไม่มีคนกลุ่มอื่นก็ไม่สร้างชุดเปล่า', ({ assert }) => {
    const result = batches([rowOf()])
    assert.notExists(result.find((b) => b.key === 'other'))
  })

  test('ชุดที่เกิน 40 รายถูกซอยต่อ กันไม่ให้การ์ดใบที่ 6 หายเงียบ ๆ', ({ assert }) => {
    // splitPages ตัดที่ 5 ใบ ใบละ 8 ราย เกินกว่านั้นบล็อกถูกโยนทิ้งโดยไม่มีอะไรฟ้อง
    const many = Array.from({ length: 45 }, (_, i) => rowOf({ vn: `v${i}`, hn: String(9000 + i) }))
    const result = batches(many)

    assert.lengthOf(result, 2)
    assert.equal(result[0].rows.length, 40)
    assert.equal(result[1].rows.length, 5)
    assert.include(result[0].title, '(1/2)')
  })
})

test.group('การ์ด Flex ที่เข้ากลุ่มเจ้าหน้าที่', () => {
  const from = bkk('2026-09-01T15:00')
  const to = bkk('2026-09-02T15:00')
  const watcher = new VitalsWatcher()

  const textOf = (rows: VitalsRow[], settings = settingsOf()) => {
    const [batch] = watcher.batchesFor(rows)
    return blocksToPlainText(watcher.flexBlocksFor(batch, settings, from, to))
  }

  test('มีครบทั้ง HN ชื่อ ที่อยู่ เบอร์โทร และชื่อสถานพยาบาลรองบนหัวการ์ด', ({ assert }) => {
    const text = textOf([rowOf()])

    assert.include(text, 'โรงพยาบาลส่งเสริมสุขภาพตำบลบะใหญ่')
    assert.include(text, 'นายสมชาย ใจดี')
    assert.include(text, 'HN 0123814')
    assert.include(text, 'ต.อุดมทรัพย์')
    assert.include(text, '0829078762')
  })

  test('ปิดช่องไหนช่องนั้นหายจากการ์ด', ({ assert }) => {
    const text = textOf([rowOf()], settingsOf({ includeAddress: false, includePhone: false }))

    assert.notInclude(text, 'ต.อุดมทรัพย์')
    assert.notInclude(text, '0829078762')
    assert.include(text, 'HN 0123814')
  })

  test('ขึ้นการ์ดใหม่ทุก 8 ราย ไม่ยัดใบเดียวจนเกิน 10 KB', ({ assert }) => {
    const many = Array.from({ length: 17 }, (_, i) => rowOf({ vn: `v${i}` }))
    const [batch] = watcher.batchesFor(many)
    const blocks = watcher.flexBlocksFor(batch, settingsOf(), from, to)

    assert.lengthOf(
      blocks.filter((b) => b.kind === 'pagebreak'),
      2
    )
  })

  test('เรียงความดันจากมากไปน้อย และเตือนเฉพาะระดับสูงมากขึ้นไป', ({ assert }) => {
    // เตือนทุกคนเท่ากับไม่เตือนใคร — และคนที่หนักที่สุดต้องอยู่บนสุดของการ์ด
    const blocks = watcher.flexBlocksFor(
      { key: 'k', title: 'ทดสอบ', rows: [rowOf({ bps: 150, bpd: 85 }), rowOf({ bps: 190 })] },
      settingsOf(),
      from,
      to
    )

    const rows = blocks
      .filter((b) => b.kind === 'rows')
      .flatMap((b) => (b.kind === 'rows' ? b.rows : []))

    assert.deepEqual(
      rows.map((r) => r.value),
      ['190/95 mmHg', '150/85 mmHg']
    )
    assert.deepEqual(
      rows.map((r) => r.alert),
      [true, false]
    )
  })

  test('กำกับเสมอว่าเป็นค่าคัดกรอง ไม่ใช่การวินิจฉัย', ({ assert }) => {
    assert.include(textOf([rowOf()]), 'ไม่ใช่การวินิจฉัย')
  })
})
