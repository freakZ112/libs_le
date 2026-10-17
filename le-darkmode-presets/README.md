# LE Manager – Darkmode: Farb-Presets

Jede Datei (außer `index.json`) beschreibt ein Preset. Das Standard-Grau steckt fest im Skript und dient als Basis:
Alles, was in einem Preset fehlt, wird aus dem Grau übernommen.

## index.json
Liste aller Presets für das Auswahlfeld im LE Core.

```json
{ "schema": 1, "default": "grau", "presets": [ { "id": "weinrot", "file": "weinrot.json", "label": { "de": "Weinrot", "en": "Wine red" } } ] }
```

Ein neues Preset: Datei anlegen und hier einen Eintrag ergänzen. `id` = Dateiname ohne `.json`.

## Preset-Datei

| Feld | Pflicht | Inhalt |
|---|---|---|
| `schema` | ja | Formatversion, aktuell `1` |
| `id` | ja | eindeutiger Name, nur `a-z`, `0-9`, `-`, `_` |
| `label` | ja | `{ "de": "...", "en": "..." }` – Anzeigename |
| `colors` | nein | nur Farben, die vom Grau abweichen (Hex `#rrggbb` oder `rgba(r,g,b,a)`) |
| `map` | nein | Karten-Einfärbung: `colorFilter`, `tint`, `roadFilter`, `colorAlpha`, `roadWarmth`, `buildingBrightness` |
| `hud` | nein | Bilder unten an der Karte: `assets` (`left`, `right`, `ground` mit `w`, `h`, `url`), `scale`, `bottom`, `hideBar` |
| `icons` | nein | Symbole ersetzen: `data-key` des `<img>` → Bild (z. B. `"regular/plus-icon"`) |
| `navDecor` | nein | Muster in der Menüleiste: `image`, `size`, `positionLeft`, `positionRight` |
| `corners` | nein | Bilder in den oberen Ecken: `image`, `size`, `zIndex`, `opacity`, `filter` |
| `hudHeader` | nein | Hintergrundbild der Ressourcenanzeige oben |
| `addButton` | nein | Hintergrundbild des „+“-Buttons |

Bilder sind aktuell als `data:image/...;base64,...` direkt in der Datei eingebettet.

## Farb-Schlüssel (`colors`)
Die gültigen Namen stehen im Skript unter `BASE_COLORS` (z. B. `surface`, `navTop`, `navActiveBorder`, `addButton`, `text`).
Unbekannte Namen werden ignoriert.

Hinweis: `navGlowHover` (Leuchten der Menü-Buttons beim Darüberfahren) ist derzeit nur in Blau, Grün, Gelb/Orange, Cyan und Halloween gesetzt, aber nicht in der Grau-Basis des Skripts.
