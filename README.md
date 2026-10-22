# EquityLens AI

EquityLens AI is an investment research platform with a Next.js frontend and a stateless FastAPI backend. It preserves the original deterministic Python financial engine while replacing the Streamlit runtime, local SQLite cloud assumptions, and local-only UI.

All built-in company data is explicitly synthetic. EquityLens is research software, not investment advice.

## Architecture

```text
Browser (Vercel)
  -> Next.js 16 / React 19 / TypeScript / Tailwind / Recharts   (root: frontend/)
  -> NEXT_PUBLIC_API_BASE  (direct HTTPS calls, CORS-restricted)
  -> FastAPI on Google Cloud Run                                 (build context: backend/)
  -> existing deterministic EquityLens Python modules
  -> OpenRouter (optional live AI, rate limited per visitor IP)
```

- `frontend/` is a plain Next.js project on Vercel (`frontend/vercel.json`).
- `backend/` is an API-only, stateless FastAPI container on Cloud Run (`backend/Dockerfile`), deployed by `.github/workflows/deploy.yml`.
- The browser calls the backend directly so the shared rate limiter sees each visitor's own IP. Only `POST /v1/inference/generate` is rate limited (bucket `gen`); everything else is deterministic and unlimited.
- The synthetic demo company loads by default, so visitors see a full workspace without uploading anything.

## Features

- Ten working research modules: dashboard, workspace, financial analysis, valuation, agents, thesis, chat, reports, prompt lab, and settings
- Responsive terminal-style dark interface with collapsible navigation
- Multiple isolated browser-local company projects with create, rename, duplicate, switch, archive/restore, project export/import, IndexedDB storage, and localStorage fallback
- Optional ten-step New Investment Analysis workflow with artifact-based progress and persistent back/forward navigation
- PDF, CSV, and XLSX processing with source pages and review suggestions
- Editable historical financial statements and data-origin labels
- Python-calculated ratios that preserve missing values
- Five-year DCF with bear/base/bull scenarios and sensitivity matrix
- Comparable-company multiples with invalid denominator exclusion
- Four research agents plus an Evidence Verification Agent, with schema validation, source IDs, provenance, and stale-input fingerprints
- Grounded research-chat prompt preparation and manual response validation
- Deterministic investment thesis fallback
- DOCX, PDF, and XLSX report generation
- Prompt strategy comparison with objective and human-review metrics separated
- Deterministic claim checks for exact excerpts, source locators, and calculation reconciliation
- Persisted financial-analysis, thesis, and report manifests tied to dependency fingerprints; stale artifacts are hidden or excluded
- Optional one-click live AI through OpenRouter ("Run with live AI" for agents, "Ask AI" in research chat); Manual AI copy/paste always works as the fallback
- No database or object-storage service required

## Reused Python Engine

The migration keeps these framework-independent modules as the calculation source of truth:

| Module | Status |
|---|---|
| `backend/equitylens/financials.py` | Extended with scale normalization, capex-sign handling, and blocking consistency checks |
| `backend/equitylens/valuation.py` | Extended with finite-input validation and resilient scenario handling |
| `backend/equitylens/documents.py` | Extended extraction, chunk provenance, SHA-256 identifiers, suggestions, and BM25 retrieval |
| `backend/equitylens/prompts.py` | Extended with the fifth agent, source IDs, versioning, and repeatable benchmark metrics |
| `backend/equitylens/evidence.py` | Deterministic source-locator, exact-excerpt, and calculation reconciliation checks |
| `backend/equitylens/reports.py` | Extended DOCX, PDF, and Excel generation with current DCF and evidence-review exports |
| `backend/equitylens/thesis.py` | Transparent deterministic thesis generation with explicit statement classifications |
| `backend/equitylens/models.py` | Tightened Pydantic domain, evidence, and agent schemas |
| `backend/equitylens/db.py` | Retained only for legacy local tests; never instantiated by the Vercel API |
| `backend/equitylens/ai.py` | JSON validation reused; local Ollama execution is not used in production |

See `MIGRATION.md` for the detailed decision record.

## Local Development

Install Node.js 24, Python 3.12-3.14, and `uv`, then install each service's locked dependencies:

```bash
npm ci --prefix frontend
cd backend
uv sync --locked
cd ..
```

Run the backend and frontend in two terminals:

```bash
# backend/ (reads env vars from the shell; see ../.env.example)
uv run uvicorn app.main:app --reload --port 8000

# frontend/ (NEXT_PUBLIC_API_BASE defaults to http://localhost:8000)
npm run dev
```

Without `API_KEY` the live AI buttons return a "not configured" notice and the manual flow is used. Without Upstash credentials rate limiting is disabled.

## API Surface

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Health check and live-AI status (`/health` kept as an alias) |
| `GET /v1/demo` | Synthetic stateless demo data |
| `POST /v1/financials/analyze` | Historical ratios and quality checks |
| `POST /v1/valuation/dcf` | DCF, scenarios, and sensitivity |
| `POST /v1/valuation/comparables` | Peer multiples and statistics |
| `POST /v1/documents/process` | In-memory PDF/CSV/XLSX extraction |
| `POST /v1/retrieval/search` | Local BM25 evidence retrieval |
| `POST /v1/prompts/agent` | Specialized agent prompt generation |
| `POST /v1/ai/validate` | Manual agent JSON validation |
| `POST /v1/chat/prompt` | Grounded research-chat prompt generation |
| `POST /v1/chat/validate` | Manual chat response validation |
| `GET /v1/prompts/benchmarks` | Repeatable prompt benchmark definitions |
| `POST /v1/prompts/strategy` | Prompt-strategy generation |
| `POST /v1/prompts/evaluate` | Objective benchmark checks |
| `POST /v1/evidence/verify` | Deterministic claim locator, excerpt, and calculation checks |
| `POST /v1/thesis` | Deterministic classified thesis |
| `POST /v1/reports/{docx,pdf,xlsx}` | Downloadable report generation |
| `POST /v1/inference/generate` | Live AI via OpenRouter; 501 if unconfigured, 429 over quota, 503 when paused |

All arithmetic runs in Python. An LLM never calculates DCF outputs, ratios, scenarios, or sensitivity values.

## Storage and Privacy

The basic deployment is stateless:

- The project portfolio is stored primarily in browser IndexedDB, with a capacity-limited `localStorage` fallback.
- The active project can be exported; imports create a separate isolated project rather than replacing another company.
- Uploaded bytes are processed in memory and discarded after each response.
- Extracted document text remains in browser memory only by default.
- Persisting extracted text, excerpts, source-bearing agent packets, or research chat requires explicit consent in Settings.
- When retention is off, persistent copies and exports redact document chunks, excerpts, source-bearing agent output, claim checks, and chat.
- SQLite is not used by the FastAPI application.
- `backend/app/storage.py` defines the durable database/object-storage protocol for an optional future provider.

Do not enable browser document-text persistence on shared machines or where policy prohibits browser storage. IndexedDB remains local browser storage, not a durable or regulated system of record.

## Document Limits

Synchronous serverless processing is intentionally bounded:

- Maximum upload: 4 MB, keeping synchronous parsing within a 512 MiB Cloud Run instance
- Maximum PDF length: 100 pages
- Supported production uploads: PDF, CSV, XLSX
- Maximum returned searchable chunks: 250
- Maximum returned figure suggestions: 500
- Maximum returned table previews: 20

Files exceeding these limits must be split before upload. A production system requiring large filings should use consent-aware object storage plus a queued worker; serverless requests should not pretend to provide reliable long-running document jobs.

Scanned PDFs are detected by low text density, but OCR is not bundled. Convert scans to searchable PDFs first.

## AI Modes

### Manual AI Mode

Default and credential-free:

1. Select an agent or ask a research question.
2. EquityLens retrieves available evidence and constructs the prompt.
3. Copy the prompt to an external chat interface.
4. Paste the returned JSON into EquityLens.
5. FastAPI validates the exact agent schema.
6. Valid output is labeled as a manual external import.

### Financial Analytics Only

Disables narrative inference while retaining all deterministic calculations, document processing, retrieval, and exports.

### Live AI (OpenRouter)

Set `API_KEY` (and optionally `MODEL_NAME`, default `google/gemini-2.5-flash`) on the backend. The agents page then offers **Run with live AI** and research chat offers **Ask AI**; replies still pass the same schema and citation-allowlist validation before they are saved. The route is limited per IP by the shared AI Lodge rate-limit engine. When the limit is hit the AI Lodge CTA modal appears; when the demo is paused an operator notice appears. In both cases the live AI action stops there; Manual AI Mode remains a separate option you can choose in Settings.

## Tests and Build

```bash
# Python domain and API integration tests
cd backend
uv run pytest
cd ..

# Frontend type checks and component tests
npm run check --prefix frontend

# Production Next.js build
npm run build --prefix frontend

# Dependency audit
npm audit --prefix frontend --audit-level=moderate
```

The suite does not require internet access, AI credentials, Ollama, a cloud database, or uploaded fixtures. See `AUDIT.md` for the page-by-page audit, verification matrix, and residual limitations.

## Deployment

**Backend (Cloud Run).** Pushing to `main` runs `.github/workflows/deploy.yml`, which builds `backend/`, pushes `docker.io/<DOCKERHUB_USERNAME>/ail-ay2627-s1-jon-ai-investment-analyst`, and deploys the Cloud Run service of the same name with env vars from the repo's `DOTENV` secret:

```bash
cp .env.example .env    # fill in values; never commit it
gh secret set DOTENV --repo smubia-projects/ail-ay2627-s1-jon-ai-investment-analyst < .env
gh workflow run deploy.yml
```

**Frontend (Vercel).** Import the repo, set **Root Directory** to `frontend`, and set `NEXT_PUBLIC_API_BASE` to the Cloud Run URL. Then put the Vercel URL in `CORS_ORIGINS` in `.env`, re-upload `DOTENV`, and re-run the workflow.

## Limitations

- No authentication is included because the basic deployment stores isolated company projects in one browser rather than on a shared server.
- Browser IndexedDB/localStorage is not a substitute for regulated document management.
- Currency conversion and market data remain manual to avoid hidden external dependencies.
- Lexical BM25 retrieval can miss passages using unrelated terminology.
- PDF table extraction varies by filing format and always requires analyst review.
- Deterministic excerpt checks establish locator and text overlap, not full semantic entailment; consequential claims still require analyst review.
- Schema-valid AI output can still be factually wrong; the Evidence Verification Agent and human source review remain mandatory.
- Automated prompt scores do not grade interpretive quality or citation entailment.
