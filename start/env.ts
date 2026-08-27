/*
|--------------------------------------------------------------------------
| Environment variables service
|--------------------------------------------------------------------------
|
| The `Env.create` method creates an instance of the Env service. The
| service validates the environment variables and also cast values
| to JavaScript data types.
|
*/

import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  APP_KEY: Env.schema.string(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.string(),

  /*
  |----------------------------------------------------------
  | Variables for configuring session package
  |----------------------------------------------------------
  */
  SESSION_DRIVER: Env.schema.enum(['cookie', 'memory'] as const),

  /*
  |----------------------------------------------------------
  | ส่ง cookie เฉพาะเมื่อเชื่อมต่อผ่าน HTTPS หรือไม่
  |----------------------------------------------------------
  |
  | ไม่ระบุ = false เพราะโรงพยาบาลส่วนใหญ่เปิดหน้าเว็บนี้ผ่าน http://<ไอพี>:3333
  | บนวงแลนภายใน ถ้าตั้งเป็น true ในสภาพนั้น เบราว์เซอร์จะไม่ส่ง cookie กลับมาเลย
  | ผลคือล็อกอินแล้วเด้งกลับหน้าล็อกอินวนไปเรื่อย ๆ โดยไม่มีข้อความบอกว่าผิดตรงไหน
  |
  | ตั้งเป็น true เมื่อมี HTTPS อยู่หน้าระบบแล้วเท่านั้น
  */
  COOKIE_SECURE: Env.schema.boolean.optional(),

  /*
  |----------------------------------------------------------
  | Variables for configuring database connection
  |----------------------------------------------------------
  */
  DB_HOST: Env.schema.string({ format: 'host' }),
  DB_PORT: Env.schema.number(),
  DB_USER: Env.schema.string(),
  DB_PASSWORD: Env.schema.string.optional(),
  DB_DATABASE: Env.schema.string(),
})
