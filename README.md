<img src="data/dev.yulian.Cinders.svg" alt="Cinders" width="128" height="128" align="left"/>

# Cinders

**Get Git forges notifications**

<br>

[![Please do not theme this app](https://stopthemingmy.app/badge.svg)](https://stopthemingmy.app)

<p align="center">
  <img src="data/screenshots/1.png"/>
</p>

## Description
Simple notifier app with support for GitHub, GitLab, Gitea, Forgejo and Tangled.

## Install
Cinders is a fork of Forge Sparks and currently builds from source.

### Build from source

You can clone and run from GNOME Builder.

#### Requirements

- GJS (>= 1.72) `gjs`
- GTK4 (>= 4.10) `gtk4`
- libadwaita (>= 1.5.0) `libadwaita`
- libsoup (>= 3.0) `libsoup`
- libsecret (>= 0.20) `libsecret`
- libportal (>= 0.7) `libportal`
- Meson `meson`
- Ninja `ninja`

Alternatively, use the following commands to build it with meson.
```bash
meson builddir --prefix=/usr/local
sudo ninja -C builddir install
```

## Translations
Cinders inherits translations from Forge Sparks. Newly renamed strings may need translation updates.

## Credits
Maintained by **Yulian Kuncheff**. Based on Forge Sparks by **[Rafael Mardojai CM](https://mardojai.com)** and contributors.

## Code of Conduct
The project follows the [GNOME Code of Conduct](https://wiki.gnome.org/Foundation/CodeOfConduct).
