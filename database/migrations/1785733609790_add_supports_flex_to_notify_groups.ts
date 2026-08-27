import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * บางกลุ่มปลายทางรับการ์ด Flex ไม่ได้
 *
 * MOPH Notify ตอบ 200 Success ตั้งแต่ตอนรับเรื่อง แล้วค่อยส่งต่อให้ LINE
 * ถ้าปลายทางไม่ส่งการ์ดต่อ เราจะไม่มีทางรู้จากรหัสตอบกลับเลย — ต้องให้ผู้ดูแล
 * ทดสอบเองแล้วมาติ๊กปิด ระบบจะได้ส่งเป็นข้อความธรรมดาแทนที่จะเงียบหาย
 */
export default class extends BaseSchema {
  protected tableName = 'notify_groups'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.boolean('supports_flex').notNullable().defaultTo(true)
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('supports_flex')
    })
  }
}
