import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

/**
 * เก็บ/อ่าน JSON ให้เหมือนกับที่ notify_system ทำ
 *
 * เขียน null กับ undefined แยกกันชัด ๆ แทน `== null` เพราะกฎ eqeqeq
 * ความหมายเหมือนเดิมทุกประการ
 */
const isNullish = (value: unknown) => value === null || value === undefined

const jsonColumn = {
  prepare: (value: unknown) => (isNullish(value) ? null : JSON.stringify(value)),
  consume: (value: unknown) => {
    if (isNullish(value)) return null
    return typeof value === 'string' ? JSON.parse(value) : value
  },
}

/**
 * ตั้งค่าการแจ้งเตือนนัดหมายล่วงหน้า
 *
 * แถวเดียวทั้งระบบ เหมือน PollerSetting และ CdcuSetting
 */
export default class AppointmentSetting extends BaseModel {
  static table = 'appointment_settings'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare isEnabled: boolean

  @column()
  declare dryRun: boolean

  @column()
  declare daysAhead: number

  @column()
  declare sendAt: string

  @column()
  declare allClinics: boolean

  @column(jsonColumn)
  declare clinicCodes: string[] | null

  @column()
  declare messageTitle: string

  @column()
  declare messageText: string | null

  @column()
  declare messageHtml: string | null

  @column.date()
  declare lastRunDate: DateTime | null

  @column.dateTime()
  declare lastRunAt: DateTime | null

  @column()
  declare lastRunNote: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  static async current() {
    const existing = await this.first()
    if (existing) return existing

    // ต้องอ่านกลับจากฐานหลังสร้าง ไม่งั้นค่าตั้งต้นที่ประกาศไว้ใน migration
    // จะไม่ติดมากับ instance และกลายเป็น undefined
    //
    // สำคัญมากกับ dryRun — undefined ถูกตีความว่า "ปิด" ซึ่งแปลว่าระบบ
    // จะส่งถึงผู้ป่วยจริงตั้งแต่ครั้งแรกที่รัน ตรงข้ามกับที่ตั้งใจไว้ทุกประการ
    const created = await this.create({})
    await created.refresh()
    return created
  }

  /** คลินิกนี้เปิดแจ้งเตือนไว้ไหม */
  watches(clinic: string | null) {
    if (this.allClinics) return true
    if (!clinic) return false
    return (this.clinicCodes ?? []).includes(clinic)
  }
}
