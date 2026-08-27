import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * ให้ข้อความ 506 พาดชื่อผู้ป่วยกับเบอร์โทรได้ เพื่อให้ทีมระบาดโทรตามเคสได้ทันที
 * โดยไม่ต้องเปิด HOSxP อีกจอ
 *
 * ตั้งต้นเป็น false ทั้งคู่เหมือน include_hn — ของเดิมที่ตั้งไว้แล้วจะไม่เปลี่ยน
 * พฤติกรรมเองจากการอัปเกรด ต้องมีคนกดเปิดในหน้า CDCU
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('cdcu_settings', (table) => {
      table.boolean('include_name').notNullable().defaultTo(false)
      table.boolean('include_phone').notNullable().defaultTo(false)
    })
  }

  async down() {
    this.schema.alterTable('cdcu_settings', (table) => {
      table.dropColumn('include_name')
      table.dropColumn('include_phone')
    })
  }
}
