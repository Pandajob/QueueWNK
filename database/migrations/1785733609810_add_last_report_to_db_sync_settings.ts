import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * เก็บผลตรวจล่าสุดไว้ทั้งก้อน
 *
 * ตอนแรกยัดลง `watermarks.value` แล้วชนเพดาน — คอลัมน์นั้นเป็น varchar
 * ตั้งใจให้เก็บ "ตัวเลขล่าสุดที่อ่านถึง" ไม่ใช่ payload ทั้งรายงาน
 * ผลตรวจก้อนหนึ่งราว 2–3 KB จึงควรมีที่อยู่ของตัวเอง
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('db_sync_settings', (table) => {
      table.json('last_report').nullable()
    })
  }

  async down() {
    this.schema.alterTable('db_sync_settings', (table) => {
      table.dropColumn('last_report')
    })
  }
}
