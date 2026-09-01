/**
 * โครงเมนูของทั้งแอป
 *
 * แถบบน = เลือกว่าจะเข้าระบบไหน · sidebar = เมนูของระบบนั้น
 *
 * เก็บไว้ที่นี่ที่เดียวเป็น TypeScript ไม่ใช่กระจายใน Edge เพราะ
 *   - หน้าใหม่ที่ลืมใส่เมนูจะจับได้ด้วยเทสต์ (ทุก key ต้องอยู่ในระบบใดระบบหนึ่ง)
 *   - key ซ้ำข้ามระบบจะทำให้ไฮไลต์ผิด จึงมีเทสต์คุมว่าห้ามซ้ำ
 *
 * แต่ละหน้าใส่ `active: '<key>'` ตอน @component('layouts/main') แล้ว layout
 * ย้อนหา key นั้นเองว่าอยู่ระบบไหน ไม่ต้องบอกซ้ำว่าอยู่ระบบอะไร
 */

export type NavItem = {
  /** ตรงกับค่า active ที่หน้านั้นส่งเข้า layout */
  key: string
  label: string
  /** ชื่อ route ให้ Edge เอาไปเข้า route() เอง */
  route: string
}

export type NavGroup = {
  title: string
  items: NavItem[]
}

export type NavSystem = {
  key: string
  label: string
  caption: string
  /** หน้าแรกของระบบ ใช้ตอนกดที่แถบบน */
  route: string
  groups: NavGroup[]
}

export const NAV_SYSTEMS: NavSystem[] = [
  {
    key: 'alert',
    label: 'Alert',
    caption: 'แจ้งเตือนคิวผู้ป่วย',
    route: 'poller.log',
    groups: [
      {
        title: 'หลัก',
        items: [
          { key: 'log', label: 'บันทึกการส่ง', route: 'poller.log' },
          { key: 'test', label: 'ทดสอบส่ง', route: 'test.index' },
        ],
      },
      {
        title: 'ข้อความ',
        items: [
          { key: 'templates', label: 'ข้อความแจ้งเตือน', route: 'templates.index' },
          { key: 'poller', label: 'การส่ง', route: 'poller.settings' },
          { key: 'appointment', label: 'แจ้งเตือนนัดหมาย', route: 'appointment.index' },
        ],
      },
      {
        title: 'เชื่อมต่อ',
        items: [{ key: 'moph', label: 'MOPH Alert', route: 'settings.moph' }],
      },
    ],
  },
  {
    key: 'notify',
    label: 'Notify',
    caption: 'แจ้งเตือนกลุ่มเจ้าหน้าที่',
    route: 'notify.dashboard',
    groups: [
      {
        title: 'หลัก',
        items: [
          { key: 'nt-dashboard', label: 'แดชบอร์ด', route: 'notify.dashboard' },
          { key: 'nt-schedules', label: 'ตารางเวลา', route: 'notify.schedules' },
          { key: 'nt-cdcu', label: 'CDCU เฝ้าระวังโรค', route: 'notify.cdcu' },
        ],
      },
      {
        title: 'ข้อมูล',
        items: [
          { key: 'nt-templates', label: 'เทมเพลตข้อความ', route: 'notify.templates' },
          { key: 'nt-datasets', label: 'รายการข้อมูล', route: 'notify.datasets' },
          { key: 'nt-groups', label: 'กลุ่ม LINE', route: 'notify.groups' },
        ],
      },
      {
        title: 'ระบบ',
        items: [
          { key: 'nt-history', label: 'ประวัติการส่ง', route: 'notify.history' },
          { key: 'nt-audit', label: 'ประวัติการแก้ไข', route: 'notify.audit' },
        ],
      },
    ],
  },
  {
    key: 'ccm',
    label: 'CCM',
    caption: 'บรอดแคสต์หมอพร้อม',
    route: 'ccm.index',
    groups: [
      {
        title: 'หลัก',
        items: [{ key: 'ccm', label: 'ภาพรวม', route: 'ccm.index' }],
      },
    ],
  },
  /**
   * เฝ้าสุขภาพของระบบ — คนละกลุ่มผู้ใช้กับสามระบบข้างบน
   *
   * สามหน้านี้เคยกระจายอยู่คนละแท็บ (สถานะอยู่ใต้ Alert · แจ้งเตือนทีมงานอยู่ใต้ Notify ·
   * เทียบเครื่องฐานข้อมูลอยู่ใต้ ระบบ) ทั้งที่คนเปิดคือทีมไอทีชุดเดียวกัน
   * และไม่มีหน้าไหนเกี่ยวกับ "จะส่งอะไรหาใคร" ซึ่งเป็นเกณฑ์แบ่งของอีกสามแท็บ
   *
   * URL ของทุกหน้าไม่ได้เปลี่ยนตาม — bookmark เดิมยังใช้ได้
   */
  {
    key: 'monitor',
    label: 'Monitor',
    caption: 'สุขภาพเครื่องและฐานข้อมูล',
    route: 'status',
    groups: [
      {
        title: 'หลัก',
        items: [
          { key: 'status', label: 'สถานะ', route: 'status' },
          { key: 'dbsync', label: 'เทียบเครื่องฐานข้อมูล', route: 'settings.dbsync' },
        ],
      },
      {
        title: 'แจ้งเตือน',
        items: [{ key: 'notify', label: 'แจ้งเตือนทีมงาน', route: 'settings.notify' }],
      },
    ],
  },
  {
    key: 'system',
    label: 'ระบบ',
    caption: 'ตั้งค่าที่ใช้ร่วมกัน',
    route: 'settings.index',
    groups: [
      {
        title: 'ตั้งค่า',
        items: [
          { key: 'settings', label: 'ภาพรวม', route: 'settings.index' },
          { key: 'hosxp', label: 'ฐานข้อมูล HOSxP', route: 'settings.hosxp' },
          { key: 'users', label: 'ผู้ใช้', route: 'users.index' },
        ],
      },
    ],
  },
]

/** ทุก key ที่มีเมนูรองรับ ใช้ในเทสต์ */
export function allNavKeys() {
  return NAV_SYSTEMS.flatMap((system) => system.groups.flatMap((g) => g.items.map((i) => i.key)))
}

/**
 * หาว่า key นี้อยู่ระบบไหน
 *
 * หน้าย่อยอย่างฟอร์มแก้ไขใช้ key เดียวกับหน้ารายการ จึงไฮไลต์เมนูเดิมได้เลย
 * key ที่ไม่รู้จัก (เช่นหน้า login) คืน null แล้ว layout จะไม่แสดง sidebar
 */
export function findNavSystem(activeKey: string | undefined | null) {
  if (!activeKey) return null

  return (
    NAV_SYSTEMS.find((system) =>
      system.groups.some((group) => group.items.some((item) => item.key === activeKey))
    ) ?? null
  )
}
