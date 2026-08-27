import type { HttpContext } from '@adonisjs/core/http'
import User from '#models/user'
import vine from '@vinejs/vine'

const createValidator = vine.compile(
  vine.object({
    fullName: vine.string().trim().maxLength(120).optional(),
    email: vine.string().trim().email().normalizeEmail(),
    password: vine.string().minLength(8).maxLength(200),
  })
)

const updateValidator = vine.compile(
  vine.object({
    fullName: vine.string().trim().maxLength(120).optional(),
    email: vine.string().trim().email().normalizeEmail(),
    // เว้นว่าง = ไม่เปลี่ยนรหัสผ่าน
    password: vine.string().minLength(8).maxLength(200).optional(),
  })
)

export default class UsersController {
  async index({ view, auth }: HttpContext) {
    const users = await User.query().orderBy('id', 'asc')
    return view.render('pages/settings/users', { users, currentUserId: auth.user!.id })
  }

  async create({ view }: HttpContext) {
    return view.render('pages/settings/user_form', { user: null })
  }

  async store({ request, response, session }: HttpContext) {
    const data = await request.validateUsing(createValidator)

    if (await User.findBy('email', data.email)) {
      session.flash('error', `มีผู้ใช้อีเมล ${data.email} อยู่แล้ว`)
      return response.redirect().toRoute('users.create')
    }

    await User.create({
      email: data.email,
      password: data.password,
      fullName: data.fullName ?? null,
    })

    session.flash('success', `เพิ่มผู้ใช้ ${data.email} แล้ว`)
    return response.redirect().toRoute('users.index')
  }

  async edit({ params, view, response, session }: HttpContext) {
    const user = await User.find(params.id)
    if (!user) {
      session.flash('error', 'ไม่พบผู้ใช้')
      return response.redirect().toRoute('users.index')
    }
    return view.render('pages/settings/user_form', { user })
  }

  async update({ params, request, response, session }: HttpContext) {
    const user = await User.find(params.id)
    if (!user) {
      session.flash('error', 'ไม่พบผู้ใช้')
      return response.redirect().toRoute('users.index')
    }

    const data = await request.validateUsing(updateValidator)

    const clash = await User.query().where('email', data.email).whereNot('id', user.id).first()
    if (clash) {
      session.flash('error', `อีเมล ${data.email} ถูกใช้โดยผู้ใช้อื่นแล้ว`)
      return response.redirect().toRoute('users.edit', { id: user.id })
    }

    user.email = data.email
    user.fullName = data.fullName ?? null
    if (data.password) user.password = data.password
    await user.save()

    session.flash('success', `บันทึกข้อมูล ${user.email} แล้ว`)
    return response.redirect().toRoute('users.index')
  }

  async destroy({ params, response, session, auth }: HttpContext) {
    const user = await User.find(params.id)
    if (!user) {
      session.flash('error', 'ไม่พบผู้ใช้')
      return response.redirect().toRoute('users.index')
    }

    // ลบตัวเองแล้วจะหลุดออกจากระบบทันทีโดยไม่ตั้งใจ
    if (user.id === auth.user!.id) {
      session.flash('error', 'ลบบัญชีที่กำลังใช้งานอยู่ไม่ได้')
      return response.redirect().toRoute('users.index')
    }

    // ถ้าลบคนสุดท้ายได้ จะไม่มีใครเข้าหน้าตั้งค่าได้อีกเลย
    const total = await User.query().count('* as total').first()
    if (Number(total?.$extras.total ?? 0) <= 1) {
      session.flash('error', 'ต้องเหลือผู้ใช้อย่างน้อยหนึ่งคน')
      return response.redirect().toRoute('users.index')
    }

    const email = user.email
    await user.delete()

    session.flash('success', `ลบผู้ใช้ ${email} แล้ว`)
    return response.redirect().toRoute('users.index')
  }
}
