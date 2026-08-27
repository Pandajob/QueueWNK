import env from '#start/env'
import { defineConfig } from '@adonisjs/lucid'

/**
 * ฐานข้อมูลของแอปเราเอง — MariaDB ให้ตรงกับที่โรงพยาบาลใช้อยู่
 *
 * ที่นี่มีแค่ connection เดียว การเชื่อมต่อ HOSxP **ไม่ได้อยู่ใน Lucid**
 * โดยตั้งใจ มันไปอยู่ที่ app/services/hosxp_client.ts ซึ่งเป็น mysql2 ดิบ
 * ที่ปฏิเสธ SQL ทุกอย่างที่ไม่ใช่การอ่าน
 *
 * เหตุผล: ถ้าเอา HOSxP มาเป็น connection ใน Lucid จะมี migration runner
 * และ model ที่ save() ได้ชี้ไปที่ฐานโรงพยาบาลทันที พลาดครั้งเดียวก็เสียหาย
 */
const dbConfig = defineConfig({
  connection: 'mysql',
  connections: {
    mysql: {
      client: 'mysql2',
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: env.get('DB_USER'),
        password: env.get('DB_PASSWORD'),
        database: env.get('DB_DATABASE'),
        timezone: '+07:00',
      },
      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },
    },
  },
})

export default dbConfig
