-- ACCESS v1 reference schema. Apply only to an empty development database.
-- Requires a provisioning connection with CREATEROLE and schema creation rights.
-- This is reference DDL, not a Supabase migration or deployed application.
-- PostgreSQL 17+; no extension dependency; credentials are provisioned separately.
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'access_runtime') THEN
    CREATE ROLE access_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'access_api_runtime') THEN
    CREATE ROLE access_api_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'access_worker_runtime') THEN
    CREATE ROLE access_worker_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'access_authz_owner') THEN
    CREATE ROLE access_authz_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;
GRANT access_runtime TO access_api_runtime, access_worker_runtime;

CREATE SCHEMA authz;
CREATE SCHEMA access;
REVOKE ALL ON SCHEMA authz, access FROM PUBLIC;
GRANT USAGE ON SCHEMA authz, access TO access_runtime;
GRANT USAGE, CREATE ON SCHEMA authz TO access_authz_owner;
ALTER DEFAULT PRIVILEGES IN SCHEMA authz REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA access REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Global bootstrap data, deliberately inaccessible to runtime table queries.
CREATE TABLE authz.database_principals (
  login_role name PRIMARY KEY,
  org_id uuid NOT NULL,
  principal_kind text NOT NULL CHECK (principal_kind IN ('API','WORKER')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE authz.database_principals OWNER TO access_authz_owner;

CREATE FUNCTION authz.current_org_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$ SELECT p.org_id FROM authz.database_principals p
      WHERE p.login_role = session_user::name AND p.enabled $$;
ALTER FUNCTION authz.current_org_id() OWNER TO access_authz_owner;
REVOKE CREATE ON SCHEMA authz FROM access_authz_owner;
REVOKE ALL ON FUNCTION authz.current_org_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.current_org_id() TO access_runtime;

-- This records trusted API context; it is not an authentication mechanism.
CREATE FUNCTION authz.actor_id() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('access.actor_id', true), '')::uuid $$;
REVOKE ALL ON FUNCTION authz.actor_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION authz.actor_id() TO access_runtime;

CREATE DOMAIN access.sha256 AS text CHECK (VALUE ~ '^[0-9a-f]{64}$');

CREATE TABLE access.tenants (
  org_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  current_policy_version_id uuid,
  authority_epoch bigint NOT NULL DEFAULT 1 CHECK (authority_epoch > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE authz.database_principals ADD CONSTRAINT database_principals_tenant_fk
  FOREIGN KEY (org_id) REFERENCES access.tenants(org_id);

CREATE TABLE access.memberships (
  org_id uuid NOT NULL REFERENCES access.tenants(org_id),
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('ADMIN','OPERATOR','REVIEWER','AUDITOR')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY (org_id, user_id),
  CHECK (active OR revoked_at IS NOT NULL)
);

CREATE TABLE access.session_revocations (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason_code text NOT NULL,
  PRIMARY KEY (org_id, user_id, session_id),
  FOREIGN KEY (org_id, user_id) REFERENCES access.memberships(org_id, user_id)
);

CREATE TABLE access.integrations (
  org_id uuid NOT NULL REFERENCES access.tenants(org_id),
  integration_id uuid NOT NULL DEFAULT gen_random_uuid(),
  connector_kind text NOT NULL CHECK (connector_kind IN ('DTM','MOCK')),
  environment text NOT NULL CHECK (environment IN ('TEST','PRODUCTION')),
  destination_key text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  current_capability_id uuid,
  current_mapping_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, integration_id),
  UNIQUE (org_id, connector_kind, environment, destination_key)
);

CREATE TABLE access.capability_snapshots (
  org_id uuid NOT NULL,
  capability_id uuid NOT NULL DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  version text NOT NULL,
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  manifest_hash access.sha256 NOT NULL,
  evidence_artifact_path text,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, capability_id),
  UNIQUE (org_id, integration_id, capability_id),
  UNIQUE (org_id, integration_id, version),
  FOREIGN KEY (org_id, integration_id) REFERENCES access.integrations(org_id, integration_id)
);

CREATE TABLE access.mapping_versions (
  org_id uuid NOT NULL,
  mapping_id uuid NOT NULL DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  version text NOT NULL,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  definition_hash access.sha256 NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, mapping_id),
  UNIQUE (org_id, integration_id, mapping_id),
  UNIQUE (org_id, integration_id, version),
  FOREIGN KEY (org_id, integration_id) REFERENCES access.integrations(org_id, integration_id)
);
ALTER TABLE access.integrations ADD CONSTRAINT integrations_capability_fk
  FOREIGN KEY (org_id, integration_id, current_capability_id)
  REFERENCES access.capability_snapshots(org_id, integration_id, capability_id);
ALTER TABLE access.integrations ADD CONSTRAINT integrations_mapping_fk
  FOREIGN KEY (org_id, integration_id, current_mapping_id)
  REFERENCES access.mapping_versions(org_id, integration_id, mapping_id);

CREATE TABLE access.executors (
  org_id uuid NOT NULL,
  executor_id uuid NOT NULL DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  authenticated_subject text NOT NULL,
  credential_version text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, executor_id),
  UNIQUE (org_id, integration_id, executor_id),
  UNIQUE (org_id, authenticated_subject),
  FOREIGN KEY (org_id, integration_id) REFERENCES access.integrations(org_id, integration_id)
);

CREATE TABLE access.raw_artifacts (
  org_id uuid NOT NULL REFERENCES access.tenants(org_id),
  artifact_id uuid NOT NULL DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('UPLOAD','SYNTHETIC','CONNECTOR_RESULT')),
  bucket_name text NOT NULL DEFAULT 'access-quarantine',
  object_path text NOT NULL,
  accepted_bucket_name text,
  accepted_object_path text,
  upload_state text NOT NULL DEFAULT 'RESERVED'
    CHECK (upload_state IN ('RESERVED','QUARANTINED','ACCEPTED','REJECTED','PURGED')),
  uploaded_by uuid,
  expected_mime text NOT NULL,
  expected_digest access.sha256,
  expected_max_bytes bigint NOT NULL CHECK (expected_max_bytes > 0 AND expected_max_bytes <= 20971520),
  actual_bytes bigint CHECK (actual_bytes >= 0),
  content_hash access.sha256,
  detected_mime text,
  page_count integer CHECK (page_count > 0),
  scanner_name text,
  scanner_version text,
  scanner_definition_version text,
  scan_result text CHECK (scan_result IN ('CLEAN','INFECTED','ERROR')),
  scanned_at timestamptz,
  reserved_until timestamptz NOT NULL,
  accepted_at timestamptz,
  retention_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, artifact_id),
  UNIQUE (org_id, bucket_name, object_path),
  UNIQUE (org_id, accepted_bucket_name, accepted_object_path),
  CHECK (object_path LIKE org_id::text || '/%'),
  CHECK (accepted_object_path IS NULL OR accepted_object_path LIKE org_id::text || '/%'),
  CHECK (upload_state <> 'ACCEPTED' OR (content_hash IS NOT NULL AND actual_bytes IS NOT NULL
    AND actual_bytes <= expected_max_bytes
    AND accepted_at IS NOT NULL AND accepted_object_path IS NOT NULL AND accepted_bucket_name IS NOT NULL
    AND accepted_bucket_name <> bucket_name AND scan_result IS NOT NULL AND scan_result = 'CLEAN'
    AND scanned_at IS NOT NULL AND scanner_name IS NOT NULL AND scanner_version IS NOT NULL
    AND scanner_definition_version IS NOT NULL AND detected_mime IS NOT NULL
    AND detected_mime IN ('application/pdf','image/png','image/jpeg'))),
  CHECK (upload_state <> 'ACCEPTED' OR expected_digest IS NULL OR expected_digest = content_hash)
);

CREATE TABLE access.documents (
  org_id uuid NOT NULL,
  document_id uuid NOT NULL DEFAULT gen_random_uuid(),
  artifact_id uuid NOT NULL,
  document_kind text NOT NULL DEFAULT 'REFERRAL',
  page_count integer CHECK (page_count > 0),
  processing_state text NOT NULL DEFAULT 'READY'
    CHECK (processing_state IN ('READY','EXTRACTING','EXTRACTED','REVIEW_REQUIRED','FAILED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, document_id),
  UNIQUE (org_id, artifact_id),
  FOREIGN KEY (org_id, artifact_id) REFERENCES access.raw_artifacts(org_id, artifact_id)
);

CREATE TABLE access.extractions (
  org_id uuid NOT NULL,
  extraction_id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  engine text NOT NULL,
  engine_version text NOT NULL,
  prompt_version text NOT NULL,
  schema_version text NOT NULL,
  input_hash access.sha256 NOT NULL,
  output jsonb NOT NULL CHECK (jsonb_typeof(output) = 'object'),
  output_hash access.sha256 NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, extraction_id),
  UNIQUE (org_id, document_id, extraction_id),
  FOREIGN KEY (org_id, document_id) REFERENCES access.documents(org_id, document_id)
);

CREATE TABLE access.extraction_fields (
  org_id uuid NOT NULL,
  field_id uuid NOT NULL DEFAULT gen_random_uuid(),
  extraction_id uuid NOT NULL,
  field_path text NOT NULL,
  value jsonb NOT NULL,
  source_page integer CHECK (source_page > 0),
  source_region jsonb,
  source_artifact_id uuid NOT NULL,
  source_artifact_hash access.sha256 NOT NULL,
  ocr_text_hash access.sha256 NOT NULL,
  text_start integer CHECK (text_start >= 0),
  text_end integer CHECK (text_end >= text_start),
  source_excerpt text,
  confidence numeric(5,4) CHECK (confidence BETWEEN 0 AND 1),
  needs_review boolean NOT NULL DEFAULT true,
  PRIMARY KEY (org_id, extraction_id, field_path),
  UNIQUE (org_id, field_id),
  FOREIGN KEY (org_id, extraction_id) REFERENCES access.extractions(org_id, extraction_id),
  FOREIGN KEY (org_id, source_artifact_id) REFERENCES access.raw_artifacts(org_id, artifact_id)
);

CREATE TABLE access.patients (
  org_id uuid NOT NULL REFERENCES access.tenants(org_id),
  patient_id uuid NOT NULL DEFAULT gen_random_uuid(),
  demographics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(demographics) = 'object'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, patient_id)
);

CREATE TABLE access.patient_identifiers (
  org_id uuid NOT NULL,
  identifier_id uuid NOT NULL DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL,
  namespace text NOT NULL,
  normalisation_version text NOT NULL,
  digest_key_version text NOT NULL,
  value_digest access.sha256 NOT NULL,
  encrypted_value bytea,
  verification text NOT NULL CHECK (verification IN ('CLAIMED','VERIFIED','REJECTED')),
  verified_by uuid,
  verified_at timestamptz,
  PRIMARY KEY (org_id, identifier_id),
  FOREIGN KEY (org_id, patient_id) REFERENCES access.patients(org_id, patient_id),
  CHECK (verification <> 'VERIFIED' OR (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE UNIQUE INDEX patient_identifiers_verified_uq
  ON access.patient_identifiers(org_id, namespace, normalisation_version, digest_key_version, value_digest)
  WHERE verification = 'VERIFIED';

CREATE TABLE access.external_patient_refs (
  org_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  external_patient_id text NOT NULL,
  verification_evidence jsonb NOT NULL CHECK (jsonb_typeof(verification_evidence) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, integration_id, external_patient_id),
  UNIQUE (org_id, integration_id, patient_id),
  FOREIGN KEY (org_id, patient_id) REFERENCES access.patients(org_id, patient_id),
  FOREIGN KEY (org_id, integration_id) REFERENCES access.integrations(org_id, integration_id)
);

CREATE TABLE access.referrals (
  org_id uuid NOT NULL REFERENCES access.tenants(org_id),
  referral_id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid,
  extraction_id uuid,
  patient_id uuid,
  state text NOT NULL DEFAULT 'RECEIVED' CHECK (state IN
    ('RECEIVED','EXTRACTING','REVIEW_REQUIRED','READY','AWAITING_APPROVAL','COMMIT_PENDING',
     'RECONCILING','MANUAL_PENDING','COMMITTED','CLOSED','CANCELLED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  structured_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_verification_set_id uuid,
  current_identity_decision_id uuid,
  workflow_generation bigint NOT NULL DEFAULT 1 CHECK (workflow_generation > 0),
  completion_source text CHECK (completion_source IN ('automated_confirmed','human_attested','mixed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (org_id, referral_id),
  FOREIGN KEY (org_id, document_id) REFERENCES access.documents(org_id, document_id),
  FOREIGN KEY (org_id, document_id, extraction_id) REFERENCES access.extractions(org_id, document_id, extraction_id),
  FOREIGN KEY (org_id, patient_id) REFERENCES access.patients(org_id, patient_id),
  CHECK (state NOT IN ('COMMITTED','CLOSED') OR (completed_at IS NOT NULL AND completion_source IS NOT NULL))
);
CREATE INDEX referrals_queue_idx ON access.referrals(org_id, state, created_at);

CREATE TABLE access.referral_documents (
  org_id uuid NOT NULL,
  referral_id uuid NOT NULL,
  document_id uuid NOT NULL,
  source_role text NOT NULL DEFAULT 'SOURCE',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, referral_id, document_id),
  FOREIGN KEY (org_id, referral_id) REFERENCES access.referrals(org_id, referral_id),
  FOREIGN KEY (org_id, document_id) REFERENCES access.documents(org_id, document_id)
);

CREATE TABLE access.verification_sets (
  org_id uuid NOT NULL,
  verification_set_id uuid NOT NULL DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL,
  source_version bigint NOT NULL CHECK (source_version > 0),
  canonical_payload_hash access.sha256 NOT NULL,
  verified_by uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, verification_set_id),
  UNIQUE (org_id, referral_id, verification_set_id),
  FOREIGN KEY (org_id, referral_id) REFERENCES access.referrals(org_id, referral_id),
  FOREIGN KEY (org_id, verified_by) REFERENCES access.memberships(org_id, user_id)
);

CREATE TABLE access.confirmed_fields (
  org_id uuid NOT NULL,
  verification_set_id uuid NOT NULL,
  field_path text NOT NULL,
  field_id uuid,
  accepted_value jsonb NOT NULL,
  source_evidence jsonb NOT NULL,
  PRIMARY KEY (org_id, verification_set_id, field_path),
  FOREIGN KEY (org_id, verification_set_id) REFERENCES access.verification_sets(org_id, verification_set_id),
  FOREIGN KEY (org_id, field_id) REFERENCES access.extraction_fields(org_id, field_id)
);

CREATE TABLE access.identity_decisions (
  org_id uuid NOT NULL,
  identity_decision_id uuid NOT NULL DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL,
  verification_set_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  patient_id uuid,
  decision text NOT NULL CHECK (decision IN ('LINK_EXISTING','PROPOSE_CREATE','REVIEW_REQUIRED')),
  external_patient_id text,
  decided_by uuid NOT NULL,
  evidence jsonb NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, identity_decision_id),
  UNIQUE (org_id, referral_id, identity_decision_id),
  FOREIGN KEY (org_id, referral_id, verification_set_id) REFERENCES access.verification_sets(org_id, referral_id, verification_set_id),
  FOREIGN KEY (org_id, integration_id) REFERENCES access.integrations(org_id, integration_id),
  FOREIGN KEY (org_id, patient_id) REFERENCES access.patients(org_id, patient_id),
  FOREIGN KEY (org_id, decided_by) REFERENCES access.memberships(org_id, user_id),
  CHECK (decision <> 'LINK_EXISTING' OR (patient_id IS NOT NULL AND external_patient_id IS NOT NULL))
);
ALTER TABLE access.referrals ADD CONSTRAINT referrals_verification_set_fk
  FOREIGN KEY (org_id, referral_id, current_verification_set_id)
  REFERENCES access.verification_sets(org_id, referral_id, verification_set_id);
ALTER TABLE access.referrals ADD CONSTRAINT referrals_identity_decision_fk
  FOREIGN KEY (org_id, referral_id, current_identity_decision_id)
  REFERENCES access.identity_decisions(org_id, referral_id, identity_decision_id);

CREATE TABLE access.commands (
  org_id uuid NOT NULL REFERENCES access.tenants(org_id),
  command_id uuid NOT NULL DEFAULT gen_random_uuid(),
  caller_subject text NOT NULL,
  route_family text NOT NULL,
  dedupe_key text NOT NULL,
  command_type text NOT NULL,
  request_hash access.sha256 NOT NULL,
  expected_version bigint,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, command_id),
  UNIQUE (org_id, caller_subject, route_family, dedupe_key)
);

CREATE TABLE access.policy_versions (
  org_id uuid NOT NULL REFERENCES access.tenants(org_id),
  policy_version_id uuid NOT NULL DEFAULT gen_random_uuid(),
  version text NOT NULL,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  definition_hash access.sha256 NOT NULL,
  published_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, policy_version_id),
  UNIQUE (org_id, version)
);
ALTER TABLE access.tenants ADD CONSTRAINT tenants_current_policy_fk
  FOREIGN KEY (org_id, current_policy_version_id) REFERENCES access.policy_versions(org_id, policy_version_id);

CREATE TABLE access.executions (
  org_id uuid NOT NULL,
  execution_id uuid NOT NULL DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL,
  verification_set_id uuid NOT NULL,
  identity_decision_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  capability_id uuid NOT NULL,
  mapping_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('patient.create','referral.create','document.attach')),
  action_schema_version text NOT NULL,
  final_action jsonb NOT NULL CHECK (jsonb_typeof(final_action) = 'object'),
  request_body bytea NOT NULL,
  request_body_sha256 access.sha256 NOT NULL,
  request_body_length_bytes bigint NOT NULL CHECK (request_body_length_bytes >= 0),
  action_hash access.sha256 NOT NULL,
  idempotency_key text NOT NULL,
  sequence_number bigint NOT NULL CHECK (sequence_number > 0),
  state text NOT NULL DEFAULT 'READY' CHECK (state IN
    ('READY','STARTED','UNCERTAIN','COMMITTED','REJECTED','CANCELLED','MANUAL_REVIEW')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  external_result jsonb,
  committed_at timestamptz,
  PRIMARY KEY (org_id, execution_id),
  UNIQUE (org_id, referral_id, sequence_number),
  UNIQUE (org_id, integration_id, idempotency_key),
  UNIQUE (org_id, integration_id, execution_id),
  UNIQUE (org_id, referral_id, execution_id),
  UNIQUE (org_id, execution_id, action_hash),
  FOREIGN KEY (org_id, referral_id) REFERENCES access.referrals(org_id, referral_id),
  FOREIGN KEY (org_id, referral_id, verification_set_id)
    REFERENCES access.verification_sets(org_id, referral_id, verification_set_id),
  FOREIGN KEY (org_id, referral_id, identity_decision_id)
    REFERENCES access.identity_decisions(org_id, referral_id, identity_decision_id),
  FOREIGN KEY (org_id, integration_id) REFERENCES access.integrations(org_id, integration_id),
  FOREIGN KEY (org_id, integration_id, capability_id)
    REFERENCES access.capability_snapshots(org_id, integration_id, capability_id),
  FOREIGN KEY (org_id, integration_id, mapping_id)
    REFERENCES access.mapping_versions(org_id, integration_id, mapping_id),
  CHECK (octet_length(request_body) = request_body_length_bytes),
  CHECK (state <> 'COMMITTED' OR (committed_at IS NOT NULL AND external_result IS NOT NULL))
);
CREATE INDEX executions_recovery_idx ON access.executions(org_id, state, created_at);

CREATE TABLE access.identity_claims (
  org_id uuid NOT NULL,
  claim_id uuid NOT NULL DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  owning_referral_id uuid NOT NULL,
  identity_namespace text NOT NULL,
  normalisation_version text NOT NULL,
  identity_digest access.sha256 NOT NULL,
  key_version text NOT NULL,
  execution_id uuid,
  patient_id uuid,
  state text NOT NULL DEFAULT 'RESERVED' CHECK (state IN
    ('RESERVED','UNCERTAIN','RESOLVED','RELEASED')),
  resolution_evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  PRIMARY KEY (org_id, claim_id),
  UNIQUE (org_id, integration_id, claim_id),
  FOREIGN KEY (org_id, owning_referral_id) REFERENCES access.referrals(org_id, referral_id),
  FOREIGN KEY (org_id, integration_id) REFERENCES access.integrations(org_id, integration_id),
  FOREIGN KEY (org_id, integration_id, execution_id)
    REFERENCES access.executions(org_id, integration_id, execution_id),
  FOREIGN KEY (org_id, patient_id) REFERENCES access.patients(org_id, patient_id),
  CHECK (state NOT IN ('RESOLVED','RELEASED') OR (resolution_evidence IS NOT NULL AND resolved_at IS NOT NULL)),
  CHECK (state <> 'RESOLVED' OR patient_id IS NOT NULL)
);
CREATE UNIQUE INDEX identity_claims_unreleased_uq ON access.identity_claims
  (org_id, integration_id, identity_namespace, normalisation_version, key_version, identity_digest)
  WHERE state <> 'RELEASED';

CREATE TABLE access.identity_claim_aliases (
  org_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  identity_namespace text NOT NULL,
  normalisation_version text NOT NULL,
  key_version text NOT NULL,
  identity_digest access.sha256 NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, integration_id, identity_namespace, normalisation_version, key_version, identity_digest),
  FOREIGN KEY (org_id, integration_id, claim_id) REFERENCES access.identity_claims(org_id, integration_id, claim_id)
);

CREATE TABLE access.referral_identity_claims (
  org_id uuid NOT NULL,
  referral_id uuid NOT NULL,
  claim_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, referral_id, claim_id),
  FOREIGN KEY (org_id, referral_id) REFERENCES access.referrals(org_id, referral_id),
  FOREIGN KEY (org_id, claim_id) REFERENCES access.identity_claims(org_id, claim_id)
);

CREATE TABLE access.action_approvals (
  org_id uuid NOT NULL,
  approval_id uuid NOT NULL DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL,
  action_hash access.sha256 NOT NULL,
  approved_by uuid NOT NULL,
  approval_session_id uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revocation_reason text,
  PRIMARY KEY (org_id, approval_id),
  UNIQUE (org_id, execution_id, approval_id),
  FOREIGN KEY (org_id, execution_id, action_hash) REFERENCES access.executions(org_id, execution_id, action_hash),
  FOREIGN KEY (org_id, approved_by) REFERENCES access.memberships(org_id, user_id),
  CHECK (expires_at > approved_at)
);

CREATE TABLE access.action_grants (
  org_id uuid NOT NULL,
  grant_id uuid NOT NULL DEFAULT gen_random_uuid(),
  token_digest access.sha256 NOT NULL,
  execution_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  executor_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  policy_version_id uuid NOT NULL,
  authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
  action_hash access.sha256 NOT NULL,
  authorised_user_id uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  consumed_at timestamptz,
  consumed_attempt_id uuid,
  PRIMARY KEY (org_id, grant_id),
  UNIQUE (org_id, token_digest),
  UNIQUE (org_id, execution_id, executor_id, grant_id),
  UNIQUE (org_id, consumed_attempt_id),
  FOREIGN KEY (org_id, integration_id, execution_id) REFERENCES access.executions(org_id, integration_id, execution_id),
  FOREIGN KEY (org_id, execution_id, action_hash) REFERENCES access.executions(org_id, execution_id, action_hash),
  FOREIGN KEY (org_id, integration_id, executor_id) REFERENCES access.executors(org_id, integration_id, executor_id),
  FOREIGN KEY (org_id, execution_id, approval_id) REFERENCES access.action_approvals(org_id, execution_id, approval_id),
  FOREIGN KEY (org_id, policy_version_id) REFERENCES access.policy_versions(org_id, policy_version_id),
  FOREIGN KEY (org_id, authorised_user_id) REFERENCES access.memberships(org_id, user_id),
  CHECK (expires_at > issued_at),
  CHECK ((consumed_at IS NULL) = (consumed_attempt_id IS NULL))
);

CREATE TABLE access.execution_attempts (
  org_id uuid NOT NULL,
  attempt_id uuid NOT NULL DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL,
  executor_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  state text NOT NULL CHECK (state IN ('STARTED','UNCERTAIN','COMMITTED','DEFINITIVELY_NOT_COMMITTED')),
  start_request_id uuid NOT NULL,
  invocation_owner text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatch_by timestamptz NOT NULL,
  request_deadline_at timestamptz NOT NULL,
  resolved_at timestamptz,
  retry_basis text CHECK (retry_basis IN ('DESTINATION_IDEMPOTENCY','DEFINITIVE_NON_COMMIT')),
  retry_evidence jsonb,
  PRIMARY KEY (org_id, attempt_id),
  UNIQUE (org_id, execution_id, attempt_number),
  UNIQUE (org_id, executor_id, start_request_id),
  UNIQUE (org_id, grant_id),
  UNIQUE (org_id, execution_id, attempt_id),
  UNIQUE (org_id, execution_id, grant_id, attempt_id),
  FOREIGN KEY (org_id, execution_id, executor_id, grant_id)
    REFERENCES access.action_grants(org_id, execution_id, executor_id, grant_id),
  CHECK (request_deadline_at > started_at),
  CHECK (dispatch_by > started_at AND dispatch_by <= request_deadline_at),
  CHECK (attempt_number = 1 OR (retry_basis IS NOT NULL AND retry_evidence IS NOT NULL)),
  CHECK (state NOT IN ('COMMITTED','DEFINITIVELY_NOT_COMMITTED') OR resolved_at IS NOT NULL)
);
CREATE UNIQUE INDEX execution_attempts_one_started_uq
  ON access.execution_attempts(org_id, execution_id) WHERE state = 'STARTED';
ALTER TABLE access.action_grants ADD CONSTRAINT grants_consumed_attempt_fk
  FOREIGN KEY (org_id, execution_id, grant_id, consumed_attempt_id)
  REFERENCES access.execution_attempts(org_id, execution_id, grant_id, attempt_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE access.inbox_observations (
  org_id uuid NOT NULL,
  observation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  attempt_id uuid,
  authenticated_subject text NOT NULL,
  source_message_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('CONNECTOR_RESPONSE','WEBHOOK','RECONCILIATION','HUMAN_EVIDENCE')),
  payload_hash access.sha256 NOT NULL,
  observed_outcome text NOT NULL CHECK (observed_outcome IN ('COMMITTED','DEFINITIVELY_NOT_COMMITTED','UNKNOWN')),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, observation_id),
  UNIQUE (org_id, integration_id, authenticated_subject, source_message_id),
  FOREIGN KEY (org_id, integration_id, execution_id) REFERENCES access.executions(org_id, integration_id, execution_id),
  FOREIGN KEY (org_id, execution_id, attempt_id) REFERENCES access.execution_attempts(org_id, execution_id, attempt_id)
);

CREATE TABLE access.observation_applications (
  org_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('APPLIED','DUPLICATE','CONFLICT_REVIEW','UNTRUSTED')),
  command_id uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, observation_id),
  FOREIGN KEY (org_id, observation_id) REFERENCES access.inbox_observations(org_id, observation_id),
  FOREIGN KEY (org_id, command_id) REFERENCES access.commands(org_id, command_id)
);

CREATE TABLE access.work_items (
  org_id uuid NOT NULL,
  work_item_id uuid NOT NULL DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL,
  execution_id uuid,
  kind text NOT NULL CHECK (kind IN
    ('SOURCE_VERIFICATION','IDENTITY_REVIEW','MISSING_INFORMATION','SAFE_MANUAL_COMMIT',
     'UNCERTAIN_EXECUTION','EXECUTION_FAILURE','EVIDENCE_CONFLICT','APPROVAL')),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','ASSIGNED','RESOLVED','CANCELLED')),
  assigned_user_id uuid,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, work_item_id),
  UNIQUE (org_id, referral_id, work_item_id),
  FOREIGN KEY (org_id, referral_id) REFERENCES access.referrals(org_id, referral_id),
  FOREIGN KEY (org_id, referral_id, execution_id) REFERENCES access.executions(org_id, referral_id, execution_id),
  FOREIGN KEY (org_id, assigned_user_id) REFERENCES access.memberships(org_id, user_id)
);
CREATE INDEX work_items_queue_idx ON access.work_items(org_id, state, due_at, created_at);

CREATE TABLE access.manual_preparations (
  org_id uuid NOT NULL,
  preparation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL,
  work_item_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  verification_set_id uuid NOT NULL,
  identity_decision_id uuid NOT NULL,
  prior_execution_id uuid,
  prepared_action jsonb NOT NULL CHECK (jsonb_typeof(prepared_action) = 'object'),
  prepared_action_hash access.sha256 NOT NULL,
  safety_basis text NOT NULL CHECK (safety_basis IN ('NEVER_STARTED','PROVEN_NO_EFFECT')),
  safety_evidence jsonb NOT NULL CHECK (jsonb_typeof(safety_evidence) = 'object'),
  approved_by uuid NOT NULL,
  approval_session_id uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, preparation_id),
  UNIQUE (org_id, work_item_id),
  FOREIGN KEY (org_id, referral_id, work_item_id) REFERENCES access.work_items(org_id, referral_id, work_item_id),
  FOREIGN KEY (org_id, integration_id) REFERENCES access.integrations(org_id, integration_id),
  FOREIGN KEY (org_id, referral_id, verification_set_id) REFERENCES access.verification_sets(org_id, referral_id, verification_set_id),
  FOREIGN KEY (org_id, referral_id, identity_decision_id) REFERENCES access.identity_decisions(org_id, referral_id, identity_decision_id),
  FOREIGN KEY (org_id, referral_id, prior_execution_id) REFERENCES access.executions(org_id, referral_id, execution_id),
  FOREIGN KEY (org_id, approved_by) REFERENCES access.memberships(org_id, user_id),
  CHECK (expires_at > approved_at),
  CHECK (safety_basis <> 'PROVEN_NO_EFFECT' OR prior_execution_id IS NOT NULL)
);

CREATE TABLE access.manual_attestations (
  org_id uuid NOT NULL,
  attestation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  preparation_id uuid NOT NULL,
  attested_by uuid NOT NULL,
  external_ref text NOT NULL,
  observed_at timestamptz NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, attestation_id),
  FOREIGN KEY (org_id, preparation_id) REFERENCES access.manual_preparations(org_id, preparation_id),
  FOREIGN KEY (org_id, attested_by) REFERENCES access.memberships(org_id, user_id)
);

CREATE TABLE access.work_item_resolutions (
  org_id uuid NOT NULL,
  resolution_id uuid NOT NULL DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL,
  resolved_by uuid NOT NULL,
  resolution jsonb NOT NULL CHECK (jsonb_typeof(resolution) = 'object'),
  source_evidence jsonb NOT NULL,
  supersedes_resolution_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, resolution_id),
  FOREIGN KEY (org_id, work_item_id) REFERENCES access.work_items(org_id, work_item_id),
  FOREIGN KEY (org_id, resolved_by) REFERENCES access.memberships(org_id, user_id),
  FOREIGN KEY (org_id, supersedes_resolution_id) REFERENCES access.work_item_resolutions(org_id, resolution_id)
);

CREATE TABLE access.outbox (
  org_id uuid NOT NULL,
  outbox_id uuid NOT NULL DEFAULT gen_random_uuid(),
  referral_id uuid,
  artifact_id uuid,
  execution_id uuid,
  effect_type text NOT NULL CHECK (effect_type IN ('VERIFY_UPLOAD','EXTRACT_DOCUMENT','DISPATCH_EXECUTION','RECONCILE_EXECUTION','APPLY_OBSERVATION')),
  lane text NOT NULL CHECK (lane IN ('LOCAL','WRITE','RECOVERY')),
  dedupe_key text NOT NULL,
  sequence_number bigint NOT NULL CHECK (sequence_number > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','LEASED','DELIVERED','BLOCKED','CANCELLED')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_token uuid,
  lease_until timestamptz,
  delivery_count integer NOT NULL DEFAULT 0 CHECK (delivery_count >= 0),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, outbox_id),
  UNIQUE (org_id, dedupe_key),
  UNIQUE (org_id, referral_id, sequence_number),
  FOREIGN KEY (org_id) REFERENCES access.tenants(org_id),
  FOREIGN KEY (org_id, artifact_id) REFERENCES access.raw_artifacts(org_id, artifact_id),
  FOREIGN KEY (org_id, referral_id) REFERENCES access.referrals(org_id, referral_id),
  FOREIGN KEY (org_id, referral_id, execution_id) REFERENCES access.executions(org_id, referral_id, execution_id),
  CHECK ((effect_type = 'VERIFY_UPLOAD' AND artifact_id IS NOT NULL AND execution_id IS NULL AND lane = 'LOCAL') OR
    (effect_type = 'EXTRACT_DOCUMENT' AND referral_id IS NOT NULL AND execution_id IS NULL AND lane = 'LOCAL') OR
    (effect_type = 'DISPATCH_EXECUTION' AND referral_id IS NOT NULL AND execution_id IS NOT NULL AND lane = 'WRITE') OR
    (effect_type IN ('RECONCILE_EXECUTION','APPLY_OBSERVATION') AND referral_id IS NOT NULL AND execution_id IS NOT NULL AND lane = 'RECOVERY')),
  CHECK (state <> 'LEASED' OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX outbox_dispatch_idx ON access.outbox(org_id, available_at, created_at)
  WHERE state IN ('PENDING','LEASED');

CREATE TABLE access.timers (
  org_id uuid NOT NULL,
  timer_id uuid NOT NULL DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL,
  timer_kind text NOT NULL,
  workflow_generation bigint NOT NULL CHECK (workflow_generation > 0),
  dedupe_key text NOT NULL,
  due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','FIRED','CANCELLED')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, timer_id),
  UNIQUE (org_id, dedupe_key),
  FOREIGN KEY (org_id, referral_id) REFERENCES access.referrals(org_id, referral_id)
);
CREATE INDEX timers_due_idx ON access.timers(org_id, due_at) WHERE state = 'PENDING';

CREATE TABLE access.event_chain_heads (
  org_id uuid PRIMARY KEY REFERENCES access.tenants(org_id),
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  last_hash access.sha256,
  CHECK ((last_sequence = 0) = (last_hash IS NULL))
);

CREATE TABLE access.events (
  org_id uuid NOT NULL,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  referral_id uuid,
  sequence_number bigint NOT NULL CHECK (sequence_number > 0),
  event_type text NOT NULL,
  envelope_version text NOT NULL DEFAULT 'access.event.v1',
  correlation_id uuid NOT NULL,
  causation_id uuid NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  reason_code text NOT NULL,
  measurement jsonb NOT NULL DEFAULT '{"schema":"access.measurement.v1"}'::jsonb,
  command_id uuid NOT NULL,
  actor_subject text NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  previous_hash access.sha256,
  event_hash access.sha256 NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, event_id),
  UNIQUE (org_id, sequence_number),
  UNIQUE (org_id, sequence_number, event_hash),
  FOREIGN KEY (org_id, referral_id) REFERENCES access.referrals(org_id, referral_id),
  FOREIGN KEY (org_id, command_id) REFERENCES access.commands(org_id, command_id)
);
CREATE INDEX events_timeline_idx ON access.events(org_id, referral_id, occurred_at);

CREATE TABLE access.evidence_checkpoints (
  org_id uuid NOT NULL,
  checkpoint_id uuid NOT NULL DEFAULT gen_random_uuid(),
  sequence_number bigint NOT NULL,
  event_hash access.sha256 NOT NULL,
  external_location text NOT NULL,
  signer_key_id text NOT NULL,
  checkpoint_schema text NOT NULL DEFAULT 'access.checkpoint.v1',
  signature bytea NOT NULL,
  exported_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, checkpoint_id),
  FOREIGN KEY (org_id, sequence_number, event_hash) REFERENCES access.events(org_id, sequence_number, event_hash)
);

CREATE TABLE access.effort_sessions (
  org_id uuid NOT NULL,
  effort_id uuid NOT NULL DEFAULT gen_random_uuid(),
  referral_id uuid NOT NULL,
  work_item_id uuid,
  user_id uuid NOT NULL,
  activity text NOT NULL CHECK (activity IN ('REVIEW','PHONE_CALL','INVESTIGATION','CORRECTION','PMS_WORK','OTHER')),
  measurement_kind text NOT NULL CHECK (measurement_kind IN ('OBSERVED','ESTIMATED','UNKNOWN')),
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer CHECK (duration_seconds >= 0),
  method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, effort_id),
  FOREIGN KEY (org_id, referral_id) REFERENCES access.referrals(org_id, referral_id),
  FOREIGN KEY (org_id, work_item_id) REFERENCES access.work_items(org_id, work_item_id),
  FOREIGN KEY (org_id, user_id) REFERENCES access.memberships(org_id, user_id),
  CHECK (ended_at IS NULL OR (started_at IS NOT NULL AND ended_at >= started_at)),
  CHECK ((measurement_kind = 'UNKNOWN' AND duration_seconds IS NULL) OR
         (measurement_kind <> 'UNKNOWN' AND duration_seconds IS NOT NULL))
);

CREATE TABLE access.baseline_cohorts (
  org_id uuid NOT NULL REFERENCES access.tenants(org_id),
  cohort_id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  inclusion_rules jsonb NOT NULL,
  method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, cohort_id),
  CHECK (period_end >= period_start)
);

CREATE TABLE access.baseline_observations (
  org_id uuid NOT NULL,
  observation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL,
  case_reference text NOT NULL,
  measurement_kind text NOT NULL CHECK (measurement_kind IN ('OBSERVED','ESTIMATED','UNKNOWN')),
  handling_seconds integer CHECK (handling_seconds >= 0),
  completion_seconds integer CHECK (completion_seconds >= 0),
  corrections integer CHECK (corrections >= 0),
  source_evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, observation_id),
  UNIQUE (org_id, cohort_id, case_reference),
  FOREIGN KEY (org_id, cohort_id) REFERENCES access.baseline_cohorts(org_id, cohort_id),
  CHECK (measurement_kind <> 'UNKNOWN' OR (handling_seconds IS NULL AND completion_seconds IS NULL))
);

-- Runtime roles are not owners; FORCE protects accidental use of owner-like roles
-- without BYPASSRLS. Provisioning owners/superusers remain a separate trust boundary.
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'access' LOOP
    EXECUTE format('ALTER TABLE access.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE access.%I FORCE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('CREATE POLICY tenant_scope ON access.%I TO access_runtime USING (org_id = (SELECT authz.current_org_id())) WITH CHECK (org_id = (SELECT authz.current_org_id()))', t.tablename);
  END LOOP;
END $$;

CREATE FUNCTION access.reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN RAISE EXCEPTION 'immutable record: append a new version or correction' USING ERRCODE = '55000'; END $$;

CREATE FUNCTION access.protect_execution_action() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF ROW(NEW.org_id, NEW.execution_id, NEW.referral_id, NEW.integration_id, NEW.capability_id,
    NEW.mapping_id, NEW.operation, NEW.action_schema_version, NEW.final_action, NEW.action_hash,
    NEW.verification_set_id, NEW.identity_decision_id, NEW.request_body, NEW.request_body_sha256, NEW.request_body_length_bytes,
    NEW.idempotency_key, NEW.sequence_number, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.org_id, OLD.execution_id, OLD.referral_id, OLD.integration_id, OLD.capability_id,
    OLD.mapping_id, OLD.operation, OLD.action_schema_version, OLD.final_action, OLD.action_hash,
    OLD.verification_set_id, OLD.identity_decision_id, OLD.request_body, OLD.request_body_sha256, OLD.request_body_length_bytes,
    OLD.idempotency_key, OLD.sequence_number, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'execution action is immutable; create a new execution' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER executions_immutable_action BEFORE UPDATE ON access.executions
  FOR EACH ROW EXECUTE FUNCTION access.protect_execution_action();

CREATE FUNCTION access.protect_grant_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['revoked_at','consumed_at','consumed_attempt_id']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['revoked_at','consumed_at','consumed_attempt_id']) THEN
    RAISE EXCEPTION 'grant binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.consumed_at IS NOT NULL AND ROW(NEW.consumed_at, NEW.consumed_attempt_id)
    IS DISTINCT FROM ROW(OLD.consumed_at, OLD.consumed_attempt_id) THEN
    RAISE EXCEPTION 'grant consumption cannot be reset' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'grant revocation cannot be reset' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER grants_immutable_binding BEFORE UPDATE ON access.action_grants
  FOR EACH ROW EXECUTE FUNCTION access.protect_grant_binding();

CREATE FUNCTION access.protect_attempt_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state','resolved_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['state','resolved_at']) THEN
    RAISE EXCEPTION 'attempt start record is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attempts_immutable_binding BEFORE UPDATE ON access.execution_attempts
  FOR EACH ROW EXECUTE FUNCTION access.protect_attempt_binding();

CREATE FUNCTION access.protect_approval_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['revoked_at','revocation_reason']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['revoked_at','revocation_reason']) THEN
    RAISE EXCEPTION 'approval binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at, NEW.revocation_reason)
    IS DISTINCT FROM ROW(OLD.revoked_at, OLD.revocation_reason) THEN
    RAISE EXCEPTION 'approval revocation cannot be reset' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approvals_immutable_binding BEFORE UPDATE ON access.action_approvals
  FOR EACH ROW EXECUTE FUNCTION access.protect_approval_binding();

CREATE FUNCTION access.protect_accepted_artifact() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF OLD.accepted_at IS NOT NULL AND
     (to_jsonb(NEW) - ARRAY['upload_state','retention_until']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['upload_state','retention_until']) THEN
    RAISE EXCEPTION 'accepted artifact identity and scan evidence are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.accepted_at IS NOT NULL AND NEW.upload_state NOT IN ('ACCEPTED','PURGED') THEN
    RAISE EXCEPTION 'accepted artifact cannot return to upload processing' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER raw_artifacts_accepted_immutable BEFORE UPDATE ON access.raw_artifacts
  FOR EACH ROW EXECUTE FUNCTION access.protect_accepted_artifact();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['capability_snapshots','mapping_versions','extractions',
    'extraction_fields','commands','policy_versions','inbox_observations','observation_applications',
    'work_item_resolutions','events','evidence_checkpoints','baseline_observations',
    'verification_sets','confirmed_fields','identity_decisions','session_revocations',
    'manual_preparations','manual_attestations'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON access.%I FOR EACH ROW EXECUTE FUNCTION access.reject_mutation()', table_name);
  END LOOP;
END $$;

-- Application module ownership is enforced in code. These are trusted backend
-- roles, never end-user roles; business authorisation is a core command obligation.
GRANT SELECT ON ALL TABLES IN SCHEMA access TO access_runtime;
GRANT INSERT, UPDATE ON ALL TABLES IN SCHEMA access TO access_api_runtime, access_worker_runtime;
REVOKE INSERT, UPDATE ON access.tenants, access.memberships, access.integrations,
  access.executors, access.capability_snapshots, access.mapping_versions, access.policy_versions
  FROM access_worker_runtime;
REVOKE INSERT ON access.tenants FROM access_api_runtime;
-- SELECT FOR UPDATE needs UPDATE privilege on at least one column. A worker
-- receives only this column privilege on the tenant authority guard.
GRANT UPDATE(authority_epoch) ON access.tenants TO access_worker_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA authz FROM PUBLIC, access_runtime, access_api_runtime, access_worker_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA access FROM PUBLIC;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA access, authz FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA access, authz FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA access, authz FROM %I', r);
    END IF;
  END LOOP;
END $$;

COMMIT;
