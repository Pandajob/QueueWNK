import { DateTime } from 'luxon'
import { BaseModel, belongsTo, column, hasMany, manyToMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany, ManyToMany } from '@adonisjs/lucid/types/relations'
import { encryptedColumn } from '#models/encrypted_column'
import type { FlexBlock } from '#services/flex_builder'

/** คอลัมน์ json — ไดรเวอร์บางเวอร์ชันคืน string บางเวอร์ชันแปลงให้แล้ว */
const jsonColumn = {
  prepare: (value: unknown) => (value == null ? null : JSON.stringify(value)),
  consume: (value: unknown) => {
    if (value == null) return null
    return typeof value === 'string' ? JSON.parse(value) : value
  },
}

/** ช่วงเวลางดส่ง รองรับช่วงที่ข้ามเที่ยงคืน เช่น 21:00–07:00 */
export function isQuietAt(quietStart: string, quietEnd: string, now: DateTime) {
  const minutes = now.hour * 60 + now.minute
  const parse = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number)
    return h * 60 + m
  }

  const start = parse(quietStart)
  const end = parse(quietEnd)

  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

// --- กลุ่ม LINE -------------------------------------------------------------

export class NotifyGroup extends BaseModel {
  static table = 'notify_groups'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column()
  declare hcode: string | null

  @column()
  declare baseUrl: string

  @column(encryptedColumn)
  declare clientKey: string | null

  @column(encryptedColumn)
  declare secretKey: string | null

  @column()
  declare isActive: boolean

  /**
   * ปลายทางส่งการ์ด Flex ต่อให้จริงหรือไม่
   *
   * ปิดไว้แล้วเทมเพลตแบบการ์ดจะถูกส่งเป็นข้อความธรรมดาแทน ข้อมูลครบเหมือนกัน
   * แค่ไม่มีแถบกับสี — ดีกว่าส่งแล้วเงียบหายโดยที่ประวัติขึ้นว่าสำเร็จ
   */
  @column()
  declare supportsFlex: boolean

  @column()
  declare note: string | null

  @column.dateTime()
  declare lastTestedAt: DateTime | null

  @column()
  declare lastTestOk: boolean | null

  @column()
  declare lastTestError: string | null

  @column.dateTime()
  declare lastSentAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  get isUsable() {
    return this.isActive && !!this.clientKey && !!this.secretKey
  }
}

// --- ตั้งค่าแจ้งเตือนสถานะระบบให้ทีมงาน --------------------------------------

export class NotifyOpsSetting extends BaseModel {
  static table = 'notify_ops_settings'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare groupId: number | null

  @column()
  declare onError: boolean

  @column()
  declare onRecover: boolean

  @column()
  declare onSendFailure: boolean

  @column()
  declare onRestart: boolean

  @column()
  declare throttleMinutes: number

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

// --- ชุดดึงข้อมูลจาก HOSxP ---------------------------------------------------

export class NotifyDataset extends BaseModel {
  static table = 'notify_datasets'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare key: string

  @column()
  declare name: string

  @column()
  declare description: string | null

  @column()
  declare sqlText: string

  @column()
  declare isEnabled: boolean

  @column.dateTime()
  declare lastRunAt: DateTime | null

  @column()
  declare lastRowCount: number | null

  @column()
  declare lastDurationMs: number | null

  @column(jsonColumn)
  declare lastColumns: string[] | null

  @column()
  declare lastError: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @hasMany(() => NotifyTemplate, { foreignKey: 'datasetId' })
  declare templates: HasMany<typeof NotifyTemplate>
}

// --- เทมเพลตข้อความ ----------------------------------------------------------

export class NotifyTemplate extends BaseModel {
  static table = 'notify_templates'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare key: string

  @column()
  declare name: string

  @column()
  declare datasetId: number | null

  @column()
  declare body: string

  @column()
  declare isEnabled: boolean

  /** text = ข้อความธรรมดา · flex = การ์ด */
  @column()
  declare messageType: 'text' | 'flex'

  @column()
  declare altText: string | null

  @column(jsonColumn)
  declare flexBlocks: FlexBlock[] | null

  @column()
  declare flexColor: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @belongsTo(() => NotifyDataset, { foreignKey: 'datasetId' })
  declare dataset: BelongsTo<typeof NotifyDataset>

  get blocks(): FlexBlock[] {
    return Array.isArray(this.flexBlocks) ? this.flexBlocks : []
  }
}

// --- ตารางเวลา ---------------------------------------------------------------

export type Frequency = 'daily' | 'weekly' | 'monthly'

/** index ตาม ISO weekday (จันทร์ = 1) ช่อง 0 ไม่ใช้ */
const THAI_WEEKDAY_SHORT = ['', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์']

export class NotifySchedule extends BaseModel {
  static table = 'notify_schedules'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column()
  declare templateId: number

  @column()
  declare frequency: Frequency

  @column()
  declare runAt: string

  @column(jsonColumn)
  declare daysOfWeek: number[] | null

  @column()
  declare dayOfMonth: number | null

  @column()
  declare isEnabled: boolean

  @column.dateTime()
  declare lastRunAt: DateTime | null

  @column()
  declare lastStatus: string | null

  @column()
  declare lastError: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @belongsTo(() => NotifyTemplate, { foreignKey: 'templateId' })
  declare template: BelongsTo<typeof NotifyTemplate>

  @manyToMany(() => NotifyGroup, {
    pivotTable: 'notify_schedule_groups',
    pivotForeignKey: 'schedule_id',
    pivotRelatedForeignKey: 'group_id',
  })
  declare groups: ManyToMany<typeof NotifyGroup>

  /**
   * คำอธิบายรอบส่งแบบอ่านง่าย
   *
   * อยู่บน model ไม่ใช่ใน template เพราะต้องใช้ทั้งในหน้าเว็บและใน audit log
   * และตรรกะแบบนี้เขียนใน Edge แล้วอ่านยากกว่าที่ควร
   */
  get scheduleLabel() {
    if (this.frequency === 'daily') return `ทุกวัน ${this.runAt}`

    if (this.frequency === 'weekly') {
      const names = (this.daysOfWeek ?? []).map((day) => THAI_WEEKDAY_SHORT[day]).filter(Boolean)
      return names.length ? `ทุก${names.join(' ')} ${this.runAt}` : `รายสัปดาห์ ${this.runAt}`
    }

    return `ทุกวันที่ ${this.dayOfMonth ?? '-'} ของเดือน ${this.runAt}`
  }

  /**
   * ถึงรอบส่งหรือยัง
   *
   * เทียบแบบ "ผ่านเวลานัดของวันนี้แล้ว และยังไม่ได้ส่งของวันนี้" แทนการจับเวลาเป๊ะ
   * เพราะ worker อาจดับข้ามช่วงเวลานัดพอดี — แบบนี้พอฟื้นขึ้นมาจะยังส่งให้
   */
  isDue(now: DateTime) {
    if (!this.isEnabled) return false

    if (this.frequency === 'weekly') {
      const days = this.daysOfWeek ?? []
      if (!days.includes(now.weekday)) return false
    }

    if (this.frequency === 'monthly' && this.dayOfMonth !== now.day) return false

    const [hour, minute] = this.runAt.split(':').map(Number)
    const dueAt = now.set({ hour, minute, second: 0, millisecond: 0 })
    if (now < dueAt) return false

    // ส่งไปแล้วในรอบนี้หรือยัง
    return !this.lastRunAt || this.lastRunAt.setZone(now.zone) < dueAt
  }
}

// --- ประวัติการส่ง ------------------------------------------------------------

export type MessageSource = 'schedule' | 'manual' | 'ops' | 'cdcu' | 'dbsync'
export type MessageStatus = 'sent' | 'failed' | 'skipped'

export class NotifyMessage extends BaseModel {
  static table = 'notify_messages'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare groupId: number | null

  @column()
  declare groupName: string

  @column()
  declare source: MessageSource

  @column()
  declare scheduleId: number | null

  @column()
  declare templateId: number | null

  @column()
  declare subject: string | null

  @column()
  declare body: string

  @column()
  declare status: MessageStatus

  @column()
  declare responseCode: number | null

  @column()
  declare error: string | null

  @column.dateTime()
  declare sentAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}

// --- ประวัติการแก้ไข ----------------------------------------------------------

export type AuditAction = 'create' | 'update' | 'delete' | 'send' | 'test' | 'toggle'

export class NotifyAuditLog extends BaseModel {
  static table = 'notify_audit_logs'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare userId: number | null

  @column()
  declare userEmail: string

  @column()
  declare action: AuditAction

  @column()
  declare entity: string

  @column()
  declare entityId: string | null

  @column()
  declare summary: string

  @column(jsonColumn)
  declare changes: Record<string, { from: unknown; to: unknown }> | null

  @column()
  declare ip: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}

// --- CDCU --------------------------------------------------------------------

export class CdcuSetting extends BaseModel {
  static table = 'cdcu_settings'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare isEnabled: boolean

  @column()
  declare groupId: number | null

  @column()
  declare watchAll: boolean

  @column(jsonColumn)
  declare watchedCodes: number[] | null

  @column()
  declare includeHn: boolean

  @column()
  declare includeName: boolean

  @column()
  declare includePhone: boolean

  @column()
  declare quietStart: string

  @column()
  declare quietEnd: string

  @column()
  declare throttleMinutes: number

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @belongsTo(() => NotifyGroup, { foreignKey: 'groupId' })
  declare group: BelongsTo<typeof NotifyGroup>

  static async current() {
    return (await this.first()) ?? (await this.create({}))
  }

  isQuietNow(now = DateTime.now().setZone('Asia/Bangkok')) {
    return isQuietAt(this.quietStart, this.quietEnd, now)
  }

  watches(code506: number | null) {
    if (this.watchAll) return true
    if (code506 == null) return false
    return (this.watchedCodes ?? []).includes(code506)
  }
}

export class CdcuSeen extends BaseModel {
  static table = 'cdcu_seen'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare svNumber: number

  @column()
  declare code506: number | null

  @column()
  declare diseaseName: string | null

  @column.date()
  declare reportDate: DateTime | null

  @column()
  declare notified: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
