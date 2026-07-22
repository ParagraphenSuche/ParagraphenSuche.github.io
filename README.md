# ParagraphenSuche

Findet alle Gesetzeszitate (z. B. `§ 823 Abs. 1 BGB`, `Art. 6 Abs. 1 lit. f DSGVO`) in einem
juristischen PDF, erstellt eine Tabelle *Norm → Fundseiten* und prüft, ob die zitierten
Normen seit dem Erscheinungsjahr des Dokuments geändert wurden.

Läuft vollständig im Browser (GitHub Pages) — das PDF verlässt den Rechner nicht.

## Entwicklung

```bash
npm install
npm run dev        # Dev-Server
npm test           # vitest
npm run build      # Produktions-Build (dist/)
```

Deployment erfolgt automatisch per GitHub Actions bei Push auf `main`.

## Architektur

- `src/lib/` — UI-unabhängige Kernbibliothek: Textbereinigung, Zitat-Grammatik (Regex),
  Extraktion, Gesetzes-Registry, Änderungsprüfung, Report/Exporte.
- `src/app/` — schlanke Vanilla-TS-Oberfläche.
- Datenquelle: täglicher Spiegel von gesetze-im-internet.de im Repo
  [QuantLaw/gesetze-im-internet](https://github.com/QuantLaw/gesetze-im-internet)
  (Branch `data`), erreichbar per CORS über raw.githubusercontent.com.
  Pro-§-Prüfung: Gesetzes-XML an einem historischen Commit vs. aktueller Stand.

## Hinweise

- Test-PDFs (Lehrbücher) sind urheberrechtlich geschützt und werden **nie** committet
  (`*.pdf` steht in `.gitignore`); die zugehörigen e2e-Tests laufen nur lokal.
- EU-Recht (DSGVO, AEUV, …) wird erkannt, aber in v1 nicht auf Änderungen geprüft.
