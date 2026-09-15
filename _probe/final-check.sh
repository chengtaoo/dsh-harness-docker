#!/usr/bin/env bash
# Final acceptance run against the shipping image, with two licences so that
# per-user isolation is exercised rather than assumed.
export MSYS_NO_PATHCONV=1
set -u
cd "$(dirname "$0")/.." || exit 1

echo "############ 构建最终镜像 ############"
docker build -q -t dsh-harness:0.1.5-rc.1 -t dsh-harness:latest . >/dev/null || exit 1
echo "built."

echo
echo "############ 全新启动 ############"
docker rm -f dsh-test >/dev/null 2>&1
docker volume rm dsh-test-data >/dev/null 2>&1
docker run -d --name dsh-test \
  --add-host=host.docker.internal:host-gateway \
  -p 18080:8080 -v dsh-test-data:/data \
  -e DSH_LLM_BASE_URL=http://host.docker.internal:11434/v1 \
  -e DSH_LLM_API_KEY=sk-test -e DSH_LLM_MODEL=deepseek-chat \
  -e DSH_LLM_THINKING_FORMAT=deepseek -e DSH_LLM_MAX_TOKENS_FIELD=max_tokens \
  -e DSH_LLM_SUPPORTS_DEVELOPER_ROLE=false \
  -e GATEWAY_MAX_INSTANCES=5 \
  dsh-harness:latest >/dev/null || exit 1
sleep 14
docker logs dsh-test 2>&1 | sed 's/^/  /'

echo
echo "############ 授权码 ############"
docker exec dsh-test dsh-license add --label "张三" --days 365 --max-devices 3
docker exec dsh-test dsh-license add --label "李四" --days 30
# The list is ordered newest-first, so select by label rather than by row.
KEY_A=$(docker exec dsh-test dsh-license list | grep '张三' | awk '{print $1}')
KEY_B=$(docker exec dsh-test dsh-license list | grep '李四' | awk '{print $1}')
echo "张三=$KEY_A  李四=$KEY_B"

echo
echo "############ 用户 A 验收 ############"
node _probe/accept.mjs 18080 "$KEY_A" "张三"
A=$?

echo
echo "############ 用户 B 验收 ############"
node _probe/accept.mjs 18080 "$KEY_B" "李四"
B=$?

echo
echo "############ 多用户隔离 ############"
curl -s http://127.0.0.1:18080/__auth/healthz; echo
echo "独立实例进程:"
docker exec dsh-test sh -c 'ps -eo pid,args | grep "[d]sh/lib/bin.js" | sed "s/.*--port /  port=/;s/ .*//"'
echo "独立工作目录:"
docker exec dsh-test sh -c 'ls /workspace/ | sed "s/^/  /"'
echo "独立 DSH_HOME:"
docker exec dsh-test sh -c 'ls /data/users/ | sed "s/^/  /"'

echo
echo "############ 模型链路（真实调用）############"
docker exec dsh-test sh -c 'D=$(ls -d /data/users/张三-*); cd /workspace/$(basename $D) && DSH_HOME=$D/dsh-home HOME=$D/home timeout 90 node /app/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless "reply with exactly MOCK_OK" 2>&1 | tail -3'

echo
echo "############ 结果 ############"
if [ "$A" -eq 0 ] && [ "$B" -eq 0 ]; then
  echo "全部验收项通过"
else
  echo "存在失败项：张三=$A 李四=$B"
fi
exit $(( A + B ))
