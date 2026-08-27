import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { writeFile } from 'node:fs/promises'

/** จำนวนแถวสูงสุดที่ยอมสแกนตอนประเมินคุณภาพข้อมูล — กันไม่ให้ไปกวนฐาน production */
const SAMPLE_SIZE = 20_000

/**
 * สำรวจโครงสร้างฐาน HOSxP โดยใช้ค่าที่ตั้งไว้ในหน้าเว็บ
 *
 *   docker compose run --rm web node ace hosxp:discover
 *
 * อ่านอย่างเดียว ผ่าน HosxpClient ที่ปฏิเสธ SQL ที่ไม่ใช่ SELECT
 * ผลลัพธ์เขียนลง docs/hosxp-schema.md (อยู่ใน .gitignore เพราะมีชื่อคอลัมน์
 * และตัวอย่างข้อมูลของโรงพยาบาล)
 */
export default class HosxpDiscover extends BaseCommand {
  static commandName = 'hosxp:discover'
  static description = 'สำรวจตาราง/คอลัมน์ที่เกี่ยวกับคิวในฐาน HOSxP'
  static options: CommandOptions = { startApp: true }

  @flags.string({ description: 'ไฟล์ผลลัพธ์', default: 'docs/hosxp-schema.md' })
  declare out: string

  @flags.string({ description: 'ระบุตารางที่ต้องการดูคอลัมน์ คั่นด้วย , (ไม่ระบุ = เดาจากชื่อ)' })
  declare tables?: string

  /** ชื่อที่ใช้ค้นหา ไม่ได้ hard-code ว่าต้องมีตารางไหน */
  static HINTS = ['queue', 'ovst', 'patient', 'opdscreen', 'depart', 'spclty', 'person', 'visit']

  static CORE = ['patient', 'ovst', 'opdscreen', 'kskdepartment', 'spclty']

  #lines: string[] = []
  #say(text = '') {
    this.#lines.push(text)
  }

  #table(rows: Record<string, unknown>[], columns: string[]) {
    if (!rows.length) {
      this.#say('_(ไม่มีข้อมูล)_\n')
      return
    }
    this.#say('| ' + columns.join(' | ') + ' |')
    this.#say('|' + columns.map(() => '---').join('|') + '|')
    for (const row of rows) {
      this.#say(
        '| ' + columns.map((c) => String(row[c] ?? '').replace(/\|/g, '\\|')).join(' | ') + ' |'
      )
    }
    this.#say('')
  }

  #mask(value: unknown) {
    const s = String(value ?? '')
    if (/^\d{13}$/.test(s)) return `${s.slice(0, 4)}xxxxx${s.slice(9)}`
    if (s.length > 6) return `${s.slice(0, 3)}***${s.slice(-2)}`
    return s
  }

  async run() {
    const { default: HosxpConnection } = await import('#models/hosxp_connection')
    const { HosxpClient } = await import('#services/hosxp_client')

    const settings = await HosxpConnection.active()
    if (!settings || !settings.password) {
      this.logger.error('ยังไม่ได้ตั้งค่าการเชื่อมต่อ HOSxP — ตั้งค่าที่ /settings/hosxp ก่อน')
      this.exitCode = 1
      return
    }

    this.logger.info(`กำลังต่อ ${settings.host}:${settings.port}/${settings.database}`)

    const client = await HosxpClient.connect({
      host: settings.host,
      port: settings.port,
      database: settings.database,
      username: settings.username,
      password: settings.password,
      charset: settings.charset,
    })

    const db = settings.database
    const hints = HosxpDiscover.HINTS

    this.#say('# HOSxP schema discovery')
    this.#say('')
    this.#say(`- host: \`${settings.host}:${settings.port}\``)
    this.#say(`- database: \`${db}\``)
    this.#say(`- charset ที่ใช้ต่อ: \`${settings.charset}\``)
    this.#say(`- สำรวจเมื่อ: ${new Date().toISOString()}`)
    this.#say('')

    // 1. server -------------------------------------------------------------
    this.#say('## 1. Server')
    this.#say('')
    this.#table(
      await client.select(
        `SHOW VARIABLES WHERE Variable_name IN
         ('version','version_comment','character_set_server','collation_server',
          'character_set_database','collation_database','time_zone','system_time_zone','sql_mode')`
      ),
      ['Variable_name', 'Value']
    )

    const [clock] = await client.select<{ db_now: string; db_epoch: number }>(
      `SELECT NOW() AS db_now, UNIX_TIMESTAMP() AS db_epoch`
    )
    this.#say(`- เวลาใน DB: \`${clock.db_now}\``)
    this.#say(
      `- ต่างจากเครื่องนี้: ${Math.floor(Date.now() / 1000) - Number(clock.db_epoch)} วินาที`
    )
    this.#say('')

    // 2. สิทธิ์ --------------------------------------------------------------
    this.#say('## 2. สิทธิ์ของ user')
    this.#say('')
    try {
      const grants = await client.select(`SHOW GRANTS FOR CURRENT_USER()`)
      for (const g of grants) this.#say('    ' + Object.values(g)[0])
    } catch (error) {
      this.#say(`_อ่านสิทธิ์ไม่ได้: ${error.message}_`)
    }
    this.#say('')

    // 3. ตารางที่เข้าข่าย -----------------------------------------------------
    //
    // ใช้ SHOW TABLES ไม่ใช่ INFORMATION_SCHEMA.TABLES โดยตั้งใจ
    // การขอ TABLE_ROWS / UPDATE_TIME บังคับให้ MySQL เปิดทุกไฟล์ตารางเพื่ออ่าน
    // สถิติ ซึ่งบนฐาน HOSxP ที่มีตารางหลักพันตารางใช้เวลาหลายนาทีจนดูเหมือนค้าง
    this.#say('## 3. ตารางที่ชื่อเข้าข่าย')
    this.#say('')

    const allTables = (await client.select<Record<string, string>>(`SHOW TABLES`)).map(
      (row) => Object.values(row)[0]
    )

    const candidates = allTables
      .filter((name) => hints.some((h) => name.toLowerCase().includes(h)))
      .sort()

    this.#say(`ทั้งฐานมี ${allTables.length} ตาราง เข้าข่าย ${candidates.length} ตาราง`)
    this.#say('')
    this.#table(
      candidates.map((name) => ({ TABLE_NAME: name })),
      ['TABLE_NAME']
    )
    this.logger.info(`พบตารางเข้าข่าย ${candidates.length} จากทั้งหมด ${allTables.length}`)

    // 4. คอลัมน์ -------------------------------------------------------------
    this.#say('## 4. คอลัมน์ของตารางหลัก')
    this.#say('')
    // เลือกตารางคิวตามความน่าจะเกี่ยวข้อง ไม่ใช่เรียงตามตัวอักษร
    // ฐานนี้มีตารางที่ชื่อมี "queue" เป็นร้อย ส่วนใหญ่เป็นคิวห้องแล็บ/ห้องยา/พิมพ์เอกสาร
    // ที่เราต้องการคือคิวห้องตรวจ OPD
    const wanted = this.tables
      ? this.tables.split(',').map((t) => t.trim())
      : candidates.filter((name) =>
          /^(opd_queue|opd_dep_queue|opd_gen_queue|opd_previsit_queue|ovst_queue|ovst_seq)/i.test(
            name
          )
        )

    for (const tableName of [...new Set([...HosxpDiscover.CORE, ...wanted])]) {
      const columns = await client.select(
        `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA,
                CHARACTER_SET_NAME, COLUMN_COMMENT
           FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION`,
        [db, tableName]
      )
      if (!columns.length) continue

      this.#say(`### \`${tableName}\``)
      this.#say('')
      this.#table(columns, [
        'COLUMN_NAME',
        'COLUMN_TYPE',
        'IS_NULLABLE',
        'COLUMN_KEY',
        'EXTRA',
        'CHARACTER_SET_NAME',
        'COLUMN_COMMENT',
      ])
    }

    // 5. ภาษาไทย ------------------------------------------------------------
    this.#say('## 5. ตัวอย่างภาษาไทย')
    this.#say('')
    try {
      const rows = await client.select<Record<string, string>>(
        `SELECT hn, cid, pname, fname, lname FROM patient LIMIT 5`
      )
      for (const r of rows) {
        this.#say(
          `- hn \`${this.#mask(r.hn)}\` · cid \`${this.#mask(r.cid)}\` → ${r.pname ?? ''}${r.fname} ${r.lname}`
        )
      }
    } catch (error) {
      this.#say(`_อ่าน patient ไม่ได้: ${error.message}_`)
    }
    this.#say('')

    // 6. watermark ----------------------------------------------------------
    this.#say('## 6. คอลัมน์ที่ใช้ทำ watermark ได้')
    this.#say('')
    this.#say('poller ต้องรู้ว่าอ่านถึงไหนแล้ว ต้องมี auto_increment หรือ timestamp ที่เชื่อถือได้')
    this.#say('')

    // จำกัดเฉพาะตารางที่เข้าข่าย — ถ้าปล่อยให้ scan ทั้ง schema
    // MySQL ต้องเปิด table definition ทุกตัวและใช้เวลาหลายนาที
    if (candidates.length) {
      const placeholders = candidates.map(() => '?').join(',')
      this.#table(
        await client.select(
          `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, EXTRA
             FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})
              AND (EXTRA LIKE '%auto_increment%'
                   OR DATA_TYPE IN ('timestamp','datetime')
                   OR COLUMN_NAME REGEXP '(date|time|update|modif|seq)')
            ORDER BY TABLE_NAME, ORDINAL_POSITION`,
          [db, ...candidates]
        ),
        ['TABLE_NAME', 'COLUMN_NAME', 'COLUMN_TYPE', 'EXTRA']
      )
    }

    // 7. ปริมาณงาน ----------------------------------------------------------
    this.#say('## 7. ปริมาณ visit ต่อวัน (7 วันล่าสุด)')
    this.#say('')
    try {
      this.#table(
        await client.select(
          `SELECT vstdate, COUNT(*) AS visits
             FROM ovst
            WHERE vstdate >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
            GROUP BY vstdate ORDER BY vstdate DESC`
        ),
        ['vstdate', 'visits']
      )
    } catch (error) {
      this.#say(`_นับ visit ไม่ได้: ${error.message}_`)
    }

    // 8. ความครบถ้วนของ cid --------------------------------------------------
    this.#say('## 8. ความครบถ้วนของ cid')
    this.#say('')
    this.#say('cid คือ key เดียวที่ MOPH Alert ใช้ ถ้าไม่ครบ 13 หลัก = ส่งไม่ได้')
    this.#say('')
    this.#say(
      `**ตัวเลขที่ใช้ตัดสินใจคือชุดที่สอง** — ทั้งตาราง patient รวมทะเบียนเก่าที่ไม่มีวันกลับมา` +
        ` ส่วนที่สำคัญคือคนที่เดินเข้ามารับบริการจริง`
    )
    this.#say('')

    this.#say(`### ตัวอย่าง ${SAMPLE_SIZE.toLocaleString()} แถวแรกของ patient`)
    this.#say('')
    try {
      // สุ่มตัวอย่างแทนการนับทั้งตาราง — REGEXP ทุกแถวบนตาราง patient
      // ของโรงพยาบาลจริงคือ full table scan ที่ไปเพิ่มภาระให้ระบบ production
      this.#table(
        await client.select(
          `SELECT COUNT(*) AS sampled,
                  SUM(CASE WHEN cid IS NULL OR cid = '' THEN 1 ELSE 0 END) AS cid_empty,
                  SUM(CASE WHEN cid REGEXP '^[0-9]{13}$' THEN 1 ELSE 0 END) AS cid_valid
             FROM (SELECT cid FROM patient LIMIT ${SAMPLE_SIZE}) AS sample`
        ),
        ['sampled', 'cid_empty', 'cid_valid']
      )
    } catch (error) {
      this.#say(`_นับ cid ไม่ได้: ${error.message}_`)
    }

    this.#say('### ผู้มารับบริการจริง 7 วันล่าสุด')
    this.#say('')
    try {
      this.#table(
        await client.select(
          `SELECT o.vstdate,
                  COUNT(*) AS visits,
                  SUM(CASE WHEN p.cid REGEXP '^[0-9]{13}$' THEN 1 ELSE 0 END) AS cid_valid
             FROM ovst o
             JOIN patient p ON p.hn = o.hn
            WHERE o.vstdate >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
            GROUP BY o.vstdate
            ORDER BY o.vstdate DESC`
        ),
        ['vstdate', 'visits', 'cid_valid']
      )
    } catch (error) {
      this.#say(`_นับ cid ของผู้มารับบริการไม่ได้: ${error.message}_`)
    }

    await client.close()

    await writeFile(this.out, this.#lines.join('\n'), 'utf8')
    this.logger.success(`เขียนผลสำรวจลง ${this.out}`)
  }
}
