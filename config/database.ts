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
        /**
         * บังคับ utf8mb4 อย่าตัดออก
         *
         * MariaDB ของ server40 ตั้ง character_set_client เป็น tis620 ไว้
         * (น่าจะเพื่อรองรับแอปไทยรุ่นเก่า) ถ้าไม่บังคับตรงนี้ การค้นภาษาไทย
         * จะไม่เจออะไรเลยเพราะไบต์ UTF-8 ที่ส่งไปถูกตีความเป็น tis620
         * และข้อความไทยที่เขียนลงไปมีโอกาสเพี้ยนถาวร
         */
        charset: 'utf8mb4',
      },
      /**
       * บังคับ utf8mb4 ทุกครั้งที่เปิด connection ใหม่
       *
       * MariaDB ของ server40 ตั้งไว้สามอย่างที่ทำให้ charset ฝั่ง client ไม่มีผล
       *   character-set-server = tis620
       *   skip-character-set-client-handshake   ← เมินสิ่งที่ client ขอตอน handshake
       *   init_connect = SET NAMES tis620       ← ยัด tis620 ให้ทุก connection
       *
       * ตั้งไว้เพื่อรองรับแอปไทยรุ่นเก่าบนเครื่องเดียวกัน แก้ที่เซิร์ฟเวอร์ไม่ได้
       * เพราะแอปอื่นพึ่งพาอยู่ จึงต้องสั่ง SET NAMES เองหลัง init_connect ทำงานเสร็จ
       *
       * ถ้าไม่มีบรรทัดนี้ ค้นภาษาไทยจะไม่เจออะไรเลย และข้อความไทยที่เขียนลงฐาน
       * มีโอกาสเพี้ยนถาวร
       */
      pool: {
        afterCreate: (conn: any, done: (err: unknown, conn: unknown) => void) => {
          conn.query('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci', (err: unknown) =>
            done(err, conn)
          )
        },
      },

      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },
    },
  },
})

export default dbConfig
