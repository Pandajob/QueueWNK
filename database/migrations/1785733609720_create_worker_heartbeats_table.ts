import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'worker_heartbeats'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      // ชื่อ process เช่น 'queue:watch' — หนึ่งแถวต่อหนึ่ง worker
      table.string('name').notNullable().unique()

      table.timestamp('last_beat_at', { useTz: true }).notNullable()
      table.string('status').notNullable().defaultTo('idle')
      table.text('message').nullable()

      // นับรอบที่ทำงานไปแล้ว ช่วยดูว่า loop เดินจริงหรือค้าง
      table.bigInteger('cycles').notNullable().defaultTo(0)

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
