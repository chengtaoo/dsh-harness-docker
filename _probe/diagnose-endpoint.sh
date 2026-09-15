#!/usr/bin/env bash
# 逐项二分：找出内网模型服务拒绝 dsh 请求的真正原因。
#
# 用法（在能访问模型服务的机器上执行）：
#   bash diagnose-endpoint.sh http://15.124.235.210:1025/v1 123456 Qwen3-235B-W8A8
#
# 原理：从最小请求开始，逐项加上 dsh 实际会发的字段，看哪一步开始报 422。

BASE="${1:?用法: diagnose-endpoint.sh <base_url> <api_key> <model>}"
KEY="${2:?缺少 api_key}"
MODEL="${3:?缺少 model}"

URL="${BASE%/}/chat/completions"
PASS=0; FAIL=0

try() {
  local name="$1"; local payload="$2"
  local code body

  # A payload that failed to build would be sent as an empty body and read as a
  # server rejection, which is a false positive. Refuse to run it instead.
  if [ -z "$payload" ]; then
    printf '  \033[33m跳过\033[0m  %-42s (载荷为空，未发送)\n' "$name"; return
  fi

  body=$(curl -s -m 60 -w '\n__CODE__%{http_code}' "$URL" \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d "$payload" 2>&1)
  code=$(printf '%s' "$body" | sed -n 's/.*__CODE__//p')
  body=$(printf '%s' "$body" | sed 's/__CODE__[0-9]*$//')

  if [ "$code" = "200" ]; then
    printf '  \033[32m通过\033[0m  %-42s (HTTP %s)\n' "$name" "$code"; PASS=$((PASS+1))
  else
    printf '  \033[31m失败\033[0m  %-42s (HTTP %s)\n' "$name" "$code"; FAIL=$((FAIL+1))
    printf '        %s\n' "$(printf '%s' "$body" | head -c 300 | tr -d '\n')"
  fi
}

echo "目标: $URL"
echo "模型: $MODEL"
echo
echo "── 第 1 组：基础连通性 ──────────────────────────────────"

try "纯文本 messages" "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":16}"

try "加 system 提示" "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"system\",\"content\":\"You are a helpful assistant.\"},{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":16}"

echo
echo "── 第 2 组：dsh 特有的消息结构 ──────────────────────────"

try "连续两条 user（dsh 的运行时上下文注入）" "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"system\",\"content\":\"You are a helpful assistant.\"},{\"role\":\"user\",\"content\":\"hi\"},{\"role\":\"user\",\"content\":\"Current runtime context. This snapshot supersedes earlier ones.\"}],\"max_tokens\":16}"

# 纯 bash 构造长文本，避免依赖 node（服务器上通常没装）
LONG_SYSTEM=""
for _ in $(seq 1 100); do LONG_SYSTEM="${LONG_SYSTEM}You are an AI agent powered by DeepSeek Harness. "; done
try "长 system（约 4500 字符）" "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"system\",\"content\":\"$LONG_SYSTEM\"},{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":16}"

try "三条消息（dsh 的真实形状：system+user+user）" "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"system\",\"content\":\"$LONG_SYSTEM\"},{\"role\":\"user\",\"content\":\"hi\"},{\"role\":\"user\",\"content\":\"Current runtime context. This snapshot supersedes earlier runtime-context snapshots. Current DSH file policy: workspace-write. Approval policy: ask.\"}],\"max_tokens\":16}"

echo
echo "── 第 3 组：dsh 会带的可选字段 ──────────────────────────"

try "加 stream" "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":true,\"max_tokens\":16}"

try "加 store:false" "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"store\":false,\"max_tokens\":16}"

try "加 stream_options" "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":true,\"stream_options\":{\"include_usage\":true},\"max_tokens\":16}"

try "加 tools（1 个）" "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"bash\",\"description\":\"Run a shell command\",\"parameters\":{\"type\":\"object\",\"properties\":{\"command\":{\"type\":\"string\"}},\"required\":[\"command\"]}}}],\"max_tokens\":16}"

try "max_tokens=32768（dsh 的默认值）" "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":32768}"

echo
echo "── 第 4 组：组合（完整复现 dsh 的请求形状）──────────────"

try "完整组合（stream+store+stream_options+tools）" "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"system\",\"content\":\"You are a helpful assistant.\"},{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":true,\"stream_options\":{\"include_usage\":true},\"store\":false,\"max_tokens\":32768,\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"bash\",\"description\":\"Run a shell command\",\"parameters\":{\"type\":\"object\",\"properties\":{\"command\":{\"type\":\"string\"}},\"required\":[\"command\"]}}}]}"

echo
echo "── 第 5 组：模型名精确性 ────────────────────────────────"
echo "  （检查 .env 里 DSH_LLM_MODEL 是否有多余空格——这会直接导致服务端匹配不到模型）"
echo "  你填的模型名: [$MODEL]  长度=${#MODEL}"
case "$MODEL" in
  *' ') echo "  ⚠️  结尾有空格！这很可能是问题所在。请去掉 .env 里 DSH_LLM_MODEL 行尾的空格。" ;;
  ' '*) echo "  ⚠️  开头有空格！" ;;
  *)    echo "  模型名首尾无空格。" ;;
esac

echo
echo "══════════════════════════════════════════════════════"
echo "  通过 $PASS 项，失败 $FAIL 项"
echo "  ★ 第一个失败项上面那一行的字段，就是嫌疑对象。"
echo "══════════════════════════════════════════════════════"
