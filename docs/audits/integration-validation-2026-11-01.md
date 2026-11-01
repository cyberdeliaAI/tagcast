# Tagcast — definitieve integratie- en releasecontrole

Datum: 1 november 2026. Branch: `codex/stabilization-audit`.

## Advies

**GO voor een geautoriseerde push en concept-PR; nog geen GO voor publicatie.**

De oorspronkelijke twintig commits vormen een samenhangende stabilisatieronde
tegen baseline `58c8230b3fc9f348b3dc51485b65fe6194f0cf70` (1.2.0). De twee
bevestigde P1-bevindingen zijn opgelost. Deze integratiecontrole vond twee
release-integratieproblemen en een ontbrekende automatische pakketcontrole.
Die zijn in drie afzonderlijke lokale commits gecorrigeerd. De definitief
geteste code staat op `9d4ce85bf6ae1ae717b5be61604d936248b8f40d`; de daaropvolgende
rapportagecommit verandert geen applicatiecode.

De branch is geschikt om platform-CI te starten. Nieuwe Windows-, Linux- en
macOS Intel-distributies en Developer ID/notarization voor deze wijzigingenset
zijn echter **niet** gevalideerd. Dat zijn nog verplichte publicatievoorwaarden.

## Afbakening en volledigheid

- Alle twintig oorspronkelijke commits en de gezamenlijke diff zijn beoordeeld;
  de volledige bevindingenlijst en commit-/bestandstabel blijven behouden in
  [het stabilisatierapport](stabilization-progress-2026-11-01.md).
- De wijzigingen blijven beperkt tot authenticatiefoutafhandeling, CA-bundel,
  downloads, bestaande queue-/Cleanup-/read-backproblemen, veilige beeldfallbacks,
  logrechten, releasebeveiligingen en bijbehorende tests/documentatie.
- Er zijn geen nieuwe features, CSS-/paletwijzigingen, versiebumps, gewijzigde
  Electron-afhankelijkheden of losse experimenten meegenomen. Na de oorspronkelijke
  twintig commits is `src/`, `electron/`, `pyproject.toml` en `uv.lock` ongewijzigd.
- De canonieke `main` bleef op `58c8230`; het Apple Music-worktree bleef op
  `ed68408`. Ook het afzonderlijke oude ontwikkelworktree bleef intact.
  Voor/na-controle: drie HEAD/status-snapshots en SHA-256 van alle veertig
  bestaande gewijzigde/ongetrackte bestanden zijn identiek.
- Geen push, merge, tag, release, deployment, installatievervanging, toegang tot
  signing secrets of mutatie van een echte iBroadcast-bibliotheek uitgevoerd.

## Nieuwe integratiebevindingen en correcties

| Commit | Probleem | Gerichte correctie en bewijs |
|---|---|---|
| `25a3c0e` | De nieuwe distributie-eindcontrole liep ook na een bewust overgeslagen `workflow_run` voor gewone commits. Daardoor kon een geldige gewone main-run alsnog een onterechte rode vervolgrun krijgen. | Alleen de bewust niet-toepasselijke `workflow_run` wordt overgeslagen. Een mislukte scopecontrole en onverwacht overgeslagen PR/push/manual-afhankelijkheden blijven falen. De regressietest faalde vóór de fix; de werkelijke expressie is met veertig event/scope/cancel-combinaties gecontroleerd. |
| `ac62500` | De nieuw aangemaakte stable draft werd nog expliciet als Latest aangewezen. Dat past niet bij GitHubs gedocumenteerde beperking voor drafts. | Drafts worden met `--latest=false` aangemaakt; alleen de gecontroleerde definitieve publicatie kan een stable release Latest maken. Tests voeren de echte voorbereidingsfunctie uit voor stable en beta met nagebootste GitHub-opdrachten. De stable-test faalde vóór de fix. Er is geen echte API-afwijzing gereproduceerd. |
| `9d4ce85` | De bijgewerkte CA was lokaal in het macOS-pakket bewezen, maar toekomstige platformchecks controleerden niet expliciet de werkelijk verpakte CA. | `check_certificates()` in `tools/check_electron.py` controleert vóór appstart de uitgepakte versie-inventaris, minimumversie, exacte CA-bytes en daadwerkelijke trust roots. Ontbrekende/afwijkende/oude bundels blokkeren de check. Tests: vijftien buildtests, 31 subtests; daarnaast controle van het echte uitgepakte macOS-pakket. |

De bestaande beveiligingen zijn niet omzeild. Er is geen `--no-sandbox`, gewijzigde
Chromium-sandbox, versoepelde CSP of aanpassing van Electron-fuses toegevoegd.

Bron voor de draftbeperking: [GitHub Releases API](https://docs.github.com/en/rest/releases/releases).
De [implementatie van gh release create](https://github.com/cli/cli/blob/trunk/pkg/cmd/release/create/create.go)
stuurt een expliciete Latest-keuze door naar `make_latest`.

## Gezamenlijk gecontroleerde interacties

- **OAuth en downloads:** tijdelijke refreshproblemen behouden opgeslagen tokens;
  expliciete credential rejection blijft een andere fout. De downloadafhandeling
  onderscheidt tijdelijke netwerkproblemen, auth/TLS, lokale schijffouten en Stop.
  Geen onbeperkte herhaling of omschakeling van een lokale schijffout naar streaming.
- **Downloads en hervatten:** gewijzigde totalen en geregistreerde validators
  blokkeren append; bestaande partials blijven behouden. Het manifestformaat en
  bestaande afgeronde downloads zijn niet gemigreerd.
- **Queue Sync en Gapless:** keuze voor de lokale queue gaat vóór remote restore;
  late seeks zijn gebonden aan de actuele bron/track. De echte gedeelde pagina is
  getest op normale fallback, transport en late queuevervanging. Het oorspronkelijke
  afzonderlijke handover-bewijs blijft in de evidence behouden.
- **Cleanup en editor/read-back:** onafhankelijke library-vervanging laat busy state
  los; oude editorantwoorden mogen geen nieuwe library vervangen. Grote reeds
  geleverde read-backpayloads worden vrijgegeven, actieve checks behouden hun markers.
  De bestaande fresh-review-, single-use- en no-retry-beveiligingen blijven intact.
- **CSP en beeldfallbacks:** de bestaande echte Electron-DOM-proef bewijst de
  gedelegeerde fallback onder de productie-CSP; geen inline uitvoerbare handlers
  nodig. Die resultaten zijn bewaard, niet als nieuwe fysieke browserproef geteld.
- **Releases:** tests kwalificeren de draft; aparte volledige native builds maken
  ondertekende assets; de laatste publicatiestap valideert de complete set.

## Uitgevoerde controles

Alle resultaten hieronder horen bij deze integratieronde, behalve waar expliciet
anders vermeld. De host is macOS 27.2 op Apple Silicon.

| Controle | Resultaat | Evidencebestand |
|---|---|---|
| Volledige Python-suite, Python 3.11.17 | **806 passed, 2.339 subtests passed**, 134,56 s | `python-3.11.txt` |
| Volledige Python-suite, Python 3.13.16 | **806 passed, 2.339 subtests passed**, 134,31 s | `python-3.13.txt` |
| Alle frontendtests | **602 passed, 0 failed** | `frontend.txt` |
| Alle Electron-shelltests | **40 passed, 0 failed** | `electron.txt` |
| Ruff voor src/tests/tools | Geslaagd | `ruff.txt` |
| Syntax van alle 44 gedeelde JavaScript-bestanden | Geslaagd | `final-checks.json` |
| Versieconsistentie en volledige diff-whitespacecheck | Geslaagd; versie blijft 1.2.0 | `final-checks.json` |
| Alle drie workflows met actionlint 1.7.12 | Geslaagd; shellcheck/pyflakes niet uitgevoerd | `final-checks.json` |
| Python-runtime-advisories, zeven vastgepinde pakketten | Geen bekende kwetsbaarheden gevonden | `dependency-audit.json` |
| npm-productieafhankelijkheden | Geen gemelde kwetsbaarheden | `npm-audit-runtime.json` |
| npm inclusief buildhulpmiddelen | **Exit 1**: zestien affected packages, maximaal moderate; geen high/critical. Vijf onderliggende advisories. Zie beoordeling hieronder. | `npm-audit.json` |
| Synthetische media-smoke | Twaalf scenario's plus twaalf referenties, alle geslaagd; **nul PCM-afwijkingen** | `media-smoke/results.json` |
| Media-diagnostiek | Zeven verwachte contracten geslaagd | `media-diagnostics/results.json` |
| Werkelijke gedeelde applicatiepagina | Tien scenario's geslaagd | `media-application/results.json` |
| Negatieve media-testcontroles | Zes controles bewijzen een niet-nul procesexit bij ongeldige fixtures/incomplete of mislukte metingen | `media-negative.log` |
| Uitgepakt macOS arm64-pakket | CLI, appstart, herstart/persistentie, sandbox, context isolation, gedeelde interface, mini player en serverafsluiting geslaagd | `package-check.json` |
| Werkelijk verpakte statische assets | Alle 58 bestanden byte-identiek aan de huidige bron | `package-check.json` |

Reproductie gebruikt de bestaande suites: `pytest -q`, `node --test tests/*.test.cjs`,
`node --test electron/tests/*.test.cjs`, `ruff check src tests tools`,
`tools/release_info.py` en de bestaande `tools/gapless_lab`-harnassen voor smoke,
application, diagnostics, artifact verification en negative controls.
De Python 3.11-omgeving was afzonderlijk en gebruikte dezelfde bevroren dev-lockexport.
De exacte overige verificatieopdrachten staan in `final-checks.json`.

### Grenzen van de audiometingen

Electron 44.9.3 / Chromium 152.0.7977.167; synthetische FLAC, 16/24 bit,
mono/stereo, 44,1/48/96/192 kHz, korte interludes, Repeat en verschillende blokgroottes.
De meting gebeurt vóór fysieke audio-uitvoer; het geluid is gedempt.

De mixed-block small-to-large-diagnose heeft bewust **61.824** raw afwijkingen:
dit controleert afwijzing/fallback, geen gapless doorgang. De echte applicatietest
bevestigt dat het vervolg normaal afspeelt. `seek-early` heeft **1.796.673** raw
afwijkingen door de overgeslagen tijdlijn; zijn contract is seek/readiness, geen
volledige PCM-identiteit. Beide worden nadrukkelijk niet als sample-accurate geteld.
De overige compatibele metingen, inclusief de twee begrensde 96/192 kHz-proeven,
hebben nul afwijkingen. Dat bewijst de gemeten fixtures, geen universele muziek-,
platform- of hardwarecontinuïteit. Geen nieuwe lange duurtest, slaap/ontwaak-,
AirPlay/Bluetooth- of echte multi-device WebSocket-sessie uitgevoerd.

## Pakket, certifi en ondertekening

De lokale controle hergebruikt het werkelijk gebouwde originele stabilisatiepakket;
de drie nieuwe commits veranderen geen applicatiecode/dependencies/assets.
Het pakket is opnieuw uitgepakt, de handtekening is gecontroleerd en de app is
tweemaal gestart met één tijdelijk profiel en één vaste lokale origin.

- `tagcast-1.2.0-macos-arm64.zip`, 145.970.215 bytes.
- Archief SHA-256: `5e8d217c32693678a0a3fd302d9ef75dbc9b429e7be6d414d77d591d0bbef41f`.
- Verpakte certifi: **2026.10.23**; minimum **2026.10.19**.
- CA SHA-256: `2ef52ad56b4803e264045c915e55c236cbfa045b84b81efefc218a19eb44bd2b`.
- **118 trust roots**, emSign ECC Root CA - G3 ontbreekt; CA exact gelijk aan de
  gecontroleerde builddependency. De nieuwe checker dwingt dit voortaan af bij
  elke uitgepakte Electron-build, ook op de andere platforms.
- Ad-hoc ondertekend, **geen nieuwe Developer ID- of notarization-controle**.
  Geen nieuwe officiële 1.2.0 en geen vervanging van de geïnstalleerde app.

### Afzonderlijk npm-aandachtspunt

De ongewijzigde buildketen bevat `fast-uri` 3.1.8 en meerdere `minimatch`-versies.
De meldingen betreffen URI-normalisatie en glob-pattern-verwerking:
[fast-uri](https://github.com/advisories/GHSA-w74x-v6f9-j3xg),
[hostnormalisatie](https://github.com/advisories/GHSA-wjr9-j795-jxcr),
[minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249).
De volledige lijst staat in `npm-audit.json`; zestien affected packages betekent
niet zestien onafhankelijke kwetsbaarheden.

Dit is geen nieuwe stabilisatieregressie. De lockfile is identiek aan baseline.
Het daadwerkelijk uitgepakte `app.asar` bevat achttien entries en geen
`node_modules`; de genoemde npm-buildhulpmiddelen zijn geen app-runtimepakketten.
Er is geen relevante runtime-aanval of P0/P1 gereproduceerd. De buildprocessen
blijven wel een afzonderlijk onderhoudsoppervlak: alleen vertrouwde configuratie
signen, en een gerichte dependency-update apart testen. Geen `npm audit fix --force`
toegepast; die stelde onder meer een forse electron-builder-downgrade voor.
Deze scans beoordelen geen volledige Chromium-, OpenSSL- of OS-aanvalsvlakken.

## Platformdekking: configuratie tegenover bewijs

| Platform | Bestaande CI-dekking na push/PR | Daadwerkelijk bewijs in deze ronde |
|---|---|---|
| macOS Apple Silicon | Python 3.11/3.13 op macos-latest; native build macos-15; uitgepakte CLI/app-check | Twee lokale Python-versies, Electron/media en uitgepakt ad-hoc pakket met herstart gecontroleerd |
| macOS Intel | Native macos-15-intel / x64, Python 3.13; uitgepakte CLI/app en signatures | **Niet uitgevoerd**; geen Intel-playbackclaim |
| Windows x64 | Python 3.11/3.13 op windows-latest; native windows-2022, uitgepakte CLI/app | **Niet uitgevoerd**; ACL/junction/upload-identiteit niet lokaal bewezen |
| Linux x64 | Python 3.11/3.13 op ubuntu-latest; native Ubuntu 22.04; aparte gemeten Electron-mediajob op ubuntu-latest | **Niet uitgevoerd**; YAML/testcontracten beoordeeld, geen Linux-start/playbackclaim |
| Ubuntu 24.04 desktop | Geen aparte uitgepakte desktop-app-job op deze versie; media-runner is geen equivalent | **Geen geschikte host beschikbaar**; sandbox/AppArmor blijft expliciet onbewezen |

De workflows bieden relevante source-, shell-, media- en pakketdekking, maar een
geconfigureerde job is geen geslaagde uitvoering. De Linux-mediajob gebruikt een
virtuele output en de SUID-sandboxhelper, geen uitgeschakelde sandbox. De native
Linux-appcheck gebruikt Ubuntu 22.04 en bewijst geen gewone 24.04-desktopstart.

## Releaseworkflow en overblijvende voorwaarden

Beoordeeld en lokaal getest met nagebootste GitHub-antwoorden:

1. Scope moet geldig zijn. Alle verwachte test-/buildafhankelijkheden moeten
   succesvol zijn; een onverwacht skipped/failed/cancelled/missing resultaat faalt.
2. De voorbereidingsstap maakt uitsluitend een draft voor de geteste commit.
3. Publicatie vereist exact vier archives en vier bijbehorende SHA-256-bestanden,
   niet-lege reguliere bestanden en overeenkomende checksums.
4. Beide macOS-archives vereisen aan hun exacte checksum gebonden bewijzen voor
   Developer ID, hardened runtime, notarization ticket en Gatekeeper.
5. Bestaande publieke releases en drafts met al aanwezige assets worden geweigerd.
   Geen `--clobber`. Een fout/partiële upload laat de draft ongepubliceerd; daarna
   is expliciete beoordeling nodig, geen automatische vervanging.
6. Ook na upload worden target-SHA, draftstatus, namen en bestandsgrootten opnieuw
   gecontroleerd vóór publicatie/Latest.

Dit beschermt de geautomatiseerde route. Het verhindert niet dat een maintainer
zelf buiten deze tooling een onvolledige draft publiek maakt. De echte signing-
en GitHub-upload/publish-route is in deze ronde niet aangeroepen.

Read-only controle van de huidige branchregels vond veertien bestaande verplichte
checks: vier native builds, zes Python-matrixjobs, drie startscriptjobs en de
Linux-mediajob. **Application verification** en **Distribution verification** zijn
nog niet verplicht ingesteld. Voeg die na hun eerste echte PR-run toe aan de
ruleset; behoud de bestaande controles totdat de vervanging aantoonbaar werkt.
De ruleset is niet gewijzigd.

## Open bevindingen en releasebesluit

Geen onbehandelde bevestigde P0/P1 gevonden binnen deze controle. De bekende
P3-bevindingen uit het oorspronkelijke rapport zijn niet stilzwijgend opgelost
verklaard: onder meer oude-client disconnect-races (TC-03), herstel van onzekere
write-history/corrupte lokale reports (TC-19/25/26), gedeelde-serverafsluiting,
zeldzame media-error/play-reporting-events, lokale server/fuse-hardening en
providerafhankelijke downloadgrenzen blijven afzonderlijke vervolgstappen.
De nieuwe npm-buildmeldingen zijn een aanvullend onderhoudspunt, geen aangetoonde
runtime-releaseblocker. Er is geen reden gevonden om deze branch voor een brede
refactor te blokkeren.

**Nog blokkerend voor openbare release:**

- De volledige remote matrix op de exacte integratiecommit moet eerst groen zijn.
- Nieuwe officiële macOS-assets moeten werkelijk Developer ID signed/notarized
  zijn en de signing-/assetcontrole passeren; lokale ad-hoc evidence is onvoldoende.
- Een nieuw, consistent versienummer en release notes moeten worden voorbereid.
  De huidige branch blijft bewust 1.2.0 en is geen vervangende publieke build.
- Ubuntu 24.04 moet óf op een echte host getest worden, óf de release moet deze
  compatibiliteitsgrens duidelijk behouden. Zonder hostbewijs geen 24.04-supportclaim.

**Veilige vervolgstappen:** na toestemming push naar een concept-PR, alle vier
platformbuilds en tests laten uitvoeren, aggregate checks verplicht maken,
bevindingen/ondertekende testbuild beoordelen, daarna pas met afzonderlijke
merge-/releasegoedkeuring een nieuwe security/bugfix-release voorbereiden.
Gebruik verse release-artifacts; overschrijf de bestaande signed downloads niet.
Echte 18.739-album-accountmetingen, fysieke output en langdurige sessies zijn
aanvullende validatie, geen resultaten die deze synthetische tests impliceren.

## Duurzaam bewaarde evidence

[Evidence-index](evidence/README.md): compacte oorspronkelijke en definitieve
logs, resultaten, bron-diffs, reproducerende tests en checksums staan in Git naast
dit rapport. Grote synthetische fixtures/PCM-opnamen en de gecontroleerde testapp
staan bovendien in de nieuw aangemaakte blijvende map
`/Users/cyberdelia/Documents/Tagcast-validation/stabilization-2026-11-01/`.
Geen benodigde evidence is uitsluitend afhankelijk van een disposable buildmap.
