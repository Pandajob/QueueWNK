import type { HttpContext } from '@adonisjs/core/http'
import User from '#models/user'
import vine from '@vinejs/vine'

const loginValidator = vine.compile(
  vine.object({
    email: vine.string().trim().email(),
    password: vine.string(),
  })
)

export default class AuthController {
  async showLogin({ view }: HttpContext) {
    return view.render('pages/auth/login')
  }

  async login({ request, response, auth, session }: HttpContext) {
    const { email, password } = await request.validateUsing(loginValidator)

    try {
      const user = await User.verifyCredentials(email, password)
      await auth.use('web').login(user)
    } catch {
      session.flash('error', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง')
      return response.redirect().toRoute('login')
    }

    return response.redirect().toRoute('settings.hosxp')
  }

  async logout({ response, auth }: HttpContext) {
    await auth.use('web').logout()
    return response.redirect().toRoute('login')
  }
}
