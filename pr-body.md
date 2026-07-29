## Email Tone Rewriter — Architecture Contract

**Closes #349**

This PR adds the architecture contract for the Email Tone Rewriter as a self-contained V1 individual mini-product.

### Summary

Adds `ARCHITECTURE.md` as the central architecture contract for the Email Tone Rewriter tool (`tools/v1/individual/email-tone-rewriter/`). This is documentation-only — no existing files were modified, no main app code was touched.

### What's included

The new `ARCHITECTURE.md` defines:

- **Purpose & design decisions** — pure, local, rule-based, deterministic, isolated
- **Complete folder structure** — annotated tree of all files in the tool
- **Module responsibilities** — types, services, guards, hooks, components, tests, docs
- **One-way dependency flow** — Components → Hooks → Services → Types (no circular deps)
- **Data flow diagram** — from draft input through guards → engine → result
- **Cross-references** to existing companion docs:
  - `DATA_OWNERSHIP.md` — data model, lifecycle, storage boundaries
  - `INTEGRATION_CONSTRAINTS.md` — isolation rules and future integration policy
  - `MODULE_BOUNDARIES.md` — internal module contracts and dependency rules
  - `docs/threat-model.md` — security assumptions and mitigations
  - `docs/performance.md` — performance model and hard limits
  - `docs/test-plan.md` — unit and component test scenarios
- **What contributors may change** — 8 explicit allowances
- **What contributors may NOT change** — 7 explicit prohibitions
- **Security & performance** — hard limits, sanitization rules, deterministic guarantees
- **Testing strategy** — coverage targets
- **Future integration path** — what becomes allowable when a linked integration issue is opened

### Acceptance criteria met

- ✅ Clear folder-local architecture plan
- ✅ No modifications to main app shell, routing, inbox architecture, wallet core, Stellar core, or design system
- ✅ Specs explain what future contributors may and may not change (sections 8 and 9)
- ✅ Files changed are limited to `tools/v1/individual/email-tone-rewriter/`
- ✅ Contribution is reviewable as a self-contained mini-product change

### Labels

- Architecture
- GrantFox OSS
- Maybe Rewarded
- Official Campaign
- Tooling Ecosystem
- V1 Launch Tool
- Individual Tool

### Files changed

- `tools/v1/individual/email-tone-rewriter/ARCHITECTURE.md` (+237 lines, new file)
