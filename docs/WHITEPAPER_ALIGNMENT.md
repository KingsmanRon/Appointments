# ACCESS v1.1 whitepaper alignment

Status: product thesis and scope decision for review. This document does not claim product-market fit, customer validation, working software or realised savings.

## 1. Thesis being implemented

The primary market anchor is Boston Consulting Group's July 2026 article, [Transforming the Patient Access Center with AI](https://www.bcg.com/publications/2026/transforming-patient-access-centers-with-ai). BCG describes patient access as a growth and care-access problem, not merely a contact-centre cost problem. The opportunity is to resolve high-volume appointment, referral and status intents across fragmented systems, preserve human judgement for exceptions, and connect operational improvement to completed patient journeys.

ACCESS translates that thesis into one narrow first product:

> ACCESS is a standalone patient-access orchestration layer that converts inbound referrals into verified, complete and tracked outcomes inside a provider's existing systems.

The first sellable module is **ACCESS Referral Operations**. It follows a referral from receipt through identity and information verification, safe destination commitment, readiness for booking, and either a confirmed booking or an evidenced closure. It does not replace the provider's practice management system or clinical record.

## 2. Problem-to-product traceability

| Whitepaper problem | ACCESS v1.1 response | Evidence the pilot must produce |
| --- | --- | --- |
| Appointment, referral and status intents drive substantial access volume | A generic `access_case` and interaction timeline, with `REFERRAL` as the only enabled v1 case type | Count cases and interactions by intent and channel; identify avoidable status contacts |
| Point automation leaves the patient journey fragmented | One case owns intake, verification, identity resolution, execution, follow-up and final outcome | Case timeline from first receipt to booked or deliberately closed |
| Scheduling and referral work often remains unresolved | Destination `COMMITTED` is explicitly non-terminal; booking or closure is a separate outcome | Referral-to-booking conversion, time to booking, unresolved ageing and closure reasons |
| Operational and business rules are often uncodified | Versioned customer-owned access rule sets separate operational routing from security authority | Rule version attached to every execution-ready case; exceptions explain which rule failed |
| Existing systems and workflows differ by provider | Connector capability negotiation and immutable mapping snapshots; unsupported operations use a visible human path | Qualification report for every enabled operation and safe fallback |
| AI value depends on workflow redesign and staff adoption | Human exception queue, source evidence, explicit resolution and measured staff effort | Correction rate, staff minutes, exception mix and adoption by role |
| Growth value can exceed simple labour savings | Outcome model connects completed referrals to appointments without inventing revenue | Booking conversion and leakage reduction; revenue impact remains optional and customer supplied |

These are product hypotheses derived from the article, not BCG endorsements of ACCESS.

## 3. Product boundaries

### Enabled in the first release

1. One intake channel selected with the design partner, initially secure staff upload unless evidence supports email ingestion first.
2. One referral workflow for one specialty or service line.
3. Source preservation, bounded extraction, human field confirmation and completeness rules.
4. Identity review with durable coordination around patient creation.
5. One real destination connector, plus deterministic mock and manual completion paths.
6. Safe action approval, execution, reconciliation and uncertain-outcome handling.
7. Booking-status observation or human follow-up sufficient to classify the case as booked, deliberately closed or still unresolved.
8. Baseline and pilot metrics for conversion, elapsed time, active effort, corrections, contacts and unresolved cases.

### Designed now but disabled

The contracts reserve case types and channels for appointment requests, status enquiries, cancellation, rescheduling, missing-information responses, email, WhatsApp, voice, portals and partner APIs. Reserving a namespace is not implementation. These capabilities remain disabled until separately accepted.

### Explicitly deferred

Automated voice agents, autonomous outbound messaging, broad scheduling optimisation, insurance authorisation, billing, payments, clinical triage, patient record merging and remote Inntris policy evaluation are outside the first release. Clinical source content may be displayed; ACCESS does not infer urgency or make care decisions.

## 4. Buyer and first design partner

The economic buyer is the executive accountable for patient access, referral operations or practice-group growth. Likely titles are Chief Operating Officer, Head of Patient Access, Referral Operations Lead or Group Practice Manager. IT, information security and clinical governance are mandatory approvers, but the product should not be positioned as an IT integration project alone.

The best first design partner is a referral-heavy multi-site specialist group with:

1. Enough inbound referrals for leakage and handling time to be measurable.
2. A current process spanning documents, calls and manual re-entry.
3. A destination system with at least a test route or a controlled manual completion path.
4. An operational owner able to define rules and provide an observed baseline.
5. Permission to run a synthetic qualification first and a governed live pilot later.

A named prospect such as GOA should be treated as a hypothesis until discovery confirms these conditions. A single small practice may be useful for workflow learning, but it is less likely to support the patient-access transformation and enterprise integration thesis.

## 5. Pilot outcome contract

Before live implementation, the design partner and ACCESS must agree:

| Item | Required definition |
| --- | --- |
| Cohort | Included referral source, service line, sites, dates and exclusions |
| Baseline | Observed current handling time, completion time, booking conversion, corrections and status contacts |
| Success outcome | Booked appointment or one of the enumerated evidenced closure reasons |
| Safety guardrails | Wrong-patient links, duplicate creations, unresolved external writes and unauthorised actions |
| Human effort | Observed, estimated and unknown effort reported separately |
| Attribution | Which changes are attributable to ACCESS, staffing, demand or destination-system changes |
| Go/no-go | Minimum value, safety and adoption thresholds set before outcome review |

An accepted destination write is an intermediate operational milestone. It is not counted as a booking, patient access success or realised revenue.

## 6. Funding narrative and proof sequence

The fundable claim is not that ACCESS is a general AI access centre. The claim to test is that a standalone, integration-friendly referral operations layer can reduce leakage and administrative effort in fragmented South African provider workflows while preserving identity and execution safety.

The proof sequence is:

1. Validate the workflow and baseline with one design partner.
2. Demonstrate one complete synthetic case and failure recovery against a real connector contract.
3. Run a governed live pilot with independently reviewable outcomes.
4. Show repeatability across a second service line or provider without replacing its core system.
5. Only then broaden channels and intent types.

Inntris remains a future authority implementation behind the defined policy interface. ACCESS must be independently useful and safe without Inntris, which permits it to be funded, sold and deployed as a standalone solution.
