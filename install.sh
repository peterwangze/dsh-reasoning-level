#!/bin/sh
# dsh-reasoning-level 安装脚本 v2 (macOS / Linux / Git Bash)
#
# v0.6.0 起安装走 DSH 官方插件通道（`dsh plugin --profile <P> add <spec>`，
# 一个 pnpm 转发器）：插件装进 profile 自己的 workspace，由 pnpm 管理，
# dsh.profile.bundles 层列表按安装状态自动维护。
#
# 本脚本不再做任何 node_modules 软链 / cordis.patch.yml 手改 /
# settings.yaml 写入——旧脚本的符号链接方案曾把 profiles/node_modules
# 共享树链成反射环，造成 DSH 无法启动与消息 fetch 失败级故障
# （详见 VERIFICATION.md「事故复盘」）。若检测到旧安装残留，先安全清除
# （只删链接本体，绝不递归删除真实目录）。
#
# 用法：
#   ./install.sh                  # 安装本目录的插件到 profile web（file: 快照）
#   ./install.sh --link           # 开发模式（link: 直连源码，改代码重启即生效）
#   ./install.sh --profile tui    # 指定 profile
#   ./install.sh --uninstall      # 卸载（官方通道 remove + 残留清理）
#
# 环境要求：dsh 与 pnpm 在 PATH；DSH_HOME 环境变量可覆盖配置目录（默认 ~/.dsh）。

set -eu

PROFILE="web"
MODE="install"
SRC="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_NAME="dsh-reasoning-level"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --link) MODE="link"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

step() { echo "==> $1"; }
fail() { echo "[X] $1" >&2; exit 1; }

command -v dsh >/dev/null 2>&1 || fail "PATH 上找不到 dsh。请先安装/启动 DSH。"
command -v pnpm >/dev/null 2>&1 || fail "PATH 上找不到 pnpm（dsh plugin 依赖它管理 profile workspace）。"
[ -f "$SRC/package.json" ] || fail "脚本目录缺 package.json：$SRC（应从插件包根目录运行）"

# ── 1. 旧版残留清理（只删链接本体，安全幂等）─────────────────────────
remove_link_only() {
  path="$1"; what="$2"
  [ -e "$path" ] || [ -L "$path" ] || return 0
  if [ -L "$path" ]; then
    rm "$path"
    step "已清除旧 $what 链接：$path"
  else
    echo "[!] $path 不是链接而是真实目录，请人工确认后删除（脚本拒绝递归删除真实目录）。" >&2
  fi
}

remove_link_only "$DSH_HOME/profiles/node_modules/$PLUGIN_NAME" 'profiles node_modules 接入'
LEGACY_CLONE="$DSH_HOME/plugins-src/$PLUGIN_NAME"
if [ -d "$LEGACY_CLONE" ]; then
  remove_link_only "$LEGACY_CLONE/node_modules" '旧源码依赖'
  rm -rf "$LEGACY_CLONE"
  step "已删除旧源码克隆：$LEGACY_CLONE"
  rmdir "$DSH_HOME/plugins-src" 2>/dev/null || true
fi

# 旧补丁行清理：bundle 层已接管该行；残留会造成双重挂载（重复路由 → 注册抛错）
PATCH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"
if [ -f "$PATCH" ] && grep -q "name: $PLUGIN_NAME" "$PATCH"; then
  grep -v -E "^[[:space:]]*- id: reasoning-level[[:space:]]*$|^[[:space:]]*name: $PLUGIN_NAME[[:space:]]*$" "$PATCH" > "$PATCH.tmp" || true
  mv "$PATCH.tmp" "$PATCH"
  step "已从 $PATCH 移除旧版手工行（现由 bundle 层自动挂载）"
fi

# ── 2. 走官方通道 ─────────────────────────────────────────────────────
if [ "$MODE" = "uninstall" ]; then
  step "卸载：dsh plugin --profile $PROFILE remove $PLUGIN_NAME"
  dsh plugin --profile "$PROFILE" remove "$PLUGIN_NAME"
  echo ""
  echo "[OK] $PLUGIN_NAME 已从 profile $PROFILE 卸载；重启 DSH 生效。"
  echo "     可选清理：先设 llm-reasoning.enabled: false 重启一次还原其写入，再删除 settings.yaml 的 llm-reasoning 节。"
  exit 0
fi

# 安装前自检：本包必须是「零 dependencies + 全 peer」形态（v0.6.0 契约）
DEP_COUNT=$(node -e "const p=require('$SRC/package.json'); console.log(Object.keys(p.dependencies||{}).length)")
[ "$DEP_COUNT" = "0" ] || fail "package.json 声明了 $DEP_COUNT 个 dependencies——v0.6.0 契约要求为空（宿主包一律 peer）。拒绝安装以防共享依赖树被污染。"
node -e "const p=require('$SRC/package.json'); if(!p.dsh?.bundle?.patch) process.exit(1)" \
  || fail "package.json 缺 dsh.bundle.patch 声明——dsh 无法把它识别为 profile 层。"

# 规格说明（金丝雀实测，2026-08）：pnpm 会把裸目录规格归一化为 link:，
# 而 link: 安装下 Node 从源码真实路径向上解析依赖，永远够不到
# $DSH_HOME/profiles/node_modules 平坦回退树 → 宿主包 peers 全部
# ERR_MODULE_NOT_FOUND。必须显式 file:（内容寻址快照）。link: 仅当
# 源码目录自带完整 node_modules 时可用。
SPEC="file:$SRC"
[ "$MODE" = "link" ] && SPEC="link:$SRC"
step "安装：dsh plugin --profile $PROFILE add $SPEC"
dsh plugin --profile "$PROFILE" add "$SPEC"

echo ""
echo "[OK] $PLUGIN_NAME 已安装到 profile $PROFILE（$([ "$MODE" = "link" ] && echo 'link 开发模式' || echo 'file 快照')）。"
echo "     重启 DSH 后在「设置 → 统一推理等级」查看。"
echo "     强烈建议先按 VERIFICATION.md 的金丝雀流程验证再上工作 profile。"
