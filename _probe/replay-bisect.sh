#!/usr/bin/env bash
# 用 dsh 真实发出的请求体逐个变体重放，定位内网模型服务拒绝它的原因。
#
# 把 _probe/ 整个目录（含 replay/ 子目录）拷到能访问模型服务的机器上，然后：
#
#   bash replay-bisect.sh http://15.124.235.210:1025/v1 123456
#
# 01 是 dsh 原样请求。02 起逐项剥离。哪一项从「失败」变成「通过」，
# 被剥掉的那个东西就是原因。
#
# 服务器上不需要 node、jq 或任何 JSON 工具——所有变体都已预先算好。

BASE="${1:?用法: replay-bisect.sh <base_url> <api_key>}"
KEY="${2:?缺少 api_key}"

HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$HERE/replay"
URL="${BASE%/}/chat/completions"

if [ ! -d "$DIR" ]; then
  echo "找不到 $DIR —— 请把 _probe 整个目录一起拷贝过来" >&2
  exit 1
fi

echo "目标: $URL"
echo
echo "变体说明："
echo "  01-full             dsh 原样请求（25 个工具 + 3 条消息，31KB）"
echo "  02-no-tools         去掉 tools"
echo "  03-messages-only    只留 model + messages + max_tokens"
echo "  04-short-system     system 缩短为一句"
echo "  05-system-only      只有那条 4492 字符的 system"
echo "  06-tools-only-shape 短消息 + 全部 25 个工具"
echo
echo "──────────────────────────────────────────────────────────"

for f in "$DIR"/*.json; do
  [ -e "$f" ] || continue
  name=$(basename "$f" .json)
  size=$(wc -c < "$f" | tr -d ' ')
  code=$(curl -s -m 180 -o /tmp/replay-out.txt -w '%{http_code}' "$URL" \
    -H "Authorization: Bearer $KEY" \
    -H 'Content-Type: application/json' \
    --data-binary "@$f" 2>/dev/null)

  if [ "$code" = "200" ]; then
    printf '  \033[32m通过\033[0m  %-20s %8s 字节\n' "$name" "$size"
  else
    printf '  \033[31m失败\033[0m  %-20s %8s 字节  HTTP %s\n' "$name" "$size" "$code"
    printf '        %s\n' "$(head -c 220 /tmp/replay-out.txt 2>/dev/null | tr -d '\n')"
  fi
done

echo "──────────────────────────────────────────────────────────"
echo
echo "怎么读结果："
echo "  · 若 01 失败而 02 通过  → 问题出在 tools（25 个工具定义）"
echo "  · 若 02 失败而 03 通过  → 问题出在 store / stream_options / stream"
echo "  · 若 03 失败而 04 通过  → 问题出在那条 4492 字符的长 system"
echo "  · 若 06 失败而 02 通过  → 同样是 tools，且与消息长度无关"
echo "  · 若全部失败           → 请求体本身没问题，需查 MindIE 侧配置"
echo
echo "把这段输出整段发回即可。"
