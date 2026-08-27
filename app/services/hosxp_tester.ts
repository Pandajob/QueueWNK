import { HosxpClient, type HosxpConfig } from '#services/hosxp_client'

export type TestCheck = {
  label: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
}

export type TestResult = {
  ok: boolean
  checks: TestCheck[]
}

/** ปิดบังเลข 13 หลักและ HN ก่อนเอาขึ้นหน้าเว็บหรือลง log */
function mask(value: unknown) {
  const s = String(value ?? '')
  if (/^\d{13}$/.test(s)) return `${s.slice(0, 4)}xxxxx${s.slice(9)}`
  if (s.length > 6) return `${s.slice(0, 3)}***${s.slice(-2)}`
  return s
}

/** ตัวอักษรไทยอ่านออกไหม — ถ้า charset ผิดจะได้ replacement char หรือ latin1 mojibake */
function looksLikeThai(s: string) {
  return /[฀-๿]/.test(s)
}

const WRITE_PRIVILEGES =
  /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT OPTION)\b/i

/**
 * ทดสอบค่าที่ผู้ใช้กรอกในหน้าเว็บ โดยยังไม่ต้องบันทึกลง DB
 * ตอบกลับเป็นรายการ check ให้แสดงผลทีละข้อ ผู้ใช้จะได้เห็นว่าพังตรงไหน
 */
export async function testHosxpConnection(config: HosxpConfig): Promise<TestResult> {
  const checks: TestCheck[] = []
  let client: HosxpClient | null = null

  try {
    client = await HosxpClient.connect(config)
  } catch (error) {
    return {
      ok: false,
      checks: [
        {
          label: 'เชื่อมต่อฐานข้อมูล',
          status: 'fail',
          detail: `${error.code ?? ''} ${error.message}`.trim(),
        },
      ],
    }
  }

  checks.push({
    label: 'เชื่อมต่อฐานข้อมูล',
    status: 'ok',
    detail: `ต่อ ${config.host}:${config.port}/${config.database} สำเร็จ`,
  })

  // --- เวอร์ชันและ charset ของ server ---------------------------------------
  try {
    const vars = await client.select<{ Variable_name: string; Value: string }>(
      `SHOW VARIABLES WHERE Variable_name IN
       ('version','character_set_database','collation_database','time_zone')`
    )
    const get = (n: string) => vars.find((v) => v.Variable_name === n)?.Value ?? '?'

    checks.push({
      label: 'เวอร์ชัน MySQL',
      status: 'ok',
      detail: get('version'),
    })
    checks.push({
      label: 'Charset ของฐานข้อมูล',
      status: 'ok',
      detail: `${get('character_set_database')} / ${get('collation_database')} — ที่เลือกไว้คือ ${config.charset}`,
    })
  } catch (error) {
    checks.push({ label: 'อ่านค่า server', status: 'warn', detail: error.message })
  }

  // --- เวลาต่างกันเท่าไร -----------------------------------------------------
  try {
    const [row] = await client.select<{ db_epoch: number }>(`SELECT UNIX_TIMESTAMP() AS db_epoch`)
    const skew = Math.floor(Date.now() / 1000) - Number(row.db_epoch)

    checks.push({
      label: 'ส่วนต่างเวลากับ DB',
      status: Math.abs(skew) > 60 ? 'warn' : 'ok',
      detail:
        Math.abs(skew) > 60
          ? `ต่างกัน ${skew} วินาที — การ poll ด้วย timestamp อาจข้ามหรือส่งซ้ำ ควรตั้งเวลาให้ตรงกัน`
          : `ต่างกัน ${skew} วินาที`,
    })
  } catch (error) {
    checks.push({ label: 'ส่วนต่างเวลากับ DB', status: 'warn', detail: error.message })
  }

  // --- สิทธิ์ของ user --------------------------------------------------------
  try {
    const grants = await client.select(`SHOW GRANTS FOR CURRENT_USER()`)
    const lines = grants.map((g) => String(Object.values(g)[0]))
    const writable = lines.filter((l) => WRITE_PRIVILEGES.test(l))

    checks.push({
      label: 'สิทธิ์ของ user',
      status: writable.length ? 'warn' : 'ok',
      detail: writable.length
        ? `user นี้เขียนฐาน HOSxP ได้ ซึ่งเกินความจำเป็น แนะนำให้ใช้ user ที่มีแค่ SELECT — ${writable.join(' | ')}`
        : `SELECT อย่างเดียว ถูกต้อง`,
    })
  } catch (error) {
    checks.push({
      label: 'สิทธิ์ของ user',
      status: 'warn',
      detail: `ตรวจไม่ได้: ${error.message}`,
    })
  }

  // --- อ่านภาษาไทยออกไหม -----------------------------------------------------
  try {
    const rows = await client.select<{
      hn: string
      cid: string
      pname: string
      fname: string
      lname: string
    }>(`SELECT hn, cid, pname, fname, lname FROM patient LIMIT 5`)

    const named = rows.filter((r) => r.fname)
    const readable = named.filter((r) => looksLikeThai(`${r.fname}${r.lname}`))

    if (!named.length) {
      checks.push({
        label: 'อ่านภาษาไทย',
        status: 'warn',
        detail: 'ตาราง patient ไม่มีข้อมูลชื่อให้ทดสอบ',
      })
    } else {
      const sample = named
        .slice(0, 3)
        .map((r) => `${r.pname ?? ''}${r.fname} ${r.lname} (hn ${mask(r.hn)})`)
        .join(' · ')

      checks.push({
        label: 'อ่านภาษาไทย',
        status: readable.length ? 'ok' : 'fail',
        detail: readable.length
          ? sample
          : `อ่านออกมาเป็นตัวขยะ ลองเปลี่ยน charset — ที่ได้: ${sample}`,
      })
    }
  } catch (error) {
    checks.push({
      label: 'อ่านภาษาไทย',
      status: 'fail',
      detail: `อ่านตาราง patient ไม่ได้: ${error.message}`,
    })
  }

  await client.close()

  return {
    ok: checks.every((c) => c.status !== 'fail'),
    checks,
  }
}
