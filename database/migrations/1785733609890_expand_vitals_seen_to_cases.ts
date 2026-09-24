import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * เก็บรายละเอียดเคสความดันสูงไว้ให้ระบบติดตามอาการใช้ต่อ
 *
 * เดิม `vitals_seen` มีหน้าที่เดียวคือกันแจ้งซ้ำ จึงเก็บแค่ vn/hn/ค่าความดัน
 * ตอนนี้มีแดชบอร์ดติดตามอาการมาอ่านต่อ ซึ่งต้องรู้ว่าเป็นใคร อยู่ที่ไหน
 * และ รพ.สต. ไหนรับผิดชอบ — ข้อมูลพวกนี้เดิมดึงสดจาก HOSxP ตอนส่งแล้วทิ้ง
 *
 * ทำไมถึงยอมเก็บ PII ลงฐานของแอปทั้งที่หลักการเดิมคือไม่เก็บ
 *   1. ข้อมูลชุดนี้ถูกส่งเข้ากลุ่ม LINE ไปแล้ว การเก็บไว้หลังหน้าล็อกอิน
 *      ไม่ได้เปิดเผยมากไปกว่าเดิม
 *   2. งานติดตามอาการต้องการ "ที่อยู่ ณ วันที่แจ้ง" ไม่ใช่ที่อยู่วันนี้
 *   3. แดชบอร์ดเป็นคนละแอป การให้มันต่อ HOSxP เองแปลว่าต้องมีรหัสฐาน
 *      โรงพยาบาลอีกชุด ซึ่งเสี่ยงกว่าการเก็บ snapshot
 *
 * เลขบัตรประชาชนยัง**ไม่เก็บ**เหมือนเดิม ไม่ได้ดึงมาตั้งแต่ชั้น SQL
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('vitals_seen', (table) => {
      table.string('pname', 40).nullable()
      table.string('fname', 120).nullable()
      table.string('lname', 120).nullable()
      table.string('addr', 255).nullable()
      table.string('tel', 40).nullable()
      table.string('hospsub', 9).nullable()
      table.string('hospsub_name', 200).nullable()
      table.boolean('in_district').notNullable().defaultTo(false)
      table.dateTime('screened_at').nullable()

      // แดชบอร์ดกรองด้วยสองอันนี้เป็นหลัก — รายการของ รพ.สต. ตัวเอง เรียงตามวัน
      table.index(['hospsub', 'vstdate'], 'vitals_seen_hospsub_vstdate_index')
    })
  }

  async down() {
    this.schema.alterTable('vitals_seen', (table) => {
      table.dropIndex(['hospsub', 'vstdate'], 'vitals_seen_hospsub_vstdate_index')
      table.dropColumn('pname')
      table.dropColumn('fname')
      table.dropColumn('lname')
      table.dropColumn('addr')
      table.dropColumn('tel')
      table.dropColumn('hospsub')
      table.dropColumn('hospsub_name')
      table.dropColumn('in_district')
      table.dropColumn('screened_at')
    })
  }
}
