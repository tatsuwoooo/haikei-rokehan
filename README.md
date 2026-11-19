# 背景ロケハン（haikei-rokehan）

地図で場所を選び、3D で見ながら背景として作る範囲（四角・丸・地域メッシュの格子）を置いて、
その範囲の地形と建物・道・木などの配置データを書き出すブラウザアプリです。
書き出したデータは Blender で読み込み、アセットに置き換えて背景の 3D を作ります（Blender 側は別のスクリプト）。

- スマホと PC のどちらでも動きます（PC では 3D と真上の地図を並べて表示）。
- 日本のみ。座標は平面直角座標系（m）、区画は標準地域メッシュに合わせます。
- 書き出す形式: [notes/format.md](notes/format.md)

## 使っているデータ
- © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors（ODbL）— Overpass API で取得
- [OpenFreeMap](https://openfreemap.org/) © OpenMapTiles — 建物の高さ・形
- [国土地理院](https://maps.gsi.go.jp/development/ichiran.html) — 地図・写真・標高タイル、住所検索
- 地図表示: [MapLibre GL JS](https://maplibre.org/)

## 手元で動かす
```
cd docs
python -m http.server 8770 --bind 127.0.0.1
```
http://127.0.0.1:8770/ を開く。
