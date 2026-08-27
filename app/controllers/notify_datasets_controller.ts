import type { HttpContext } from '@adonisjs/core/http'

import { NotifyDataset, NotifyTemplate } from '#models/notify_system'
import { runDataset, runDatasetSql, SLOW_MS, MAX_ROWS } from '#services/dataset_runner'
import { withHosxp } from '#services/hosxp_session'
import { datasetPreviewValidator, datasetValidator } from '#validators/notify'
import { audit, diff } from '#services/audit'

/**
 * ตัวอย่างให้กดใช้ได้เลย ไม่ต้องเริ่มจากหน้าว่าง
 *
 * ทุกอันตรวจกับฐานจริงแล้วว่าอ่านได้และคืนค่าถูก ดู `notify:seed-examples`
 * ซึ่งใช้ชุดเดียวกันนี้สร้างเป็นชุดข้อมูลพร้อมการ์ดตัวอย่างให้เลย
 */
export const EXAMPLES = [
  {
    key: 'visits_today',
    name: 'ยอดผู้รับบริการรวมวันนี้',
    description: 'จำนวน visit และจำนวนคนไม่ซ้ำของวันนี้',
    sql: `SELECT COUNT(*) AS all_visits,
       COUNT(DISTINCT hn) AS patients
  FROM vn_stat
 WHERE vstdate = CURDATE()`,
  },
  {
    key: 'visits_by_dept',
    name: 'แยกตามแผนกวันนี้ (ER นับจาก er_regist · แผนไทยขึ้นเสมอ)',
    description:
      'main_dep นับ ER ไม่ครบ เพราะคนไข้ที่ผ่าน ER แล้วถูกส่งต่อจะถูกนับเป็นแผนกปลายทาง ' +
      'จึงตัด ER ออกจากฝั่ง main_dep แล้วเอาตัวเลขจริงจาก er_regist มาต่อท้าย ' +
      'ส่วนแพทย์แผนไทยแยกออกมาเป็น UNION เหมือนกัน เพื่อให้มีแถวขึ้นเสมอแม้วันนั้นไม่มีคนมา ' +
      'และตัด depcode 999 "กลับบ้าน" ทิ้ง เพราะเป็นสถานะ ไม่ใช่แผนกที่ให้บริการ',
    sql: `SELECT k.department AS department_name,
       COUNT(DISTINCT v.hn) AS patient_count
  FROM vn_stat v
  LEFT JOIN ovst o ON o.vn = v.vn
  LEFT JOIN kskdepartment k ON k.depcode = o.main_dep
 WHERE v.vstdate = CURDATE()
   AND COALESCE(o.main_dep, '') <> '999'
   AND (k.department IS NULL OR k.department NOT IN ('ER', 'แพทย์แผนไทย'))
 GROUP BY department_name
UNION ALL
SELECT 'ER', COUNT(DISTINCT v2.hn)
  FROM er_regist e
  LEFT JOIN vn_stat v2 ON v2.vn = e.vn
 WHERE v2.vstdate = CURDATE()
UNION ALL
SELECT 'แพทย์แผนไทย', COUNT(DISTINCT v3.hn)
  FROM vn_stat v3
  JOIN ovst o3 ON o3.vn = v3.vn
  JOIN kskdepartment k3 ON k3.depcode = o3.main_dep
                       AND k3.department = 'แพทย์แผนไทย'
 WHERE v3.vstdate = CURDATE()
 ORDER BY patient_count DESC`,
  },
  {
    key: 'services_today',
    name: 'บริการอื่นวันนี้ (ยา · Lab · X-Ray)',
    description:
      'นับจากทะเบียนของแต่ละงานตรง ๆ ไม่ผ่าน main_dep — ผู้รับยาดูจากรายการที่เบิกจริง ' +
      'ที่เป็นเวชภัณฑ์ยา (opitemrece × drugitems) ส่วน X-Ray ใช้ xray_head ' +
      'เพราะ xrayexam ของโรงพยาบาลนี้ว่างทั้งตาราง',
    sql: `SELECT 'ผู้รับยา' AS service, COUNT(DISTINCT o.vn) AS patient_count
  FROM opitemrece o
  JOIN drugitems d ON d.icode = o.icode
 WHERE o.vstdate = CURDATE()
UNION ALL
SELECT 'ห้อง Lab', COUNT(DISTINCT l.vn)
  FROM lab_head l
 WHERE l.order_date = CURDATE()
UNION ALL
SELECT 'X-Ray', COUNT(DISTINCT x.vn)
  FROM xray_head x
 WHERE x.order_date = CURDATE()`,
  },
  {
    key: 'pending_today',
    name: 'งานค้างวันนี้ (CC · Dx · Authen)',
    description:
      'งานที่ยังไม่ได้ลง ตัวเลขยิ่งน้อยยิ่งดี — "กลับบ้านแล้ว" ดูจาก ovst.cur_dep = 999 ' +
      'ซึ่งเป็นแผนก "กลับบ้าน" ใน kskdepartment ส่วน Authen นับเฉพาะสิทธิบัตรทอง (UCS) ' +
      'เพราะสิทธิอื่นไม่ต้อง authen กับ สปสช.',
    sql: `SELECT 'ยังไม่ลง CC' AS item, COUNT(*) AS patient_count
  FROM vn_stat v
  LEFT JOIN opdscreen s ON s.vn = v.vn
 WHERE v.vstdate = CURDATE()
   AND (s.cc IS NULL OR TRIM(s.cc) = '')
UNION ALL
SELECT 'กลับบ้านแล้วยังไม่ลง Dx', COUNT(*)
  FROM ovst o
  LEFT JOIN ovstdiag d ON d.vn = o.vn
 WHERE o.vstdate = CURDATE()
   AND o.cur_dep = '999'
   AND d.vn IS NULL
UNION ALL
SELECT 'บัตรทองยังไม่ Authen', COUNT(*)
  FROM vn_stat v2
  JOIN visit_pttype vp ON vp.vn = v2.vn
  JOIN pttype p ON p.pttype = v2.pttype
 WHERE v2.vstdate = CURDATE()
   AND p.hipdata_code = 'UCS'
   AND TRIM(COALESCE(vp.auth_code, '')) = ''`,
  },
  {
    key: 'rights_today',
    name: 'แยกตามสิทธิการรักษาวันนี้',
    description:
      'จัดกลุ่มด้วย pttype.hipdata_code ซึ่งเป็นรหัสมาตรฐาน ไม่ใช่ชื่อสิทธิที่โรงพยาบาลตั้งเอง ' +
      '(โรงพยาบาลนี้มีชื่อสิทธิย่อยกว่า 30 แบบ แต่ยุบเป็นกลุ่มมาตรฐานได้ 6 กลุ่ม)',
    sql: `SELECT CASE COALESCE(p.hipdata_code, '')
         WHEN 'UCS' THEN 'บัตรทอง (UC)'
         WHEN 'SSS' THEN 'ประกันสังคม'
         WHEN 'OFC' THEN 'ข้าราชการ'
         WHEN 'LGO' THEN 'อปท.'
         WHEN 'CSH' THEN 'ชำระเงินเอง'
         ELSE 'สิทธิอื่น'
       END AS right_name,
       COUNT(*) AS patient_count
  FROM vn_stat v
  LEFT JOIN pttype p ON p.pttype = v.pttype
 WHERE v.vstdate = CURDATE()
 GROUP BY right_name
 ORDER BY patient_count DESC`,
  },
  {
    key: 'refer_ipd_today',
    name: 'Refer และผู้ป่วยใน',
    description:
      '"IPD นอนอยู่" คือยอด ณ ขณะนี้ (dchdate ยังว่าง) ไม่ใช่ยอดของวันนี้ ' +
      'ต่างจากอีกสามบรรทัดที่เป็นเหตุการณ์ของวันนี้',
    sql: `SELECT 'Refer ออก' AS item, COUNT(*) AS patient_count
  FROM referout WHERE refer_date = CURDATE()
UNION ALL
SELECT 'Refer เข้า', COUNT(*) FROM referin WHERE refer_date = CURDATE()
UNION ALL
SELECT 'IPD รับใหม่', COUNT(*) FROM ipt WHERE regdate = CURDATE()
UNION ALL
SELECT 'IPD จำหน่าย', COUNT(*) FROM ipt WHERE dchdate = CURDATE()
UNION ALL
SELECT 'IPD นอนอยู่', COUNT(*) FROM ipt WHERE dchdate IS NULL`,
  },
  {
    key: 'ipd_by_ward',
    name: 'ผู้ป่วยในแยกตามตึก (ณ ขณะนี้)',
    description: 'ยอดที่ยังไม่จำหน่าย แยกตามตึก — เป็นยอด ณ ขณะที่รัน ไม่ใช่ยอดของวันนี้',
    sql: `SELECT w.name AS ward, COUNT(*) AS patient_count
  FROM ipt i
  LEFT JOIN ward w ON w.ward = i.ward
 WHERE i.dchdate IS NULL
 GROUP BY w.name
 ORDER BY patient_count DESC`,
  },
  {
    key: 'er_today',
    name: 'ER วันนี้',
    description: 'นับจากทะเบียน er_regist ตรง ๆ ไม่ผ่าน main_dep',
    sql: `SELECT COUNT(DISTINCT e.vn) AS er_visits
  FROM er_regist e
  LEFT JOIN vn_stat v ON v.vn = e.vn
 WHERE v.vstdate = CURDATE()`,
  },
  {
    key: 'surveil_7d',
    name: 'เคสเฝ้าระวัง 506 ใน 7 วัน',
    description: 'แยกตามโรคจากทะเบียน surveil_member',
    sql: `SELECT n.name AS disease, COUNT(*) AS cases
  FROM surveil_member s
  LEFT JOIN name506 n ON n.code = s.code506
 WHERE s.report_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
 GROUP BY n.name
 ORDER BY cases DESC`,
  },
]

export default class NotifyDatasetsController {
  async index({ view }: HttpContext) {
    const datasets = await NotifyDataset.query().orderBy('name')
    return view.render('pages/notify/datasets', { datasets, slowMs: SLOW_MS })
  }

  async create({ view }: HttpContext) {
    return view.render('pages/notify/dataset_form', {
      item: null,
      examples: EXAMPLES,
      maxRows: MAX_ROWS,
    })
  }

  async edit({ params, view, response, session }: HttpContext) {
    const item = await NotifyDataset.find(params.id)

    if (!item) {
      session.flash('error', 'ไม่พบชุดข้อมูลนี้')
      return response.redirect().toRoute('notify.datasets')
    }

    return view.render('pages/notify/dataset_form', { item, examples: EXAMPLES, maxRows: MAX_ROWS })
  }

  async store(ctx: HttpContext) {
    const { request, response, session } = ctx
    const data = await request.validateUsing(datasetValidator)

    if (await NotifyDataset.findBy('key', data.key)) {
      session.flash('error', `มีชุดข้อมูลชื่อย่อ "${data.key}" อยู่แล้ว`)
      return response.redirect().back()
    }

    const dataset = await NotifyDataset.create({
      key: data.key,
      name: data.name,
      description: data.description ?? null,
      sqlText: data.sqlText,
      isEnabled: Boolean(data.isEnabled),
    })

    await audit(ctx, {
      action: 'create',
      entity: 'dataset',
      entityId: dataset.id,
      summary: `เพิ่มชุดข้อมูล "${dataset.name}"`,
    })

    session.flash('success', `เพิ่มชุดข้อมูล "${dataset.name}" แล้ว`)
    return response.redirect().toRoute('notify.datasets')
  }

  async update(ctx: HttpContext) {
    const { params, request, response, session } = ctx
    const dataset = await NotifyDataset.find(params.id)

    if (!dataset) {
      session.flash('error', 'ไม่พบชุดข้อมูลนี้')
      return response.redirect().toRoute('notify.datasets')
    }

    const data = await request.validateUsing(datasetValidator)
    const clash = await NotifyDataset.findBy('key', data.key)

    if (clash && clash.id !== dataset.id) {
      session.flash('error', `มีชุดข้อมูลชื่อย่อ "${data.key}" อยู่แล้ว`)
      return response.redirect().back()
    }

    const before = dataset.serialize()

    dataset.merge({
      key: data.key,
      name: data.name,
      description: data.description ?? null,
      sqlText: data.sqlText,
      isEnabled: Boolean(data.isEnabled),
    })
    await dataset.save()

    await audit(ctx, {
      action: 'update',
      entity: 'dataset',
      entityId: dataset.id,
      summary: `แก้ไขชุดข้อมูล "${dataset.name}"`,
      changes: diff(before, dataset.serialize()),
    })

    session.flash('success', 'บันทึกแล้ว')
    return response.redirect().toRoute('notify.datasets')
  }

  async destroy(ctx: HttpContext) {
    const { params, response, session } = ctx
    const dataset = await NotifyDataset.find(params.id)

    if (!dataset) {
      session.flash('error', 'ไม่พบชุดข้อมูลนี้')
      return response.redirect().toRoute('notify.datasets')
    }

    // เทมเพลตที่อ้างถึงจะกลายเป็นไม่มีชุดข้อมูล (FK ตั้ง SET NULL ไว้)
    // บอกให้ชัดว่ากระทบอะไร ดีกว่าลบเงียบ ๆ แล้วข้อความเพี้ยนทีหลัง
    const affected = await NotifyTemplate.query().where('dataset_id', dataset.id)
    const name = dataset.name
    await dataset.delete()

    await audit(ctx, {
      action: 'delete',
      entity: 'dataset',
      entityId: params.id,
      summary: `ลบชุดข้อมูล "${name}"`,
    })

    session.flash(
      'success',
      affected.length
        ? `ลบชุดข้อมูล "${name}" แล้ว — เทมเพลต ${affected.length} อันที่ใช้อยู่จะไม่มีข้อมูลเติมให้`
        : `ลบชุดข้อมูล "${name}" แล้ว`
    )
    return response.redirect().toRoute('notify.datasets')
  }

  /** ลองวิ่ง SQL ที่กำลังพิมพ์อยู่ โดยยังไม่บันทึก */
  async preview({ request, response }: HttpContext) {
    const { sqlText } = await request.validateUsing(datasetPreviewValidator)

    try {
      const result = await withHosxp((client) => runDatasetSql(client, sqlText))

      if (!result) {
        return response.ok({ ok: false, error: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ HOSxP' })
      }

      return response.ok({
        ok: true,
        columns: result.columns,
        rows: result.rows.slice(0, 20),
        rowCount: result.rows.length,
        durationMs: result.durationMs,
        truncated: result.truncated,
        slow: result.durationMs > SLOW_MS,
      })
    } catch (error) {
      return response.ok({ ok: false, error: error.message })
    }
  }

  /** วิ่งชุดข้อมูลที่บันทึกไว้แล้ว พร้อมอัปเดตสถิติ */
  async run({ params, response }: HttpContext) {
    const dataset = await NotifyDataset.find(params.id)
    if (!dataset) return response.notFound({ ok: false, error: 'ไม่พบชุดข้อมูลนี้' })

    try {
      const result = await runDataset(dataset)
      return response.ok({
        ok: true,
        columns: result.columns,
        rows: result.rows.slice(0, 20),
        rowCount: result.rows.length,
        durationMs: result.durationMs,
        truncated: result.truncated,
        slow: result.durationMs > SLOW_MS,
      })
    } catch (error) {
      return response.ok({ ok: false, error: error.message })
    }
  }
}
