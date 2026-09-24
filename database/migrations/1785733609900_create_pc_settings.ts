import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * แจ้งเตือนผู้ป่วยกลุ่มประคับประคอง (Palliative Care) เข้ากลุ่มเจ้าหน้าที่
 *
 * อ่านการวินิจฉัยจาก `ovstdiag` (ผู้ป่วยนอก) และ `iptdiag` (ผู้ป่วยใน) ของ HOSxP
 * แล้วแจ้งเมื่อพบผู้ป่วยที่เข้าเกณฑ์โรคกลุ่มนี้
 *
 * ต่างจากรายงานความดันตรงจุดสำคัญ — ความดันเป็น "ค่าที่วัดครั้งนั้น" คนเดิม
 * มาวัดใหม่ก็เป็นเคสใหม่ได้ แต่โรคกลุ่มนี้เป็น "โรคเรื้อรัง" ผู้ป่วยมะเร็งคนหนึ่ง
 * มาโรงพยาบาลปีละหลายสิบครั้ง ถ้าแจ้งทุกครั้งที่เจอรหัสโรค กลุ่มจะถูกน้ำท่วม
 * ภายในวันเดียว จึงกันซ้ำด้วย **HN** ไม่ใช่ vn — ผู้ป่วยหนึ่งคนแจ้งครั้งเดียว
 *
 * ตั้งต้นปิดไว้เหมือนทุกอย่างที่ส่งออกนอกระบบ ต้องมีคนกดเปิดในหน้าเว็บ
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('pc_settings', (table) => {
      table.increments('id')
      table.boolean('is_enabled').notNullable().defaultTo(false)
      table.integer('group_id').unsigned().nullable().references('id').inTable('notify_groups')

      /**
       * สองโหมด เปิดพร้อมกันได้
       *   ทันที   — เจอผู้ป่วยรายใหม่แล้วแจ้งเลยในรอบถัดไปของ worker (ราว 1 นาที)
       *   รายวัน  — สรุปผู้ป่วยรายใหม่ของวันนั้นรวมเป็นข้อความเดียวตามเวลาที่ตั้ง
       */
      table.boolean('notify_immediate').notNullable().defaultTo(true)
      table.boolean('notify_daily').notNullable().defaultTo(true)
      table.string('send_at', 5).notNullable().defaultTo('16:00')

      // เลือกเฝ้าเฉพาะบางกลุ่มโรคได้ ว่าง = ทุกกลุ่ม
      table.boolean('all_groups').notNullable().defaultTo(true)
      table.json('group_codes').nullable()

      /**
       * ย้อนดูการวินิจฉัยกี่วัน
       *
       * ไม่ใช้ watermark เวลาเหมือนรายงานความดัน เพราะเวชระเบียนคีย์รหัสโรค
       * ย้อนหลังได้หลายวัน ถ้าดูแค่ตั้งแต่รอบที่แล้วจะพลาดรายที่คีย์ช้า
       * ดูย้อนหลังแล้วกันซ้ำด้วย pc_seen แทน — คีย์ช้าแค่ไหนก็ยังเจอ
       */
      table.integer('lookback_days').notNullable().defaultTo(7)

      /**
       * เพดานจำนวนรายต่อรอบแจ้งทันที
       *
       * กันกรณีเวชระเบียนคีย์ข้อมูลย้อนหลังทีเดียวหลายร้อยราย แล้วกลุ่มโดนถล่ม
       * รายที่เกินเพดานไม่ได้หายไป จะทยอยแจ้งในรอบถัดไป
       */
      table.integer('max_per_run').notNullable().defaultTo(20)

      // ข้อมูลที่ระบุตัวผู้ป่วยได้ ตั้งต้นปิดทั้งหมด
      table.boolean('include_hn').notNullable().defaultTo(false)
      table.boolean('include_name').notNullable().defaultTo(false)
      table.boolean('include_address').notNullable().defaultTo(false)
      table.boolean('include_phone').notNullable().defaultTo(false)

      // ไม่แจ้งผู้ที่เสียชีวิตแล้ว (patient.death = 'Y')
      table.boolean('exclude_dead').notNullable().defaultTo(true)

      /**
       * เคยรับทราบผู้ป่วยเดิมทั้งฐานหรือยัง
       *
       * ตอนเปิดใช้ครั้งแรกในฐานนี้มีผู้ป่วยเข้าเกณฑ์อยู่แล้วราว 1,600 ราย
       * ถ้าไม่กันไว้ รอบแรกจะแจ้งทั้งหมดออกไปทีเดียว ระบบจึงต้อง "รับทราบ"
       * รายเดิมลง pc_seen โดยไม่ส่ง ก่อนจะเริ่มเฝ้าหารายใหม่
       */
      table.boolean('seeded').notNullable().defaultTo(false)
      table.timestamp('seeded_at').nullable()

      table.date('last_run_date').nullable()
      table.timestamp('last_run_at').nullable()
      table.string('last_run_note', 255).nullable()

      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').notNullable()
    })

    /**
     * ผู้ป่วยที่เคยพบแล้ว — กันซ้ำ และเป็นทะเบียนให้ระบบติดตามใช้ต่อ
     *
     * กุญแจกันซ้ำคือ hn ไม่ใช่ vn (ดูเหตุผลด้านบน) เก็บ snapshot ชื่อ ที่อยู่
     * เบอร์โทร และ รพ.สต. ณ วันที่พบ ไม่ใช่ค่าปัจจุบัน เพราะงานติดตามต้องรู้ว่า
     * ตอนนั้นเขาอยู่ที่ไหน
     *
     * ไม่เก็บเลขบัตรประชาชน — ไม่ได้ดึงมาตั้งแต่ชั้น SQL อยู่แล้ว
     */
    this.schema.createTable('pc_seen', (table) => {
      table.increments('id')
      table.string('hn', 16).notNullable().unique()

      table.string('grp', 32).nullable()
      table.string('icd10', 16).nullable()
      table.date('dxdate').nullable()
      table.string('src', 4).nullable()

      table.string('pname', 64).nullable()
      table.string('fname', 128).nullable()
      table.string('lname', 128).nullable()
      table.string('addr', 255).nullable()
      table.string('tel', 32).nullable()
      table.string('hospsub', 16).nullable()
      table.string('hospsub_name', 255).nullable()
      table.boolean('in_district').notNullable().defaultTo(false)

      /** false = รับทราบไว้เฉย ๆ ตอน seed ไม่ได้ส่งออกกลุ่ม */
      table.boolean('notified').notNullable().defaultTo(false)
      table.timestamp('created_at').notNullable()

      table.index(['dxdate'], 'pc_seen_dxdate_index')
      table.index(['grp'], 'pc_seen_grp_index')
    })
  }

  async down() {
    this.schema.dropTable('pc_seen')
    this.schema.dropTable('pc_settings')
  }
}
