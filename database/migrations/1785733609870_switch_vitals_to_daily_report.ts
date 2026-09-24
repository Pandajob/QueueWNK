import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * เปลี่ยนแจ้งเตือนความดันจาก "เฝ้าตลอดเวลาแล้วรวบส่ง" เป็น "ส่งรอบเดียวต่อวัน"
 *
 * ของเดิมเฝ้าทุกนาทีแล้วใช้ throttle คุมความถี่ ของใหม่ส่งวันละครั้งเวลาที่กำหนด
 * ช่วงเวลางดส่งกับ throttle จึงไม่มีความหมายอีกต่อไป — เวลาส่งถูกกำหนดตายตัวแล้ว
 *
 * ช่วงข้อมูลของแต่ละรอบคือ "ตั้งแต่รอบที่แล้วถึงตอนนี้" ไม่ใช่ทั้งวัน
 * รายที่คัดกรองหลังเวลาส่งของวันนี้จึงตกไปอยู่ในรอบของวันถัดไปโดยอัตโนมัติ
 * ไม่มีใครหล่นหาย และไม่มีใครถูกแจ้งซ้ำสองรอบ
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('vitals_settings', (table) => {
      table.string('send_at', 5).notNullable().defaultTo('15:00')
      table.date('last_run_date').nullable()

      // ที่อยู่กับเบอร์โทร — ต้องมีเพื่อให้ รพ.สต. ตามเยี่ยมได้
      table.boolean('include_address').notNullable().defaultTo(true)
      table.boolean('include_phone').notNullable().defaultTo(true)

      table.dropColumn('quiet_start')
      table.dropColumn('quiet_end')
      table.dropColumn('throttle_minutes')
    })

    /**
     * แถวตั้งค่าถูกสร้างไว้แล้วตอน migration ก่อนหน้า โดยที่ include_hn กับ
     * include_name เป็น false — การเปลี่ยน default ของคอลัมน์ไม่ย้อนไปแก้แถวเดิม
     * จึงต้องสั่งเปิดให้ตรงกับที่ผู้ใช้ระบุว่าต้องมีข้อมูลเหล่านี้ในข้อความ
     */
    this.defer(async (db) => {
      await db.from('vitals_settings').update({
        include_hn: true,
        include_name: true,
        sys_threshold: 139,
        dia_threshold: 90,
      })
    })
  }

  async down() {
    this.schema.alterTable('vitals_settings', (table) => {
      table.string('quiet_start', 5).notNullable().defaultTo('21:00')
      table.string('quiet_end', 5).notNullable().defaultTo('07:00')
      table.integer('throttle_minutes').notNullable().defaultTo(60)

      table.dropColumn('send_at')
      table.dropColumn('last_run_date')
      table.dropColumn('include_address')
      table.dropColumn('include_phone')
    })
  }
}
