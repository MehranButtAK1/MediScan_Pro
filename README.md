# MediScan_Pro
A system for adrs reporting and drugs information. 
# MediScan Pro

MediScan Pro — ADR Reporting & Drug Verification (PWA demo)

## Files
- index.html
- style.css
- app.js
- drap_drugs.json
- manifest.json
- sw.js

## Quick deploy (GitHub Pages)
1. Create a new repository and push these files to the root.
2. In GitHub repo settings → Pages → Source = `main` branch / root.
3. Open the generated `https://username.github.io/repo/` in mobile Chrome.
4. Grant camera permissions and tap **Scan QR (Back)**.

## Test QR examples
- Plain text QR: `Augmentin`
- JSON QR: `{"drugName":"Augmentin","batch":"AUG-AB1234","expiry":"12/2026"}`

## Notes
- openFDA calls are fallback (US data). Rate limits apply.
- For camera/torch features, host over HTTPS (GitHub Pages or Firebase).
- Reports saved to `localStorage`. Export via **Export Reports**.
- Footer: Developed & Provided by HCK_Pharma.
