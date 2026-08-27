import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * ระบบ MOPH Notify เต็มรูปแบบ — กลุ่ม LINE หลายกลุ่ม ชุดข้อมูล เทมเพลต
 * ตารางเวลาส่งซ้ำ เฝ้าระวังโรค 506 ประวัติการส่ง และประวัติการแก้ไข
 *
 * `notify_credentials` (ของเดิม ใช้เก็บกลุ่มเดียวสำหรับแจ้งเตือนทีมงาน)
 * ถูกแทนที่ด้วย `notify_groups` + `notify_ops_settings` เพราะตอนนี้กลุ่มมีได้หลายกลุ่ม
 * และการตั้งค่า "เตือนเรื่องอะไร" เป็นคนละเรื่องกับ "กลุ่มไหน"
 */
export default class extends BaseSchema {
  async up() {
    // --- กลุ่ม LINE ---------------------------------------------------------
    this.schema.createTable('notify_groups', (table) => {
      table.increments('id')
      table.string('name').notNullable()
      table.string('hcode', 10).nullable()
      table.string('base_url').notNullable().defaultTo('https://morpromt2f.moph.go.th')

      // Client_ID / Secret จาก CMS MOPH Notify — เข้ารหัสก่อนลง DB
      table.text('client_key').notNullable()
      table.text('secret_key').notNullable()

      table.boolean('is_active').notNullable().defaultTo(true)
      table.text('note').nullable()

      table.timestamp('last_tested_at', { useTz: true }).nullable()
      table.boolean('last_test_ok').nullable()
      table.text('last_test_error').nullable()
      table.timestamp('last_sent_at', { useTz: true }).nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })

    // --- ตั้งค่าการแจ้งเตือนสถานะระบบให้ทีมงาน (แถวเดียว) --------------------
    this.schema.createTable('notify_ops_settings', (table) => {
      table.increments('id')
      // null = ปิดการแจ้งเตือนทีมงาน
      table.integer('group_id').unsigned().nullable().references('id').inTable('notify_groups').onDelete('SET NULL')

      table.boolean('on_error').notNullable().defaultTo(true)
      table.boolean('on_recover').notNullable().defaultTo(true)
      table.boolean('on_send_failure').notNullable().defaultTo(true)
      table.boolean('on_restart').notNullable().defaultTo(true)
      table.integer('throttle_minutes').notNullable().defaultTo(30)

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })

    // --- ชุดดึงข้อมูลจาก HOSxP ----------------------------------------------
    // SQL ที่ผู้ดูแลเขียนเอง วิ่งผ่าน HosxpClient จึงเป็น SELECT ได้อย่างเดียว
    this.schema.createTable('notify_datasets', (table) => {
      table.increments('id')
      table.string('key', 60).notNullable().unique()
      table.string('name').notNullable()
      table.text('description').nullable()
      table.text('sql_text').notNullable()
      table.boolean('is_enabled').notNullable().defaultTo(true)

      table.timestamp('last_run_at', { useTz: true }).nullable()
      table.integer('last_row_count').nullable()
      table.integer('last_duration_ms').nullable()
      table.text('last_error').nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })

    // --- เทมเพลตข้อความ ------------------------------------------------------
    this.schema.createTable('notify_templates', (table) => {
      table.increments('id')
      table.string('key', 60).notNullable().unique()
      table.string('name').notNullable()
      table
        .integer('dataset_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('notify_datasets')
        .onDelete('SET NULL')
      table.text('body').notNullable()
      table.boolean('is_enabled').notNullable().defaultTo(true)

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })

    // --- ตารางเวลาส่งซ้ำ -----------------------------------------------------
    this.schema.createTable('notify_schedules', (table) => {
      table.increments('id')
      table.string('name').notNullable()
      table
        .integer('template_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('notify_templates')
        .onDelete('CASCADE')

      // daily | weekly | monthly
      table.string('frequency', 10).notNullable().defaultTo('daily')
      table.string('run_at', 5).notNullable().defaultTo('08:00')
      // weekly: [1..7] (จันทร์=1 ตาม ISO)  monthly: 1..31
      table.json('days_of_week').nullable()
      table.integer('day_of_month').nullable()

      table.boolean('is_enabled').notNullable().defaultTo(false)

      table.timestamp('last_run_at', { useTz: true }).nullable()
      table.string('last_status', 20).nullable()
      table.text('last_error').nullable()

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })

    this.schema.createTable('notify_schedule_groups', (table) => {
      table.increments('id')
      table
        .integer('schedule_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('notify_schedules')
        .onDelete('CASCADE')
      table
        .integer('group_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('notify_groups')
        .onDelete('CASCADE')
      table.unique(['schedule_id', 'group_id'])
    })

    // --- ประวัติการส่ง -------------------------------------------------------
    this.schema.createTable('notify_messages', (table) => {
      table.increments('id')
      table
        .integer('group_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('notify_groups')
        .onDelete('SET NULL')
      table.string('group_name').notNullable()

      // schedule | manual | ops | cdcu
      table.string('source', 20).notNullable().index()
      table.integer('schedule_id').unsigned().nullable()
      table.integer('template_id').unsigned().nullable()
      table.string('subject').nullable()

      // ข้อความตามที่ส่งออกไปจริง ผ่าน scrubCid มาแล้ว
      table.text('body').notNullable()

      table.string('status', 20).notNullable().index()
      table.integer('response_code').nullable()
      table.text('error').nullable()
      table.timestamp('sent_at', { useTz: true }).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().index()
    })

    // --- ประวัติการแก้ไข ------------------------------------------------------
    this.schema.createTable('notify_audit_logs', (table) => {
      table.increments('id')
      table.integer('user_id').unsigned().nullable()
      table.string('user_email').notNullable()

      // create | update | delete | send | test | toggle
      table.string('action', 20).notNullable().index()
      table.string('entity', 40).notNullable().index()
      table.string('entity_id', 40).nullable()
      table.string('summary', 255).notNullable()

      // ค่าก่อน/หลัง โดยค่าที่เป็นความลับถูกแทนด้วย "•••" ก่อนบันทึก
      table.json('changes').nullable()
      table.string('ip', 45).nullable()

      table.timestamp('created_at', { useTz: true }).notNullable().index()
    })

    // --- CDCU เฝ้าระวังโรค (แถวเดียว) ----------------------------------------
    this.schema.createTable('cdcu_settings', (table) => {
      table.increments('id')
      table.boolean('is_enabled').notNullable().defaultTo(false)
      table
        .integer('group_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('notify_groups')
        .onDelete('SET NULL')

      // เฝ้าทุกโรค หรือเฉพาะรหัสที่เลือก (code506 ของ name506)
      table.boolean('watch_all').notNullable().defaultTo(true)
      table.json('watched_codes').nullable()

      // ค่าตั้งต้นคือไม่ส่ง HN เข้ากลุ่ม — ต้องเลือกเปิดเอง
      table.boolean('include_hn').notNullable().defaultTo(false)

      table.string('quiet_start', 5).notNullable().defaultTo('21:00')
      table.string('quiet_end', 5).notNullable().defaultTo('07:00')
      table.integer('throttle_minutes').notNullable().defaultTo(10)

      table.timestamp('created_at', { useTz: true }).notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable()
    })

    // เคสที่เห็นแล้ว — กันแจ้งซ้ำที่ระดับฐานข้อมูลเหมือนที่ notifications ทำ
    this.schema.createTable('cdcu_seen', (table) => {
      table.increments('id')
      table.integer('sv_number').notNullable().unique()
      table.integer('code506').nullable()
      table.string('disease_name').nullable()
      table.date('report_date').nullable()
      table.boolean('notified').notNullable().defaultTo(false)
      table.timestamp('created_at', { useTz: true }).notNullable()
    })

    // เวอร์ชันก่อนหน้าเก็บกลุ่มเดียวไว้ที่ `notify_credentials`
    // ตอนนี้ย้ายมา notify_groups + notify_ops_settings แล้ว
    this.schema.dropTableIfExists('notify_credentials')
  }

  async down() {
    this.schema.dropTable('cdcu_seen')
    this.schema.dropTable('cdcu_settings')
    this.schema.dropTable('notify_audit_logs')
    this.schema.dropTable('notify_messages')
    this.schema.dropTable('notify_schedule_groups')
    this.schema.dropTable('notify_schedules')
    this.schema.dropTable('notify_templates')
    this.schema.dropTable('notify_datasets')
    this.schema.dropTable('notify_ops_settings')
    this.schema.dropTable('notify_groups')
  }
}
