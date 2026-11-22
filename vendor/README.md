# Third-party files

Everything here is produced by `node scripts/vendor.mjs` from the versions
pinned in `package.json`. Do not edit these files by hand: change the pinned
version, run the script and commit the result.

| Library | Version | Licence | Used for |
| --- | --- | --- | --- |
| [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) | 6.19.0 | BSD-3-Clause | The map |
| [PMTiles](https://github.com/protomaps/PMTiles) | 4.5.0 | BSD-3-Clause | Reading the base-map archive |
| [Protomaps basemaps](https://github.com/protomaps/basemaps) | 5.7.2 | BSD-3-Clause | Base-map style (light and dark) |
| [Protomaps basemap assets](https://github.com/protomaps/basemaps-assets) | sprites v4 | OFL-1.1 (fonts), MIT-derived (icons) | Map label fonts and icons |

The MapLibre files are published upstream as `.mjs`; they are stored as
`.js` so that every embedded web view serves them as JavaScript. Their
contents are unchanged, as the checksums below show.

The base-map tiles themselves are not kept here or anywhere in the
repository. `scripts/fetch-basemap.mjs` cuts them from a Protomaps build of
OpenStreetMap data (© OpenStreetMap contributors, ODbL).

## Files (29, 2.97 MB)

| File | Bytes | SHA-256 | Source |
| --- | ---: | --- | --- |
| `maplibre-gl/maplibre-gl.js` | 1,106,041 | `01590c9875ea5bb0e8cdc534479f607f7d1695ca5debbccaf730edf5fa5f39e5` | maplibre-gl@6.19.0 dist/maplibre-gl.mjs |
| `maplibre-gl/maplibre-gl-worker.js` | 550,754 | `c8564c4a4147326a587c9cc4c2a871c4b02a6c37c3f1ea51da55be3220d4b112` | maplibre-gl@6.19.0 dist/maplibre-gl-worker.mjs |
| `maplibre-gl/maplibre-gl.css` | 71,596 | `a90798a1953017790e590f7e1bd35ff103a8a4263972cb47290b78adf86f8c20` | maplibre-gl@6.19.0 dist/maplibre-gl.css |
| `maplibre-gl/LICENSE.txt` | 5,984 | `ee5fc05a0677eaf69601d2c7db0d9ecd6cc27c3abc1d0733bc9ed34707cf8ef2` | maplibre-gl@6.19.0 LICENSE.txt |
| `pmtiles/pmtiles.js` | 20,229 | `caf981bc46f6327ee7e65d5dc964d89d38a69f60edca2bd4c5c890c21b554c6c` | pmtiles@4.5.0 dist/pmtiles.js |
| `pmtiles/LICENSE` | 108 | `2eb80839ea623734f1e57ebfde3ddc8a762664c12f4bd14c204cae0a261b9d5b` | note |
| `protomaps-basemaps/basemaps.js` | 38,226 | `9d6ee63bee82fd4af79bedaaab538f904341b35fbc1f6254b86166aa4ee24cf1` | @protomaps/basemaps@5.7.2 dist/esm/index.js |
| `protomaps-basemaps/LICENSE` | 124 | `37b022c1b7bcef9c2415a8642109aefb93a2df27e34bf7aa2bf0584eafc87295` | note |
| `basemaps-assets/fonts/NotoSans-Regular/0-255.pbf` | 76,044 | `62c6d49b15fa836eb6aa45e259c7ca6762f44b011b09e47776efbe4a6db1b397` | https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Regular/0-255.pbf |
| `basemaps-assets/fonts/NotoSans-Regular/256-511.pbf` | 127,726 | `2eca7561f9f566bcacfda5dd04fb5880baec1328ec0f5484678289a13994de8a` | https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Regular/256-511.pbf |
| `basemaps-assets/fonts/NotoSans-Regular/7680-7935.pbf` | 135,449 | `b9100ec886dff647198802c41d1ca6df9e6f82325179d8d71e3d377b5fe8682e` | https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Regular/7680-7935.pbf |
| `basemaps-assets/fonts/NotoSans-Regular/8192-8447.pbf` | 64,220 | `8ea977a587352fe31b4159ffdbc9a40be79056f2472017c742ea1e4a931864b9` | https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Regular/8192-8447.pbf |
| `basemaps-assets/fonts/NotoSans-Medium/0-255.pbf` | 77,628 | `ba2f0118dd024e3041b158e5f9eb49bc0a658019f53f458e9f5c0b8efcd79b91` | https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Medium/0-255.pbf |
| `basemaps-assets/fonts/NotoSans-Medium/256-511.pbf` | 129,635 | `d5e801a1a5b1d409d3298c3a1e1ca76328e2314a751078833a618620e8e66e4d` | https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Medium/256-511.pbf |
| `basemaps-assets/fonts/NotoSans-Medium/7680-7935.pbf` | 138,316 | `21c35a285f8abc65e05bd55e80f8782d10a179831a83b31d983aa00a783a258b` | https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Medium/7680-7935.pbf |
| `basemaps-assets/fonts/NotoSans-Medium/8192-8447.pbf` | 65,101 | `cc38e4956207f0edba1aaf749b61e8f6f1678ef1ad443d32ee285b21d0eb67aa` | https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Medium/8192-8447.pbf |
| `basemaps-assets/fonts/NotoSans-Italic/0-255.pbf` | 79,344 | `43edfca91c285ba1226f09d5e74d68e1473a088c517f02a5212ff6ccb10037dc` | https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Italic/0-255.pbf |
| `basemaps-assets/fonts/NotoSans-Italic/256-511.pbf` | 132,976 | `a6f9f6574c86a4a28aba630ca1017857ceadd2370ed32a1293c35f819ab9bd60` | https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Italic/256-511.pbf |
| `basemaps-assets/fonts/NotoSans-Italic/7680-7935.pbf` | 141,117 | `781d61c4e6c2634d704579906c71b064c4b62d7da7f06141a2babc0870c05ebb` | https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Italic/7680-7935.pbf |
| `basemaps-assets/fonts/NotoSans-Italic/8192-8447.pbf` | 52,891 | `5dc4e6680116fef01be024e272859d130262613c7e634409a590e5d50ad124ae` | https://protomaps.github.io/basemaps-assets/fonts/Noto%20Sans%20Italic/8192-8447.pbf |
| `basemaps-assets/sprites/v4/light.json` | 3,549 | `bfac76cf7ed5c2aa2992695904056a1c6b07785b7fd20e6c640cb44fd6244a2e` | https://protomaps.github.io/basemaps-assets/sprites/v4/light.json |
| `basemaps-assets/sprites/v4/light.png` | 16,174 | `b6a34640917bdc57d0bd080836db33376371a3312ebe7b849045268015de3481` | https://protomaps.github.io/basemaps-assets/sprites/v4/light.png |
| `basemaps-assets/sprites/v4/light@2x.json` | 3,579 | `1fb5b123fbe35d2e1f6ac171513ce01df89e671273a417ee89c44886a4c132f0` | https://protomaps.github.io/basemaps-assets/sprites/v4/light@2x.json |
| `basemaps-assets/sprites/v4/light@2x.png` | 28,852 | `23f6e9df27c2e9a14385763980a24e3608966bfc8192a106058bc2ca959ab563` | https://protomaps.github.io/basemaps-assets/sprites/v4/light@2x.png |
| `basemaps-assets/sprites/v4/dark.json` | 3,549 | `bfac76cf7ed5c2aa2992695904056a1c6b07785b7fd20e6c640cb44fd6244a2e` | https://protomaps.github.io/basemaps-assets/sprites/v4/dark.json |
| `basemaps-assets/sprites/v4/dark.png` | 16,054 | `8920f68e8f9f7a4188da43e62a81bbc426532579fff7b5f27aad09e130f4246e` | https://protomaps.github.io/basemaps-assets/sprites/v4/dark.png |
| `basemaps-assets/sprites/v4/dark@2x.json` | 3,579 | `1fb5b123fbe35d2e1f6ac171513ce01df89e671273a417ee89c44886a4c132f0` | https://protomaps.github.io/basemaps-assets/sprites/v4/dark@2x.json |
| `basemaps-assets/sprites/v4/dark@2x.png` | 28,407 | `6e01b4e366d304f27bbd55390511a3d4e39aa1d03eb3e82f873f7ea32e74cbe4` | https://protomaps.github.io/basemaps-assets/sprites/v4/dark@2x.png |
| `basemaps-assets/LICENSE.md` | 289 | `df80d14cde3799ef95bd4b3928d19667e1cb1c082c3b1d5a9ab19f537ceac123` | note |
