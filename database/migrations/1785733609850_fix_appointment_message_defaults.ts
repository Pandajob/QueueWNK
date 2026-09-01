import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * MariaDB ไม่ยอมให้คอลัมน์ TEXT มีค่าตั้งต้น เมื่อเปิด strict mode การสร้างแถวแรก
 * จึงล้มด้วย "Field 'message_text' doesn't have a default value"
 *
 * เปลี่ยนเป็นให้ว่างได้ แล้วให้โค้ดใช้ข้อความตั้งต้นแทนเมื่อยังไม่ได้ตั้งเอง
 * (ดู DEFAULT_TEXT / DEFAULT_HTML ใน appointment_reminder.ts)
 */
export default class extends BaseSchema {
  protected tableName = 'appointment_settings'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.text('message_text').nullable().alter()
      table.text('message_html').nullable().alter()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.text('message_text').notNullable().alter()
      table.text('message_html').notNullable().alter()
    })
  }
}
