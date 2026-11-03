# Interface language research material

Supporting files for [the internationalization plan](../tagcast-internationalization-plan.md) and
[the proof of concept evaluation](../tagcast-i18n-poc-evaluation.md).

| File | Contents |
|---|---|
| `string-inventory-c47f2e0.csv` | Every user-visible string found at commit `c47f2e01df2237240d60572e25af22f48558cf2a` (application code of Tagcast 1.3.0), before the proof of concept: 4,410 rows with layer, file, line, component, category, kind, syntactic context, attribute or exception class, word count, placeholder and fragment flags and the text. `{}` marks an interpolated value. |
| `tools/inventory-js.cjs` | JavaScript and HTML extractor (acorn 8, acorn-walk 8, parse5 7) |
| `tools/inventory_py.py` | Python extractor (standard `ast`) |
| `tools/summarize.py` | Tables by component and file, and `inv-rows.json` |
| `tools/export_csv.py` | Writes the CSV from the two inventories |
| `tools/i18next-compat.cjs` | Renders every key of the shipped catalogs in `TagcastI18n` and in i18next and compares the output |
| `tools/browser-timing.cjs` | Page load, evaluation and language switching timings in Chromium (Playwright) |
| `tools/text-scan.cjs` | Opens every screen and the main dialogs in Chromium against `tests/mock_ibroadcast.py` and records all text, attributes and clipped controls, in any shipped language or pseudo-localization, optionally with screenshots, a narrow width or dark mode |
| `tools/text-compare.py` | Compares two scans: English output before and after a change, or a translated scan for text that is still English |

The categories in the CSV: `ui` (translatable), `dnt-*` (never translated: demo and sample
metadata, product names), `technical-diagnostic`, `excluded-test-or-build`, and for Python
`ui-server-error`, `ui-server-payload`, `internal-exception` and `legacy-launcher`. A hand check
of 100 random `ui` rows found about 97 genuine interface texts; treat counts as accurate to
roughly ±5%.

## Reproducing

The tools are not project dependencies. Install them in a temporary folder outside the
repository, then point Node at it:

```sh
tmp=$(mktemp -d) && (cd "$tmp" && npm init -y >/dev/null && npm install acorn@8 acorn-walk@8 parse5@7)
NODE_PATH="$tmp/node_modules" node docs/plans/i18n/tools/inventory-js.cjs . /tmp/inv-js.json
python3 -I docs/plans/i18n/tools/inventory_py.py . /tmp/inv-py.json
python3 -I docs/plans/i18n/tools/summarize.py /tmp/inv-js.json /tmp/inv-py.json /tmp/inv-rows.json
python3 -I docs/plans/i18n/tools/export_csv.py /tmp/inv-rows.json /tmp/inv-py.json /tmp/inventory.csv
```

Run the extractor on the inspected commit to reproduce the CSV exactly. On later commits the
proof of concept moves texts into `src/tagcast/static/i18n/en.json`, so they no longer appear as
literals.

For the comparison with i18next, install `i18next@26.7.1` in the same temporary folder and run
`node docs/plans/i18n/tools/i18next-compat.cjs . "$tmp/node_modules/i18next/dist/umd/i18next.js"`.

To scan, start two Tagcast servers on mock iBroadcast instances, each with a temporary
`TAGCAST_HOME` (for example `TAGCAST_IBROADCAST_BASE=http://127.0.0.1:9555 IBROADCAST_CLIENT_ID=test`),
connect them through `/api/auth/device`, then run
`node docs/plans/i18n/tools/text-scan.cjs http://127.0.0.1:8941/ en /tmp/after-en.json` (and `nl`, `de`, `fr`, `es`, `ja`,
`pseudo`, `--width 420`, `--dark`, `--shots <dir>`) and
`python3 -I docs/plans/i18n/tools/text-compare.py english /tmp/before-en.json /tmp/after-en.json`.
