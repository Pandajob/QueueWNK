import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export type WorkerStatus = 'idle' | 'running' | 'waiting_config' | 'error'

/** ถ้าไม่มีสัญญาณเกินเท่านี้ ถือว่า worker ตายแล้ว */
export const HEARTBEAT_STALE_SECONDS = 90

export default class WorkerHeartbeat extends BaseModel {
  @column({ isPrimary: true })
  declare id: number

  @column()
  declare name: string

  @column.dateTime()
  declare lastBeatAt: DateTime

  @column()
  declare status: WorkerStatus

  @column()
  declare message: string | null

  @column()
  declare cycles: number

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  get isStale() {
    return DateTime.now().diff(this.lastBeatAt, 'seconds').seconds > HEARTBEAT_STALE_SECONDS
  }

  /** worker เรียกทุกรอบ — upsert แถวเดียวต่อ worker */
  static async beat(name: string, status: WorkerStatus, message: string | null = null) {
    const existing = await this.findBy('name', name)

    if (!existing) {
      return this.create({
        name,
        status,
        message,
        cycles: 1,
        lastBeatAt: DateTime.now(),
      })
    }

    existing.merge({
      status,
      message,
      cycles: Number(existing.cycles) + 1,
      lastBeatAt: DateTime.now(),
    })

    return existing.save()
  }
}
