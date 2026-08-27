import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    // จำว่าอ่าน ovst_queue_server ถึงไหนแล้ว กัน replay ทั้งวันตอน restart
    this.schema.createTable('watermarks', (table) => {
      table.increments('id')
      table.string('key').notNullable().unique()
      table.string('value').nullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })

    // snapshot ล่าสุดต่อ visit — HOSxP ไม่เก็บประวัติการย้ายห้องให้
    // และเราเขียนอะไรลงฐานเขาไม่ได้ จึงต้องจำเองว่ารอบก่อนเห็นอะไร
    this.schema.createTable('visit_states', (table) => {
      table.increments('id')
      table.string('vn', 20).notNullable().unique()
      table.date('visit_date').notNullable().index()
      table.string('hn', 20).notNullable()

      table.string('depq', 20).nullable()
      table.string('dep', 10).nullable()
      table.integer('status').nullable()
      table.string('time_visit', 12).nullable()

      // จำนวนคิวที่รออยู่ข้างหน้าตอนที่แจ้ง "ใกล้ถึงคิว" ไปแล้ว
      // กันไม่ให้ยิงซ้ำทุกครั้งที่ตัวเลขขยับลงทีละหนึ่ง
      table.integer('last_notified_waiting').nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })

    // หนึ่งแถว = หนึ่งความตั้งใจจะส่ง
    // dedup_key เป็น UNIQUE ที่ระดับฐานข้อมูล ไม่ใช่ check-then-insert ในโค้ด
    // เพราะ check-then-insert แข่งกันเองได้ถ้า poller ซ้อนรอบ
    this.schema.createTable('notifications', (table) => {
      table.increments('id')
      table.string('dedup_key').notNullable().unique()

      table.string('vn', 20).notNullable().index()
      table.string('hn', 20).notNullable()
      table.string('case_key', 40).notNullable()
      table.string('dep', 10).nullable()
      table.string('depq', 20).nullable()

      // payload ที่จะส่ง — ไม่เก็บเลขบัตรประชาชนไว้ที่นี่
      // ตอนส่งค่อยไปอ่านจาก HOSxP สด ๆ จะได้ไม่สำเนา cid มาไว้อีกที่
      table.json('payload').notNullable()

      table.string('status', 20).notNullable().defaultTo('pending').index()
      table.integer('attempts').notNullable().defaultTo(0)
      table.integer('moph_code').nullable()
      table.text('last_error').nullable()
      table.timestamp('sent_at', { useTz: true }).nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })

    // เปิด/ปิดรายห้องตรวจ ตั้งต้นปิดทั้งหมด ต้องเลือกเปิดเอง
    this.schema.createTable('department_settings', (table) => {
      table.increments('id')
      table.string('depcode', 10).notNullable().unique()
      table.string('name').nullable()
      table.boolean('is_enabled').notNullable().defaultTo(false)
      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })

    // แถวเดียว
    this.schema.createTable('poller_settings', (table) => {
      table.increments('id')
      table.boolean('dry_run').notNullable().defaultTo(true)
      table.string('quiet_start', 5).notNullable().defaultTo('21:00')
      table.string('quiet_end', 5).notNullable().defaultTo('07:00')
      table.integer('near_threshold').notNullable().defaultTo(3)
      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })
  }

  async down() {
    this.schema.dropTable('poller_settings')
    this.schema.dropTable('department_settings')
    this.schema.dropTable('notifications')
    this.schema.dropTable('visit_states')
    this.schema.dropTable('watermarks')
  }
}
