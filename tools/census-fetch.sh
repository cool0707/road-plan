#!/usr/bin/env bash
# 令和3年度 全国道路・街路交通情勢調査 一般交通量調査（国土交通省）の公開データを取得する。
#   箇所別基本表 CSV・時間帯別交通量表 CSV（都道府県別）と、可視化ツールの区間形状（区間ごとの GeoJSON）
# 全国を取ると約 10 万回のアクセスになる。必要な都道府県だけを指定し、サーバーに負荷をかけないこと。
# 使い方: tools/census-fetch.sh <保存先ディレクトリ> [都道府県コード...]
# 取得後に tools/census-build.mjs で data/census-r3/ を作る。
set -u
OUT=${1:?保存先ディレクトリを指定}; shift || true
KENS=("$@"); [ ${#KENS[@]} -eq 0 ] && KENS=($(seq -w 1 47))
CSV=https://www.mlit.go.jp/road/census/r3/data/csv
VIZ=https://www.mlit.go.jp/road/ir/ir-data/census_visualizationR3
mkdir -p "$OUT/csv" "$OUT/geom"
for k in "${KENS[@]}"; do
  for f in kasyo zkntrf; do
    [ -s "$OUT/csv/$f$k.csv" ] || curl -sS --retry 3 -m 300 -o "$OUT/csv/$f$k.csv" "$CSV/$f$k.csv" || echo "失敗: $f$k.csv" >&2
  done
  mkdir -p "$OUT/geom/$k"
  # 1 列目（交通調査基本区間番号）から区間形状の URL 一覧を作る。取得済みは飛ばす
  tail -n +2 "$OUT/csv/kasyo$k.csv" | cut -d, -f1 | sort -u | while read -r id; do
    [ -s "$OUT/geom/$k/$id.geojson" ] || printf 'url = "%s/census/%s/%s.geojson"\noutput = "%s/geom/%s/%s.geojson"\n' "$VIZ" "$k" "$id" "$OUT" "$k" "$id"
  done > "$OUT/geom/$k.list"
  if [ -s "$OUT/geom/$k.list" ]; then curl -sS -Z --parallel-max 12 --retry 2 -m 120 -f -K "$OUT/geom/$k.list" 2>>"$OUT/errors.log" || true; fi
  echo "$k: $(ls "$OUT/geom/$k" | wc -l) 区間"
done
