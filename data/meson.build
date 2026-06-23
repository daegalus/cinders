
desktop_conf = configuration_data()
desktop_conf.set('app_id', application_id)
desktop_conf.set('command', meson.project_name())
desktop_file = i18n.merge_file(
  input: configure_file(
    input: 'dev.yulian.Cinders.desktop.in.in',
    output: 'dev.yulian.Cinders.desktop.in',
    configuration: desktop_conf
  ),
  output: '@0@.desktop'.format(application_id),
  type: 'desktop',
  po_dir: '../po',
  install: true,
  install_dir: datadir / 'applications'
)

desktop_file_validate = find_program('desktop-file-validate', required: false)
if desktop_file_validate.found()
  test('Validate desktop file', desktop_file_validate,
    args: [desktop_file]
  )
endif

appstream_conf = configuration_data()
appstream_conf.set('app_id', application_id)
appstream_file = i18n.merge_file(
  input: configure_file(
    input: 'dev.yulian.Cinders.metainfo.xml.in.in',
    output: 'dev.yulian.Cinders.metainfo.xml.in',
    configuration: appstream_conf
  ),
  output: '@0@.metainfo.xml'.format(application_id),
  po_dir: '../po',
  install: true,
  install_dir: datadir / 'metainfo'
)

appstreamcli = find_program('appstreamcli', required: false)
if appstreamcli.found()
  test('Validate appstream file', appstreamcli,
    args: ['validate', '--no-net', '--explain', appstream_file],
    workdir: meson.current_build_dir()
  )
endif

gschema_conf = configuration_data()
gschema_conf.set('app_id', application_id)
configure_file(
  input: 'dev.yulian.Cinders.gschema.xml',
  output: '@0@.gschema.xml'.format(application_id),
  configuration: gschema_conf,
  install: true,
  install_dir: datadir / 'glib-2.0/schemas'
)

compile_schemas = find_program('glib-compile-schemas', required: false)
if compile_schemas.found()
  test('Validate schema file', compile_schemas,
    args: ['--strict', '--dry-run', meson.current_source_dir()]
  )
endif

service_conf = configuration_data()
service_conf.set('app_id', application_id)
service_conf.set('bindir', bindir)
service_conf.set('command', meson.project_name())
configure_file(
  input: 'dev.yulian.Cinders.service.in',
  output: '@0@.service'.format(application_id),
  configuration: service_conf,
  install_dir: datadir / 'dbus-1/services'
)

if profile == 'Devel'
  app_icon = 'dev.yulian.CindersDevel.svg'
else
  app_icon = 'dev.yulian.Cinders.svg'
endif

install_data(
  app_icon,
  install_dir: datadir / 'icons/hicolor/scalable/apps',
  rename: '@0@.svg'.format(application_id)
)

install_data(
  'dev.yulian.Cinders-symbolic.svg',
  install_dir: datadir / 'icons/hicolor/symbolic/apps',
  rename: '@0@-symbolic.svg'.format(application_id)
)
