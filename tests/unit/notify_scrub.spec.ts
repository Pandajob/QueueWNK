import { test } from '@japa/runner'
import { scrubCid } from '#services/notify_client'

test.group('MOPH Notify — กันเลขบัตรหลุดเข้ากลุ่มแชท', () => {
  test('ตัดเลข 13 หลักทิ้ง', ({ assert }) => {
    assert.equal(scrubCid('cid 1234567890123 ส่งไม่ผ่าน'), 'cid xxxxxxxxxxxxx ส่งไม่ผ่าน')
    assert.equal(scrubCid('1234567890123'), 'xxxxxxxxxxxxx')
  })

  test('ตัดได้แม้ติดกับตัวอักษรอื่น', ({ assert }) => {
    // ข้อความ error จริงมักไม่มีช่องว่างคั่น เช่น cid=1234567890123,hn=...
    assert.equal(scrubCid('cid=1234567890123,hn=000123'), 'cid=xxxxxxxxxxxxx,hn=000123')
  })

  test('ตัดครบทุกตัวในข้อความเดียว', ({ assert }) => {
    assert.equal(
      scrubCid('1111111111111 กับ 2222222222222'),
      'xxxxxxxxxxxxx กับ xxxxxxxxxxxxx'
    )
  })

  test('ไม่แตะเลขสั้นกว่า 13 หลัก', ({ assert }) => {
    // เลข vn (12 หลัก) เวลา และจำนวนต่าง ๆ ต้องอ่านออกได้ตามเดิม
    assert.equal(scrubCid('vn 690803134422 เวลา 14:32 ล้มเหลว 3 รายการ'),
      'vn 690803134422 เวลา 14:32 ล้มเหลว 3 รายการ')
  })
})
