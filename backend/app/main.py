from __future__ import annotations

import hashlib
import json
import math
import os
from io import BytesIO
from pathlib import Path
from typing import Any, Literal

import pandas as pd
import pymupdf
import requests
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from app.rate_limit import check_rate_limit
from app.schemas import (
    AgentPromptRequest,
    AgentValidationRequest,
    ChatPromptRequest,
    ChatValidationRequest,
    ComparablesRequest,
    EvidenceVerificationRequest,
    FinancialAnalysisRequest,
    InferenceRequest,
    ReportRequest,
    RetrievalRequest,
    StrategyEvaluationRequest,
    StrategyPromptRequest,
    ThesisRequest,
)
from equitylens.ai import build_chat_prompt, parse_json_output
from equitylens.documents import (
    chunk_pages,
    classify_document,
    detect_reporting_period,
    document_identifier,
    extract_document,
    search_chunks,
    suggest_financial_figures,
)
from equitylens.evidence import verify_claims
from equitylens.financials import FORMULAS, analysis_table, data_quality_issues, figures_to_frame, periods_to_metrics
from equitylens.models import ChatAnswer, DCFInputs
from equitylens.prompts import (
    AGENT_PROMPT_VERSION,
    AGENT_SCHEMAS,
    BENCHMARK_VERSION,
    STRATEGIES,
    build_agent_prompt,
    build_strategy_prompt,
    evaluate_output,
    known_answer_tasks,
)
from equitylens.reports import generate_docx, generate_excel, generate_pdf
from equitylens.sample import synthetic_company, synthetic_figures
from equitylens.thesis import generate_deterministic_thesis
from equitylens.valuation import (
    calculate_dcf,
    calculate_multiples,
    peer_statistics,
    scenario_analysis,
    sensitivity_analysis,
)

# Keep synchronous parsing small enough for a 512 MiB Cloud Run instance.
MAX_UPLOAD_BYTES = 4 * 1024 * 1024
MAX_PDF_PAGES = 100
MAX_RETURNED_CHUNKS = 250
ALLOWED_SUFFIXES = {".pdf", ".csv", ".xlsx"}

app = FastAPI(
    title="EquityLens AI API",
    version="1.0.0",
    description="Stateless deterministic financial analytics and document-processing API.",
)

# Comma-separated browser origins allowed to call the API (the Vercel frontend URL in production).
origins = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",") if origin.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
    # Report downloads read the filename from Content-Disposition across origins.
    expose_headers=["Content-Disposition"],
)


@app.get("/")
def root() -> dict[str, str]:
    return {"service": "EquityLens AI API", "status": "ready", "persistence": "stateless"}


@app.get("/api/health")
@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "equitylens-api",
        "manual_ai_default": True,
        "inference_configured": inference_configured(),
    }


@app.get("/v1/demo")
def demo_workspace() -> dict[str, Any]:
    company = synthetic_company()
    figures = synthetic_figures(company.id or 1)
    return {
        "company": company.model_dump(mode="json"),
        "figures": [figure.model_dump(mode="json") for figure in figures],
        "disclaimer": "All figures are synthetic and are not actual company information.",
    }


@app.post("/v1/financials/analyze")
def analyze_financials(payload: FinancialAnalysisRequest) -> dict[str, Any]:
    issues = data_quality_issues(payload.figures)
    blocking = [issue for issue in issues if issue.startswith(("Currency mismatch", "Duplicate figure", "Annual and quarterly"))]
    if blocking:
        raise HTTPException(status_code=422, detail=" ".join(blocking))
    table = analysis_table(payload.figures)
    return {
        "periods": periods_to_metrics(payload.figures),
        "analysis": dataframe_records(table.reset_index()),
        "quality_issues": issues,
        "formulas": FORMULAS,
    }


@app.post("/v1/valuation/dcf")
def dcf_valuation(payload: DCFInputs) -> dict[str, Any]:
    try:
        inputs = DCFInputs.model_validate(payload)
        result = calculate_dcf(inputs)
        scenarios = scenario_analysis(inputs)
        sensitivity = sensitivity_analysis(inputs)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        **dcf_result_json(result),
        "scenarios": {name.lower(): dcf_result_json(value) for name, value in scenarios.items()},
        "sensitivity": {
            "rows": list(sensitivity.index),
            "columns": list(sensitivity.columns),
            "values": [[finite_or_none(value) for value in row] for row in sensitivity.to_numpy().tolist()],
        },
    }


@app.post("/v1/valuation/comparables")
def comparable_valuation(payload: ComparablesRequest) -> dict[str, Any]:
    rows = [row.model_dump() for row in payload.rows]
    calculated = [calculate_multiples(row) for row in rows]
    statistics = peer_statistics(rows)
    return {"multiples": calculated, "statistics": dataframe_index_records(statistics)}


@app.post("/v1/documents/process")
async def process_document(file: UploadFile = File(...), currency: str = Form(default="USD")) -> dict[str, Any]:  # noqa: B008
    name = Path(file.filename or "upload").name
    suffix = Path(name).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(status_code=415, detail="Supported document types are PDF, CSV, and XLSX.")
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    await file.close()
    if not content:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="The upload exceeds the 4 MB synchronous processing limit.")
    if suffix == ".pdf":
        try:
            with pymupdf.open(stream=content, filetype="pdf") as pdf:
                if pdf.page_count > MAX_PDF_PAGES:
                    raise HTTPException(
                        status_code=413,
                        detail=f"PDFs are limited to {MAX_PDF_PAGES} pages for synchronous processing. Split the document and retry.",
                    )
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"The PDF could not be opened: {exc}") from exc
    try:
        extracted = extract_document(content, name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    combined = "\n".join(page["text"] for page in extracted.pages)
    chunks = chunk_pages(extracted.pages)[:MAX_RETURNED_CHUNKS]
    identifier = document_identifier(content)
    document_type = classify_document(name, combined)
    for chunk in chunks:
        chunk["document_name"] = name
        chunk["document_identifier"] = identifier
        chunk["chunk_id"] = hashlib.sha256(f"{identifier}:{chunk['page']}:{chunk['text']}".encode()).hexdigest()
        chunk["metadata"]["document_type"] = document_type
    return {
        "document": {
            "identifier": identifier,
            "name": name,
            "document_type": document_type,
            "reporting_period": detect_reporting_period(combined),
            "pages": len(extracted.pages),
            "warning": extracted.warning,
            "extraction_status": "warning" if extracted.warning else "complete",
            "retained_by_server": False,
        },
        "chunks": chunks,
        "suggestions": suggest_financial_figures(extracted.pages, currency.upper())[:500],
        "tables": extracted.tables[:20],
        "limits": {"max_upload_bytes": MAX_UPLOAD_BYTES, "max_pdf_pages": MAX_PDF_PAGES},
    }


@app.post("/v1/retrieval/search")
def retrieve_evidence(payload: RetrievalRequest) -> dict[str, Any]:
    return {"results": search_chunks(payload.query, [chunk.model_dump() for chunk in payload.chunks], payload.limit)}


@app.post("/v1/prompts/agent")
def prepare_agent_prompt(payload: AgentPromptRequest) -> dict[str, Any]:
    evidence = [chunk.model_dump() for chunk in payload.evidence]
    prompt = build_agent_prompt(
        payload.agent_name,
        evidence,
        payload.verified_financials,
        payload.valuation_results,
        payload.prior_outputs,
        payload.assumptions,
    )
    return {
        "agent_name": payload.agent_name,
        "prompt": prompt,
        "schema": AGENT_SCHEMAS[payload.agent_name].model_json_schema(),
        "prompt_version": AGENT_PROMPT_VERSION,
        "prompt_hash": artifact_hash(prompt),
        "input_hash": payload.client_input_hash or artifact_hash(payload.model_dump(exclude={"client_input_hash"})),
        "source_ids": [chunk["chunk_id"] for chunk in evidence],
        "assumptions": payload.assumptions,
    }


@app.post("/v1/ai/validate")
def validate_agent_response(payload: AgentValidationRequest) -> dict[str, Any]:
    parsed, errors = parse_json_output(payload.raw_output, AGENT_SCHEMAS[payload.agent_name])
    return {
        "valid": parsed is not None,
        "schema_valid": parsed is not None,
        "parsed_output": parsed,
        "errors": errors,
        "provenance": f"External model response manually imported by the user: {payload.model_id}",
        "prompt_hash": payload.prompt_hash,
        "input_hash": payload.input_hash,
        "prompt_version": payload.prompt_version,
    }


@app.post("/v1/chat/prompt")
def prepare_chat_prompt(payload: ChatPromptRequest) -> dict[str, str]:
    return {"prompt": build_chat_prompt(payload.question, [chunk.model_dump() for chunk in payload.evidence], json.dumps(payload.calculation_context, indent=2))}


@app.post("/v1/chat/validate")
def validate_chat_response(payload: ChatValidationRequest) -> dict[str, Any]:
    parsed, errors = parse_json_output(payload.raw_output, ChatAnswer)
    if parsed is not None:
        citations = parsed.get("citations", [])
        allowed = [chunk.model_dump() for chunk in payload.evidence]
        allowed_citations = {f"{chunk['document_name']}, page {chunk['page']}".casefold() for chunk in allowed}
        invalid = [citation for citation in citations if citation.strip().casefold() not in allowed_citations]
        if invalid:
            errors.append("Citations outside the retrieved source set: " + "; ".join(invalid))
        if not citations and not parsed.get("unsupported"):
            errors.append("A supported answer must cite a retrieved document and page, or set unsupported=true.")
        if errors:
            parsed = None
    return {"valid": parsed is not None, "parsed_output": parsed, "errors": errors, "provenance": "Manual import with citation allowlist validation"}


@app.get("/v1/prompts/benchmarks")
def prompt_benchmarks() -> dict[str, Any]:
    return {"version": BENCHMARK_VERSION, "strategies": STRATEGIES, "tasks": known_answer_tasks()}


@app.post("/v1/prompts/strategy")
def prepare_strategy_prompt(payload: StrategyPromptRequest) -> dict[str, str]:
    try:
        prompt = build_strategy_prompt(payload.strategy, payload.task, payload.context)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"prompt": prompt}


@app.post("/v1/prompts/evaluate")
def evaluate_strategy(payload: StrategyEvaluationRequest) -> dict[str, Any]:
    tasks = known_answer_tasks()
    if payload.task_name not in tasks:
        raise HTTPException(status_code=422, detail="Unknown benchmark task.")
    metrics = evaluate_output(payload.output, tasks[payload.task_name], payload.require_json)
    return {
        "objective_metrics": metrics,
        "benchmark_version": tasks[payload.task_name].get("version", BENCHMARK_VERSION),
        "prompt_version": payload.prompt_version,
        "model_id": payload.model_id,
        "human_judgments": {"rating": None, "notes": "Interpretive quality and citation entailment were not automatically scored."},
    }


@app.post("/v1/evidence/verify")
def verify_evidence(payload: EvidenceVerificationRequest) -> dict[str, Any]:
    assessments = verify_claims(payload.assessments, [chunk.model_dump() for chunk in payload.evidence], payload.calculation_context)
    counts = {status: sum(item["status"] == status for item in assessments) for status in ("verified", "partially_supported", "unsupported", "contradicted")}
    return {"assessments": assessments, "counts": counts, "verification_version": "evidence-v1.0"}


@app.post("/v1/thesis")
def build_thesis(payload: ThesisRequest) -> dict[str, Any]:
    blocking = blocking_financial_issues(payload.figures, payload.company.currency)
    if blocking:
        raise HTTPException(status_code=422, detail=" ".join(blocking))
    return {
        "sections": generate_deterministic_thesis(
            payload.company,
            periods_to_metrics(payload.figures),
            payload.valuation,
            payload.agent_outputs,
        )
    }


@app.post("/v1/reports/{report_format}")
def generate_report(report_format: Literal["docx", "pdf", "xlsx"], payload: ReportRequest) -> StreamingResponse:
    blocking = blocking_financial_issues(payload.figures, payload.company.currency)
    if blocking:
        raise HTTPException(status_code=422, detail=" ".join(blocking))
    valuation = payload.valuation
    calculated = None
    if payload.dcf_inputs is not None:
        try:
            calculated = calculate_dcf(payload.dcf_inputs)
            valuation = dcf_result_json(calculated)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    thesis = generate_deterministic_thesis(
        payload.company,
        periods_to_metrics(payload.figures),
        valuation,
        payload.agent_outputs,
    )
    thesis = {heading: list(items) for heading, items in thesis.items()}
    if payload.claim_assessments:
        thesis["Evidence review"] = [
            {
                "classification": f"Workspace evidence status: {assessment.status.replace('_', ' ')}",
                "text": f"{assessment.claim} Review rationale: {assessment.rationale} Checks: {' | '.join(assessment.checks) or 'none recorded'}. Calculation value: {assessment.calculation_value if assessment.calculation_value is not None else 'none'}. Human review required: {'yes' if assessment.human_review_required else 'no'}. Citations: " + (" | ".join(f"[{citation.source_id}] {citation.document_name}, page {citation.page}: {citation.excerpt}" for citation in assessment.citations) or "none"),
            }
            for assessment in payload.claim_assessments
        ]
    frame = figures_to_frame(payload.figures)
    filename = safe_filename(payload.company.name)
    if report_format == "docx":
        content = generate_docx(payload.company, thesis, frame, valuation)
        return download(content, f"{filename}-research.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    if report_format == "pdf":
        content = generate_pdf(payload.company, thesis, valuation)
        return download(content, f"{filename}-research.pdf", "application/pdf")
    assumptions = pd.DataFrame()
    forecast = pd.DataFrame()
    if payload.dcf_inputs is not None:
        inputs = payload.dcf_inputs
        assumptions = pd.DataFrame(
            {
                "year": range(1, len(inputs.revenue_growth) + 1),
                "revenue_growth": inputs.revenue_growth,
                "ebit_margin": inputs.ebit_margin,
                "tax_rate": inputs.tax_rate,
                "depreciation_pct_revenue": inputs.depreciation_pct_revenue,
                "capex_pct_revenue": inputs.capex_pct_revenue,
                "nwc_pct_revenue": inputs.nwc_pct_revenue,
            }
        )
        forecast = calculated.forecast if calculated is not None else pd.DataFrame()
    content = generate_excel(
        payload.company,
        frame,
        assumptions,
        forecast,
        valuation,
        [assessment.model_dump(mode="json") for assessment in payload.claim_assessments],
    )
    return download(content, f"{filename}-valuation.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


OPENROUTER_URL = (os.getenv("API_BASE_URL", "").strip() or os.getenv("OPENROUTER_BASE_URL", "").strip() or "https://api.apiyi.com/v1").rstrip("/") + "/chat/completions"
DEFAULT_OPENROUTER_MODEL = "gemini-3.5-flash-lite"


def openrouter_model() -> str:
    return (os.getenv("MODEL_NAME", "").strip() or os.getenv("OPENROUTER_MODEL", "")).strip() or DEFAULT_OPENROUTER_MODEL


def inference_configured() -> bool:
    return bool((os.getenv("API_KEY", "").strip() or os.getenv("OPENROUTER_API_KEY", "")).strip())


@app.post("/v1/inference/generate")
def configured_inference(payload: InferenceRequest, request: Request) -> dict[str, Any]:
    """Run a prepared prompt through OpenRouter.

    Returns 501 when no OPENROUTER_API_KEY is set so the frontend can fall back to
    Manual AI Mode. 503 is reserved for the rate-limit kill switch.
    """
    api_key = (os.getenv("API_KEY", "").strip() or os.getenv("OPENROUTER_API_KEY", "")).strip()
    if not api_key:
        raise HTTPException(status_code=501, detail="Live AI is not configured on this server. Use Manual AI Mode.")
    # Only this LLM route is rate limited (bucket "gen"); 429 over quota, 503 when paused.
    check_rate_limit(request, "gen")
    model = openrouter_model()
    body: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": payload.prompt}],
        "max_tokens": 4096,
    }
    if payload.json_mode:
        body["response_format"] = {"type": "json_object"}
    try:
        response = requests.post(
            OPENROUTER_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "X-Title": "EquityLens AI",
            },
            json=body,
            timeout=60,
        )
        response.raise_for_status()
        output = response.json()["choices"][0]["message"]["content"]
        if not isinstance(output, str) or not output.strip():
            raise ValueError("Empty model output")
    except (requests.RequestException, KeyError, IndexError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="The AI model failed to return a valid response. Try again or use Manual AI Mode.") from exc
    return {"output": output, "model": model, "provenance": "OpenRouter inference"}


def dcf_result_json(result: Any) -> dict[str, Any]:
    return {
        "forecast": dataframe_records(result.forecast.reset_index()),
        "enterprise_value": result.enterprise_value,
        "equity_value": result.equity_value,
        "implied_share_value": result.implied_share_value,
        "terminal_value": result.terminal_value,
        "pv_terminal_value": result.pv_terminal_value,
        "upside_downside": result.upside_downside,
        "timing_convention": result.timing_convention,
    }


def dataframe_records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    return json.loads(frame.to_json(orient="records"))


def dataframe_index_records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    if frame.empty:
        return []
    named = frame.reset_index().rename(columns={"index": "statistic"})
    return dataframe_records(named)


def finite_or_none(value: Any) -> float | None:
    number = float(value)
    return number if math.isfinite(number) else None


def safe_filename(name: str) -> str:
    return "-".join("".join(character.lower() if character.isalnum() else " " for character in name).split()) or "equitylens"


def download(content: bytes, filename: str, media_type: str) -> StreamingResponse:
    return StreamingResponse(
        BytesIO(content),
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"},
    )


def artifact_hash(value: Any) -> str:
    serialized = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(serialized.encode()).hexdigest()


def blocking_financial_issues(figures: list[Any], company_currency: str) -> list[str]:
    issues = [
        issue
        for issue in data_quality_issues(figures)
        if issue.startswith(("Currency mismatch", "Duplicate figure", "Annual and quarterly"))
    ]
    figure_currencies = {figure.currency for figure in figures}
    if figure_currencies and figure_currencies != {company_currency}:
        issues.append(f"Figure currency must match company currency {company_currency}.")
    return issues
