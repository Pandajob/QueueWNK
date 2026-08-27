import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'hosxp_connections'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.string('label').notNullable().defaultTo('HOSxP')

      table.string('host').notNullable()
      table.integer('port').notNullable().defaultTo(3306)
      table.string('database').notNullable()
      table.string('username').notNullable()

      // เข้ารหัสด้วย APP_KEY ก่อนลง DB — ดู app/models/hosxp_connection.ts
      table.text('password').notNullable()

      // HOSxP v3 มักเก็บภาษาไทยเป็น tis620
      table.string('charset').notNullable().defaultTo('tis620')

      table.boolean('is_active').notNullable().defaultTo(false)

      table.timestamp('last_tested_at', { useTz: true }).nullable()
      table.boolean('last_test_ok').nullable()
      table.text('last_test_error').nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
