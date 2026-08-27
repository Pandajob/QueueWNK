import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'moph_credentials'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.string('label').notNullable().defaultTo('MOPH Alert')

      table.string('base_url').notNullable().defaultTo('https://morpromt2c.moph.go.th')

      // client-key / secret-key จาก CMS MOPH ALERTING — เข้ารหัสก่อนลง DB
      table.text('client_key').notNullable()
      table.text('secret_key').notNullable()

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
