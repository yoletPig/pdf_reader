#!/usr/bin/env bash
# ============================================================
# PDF Reader 一键启动脚本
# 启动顺序: backend(8000) → agent-gateway(8002) → frontend(5173)
# 用法:
#   ./start.sh              # 启动全部（已运行的服务自动跳过）
#   ./start.sh --no-frontend  # 只启动后端与 agent 服务
#   ./start.sh backend      # 只启动单个服务 (backend|gateway|frontend)
#
# 端口配置（两种方式，环境变量优先）:
#   1) 临时指定: PDF_READER_BACKEND_PORT=8100 ./start.sh
#   2) 永久修改: 改下方 BACKEND_PORT/GATEWAY_PORT/FRONTEND_PORT 默认值
# ============================================================
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/logs"
PID_DIR="$LOG_DIR/pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

BACKEND_DIR="$ROOT/backend"
GATEWAY_DIR="$ROOT/agent-gateway"
FRONTEND_DIR="$ROOT/frontend"

# 端口配置：环境变量优先（PDF_READER_*_PORT），否则使用默认值
BACKEND_PORT="${PDF_READER_BACKEND_PORT:-8000}"
GATEWAY_PORT="${PDF_READER_GATEWAY_PORT:-8002}"
FRONTEND_PORT="${PDF_READER_FRONTEND_PORT:-5173}"

BACKEND_LOG="$LOG_DIR/backend.log"
GATEWAY_LOG="$LOG_DIR/gateway.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"

# 服务间互连地址（跟随端口联动，保证代理/工具指向正确）
BACKEND_URL="http://127.0.0.1:$BACKEND_PORT"
GATEWAY_URL="http://127.0.0.1:$GATEWAY_PORT"

# uvicorn 可能是用户级安装（~/.local/bin），不在 PATH 时手动补
UVICORN="$(command -v uvicorn || echo "$HOME/.local/bin/uvicorn")"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

log_ok()   { echo -e "${GREEN}✅ $*${NC}"; }
log_warn() { echo -e "${YELLOW}⚠️  $*${NC}"; }
log_err()  { echo -e "${RED}❌ $*${NC}"; }
log_info() { echo -e "${CYAN}ℹ️  $*${NC}"; }

# ---------- 通用工具 ----------

# 按 PID 文件判断服务是否存活
is_pid_alive() {
  local pidfile="$1"
  [ -f "$pidfile" ] || return 1
  local pid
  pid="$(cat "$pidfile" 2>/dev/null)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# HTTP 健康检查
http_ok() {
  curl -sf -o /dev/null --max-time 2 "$1"
}

# 等待 URL 就绪（默认 30s）
wait_for() {
  local url="$1" name="$2" tries="${3:-30}"
  for _ in $(seq 1 "$tries"); do
    if http_ok "$url"; then return 0; fi
    sleep 1
  done
  log_err "$name 启动超时（${tries}s），请查看日志"
  return 1
}

# ---------- 服务启动 ----------

start_backend() {
  echo ""
  echo "━━━ Backend (FastAPI :$BACKEND_PORT) ━━━"
  if http_ok "http://127.0.0.1:$BACKEND_PORT/api/health"; then
    log_ok "backend 已在运行，跳过"
    return 0
  fi
  if [ ! -x "$UVICORN" ]; then
    log_err "找不到 uvicorn，请先: pip install -r backend/requirements.txt"
    return 1
  fi
  log_info "启动 backend ..."
  (cd "$BACKEND_DIR" && PDF_READER_AGENT_GATEWAY_URL="$GATEWAY_URL" \
   nohup "$UVICORN" app.main:app --host 127.0.0.1 --port "$BACKEND_PORT" > "$BACKEND_LOG" 2>&1 &
   echo $! > "$PID_DIR/backend.pid")
  if wait_for "http://127.0.0.1:$BACKEND_PORT/api/health" "backend"; then
    log_ok "backend 就绪 (pid $(cat "$PID_DIR/backend.pid"))  日志: $BACKEND_LOG"
  else
    tail -20 "$BACKEND_LOG"
    return 1
  fi
}

start_gateway() {
  echo ""
  echo "━━━ Agent Gateway (pi agent :$GATEWAY_PORT) ━━━"
  if http_ok "http://127.0.0.1:$GATEWAY_PORT/health"; then
    log_ok "agent-gateway 已在运行，跳过"
    return 0
  fi
  if [ ! -d "$GATEWAY_DIR/node_modules" ]; then
    log_info "安装 agent-gateway 依赖 ..."
    (cd "$GATEWAY_DIR" && npm install) || { log_err "npm install 失败"; return 1; }
  fi
  if [ ! -f "$GATEWAY_DIR/dist/server.js" ]; then
    log_info "构建 agent-gateway ..."
    (cd "$GATEWAY_DIR" && npm run build) || { log_err "构建失败"; return 1; }
  fi
  log_info "启动 agent-gateway ..."
  (cd "$GATEWAY_DIR" && AGENT_GATEWAY_PORT="$GATEWAY_PORT" PDF_READER_BACKEND_URL="$BACKEND_URL" \
   nohup node dist/server.js > "$GATEWAY_LOG" 2>&1 &
   echo $! > "$PID_DIR/gateway.pid")
  if wait_for "http://127.0.0.1:$GATEWAY_PORT/health" "agent-gateway"; then
    log_ok "agent-gateway 就绪 (pid $(cat "$PID_DIR/gateway.pid"))  日志: $GATEWAY_LOG"
  else
    tail -20 "$GATEWAY_LOG"
    return 1
  fi
}

start_frontend() {
  echo ""
  echo "━━━ Frontend (Vite :$FRONTEND_PORT) ━━━"
  if http_ok "http://127.0.0.1:$FRONTEND_PORT"; then
    log_ok "frontend 已在运行，跳过"
    return 0
  fi
  if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    log_info "安装 frontend 依赖 ..."
    (cd "$FRONTEND_DIR" && npm install) || { log_err "npm install 失败"; return 1; }
  fi
  log_info "启动 frontend ..."
  (cd "$FRONTEND_DIR" && PDF_READER_BACKEND_URL="$BACKEND_URL" \
   nohup npm run dev -- --port "$FRONTEND_PORT" --strictPort > "$FRONTEND_LOG" 2>&1 &
   echo $! > "$PID_DIR/frontend.pid")
  if wait_for "http://127.0.0.1:$FRONTEND_PORT" "frontend" 45; then
    log_ok "frontend 就绪  日志: $FRONTEND_LOG"
    echo -e "   ${CYAN}→ 访问 http://localhost:$FRONTEND_PORT${NC}"
  else
    tail -20 "$FRONTEND_LOG"
    return 1
  fi
}

# ---------- 主流程 ----------

ONLY="${1:-all}"
FAIL=0

case "$ONLY" in
  --no-frontend)
    start_backend || FAIL=1
    start_gateway || FAIL=1
    ;;
  backend|gateway|frontend)
    "start_$ONLY" || FAIL=1
    ;;
  all)
    start_backend || FAIL=1
    start_gateway || FAIL=1
    start_frontend || FAIL=1
    ;;
  *)
    log_err "未知参数: $ONLY（支持 all / backend / gateway / frontend / --no-frontend）"
    exit 1
    ;;
esac

echo ""
if [ "$FAIL" -eq 0 ]; then
  log_ok "全部服务启动完成"
else
  log_warn "部分服务启动失败，请查看上方日志输出"
  exit 1
fi
