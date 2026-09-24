import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * ตัดผู้ที่เคยได้รับการวินิจฉัยความดันโลหิตสูง (ICD-10 I10) ออกจากรายงาน
 *
 * เป้าหมายของรายงานคือ "หาคนที่ยังไม่รู้ตัว" — คนที่วินิจฉัยแล้วอยู่ในระบบดูแล
 * ของคลินิกโรคเรื้อรังอยู่แล้ว การแจ้งซ้ำทุกครั้งที่เขามาวัดความดันไม่ได้ช่วยอะไร
 * และกลบเคสใหม่จนมองไม่เห็น
 *
 * ของจริงในฐานนี้ 24 ชั่วโมงมีความดันเกินเกณฑ์ 160 ราย ในนั้นวินิจฉัยแล้ว 93 ราย
 * (58%) เหลือเคสที่ยังไม่เคยวินิจฉัย 67 ราย
 *
 * เปิดไว้เป็นค่าตั้งต้น แต่ปิดได้ถ้าอยากเห็นทุกคนรวมผู้ป่วยเดิม
 */
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('vitals_settings', (table) => {
      table.boolean('exclude_known_ht').notNullable().defaultTo(true)
    })

    this.defer(async (db) => {
      await db.from('vitals_settings').update({ exclude_known_ht: true })
    })
  }

  async down() {
    this.schema.alterTable('vitals_settings', (table) => {
      table.dropColumn('exclude_known_ht')
    })
  }
}
