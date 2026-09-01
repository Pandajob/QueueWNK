import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * ตั้งค่าการแจ้งเตือนนัดหมายล่วงหน้าผ่านหมอพร้อม
 *
 * ตั้งต้นปิดไว้และ dry run เปิดอยู่ เหมือนทุกอย่างที่ส่งถึงผู้ป่วยจริงในระบบนี้
 * เปิดใช้เมื่อไรต้องเป็นการตัดสินใจของคนติดตั้ง ไม่ใช่ผลข้างเคียงของการอัปเกรด
 */
export default class extends BaseSchema {
  protected tableName = 'appointment_settings'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table.boolean('is_enabled').notNullable().defaultTo(false)
      table.boolean('dry_run').notNullable().defaultTo(true)

      // ส่งล่วงหน้ากี่วัน 1 = แจ้งวันนี้ว่าพรุ่งนี้มีนัด
      table.integer('days_ahead').notNullable().defaultTo(1)

      // เวลาที่จะส่งในแต่ละวัน รูปแบบ HH:mm
      // ค่าตั้งต้นเย็นก่อนวันนัด คนยังไม่นอนและยังจำได้ถึงพรุ่งนี้
      table.string('send_at', 5).notNullable().defaultTo('18:00')

      // เลือกเฉพาะบางคลินิกได้ ว่างหรือ watch_all = ส่งทุกคลินิก
      table.boolean('all_clinics').notNullable().defaultTo(true)
      table.json('clinic_codes').nullable()

      // ข้อความ ใช้ตัวยึดแบบเดียวกับหน้าเทมเพลตอื่น
      table.string('message_title', 120).notNullable().defaultTo('แจ้งเตือนนัดหมาย')
      table.text('message_text').notNullable().defaultTo('')
      table.text('message_html').notNullable().defaultTo('')

      // กันรันซ้ำในวันเดียวกันเวลา worker รีสตาร์ต
      table.date('last_run_date').nullable()
      table.timestamp('last_run_at', { useTz: true }).nullable()
      table.text('last_run_note').nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
