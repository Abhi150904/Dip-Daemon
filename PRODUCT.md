# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The operator researches Indian equities and manages a small virtual account locally. The user confirmed that paper order placement and automation controls are the Phase 3 priority.

## Product Purpose

DipDaemon: Scan. Simulate. Trade. Combine inspectable quantitative/AI signals with deterministic risk controls and durable simulated accounting.

## Operating Context

Local Node/TypeScript backend, SQLite and existing browser frontend. Ordinary startup observes; explicit paper mode or the synthetic offline demo supports simulated orders. No public hosting is requested.

## Capabilities and Constraints

Paper orders, positions, ledger, net P&L, signal approval, scheduler, strategy controls and logs already have backend APIs. Backend remains authoritative. Real order endpoints are disabled. Credentials stay out of the frontend. User wants to work directly on main and does not want .env.example recreated.

## Brand Commitments

DipDaemon branding, restrained dark trading-terminal aesthetic, dense readable financial data, responsive accessible interface, clear PAPER and SYNTHETIC DATA labeling. The original MIT attribution is retained.

## Evidence on Hand

docs/ARCHITECTURE.md, docs/PAPER_TRADING.md, docs/AUTOMATION.md and the offline integration suite. Local historical-bar evaluation and a separate holdout workflow now exist; real source/model provenance and profitability remain unverified.

## Product Principles

- Display authoritative paper records in rupees; distinguish unavailable values from zero.
- Make order consequences and rejection reasons visible.
- Keep simulated, observe and market-data states explicit.
- Connect every actionable control to an existing validated API.
- Evaluate frozen declared datasets with explicit fill assumptions, separate holdout results and truthful synthetic labeling.

## Accessibility & Inclusion

Keyboard-operable forms/navigation, visible focus, explicit field labels, readable contrast, status messages and small-screen layouts are required by the original brief.
