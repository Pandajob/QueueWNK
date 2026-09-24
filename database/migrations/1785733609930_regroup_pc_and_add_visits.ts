import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * จัดกลุ่มโรคประคับประคองใหม่ตามรายงานของทีม และเพิ่มการมาโรงพยาบาลให้ระบบติดตาม
 *
 * กลุ่มเดิม 12 กลุ่มยุบเหลือ 9 ตามที่ทีมประคับประคองใช้รายงานจริง
 *   cancer + neoplasm     → cancer   (และขยาย D37 เป็น D37-D48)
 *   stroke + dementia     → neuro
 *   congenital + preterm  → peds
 * ทะเบียนที่รับทราบไว้แล้วต้องย้ายกลุ่มตาม ไม่งั้นหน้ารายงานจะเห็นกลุ่มที่ไม่มีอยู่แล้ว
 *
 * `pc_visits` — การมาโรงพยาบาลของผู้ป่วยในทะเบียน กวาดจาก `ovst` ของ HOSxP
 * ให้ระบบติดตาม (bpfollow) ซึ่งไม่ต่อ HOSxP ใช้แจ้งเตือนว่า "คนไข้มา รพ. วันนี้"
 * และนับว่ามาครั้งที่เท่าไหร่ตั้งแต่รับเข้า
 */
export default class extends BaseSchema {
  async up() {
    /**
     * ⚠️ ต้องตรึง created_at ไว้ตอน UPDATE
     *
     * ตอนนี้ created_at ยังมี ON UPDATE current_timestamp() อยู่ (ปลดออกข้างล่าง แต่
     * defer ทำงานก่อน alterTable) รอบแรกที่รันบน server40 ลืมตรงนี้ วันที่เข้าทะเบียน
     * ของ 867 รายถูกเขียนทับเป็นวันนั้น ต้องกู้กลับจาก binlog — อย่าให้เกิดซ้ำ
     */
    this.defer(async (db) => {
      const keep = { created_at: db.raw('created_at') }
      await db
        .from('pc_seen')
        .where('grp', 'neoplasm')
        .update({ grp: 'cancer', ...keep })
      await db
        .from('pc_seen')
        .whereIn('grp', ['stroke', 'dementia'])
        .update({ grp: 'neuro', ...keep })
      await db
        .from('pc_seen')
        .whereIn('grp', ['congenital', 'preterm'])
        .update({ grp: 'peds', ...keep })
    })

    this.schema.alterTable('pc_seen', (table) => {
      // HOSxP บันทึกว่าเสียชีวิตเมื่อไหร่ที่ไหน — เป็นคำใบ้ให้ทีม ไม่ใช่บันทึกหลัก
      table.date('death_on').nullable()
      table.string('death_place', 16).nullable()
    })

    /**
     * ปลด ON UPDATE ออกจาก created_at
     *
     * MariaDB ใส่ `ON UPDATE current_timestamp()` ให้คอลัมน์ TIMESTAMP ตัวแรกของตาราง
     * เองเงียบ ๆ ถ้าไม่ระบุ DEFAULT — พอมีการ UPDATE แถว (เช่น เติม death_on)
     * วันที่เข้าทะเบียนจะถูกเขียนทับเป็นวันนี้ ระบบติดตามใช้ค่านี้นับ "รับใหม่รายเดือน"
     * และ "ค้างประเมินเกิน 24 ชม." จึงต้องตรึงไว้
     */
    this.schema.raw(
      'ALTER TABLE pc_seen MODIFY created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP'
    )

    this.schema.alterTable('pc_settings', (table) => {
      table.timestamp('visits_synced_at').nullable()
    })

    this.schema.createTable('pc_visits', (table) => {
      table.increments('id')
      table.string('hn', 16).notNullable()
      // vn ของ HOSxP ไม่ซ้ำ — ใช้กันเขียนซ้ำตอนกวาดทับช่วงเดิม
      table.string('vn', 16).notNullable().unique()
      table.string('an', 16).nullable()
      table.date('vstdate').notNullable()
      table.time('vsttime').nullable()
      table.string('dept', 128).nullable()
      table.string('kind', 4).notNullable().defaultTo('OPD')
      // ระบุ DEFAULT เอง ไม่งั้น MariaDB แถม ON UPDATE ให้ (ดูข้างบน)
      table.timestamp('created_at').notNullable().defaultTo(this.now())

      table.index(['hn', 'vstdate'], 'pc_visits_hn_vstdate_index')
      table.index(['vstdate'], 'pc_visits_vstdate_index')
    })
  }

  async down() {
    this.schema.dropTable('pc_visits')
    this.schema.alterTable('pc_settings', (table) => {
      table.dropColumn('visits_synced_at')
    })
    this.schema.alterTable('pc_seen', (table) => {
      table.dropColumn('death_on')
      table.dropColumn('death_place')
    })
  }
}
