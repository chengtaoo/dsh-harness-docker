#!/usr/bin/env bash
# Regression: revoking a licence must block access immediately and reclaim the
# instance within one maintenance sweep.
export MSYS_NO_PATHCONV=1
set -u
cd "$(dirname "$0")/.." || exit 1

echo "### rebuild"
docker build -q -t dsh-harness:latest . >/dev/null || exit 1

echo "### fresh container"
docker rm -f dsh-test >/dev/null 2>&1
docker volume rm dsh-test-data >/dev/null 2>&1
docker run -d --name dsh-test \
  --add-host=host.docker.internal:host-gateway \
  -p 18080:8080 -v dsh-test-data:/data \
  -e DSH_LLM_BASE_URL=http://host.docker.internal:11434/v1 \
  -e DSH_LLM_API_KEY=sk-test -e DSH_LLM_MODEL=deepseek-chat \
  dsh-harness:latest >/dev/null || exit 1
sleep 14

echo "### create licence"
docker exec dsh-test dsh-license add --label "王五" --days 30
KEY=$(docker exec dsh-test dsh-license list | sed -n '3p' | awk '{print $1}')
echo "key=$KEY"

echo "### login"
curl -s -c /tmp/w.txt -o /dev/null -w "login=%{http_code}\n" \
  -X POST --data-urlencode "key=$KEY" http://127.0.0.1:18080/__auth/login

echo "### wait for instance to boot"
for _ in $(seq 1 40); do
  n=$(curl -s http://127.0.0.1:18080/__auth/healthz | grep -o '"ready":true' | wc -l)
  [ "$n" -ge 1 ] && break
  sleep 3
done
curl -s http://127.0.0.1:18080/__auth/healthz; echo
curl -s -b /tmp/w.txt -o /dev/null -w "access_before_revoke=%{http_code}\n" http://127.0.0.1:18080/

echo "### revoke"
docker exec dsh-test dsh-license revoke "$KEY"
sleep 2
curl -s -b /tmp/w.txt -o /dev/null -w "access_after_revoke=%{http_code}\n" \
  -H "Accept: text/html" http://127.0.0.1:18080/

echo "### wait for sweep (up to 90s)"
for _ in $(seq 1 30); do
  cur=$(curl -s http://127.0.0.1:18080/__auth/healthz)
  echo "$cur" | grep -q '"instances":\[\]' && break
  sleep 3
done
echo "final healthz: $(curl -s http://127.0.0.1:18080/__auth/healthz)"
echo "dsh processes still alive: $(docker exec dsh-test sh -c 'ps -eo args | grep -c "[d]sh/lib/bin.js"')"
echo "### audit"
docker exec dsh-test dsh-license audit --limit 10
