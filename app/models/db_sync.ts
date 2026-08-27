import { DateTime } from 'luxon'
import { BaseModel, belongsTo, column } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import { encryptedColumn } from '#models/encrypted_column'
import { NotifyGroup } from '#models/notify_system'
import type { SyncReport } from '#services/db_sync_checker'

/** คอลัมน์ json — ไดรเวอร์บางเวอร์ชันคืน string บางเวอร์ชันแปลงให้แล้ว */
const jsonColumn = {
  prepare: (value: unknown) => (value == null ? null : JSON.stringify(value)),
  consume: (value: unknown) => {
    if (value == null) return null
    return typeof value === 'string' ? JSON.parse(value) : value
  },
}

/** ผลตรวจล่าสุดของเครื่องหนึ่ง — เก็บไว้แสดงในหน้าเว็บโดยไม่ต้องไปถามเครื่องใหม่ */
export type HostStatus = 'ok' | 'behind' | 'unreachable'

/**
 * ส่งเป็นอะไร
 *
 * `digest` เป็นค่าตั้งต้นเพราะปลายทางดองการ์ดไว้ราว 19 นาที — รายงานประจำวัน
 * ช้าขนาดนั้นไม่มีใครเดือดร้อน แต่เรื่องด่วนช้าขนาดนั้นคือรู้หลังเกิดเรื่องไปครึ่งชั่วโมง
 */
export type MessageStyle = 'text' | 'digest' | 'flex'

export const MESSAGE_STYLE_LABELS: Record<MessageStyle, string> = {
  text: 'ข้อความธรรมดาทุกครั้ง — เข้าเร็วที่สุด',
  digest: 'การ์ดเฉพาะรายงานประจำวัน · เรื่องด่วนเป็นข้อความ',
  flex: 'การ์ดทุกครั้ง — สวยที่สุด แต่เรื่องด่วนก็ช้าตาม',
}

export class DbHost extends BaseModel {
  static table = 'db_hosts'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare label: string

  @column()
  declare host: string

  @column()
  declare port: number

  /** ว่าง = ใช้ค่าจากหน้า "ฐานข้อมูล HOSxP" */
  @column()
  declare username: string | null

  @column(encryptedColumn)
  declare password: string | null

  @column()
  declare isEnabled: boolean

  @column()
  declare sortOrder: number

  @column.dateTime()
  declare lastCheckedAt: DateTime | null

  @column()
  declare lastStatus: HostStatus | null

  @column()
  declare lastNote: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  get address() {
    return this.port === 3306 ? this.host : `${this.host}:${this.port}`
  }

  /** เรียงให้เหมือนกันทุกที่ — ลำดับที่ตั้งไว้ก่อน แล้วค่อยชื่อ */
  static ordered() {
    return this.query().orderBy('sort_order').orderBy('label')
  }
}

export class DbSyncSetting extends BaseModel {
  static table = 'db_sync_settings'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare isEnabled: boolean

  @column()
  declare groupId: number | null

  @column()
  declare checkEveryMinutes: number

  @column()
  declare lagWarnSeconds: number

  @column()
  declare rowGapWarn: number

  @column()
  declare gtidLagWarn: number

  @column()
  declare throttleMinutes: number

  @column()
  declare notifyOnRecover: boolean

  /** HH:MM หรือ null */
  @column()
  declare digestAt: string | null

  @column()
  declare messageStyle: MessageStyle

  @column()
  declare cardColor: string

  /** ผลตรวจรอบล่าสุด — หน้าเว็บอ่านจากนี่ ไม่ต้องไปถามเครื่องใหม่ทุกครั้งที่เปิดหน้า */
  @column(jsonColumn)
  declare lastReport: SyncReport | null

  /** รอบนี้ควรส่งเป็นการ์ดไหม */
  wantsCard(isDigest: boolean) {
    if (this.messageStyle === 'flex') return true
    if (this.messageStyle === 'digest') return isDigest
    return false
  }

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @belongsTo(() => NotifyGroup, { foreignKey: 'groupId' })
  declare group: BelongsTo<typeof NotifyGroup>

  /** มีแถวเดียวเสมอ สร้างให้ถ้ายังไม่มี */
  static async current() {
    return (await this.first()) ?? (await this.create({}))
  }
}
