import type { HttpContext } from '@adonisjs/core/http'

/**
 * MOPH CCM — ระบบบรอดแคสต์ของหมอพร้อม
 *
 * ตอนนี้มีแค่หน้าอธิบายว่าระบบนี้ทำอะไรได้และทำอะไรไม่ได้ ยังไม่ได้ต่อ API
 * เพราะการยิง /api/segment คือการส่ง "เลขบัตรประชาชนของผู้ป่วย" ออกไปนอกโรงพยาบาล
 * ซึ่งเป็นการตัดสินใจของโรงพยาบาล ไม่ใช่ของคนเขียนโค้ด
 */
export default class CcmController {
  async index({ view }: HttpContext) {
    return view.render('pages/ccm/index')
  }
}
