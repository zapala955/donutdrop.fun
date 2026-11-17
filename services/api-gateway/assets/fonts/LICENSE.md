# Fonts

The site's two typefaces, as static TrueType instances from Google Fonts, for the win card the API
draws (`src/lib/win-card.ts`). The renderer cannot read the WOFF2 files the frontend serves, so these
are the same faces in a format it can.

| File | Typeface | Copyright | Licence |
| --- | --- | --- | --- |
| `archivo-900.ttf` | Archivo Black | Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo) | SIL Open Font License 1.1 |
| `figtree-600.ttf`, `figtree-700.ttf` | Figtree SemiBold, Bold | Copyright 2022 The Figtree Project Authors (https://github.com/erikdkennedy/figtree) | SIL Open Font License 1.1 |
| `geist-500.ttf` to `geist-800.ttf` | Geist Medium to ExtraBold, for the stats card (`src/lib/stats-card.ts`) | Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font) | SIL Open Font License 1.1 |

The licence text: https://openfontlicense.org/open-font-license-official-text/
