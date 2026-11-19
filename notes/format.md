# 書き出しファイルの形式（version 1）

ブラウザアプリの「書き出す」で作る zip の中身。Blender 側のスクリプトはこれを読む。

```
rokehan_<場所>_<日時>.zip
├─ manifest.json
├─ sections/<区画 ID>.json        区画ごとの物
└─ terrain/<dem5a|dem>/<z>/<x>/<y>.png   国土地理院の標高タイル（そのまま）
```

## 座標
- 平面直角座標系（JGD2011）の系を、中心の都道府県から選ぶ（`manifest.zone`、1〜19）。
- 物の座標は **[東, 北]（m）**。系の原点からの値から `manifest.origin.plane` を引いた「ローカル座標」。Blender の X = 東、Y = 北にそのまま使える。
- 同じ系なら、別の日に書き出したデータも `origin.plane` の差だけずらせばぴったり並ぶ。
- 高さ（Z）は入っていない。地形の上に置くときは、標高タイルから求める。

## manifest.json
| キー | 内容 |
|---|---|
| `format`, `version` | `"haikei-rokehan"`, `1` |
| `created` | 書き出した日時（ISO） |
| `place` | `{name, c:[lon,lat]}` 場所の名前 |
| `center` | 範囲全体の中心 [lon, lat] |
| `zone`, `prefecture` | 平面直角座標系の系、都道府県コード（分からなければ null） |
| `origin.plane` | ローカル座標の原点（系の座標 [東, 北]、10m 単位に丸め） |
| `settings` | `{outside: "none"|"far", outsideR, terrain}` |
| `ranges[]` | ユーザーが置いた範囲。`{id, name, level, kind, outside, ring_lonlat, ring_local, shape}`。`outside: true` は「範囲の外を板ポリにする」で作った丸 |
| `sections[]` | 区画。`{id, level, mesh, bounds (lon/lat), bounds_local [w,s,e,n], ranges[], file, counts, terrain[]}` |
| `terrain` | 標高タイルの一覧 `{file, src, z, x, y}` と符号化の説明 |
| `attribution` | 出典（作品に使うときに表記する） |

## 区画（sections）
- `detail_<1/2 メッシュコード 9 桁>`: 詳細。約 500m。
- `mid_<3 次メッシュコード 8 桁>`: 中景。約 1km。
- `far_<範囲 ID>`: 板ポリ。範囲 1 つにつき 1 区画（`far_outside` は範囲の外）。
- 区画の形は「メッシュの四角」と「その区画の範囲（`ranges` の ID）」の重なり。Blender で切り取るときは、`bounds_local` の四角と、その `ranges` の `ring_local` の重なりを使う。
- **建物は、中心がある区画にだけ入っている**（重複なし）。範囲が重なる所は細かい方（詳細 > 中景 > 板ポリ）の区画に入る。
- 道・線路・塀・電線・面（公園や水）は、区画の四角（＋40m）にかかるものが全部入っている。区画の形で切り取ること。区画をまたぐ線は両方の区画に入っている。
- 点の物（木・信号など）は、その区画の詳細の範囲の中のものだけ。

## sections/<ID>.json
共通: `{id, level, mesh, buildings, roads, rails, areas, barriers, power, points}`

### 詳細（OSM）
- `buildings[]`: `{id, fp: [[e,n],...] 外周（閉じ点なし）, holes: [[...]], h: 高さ m, hSrc: "height"|"levels"|"guess"|"kind", minH, levels, use: building タグ, roof: roof:shape, colour, material, name, c: 中心, area: m², kind, gsi}`
  - `hSrc = "guess"` は高さが地図に無く、用途と面積から推測した値。`"kind"` は、用途も分からず、国土地理院の建物の種類と面積から推測した値。
  - `kind`: 国土地理院の建物の種類（`"house"` 普通建物＝民家・小さな建物、`"building"` 堅ろう建物＝ビル・マンション、`"tower"` 高層建物、`"shed"` 無壁舎＝屋根だけの車庫など）。`gsi` はその元の番号（3101 / 3102 / 3103 / 3111 / 3112）。中心の位置で国土地理院の建物と照らし合わせ、見つからない建物には付かない。
- `roads[]`: `{id, kind: highway の値, pts: [[e,n],...], tags: {name, lanes, width, oneway, layer, bridge, tunnel, sidewalk, surface, ...}}`
- `rails[]`: `{id, kind: railway の値, pts, tags}`
- `areas[]`: `{id, kind: water|park|grass|forest|parking|pitch|..., rings: [[[e,n],...]]}`、川などの線は `{kind: "waterway_river", line: [...]}`
- `barriers[]`: `{id, kind: wall|fence|retaining_wall|..., pts, tags}`
- `power[]`: `{id, kind: line|minor_line, pts}`
- `points[]`: `{kind, p: [e,n], tags, id}`。kind は tree / street_lamp / traffic_signals / crossing / bus_stop / sign / utility_pole / power_tower / street_cabinet / fire_hydrant / vending_machine / bench / post_box / telephone / bicycle_parking / waste_basket / toilets
  - `auto: true` の点は、OSM に無いので道の形から自動で置いたもの（3D 表示と同じ決まり。`docs/lib/props.js`）。`a` は向き（度。東が 0、反時計回り）。
    - `utility_pole`（電柱）: 細い道（minor）と tertiary の片側に約 30m ごと。`a` は道の向き（腕木は道と直角）。
    - `street_lamp`（街灯）: tertiary 以上に約 34m ごと。`a` は腕が伸びる向き（道の中へ）。
    - `traffic_signals`（信号）: secondary 以上を含む大きな交差点（または OSM に信号がある交差点）の各方向に1つ。`a` は灯器が向く向き、`arm` は腕の長さ（m）。腕は `a` の左へ伸びる。
    - `crossing`（横断歩道）: 信号のある交差点の各方向。`a` は道の向き、`w` は道幅（m）、`d` は横断歩道の幅（4m）。
    - `tree`（木）: OSM に1本ずつ登録された木（`auto` なし）のほかに、`auto: true` の木がある。`src` は置いた理由。
      - `row`: OSM の並木（natural=tree_row）の線に沿って 7m ごと。
      - `wood`: 林（OpenFreeMap の landcover wood）の中に、世界に固定した格子で約 7m ごと。
      - `photo`: 国土地理院の航空写真（seamlessphoto、z18）で、まわりより緑っぽく、ざらついている（木の葉の凹凸がある）所。約 5m の格子で、半径 2m の半分以上が木の所に置く。建物の中、車道の上、林・水の中、ほかの木から 3m 以内には置かない。`r` は写真から見た樹冠の半径（m、1.6〜3.4）。
      - `park`: 公園の中に約 13m ごと。写真を読めなかったときだけ使う（読めたときは、公園の中も写真で決める）。
      - 3D 表示と同じ関数（`docs/lib/props.js` の `treesFor`、`docs/lib/phototrees.js`）なので、Blender でもブラウザと同じ場所に立つ。写真の判定は推測なので、緑の屋根・人工芝・芝生の縁に立つことや、影の中の暗い木を取りこぼすことがある。
- `power[]` の `auto: true` は、自動で置いた電柱の間の電線（`minor_line`、2点）。

### 中景（ベクトルタイル）
- `buildings[]`: `{fp: [[e,n],...], h, hSrc: "map"|"default"|"kind", minH, kind, gsi}`（用途などのタグは無い。`kind`・`gsi` は詳細と同じ。地図に高さが無いときは種類と面積から推測して `hSrc = "kind"`）
- `roads[]`: `{kind: class（motorway, primary, minor, service, rail, path …）, sub, brunnel: bridge|tunnel|null, layer, pts}`

### 板ポリ（ベクトルタイル）
- `buildings[]`: `{box: [cx, cy, 幅, 奥行き, 角度(度, 東から反時計回り)], h}`

## 標高タイル
- 国土地理院の PNG をそのまま入れている。高さ = (R×65536 + G×256 + B) × 0.01 m。2²³ 以上は負の値（−2²⁴ する）。(128,0,0) はデータなし（海など）。
- `dem5a` は z15（約 5m、欠けがある）、`dem` は z14（約 10m）または z13（板ポリ）。詳細は dem5a を使い、欠けた所を dem で埋める。
- タイル座標 → 経緯度は Web メルカトル。経緯度 → ローカル座標は、manifest の系で平面直角座標に直してから `origin.plane` を引く。

## 出典
OSM（ODbL）、OpenFreeMap / OpenMapTiles、国土地理院。作品に使うときは出典を表記する。
