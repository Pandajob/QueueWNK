import encryption from '@adonisjs/core/services/encryption'

/**
 * ตัวช่วยสำหรับคอลัมน์ที่เก็บความลับ (รหัสผ่าน DB, secret-key ของ MOPH)
 *
 * - เข้ารหัสด้วย APP_KEY ก่อนเขียนลง DB
 * - `serializeAs: null` กันไม่ให้หลุดออกไปกับ JSON response หรือ log โดยไม่ตั้งใจ
 *   ถ้าต้องใช้ค่าจริงต้องอ่านจาก property ตรง ๆ เท่านั้น
 *
 * ถ้า APP_KEY เปลี่ยน ค่าเดิมจะถอดรหัสไม่ออก — decrypt จะคืน null
 * แทนที่จะ throw เพื่อให้หน้าเว็บยังเปิดได้และผู้ใช้กรอกใหม่ได้
 */
export const encryptedColumn = {
  prepare: (value: string | null | undefined) =>
    value === null || value === undefined || value === '' ? value : encryption.encrypt(value),

  consume: (value: string | null | undefined) => {
    if (value === null || value === undefined || value === '') return value
    return encryption.decrypt<string>(value)
  },

  serializeAs: null,
} as const
