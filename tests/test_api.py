import json
import math
from io import BytesIO

from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def dcf_payload():
    return {
        "base_revenue": 100,
        "revenue_growth": [0, 0, 0, 0, 0],
        "ebit_margin": [0.1] * 5,
        "tax_rate": [0] * 5,
        "depreciation_pct_revenue": [0] * 5,
        "capex_pct_revenue": [0] * 5,
        "nwc_pct_revenue": [0] * 5,
        "wacc": 0.1,
        "terminal_growth": 0,
        "cash": 20,
        "debt": 30,
        "diluted_shares": 10,
        "reference_price": 8,
    }


def test_health_demo_and_dcf_endpoints():
    assert client.get("/health").json()["manual_ai_default"] is True
    demo = client.get("/v1/demo")
    assert demo.status_code == 200
    assert demo.json()["company"]["is_synthetic"] is True
    response = client.post("/v1/valuation/dcf", json=dcf_payload())
    assert response.status_code == 200
    assert math.isclose(response.json()["equity_value"], 90)
    assert math.isclose(response.json()["implied_share_value"], 9)
    assert set(response.json()["scenarios"]) == {"bear", "base", "bull"}


def test_dcf_request_validation_and_missing_data():
    invalid = dcf_payload() | {"wacc": 0.02, "terminal_growth": 0.03}
    response = client.post("/v1/valuation/dcf", json=invalid)
    assert response.status_code == 422
    financials = client.post(
        "/v1/financials/analyze",
        json={"figures": [{"company_id": 1, "metric": "revenue", "period": "2024", "value": None}]},
    )
    assert financials.status_code == 200
    assert financials.json()["analysis"][0]["gross_margin"] is None


def test_csv_document_upload_is_processed_without_retention():
    content = b"metric,2024\nRevenue,1250\n"
    response = client.post(
        "/v1/documents/process",
        files={"file": ("financials.csv", content, "text/csv")},
        data={"currency": "USD"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["document"]["retained_by_server"] is False
    assert body["document"]["document_type"] == "Financial dataset"
    assert body["chunks"]


def test_manual_agent_validation_and_prompt_generation():
    prompt = client.post(
        "/v1/prompts/agent",
        json={"agent_name": "Financial Analyst", "evidence": [], "verified_financials": {}},
    )
    assert prompt.status_code == 200
    assert "untrusted source material" in prompt.json()["prompt"]
    valid_output = {
        "summary": "Insufficient evidence.",
        "findings": [],
        "data_gaps": ["No source documents"],
    }
    validation = client.post(
        "/v1/ai/validate",
        json={"agent_name": "Financial Analyst", "raw_output": json.dumps(valid_output)},
    )
    assert validation.status_code == 200
    assert validation.json()["valid"] is True
    assert "manually imported" in validation.json()["provenance"]


def test_report_download_and_unconfigured_inference():
    demo = client.get("/v1/demo").json()
    report = client.post(
        "/v1/reports/pdf",
        json={"company": demo["company"], "figures": demo["figures"], "valuation": {}, "agent_outputs": {}},
    )
    assert report.status_code == 200
    assert report.content.startswith(b"%PDF")
    assert "attachment" in report.headers["content-disposition"]
    inference = client.post("/v1/inference/generate", json={"prompt": "test"})
    assert inference.status_code == 501


def test_upload_rejects_unsupported_files():
    response = client.post(
        "/v1/documents/process",
        files={"file": ("notes.txt", BytesIO(b"text"), "text/plain")},
    )
    assert response.status_code == 415


def test_inference_calls_openrouter_when_configured(monkeypatch):
    import app.main as main

    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": '{"ok": true}'}}]}

    def fake_post(url, headers, json, timeout):
        captured.update(url=url, headers=headers, body=json)
        return FakeResponse()

    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    monkeypatch.delenv("OPENROUTER_MODEL", raising=False)
    monkeypatch.setattr(main.requests, "post", fake_post)
    response = client.post("/v1/inference/generate", json={"prompt": "test"})
    assert response.status_code == 200
    assert response.json()["output"] == '{"ok": true}'
    assert captured["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer test-key"
    assert captured["body"]["model"] == "google/gemini-2.5-flash"
    assert captured["body"]["response_format"] == {"type": "json_object"}
    assert client.get("/api/health").json()["inference_configured"] is True
