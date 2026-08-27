import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import { encryptedColumn } from '#models/encrypted_column'

export default class MophCredential extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare label: string

  @column()
  declare baseUrl: string

  @column(encryptedColumn)
  declare clientKey: string | null

  @column(encryptedColumn)
  declare secretKey: string | null

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
