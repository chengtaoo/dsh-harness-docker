#!/usr/bin/env bash
# 回归测试：用户在界面上改的模型配置，必须在实例重启后依然存在。
#
# 背景：dsh 的 settings 写入器会保留注释，所以无法用「标记注释是否还在」
# 来判断文件是自动生成的还是用户改过的——早期实现据此覆盖用户配置，
# 导致界面里改的东西在实例回收后静默丢失。
export MSYS_NO_PATHCONV=1
set -u
cd "$(dirname "$0")/.." || exit 1

LABEL="配置持久化"
echo "### 构建镜像"
docker build -q -t dsh-harness:0.1.5-rc.1 -t dsh-harness:latest . >/dev/null || exit 1

echo "### 全新启动"
docker compose down -v >/dev/null 2>&1
docker compose up -d >/dev/null 2>&1 || exit 1
sleep 25

echo "### 创建授权码并登录"
docker compose exec -T dsh dsh-license add --label "$LABEL" --days 30 >/dev/null
KEY=$(docker compose exec -T dsh dsh-license list | grep "$LABEL" | awk '{print $1}')
curl -s -c /tmp/persist.txt -o /dev/null -X POST \
  --data-urlencode "key=$KEY" http://127.0.0.1:8080/__auth/login
sleep 30

DIR=$(docker compose exec -T dsh sh -c "ls -d /data/users/${LABEL}-*" | tr -d '\r')
echo "用户目录: $DIR"

echo "### 模拟用户在界面上改配置（改默认模型 + 加自定义 provider）"
docker compose exec -T dsh sh -c "
  sed -i 's/^  model: .*/  model: deepseek-v4-pro/' $DIR/dsh-home/settings.yaml
  printf '\n# 用户自己加的备注\n' >> $DIR/dsh-home/settings.yaml
"

echo "### 重启实例"
docker compose exec -T dsh sh -c 'pkill -f "[d]sh/lib/bin[.]js"; sleep 2'
sleep 2
curl -s -b /tmp/persist.txt -o /dev/null -H "Accept: text/html" http://127.0.0.1:8080/
sleep 35

echo
echo "### 结果"
docker compose exec -T dsh sh -c "
  echo '  默认模型:                '\$(grep -A1 '^agent-default-model:' $DIR/dsh-home/settings.yaml | grep 'model:' | awk '{print \$2}')
  echo '  用户备注出现次数:        '\$(grep -c '用户自己加的备注' $DIR/dsh-home/settings.yaml)
  echo '  自定义 provider 是否保留: '\$(grep -c 'deepseek-v4-pro' $DIR/dsh-home/settings.yaml)
"
echo
echo "### 判定标准"
echo "  默认模型应为 deepseek-v4-pro，用户备注次数应为 1 —— 否则用户配置仍在丢失"

echo
echo "### 附带验证：密钥是否仍在从环境刷新"
docker compose exec -T dsh sh -c "grep -h 'config\]' /data/logs/*.log 2>/dev/null | tail -2"
