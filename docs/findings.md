# Findings, decisions and open questions

This document records the audit of the project as delivered (16 Oct 2026 theme export and the `Products/` folder), the architecture decision, and the items that still need a decision from NxtGen Analysis.

## 1. What the previous implementation actually did

| Area | Observation | Risk |
|---|---|---|
| External backend `trekru2.dreamhosters.com` | All COA features called it from the browser with no authentication. Endpoints: `/get-report/{key}`, `/get-reports/{email}`, `/search-reports?email=&q=`, `/order/{orderNumber}`, `/process-pdf` | Anyone could list any customer's reports by email, read order details by order number, and generate COAs |
| `sections/pdf-upload.liquid` (Verify COA page) | 166 KB, about 60% commented-out copies. It output a nested `<html>` document inside the section and had global CSS resets (`* { margin:0; font-family: Arial }`) that leaked into the header and footer. It had no schema, so nothing could be edited in the theme editor. | The "admin" COA generator was hidden only by a Liquid email allowlist; the API behind it was open. |
| `templates/page.test-reports.liquid` | Raw template that could not be edited; two dead copies. Inserted the customer email into JavaScript without escaping. Used the Google Docs viewer for previews, which sends PDF URLs to Google. | Privacy |
| `sections/header.liquid` | About 2,300 lines of commented-out header copies, plus a report-search modal calling the old backend. Its icon was hard-coded white, so it was invisible on light colour schemes. | Maintenance, privacy |
| Homepage "Order your Test" | A rewritten stock `collection-links` section with the `order-test` handle hard-coded and the heading done with inline `!important` styles. It only linked to products. | Not editable |
| Product page order form | Custom Liquid block posting natively to `/cart/add` with line-item properties. The price was static (did not follow the selected variant). Orphaned script in `product-information.liquid` targets an element that does not exist. | UX |
| FAQ | Stock section using a colour scheme with #383838 text on a #2351a4 background. | Contrast / accessibility |
| Store navigation (live) | Order Tests → `/collections/order-test`; Verify COA → `/pages/verify`; Test Reports → `/pages/order-details`; Archive → `/pages/archive`; Contact → `/pages/contact` | — |
| Placeholder content | `page.our-lab.json` uses AI-generated blocks with placeholder people ("Dr. Charles Xavier", "Ororo Munroe", "[Facility Name]"). It is outside this scope and was **not changed**, but it should be replaced before it is linked from navigation. | Credibility |

## 2. Architecture decision

**One Node application** (Fastify + TypeScript) with Postgres and Cloudflare R2, deployed on Render. It serves:

- the staff dashboard (`/admin`)
- the storefront API through a Shopify **app proxy** (`/apps/coa/*` → `/proxy/*`), with an HMAC signature checked on every request

Alternatives considered:

- **Separate dashboard and "Shopify custom app" services.** Rejected: two deployments sharing one database and one storage account, with no isolation benefit.
- **Public CORS API called directly from the theme.** Rejected: an extra origin to secure, and no signed customer identity for Test Reports.
- **Storing reports as Shopify metaobjects.** Rejected: drafts and private data would live in Shopify, the app would need write scopes, and there would be no versioned image control.

The only Shopify permission is `read_customers`, used to read a signed-in customer's verified email. No order, product or customer-write access is requested.

## 3. Confirmed product decisions

- Test Reports shows **only the signed-in customer's own** published reports. Matching uses the customer's verified email against the email staff enter on the report; the customer ID is then cached on the report.
- Legacy reports from the old backend: **cut over, no fallback.** The theme no longer calls the old backend, so old verification keys return "no matching report".

## 4. Template mapping summary

See `docs/product-template-mapping.md` for every field, its validation and its pixel placement. Summary:

| Folder | Test type | Pages | Status |
|---|---|---|---|
| HPLC-PURITY | `hplc-purity` | 1 | complete |
| HPLC Quantity Test | `hplc-quantity` | 1 | complete |
| HPLC - Purity & Quantity Test | `hplc-purity-quantity` | 1 | complete |
| HPLC - Purity, Quantity, AND Compound identification Test | `hplc-pq-identification` | 2 | complete |
| HLPC compound identification (folder name typo; template is MS QTOF-HRMS) | `ms-identification` | 1 | complete |
| ENDOTOXIn Report | `endotoxin` | 1 | complete |
| pH Test (USP _791_) | `ph-usp-791` | 1 | complete |
| Sterility Test, pages 1–2 (ATP/Celsis) | `sterility-atp` | 2 | complete |
| Sterility Test, pages 3–4 (Visual) | `sterility-visual` | 2 | complete |

Every template was measured on the **blank** images and checked visually by overlaying generated renders on the completed examples. Several completed examples were not produced from the supplied blanks (offsets of 9–42 px; the HPLC-PURITY example has an extra "Phone" line), so the placement follows the blanks.

## 5. Open questions and template defects (flagged, not silently fixed)

Defects printed on the blanks themselves (the app leaves them as-is):

1. **pH blank header** reads "NxtGen Analysis, LLC"; other templates read "NextGen".
2. **Sterility ATP page 2 conclusion** says FTM was incubated at "20–25 °C", but the procedure states FTM at 30–35 °C.
3. **Visual sterility page 4** signer address reads "44401 Piggly Wiggly".
4. **Endotoxin** label "Start/End Temp CC):" has an unmatched parenthesis.
5. **Missing labels on the Sterility ATP blanks:**
   - Page 1 control block is missing "Negative Cut-off:" and "Bkgnd".
   - Page 2 control block is missing "Bkgnd".

   The renderer draws these labels. Better to fix the blanks.
6. **Visual sterility page 3 blank** already contains a previous client's header values. The renderer erases them, but a clean blank is preferable.
7. **Family B blanks** (Endotoxin, pH, Sterility) have the report date "30 Jun 2025" pre-printed. The renderer covers it with the entered date. Clean blanks are preferable.

Ambiguities that need a decision from the lab:

8. **Verification key format.** No completed example shows a key, so the app generates `NGA-XXXX-XXXX-XXXX`. Confirm, or provide the desired format.
9. **Expected / Measured Mass** (MS and PQ+ID page 2) are empty in the examples. They are free text with a unit and not required.
10. **HPLC Quantity Test** labels its image "Mass Spectrum". It is kept as printed; confirm whether it should read "Chromatogram".
11. **Gelling Potential** (pH) shows "Possible/ Unlikely". It is implemented as a choice between the two.
12. **Sterility and Visual sterility** templates pre-print negative conclusions (green result cells, "no microbial growth"). The app therefore **blocks** publishing a non-negative result on them. A template for positive results is needed if one should ever be issued.
13. **Endotoxin FAIL.** The examples only show PASS in green. FAIL is rendered in red, and the pre-printed green "Sample Value" cell is turned white when the endotoxin limit status is FAIL.
14. **Peak chart** is handled as an uploaded screenshot (as in the examples), not a typed table.
15. **Client email on certificates.** The pH and Sterility templates print the client email, so it is visible to anyone who can open the published certificate.
16. **Inconsistent example data** (for information only):
    - The purity example shows 99.96% while the peak table shows 99.15.
    - The quantities shown average to 11.27, not the 11.26 printed.
    - Report dates come before test dates.

    Nothing is calculated by the system, so this does not affect generation.
