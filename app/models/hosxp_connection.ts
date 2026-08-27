import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import { encryptedColumn } from '#models/encrypted_column'

export default class HosxpConnection extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare label: string

  @column()
  declare host: string

  @column()
  declare port: number

  @column()
  declare database: string

  @column()
  declare username: string

  @column(encryptedColumn)
  declare password: string | null

  @column()
  declare charset: string

  @column()
  declare isActive: boolean

  @column.dateTime()
  declare lastTestedAt: DateTime | null

  @column()
  declare lastTestOk: boolean | null

  @column()
  declare lastTestError: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  static async active() {
    return this.query().where('is_active', true).first()
  }
}
