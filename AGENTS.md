# Projectinstructies voor Tagcast

## Scope en communicatie

- Tagcast is een lokale metadata-editor voor iBroadcast; het wijzigt geen lokale
  muziekbestanden.
- Communiceer met de gebruiker in het Nederlands. Behoud bestaande Engelse
  namen voor bestanden, variabelen, functies en codecommentaren.
- Onderzoek relevante broncode en tests voordat je wijzigingen aanbrengt.
- Verwijder bestaande functionaliteit of wijzig de architectuur of het gedrag
  ingrijpend alleen met expliciete toestemming van de gebruiker.
- Maak onderscheid tussen vastgestelde feiten, aannames en mogelijke problemen.
  Vraag om verduidelijking wanneer ontbrekende informatie de uitvoering bepaalt.

## Architectuur

De toepassing bestaat uit een Python-server en een frontend in plain JavaScript.

- `src/tagcast/app.py`: CLI, lokale HTTP-server, API-routes, OAuth-callback en
  streamingproxy. Gebruikt `ThreadingHTTPServer` en `SimpleHTTPRequestHandler`.
- `src/tagcast/client.py`: `StudioClient` voor iBroadcast-requests; `Studio` voor
  OAuth, verbinding, lokale opslag, library caching, saves en read-back jobs.
- `src/tagcast/auth.py`: OAuth-requests met timeouts; gebruikt endpoints,
  PKCE-helpers en `TokenSet` uit `ibroadcast.oauth`.
- `src/tagcast/library.py`: `Record`, `Table` en `Library` lezen iBroadcast-data;
  `plan_save()`, `write_requests()` en `verify()` verzorgen de saveplanning.
- `src/tagcast/sources.py`: adapters voor externe bronnen, matching, request
  pacing en een gedeelde responsecache.
- `src/tagcast/artwork.py`: afbeeldingsvalidatie, base64-decoding en downloads.
- `src/tagcast/static/`: HTML, CSS, SVG en zes JavaScript-bestanden:
  `app.js`, `genres.js`, `lookup.js`, `artwork.js`, `player.js`, `overview.js`.
- `tests/`: unittest-tests die ook via pytest draaien, fixtures en
  `mock_ibroadcast.py`.
- `tools/build_dark_css.py`: genereert `static/dark.css` uit `static/style.css`.

De JavaScript-bestanden delen één globale scope. Houd top-level namen uniek en
behoud een geldige scriptvolgorde in `index.html`.

## Technologie en programmeerafspraken

- Python vereist versie 3.11 of hoger.
- Runtime dependency: `ibroadcast>=2.0.1,<3`; de code gebruikt ook `requests`,
  momenteel een transitive dependency van `ibroadcast`.
- Packaging gebruikt Hatchling; de CLI-entrypoint is `tagcast.app:main`.
- `pyproject.toml` bevat dependency- en lintconfiguratie; `uv.lock` legt de
  dependencyversies vast voor de uv-workflow.
- Volg de bestaande naamgeving en stijl: Python `snake_case`, JavaScript
  `camelCase` en bestaande classnamen.
- Ruff controleert `E`, `F` en `I`; de ingestelde regellengte is 100, met `E501`
  uitgezonderd.
- Behoud de bestaande frontend zonder een nieuwe buildstap of framework toe te
  voegen tenzij de gebruiker die architectuurwijziging goedkeurt.
- Bewerk `dark.css` niet handmatig. Genereer het opnieuw na wijzigingen aan
  `style.css`.

## Gedrag dat behouden moet blijven

- De server bindt uitsluitend aan `127.0.0.1`, standaard op poort 8912.
- Behoud Host-controle, POST-header `X-Tagcast`, Fetch Metadata-controle voor
  GET-API’s en bestaande beveiligingsheaders.
- Tokens en source keys blijven server-side en komen niet in API-responses
  voor de frontend of in de repository.
- Instellingen, tokens, cache en logs staan standaard in `~/.tagcast/`;
  `TAGCAST_HOME` kan dit wijzigen. Behoud bestaande migratieondersteuning voor
  de eerdere naam `library-studio`.
- Demo en geïmporteerde JSON-bibliotheken blijven lokale previews en worden
  nooit naar iBroadcast opgeslagen.
- Online suggesties vullen de editor; metadatawrites volgen pas na review.
  Artwork heeft een afzonderlijke vergelijking en expliciete save.
- Een metadata-save blijft beperkt tot één album of één album artist.
  Alleen gewijzigde, ondersteunde velden worden verstuurd.
- Vergelijk `before`-waarden met de actuele library view vóór writes.
  Controleer geaccepteerde writes achteraf via een nieuwe library download.
  Behoud het onderscheid tussen verzonden, bevestigd, onbevestigd, mislukt,
  niet verzonden en geblokkeerd.
- Saves zijn niet transactioneel. Behoud foutafhandeling voor gedeeltelijke
  saves en stop latere metadatarequests na een requestfout.
- `create_artist` wordt niet automatisch herhaald bij tijdelijke fouten.
- Albumjaren wijzigen trackjaren alleen wanneer de gebruiker dat kiest.
  Individuele trackwijzigingen hebben voorrang op album-wide wijzigingen.
- Genres: eerste label naar `genre`, overige naar `genres_additional`.
  Split bestaande gecombineerde labels alleen op verzoek.
- Composers gebruiken `artists_additional` met type `composer`; behoud andere
  credits. Een artist met `trashed` kan nog een geldige album artist zijn.
- Met `Combine Multi-Disc Album Sets` aan worden albumwijzigingen geblokkeerd;
  trackwijzigingen kunnen doorgaan. De cache moet bij deze instelling passen.
- Behoud compacte album summaries, lazy trackdetails en caching op account,
  `lastmodified` en `combine_sets`.
- Artwork gebruikt JPEG, PNG, WebP of GIF, maximaal 15 MB. Behoud controles op
  lokale adressen en redirects. Albumcovers worden op actieve tracks toegepast;
  undo bewaart eerdere artwork-ID’s per track.
- Playback loopt via de lokale server, ondersteunt Range requests en rapporteert
  geen plays of scrobbles aan iBroadcast.
- iBroadcast-write- en artworkmodes volgen deels ongedocumenteerde endpoints.
  Verifieer aannames voordat je hun payloads of gedrag verandert.

## Tests en compatibiliteit

Voer de relevante controles uit voor gewijzigde onderdelen. De bestaande
CI-controles zijn:

```sh
uv run --frozen pytest -q
uv run --frozen ruff check src tests tools
for f in src/tagcast/static/*.js; do node --check "$f"; done
node --test tests/frontend.test.cjs
```

Na wijzigingen aan `style.css`:

```sh
python3 tools/build_dark_css.py
python3 tools/build_dark_css.py --check
```

- Gebruik `tests/mock_ibroadcast.py` voor gecontroleerde iBroadcast-flows.
  `TAGCAST_IBROADCAST_BASE` verwijst alle iBroadcast-endpoints naar de mockserver.
- Houd testdata en instellingen gescheiden van het echte account, bijvoorbeeld
  via een tijdelijke `TAGCAST_HOME`.
- Frontend-regressietests voeren de scripts uit met een gesimuleerde DOM;
  ze controleren geen volledige browserinteractie.
  Controleer relevant interactiegedrag bij frontendwijzigingen.
- CI test Python 3.11 en 3.13 op Linux, macOS en Windows.
- Behoud de startscripts voor deze platforms, zowel met uv als met de
  Python/venv-fallback.
- Behoud expliciete MIME-types voor statische bestanden en platformafhankelijke
  poortafhandeling.
- `.bat` gebruikt CRLF; `.sh` en `.command` gebruiken LF volgens `.gitattributes`.
