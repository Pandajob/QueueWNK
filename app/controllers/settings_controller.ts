import type { HttpContext } from '@adonisjs/core/http'
import HosxpConnection from '#models/hosxp_connection'
import MophCredential from '#models/moph_credential'
import User from '#models/user'
import { DepartmentSetting, PollerSetting } from '#models/poller_models'
import { NotifyGroup, NotifyOpsSetting } from '#models/notify_system'
import { DbHost, DbSyncSetting } from '#models/db_sync'
import { testHosxpConnection } from '#services/hosxp_tester'
import { MophClient } from '#services/moph_client'
import { SUPPORTED_CHARSETS } from '#services/hosxp_client'
import { hosxpValidator, mophValidator } from '#validators/settings'
import { opsValidator } from '#validators/notify'
import { audit, diff } from '#services/audit'
import { DateTime } from 'luxon'

export default class SettingsController {
  /** หน้ารวมทางเข้าการตั้งค่าทั้งหมด พร้อมบอกว่าส่วนไหนพร้อมแล้ว */
  async index({ view }: HttpContext) {
    const [hosxp, moph, notify, poller, departments, users, dbSync, watchedHosts] =
      await Promise.all([
        HosxpConnection.active(),
        MophCredential.active(),
        NotifyOpsSetting.current(),
        PollerSetting.current(),
        DepartmentSetting.query().where('is_enabled', true).count('* as total').first(),
        User.query().count('* as total').first(),
        DbSyncSetting.current(),
        DbHost.query().where('is_enabled', true).count('* as total').first(),
      ])

    const enabledDepartments = Number(departments?.$extras.total ?? 0)
    const hostCount = Number(watchedHosts?.$extras.total ?? 0)

    return view.render('pages/settings/index', {
      cards: [
        {
          href: '/settings/hosxp',
          title: 'ฐานข้อมูล HOSxP',
          description: 'เครื่อง ผู้ใช้ รหัสผ่าน และ charset ที่ใช้อ่านข้อมูลคิว',
          state: hosxp?.lastTestOk ? 'ok' : hosxp ? 'warn' : 'fail',
          status: hosxp
            ? hosxp.lastTestOk
              ? `${hosxp.host}:${hosxp.port}/${hosxp.database}`
              : 'ตั้งค่าแล้ว แต่ยังทดสอบไม่ผ่าน'
            : 'ยังไม่ได้ตั้งค่า',
        },
        {
          href: '/settings/moph',
          title: 'MOPH Alert',
          description: 'client-key และ secret-key จาก CMS MOPH ALERTING',
          state: moph?.lastTestOk ? 'ok' : moph ? 'warn' : 'fail',
          status: moph
            ? moph.lastTestOk
              ? 'key ใช้งานได้'
              : 'ตั้งค่าแล้ว แต่ยังทดสอบไม่ผ่าน'
            : 'ยังไม่ได้ตั้งค่า',
        },
        {
          href: '/settings/templates',
          title: 'ข้อความแจ้งเตือน',
          description: 'ข้อความที่ผู้ป่วยจะเห็นในแต่ละเคส',
          state: 'ok',
          status: '4 เคส',
        },
        {
          href: '/settings/poller',
          title: 'การส่ง',
          description: 'โหมดทดสอบ ช่วงเวลางดส่ง เกณฑ์ใกล้ถึงคิว และห้องที่จะแจ้ง',
          state: poller.dryRun ? 'warn' : enabledDepartments ? 'ok' : 'warn',
          status: poller.dryRun
            ? `โหมดทดสอบ · เปิด ${enabledDepartments} ห้อง`
            : `ส่งจริง · เปิด ${enabledDepartments} ห้อง`,
        },
        {
          href: '/settings/db-sync',
          title: 'เทียบเครื่องฐานข้อมูล',
          description: 'ดูว่าเครื่องฐานข้อมูลทุกเครื่องมีข้อมูลตรงกันไหม',
          // ตรวจแล้วเจอปัญหาสำคัญกว่า "ยังไม่ได้เปิดเฝ้า" จึงเช็คผลตรวจก่อน
          state: dbSync.lastReport?.shouldAlert ? 'fail' : dbSync.isEnabled ? 'ok' : 'warn',
          status: dbSync.lastReport
            ? `${dbSync.lastReport.headline}${dbSync.isEnabled ? '' : ' · ยังไม่ได้เปิดเฝ้า'}`
            : `เฝ้า ${hostCount} เครื่อง · ยังไม่เคยตรวจ`,
        },
        {
          href: '/settings/notify',
          title: 'แจ้งเตือนทีมงาน',
          description: 'ส่งสถานะระบบเข้ากลุ่ม LINE ของทีมไอทีผ่าน MOPH Notify',
          state: notify.groupId ? 'ok' : 'warn',
          status: notify.groupId ? 'เปิดใช้งาน' : 'ยังไม่ได้เลือกกลุ่ม (ไม่บังคับ)',
        },
        {
          href: '/settings/users',
          title: 'ผู้ใช้',
          description: 'ผู้ที่เข้าหน้าตั้งค่าได้',
          state: 'ok',
          status: `${Number(users?.$extras.total ?? 0)} คน`,
        },
      ],
    })
  }

  // --- HOSxP ---------------------------------------------------------------

  async hosxp({ view }: HttpContext) {
    const connection = await HosxpConnection.active()

    return view.render('pages/settings/hosxp', {
      connection,
      charsets: SUPPORTED_CHARSETS,
    })
  }

  async saveHosxp({ request, response, session }: HttpContext) {
    const data = await request.validateUsing(hosxpValidator)
    const connection = (await HosxpConnection.active()) ?? new HosxpConnection()

    connection.merge({
      label: data.label,
      host: data.host,
      port: data.port,
      database: data.database,
      username: data.username,
      charset: data.charset,
      isActive: true,
    })

    // ฟอร์มไม่เคยส่งรหัสผ่านเดิมกลับมา ว่างไว้จึงแปลว่า "ไม่เปลี่ยน"
    if (data.password) {
      connection.password = data.password
    }

    await connection.save()

    session.flash('success', 'บันทึกการตั้งค่า HOSxP แล้ว')
    return response.redirect().toRoute('settings.hosxp')
  }

  /**
   * ทดสอบด้วยค่าที่กรอกอยู่ในฟอร์ม โดยยังไม่บันทึก
   * ผู้ใช้จะได้ลองหลาย charset ได้โดยไม่ต้องเซฟทับของเดิม
   */
  async testHosxp({ request, response }: HttpContext) {
    const data = await request.validateUsing(hosxpValidator)
    const stored = await HosxpConnection.active()
    const password = data.password || stored?.password

    if (!password) {
      return response.ok({
        ok: false,
        checks: [{ label: 'รหัสผ่าน', status: 'fail', detail: 'ยังไม่ได้กรอกรหัสผ่าน' }],
      })
    }

    const result = await testHosxpConnection({
      host: data.host,
      port: data.port,
      database: data.database,
      username: data.username,
      password,
      charset: data.charset,
    })

    if (stored) {
      stored.lastTestedAt = DateTime.now()
      stored.lastTestOk = result.ok
      stored.lastTestError = result.ok
        ? null
        : (result.checks.find((c) => c.status === 'fail')?.detail ?? null)
      await stored.save()
    }

    return response.ok(result)
  }

  // --- MOPH Alert ----------------------------------------------------------

  async moph({ view }: HttpContext) {
    const credential = await MophCredential.active()
    return view.render('pages/settings/moph', { credential })
  }

  async saveMoph({ request, response, session }: HttpContext) {
    const data = await request.validateUsing(mophValidator)
    const credential = (await MophCredential.active()) ?? new MophCredential()

    credential.merge({
      label: data.label,
      baseUrl: data.baseUrl,
      isActive: true,
    })

    if (data.clientKey) credential.clientKey = data.clientKey
    if (data.secretKey) credential.secretKey = data.secretKey

    await credential.save()

    session.flash('success', 'บันทึกการตั้งค่า MOPH Alert แล้ว')
    return response.redirect().toRoute('settings.moph')
  }

  async testMoph({ request, response }: HttpContext) {
    const data = await request.validateUsing(mophValidator)
    const stored = await MophCredential.active()
    const clientKey = data.clientKey || stored?.clientKey
    const secretKey = data.secretKey || stored?.secretKey

    if (!clientKey || !secretKey) {
      return response.ok({
        ok: false,
        checks: [{ label: 'Key', status: 'fail', detail: 'ยังไม่ได้กรอก Client ID หรือ Secret' }],
      })
    }

    const result = await new MophClient({
      baseUrl: data.baseUrl,
      clientKey,
      secretKey,
    }).verify()

    if (stored) {
      stored.lastTestedAt = DateTime.now()
      stored.lastTestOk = result.ok
      stored.lastTestError = result.ok
        ? null
        : (result.checks.find((c) => c.status === 'fail')?.detail ?? null)
      await stored.save()
    }

    return response.ok(result)
  }

  // --- แจ้งเตือนทีมงาน (เลือกกลุ่ม + เรื่องที่จะเตือน) ------------------------
  //
  // ตัว key ของกลุ่มไม่ได้อยู่หน้านี้ — อยู่ที่ /notify/groups เพราะกลุ่มเดียวกัน
  // อาจถูกใช้ทั้งแจ้งเตือนระบบ ส่งตามตารางเวลา และแจ้งเคส 506

  async notify({ view }: HttpContext) {
    return view.render('pages/settings/notify', {
      settings: await NotifyOpsSetting.current(),
      groups: await NotifyGroup.query().where('is_active', true).orderBy('name'),
    })
  }

  async saveNotify(ctx: HttpContext) {
    const { request, response, session } = ctx
    const data = await request.validateUsing(opsValidator)
    const settings = await NotifyOpsSetting.current()
    const before = settings.serialize()

    settings.merge({
      groupId: data.groupId ?? null,
      onError: Boolean(data.onError),
      onRecover: Boolean(data.onRecover),
      onSendFailure: Boolean(data.onSendFailure),
      onRestart: Boolean(data.onRestart),
      throttleMinutes: data.throttleMinutes,
    })
    await settings.save()

    await audit(ctx, {
      action: 'update',
      entity: 'ops_alert',
      entityId: settings.id,
      summary: 'แก้ไขการแจ้งเตือนสถานะระบบให้ทีมงาน',
      changes: diff(before, settings.serialize()),
    })

    session.flash(
      'success',
      settings.groupId
        ? 'บันทึกแล้ว'
        : 'บันทึกแล้ว — ยังไม่ได้เลือกกลุ่ม จึงยังไม่มีการแจ้งเตือนออกไป'
    )
    return response.redirect().toRoute('settings.notify')
  }
}
