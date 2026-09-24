import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * บันทึกการติดตามผู้ป่วยประคับประคอง
 *
 * ทะเบียน `pc_seen` เดิมตอบได้แค่ "เคยแจ้งไปแล้วหรือยัง" ซึ่งเป็นเรื่องของระบบ
 * ไม่ใช่เรื่องของงาน — คำถามที่ทีมถามจริงคือ "ไปเยี่ยมคนนี้หรือยัง"
 * สองอย่างนี้คนละเรื่องกัน แจ้งเตือนออกไปแล้วไม่ได้แปลว่ามีใครไปดูแล
 *
 * เก็บชื่อคนบันทึกไว้ด้วย เพราะเวลามีคำถามย้อนหลังว่าใครไปเยี่ยม จะได้ตามถูกคน
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('pc_seen', (table) => {
      table.timestamp('followed_at').nullable()
      table.string('followed_by', 160).nullable()
      table.text('follow_note').nullable()

      table.index(['followed_at'], 'pc_seen_followed_at_index')
    })
  }

  async down() {
    this.schema.alterTable('pc_seen', (table) => {
      table.dropIndex(['followed_at'], 'pc_seen_followed_at_index')
      table.dropColumn('follow_note')
      table.dropColumn('followed_by')
      table.dropColumn('followed_at')
    })
  }
}
