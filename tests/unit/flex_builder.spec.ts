import { test } from '@japa/runner'
import {
  blocksToPlainText,
  buildBubble,
  buildFlexMessage,
  buildFlexMessages,
  buildScope,
  parseBlocks,
  resolveBlocks,
  splitPages,
} from '#services/flex_builder'
import type { FlexBlock } from '#services/flex_builder'
import type { DatasetResult } from '#services/dataset_runner'

function dataset(rows: Record<string, unknown>[]): DatasetResult {
  return {
    rows,
    columns: rows.length ? Object.keys(rows[0]) : [],
    durationMs: 1,
    truncated: false,
  }
}

const visits = dataset([
  { dept: 'OPD', cases: 10 },
  { dept: 'IPD', cases: 24 },
  { dept: 'ER', cases: 5 },
  { dept: 'Refer', cases: 0 },
])

test.group('การ์ด Flex — แปลงบล็อกเป็นข้อมูลพร้อมวาด', () => {
  test('แทนตัวยึดในหัวการ์ด', ({ assert }) => {
    const scope = buildScope(dataset([{ total: 42 }]))
    const [block] = resolveBlocks(
      [{ type: 'header', title: 'รพ. — {date}', subtitle: 'รวม {total} ราย' }],
      scope
    )

    assert.equal(block.kind, 'header')
    assert.include(block.kind === 'header' ? block.subtitle : '', 'รวม 42 ราย')
  })

  test('แถบยาวตามสัดส่วนของค่าสูงสุดในชุด', ({ assert }) => {
    const scope = buildScope(null, { visits })
    const [block] = resolveBlocks([{ type: 'bars', title: 'ผู้ป่วย', datasetKey: 'visits' }], scope)

    assert.equal(block.kind, 'bars')
    if (block.kind !== 'bars') return

    // IPD = 24 คือค่าสูงสุด จึงเต็ม 100% ส่วน OPD = 10 ได้ราว 42%
    assert.deepEqual(
      block.rows.map((r) => [r.label, r.value, r.percent]),
      [
        ['OPD', '10', 42],
        ['IPD', '24', 100],
        ['ER', '5', 21],
        ['Refer', '0', 0],
      ]
    )
  })

  test('เลือกคอลัมน์เองได้ ไม่ระบุ = ใช้สองคอลัมน์แรก', ({ assert }) => {
    const scope = buildScope(null, {
      d: dataset([{ ignore: 'x', name: 'X-ray', n: 3 }]),
    })

    const [auto] = resolveBlocks([{ type: 'rows', datasetKey: 'd' }], scope)
    assert.deepEqual(auto.kind === 'rows' ? auto.rows : [], [
      { label: 'x', value: 'X-ray', alert: false },
    ])

    const [picked] = resolveBlocks(
      [{ type: 'rows', datasetKey: 'd', labelColumn: 'name', valueColumn: 'n' }],
      scope
    )
    assert.deepEqual(picked.kind === 'rows' ? picked.rows : [], [
      { label: 'X-ray', value: '3', alert: false },
    ])
  })

  test('ชุดข้อมูลที่ไม่มีอยู่ = แถวว่าง ไม่ระเบิด', ({ assert }) => {
    const [block] = resolveBlocks([{ type: 'bars', datasetKey: 'ไม่มี' }], buildScope(null))
    assert.deepEqual(block.kind === 'bars' ? block.rows : null, [])
  })

  test('ตัวเลขที่มี comma อ่านเป็นตัวเลขได้', ({ assert }) => {
    const scope = buildScope(null, {
      d: dataset([
        { a: 'x', b: '1,200' },
        { a: 'y', b: '600' },
      ]),
    })
    const [block] = resolveBlocks([{ type: 'bars', datasetKey: 'd' }], scope)

    assert.deepEqual(block.kind === 'bars' ? block.rows.map((r) => r.percent) : [], [100, 50])
  })
})

test.group('การ์ด Flex — โครงสร้างที่ LINE รับ', () => {
  const blocks: FlexBlock[] = [
    { type: 'header', title: 'สรุปประจำวัน', subtitle: '{date}' },
    { type: 'hero', label: 'ผู้รับบริการทั้งหมด', value: '42', unit: 'ราย' },
    { type: 'bars', title: 'แยกตามแผนก', datasetKey: 'visits' },
    { type: 'divider' },
    { type: 'text', text: 'หมายเหตุ', tone: 'muted' },
    { type: 'button', label: 'ดู Dashboard', url: 'https://example.org' },
  ]

  test('header กับ button ตัวท้ายแยกออกจาก body', ({ assert }) => {
    const bubble = buildBubble(resolveBlocks(blocks, buildScope(null, { visits })))

    assert.property(bubble, 'header')
    assert.property(bubble, 'footer')
    assert.equal((bubble as any).type, 'bubble')

    // ปุ่มขึ้น footer แล้ว ต้องไม่ซ้ำใน body อีก
    const bodyJson = JSON.stringify((bubble as any).body)
    assert.notInclude(bodyJson, 'https://example.org')
  })

  test('ไม่มีปุ่ม = ไม่มี footer', ({ assert }) => {
    const bubble = buildBubble(resolveBlocks([{ type: 'text', text: 'x' }], buildScope(null)))
    assert.notProperty(bubble, 'footer')
  })

  test('แถบค่า 0 ยังต้องมีความกว้าง เพราะ LINE ไม่รับ 0%', ({ assert }) => {
    const bubble = buildBubble(
      resolveBlocks([{ type: 'bars', datasetKey: 'visits' }], buildScope(null, { visits }))
    )

    const json = JSON.stringify(bubble)
    assert.notInclude(json, '"width":"0%"')
    assert.include(json, '"width":"1%"')
  })

  test('บล็อกว่างเปล่ายังได้ bubble ที่ส่งได้', ({ assert }) => {
    const bubble = buildBubble(resolveBlocks([], buildScope(null))) as any
    assert.isAbove(bubble.body.contents.length, 0)
  })

  test('altText ถูกตัดไม่ให้ยาวเกินที่ LINE รับ', ({ assert }) => {
    const message = buildFlexMessage('ก'.repeat(600), {})
    assert.equal(message.altText.length, 400)
  })

  test('altText ว่างมีค่าสำรองให้ ไม่ปล่อยว่าง', ({ assert }) => {
    assert.equal(buildFlexMessage('', {}).altText, 'แจ้งเตือน')
  })
})

test.group('การ์ด Flex — คัดกรองบล็อกที่ฟอร์มส่งมา', () => {
  test('เก็บเฉพาะฟิลด์ที่รู้จัก ทิ้งของแปลกปลอม', ({ assert }) => {
    const blocks = parseBlocks(
      JSON.stringify([{ type: 'header', title: 'ok', onClick: 'alert(1)', contents: [{}] }])
    )

    assert.deepEqual(blocks, [{ type: 'header', title: 'ok', subtitle: '' }])
  })

  test('ทิ้งบล็อกชนิดที่ไม่รู้จัก', ({ assert }) => {
    const blocks = parseBlocks(JSON.stringify([{ type: 'image', url: 'x' }, { type: 'divider' }]))
    assert.deepEqual(blocks, [{ type: 'divider' }])
  })

  test('ปุ่มรับเฉพาะ http/https', ({ assert }) => {
    const ok = parseBlocks(JSON.stringify([{ type: 'button', label: 'a', url: 'https://x.test' }]))
    assert.equal((ok[0] as any).url, 'https://x.test')

    const bad = parseBlocks(
      JSON.stringify([{ type: 'button', label: 'a', url: 'javascript:alert(1)' }])
    )
    assert.equal((bad[0] as any).url, '')
  })

  test('JSON เสียหรือไม่ใช่ array = ไม่มีบล็อก ไม่ throw', ({ assert }) => {
    assert.deepEqual(parseBlocks('{{{'), [])
    assert.deepEqual(parseBlocks('{"type":"header"}'), [])
    assert.deepEqual(parseBlocks(''), [])
    assert.deepEqual(parseBlocks(null), [])
  })

  test('จำกัดจำนวนบล็อกและความยาวข้อความ', ({ assert }) => {
    const many = Array.from({ length: 100 }, () => ({ type: 'divider' }))
    assert.lengthOf(parseBlocks(JSON.stringify(many)), 40)

    const long = parseBlocks(JSON.stringify([{ type: 'header', title: 'ก'.repeat(999) }]))
    assert.equal((long[0] as any).title.length, 300)
  })

  test('tone ที่ไม่รู้จักตกกลับเป็นปกติ', ({ assert }) => {
    const blocks = parseBlocks(JSON.stringify([{ type: 'text', text: 'x', tone: 'rainbow' }]))
    assert.equal((blocks[0] as any).tone, 'normal')
  })
})

test.group('การ์ด Flex — ข้อความสำรองสำหรับประวัติ', () => {
  test('อ่านรู้เรื่องโดยไม่ต้องเปิด LINE', ({ assert }) => {
    const text = blocksToPlainText(
      resolveBlocks(
        [
          { type: 'header', title: 'สรุปประจำวัน' },
          { type: 'bars', title: 'แผนก', datasetKey: 'visits' },
          { type: 'button', label: 'ดู Dashboard', url: 'https://example.org' },
        ],
        buildScope(null, { visits })
      )
    )

    assert.include(text, 'สรุปประจำวัน')
    assert.include(text, 'OPD — 10')
    assert.include(text, 'ดู Dashboard: https://example.org')
    assert.notInclude(text, '\n\n\n')
  })

  /**
   * ข้อความสำรองไม่ได้ใช้แค่ในประวัติแล้ว — กลุ่มที่ปลายทางไม่ส่งการ์ดต่อ
   * จะได้ข้อความนี้แทนการ์ดจริง จึงต้องเทียบสัดส่วนกันเองได้ด้วยตา
   */
  test('บล็อกแถบมีแถบให้เทียบสัดส่วน แถวที่มากสุดยาวสุด', ({ assert }) => {
    const text = blocksToPlainText(
      resolveBlocks([{ type: 'bars', datasetKey: 'visits' }], buildScope(null, { visits }))
    )

    const bars = text
      .split('\n')
      .filter((line) => line.includes('█'))
      .map((line) => line.slice(line.indexOf('█')).length)

    // ชุดทดสอบเรียงตาม OPD 10 / IPD 24 / ER 5 / Refer 0 — Refer ไม่มีแถบเพราะเป็นศูนย์
    assert.equal(bars.length, 3)
    // IPD มากสุดต้องได้แถบยาวสุด และมากกว่า OPD ที่น้อยกว่าครึ่ง
    assert.equal(Math.max(...bars), bars[1])
    assert.isAbove(bars[1], bars[0])
    // แถวศูนย์ยังต้องมีอยู่ในข้อความ แค่ไม่มีแถบ
    assert.include(text, 'Refer — 0')
  })
})

/**
 * สองทิศทางที่ตรงข้ามกัน — แผนกที่วันนั้นไม่มีคนมาต้องสะดุดตา
 * ส่วนงานที่ค้างอยู่ ศูนย์คือเรื่องดี ไม่ใช่ศูนย์ต่างหากที่ต้องรีบ
 */
test.group('การ์ด Flex — แถวที่ต้องทำสีแดง', () => {
  const alertsOnZero: FlexBlock[] = [
    {
      type: 'bars',
      datasetKey: 'visits',
      labelColumn: 'dept',
      valueColumn: 'cases',
      alertWhen: 'zero',
    },
  ]

  function flags(blocks: FlexBlock[]) {
    const [block] = resolveBlocks(blocks, buildScope(null, { visits })) as any[]
    return block.rows.map((r: any) => r.alert)
  }

  test('แดงเมื่อค่าเป็น 0 — จับเฉพาะแถวที่ไม่มีใครมา', ({ assert }) => {
    assert.deepEqual(flags(alertsOnZero), [false, false, false, true])
  })

  test('แดงเมื่อมากกว่า 0 — จับทุกแถวที่ยังมีงานค้าง', ({ assert }) => {
    assert.deepEqual(
      flags([{ type: 'rows', datasetKey: 'visits', valueColumn: 'cases', alertWhen: 'nonzero' }]),
      [true, true, true, false]
    )
  })

  test('ไม่ตั้งไว้ = ไม่มีแถวไหนแดง', ({ assert }) => {
    assert.deepEqual(flags([{ type: 'rows', datasetKey: 'visits', valueColumn: 'cases' }]), [
      false,
      false,
      false,
      false,
    ])
  })

  test('การ์ดเก่าที่ยังส่ง zeroRed มา ยังทำงานเหมือนเดิม', ({ assert }) => {
    const [block] = parseBlocks(
      JSON.stringify([{ type: 'bars', datasetKey: 'visits', zeroRed: true }])
    )

    assert.equal((block as any).alertWhen, 'zero')
  })

  test('ค่าที่ไม่ใช่ตัวเลขไม่เข้าเงื่อนไขทั้งสองแบบ', ({ assert }) => {
    const words = dataset([
      { name: 'ปกติ', note: 'ครบ' },
      { name: 'ว่าง', note: '' },
    ])

    for (const when of ['zero', 'nonzero'] as const) {
      const [block] = resolveBlocks(
        [
          {
            type: 'rows',
            datasetKey: 'words',
            labelColumn: 'name',
            valueColumn: 'note',
            alertWhen: when,
          },
        ],
        buildScope(null, { words })
      ) as any[]

      assert.deepEqual(
        block.rows.map((r: any) => r.alert),
        [false, false]
      )
    }
  })

  test('แถวที่เข้าเงื่อนไขเป็นสีแดงทั้งป้ายและตัวเลข', ({ assert }) => {
    const json = JSON.stringify(
      buildBubble(resolveBlocks(alertsOnZero, buildScope(null, { visits })))
    )

    // ป้าย + ตัวเลข + แถบ = สามที่ต่อหนึ่งแถว และมีแถวเดียวที่เป็นศูนย์
    assert.equal(json.split('#d02d2d').length - 1, 3)
  })

  test('ไม่ตั้งไว้แล้วไม่มีอะไรแดง', ({ assert }) => {
    const off: FlexBlock[] = [{ type: 'bars', datasetKey: 'visits', valueColumn: 'cases' }]
    const bubble = buildBubble(resolveBlocks(off, buildScope(null, { visits })))

    assert.notInclude(JSON.stringify(bubble), '#d02d2d')
  })
})

/**
 * LINE จำกัด JSON ของ Flex ไว้ 10 KB ต่อหนึ่งข้อความ ไม่ใช่ต่อคำขอ
 * การ์ดสรุปที่มีหลายสิบแถวจึงต้องตัดเป็นหลายใบ
 */
test.group('การ์ด Flex — ตัดเป็นหลายใบ', () => {
  function pageTitles(blocks: FlexBlock[]) {
    return splitPages(resolveBlocks(blocks, buildScope(null, { visits }))).map((page) =>
      page.map((b) => b.kind)
    )
  }

  test('ไม่มีจุดตัด = ใบเดียว', ({ assert }) => {
    const messages = buildFlexMessages(
      'x',
      resolveBlocks([{ type: 'text', text: 'a' }], buildScope(null))
    )

    assert.lengthOf(messages, 1)
    assert.equal(messages[0].altText, 'x')
  })

  test('ตัดตรงจุดที่วางไว้', ({ assert }) => {
    assert.deepEqual(
      pageTitles([{ type: 'text', text: 'a' }, { type: 'pagebreak' }, { type: 'text', text: 'b' }]),
      [['text'], ['text']]
    )
  })

  test('หัวการ์ดของใบแรกถูกยกไปใส่ทุกใบ ไม่ให้ใบหลังลอยมาไร้บริบท', ({ assert }) => {
    assert.deepEqual(
      pageTitles([
        { type: 'header', title: 'สรุป' },
        { type: 'text', text: 'a' },
        { type: 'pagebreak' },
        { type: 'text', text: 'b' },
      ]),
      [
        ['header', 'text'],
        ['header', 'text'],
      ]
    )
  })

  test('ใบที่มีหัวการ์ดของตัวเองอยู่แล้วไม่ถูกยัดซ้ำ', ({ assert }) => {
    assert.deepEqual(
      pageTitles([
        { type: 'header', title: 'ก' },
        { type: 'pagebreak' },
        { type: 'header', title: 'ข' },
      ]),
      [['header'], ['header']]
    )
  })

  test('จุดตัดติดกันหรืออยู่หัวท้าย ไม่ทำให้เกิดใบว่าง', ({ assert }) => {
    assert.deepEqual(
      pageTitles([
        { type: 'pagebreak' },
        { type: 'text', text: 'a' },
        { type: 'pagebreak' },
        { type: 'pagebreak' },
        { type: 'text', text: 'b' },
        { type: 'pagebreak' },
      ]),
      [['text'], ['text']]
    )
  })

  test('ไม่เกิน 5 ใบ เพราะ LINE รับได้ 5 ข้อความต่อคำขอ', ({ assert }) => {
    const many: FlexBlock[] = []
    for (let i = 0; i < 12; i++) many.push({ type: 'text', text: String(i) }, { type: 'pagebreak' })

    assert.lengthOf(splitPages(resolveBlocks(many, buildScope(null))), 5)
  })

  test('altText ติดเลขหน้าเมื่อมีหลายใบ ไม่งั้นดูเหมือนส่งซ้ำ', ({ assert }) => {
    const messages = buildFlexMessages(
      'สรุปวันนี้',
      resolveBlocks(
        [{ type: 'text', text: 'a' }, { type: 'pagebreak' }, { type: 'text', text: 'b' }],
        buildScope(null)
      )
    )

    assert.deepEqual(
      messages.map((m) => m.altText),
      ['สรุปวันนี้ (1/2)', 'สรุปวันนี้ (2/2)']
    )
  })
})
