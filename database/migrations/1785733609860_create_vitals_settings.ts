import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * แจ้งเตือนความดันโลหิตสูงเข้ากลุ่มเจ้าหน้าที่
 *
 * อ่าน `opdscreen` ของ HOSxP ซึ่งเก็บผลคัดกรองแรกรับ — `bps` คือค่าบน
 * `bpd` คือค่าล่าง ทั้งคู่เป็น double
 *
 * ตั้งต้นปิดไว้เหมือนทุกอย่างที่ส่งออกนอกระบบ ต้องมีคนกดเปิดในหน้าเว็บ
 * และตั้งต้นไม่เปิดเผยชื่อกับ HN ด้วย
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('vitals_settings', (table) => {
      table.increments('id')
      table.boolean('is_enabled').notNullable().defaultTo(false)
      table.integer('group_id').unsigned().nullable().references('id').inTable('notify_groups')

      // เกณฑ์ความดัน — เข้าเกณฑ์เมื่อค่าบนถึงเกณฑ์ "หรือ" ค่าล่างถึงเกณฑ์
      table.integer('sys_threshold').notNullable().defaultTo(140)
      table.integer('dia_threshold').notNullable().defaultTo(90)

      // กรองรายแผนก เหมือน CDCU กรองรายโรค
      table.boolean('all_departments').notNullable().defaultTo(true)
      table.json('department_codes').nullable()

      // ข้อมูลที่ระบุตัวผู้ป่วยได้ ตั้งต้นปิดทั้งหมด
      table.boolean('include_hn').notNullable().defaultTo(false)
      table.boolean('include_name').notNullable().defaultTo(false)

      table.string('quiet_start', 5).notNullable().defaultTo('21:00')
      table.string('quiet_end', 5).notNullable().defaultTo('07:00')

      /**
       * รวมเคสที่พบในรอบเดียวเป็นข้อความเดียว แล้วเว้นระยะก่อนส่งรอบถัดไป
       *
       * สำคัญมากกับงานนี้ — ที่เกณฑ์ 140/90 โรงพยาบาลนี้มีราว 55 รายต่อวัน
       * ถ้าส่งทีละรายกลุ่มจะโดนปิดเสียงภายในสัปดาห์เดียวแล้วฟีเจอร์นี้ก็ตายไป
       */
      table.integer('throttle_minutes').notNullable().defaultTo(60)

      table.timestamp('last_run_at').nullable()
      table.string('last_run_note', 255).nullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').notNullable()
    })

    /**
     * กันแจ้งซ้ำ — หนึ่ง vn แจ้งครั้งเดียวตลอดกาล
     *
     * ตรวจแล้วว่า opdscreen มีหนึ่งแถวต่อหนึ่ง vn (367 แถว = 367 vn ในวันที่ตรวจ)
     * จึงใช้ vn เป็นกุญแจกันซ้ำได้ตรง ๆ ไม่ต้องพึ่ง hos_guid ซึ่งเป็น PK จริง
     * แต่เอามาเทียบข้ามรอบลำบากกว่า
     */
    this.schema.createTable('vitals_seen', (table) => {
      table.increments('id')
      table.string('vn', 13).notNullable().unique()
      table.string('hn', 16).nullable()
      table.integer('bps').nullable()
      table.integer('bpd').nullable()
      table.string('dep', 16).nullable()
      table.date('vstdate').nullable()
      table.boolean('notified').notNullable().defaultTo(false)
      table.timestamp('created_at').notNullable()

      table.index(['vstdate'], 'vitals_seen_vstdate_index')
    })
  }

  async down() {
    this.schema.dropTable('vitals_seen')
    this.schema.dropTable('vitals_settings')
  }
}
