import HosxpConnection from '#models/hosxp_connection'
import { HosxpClient } from '#services/hosxp_client'

/**
 * เปิดการเชื่อมต่อ HOSxP จากค่าที่ตั้งไว้ในหน้าเว็บ
 *
 * แยกออกมาเพราะตอนนี้มีสามที่ที่ต้องต่อ (poller, ชุดข้อมูล, CDCU)
 * และทุกที่ต้องเช็คว่าตั้งค่าครบก่อนเหมือนกันหมด
 */
export async function openHosxp() {
  const settings = await HosxpConnection.active()
  if (!settings?.password) return null

  return HosxpClient.connect({
    host: settings.host,
    port: settings.port,
    database: settings.database,
    username: settings.username,
    password: settings.password,
    charset: settings.charset,
  })
}

/** เปิด ใช้ แล้วปิดให้เสมอ แม้ callback จะ throw */
export async function withHosxp<T>(fn: (client: HosxpClient) => Promise<T>): Promise<T | null> {
  const client = await openHosxp()
  if (!client) return null

  try {
    return await fn(client)
  } finally {
    await client.close()
  }
}
