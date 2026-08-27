import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { NotifySchedule, isQuietAt } from '#models/notify_system'

const BANGKOK = { zone: 'Asia/Bangkok' }

/** สร้าง schedule ในหน่วยความจำ ไม่แตะฐานข้อมูล */
function schedule(attrs: Partial<NotifySchedule>) {
  const row = new NotifySchedule()
  row.merge({
    name: 'ทดสอบ',
    templateId: 1,
    frequency: 'daily',
    runAt: '08:00',
    isEnabled: true,
    ...attrs,
  } as Partial<NotifySchedule>)
  return row
}

const at = (iso: string) => DateTime.fromISO(iso, BANGKOK)

test.group('ตารางเวลา — ถึงรอบหรือยัง', () => {
  test('ยังไม่ถึงเวลา = ยังไม่ส่ง', ({ assert }) => {
    assert.isFalse(schedule({ runAt: '08:00' }).isDue(at('2026-08-04T07:59')))
  })

  test('ถึงเวลาแล้วและยังไม่เคยส่ง = ส่ง', ({ assert }) => {
    assert.isTrue(schedule({ runAt: '08:00' }).isDue(at('2026-08-04T08:00')))
  })

  test('ส่งไปแล้วในรอบนี้ = ไม่ส่งซ้ำ', ({ assert }) => {
    const row = schedule({ runAt: '08:00', lastRunAt: at('2026-08-04T08:00') })
    assert.isFalse(row.isDue(at('2026-08-04T12:00')))
  })

  test('worker ดับข้ามเวลานัด พอฟื้นมาต้องยังส่งให้', ({ assert }) => {
    // สายดีกว่าหาย — นัด 08:00 เพิ่งฟื้นตอน 10:30 ส่งครั้งสุดท้ายคือเมื่อวาน
    const row = schedule({ runAt: '08:00', lastRunAt: at('2026-08-03T08:00') })
    assert.isTrue(row.isDue(at('2026-08-04T10:30')))
  })

  test('ปิดอยู่ = ไม่ส่งไม่ว่าอะไรจะเกิดขึ้น', ({ assert }) => {
    assert.isFalse(schedule({ isEnabled: false }).isDue(at('2026-08-04T23:59')))
  })

  test('รายสัปดาห์ส่งเฉพาะวันที่เลือก', ({ assert }) => {
    // 2026-08-04 เป็นวันอังคาร (ISO weekday = 2)
    const row = schedule({ frequency: 'weekly', daysOfWeek: [1, 3, 5], runAt: '08:00' })
    assert.isFalse(row.isDue(at('2026-08-04T09:00')))

    const onWednesday = schedule({ frequency: 'weekly', daysOfWeek: [1, 3, 5], runAt: '08:00' })
    assert.isTrue(onWednesday.isDue(at('2026-08-05T09:00')))
  })

  test('รายสัปดาห์ที่ไม่เลือกวันเลย = ไม่ส่ง', ({ assert }) => {
    const row = schedule({ frequency: 'weekly', daysOfWeek: [], runAt: '08:00' })
    assert.isFalse(row.isDue(at('2026-08-04T09:00')))
  })

  test('รายเดือนส่งเฉพาะวันที่กำหนด', ({ assert }) => {
    const row = schedule({ frequency: 'monthly', dayOfMonth: 1, runAt: '08:00' })
    assert.isFalse(row.isDue(at('2026-08-04T09:00')))
    assert.isTrue(schedule({ frequency: 'monthly', dayOfMonth: 4, runAt: '08:00' }).isDue(at('2026-08-04T09:00')))
  })
})

test.group('ตารางเวลา — คำอธิบายรอบ', () => {
  test('รายวัน', ({ assert }) => {
    assert.equal(schedule({ runAt: '16:30' }).scheduleLabel, 'ทุกวัน 16:30')
  })

  test('รายสัปดาห์เรียงตามที่เลือก', ({ assert }) => {
    const row = schedule({ frequency: 'weekly', daysOfWeek: [1, 5], runAt: '08:00' })
    assert.equal(row.scheduleLabel, 'ทุกจันทร์ ศุกร์ 08:00')
  })

  test('รายเดือน', ({ assert }) => {
    const row = schedule({ frequency: 'monthly', dayOfMonth: 15, runAt: '09:00' })
    assert.equal(row.scheduleLabel, 'ทุกวันที่ 15 ของเดือน 09:00')
  })
})

test.group('ช่วงเวลางดส่ง', () => {
  test('ช่วงที่ข้ามเที่ยงคืน', ({ assert }) => {
    assert.isTrue(isQuietAt('21:00', '07:00', at('2026-08-04T22:30')))
    assert.isTrue(isQuietAt('21:00', '07:00', at('2026-08-04T03:00')))
    assert.isFalse(isQuietAt('21:00', '07:00', at('2026-08-04T12:00')))
  })

  test('ช่วงปกติในวันเดียวกัน', ({ assert }) => {
    assert.isTrue(isQuietAt('12:00', '13:00', at('2026-08-04T12:30')))
    assert.isFalse(isQuietAt('12:00', '13:00', at('2026-08-04T13:00')))
  })
})
