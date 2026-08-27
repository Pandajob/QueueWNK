import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export class Watermark extends BaseModel {
  static table = 'watermarks'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare key: string

  @column()
  declare value: string | null

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  static async get(key: string) {
    return (await this.findBy('key', key))?.value ?? null
  }

  static async set(key: string, value: string) {
    const row = await this.findBy('key', key)
    if (row) {
      row.value = value
      await row.save()
      return
    }
    await this.create({ key, value })
  }
}

export class VisitState extends BaseModel {
  static table = 'visit_states'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare vn: string

  @column.date()
  declare visitDate: DateTime

  @column()
  declare hn: string

  @column()
  declare depq: string | null

  @column()
  declare dep: string | null

  @column()
  declare status: number | null

  @column()
  declare timeVisit: string | null

  @column()
  declare lastNotifiedWaiting: number | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}

export type NotificationStatus = 'pending' | 'sent' | 'failed' | 'skipped'

export class Notification extends BaseModel {
  static table = 'notifications'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare dedupKey: string

  @column()
  declare vn: string

  @column()
  declare hn: string

  @column()
  declare caseKey: string

  @column()
  declare dep: string | null

  @column()
  declare depq: string | null

  // ไดรเวอร์บางเวอร์ชันคืนคอลัมน์ json มาเป็น string บางเวอร์ชันแปลงให้แล้ว
  // แปลงเองทั้งสองทางจะได้ไม่ต้องเดาว่าเจอแบบไหน
  @column({
    prepare: (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value)),
    consume: (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value),
  })
  declare payload: Record<string, string>

  @column()
  declare status: NotificationStatus

  @column()
  declare attempts: number

  @column()
  declare mophCode: number | null

  @column()
  declare lastError: string | null

  @column.dateTime()
  declare sentAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}

export class DepartmentSetting extends BaseModel {
  static table = 'department_settings'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare depcode: string

  @column()
  declare name: string | null

  @column()
  declare isEnabled: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}

export class PollerSetting extends BaseModel {
  static table = 'poller_settings'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare dryRun: boolean

  @column()
  declare quietStart: string

  @column()
  declare quietEnd: string

  @column()
  declare nearThreshold: number

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  /** มีแถวเดียวเสมอ สร้างให้ถ้ายังไม่มี */
  static async current() {
    return (await this.first()) ?? (await this.create({}))
  }

  /**
   * อยู่ในช่วงเวลาห้ามส่งไหม
   * รองรับช่วงที่ข้ามเที่ยงคืน เช่น 21:00–07:00
   */
  isQuietNow(now = DateTime.now().setZone('Asia/Bangkok')) {
    const minutes = now.hour * 60 + now.minute
    const parse = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number)
      return h * 60 + m
    }

    const start = parse(this.quietStart)
    const end = parse(this.quietEnd)

    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
  }
}
