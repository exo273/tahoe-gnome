#!/usr/bin/env bash
#
# Instalador OPCIONAL del tema MacTahoe GTK/Shell para tahoe-gnome.
#
# El tema no se distribuye en este repositorio: se descarga desde el proyecto
# upstream de Vince Liuice (vinceliuice), licencia MIT (COPYING del upstream).
#
# Uso:
#   bash scripts/install-mactahoe-theme.sh [--apply] [--libadwaita]
#
# Garantías de seguridad:
#   - No se ejecuta con root/sudo.
#   - Sólo se escribe en $HOME (~/.themes y los archivos de usuario que crea
#     el propio instalador upstream).
#   - No se toca /usr/share ni el gresource global de GNOME Shell.
#   - Se muestra el comando upstream antes de ejecutarlo.
#   - --libadwaita se rechaza a propósito: el upstream sobrescribe
#     ~/.config/gtk-4.0 y no hace copia de seguridad.

set -Eeuo pipefail

readonly UPSTREAM_URL="https://github.com/vinceliuice/MacTahoe-gtk-theme.git"
readonly THEME_NAME="MacTahoe"
readonly USER_THEME_SCHEMA="org.gnome.shell.extensions.user-theme"
readonly USER_THEME_UUID="user-theme@gnome-shell-extensions.gcampax.github.com"

APPLY=false
LIBADWAITA=false
CACHE_DIR=""
SHIM_DIR=""
TMP_CLONE=""
USER_SCHEMA_DIR=""

usage() {
  cat <<'EOF'
Instala opcionalmente el tema MacTahoe GTK/Shell desde su repositorio upstream.

Uso:
  bash scripts/install-mactahoe-theme.sh [--apply] [--libadwaita]

Opciones:
  --apply       Tras instalar, aplica el tema GTK según color-scheme
                (MacTahoe-Dark o MacTahoe-Light) y, si el esquema de
                User Themes está disponible, ajusta su nombre. No activa
                la extensión User Themes.
  --libadwaita  No implementado por seguridad. Muestra las instrucciones
                para hacerlo manualmente con copia de seguridad.
  -h, --help    Muestra esta ayuda.

El tema se clona en:
  ${XDG_CACHE_HOME:-$HOME/.cache}/tahoe-gnome/mactahoe-gtk-theme

No requiere sudo y no escribe en /usr/share.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

log() {
  printf '%s\n' "$*"
}

warn() {
  printf 'Aviso: %s\n' "$*" >&2
}

cleanup() {
  if [[ -n ${SHIM_DIR:-} ]]; then
    rm -rf "$SHIM_DIR"
  fi
  if [[ -n ${TMP_CLONE:-} ]]; then
    rm -rf "$TMP_CLONE"
  fi
}

trap cleanup EXIT

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --apply)
        APPLY=true
        ;;
      --libadwaita)
        LIBADWAITA=true
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      --)
        shift
        break
        ;;
      *)
        usage >&2
        die "Opción no reconocida: $1"
        ;;
    esac
    shift
  done

  if (($# > 0)); then
    usage >&2
    die "Argumentos no reconocidos: $*"
  fi
}

refuse_libadwaita() {
  cat >&2 <<'EOF'
--libadwaita no está implementado a propósito.

El instalador upstream (-l) escribe directamente en ~/.config/gtk-4.0:
  gtk.css, gtk-dark.css, gtk-Light.css, gtk-Dark.css,
  assets/ y windows-assets/
Sobrescribe la configuración GTK4 del usuario, no hace copia de seguridad y
deja un tema fijo que no se puede alternar entre claro y oscuro. Por eso este
script no lo ejecuta.

Si aun así quieres hacerlo manualmente, haz primero una copia de seguridad:

  backup="$HOME/.config/gtk-4.0.backup-$(date +%Y%m%d-%H%M%S)"
  cp -a "$HOME/.config/gtk-4.0" "$backup"
  cd /ruta/al/clon/MacTahoe-gtk-theme
  ./install.sh -l -c light    # o -c dark

Para restaurar:

  rm -rf "$HOME/.config/gtk-4.0"
  mv "$backup" "$HOME/.config/gtk-4.0"

La sincronización de tahoe-gnome sólo cambia el enlace gtk.css si ya existe;
no instala ni sobrescribe libadwaita por su cuenta.
EOF
  exit 2
}

check_deps() {
  local dep
  local missing=()

  for dep in git sassc glib-compile-resources xmllint; do
    if ! command -v "$dep" >/dev/null 2>&1; then
      missing+=("$dep")
    fi
  done

  if ((${#missing[@]} > 0)); then
    printf 'Faltan dependencias: %s\n' "${missing[*]}" >&2
    cat >&2 <<'EOF'
Instálalas con tu gestor de paquetes. Este script no usa sudo ni instala
paquetes del sistema:

  Fedora:        sudo dnf install git sassc glib2-devel libxml2
  Debian/Ubuntu: sudo apt install git sassc libglib2.0-dev-bin libxml2-utils
EOF
    exit 1
  fi
}

prepare_source() {
  local parent
  local origin

  parent="$(dirname "$CACHE_DIR")"
  mkdir -p "$parent"

  if [[ -e "$CACHE_DIR" ]]; then
    if [[ ! -d "$CACHE_DIR/.git" || ! -f "$CACHE_DIR/install.sh" ]]; then
      die "La caché '$CACHE_DIR' existe pero no es un clon válido. Elimínala y vuelve a ejecutar."
    fi

    origin="$(git -C "$CACHE_DIR" config --get remote.origin.url 2>/dev/null || true)"
    case "$origin" in
      "$UPSTREAM_URL"|"${UPSTREAM_URL%.git}"|"git@github.com:vinceliuice/MacTahoe-gtk-theme.git")
        ;;
      *)
        die "La caché '$CACHE_DIR' apunta a '$origin', no a '$UPSTREAM_URL'. Elimínala y vuelve a ejecutar."
        ;;
    esac

    log "Actualizando la copia en caché..."
    if git -C "$CACHE_DIR" fetch --depth=1 origin >/dev/null 2>&1; then
      if ! git -C "$CACHE_DIR" reset --hard FETCH_HEAD >/dev/null 2>&1; then
        warn "No se pudo actualizar la caché; se usará la copia existente."
      fi
    else
      warn "No se pudo contactar con el repositorio; se usará la copia en caché."
    fi
  else
    TMP_CLONE="${CACHE_DIR}.tmp.$$"
    rm -rf "$TMP_CLONE"

    log "Clonando $UPSTREAM_URL ..."
    if ! GIT_TERMINAL_PROMPT=0 git clone --depth=1 --single-branch "$UPSTREAM_URL" "$TMP_CLONE"; then
      die "No se pudo clonar el repositorio upstream. Revisa tu conexión o la URL."
    fi

    mv "$TMP_CLONE" "$CACHE_DIR"
    TMP_CLONE=""
  fi

  SRC="$CACHE_DIR"
  if [[ ! -f "$SRC/install.sh" || ! -f "$SRC/COPYING" ]]; then
    die "El clon no contiene install.sh/COPYING. La caché '$CACHE_DIR' no es válida."
  fi

  log "Fuente: $SRC (commit $(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo '?'))"
}

create_sudo_shim() {
  local name

  SHIM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tahoe-gnome-install.XXXXXX")"

  for name in sudo pkexec doas; do
    cat > "$SHIM_DIR/$name" <<'EOF'
#!/bin/sh
printf 'Bloqueado por install-mactahoe-theme.sh: no se permite ejecutar %s.\n' "$0" >&2
exit 1
EOF
    chmod 700 "$SHIM_DIR/$name"
  done
}

run_upstream() {
  local cmd=(bash "$SRC/install.sh" -d "$HOME/.themes" -c light -c dark)

  log ""
  log "Comando del instalador upstream que se ejecutará (sin sudo):"
  printf '  '
  printf '%q ' "${cmd[@]}"
  printf '\n\n'

  if ! (
    export PATH="$SHIM_DIR:$PATH"
    export GIT_TERMINAL_PROMPT=0
    "${cmd[@]}"
  ); then
    die "El instalador upstream terminó con error. No se modificó nada fuera de tu HOME."
  fi
}

verify_variant() {
  local dir="$HOME/.themes/${THEME_NAME}-$1"

  [[ -f "$dir/index.theme" ]] &&
    [[ -f "$dir/gtk-3.0/gtk.css" ]] &&
    [[ -f "$dir/gtk-4.0/gtk.css" ]] &&
    [[ -f "$dir/gnome-shell/gnome-shell.css" ]]
}

verify_install() {
  local variant
  local missing=()

  for variant in Light Dark; do
    if ! verify_variant "$variant"; then
      missing+=("${THEME_NAME}-${variant}")
    fi
  done

  if ((${#missing[@]} > 0)); then
    printf 'No se encontraron los temas esperados:\n' >&2
    printf '  %s/.themes/%s\n' "$HOME" "${missing[@]}" >&2
    die "El instalador upstream no generó ~/.themes/MacTahoe-Light y MacTahoe-Dark."
  fi
}

find_user_theme_schema() {
  local candidate
  local data_home="${XDG_DATA_HOME:-$HOME/.local/share}"

  USER_SCHEMA_DIR=""

  if gsettings list-schemas 2>/dev/null | grep -Fqx "$USER_THEME_SCHEMA"; then
    return 0
  fi

  for candidate in \
    "$data_home/gnome-shell/extensions/$USER_THEME_UUID/schemas" \
    "/usr/share/gnome-shell/extensions/$USER_THEME_UUID/schemas"; do
    if [[ -f "$candidate/gschemas.compiled" ]] &&
      GSETTINGS_SCHEMA_DIR="$candidate" gsettings list-schemas 2>/dev/null | grep -Fqx "$USER_THEME_SCHEMA"; then
      USER_SCHEMA_DIR="$candidate"
      return 0
    fi
  done

  return 1
}

user_theme_gsettings() {
  if [[ -n "$USER_SCHEMA_DIR" ]]; then
    GSETTINGS_SCHEMA_DIR="$USER_SCHEMA_DIR" gsettings "$@"
  else
    gsettings "$@"
  fi
}

apply_desktop_theme() {
  local scheme
  local variant
  local enabled

  if ! command -v gsettings >/dev/null 2>&1; then
    warn "gsettings no está disponible; el tema quedó instalado pero no se aplicó."
    return 1
  fi

  scheme="$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null || true)"
  case "$scheme" in
    *prefer-dark*)
      variant="Dark"
      ;;
    *)
      variant="Light"
      ;;
  esac

  log "Aplicando ${THEME_NAME}-${variant} (color-scheme=${scheme:-no disponible})..."
  log "  gsettings set org.gnome.desktop.interface gtk-theme ${THEME_NAME}-${variant}"

  if ! gsettings set org.gnome.desktop.interface gtk-theme "${THEME_NAME}-${variant}"; then
    warn "No se pudo cambiar org.gnome.desktop.interface gtk-theme."
    return 1
  fi

  if find_user_theme_schema; then
    if [[ -n "$USER_SCHEMA_DIR" ]]; then
      log "  GSETTINGS_SCHEMA_DIR=$USER_SCHEMA_DIR gsettings set $USER_THEME_SCHEMA name ${THEME_NAME}-${variant}"
    else
      log "  gsettings set $USER_THEME_SCHEMA name ${THEME_NAME}-${variant}"
    fi

    if user_theme_gsettings set "$USER_THEME_SCHEMA" name "${THEME_NAME}-${variant}"; then
      log "User Themes: name=${THEME_NAME}-${variant}"
    else
      warn "No se pudo cambiar el nombre del tema de User Themes."
    fi

    enabled="$(user_theme_gsettings get org.gnome.shell enabled-extensions 2>/dev/null || true)"
    if [[ "$enabled" == *"$USER_THEME_UUID"* ]]; then
      log "User Themes ya estaba activa; no se ha activado nada."
    else
      log "User Themes no está activa; no se activa automáticamente."
    fi
  else
    log "Esquema de User Themes no disponible; se omite el tema de GNOME Shell."
  fi

  log "gtk-theme actual: $(gsettings get org.gnome.desktop.interface gtk-theme 2>/dev/null || echo 'desconocido')"
}

main() {
  parse_args "$@"

  if [[ $LIBADWAITA == true ]]; then
    refuse_libadwaita
  fi

  if [[ "$(id -u)" -eq 0 ]]; then
    die "No ejecutes este script como root ni con sudo. Está pensado para instalar sólo en tu usuario."
  fi

  if [[ -z ${HOME:-} || ! -d "$HOME" ]]; then
    die "HOME no está definido o no es un directorio válido."
  fi

  check_deps

  CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/tahoe-gnome/mactahoe-gtk-theme"
  prepare_source
  create_sudo_shim
  run_upstream
  verify_install

  if [[ $APPLY == true ]]; then
    apply_desktop_theme || exit 1
  fi

  log ""
  log "Instalación completada y verificada:"
  log "  $HOME/.themes/${THEME_NAME}-Light"
  log "  $HOME/.themes/${THEME_NAME}-Dark"

  if [[ $APPLY == false ]]; then
    log ""
    log "Para aplicarlo al escritorio:"
    printf '  bash %q --apply\n' "$0"
  fi

  log ""
  log "Nota: libadwaita/GTK4 no se instala. Ejecuta este script con --libadwaita"
  log "para ver el motivo y las instrucciones manuales con copia de seguridad."
}

main "$@"
