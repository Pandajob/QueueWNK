/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const AuthController = () => import('#controllers/auth_controller')
const SettingsController = () => import('#controllers/settings_controller')
const StatusController = () => import('#controllers/status_controller')
const UsersController = () => import('#controllers/users_controller')
const TemplatesController = () => import('#controllers/templates_controller')
const TestSendController = () => import('#controllers/test_send_controller')
const PollerController = () => import('#controllers/poller_controller')
const NotifyController = () => import('#controllers/notify_controller')
const NotifyGroupsController = () => import('#controllers/notify_groups_controller')
const NotifyDatasetsController = () => import('#controllers/notify_datasets_controller')
const NotifyTemplatesController = () => import('#controllers/notify_templates_controller')
const NotifySchedulesController = () => import('#controllers/notify_schedules_controller')
const CdcuController = () => import('#controllers/cdcu_controller')
const DbSyncController = () => import('#controllers/db_sync_controller')
const CcmController = () => import('#controllers/ccm_controller')

router.on('/').redirect('status')

router
  .group(() => {
    router.get('/login', [AuthController, 'showLogin']).as('login')
    router.post('/login', [AuthController, 'login']).as('login.submit')
  })
  .use(middleware.guest())

router.post('/logout', [AuthController, 'logout']).as('logout').use(middleware.auth())

/**
 * หน้าตั้งค่าเปิดเผยรหัสผ่านฐานข้อมูลและ key ของ MOPH
 * ต้องล็อกอินเสมอ ไม่มีข้อยกเว้น
 */
router
  .group(() => {
    router.get('/status', [StatusController, 'index']).as('status')

    router.get('/settings', [SettingsController, 'index']).as('settings.index')

    router.get('/settings/poller', [PollerController, 'settings']).as('poller.settings')
    router.post('/settings/poller', [PollerController, 'saveSettings']).as('poller.settings.save')
    router.get('/log', [PollerController, 'log']).as('poller.log')
    router.post('/log/:id/retry', [PollerController, 'retry']).as('poller.retry')
    router.post('/log/reset', [PollerController, 'resetToday']).as('poller.reset')
    router.post('/log/clear-old', [PollerController, 'clearOld']).as('poller.clearOld')

    router.get('/settings/templates', [TemplatesController, 'index']).as('templates.index')
    router.get('/settings/templates/:key', [TemplatesController, 'edit']).as('templates.edit')
    router.post('/settings/templates/:key', [TemplatesController, 'update']).as('templates.update')

    router.get('/test', [TestSendController, 'index']).as('test.index')
    router.post('/test/preview', [TestSendController, 'preview']).as('test.preview')
    router.post('/test/send', [TestSendController, 'send']).as('test.send')

    router.get('/settings/users', [UsersController, 'index']).as('users.index')
    router.get('/settings/users/new', [UsersController, 'create']).as('users.create')
    router.post('/settings/users', [UsersController, 'store']).as('users.store')
    router.get('/settings/users/:id/edit', [UsersController, 'edit']).as('users.edit')
    router.post('/settings/users/:id', [UsersController, 'update']).as('users.update')
    router.post('/settings/users/:id/delete', [UsersController, 'destroy']).as('users.destroy')

    router.get('/settings/hosxp', [SettingsController, 'hosxp']).as('settings.hosxp')
    router.post('/settings/hosxp', [SettingsController, 'saveHosxp']).as('settings.hosxp.save')
    router.post('/settings/hosxp/test', [SettingsController, 'testHosxp']).as('settings.hosxp.test')

    router.get('/settings/db-sync', [DbSyncController, 'index']).as('settings.dbsync')
    router.post('/settings/db-sync', [DbSyncController, 'save']).as('settings.dbsync.save')
    router.post('/settings/db-sync/check', [DbSyncController, 'check']).as('settings.dbsync.check')
    router
      .post('/settings/db-sync/preview', [DbSyncController, 'preview'])
      .as('settings.dbsync.preview')
    router.post('/settings/db-sync/send', [DbSyncController, 'send']).as('settings.dbsync.send')

    router.get('/settings/moph', [SettingsController, 'moph']).as('settings.moph')
    router.post('/settings/moph', [SettingsController, 'saveMoph']).as('settings.moph.save')
    router.post('/settings/moph/test', [SettingsController, 'testMoph']).as('settings.moph.test')

    router.get('/settings/notify', [SettingsController, 'notify']).as('settings.notify')
    router.post('/settings/notify', [SettingsController, 'saveNotify']).as('settings.notify.save')

    // --- ระบบ MOPH Notify --------------------------------------------------
    router.get('/notify', [NotifyController, 'dashboard']).as('notify.dashboard')
    router.get('/notify/history', [NotifyController, 'history']).as('notify.history')
    router.get('/notify/history/:id', [NotifyController, 'showMessage']).as('notify.message')
    router.get('/notify/audit', [NotifyController, 'audit']).as('notify.audit')

    router.get('/notify/groups', [NotifyGroupsController, 'index']).as('notify.groups')
    router.get('/notify/groups/new', [NotifyGroupsController, 'create']).as('notify.groups.create')
    router.post('/notify/groups', [NotifyGroupsController, 'store']).as('notify.groups.store')
    router
      .post('/notify/groups/test', [NotifyGroupsController, 'test'])
      .as('notify.groups.test.new')
    router.get('/notify/groups/:id/edit', [NotifyGroupsController, 'edit']).as('notify.groups.edit')
    router.post('/notify/groups/:id', [NotifyGroupsController, 'update']).as('notify.groups.update')
    router
      .post('/notify/groups/:id/delete', [NotifyGroupsController, 'destroy'])
      .as('notify.groups.destroy')
    router
      .post('/notify/groups/:id/test', [NotifyGroupsController, 'test'])
      .as('notify.groups.test')
    router
      .post('/notify/groups/:id/send-test', [NotifyGroupsController, 'sendTest'])
      .as('notify.groups.send')

    router.get('/notify/datasets', [NotifyDatasetsController, 'index']).as('notify.datasets')
    router
      .get('/notify/datasets/new', [NotifyDatasetsController, 'create'])
      .as('notify.datasets.create')
    router.post('/notify/datasets', [NotifyDatasetsController, 'store']).as('notify.datasets.store')
    router
      .post('/notify/datasets/preview', [NotifyDatasetsController, 'preview'])
      .as('notify.datasets.preview')
    router
      .get('/notify/datasets/:id/edit', [NotifyDatasetsController, 'edit'])
      .as('notify.datasets.edit')
    router
      .post('/notify/datasets/:id', [NotifyDatasetsController, 'update'])
      .as('notify.datasets.update')
    router
      .post('/notify/datasets/:id/delete', [NotifyDatasetsController, 'destroy'])
      .as('notify.datasets.destroy')
    router
      .post('/notify/datasets/:id/run', [NotifyDatasetsController, 'run'])
      .as('notify.datasets.run')

    router.get('/notify/templates', [NotifyTemplatesController, 'index']).as('notify.templates')
    router
      .get('/notify/templates/new', [NotifyTemplatesController, 'create'])
      .as('notify.templates.create')
    router
      .post('/notify/templates', [NotifyTemplatesController, 'store'])
      .as('notify.templates.store')
    router
      .get('/notify/templates/:id/edit', [NotifyTemplatesController, 'edit'])
      .as('notify.templates.edit')
    router
      .post('/notify/templates/:id', [NotifyTemplatesController, 'update'])
      .as('notify.templates.update')
    router
      .post('/notify/templates/:id/delete', [NotifyTemplatesController, 'destroy'])
      .as('notify.templates.destroy')
    router
      .post('/notify/templates/:id/preview', [NotifyTemplatesController, 'preview'])
      .as('notify.templates.preview')
    router
      .get('/notify/templates/:id/send', [NotifyTemplatesController, 'sendForm'])
      .as('notify.templates.send.form')
    router
      .post('/notify/templates/:id/send', [NotifyTemplatesController, 'send'])
      .as('notify.templates.send')

    router.get('/notify/schedules', [NotifySchedulesController, 'index']).as('notify.schedules')
    router
      .get('/notify/schedules/new', [NotifySchedulesController, 'create'])
      .as('notify.schedules.create')
    router
      .post('/notify/schedules', [NotifySchedulesController, 'store'])
      .as('notify.schedules.store')
    router
      .get('/notify/schedules/:id/edit', [NotifySchedulesController, 'edit'])
      .as('notify.schedules.edit')
    router
      .post('/notify/schedules/:id', [NotifySchedulesController, 'update'])
      .as('notify.schedules.update')
    router
      .post('/notify/schedules/:id/delete', [NotifySchedulesController, 'destroy'])
      .as('notify.schedules.destroy')
    router
      .post('/notify/schedules/:id/toggle', [NotifySchedulesController, 'toggle'])
      .as('notify.schedules.toggle')

    router.get('/notify/cdcu', [CdcuController, 'index']).as('notify.cdcu')
    router.post('/notify/cdcu', [CdcuController, 'save']).as('notify.cdcu.save')

    // --- MOPH CCM ----------------------------------------------------------
    router.get('/ccm', [CcmController, 'index']).as('ccm.index')
  })
  .use(middleware.auth())
