import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'notify_templates'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // text | flex
      table.string('message_type', 10).notNullable().defaultTo('text')

      // ข้อความที่ LINE แสดงในรายการแชทและใน notification ก่อนเปิดการ์ด
      // Flex บังคับต้องมี ไม่งั้นคนที่ปิดแอปอยู่จะเห็นแค่ "ข้อความ"
      table.string('alt_text', 200).nullable()

      // โครงสร้างการ์ดเป็นรายการบล็อก ไม่ใช่ Flex JSON ดิบ
      // เก็บเป็นบล็อกเพื่อให้แก้จากหน้าเว็บได้ แล้วค่อยแปลงเป็น Flex ตอนส่ง
      table.json('flex_blocks').nullable()

      table.string('flex_color', 20).notNullable().defaultTo('#00857c')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('message_type')
      table.dropColumn('alt_text')
      table.dropColumn('flex_blocks')
      table.dropColumn('flex_color')
    })
  }
}
