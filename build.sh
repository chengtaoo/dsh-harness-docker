#!/usr/bin/env bash
# 构建镜像并导出为可离线分发的 tar 包。
#
#   ./build.sh                     # 使用 Dockerfile 中的默认 dsh 版本
#   ./build.sh 0.1.5-rc.1          # 指定 dsh 版本
#
# 产物：dist/dsh-harness-<版本>.tar.gz  与同名 .sha256 校验文件
# 目标服务器：docker load -i dsh-harness-<版本>.tar.gz
set -euo pipefail

cd "$(dirname "$0")"

DSH_VERSION="${1:-0.1.5-rc.1}"
IMAGE="dsh-harness:${DSH_VERSION}"
OUT_DIR="dist"
TARBALL="${OUT_DIR}/dsh-harness-${DSH_VERSION}.tar.gz"

mkdir -p "$OUT_DIR"

echo "==> 构建 ${IMAGE}"
docker build \
  --build-arg "DSH_VERSION=${DSH_VERSION}" \
  --tag "${IMAGE}" \
  --tag dsh-harness:latest \
  .

echo "==> 导出到 ${TARBALL}"
# 先存成 tar 再压缩：直接管道到 gzip 在部分环境下会写出截断的归档。
docker save "${IMAGE}" -o "${OUT_DIR}/dsh-harness-${DSH_VERSION}.tar"
gzip -9 -f "${OUT_DIR}/dsh-harness-${DSH_VERSION}.tar"

echo "==> 生成校验和"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${TARBALL}" | tee "${TARBALL}.sha256"
else
  shasum -a 256 "${TARBALL}" | tee "${TARBALL}.sha256"
fi

SIZE=$(du -h "${TARBALL}" | cut -f1)
echo
echo "完成：${TARBALL} (${SIZE})"
echo
echo "在目标服务器上执行："
echo "  docker load -i $(basename "${TARBALL}")"
