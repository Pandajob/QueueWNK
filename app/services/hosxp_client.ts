import mysql from 'mysql2/promise'

export type HosxpConfig = {
  host: string
  port: number
  database: string
  username: string
  password: string
  charset: string
}

/**
 * HOSxP v3 เก็บภาษาไทยเป็น tis620 เป็นส่วนใหญ่ mysql2 รับชื่อ collation
 * ไม่ใช่ชื่อ charset เปล่า ๆ ถ้าจับคู่ผิดชื่อผู้ป่วยจะอ่านออกมาเป็นตัวขยะ
 * แล้วเราจะส่งชื่อขยะนั้นเข้า MOPH Alert ตรง ๆ
 */
const COLLATIONS: Record<string, string> = {
  tis620: 'TIS620_THAI_CI',
  utf8mb4: 'UTF8MB4_UNICODE_CI',
  utf8: 'UTF8_GENERAL_CI',
  latin1: 'LATIN1_SWEDISH_CI',
}

export const SUPPORTED_CHARSETS = Object.keys(COLLATIONS)

/**
 * คำสั่งแรกต้องเป็นการอ่านเท่านั้น
 *
 * แค่นี้พอจริง ๆ เพราะ `multipleStatements: false` ทำให้ต่อคำสั่งที่สอง
 * ด้วย `;` ไม่ได้ คำสั่งเดี่ยวที่ขึ้นต้นด้วย SELECT จึงเขียนข้อมูลไม่ได้
 *
 * เคยใช้ blacklist คำสั่งเขียน (insert|update|delete|…) ควบด้วย แต่ถอดออก
 * เพราะมันจับ false positive จาก string literal เช่น
 * `COLUMN_NAME REGEXP '(date|time|update|modif|seq)'` ซึ่งเป็น SELECT ปกติ
 * blacklist แบบนั้นไม่ได้กันอะไรเพิ่ม แต่ทำให้ query ที่ถูกต้องพัง
 */
const READ_ONLY_VERB = /^(select|show|describe|desc|explain|with)\b/i

/** ข้อยกเว้นเดียวที่ SELECT เขียนลงดิสก์ได้ */
const WRITES_TO_DISK = /\binto\s+(outfile|dumpfile)\b/i

/** ตัด comment นำหน้าออกก่อน ไม่ให้ซ่อนคำสั่งจริงไว้หลัง `/* *​/` หรือ `--` */
function stripLeadingComments(sql: string) {
  let s = sql.trim()
  let previous: string

  do {
    previous = s
    s = s.replace(/^\/\*[\s\S]*?\*\//, '').trim()
    s = s.replace(/^--[^\n]*\n?/, '').trim()
    s = s.replace(/^#[^\n]*\n?/, '').trim()
  } while (s !== previous)

  return s
}

export class ReadOnlyViolation extends Error {
  constructor(sql: string) {
    super(`ปฏิเสธ SQL ที่ไม่ใช่การอ่าน: ${sql.slice(0, 120)}`)
    this.name = 'ReadOnlyViolation'
  }
}

/** แยกออกมาให้เทสต์ได้ — ดู tests/unit/hosxp_read_only.spec.ts */
export function isReadOnlyStatement(sql: string) {
  const statement = stripLeadingComments(sql)
  return READ_ONLY_VERB.test(statement) && !WRITES_TO_DISK.test(statement)
}

/**
 * ตัวห่อ mysql2 ที่ยอมให้ทำได้แค่ SELECT
 *
 * ไม่ใช้ Lucid ต่อ HOSxP โดยตั้งใจ — Lucid มี migration runner และ model ที่ save() ได้
 * ซึ่งเผลอเขียนทับฐาน HOSxP ได้ ชั้นนี้ทำให้ "เขียนไม่ได้" เป็นคุณสมบัติของโค้ด
 * ไม่ใช่แค่ข้อตกลงว่าจะไม่ทำ (สิทธิ์ระดับ MySQL คือด่านที่สอง)
 */
export class HosxpClient {
  constructor(private connection: mysql.Connection) {}

  static async connect(config: HosxpConfig) {
    const connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
      charset: COLLATIONS[config.charset] ?? COLLATIONS.tis620,
      // อ่าน date/datetime เป็น string ดิบ ไม่ให้ driver แปลง timezone ให้
      // HOSxP เก็บเป็นเวลาท้องถิ่นอยู่แล้ว การแปลงจะทำให้เพี้ยน 7 ชั่วโมง
      dateStrings: true,
      multipleStatements: false,
      connectTimeout: 10_000,
    })

    return new HosxpClient(connection)
  }

  async select<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (!isReadOnlyStatement(sql)) {
      throw new ReadOnlyViolation(sql)
    }

    const [rows] = await this.connection.query(sql, params)
    return rows as T[]
  }

  async close() {
    await this.connection.end().catch(() => {})
  }
}
