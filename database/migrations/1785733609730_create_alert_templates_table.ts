import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'alert_templates'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      // welcome | queue_notify | queue_near | queue_changed — ดู app/services/alert_cases.ts
      table.string('case_key').notNullable().unique()

      table.string('header').notNullable()
      table.text('line_text').notNullable()
      table.string('message_title').notNullable()
      table.text('message_html').notNullable()
      table.string('message_text').notNullable()

      // ลิงก์ตรวจสอบคิว เว้นว่าง = การ์ดไม่มีปุ่ม
      table.string('check_url').nullable()

      table.boolean('is_enabled').notNullable().defaultTo(true)

      // ใช้กับเคส queue_near — ส่งเมื่อคิวที่รอเหลือน้อยกว่าหรือเท่ากับค่านี้
      table.integer('threshold').nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
