import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'notify_datasets'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // ชื่อคอลัมน์ที่ชุดข้อมูลนี้คืนมาครั้งล่าสุด
      // เก็บไว้ให้ตัวแก้ไขการ์ดเสนอเป็น dropdown ได้ โดยไม่ต้องยิง query
      // ไปที่เครื่องโรงพยาบาลทุกครั้งที่เปิดหน้าแก้เทมเพลต
      table.json('last_columns').nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('last_columns')
    })
  }
}
