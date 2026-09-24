import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * ถอนคอลัมน์การติดตามออกจาก `pc_seen`
 *
 * เคยใส่ไว้ตอนทำหน้าทะเบียนใน QueueWNK แต่หน้าติดตามจริงย้ายไปอยู่ที่แอป
 * bpfollow (/bp) ซึ่งบันทึกลงตาราง `bp_pc_followups` ของตัวเอง แบบเดียวกับ
 * ที่งานความดันทำอยู่
 *
 * ต้องถอนออก ไม่ใช่ปล่อยไว้เฉย ๆ เพราะถ้ามีที่เก็บ "ติดตามแล้ว" สองที่
 * วันหนึ่งจะไม่ตรงกัน แล้วไม่มีใครรู้ว่าอันไหนจริง — `pc_seen` มีหน้าที่เดียวคือ
 * บอกว่าระบบเคยเห็นผู้ป่วยรายนี้แล้ว ส่วนใครไปเยี่ยมเป็นเรื่องของ bpfollow
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('pc_seen', (table) => {
      table.dropIndex(['followed_at'], 'pc_seen_followed_at_index')
      table.dropColumn('follow_note')
      table.dropColumn('followed_by')
      table.dropColumn('followed_at')
    })
  }

  async down() {
    this.schema.alterTable('pc_seen', (table) => {
      table.timestamp('followed_at').nullable()
      table.string('followed_by', 160).nullable()
      table.text('follow_note').nullable()
      table.index(['followed_at'], 'pc_seen_followed_at_index')
    })
  }
}
