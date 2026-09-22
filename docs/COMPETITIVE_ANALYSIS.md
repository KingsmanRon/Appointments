# ACCESS competitive analysis

Research date: 22 September 2026. This is a product-positioning review based on vendors' public materials, not hands-on procurement diligence. Vendor claims require customer references and technical verification.

## 1. Conclusion

ACCESS is not globally unique. Tennr, Notable and Luma Health already describe products that connect referral intake, operational workflow, patient outreach and scheduling. Hyro is strong in conversational patient access. In South Africa, HeroMed, GoodX and Healthbridge offer increasingly capable practice-management suites.

The credible wedge is narrower: **a South Africa-first, standalone referral operations and evidence layer that works with the provider's existing system, makes uncertain writes and identity risk first-class, and measures the path from referral receipt to booked or deliberately closed outcome.**

If ACCESS becomes another all-in-one PMS, generic OCR tool or AI receptionist, it loses that wedge.

## 2. Market map

| Vendor | Publicly described strength | Overlap with ACCESS | Strategic implication |
| --- | --- | --- | --- |
| [Tennr](https://www.tennr.com/solutions/health-systems) | Referral processing, eligibility, prior authorisation, order transcription and visibility from referral to appointment | Very high | Closest benchmark. ACCESS cannot claim the category is empty; it must win on geography, interoperability, safety evidence and deployment fit |
| [Notable](https://www.notablehealth.com/use-case/growth-acquisition-access) | Referral intake, registration, non-clinical authorisation, patient outreach and scheduling automation | Very high | Demonstrates demand for closed-loop access workflows and raises the expected bar for automation and EHR integration |
| [Luma Health](https://www.lumahealth.io/patient-success-platform/patient-referrals/) | Referral conversion, text-first engagement, scheduling and broad patient journey orchestration | High | ACCESS should not lead with generic engagement; it should lead with safe orchestration across fragmented local systems |
| [Hyro](https://www.hyro.ai/multispecialty/) | Voice and conversational agents for scheduling, referral management and routing | Medium | Voice is a future channel, not the v1 product. ACCESS should expose a safe case/action API that a conversational layer can later use |
| [HeroMed](https://www.heromed.online/answers/end-to-end-practice-management-south-africa) | South African AI-first practice platform spanning booking, records, claims, reporting and optional reception/messaging | Medium | Strong local suite competitor. ACCESS differentiates only if customers can retain their existing PMS and use ACCESS across systems |
| [GoodX](https://goodx.co.za/) | Established all-in-one South African practice, clinical and accounting platform | Adjacent | More likely a destination or channel partner than a product to replace; connector feasibility must be proven rather than assumed |
| [Healthbridge](https://healthbridge.co.za/our-solutions/) | South African clinical, billing and practice-management solutions, including AI-assisted documentation | Adjacent | Existing distribution and workflow ownership are material advantages; integration and partnership may be more rational than direct suite competition |
| [Western Cape CAReS](https://www.westerncape.gov.za/health-wellness/CAReS) | Public-sector electronic appointment and referral service | Contextual | Shows local referral digitisation is real, but public-sector procurement and interoperability are a distinct segment from the first private-provider wedge |

## 3. Differentiation that can be defended

| Differentiator | Product mechanism | Proof required |
| --- | --- | --- |
| Preserve the existing system of record | Connector SPI, capability snapshots, immutable mappings and explicit manual fallback | A second destination can be added without forking core workflow or migrating the clinical record |
| South African workflow fit | Local channels, POPIA-governed deployment, local identity namespaces and support for document/manual processes | Design-partner evidence; legal and security review; no unsupported compliance claim |
| Identity integrity | Source evidence, human-confirmed critical fields, durable patient-creation claims and no automatic merge | Concurrent-referral and wrong-patient prevention tests; correction audit |
| Honest uncertain-outcome safety | One-use execution start, no blind retry, durable observations and reconciliation | Crash-after-write, delayed-commit and duplicate-callback acceptance results |
| Closed-loop operational evidence | Case outcomes distinguish destination commit, ready for booking, booked, closed and unknown | Reconciled pilot funnel and aged unresolved inventory |
| Customer-owned rules | Versioned access rules separate from authority policy and connector mapping | Operations can publish a reviewed rule version and explain every exception against it |
| Transparent value measurement | Observed, estimated and unknown effort; baseline and cohort definitions; correction and contact counts | Reproducible baseline and pilot report without treating missing effort as zero |
| Optional Inntris authority later | Behavioural policy port binds actor, tenant, destination, operation and exact payload | Independent conformance tests; no dependency or marketing claim in v1 |

These are intended differentiators. Until the acceptance evidence exists, they are design commitments rather than proven market advantages.

## 4. Where competitors are stronger today

1. Tennr, Notable and Luma publicly present broader referenceable workflows and mature integration footprints.
2. Hyro has a clearer omnichannel conversational proposition.
3. Local PMS vendors own the diary, billing and patient record, reducing integration friction inside their installed base.
4. Established vendors have distribution, implementation teams, security collateral and customer references that this repository does not yet have.

ACCESS should therefore avoid an enterprise-wide replacement pitch. The initial sale should be a bounded operational outcome with a fast, reversible implementation path and explicit integration qualification.

## 5. Positioning

Recommended category:

> **Patient-access orchestration for referral-heavy provider groups.**

Recommended promise:

> Turn every inbound referral into a verified, tracked path to an appointment or a known closure, without replacing the systems your teams already use.

Avoid these claims:

1. “The first” or “only” AI referral platform.
2. “No duplicates” unless the destination enforces the required uniqueness contract.
3. “End-to-end automation” where humans approve, call patients or complete work in the PMS.
4. “POPIA compliant” as a blanket product property without customer configuration, contracts and legal review.
5. Revenue or ROI figures inferred only from referral counts.

## 6. Commercial discovery questions

Before deciding to build beyond the review pack, interview at least five prospective operational buyers and establish:

1. Monthly referrals by source, specialty and site.
2. Percentage reaching an appointment and the definition of that denominator.
3. Median and tail time from receipt to first contact, destination entry and appointment.
4. Staff minutes, calls and corrections per referral.
5. Reasons referrals remain unresolved or leave the network.
6. Current PMS/EHR and practical API, export or controlled manual options.
7. Whether the buyer will fund orchestration without replacing its current suite.
8. Security, POPIA, hosting, procurement and integration constraints.

The go-to-market test fails if buyers primarily want a replacement PMS, cannot provide an outcome baseline, or cannot permit any safe integration route.

## 7. Recommended build-versus-learn decision

Proceed to implementation only after one credible design partner signs off the workflow, baseline fields, destination route and pilot success criteria. While discovery runs, it is reasonable to build the connector-independent case model, mock workflow and acceptance harness. Do not fund broad channel automation before proving referral conversion and operational adoption.
