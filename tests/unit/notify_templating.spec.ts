import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { renderNotifyTemplate, unknownPlaceholders } from '#services/notify_templating'
import { wrapWithLimit } from '#services/dataset_runner'
import type { DatasetResult } from '#services/dataset_runner'

function result(rows: Record<string, unknown>[]): DatasetResult {
  return {
    rows,
    columns: rows.length ? Object.keys(rows[0]) : [],
    durationMs: 1,
    truncated: false,
  }
}

test.group('เทมเพลตข้อความ MOPH Notify', () => {
  test('แทนค่าจากแถวแรก', ({ assert }) => {
    const out = renderNotifyTemplate('วันนี้มีผู้ป่วย {visits} ราย', result([{ visits: 231 }]))
    assert.equal(out, 'วันนี้มีผู้ป่วย 231 ราย')
  })

  test('วนทุกแถวด้วย each', ({ assert }) => {
    const out = renderNotifyTemplate(
      'สรุป\n{each}  {dept} {cases}\n{/each}รวม {rows} ห้อง',
      result([
        { dept: 'OPD', cases: 120 },
        { dept: 'ER', cases: 33 },
      ])
    )

    assert.equal(out, 'สรุป\n  OPD 120\n  ER 33\nรวม 2 ห้อง')
  })

  test('ไม่มีข้อมูลแล้ว each ต้องหายไปทั้งบล็อก', ({ assert }) => {
    const out = renderNotifyTemplate('หัวข้อ\n{each}  {dept}\n{/each}ท้าย', result([]))
    assert.equal(out, 'หัวข้อ\nท้าย')
  })

  test('ตัวยึดที่ไม่รู้จักกลายเป็นค่าว่าง ไม่หลุด {xxx} ให้คนอ่านเห็น', ({ assert }) => {
    const out = renderNotifyTemplate('ค่า {ไม่มีจริง}{missing} จบ', result([{ visits: 1 }]))
    assert.equal(out, 'ค่า {ไม่มีจริง} จบ')
  })

  test('ค่า null ในผลลัพธ์กลายเป็นค่าว่าง ไม่ใช่คำว่า null', ({ assert }) => {
    const out = renderNotifyTemplate('[{name}]', result([{ name: null }]))
    assert.equal(out, '[]')
  })

  test('builtin ให้วันที่แบบ พ.ศ.', ({ assert }) => {
    const out = renderNotifyTemplate('{date}', result([]))
    const now = DateTime.now().setZone('Asia/Bangkok')
    assert.equal(out, `${now.toFormat('dd/MM')}/${now.year + 543}`)
  })

  test('บอกได้ว่าตัวยึดไหนไม่มีค่าให้', ({ assert }) => {
    const missing = unknownPlaceholders('{date} {visits} {ghost}', ['visits'])
    assert.deepEqual(missing, ['ghost'])
  })
})

test.group('ครอบ LIMIT ให้ชุดข้อมูล', () => {
  test('ครอบ SELECT', ({ assert }) => {
    assert.match(wrapWithLimit('SELECT 1', 10), /^SELECT \* FROM \(SELECT 1\) AS \w+ LIMIT 10$/)
  })

  test('ตัด ; ท้ายก่อนครอบ ไม่งั้นเป็น syntax error', ({ assert }) => {
    assert.notInclude(wrapWithLimit('SELECT 1;  ', 10), ';')
  })

  test('ไม่ครอบคำสั่งที่ใส่ใน derived table ไม่ได้', ({ assert }) => {
    // SHOW/DESCRIBE เอาไปใส่ใน FROM (...) ไม่ได้ และคืนไม่กี่แถวอยู่แล้ว
    assert.equal(wrapWithLimit('SHOW COLUMNS FROM patient', 10), 'SHOW COLUMNS FROM patient')
    assert.equal(wrapWithLimit('DESCRIBE ovst', 10), 'DESCRIBE ovst')
  })
})
