#!/usr/bin/env bash
# ============================================================
# PDF Reader 一键停止脚本
# 优雅终止: backend / agent-gateway / frontend（含其子进程）
# 用法:
#   ./stop.sh              # 停止全部
#   ./stop.sh backend      # 只停单个服务 (backend|gateway|frontend)
#   ./stop.sh --all-ports  # 额外清理占用端口的残留进程（不依赖 PID 文件）
# ============================================================
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/logs"
PID_DIR="$LOG_DIR/pids"

# 端口配置：与 start.sh 保持一致（环境变量优先）
BACKEND_PORT="${PDF_READER_BACKEND_PORT:-8000}"
GATEWAY_PORT="${PDF_READER_GATEWAY_PORT:-8002}"
FRONTEND_PORT="${PDF_READER_FRONTEND_PORT:-5173}"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

log_ok()   { echo -e "${GREEN}✅ $*${NC}"; }
log_warn() { echo -e "${YELLOW}⚠️  $*${NC}"; }
log_err()  { echo -e "${RED}❌ $*${NC}"; }
log_info() { echo -e "${CYAN}ℹ️  $*${NC}"; }

# ---------- 通用工具 ----------

# 递归收集子孙进程 PID（npm→node 等父子链）
descendants_of() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    echo "$child"
    descendants_of "$child"
  done
}

kill_tree() {
  # 优雅终止进程树: 先 TERM 整棵树，2s 后仍存活则 KILL
  # 注意：不能按进程组(-pgid)杀——后台服务共享 shell 进程组，会误杀其他服务
  local pid="$1" name="$2"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 0

  local family
  family="$(descendants_of "$pid"; echo "$pid")"

  for p in $family; do kill -TERM "$p" 2>/dev/null; done

  for _ in 1 2 3 4; do
    kill -0 "$pid" 2>/dev/null || { log_ok "$name 已停止 (pid $pid)"; return 0; }
    sleep 0.5
  done

  for p in $family; do kill -KILL "$p" 2>/dev/null; done
  log_warn "$name 已强制终止 (pid $pid)"
}

# 通过 PID 文件停止
stop_by_pidfile() {
  local name="$1" pidfile="$2"
  if [ -f "$pidfile" ]; then
    local pid
    pid="$(cat "$pidfile" 2>/dev/null)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill_tree "$pid" "$name"
    else
      log_info "$name 未在运行（清理过期 PID 文件）"
    fi
    rm -f "$pidfile"
  else
    log_info "$name 无 PID 记录"
  fi
}

# 兜底：按端口/命令行清理残留进程
kill_port() {
  local port="$1" name="$2"
  local pids
  pids="$(lsof -t -i TCP:"$port" -s TCP:LISTEN 2>/dev/null)"
  if [ -n "$pids" ]; then
    log_warn "发现端口 $port 仍被占用（$name 残留进程: $pids），清理中 ..."
    for pid in $pids; do
      kill_tree "$pid" "$name($pid)"
    done
  fi
}

# uvicorn/node 兜底匹配（覆盖无 lsof 场景）
kill_pattern() {
  local pattern="$1" name="$2"
  local pids
  pids="$(pgrep -f "$pattern" 2>/dev/null)"
  [ -n "$pids" ] || return 0
  # 排除自身
  local self=$$
  for pid in $pids; do
    [ "$pid" = "$self" ] && continue
    kill_tree "$pid" "$name($pid)"
  done
}

stop_backend() {
  echo ""
  echo "━━━ Backend (FastAPI :$BACKEND_PORT) ━━━"
  stop_by_pidfile "backend" "$PID_DIR/backend.pid"
  kill_port "$BACKEND_PORT" "backend"
}

stop_gateway() {
  echo ""
  echo "━━━ Agent Gateway (pi agent :$GATEWAY_PORT) ━━━"
  stop_by_pidfile "agent-gateway" "$PID_DIR/gateway.pid"
  kill_port "$GATEWAY_PORT" "agent-gateway"
}

stop_frontend() {
  echo ""
  echo "━━━ Frontend (Vite :$FRONTEND_PORT) ━━━"
  stop_by_pidfile "frontend" "$PID_DIR/frontend.pid"
  kill_port "$FRONTEND_PORT" "frontend"
}

# ---------- 主流程 ----------

TARGET="${1:-all}"

case "$TARGET" in
  --all-ports)
    stop_backend; stop_gateway; stop_frontend
    echo ""
    log_info "兜底清理端口残留 ..."
    kill_port "$BACKEND_PORT" "backend"
    kill_port "$GATEWAY_PORT" "agent-gateway"
    kill_port "$FRONTEND_PORT" "frontend"
    ;;
  backend|gateway|frontend)
    "stop_$TARGET"
    ;;
  all)
    stop_backend; stop_gateway; stop_frontend
    echo ""
    log_info "兜底清理端口残留 ..."
    kill_port "$BACKEND_PORT" "backend"
    kill_port "$GATEWAY_PORT" "agent-gateway"
    kill_port "$FRONTEND_PORT" "frontend"
    ;;
  *)
    log_err "未知参数: $TARGET（支持 all / backend / gateway / frontend / --all-ports）"
    exit 1
    ;;
esac

echo ""
log_ok "停止操作完成"
