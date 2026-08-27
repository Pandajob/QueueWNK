import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * เลือกได้ว่าจะส่งเป็นการ์ดหรือข้อความ และเพิ่มเกณฑ์ตามหลังแบบ GTID
 *
 * ค่าตั้งต้นเป็น `digest` — การ์ดเฉพาะรายงานประจำวัน ส่วนเรื่องด่วนยังเป็นข้อความ
 * เพราะปลายทางดองการ์ดไว้ราว 19 นาที รายงานประจำวันช้า 19 นาทีไม่มีใครเดือดร้อน
 * แต่ "replication หยุดเดิน" ช้า 19 นาทีคือข้อมูลแยกกันไปแล้วครึ่งชั่วโมง
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('db_sync_settings', (table) => {
      // text | digest | flex
      table.string('message_style', 10).notNullable().defaultTo('digest')

      // ตามหลังกี่ transaction ถึงเตือน — GTID ขยับทุกการเขียน ค่าจึงต้องหลวมกว่าจำนวนแถว
      table.integer('gtid_lag_warn').notNullable().defaultTo(2000)

      table.string('card_color', 7).notNullable().defaultTo('#6d28d9')
    })
  }

  async down() {
    this.schema.alterTable('db_sync_settings', (table) => {
      table.dropColumn('message_style')
      table.dropColumn('gtid_lag_warn')
      table.dropColumn('card_color')
    })
  }
}
