import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * เฝ้าดูว่าเครื่องฐานข้อมูลหลายเครื่องมีข้อมูลตรงกันไหม
 *
 * โรงพยาบาลนี้มี MariaDB มากกว่าหนึ่งเครื่องและทำ replication กันอยู่
 * (`.212` server_id 2 กับ `.202` server_id 1 ต่างก็ `read_only = OFF`)
 * แบบนี้ข้อมูลแยกทางกันได้จริง ไม่ใช่แค่ตามช้า จึงต้องมีคนคอยเทียบให้
 *
 * แยกจาก `hosxp_connections` โดยตั้งใจ — ตารางนั้นตอบคำถามว่า
 * "poller ต่อเครื่องไหน" ซึ่งมีคำตอบเดียว ส่วนตารางนี้ตอบว่า
 * "ต้องเฝ้าเครื่องไหนบ้าง" ซึ่งมีหลายคำตอบและไม่มีเครื่องไหน active
 */
export default class extends BaseSchema {
  async up() {
    // --- เครื่องที่ต้องเฝ้า ----------------------------------------------------
    this.schema.createTable('db_hosts', (table) => {
      table.increments('id')
      table.string('label', 120).notNullable()
      table.string('host', 190).notNullable()
      table.integer('port').notNullable().defaultTo(3306)

      // ว่าง = ใช้ user/รหัส/ฐานเดียวกับที่ตั้งไว้ในหน้า "ฐานข้อมูล HOSxP"
      // เครื่องบางเครื่องอาจ GRANT ให้คนละ user จึงเปิดช่องให้ระบุแยกได้
      table.string('username', 190).nullable()
      table.text('password').nullable()

      table.boolean('is_enabled').notNullable().defaultTo(true)
      table.integer('sort_order').notNullable().defaultTo(0)

      table.timestamp('last_checked_at', { useTz: true }).nullable()
      // ok | behind | unreachable
      table.string('last_status', 20).nullable()
      table.string('last_note', 500).nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()

      table.unique(['host', 'port'])
    })

    // --- ตั้งค่าการเฝ้า (แถวเดียว) --------------------------------------------
    this.schema.createTable('db_sync_settings', (table) => {
      table.increments('id')
      table.boolean('is_enabled').notNullable().defaultTo(false)
      table
        .integer('group_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('notify_groups')
        .onDelete('SET NULL')

      table.integer('check_every_minutes').notNullable().defaultTo(10)

      // เกณฑ์ที่ถือว่า "ไม่ตรงกันจนต้องบอก" — ต่ำกว่านี้คือ replication lag ปกติ
      table.integer('lag_warn_seconds').notNullable().defaultTo(60)
      table.integer('row_gap_warn').notNullable().defaultTo(5)

      table.integer('throttle_minutes').notNullable().defaultTo(30)
      table.boolean('notify_on_recover').notNullable().defaultTo(true)

      // HH:MM — รายงาน "ทุกเครื่องปกติ" วันละครั้ง ว่าง = ไม่ส่ง
      // ความเงียบอย่างเดียวแยกไม่ออกว่า "ไม่มีปัญหา" หรือ "ตัวเฝ้าตายไปแล้ว"
      table.string('digest_at', 5).nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })
  }

  async down() {
    this.schema.dropTable('db_sync_settings')
    this.schema.dropTable('db_hosts')
  }
}
