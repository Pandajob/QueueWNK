import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

import type { FlexBlock } from '#services/flex_builder'

/**
 * สร้างชุดข้อมูลตัวอย่างกับการ์ดสรุปประจำวันให้พร้อมใช้
 *
 * รันซ้ำได้ — ของที่มีอยู่แล้วจะข้าม ไม่เขียนทับสิ่งที่ผู้ดูแลแก้ไว้เอง
 * การ์ดที่สร้างให้ปิดใช้งานไว้ก่อน ต้องเข้าไปกดดูตัวอย่างแล้วเปิดเอง
 *
 *   docker compose exec web node ace notify:seed-examples --probe
 */
export default class NotifySeedExamples extends BaseCommand {
  static commandName = 'notify:seed-examples'
  static description = 'สร้างชุดข้อมูลตัวอย่างและการ์ดสรุปประจำวัน'
  static options: CommandOptions = { startApp: true }

  // ตั้งชื่อ probe ไม่ใช่ run เพราะ run เป็นชื่อเมธอดของ BaseCommand เอง
  @flags.boolean({ description: 'ลองรันทุกชุดข้อมูลกับ HOSxP หลังสร้างเสร็จ' })
  declare probe: boolean

  @flags.boolean({
    description: 'เขียนทับ SQL ของชุดข้อมูลตัวอย่างและบล็อกของการ์ด daily_summary ด้วยตัวล่าสุด',
  })
  declare refresh: boolean

  async run() {
    const { NotifyDataset, NotifyTemplate } = await import('#models/notify_system')
    const { EXAMPLES } = await import('#controllers/notify_datasets_controller')
    const { runDataset } = await import('#services/dataset_runner')

    let created = 0

    for (const example of EXAMPLES) {
      const existing = await NotifyDataset.findBy('key', example.key)

      if (existing) {
        if (!this.refresh) {
          this.logger.log(`  ข้าม ${example.key} — มีอยู่แล้ว`)
          continue
        }

        if (existing.sqlText.trim() === example.sql.trim()) {
          this.logger.log(`  ${example.key} — SQL ตรงกับตัวล่าสุดอยู่แล้ว`)
          continue
        }

        existing.merge({
          name: example.name,
          description: example.description,
          sqlText: example.sql,
        })
        await existing.save()
        this.logger.warning(`  เขียนทับ SQL ของ ${example.key} ด้วยตัวล่าสุด`)
        continue
      }

      await NotifyDataset.create({
        key: example.key,
        name: example.name,
        description: example.description,
        sqlText: example.sql,
        isEnabled: true,
      })

      created++
      this.logger.log(`  สร้าง ${example.key} — ${example.name}`)
    }

    // รันหนึ่งรอบให้รู้จักชื่อคอลัมน์ ตัวแก้ไขการ์ดจะได้เสนอเป็น dropdown ได้
    if (this.probe) {
      this.logger.info('ลองรันชุดข้อมูลกับ HOSxP')

      for (const example of EXAMPLES) {
        const dataset = await NotifyDataset.findBy('key', example.key)
        if (!dataset) continue

        try {
          const result = await runDataset(dataset)
          this.logger.log(
            `  ${dataset.key}: ${result.rows.length} แถว · ${result.durationMs} ms · ` +
              `คอลัมน์ ${result.columns.join(', ')}`
          )
        } catch (error) {
          this.logger.error(`  ${dataset.key}: ${error.message}`)
        }
      }
    }

    // การ์ดสรุปประจำวัน — ประกอบจากชุดข้อมูลข้างบนหลายอันรวมกัน
    const card = await NotifyTemplate.findBy('key', 'daily_summary')

    if (card && !this.refresh) {
      this.logger.log('  ข้าม daily_summary — มีอยู่แล้ว')
    } else {
      const total = await NotifyDataset.findBy('key', 'visits_today')

      // --refresh เขียนทับเฉพาะบล็อก ไม่แตะสีกับสถานะเปิด/ปิดที่ผู้ดูแลตั้งไว้เอง
      const blocks: FlexBlock[] = [
        { type: 'header', title: 'สรุปผู้รับบริการ', subtitle: '{date} {time} น.' },
        { type: 'hero', label: 'ผู้รับบริการทั้งหมด', value: '{all_visits}', unit: 'ราย' },
        {
          type: 'bars',
          title: 'แยกตามแผนก',
          datasetKey: 'visits_by_dept',
          labelColumn: 'department_name',
          valueColumn: 'patient_count',
          // แพทย์แผนไทยมีแถวขึ้นเสมอจาก SQL — วันไหนไม่มีคนมาจะขึ้นเลข 0 สีแดง
          alertWhen: 'zero',
        },
        { type: 'divider' },
        { type: 'text', text: 'ผู้ป่วยไม่ซ้ำคน {patients} ราย', tone: 'muted' },

        // ทั้งชุดยัดการ์ดใบเดียววัดได้ 13 KB เกินเพดาน 10 KB ต่อข้อความของ LINE
        // ใบที่สองเป็นงานเบื้องหลัง ใบแรกเป็นภาพรวมที่คนส่วนใหญ่ดูแค่นี้พอ
        { type: 'pagebreak' },
        {
          type: 'rows',
          title: 'บริการอื่น',
          datasetKey: 'services_today',
          labelColumn: 'service',
          valueColumn: 'patient_count',
        },
        {
          type: 'rows',
          title: 'สิทธิการรักษา',
          datasetKey: 'rights_today',
          labelColumn: 'right_name',
          valueColumn: 'patient_count',
        },
        {
          type: 'rows',
          title: 'Refer และผู้ป่วยใน',
          datasetKey: 'refer_ipd_today',
          labelColumn: 'item',
          valueColumn: 'patient_count',
        },
        {
          type: 'rows',
          title: 'ผู้ป่วยในแยกตามตึก',
          datasetKey: 'ipd_by_ward',
          labelColumn: 'ward',
          valueColumn: 'patient_count',
        },
        { type: 'divider' },
        {
          type: 'rows',
          title: 'งานค้าง',
          datasetKey: 'pending_today',
          labelColumn: 'item',
          valueColumn: 'patient_count',
          // ตรงกันข้ามกับแผนก — งานค้างศูนย์คือเรื่องดี ไม่ใช่ศูนย์ต่างหากที่ต้องรีบ
          alertWhen: 'nonzero',
        },
      ]

      if (card) {
        card.flexBlocks = blocks
        await card.save()
        created++
        this.logger.warning('  เขียนทับบล็อกของการ์ด daily_summary ด้วยตัวล่าสุด')
      } else {
        await NotifyTemplate.create({
          key: 'daily_summary',
          name: 'สรุปผู้รับบริการประจำวัน',
          messageType: 'flex',
          altText: 'สรุปผู้รับบริการ {date} — {all_visits} ราย',
          flexColor: '#f97316',
          body: '',
          // ปิดไว้ก่อน ให้เข้าไปกดดูตัวอย่างแล้วค่อยเปิดเอง
          isEnabled: false,
          datasetId: total?.id ?? null,
          flexBlocks: blocks,
        })

        created++
        this.logger.log('  สร้างการ์ด daily_summary (ปิดใช้งานไว้ก่อน)')
      }
    }

    if (!created) {
      this.logger.info('ไม่มีอะไรต้องสร้างเพิ่ม')
      return
    }

    this.logger.success(`สร้างแล้ว ${created} รายการ`)
    this.logger.info('ดูชุดข้อมูลที่ /notify/datasets และการ์ดที่ /notify/templates')
  }
}
