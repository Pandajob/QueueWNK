import { test } from '@japa/runner'

import {
  DEFAULT_TEXT,
  fillTemplate,
  fullName,
  thaiFullDate,
  timeLabel,
} from '#services/appointment_reminder'

test.group('เวลานัดจาก HOSxP', () => {
  test('เวลาปกติแปลงเป็นรูปแบบไทย', ({ assert }) => {
    assert.equal(timeLabel('08:00:00'), '08.00 น.')
    assert.equal(timeLabel('13:30:00'), '13.30 น.')
    assert.equal(timeLabel('09:15:00'), '09.15 น.')
  })

  test('00:00:01 คือค่าสมมติว่าไม่ระบุเวลา ไม่ใช่เที่ยงคืน', ({ assert }) => {
    // ของจริงในฐานใช้ค่านี้ ปล่อยผ่านแล้วผู้ป่วยจะได้ข้อความว่านัดเวลา 00.00 น.
    assert.isNull(timeLabel('00:00:01'))
    assert.isNull(timeLabel('00:00:00'))
  })

  test('ค่าว่างหรืออ่านไม่ออกถือว่าไม่ระบุเวลา', ({ assert }) => {
    assert.isNull(timeLabel(null))
    assert.isNull(timeLabel(''))
    assert.isNull(timeLabel('ขยะ'))
  })
})

test.group('วันที่แบบไทย', () => {
  test('แปลงเป็น พ.ศ. และชื่อเดือนเต็ม', ({ assert }) => {
    assert.equal(thaiFullDate('2026-09-02'), '2 กันยายน 2569')
    assert.equal(thaiFullDate('2026-01-15'), '15 มกราคม 2569')
    assert.equal(thaiFullDate('2026-12-31'), '31 ธันวาคม 2569')
  })

  test('อ่านไม่ออกก็คืนค่าเดิม ไม่ระเบิด', ({ assert }) => {
    assert.equal(thaiFullDate('ขยะ'), 'ขยะ')
  })
})

test.group('ชื่อผู้ป่วย', () => {
  test('คำนำหน้าติดกับชื่อ เว้นวรรคก่อนนามสกุล', ({ assert }) => {
    assert.equal(fullName({ pname: 'น.ส.', fname: 'สมหญิง', lname: 'ใจดี' }), 'น.ส.สมหญิง ใจดี')
  })

  test('ไม่มีชื่อในทะเบียนก็ยังส่งได้ ไม่ทิ้งช่องว่างในข้อความ', ({ assert }) => {
    assert.equal(fullName({ pname: null, fname: null, lname: null }), 'ผู้รับบริการ')
  })
})

test.group('ประกอบข้อความนัดหมาย', () => {
  const values = {
    name: 'น.ส.สมหญิง ใจดี',
    date: '2 กันยายน 2569',
    time: 'เวลา 08.00 น.',
    clinic: 'โรคเบาหวาน',
    hn: '000123456',
  }

  test('แทนค่าครบทุกตัวยึด', ({ assert }) => {
    const text = fillTemplate(DEFAULT_TEXT, values)

    assert.include(text, 'น.ส.สมหญิง ใจดี')
    assert.include(text, '2 กันยายน 2569')
    assert.include(text, 'เวลา 08.00 น.')
    assert.include(text, 'โรคเบาหวาน')
  })

  test('ไม่ระบุเวลาแล้วต้องไม่เหลือช่องว่างซ้อนหรือคำว่า undefined', ({ assert }) => {
    const text = fillTemplate(DEFAULT_TEXT, { ...values, time: '' })

    assert.notInclude(text, '  ')
    assert.notInclude(text, 'undefined')
    assert.notInclude(text, '{time}')
    assert.include(text, 'มีนัดพบแพทย์วันที่ 2 กันยายน 2569 ที่ โรคเบาหวาน')
  })

  test('ตัวยึดที่ไม่รู้จักกลายเป็นค่าว่าง ไม่หลุด {xxx} ให้ผู้ป่วยเห็น', ({ assert }) => {
    assert.equal(fillTemplate('ทดสอบ {ไม่มีจริง} จบ', values), 'ทดสอบ  จบ'.replace(/ {2,}/g, ' '))
  })

  test('ข้อความที่ไม่มีตัวยึดเลยก็ผ่านได้', ({ assert }) => {
    assert.equal(fillTemplate('พรุ่งนี้มีนัด', values), 'พรุ่งนี้มีนัด')
  })
})
