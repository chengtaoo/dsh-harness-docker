#!/usr/bin/env bash
# Verifies the container still boots and serves its UI with NO network at all,
# which is the deployment target: an intranet with no internet access.
#
# `--network none` also removes loopback's route to the host, so the model
# endpoint is unreachable here on purpose — the point is that dsh itself must
# not need the outside world to start.
export MSYS_NO_PATHCONV=1
set -u

docker rm -f dsh-off >/dev/null 2>&1
docker volume rm dsh-off-data >/dev/null 2>&1

docker run -d --name dsh-off --network none \
  -v dsh-off-data:/data \
  -e DSH_LLM_BASE_URL=http://10.0.0.5:8000/v1 \
  -e DSH_LLM_MODEL=deepseek-chat \
  dsh-harness:0.1.5-rc.1 >/dev/null || exit 1

sleep 14
echo "=== 启动日志（断网）==="
docker logs dsh-off 2>&1 | sed 's/^/  /'

echo
echo "=== 断网确认 ==="
docker exec dsh-off sh -c 'getent hosts registry.npmjs.org >/dev/null 2>&1 && echo "有外网" || echo "无外网（符合预期）"'

echo
echo "=== 发授权码并登录（在容器内部发起）==="
docker exec dsh-off dsh-license add --label "离线用户" --days 30
KEY=$(docker exec dsh-off dsh-license list | grep 离线 | awk '{print $1}')
docker exec dsh-off sh -c "curl -s -c /tmp/c.txt -o /dev/null -w 'login=%{http_code}\n' -X POST --data-urlencode 'key=$KEY' http://127.0.0.1:8080/__auth/login"

echo "=== 等待实例就绪（无外网环境下）==="
for i in $(seq 1 60); do
  docker exec dsh-off sh -c 'curl -s http://127.0.0.1:8080/__auth/healthz' | grep -q '"ready":true' && break
  sleep 3
done
echo "healthz: $(docker exec dsh-off sh -c 'curl -s http://127.0.0.1:8080/__auth/healthz')"

echo "=== 断网下能否加载 Web UI ==="
docker exec dsh-off sh -c "curl -s -b /tmp/c.txt -o /tmp/p.html -w 'ui=%{http_code} size=%{size_download}\n' http://127.0.0.1:8080/"

echo "=== 实例日志（应无外网相关报错阻塞启动）==="
docker exec dsh-off sh -c 'tail -5 /data/logs/dsh-*.log'

docker rm -f dsh-off >/dev/null 2>&1
docker volume rm dsh-off-data >/dev/null 2>&1
echo "清理完成"
