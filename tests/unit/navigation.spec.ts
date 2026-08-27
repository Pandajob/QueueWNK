import { test } from '@japa/runner'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NAV_SYSTEMS, allNavKeys, findNavSystem } from '#services/navigation'

const VIEWS = new URL('../../resources/views/pages/', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1'
)

/** ไล่หาไฟล์ .edge ทุกอันในโฟลเดอร์หน้าเว็บ */
function edgeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return edgeFiles(path)
    return entry.name.endsWith('.edge') ? [path] : []
  })
}

test.group('เมนู', () => {
  test('key ห้ามซ้ำข้ามระบบ', ({ assert }) => {
    // key ซ้ำแปลว่า findNavSystem() จะเดาระบบผิด แล้วแถบบนไฮไลต์คนละอันกับที่เปิดอยู่
    const keys = allNavKeys()
    assert.equal(keys.length, new Set(keys).size, `key ซ้ำ: ${keys.join(', ')}`)
  })

  test('ทุกระบบมีอย่างน้อยหนึ่งเมนู', ({ assert }) => {
    for (const system of NAV_SYSTEMS) {
      const items = system.groups.flatMap((g) => g.items)
      assert.isAbove(items.length, 0, `ระบบ ${system.key} ไม่มีเมนูเลย`)
    }
  })

  test('หน้าแรกของแต่ละระบบต้องเป็นเมนูที่มีอยู่จริง', ({ assert }) => {
    for (const system of NAV_SYSTEMS) {
      const routes = system.groups.flatMap((g) => g.items.map((i) => i.route))
      assert.include(routes, system.route, `ระบบ ${system.key} ชี้ไปหน้าที่ไม่มีในเมนู`)
    }
  })

  test('ทุกหน้าที่ใช้ layout หลักต้องมีที่อยู่ในเมนู', ({ assert }) => {
    // กันหน้าใหม่หลุดเมนู — เปิดเข้าไปแล้ว sidebar หายทั้งแถบ
    const known = new Set(allNavKeys())
    const orphans: string[] = []

    for (const file of edgeFiles(VIEWS)) {
      const source = readFileSync(file, 'utf-8')

      // หน้า login/error ใช้ chrome: false จึงไม่ต้องมีเมนู
      if (/chrome:\s*false/.test(source)) continue

      const match = source.match(/active:\s*'([^']+)'/)
      if (!match) continue

      if (!known.has(match[1])) orphans.push(`${file} → active: '${match[1]}'`)
    }

    assert.deepEqual(orphans, [], `หน้าที่ไม่มีในเมนู:\n${orphans.join('\n')}`)
  })

  test('key ที่ไม่รู้จักคืน null ไม่ระเบิด', ({ assert }) => {
    assert.isNull(findNavSystem('ไม่มีอยู่จริง'))
    assert.isNull(findNavSystem(undefined))
  })

  test('หาระบบจาก key ได้ถูกต้อง', ({ assert }) => {
    assert.equal(findNavSystem('log')?.key, 'alert')
    assert.equal(findNavSystem('nt-cdcu')?.key, 'notify')
    assert.equal(findNavSystem('ccm')?.key, 'ccm')
    assert.equal(findNavSystem('hosxp')?.key, 'system')
  })

  test('หน้าเฝ้าระบบทั้งสามอยู่แท็บ Monitor ด้วยกัน', ({ assert }) => {
    // เคยกระจายอยู่คนละแท็บทั้งที่คนเปิดคือทีมไอทีชุดเดียวกัน
    for (const key of ['status', 'dbsync', 'notify']) {
      assert.equal(findNavSystem(key)?.key, 'monitor', `${key} หลุดออกจากแท็บ Monitor`)
    }
  })
})
