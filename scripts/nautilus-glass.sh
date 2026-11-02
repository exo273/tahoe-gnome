#!/usr/bin/env bash
#
# Nautilus GTK4 con cristal de tahoe-topbar (opción B).
#
# Instala un override CSS conservador para MacTahoe:
#   * la superficie GTK sigue siendo opaca (application-content-opacity = 1.0);
#   * sidebar y cabecera de Nautilus dejan alfa (~0.62) y muestran el cristal
#     que tahoe-topbar dibuja debajo de la ventana;
#   * el content-pane y las vistas de archivos se fuerzan a opacos.
#
# Uso:
#   scripts/nautilus-glass.sh install [--mode auto|dark|light] [--force]
#   scripts/nautilus-glass.sh remove
#   scripts/nautilus-glass.sh status
#
# Garantías:
#   * No usa sudo/root.
#   * No edita gtk-Dark.css ni gtk-Light.css: sólo crea wrapper y override.
#   * gtk.css y gtk-dark.css se respaldan y se restauran exactamente (tipo de
#     archivo y destino del enlace incluidos).
#   * Los backups viven fuera de ~/.config/gtk-4.0 para sobrevivir a una
#     reinstalación del tema.
#
# Si «Sincronizar tema de shell y GTK» está activo en Tahoe Top Bar,
# theme.js cambia entre los wrappers gtk-Dark-Tahoe.css y
# gtk-Light-Tahoe.css sin perder este override.
#
# Reinstalar el tema MacTahoe puede borrar gtk.css/tahoe-nautilus.css: vuelve
# a ejecutar `install`. `status` detecta ese caso.

set -Eeuo pipefail

readonly SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
readonly CSS_SOURCE="$REPO_ROOT/scripts/nautilus-tahoe.css"
readonly MARKER='GESTIONADO POR scripts/nautilus-glass.sh'
readonly WRAPPER_DARK='gtk-Dark-Tahoe.css'
readonly WRAPPER_LIGHT='gtk-Light-Tahoe.css'
readonly CSS_NAME='tahoe-nautilus.css'

GTK_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/gtk-4.0"
STATE_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/tahoe-gnome/nautilus-glass"
STATE_FILE="$STATE_ROOT/state.env"

MODE_ARG=auto
FORCE=false
ACTION=${1:-}
[[ $# -gt 0 ]] && shift

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'Aviso: %s\n' "$*" >&2
}

log() {
  printf '%s\n' "$*"
}

usage() {
  cat <<'EOF'
Uso:
  scripts/nautilus-glass.sh install [--mode auto|dark|light] [--force]
  scripts/nautilus-glass.sh remove
  scripts/nautilus-glass.sh status
  scripts/nautilus-glass.sh --help

install
  Crea ~/.config/gtk-4.0/tahoe-nautilus.css y los wrappers
  gtk-Dark-Tahoe.css / gtk-Light-Tahoe.css. Respalda gtk.css y gtk-dark.css
  y los repunta al wrapper del modo elegido. No toca gtk-Dark.css ni
  gtk-Light.css.

  --mode auto   Lee color-scheme/gtk-theme (por defecto).
  --mode dark   Usa gtk-Dark.css + override.
  --mode light  Usa gtk-Light.css + override.
  --force       Permite reemplazar un gtk.css personalizado no reconocido.

remove
  Restaura gtk.css y gtk-dark.css exactamente como estaban (enlace o archivo)
  y elimina sólo los ficheros creados por este script. No borra backups.

status
  Muestra el estado, el modo actual, posibles desajustes con theme.js y la
  ruta de los backups.

Integración con Tahoe Top Bar:
  Con «Sincronizar tema de shell y GTK» activo, theme.js cambia gtk.css
  entre gtk-Dark-Tahoe.css y gtk-Light-Tahoe.css sin perder el override.
EOF
}

require_not_root() {
  [[ ${EUID:-$(id -u)} -ne 0 ]] || die 'no se ejecuta como root/sudo'
}

require_gtk_dir() {
  [[ -d $GTK_DIR ]] || die "no existe $GTK_DIR (¿está instalado el tema MacTahoe?)"
}

file_kind() {
  local path=$1
  if [[ -L $path ]]; then
    printf 'symlink'
  elif [[ -e $path ]]; then
    printf 'regular'
  else
    printf 'absent'
  fi
}

link_target() {
  readlink -- "$1" 2>/dev/null || true
}

is_ours_link() {
  local path=$1 target
  [[ -L $path ]] || return 1
  target=$(link_target "$path")
  [[ $(basename -- "$target") == "$WRAPPER_DARK" || $(basename -- "$target") == "$WRAPPER_LIGHT" ]]
}

has_marker() {
  local path=$1
  [[ -f $path ]] && head -n 1 -- "$path" | grep -Fq -- "$MARKER"
}

is_known_original_link() {
  local path=$1 target base
  [[ -L $path ]] || return 1
  target=$(link_target "$path")
  base=$(basename -- "$target")
  [[ $base == 'gtk-Dark.css' || $base == 'gtk-Light.css' ]]
}

detect_mode() {
  local scheme theme
  case $MODE_ARG in
    dark|light)
      printf '%s\n' "$MODE_ARG"
      return
      ;;
    auto)
      ;;
    *)
      die "--mode debe ser auto, dark o light"
      ;;
  esac

  scheme=$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null || true)
  case $scheme in
    *prefer-dark*) printf 'dark\n'; return ;;
    *prefer-light*) printf 'light\n'; return ;;
  esac

  theme=$(gsettings get org.gnome.desktop.interface gtk-theme 2>/dev/null || true)
  case $theme in
    *Light*) printf 'light\n' ;;
    *) printf 'dark\n' ;;
  esac
}

wrapper_for_mode() {
  case $1 in
    dark) printf '%s\n' "$WRAPPER_DARK" ;;
    light) printf '%s\n' "$WRAPPER_LIGHT" ;;
    *) die "modo desconocido: $1" ;;
  esac
}

source_for_mode() {
  case $1 in
    dark) printf 'gtk-Dark.css\n' ;;
    light) printf 'gtk-Light.css\n' ;;
    *) die "modo desconocido: $1" ;;
  esac
}

write_atomic() {
  local path=$1 content=$2 tmp
  tmp=$(mktemp "${path}.tmp.XXXXXX")
  printf '%s\n' "$content" > "$tmp"
  chmod 0644 "$tmp"
  mv -f -- "$tmp" "$path"
}

write_wrapper() {
  local mode=$1 path source
  path="$GTK_DIR/$(wrapper_for_mode "$mode")"
  source=$(source_for_mode "$mode")
  write_atomic "$path" "/* $MARKER */
@import url(\"$source\");
@import url(\"$CSS_NAME\");"
}

write_override() {
  [[ -f $CSS_SOURCE ]] || die "falta $CSS_SOURCE"
  head -n 1 -- "$CSS_SOURCE" | grep -Fq -- "$MARKER" ||
    die "$CSS_SOURCE no lleva la marca de fichero gestionado"
  local tmp
  tmp=$(mktemp "$GTK_DIR/$CSS_NAME.tmp.XXXXXX")
  cp -- "$CSS_SOURCE" "$tmp"
  chmod 0644 "$tmp"
  mv -f -- "$tmp" "$GTK_DIR/$CSS_NAME"
}

save_state() {
  local mode=$1 backup_dir=$2
  local gtk_kind=$3 gtk_target=$4 gtk_backup=$5
  local dark_kind=$6 dark_target=$7 dark_backup=$8 dark_touched=$9
  mkdir -p -- "$STATE_ROOT"
  chmod 700 "$STATE_ROOT" 2>/dev/null || true
  local tmp
  tmp=$(mktemp "$STATE_ROOT/state.env.tmp.XXXXXX")
  {
    printf 'INSTALLED=1\n'
    printf 'VERSION=1\n'
    printf 'MODE=%q\n' "$mode"
    printf 'BACKUP_DIR=%q\n' "$backup_dir"
    printf 'GTK_CSS_KIND=%q\n' "$gtk_kind"
    printf 'GTK_CSS_TARGET=%q\n' "$gtk_target"
    printf 'GTK_CSS_BACKUP=%q\n' "$gtk_backup"
    printf 'GTK_DARK_CSS_KIND=%q\n' "$dark_kind"
    printf 'GTK_DARK_CSS_TARGET=%q\n' "$dark_target"
    printf 'GTK_DARK_CSS_BACKUP=%q\n' "$dark_backup"
    printf 'GTK_DARK_CSS_TOUCHED=%q\n' "$dark_touched"
  } > "$tmp"
  chmod 600 "$tmp"
  mv -f -- "$tmp" "$STATE_FILE"
}

load_state() {
  [[ -f $STATE_FILE ]] || return 1
  # state.env lo escribe este script con printf %q; es de confianza local.
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  [[ ${INSTALLED:-0} == 1 ]]
}

snapshot_entry() {
  local path=$1 prefix=$2 kind target backup
  kind=$(file_kind "$path")
  target=''
  backup=''
  if [[ $kind == symlink ]]; then
    target=$(link_target "$path")
  elif [[ $kind == regular ]]; then
    backup="$BACKUP_DIR/$(basename -- "$path")"
    cp -a -- "$path" "$backup"
  fi
  printf '%s_KIND=%q\n' "$prefix" "$kind"
  printf '%s_TARGET=%q\n' "$prefix" "$target"
  printf '%s_BACKUP=%q\n' "$prefix" "$backup"
}

backup_theme_sources() {
  local file
  for file in gtk-Dark.css gtk-Light.css; do
    if [[ -e $GTK_DIR/$file ]]; then
      # Se copia el contenido (no el enlace) para que el backup sea legible
      # aunque el tema use enlaces relativos. Nunca se escribe en el origen.
      cp -L --preserve=mode,timestamps -- "$GTK_DIR/$file" "$BACKUP_DIR/$file"
    fi
  done
}

restore_entry() {
  local path=$1 kind=$2 target=$3 backup=$4
  case $kind in
    symlink)
      rm -f -- "$path"
      ln -s -- "$target" "$path"
      ;;
    regular)
      [[ -f $backup ]] || die "falta el backup $backup"
      rm -f -- "$path"
      cp -a -- "$backup" "$path"
      ;;
    absent)
      rm -f -- "$path"
      ;;
    *)
      die "tipo de backup desconocido para $path: $kind"
      ;;
  esac
}

current_mode_hint() {
  local scheme
  scheme=$(gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null || true)
  case $scheme in
    *prefer-dark*) printf 'dark' ;;
    *prefer-light*) printf 'light' ;;
    *) printf 'desconocido (color-scheme=%s)' "$scheme" ;;
  esac
}

action_install() {
  require_not_root
  require_gtk_dir
  [[ -f $CSS_SOURCE ]] || die "falta $CSS_SOURCE"
  [[ -f $GTK_DIR/gtk-Dark.css || -f $GTK_DIR/gtk-Light.css ]] ||
    die "no encuentro gtk-Dark.css ni gtk-Light.css en $GTK_DIR"

  local mode wrapper source
  mode=$(detect_mode)
  wrapper=$(wrapper_for_mode "$mode")
  source=$(source_for_mode "$mode")
  [[ -f $GTK_DIR/$source ]] || die "el tema no tiene $source en $GTK_DIR"

  local already=false
  if load_state; then
    already=true
    [[ -d ${BACKUP_DIR:-} ]] || die "el estado apunta a un backup inexistente: ${BACKUP_DIR:-}"
  fi

  # Validar gtk.css antes de tocar nada.
  if [[ -e $GTK_DIR/gtk.css || -L $GTK_DIR/gtk.css ]]; then
    if is_ours_link "$GTK_DIR/gtk.css" || has_marker "$GTK_DIR/gtk.css"; then
      :
    elif is_known_original_link "$GTK_DIR/gtk.css"; then
      :
    elif [[ $FORCE == true ]]; then
      warn "se reemplaza gtk.css no reconocido por --force"
    else
      die "gtk.css no es el enlace MacTahoe esperado; usa --force si quieres reemplazarlo"
    fi
  fi

  local gtk_kind gtk_target gtk_backup
  local dark_kind dark_target dark_backup dark_touched=false

  if [[ $already == true ]]; then
    # Reutiliza el snapshot original: nunca respalda un wrapper como si fuera
    # el estado original del usuario.
    gtk_kind=$GTK_CSS_KIND
    gtk_target=$GTK_CSS_TARGET
    gtk_backup=$GTK_CSS_BACKUP
    dark_kind=$GTK_DARK_CSS_KIND
    dark_target=$GTK_DARK_CSS_TARGET
    dark_backup=$GTK_DARK_CSS_BACKUP
    dark_touched=$GTK_DARK_CSS_TOUCHED
  else
    BACKUP_DIR="$STATE_ROOT/backups/$(date +%Y%m%d-%H%M%S)-$$"
    mkdir -p -- "$BACKUP_DIR"
    chmod 700 "$STATE_ROOT" "$STATE_ROOT/backups" "$BACKUP_DIR" 2>/dev/null || true

    # Snapshot de gtk.css
    gtk_kind=$(file_kind "$GTK_DIR/gtk.css")
    gtk_target=''
    gtk_backup=''
    if [[ $gtk_kind == symlink ]]; then
      gtk_target=$(link_target "$GTK_DIR/gtk.css")
    elif [[ $gtk_kind == regular ]]; then
      gtk_backup="$BACKUP_DIR/gtk.css"
      cp -a -- "$GTK_DIR/gtk.css" "$gtk_backup"
    fi

    # gtk-dark.css: sólo se gestiona si ya es el enlace estándar a gtk-Dark.css.
    dark_kind=$(file_kind "$GTK_DIR/gtk-dark.css")
    dark_target=''
    dark_backup=''
    if [[ $dark_kind == symlink ]] && is_known_original_link "$GTK_DIR/gtk-dark.css"; then
      dark_target=$(link_target "$GTK_DIR/gtk-dark.css")
      dark_touched=true
    elif [[ $dark_kind == regular ]]; then
      dark_backup="$BACKUP_DIR/gtk-dark.css"
      cp -a -- "$GTK_DIR/gtk-dark.css" "$dark_backup"
      warn "gtk-dark.css es un archivo regular; se deja intacto"
      dark_kind=regular
      dark_touched=false
    else
      dark_touched=false
    fi

    backup_theme_sources
  fi

  # Guardar el estado antes de modificar, para que remove pueda recuperarse
  # incluso si el proceso se interrumpe a mitad.
  save_state "$mode" "$BACKUP_DIR" \
    "$gtk_kind" "$gtk_target" "$gtk_backup" \
    "$dark_kind" "$dark_target" "$dark_backup" "$dark_touched"

  write_override
  write_wrapper dark
  write_wrapper light

  # Repuntar gtk.css al wrapper del modo elegido.
  rm -f -- "$GTK_DIR/gtk.css"
  ln -s -- "$wrapper" "$GTK_DIR/gtk.css"

  # gtk-dark.css no lo usa GTK4 en todas las versiones, pero si el tema lo
  # dejó como enlace, se mantiene coherente con el modo oscuro.
  if [[ ${dark_touched:-false} == true ]]; then
    rm -f -- "$GTK_DIR/gtk-dark.css"
    ln -s -- "$WRAPPER_DARK" "$GTK_DIR/gtk-dark.css"
  fi

  log "Instalado Nautilus glass (modo $mode)."
  log "  gtk.css -> $(link_target "$GTK_DIR/gtk.css")"
  log "  override: $GTK_DIR/$CSS_NAME"
  log "  wrappers: $GTK_DIR/$WRAPPER_DARK, $GTK_DIR/$WRAPPER_LIGHT"
  log "  backups:  $BACKUP_DIR"
  log ''
  log 'Recuerda: en tahoe-topbar usa application-content-opacity = 1.0,'
  log 'application-blur-radius ≈ 8-12 y Nautilus en application-window-whitelist.'
  log 'Si reinstalas el tema MacTahoe, vuelve a ejecutar install.'
}

action_remove() {
  require_not_root
  load_state || die "no hay instalación gestionada en $STATE_FILE"
  require_gtk_dir
  [[ -d ${BACKUP_DIR:-} ]] || die "falta el backup ${BACKUP_DIR:-}"

  local restored=0

  if is_ours_link "$GTK_DIR/gtk.css" || has_marker "$GTK_DIR/gtk.css"; then
    restore_entry "$GTK_DIR/gtk.css" "$GTK_CSS_KIND" "$GTK_CSS_TARGET" "$GTK_CSS_BACKUP"
    restored=1
  elif [[ -e $GTK_DIR/gtk.css || -L $GTK_DIR/gtk.css ]]; then
    warn "gtk.css ya no es el wrapper; no se sobrescribe. Revisa $GTK_DIR/gtk.css"
  else
    restore_entry "$GTK_DIR/gtk.css" "$GTK_CSS_KIND" "$GTK_CSS_TARGET" "$GTK_CSS_BACKUP"
    restored=1
  fi

  if [[ ${GTK_DARK_CSS_TOUCHED:-false} == true ]]; then
    if is_ours_link "$GTK_DIR/gtk-dark.css"; then
      restore_entry "$GTK_DIR/gtk-dark.css" "$GTK_DARK_CSS_KIND" "$GTK_DARK_CSS_TARGET" "$GTK_DARK_CSS_BACKUP"
      restored=1
    elif [[ -e $GTK_DIR/gtk-dark.css || -L $GTK_DIR/gtk-dark.css ]]; then
      warn "gtk-dark.css ya no es el wrapper; no se sobrescribe"
    fi
  fi

  local file
  for file in "$CSS_NAME" "$WRAPPER_DARK" "$WRAPPER_LIGHT"; do
    if has_marker "$GTK_DIR/$file"; then
      rm -f -- "$GTK_DIR/$file"
    elif [[ -e $GTK_DIR/$file ]]; then
      warn "se deja $file porque no lleva la marca de fichero gestionado"
    fi
  done

  rm -f -- "$STATE_FILE"
  log "Eliminado el override de Nautilus glass."
  log "  backups conservados en: $BACKUP_DIR"
  [[ $restored -eq 1 ]] || warn 'no se restauró gtk.css porque había sido modificado por otro proceso'
}

action_status() {
  require_not_root
  if ! load_state; then
    log "Nautilus glass: NO instalado (estado: $STATE_FILE)"
    log "gtk.css actual: $(file_kind "$GTK_DIR/gtk.css") $(link_target "$GTK_DIR/gtk.css")"
    return 1
  fi

  local current wrapper expected
  current=$(file_kind "$GTK_DIR/gtk.css")
  wrapper=$(wrapper_for_mode "${MODE:-dark}")
  expected="$wrapper"

  log "Nautilus glass: instalado"
  log "  modo guardado: ${MODE:-?} (color-scheme actual: $(current_mode_hint))"
  log "  gtk.css: $current -> $(link_target "$GTK_DIR/gtk.css")"
  log "  esperado: $expected"
  if [[ $current == symlink && $(basename -- "$(link_target "$GTK_DIR/gtk.css")") == "$expected" ]]; then
    log '  enlace: OK'
  else
    warn 'el enlace gtk.css no apunta al wrapper esperado; reinstala o revisa el tema'
  fi

  local file
  for file in "$CSS_NAME" "$WRAPPER_DARK" "$WRAPPER_LIGHT"; do
    if [[ -f $GTK_DIR/$file ]]; then
      log "  $file: presente"
    else
      warn "$file no existe (¿reinstalaste el tema? vuelve a ejecutar install)"
    fi
  done

  if is_known_original_link "$GTK_DIR/gtk.css"; then
    warn 'gtk.css apunta al tema original: theme.js puede volver a cambiarlo'
  elif is_ours_link "$GTK_DIR/gtk.css"; then
    log '  theme.js: conserva el wrapper al cambiar entre claro y oscuro'
  fi

  log "  backups: ${BACKUP_DIR:-?}"
  if [[ -d ${BACKUP_DIR:-} ]]; then
    log "  contenido: $(find "$BACKUP_DIR" -maxdepth 1 -type f -printf '%f ' 2>/dev/null)"
  fi
  log ''
  log 'theme.js conserva el wrapper al cambiar entre claro y oscuro.'
}

case $ACTION in
  install)
    while [[ $# -gt 0 ]]; do
      case $1 in
        --mode)
          [[ $# -ge 2 ]] || die '--mode necesita un valor'
          MODE_ARG=$2
          shift 2
          ;;
        --mode=*)
          MODE_ARG=${1#--mode=}
          shift
          ;;
        --force)
          FORCE=true
          shift
          ;;
        -h|--help)
          usage
          exit 0
          ;;
        *)
          die "opción desconocida: $1"
          ;;
      esac
    done
    action_install
    ;;
  remove)
    [[ $# -eq 0 ]] || die 'remove no acepta opciones'
    action_remove
    ;;
  status)
    [[ $# -eq 0 ]] || die 'status no acepta opciones'
    action_status
    ;;
  ''|-h|--help|help)
    usage
    ;;
  *)
    usage >&2
    die "acción desconocida: $ACTION"
    ;;
esac
