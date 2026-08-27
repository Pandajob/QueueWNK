import edge from 'edge.js'
import { NAV_SYSTEMS, findNavSystem } from '#services/navigation'

/**
 * โครงเมนูเป็น global ของ Edge — ทุกหน้าใช้ layout เดียวกัน
 * จึงไม่ต้องให้ทุก controller ส่งเมนูมาเองซ้ำ ๆ
 */
edge.global('navSystems', NAV_SYSTEMS)
edge.global('findNavSystem', findNavSystem)
