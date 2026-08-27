import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * สร้างผู้ใช้แรกสำหรับเข้าหน้า admin
 *
 *   docker compose exec web node ace admin:create somchai@hospital.go.th 'รหัสผ่าน'
 */
export default class AdminCreate extends BaseCommand {
  static commandName = 'admin:create'
  static description = 'สร้างผู้ดูแลระบบสำหรับเข้าหน้าตั้งค่า'
  static options: CommandOptions = { startApp: true }

  @args.string({ description: 'อีเมลสำหรับเข้าสู่ระบบ' })
  declare email: string

  @args.string({ description: 'รหัสผ่าน' })
  declare password: string

  @args.string({ description: 'ชื่อ-นามสกุล', required: false })
  declare fullName?: string

  async run() {
    const { default: User } = await import('#models/user')

    if (this.password.length < 8) {
      this.logger.error('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร')
      this.exitCode = 1
      return
    }

    const existing = await User.findBy('email', this.email)
    if (existing) {
      existing.password = this.password
      if (this.fullName) existing.fullName = this.fullName
      await existing.save()
      this.logger.success(`อัปเดตรหัสผ่านของ ${this.email} แล้ว`)
      return
    }

    await User.create({
      email: this.email,
      password: this.password,
      fullName: this.fullName ?? null,
    })

    this.logger.success(`สร้างผู้ดูแลระบบ ${this.email} แล้ว`)
  }
}
