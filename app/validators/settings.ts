import vine from '@vinejs/vine'
import { SUPPORTED_CHARSETS } from '#services/hosxp_client'

export const hosxpValidator = vine.compile(
  vine.object({
    label: vine.string().trim().minLength(1).maxLength(80),
    host: vine.string().trim().minLength(1).maxLength(255),
    port: vine.number().range([1, 65535]),
    database: vine.string().trim().minLength(1).maxLength(64),
    username: vine.string().trim().minLength(1).maxLength(64),
    // ว่างไว้ = ไม่เปลี่ยนรหัสผ่านเดิม
    password: vine.string().optional(),
    charset: vine.enum(SUPPORTED_CHARSETS),
  })
)

export const mophValidator = vine.compile(
  vine.object({
    label: vine.string().trim().minLength(1).maxLength(80),
    baseUrl: vine.string().trim().url({ require_protocol: true }),
    clientKey: vine.string().optional(),
    secretKey: vine.string().optional(),
  })
)
