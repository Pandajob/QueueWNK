import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * เติมรายละเอียดเคสย้อนหลังให้แถวที่บันทึกไว้ก่อนมีคอลัมน์เหล่านี้
 *
 *   docker compose exec web node ace vitals:backfill --dry
 *   docker compose exec web node ace vitals:backfill
 *
 * อ่านจาก HOSxP ตาม vn ที่มีอยู่แล้วใน `vitals_seen` แล้วเติมชื่อ ที่อยู่ เบอร์โทร
 * และสถานพยาบาลรอง — แถวที่มีข้อมูลครบแล้วจะถูกข้าม รันซ้ำได้ไม่เสียหาย
 *
 * ไม่แตะ `notified` และไม่ส่งอะไรทั้งสิ้น
 */
export default class VitalsBackfill extends BaseCommand {
  static commandName = 'vitals:backfill'
  static description = 'เติมชื่อ/ที่อยู่/รพ.สต. ย้อนหลังให้เคสความดันที่บันทึกไว้แล้ว'
  static options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'ดูอย่างเดียว ไม่เขียนลงฐาน' })
  declare dry: boolean

  @flags.number({ description: 'ทำทีละกี่แถว (ค่าตั้งต้น 200)', default: 200 })
  declare limit: number

  async run() {
    const { default: db } = await import('@adonisjs/lucid/services/db')
    const { withHosxp } = await import('#services/hosxp_session')

    const pending = await db
      .from('vitals_seen')
      .select('vn')
      .whereNull('hospsub')
      .whereNull('fname')
      .limit(this.limit)

    if (!pending.length) {
      this.logger.info('ไม่มีแถวที่ต้องเติม — ครบแล้วทั้งหมด')
      return
    }

    this.logger.info(`พบ ${pending.length} แถวที่ยังไม่มีรายละเอียด`)

    const vns = pending.map((row) => row.vn as string)
    const marks = vns.map(() => '?').join(',')

    /**
     * ดึงเฉพาะฟิลด์ที่ต้องเติม ใช้เงื่อนไข join ชุดเดียวกับ vitals_watcher
     * ถ้าแก้ตรงนั้นต้องแก้ตรงนี้ด้วย — เป็นคำสั่งใช้ครั้งเดียวจึงยอมให้ซ้ำได้
     */
    const rows = await withHosxp((client) =>
      client.select<Record<string, unknown>>(
        `SELECT s.vn, p.pname, p.fname, p.lname,
                CONCAT_WS(' ',
                  NULLIF(p.addrpart, ''),
                  CASE WHEN NULLIF(p.moopart,'') IS NULL THEN NULL ELSE CONCAT('ม.', p.moopart) END,
                  CASE WHEN t.name IS NULL THEN NULL ELSE CONCAT('ต.', t.name) END,
                  CASE WHEN a.name IS NULL THEN NULL ELSE CONCAT('อ.', a.name) END,
                  CASE WHEN c.name IS NULL OR p.chwpart = hc.chwpart THEN NULL
                       ELSE CONCAT('จ.', c.name) END
                ) AS addr,
                COALESCE(NULLIF(p.mobile_phone_number,''), NULLIF(p.hometel,'')) AS tel,
                v.hospsub, h.name AS hospsub_name,
                CASE WHEN h.chwpart = hc.chwpart AND h.amppart = hc.amppart THEN 1 ELSE 0 END
                  AS in_district,
                TIMESTAMP(s.vstdate, COALESCE(s.vsttime, '00:00:00')) AS screened_at
           FROM opdscreen s
           LEFT JOIN vn_stat v ON v.vn = s.vn
           LEFT JOIN patient p ON p.hn = s.hn
           LEFT JOIN hospcode h ON h.hospcode = v.hospsub
           LEFT JOIN thaiaddress t ON t.chwpart=p.chwpart AND t.amppart=p.amppart
                                  AND t.tmbpart=p.tmbpart AND t.codetype='3'
           LEFT JOIN thaiaddress a ON a.chwpart=p.chwpart AND a.amppart=p.amppart
                                  AND a.tmbpart='00' AND a.codetype='2'
           LEFT JOIN thaiaddress c ON c.chwpart=p.chwpart AND c.amppart='00'
                                  AND c.tmbpart='00' AND c.codetype='1'
           LEFT JOIN opdconfig oc ON 1 = 1
           LEFT JOIN hospcode hc ON hc.hospcode = oc.hospitalcode
          WHERE s.vn IN (${marks})`,
        vns
      )
    )

    if (!rows) {
      this.logger.error('ยังไม่ได้ตั้งค่าการเชื่อมต่อ HOSxP')
      this.exitCode = 1
      return
    }

    this.logger.info(`อ่านจาก HOSxP ได้ ${rows.length} แถว`)

    if (this.dry) {
      for (const row of rows.slice(0, 5)) {
        this.logger.log(
          `  ${row.vn} · ${row.pname ?? ''}${row.fname ?? ''} ${row.lname ?? ''} · ` +
            `${row.addr ?? '-'} · ${row.hospsub_name ?? 'ไม่ระบุ'}`
        )
      }
      this.logger.info('โหมดดูอย่างเดียว ไม่ได้เขียนลงฐาน')
      return
    }

    let updated = 0
    for (const row of rows) {
      await db
        .from('vitals_seen')
        .where('vn', row.vn as string)
        .update({
          pname: row.pname ?? null,
          fname: row.fname ?? null,
          lname: row.lname ?? null,
          addr: row.addr ?? null,
          tel: row.tel ?? null,
          hospsub: row.hospsub ?? null,
          hospsub_name: row.hospsub_name ?? null,
          in_district: Number(row.in_district) === 1 ? 1 : 0,
          screened_at: (row.screened_at as Date | null) ?? null,
        })
      updated++
    }

    this.logger.success(`เติมข้อมูลแล้ว ${updated} แถว`)

    const left = await db.from('vitals_seen').whereNull('fname').count('* as n')
    this.logger.info(
      `เหลือที่ยังไม่มีชื่อ ${left[0]?.n ?? 0} แถว (อาจเป็นแถวที่ HOSxP ไม่มีข้อมูลแล้ว)`
    )
  }
}
