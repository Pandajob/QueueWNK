import vine from '@vinejs/vine'

/** ใช้เป็น key ของชุดข้อมูล/เทมเพลต — ต้องพิมพ์ในเทมเพลตได้ง่าย */
const slug = vine
  .string()
  .trim()
  .minLength(2)
  .maxLength(60)
  .regex(/^[a-z0-9_]+$/)

export const groupValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(120),
    hcode: vine.string().trim().maxLength(10).optional(),
    baseUrl: vine.string().trim().url({ require_protocol: true }),
    // ว่างไว้ = ไม่เปลี่ยนของเดิม
    clientKey: vine.string().optional(),
    secretKey: vine.string().optional(),
    note: vine.string().trim().maxLength(500).optional(),
    isActive: vine.accepted().optional(),
    supportsFlex: vine.accepted().optional(),
  })
)

export const opsValidator = vine.compile(
  vine.object({
    groupId: vine.number().positive().optional(),
    onError: vine.accepted().optional(),
    onRecover: vine.accepted().optional(),
    onSendFailure: vine.accepted().optional(),
    onRestart: vine.accepted().optional(),
    throttleMinutes: vine.number().range([1, 1440]),
  })
)

export const datasetValidator = vine.compile(
  vine.object({
    key: slug,
    name: vine.string().trim().minLength(1).maxLength(120),
    description: vine.string().trim().maxLength(500).optional(),
    sqlText: vine.string().trim().minLength(6).maxLength(8000),
    isEnabled: vine.accepted().optional(),
  })
)

export const datasetPreviewValidator = vine.compile(
  vine.object({
    sqlText: vine.string().trim().minLength(6).maxLength(8000),
  })
)

export const templateValidator = vine.compile(
  vine.object({
    key: slug,
    name: vine.string().trim().minLength(1).maxLength(120),
    datasetId: vine.number().positive().optional(),
    messageType: vine.enum(['text', 'flex'] as const),
    // ข้อความธรรมดาบังคับกรอก ส่วนการ์ด Flex ใช้บล็อกแทน
    body: vine.string().trim().maxLength(4000).optional(),
    altText: vine.string().trim().maxLength(200).optional(),
    // ส่งมาเป็น JSON string จากตัวแก้ไข ตรวจโครงสร้างในคอนโทรลเลอร์
    flexBlocks: vine.string().maxLength(60_000).optional(),
    flexColor: vine
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    isEnabled: vine.accepted().optional(),
  })
)

export const scheduleValidator = vine.compile(
  vine.object({
    name: vine.string().trim().minLength(1).maxLength(120),
    templateId: vine.number().positive(),
    frequency: vine.enum(['daily', 'weekly', 'monthly'] as const),
    runAt: vine.string().regex(/^\d{2}:\d{2}$/),
    daysOfWeek: vine.array(vine.number().range([1, 7])).optional(),
    dayOfMonth: vine.number().range([1, 31]).optional(),
    groups: vine.array(vine.number().positive()).optional(),
    isEnabled: vine.accepted().optional(),
  })
)

export const cdcuValidator = vine.compile(
  vine.object({
    isEnabled: vine.accepted().optional(),
    groupId: vine.number().positive().optional(),
    watchAll: vine.accepted().optional(),
    watchedCodes: vine.array(vine.number()).optional(),
    includeHn: vine.accepted().optional(),
    includeName: vine.accepted().optional(),
    includePhone: vine.accepted().optional(),
    quietStart: vine.string().regex(/^\d{2}:\d{2}$/),
    quietEnd: vine.string().regex(/^\d{2}:\d{2}$/),
    throttleMinutes: vine.number().range([1, 1440]),
  })
)

export const dbSyncValidator = vine.compile(
  vine.object({
    isEnabled: vine.accepted().optional(),
    groupId: vine.number().positive().optional(),
    checkEveryMinutes: vine.number().range([1, 1440]),
    lagWarnSeconds: vine.number().range([0, 86_400]),
    rowGapWarn: vine.number().range([0, 100_000]),
    gtidLagWarn: vine.number().range([0, 10_000_000]),
    throttleMinutes: vine.number().range([1, 1440]),
    notifyOnRecover: vine.accepted().optional(),
    messageStyle: vine.enum(['text', 'digest', 'flex'] as const),
    cardColor: vine
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/),
    // ว่าง = ไม่ส่งรายงานประจำวัน
    digestAt: vine
      .string()
      .trim()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),

    // แถวของเครื่อง — ล้างช่อง host แล้วบันทึก = ลบเครื่องนั้น
    hosts: vine
      .array(
        vine.object({
          id: vine.number().positive().optional(),
          label: vine.string().trim().maxLength(120).optional(),
          host: vine.string().trim().maxLength(190).optional(),
          port: vine.number().range([1, 65_535]).optional(),
          username: vine.string().trim().maxLength(190).optional(),
          // ว่าง = ไม่เปลี่ยนของเดิม
          password: vine.string().optional(),
          enabled: vine.enum(['1', '0'] as const).optional(),
        })
      )
      .optional(),
  })
)

export const manualSendValidator = vine.compile(
  vine.object({
    templateId: vine.number().positive(),
    groups: vine.array(vine.number().positive()).minLength(1),
  })
)

/**
 * ตั้งค่าแจ้งเตือนนัดหมาย
 *
 * daysAhead จำกัด 0–30 — 0 คือแจ้งเช้าวันนัด ส่วนเกิน 30 วันไม่มีใครจำได้
 * และยิ่งล่วงหน้ามาก โอกาสที่นัดจะถูกยกเลิกหลังส่งไปแล้วก็ยิ่งสูง
 */
export const appointmentValidator = vine.compile(
  vine.object({
    isEnabled: vine.accepted().optional(),
    dryRun: vine.accepted().optional(),
    daysAhead: vine.number().range([0, 30]),
    sendAt: vine.string().regex(/^\d{2}:\d{2}$/),
    allClinics: vine.accepted().optional(),
    clinicCodes: vine.array(vine.string().maxLength(3)).optional(),
    messageTitle: vine.string().trim().minLength(1).maxLength(120),
    messageText: vine.string().trim().maxLength(2000),
    messageHtml: vine.string().trim().maxLength(4000),
  })
)
