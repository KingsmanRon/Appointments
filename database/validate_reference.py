"""Smoke checks for reference DDL in a disposable local PostgreSQL database.

Uses real LOGIN sessions, never SET ROLE to simulate tenant isolation.
No hosted database or patient data is accepted. The schema must already be loaded.
This checks storage constraints, not the application acceptance suite.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import uuid
from datetime import datetime, timezone

parser = argparse.ArgumentParser()
parser.add_argument('--port', required=True, type=int)
parser.add_argument('--database', required=True)
parser.add_argument('--user', default='access_provisioner')
parser.add_argument('--report', default='database/validation_result.json')
args = parser.parse_args()
if not args.database.startswith('access_') or args.database == 'postgres':
    raise SystemExit('Use a disposable local database named access_... with schema.sql loaded.')
psql = shutil.which('psql')
if not psql:
    raise SystemExit('psql must be available on PATH.')
started = datetime.now(timezone.utc).isoformat()
checks = []

def query(sql, user=None):
    return subprocess.run(
        [psql, '-h', '127.0.0.1', '-p', str(args.port), '-U', user or args.user,
         '-d', args.database, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'],
        input='\\set VERBOSITY sqlstate\n' + sql,
        text=True, capture_output=True, encoding='utf-8')

def check(name, sql, user=None, result=None, error=None):
    response = query(sql, user)
    output = response.stdout.strip()
    passed = ((response.returncode == 0 and (result is None or output == result))
              if error is None else (response.returncode != 0 and error in response.stderr))
    checks.append({'name': name, 'status': 'PASS' if passed else 'FAIL',
                   'expected_sqlstate': error, 'output': output,
                   'error': response.stderr.strip()})
    if not passed:
        raise AssertionError(name + ': ' + str(checks[-1]))
    return output

ids = {k: str(uuid.uuid4()) for k in [
    'a','b','user_a','user_b','patient_a','patient_b','ref_a','ref_b','integration',
    'capability','mapping','verifications','decision','execution','executor',
    'policy','rule_set','case_a','case_b','interaction','outcome','approval','session',
    'grant_a','grant_b','attempt','artifact','work','prep','command']}
v = ids
suffix = uuid.uuid4().hex[:8]
role_a, role_b, worker, unmapped = [f'access_check_{suffix}_{x}' for x in ['a','b','worker','unmapped']]
digest = 'a' * 64

try:
    version = check('server_version', 'show server_version;')
    check('all_domain_tables_force_rls', "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='access' AND c.relkind='r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity);", result='0')
    table_count = check('domain_table_count', "SELECT count(*) FROM pg_tables WHERE schemaname='access';")
    fixture = f"""
    CREATE ROLE {role_a} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
    CREATE ROLE {role_b} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
    CREATE ROLE {worker} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
    CREATE ROLE {unmapped} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
    GRANT access_api_runtime TO {role_a}, {role_b}, {unmapped};
    GRANT access_worker_runtime TO {worker};
    INSERT INTO access.tenants(org_id,display_name) VALUES ('{v['a']}','Synthetic A'),('{v['b']}','Synthetic B');
    INSERT INTO authz.database_principals(login_role,org_id,principal_kind) VALUES
      ('{role_a}','{v['a']}','API'),('{role_b}','{v['b']}','API'),('{worker}','{v['a']}','WORKER');
    INSERT INTO access.memberships(org_id,user_id,role) VALUES
      ('{v['a']}','{v['user_a']}','ADMIN'),('{v['b']}','{v['user_b']}','ADMIN');
    INSERT INTO access.patients(org_id,patient_id) VALUES ('{v['a']}','{v['patient_a']}'),('{v['b']}','{v['patient_b']}');
    INSERT INTO access.access_rule_sets(org_id,rule_set_id,version,status,definition,definition_hash,published_by,published_at)
      VALUES ('{v['a']}','{v['rule_set']}','test','PUBLISHED','{{}}','{digest}','{v['user_a']}',clock_timestamp());
    INSERT INTO access.access_cases(org_id,case_id,case_type,source_channel,patient_id,current_rule_set_id) VALUES
      ('{v['a']}','{v['case_a']}','REFERRAL','STAFF_UPLOAD','{v['patient_a']}','{v['rule_set']}'),
      ('{v['b']}','{v['case_b']}','REFERRAL','STAFF_UPLOAD','{v['patient_b']}',NULL);
    INSERT INTO access.referrals(org_id,referral_id,case_id,patient_id) VALUES
      ('{v['a']}','{v['ref_a']}','{v['case_a']}','{v['patient_a']}'),
      ('{v['b']}','{v['ref_b']}','{v['case_b']}','{v['patient_b']}');
    INSERT INTO access.integrations(org_id,integration_id,connector_kind,environment,destination_key)
      VALUES ('{v['a']}','{v['integration']}','MOCK','TEST','synthetic_account');
    INSERT INTO access.capability_snapshots(org_id,capability_id,integration_id,version,manifest,manifest_hash)
      VALUES ('{v['a']}','{v['capability']}','{v['integration']}','test','{{}}','{digest}');
    INSERT INTO access.mapping_versions(org_id,mapping_id,integration_id,version,definition,definition_hash)
      VALUES ('{v['a']}','{v['mapping']}','{v['integration']}','test','{{}}','{digest}');
    INSERT INTO access.verification_sets(org_id,verification_set_id,referral_id,source_version,canonical_payload_hash,verified_by)
      VALUES ('{v['a']}','{v['verifications']}','{v['ref_a']}',1,'{digest}','{v['user_a']}');
    INSERT INTO access.identity_decisions(org_id,identity_decision_id,referral_id,verification_set_id,integration_id,decision,decided_by,evidence)
      VALUES ('{v['a']}','{v['decision']}','{v['ref_a']}','{v['verifications']}','{v['integration']}','PROPOSE_CREATE','{v['user_a']}','{{}}');
    INSERT INTO access.executions(org_id,execution_id,case_id,referral_id,verification_set_id,identity_decision_id,integration_id,capability_id,mapping_id,operation,action_schema_version,final_action,request_body,request_body_sha256,request_body_length_bytes,action_hash,idempotency_key,sequence_number,created_by)
      VALUES ('{v['a']}','{v['execution']}','{v['case_a']}','{v['ref_a']}','{v['verifications']}','{v['decision']}','{v['integration']}','{v['capability']}','{v['mapping']}','patient.create','test','{{}}',decode('7b7d','hex'),'{digest}',2,'{digest}','{v['execution']}',1,'{v['user_a']}');
    INSERT INTO access.executors(org_id,executor_id,integration_id,authenticated_subject,credential_version)
      VALUES ('{v['a']}','{v['executor']}','{v['integration']}','synthetic_connector','test');
    INSERT INTO access.policy_versions(org_id,policy_version_id,version,definition,definition_hash,published_by)
      VALUES ('{v['a']}','{v['policy']}','test','{{}}','{digest}','{v['user_a']}');
    INSERT INTO access.action_approvals(org_id,approval_id,execution_id,action_hash,approved_by,approval_session_id,expires_at)
      VALUES ('{v['a']}','{v['approval']}','{v['execution']}','{digest}','{v['user_a']}','{v['session']}',clock_timestamp()+interval '30 minutes');
    INSERT INTO access.action_grants(org_id,grant_id,token_digest,execution_id,integration_id,executor_id,approval_id,policy_version_id,authority_epoch,action_hash,authorised_user_id,expires_at)
      VALUES ('{v['a']}','{v['grant_a']}','{'1'*64}','{v['execution']}','{v['integration']}','{v['executor']}','{v['approval']}','{v['policy']}',1,'{digest}','{v['user_a']}',clock_timestamp()+interval '60 seconds'),
      ('{v['a']}','{v['grant_b']}','{'2'*64}','{v['execution']}','{v['integration']}','{v['executor']}','{v['approval']}','{v['policy']}',1,'{digest}','{v['user_a']}',clock_timestamp()+interval '60 seconds');
    INSERT INTO access.raw_artifacts(org_id,artifact_id,source,object_path,expected_mime,expected_max_bytes,reserved_until,retention_until)
      VALUES ('{v['a']}','{v['artifact']}','SYNTHETIC','{v['a']}/test.pdf','application/pdf',100,clock_timestamp()+interval '30 minutes',clock_timestamp()+interval '7 days');
    INSERT INTO access.work_items(org_id,work_item_id,case_id,referral_id,kind)
      VALUES ('{v['a']}','{v['work']}','{v['case_a']}','{v['ref_a']}','SAFE_MANUAL_COMMIT');
    INSERT INTO access.commands(org_id,command_id,caller_subject,route_family,dedupe_key,command_type,request_hash,result)
      VALUES ('{v['a']}','{v['command']}','synthetic','fixture','test','test','{digest}','{{}}');
    """
    check('create_synthetic_fixtures', fixture)
    check('real_login_identity', 'select session_user;', role_a, role_a)
    check('tenant_a_isolation', 'select org_id from access.tenants;', role_a, v['a'])
    check('tenant_b_isolation', 'select org_id from access.tenants;', role_b, v['b'])
    check('unmapped_identity_fails_closed', 'select count(*) from access.tenants;', unmapped, '0')
    check('tenant_setting_cannot_override_login', f"BEGIN; SET LOCAL app.current_org_id = '{v['b']}'; select authz.current_org_id(); ROLLBACK;", role_a, v['a'])
    check('cross_tenant_role_denied', f'SET ROLE {role_b};', role_a, error='42501')
    check('principal_map_read_denied', 'select * from authz.database_principals;', role_a, error='42501')
    check('principal_map_write_denied', f"UPDATE authz.database_principals SET org_id='{v['b']}' WHERE login_role='{role_a}';", role_a, error='42501')
    check('cross_tenant_insert_denied', f"INSERT INTO access.patients(org_id) VALUES ('{v['b']}');", role_a, error='42501')
    check('cross_tenant_fk_denied', f"UPDATE access.referrals SET patient_id='{v['patient_b']}' WHERE referral_id='{v['ref_a']}';", role_a, error='23503')
    check('delete_denied', 'DELETE FROM access.patients;', role_a, error='42501')
    check('worker_cannot_change_memberships', 'UPDATE access.memberships SET role=\'AUDITOR\';', worker, error='42501')
    check('worker_can_lock_authority_guard', f"BEGIN; SELECT org_id FROM access.tenants WHERE org_id='{v['a']}' FOR UPDATE; ROLLBACK;", worker, v['a'])
    check('execution_body_is_immutable', f"UPDATE access.executions SET request_body=decode('5b5d','hex') WHERE execution_id='{v['execution']}';", role_a, error='55000')
    check('approval_is_immutable', f"UPDATE access.action_approvals SET action_hash='{'b'*64}' WHERE approval_id='{v['approval']}';", role_a, error='55000')
    check('command_receipt_is_immutable', "UPDATE access.commands SET result='{\"changed\":true}';", role_a, error='55000')
    check('invalid_referral_state_denied', "UPDATE access.referrals SET state='COMPLETED';", role_a, error='23514')
    check('destination_commit_is_nonterminal', f"UPDATE access.referrals SET state='COMMITTED' WHERE referral_id='{v['ref_a']}'; SELECT completed_at IS NULL FROM access.referrals WHERE referral_id='{v['ref_a']}';", role_a, 't')
    check('case_interaction_storage', f"INSERT INTO access.access_interactions(org_id,interaction_id,case_id,channel,direction,actor_kind,intent,identity_verification_level,content_reference,occurred_at) VALUES ('{v['a']}','{v['interaction']}','{v['case_a']}','INTERNAL','INTERNAL','STAFF','REFERRAL_REVIEW','VERIFIED','{{}}',clock_timestamp());", role_a)
    check('booking_outcome_storage', f"INSERT INTO access.case_outcomes(org_id,outcome_id,case_id,outcome_type,source_type,measurement_kind,external_reference,evidence,observed_at,recorded_by) VALUES ('{v['a']}','{v['outcome']}','{v['case_a']}','APPOINTMENT_BOOKED','HUMAN','OBSERVED','synthetic-booking','{{}}',clock_timestamp(),'{v['user_a']}');", role_a)
    check('booking_outcome_immutable', "UPDATE access.case_outcomes SET outcome_type='UNKNOWN_STATUS';", role_a, error='55000')
    check('upload_job_without_referral_supported', f"INSERT INTO access.outbox(org_id,artifact_id,effect_type,lane,dedupe_key,sequence_number,payload) VALUES ('{v['a']}','{v['artifact']}','VERIFY_UPLOAD','LOCAL','upload_test',1,'{{}}');", role_a)
    check('write_job_without_execution_denied', f"INSERT INTO access.outbox(org_id,case_id,referral_id,effect_type,lane,dedupe_key,sequence_number,payload) VALUES ('{v['a']}','{v['case_a']}','{v['ref_a']}','DISPATCH_EXECUTION','WRITE','bad_write',1,'{{}}');", role_a, error='23514')
    check('recovery_lane_enforced', f"INSERT INTO access.outbox(org_id,case_id,referral_id,execution_id,effect_type,lane,dedupe_key,sequence_number,payload) VALUES ('{v['a']}','{v['case_a']}','{v['ref_a']}','{v['execution']}','RECONCILE_EXECUTION','WRITE','bad_recovery',2,'{{}}');", role_a, error='23514')
    attempt = f"""INSERT INTO access.execution_attempts(org_id,attempt_id,execution_id,executor_id,grant_id,attempt_number,state,start_request_id,invocation_owner,dispatch_by,request_deadline_at)
      VALUES ('{v['a']}','{v['attempt']}','{v['execution']}','{v['executor']}','{v['grant_a']}',1,'STARTED',gen_random_uuid(),'live_test',clock_timestamp()+interval '5 seconds',clock_timestamp()+interval '30 seconds');"""
    check('wrong_grant_consumption_rejected', 'BEGIN;' + attempt + f"UPDATE access.action_grants SET consumed_at=clock_timestamp(),consumed_attempt_id='{v['attempt']}' WHERE grant_id='{v['grant_b']}'; COMMIT;", role_a, error='23503')
    check('failed_transaction_rolled_back_attempt', 'SELECT count(*) FROM access.execution_attempts;', role_a, '0')
    check('correct_grant_consumption_supported', 'BEGIN;' + attempt + f"UPDATE access.action_grants SET consumed_at=clock_timestamp(),consumed_attempt_id='{v['attempt']}' WHERE grant_id='{v['grant_a']}'; COMMIT;", role_a)
    check('consumption_cannot_reset', f"UPDATE access.action_grants SET consumed_at=NULL,consumed_attempt_id=NULL WHERE grant_id='{v['grant_a']}';", role_a, error='55000')
    check('second_started_attempt_denied', f"""INSERT INTO access.execution_attempts(org_id,execution_id,executor_id,grant_id,attempt_number,state,start_request_id,invocation_owner,dispatch_by,request_deadline_at,retry_basis,retry_evidence)
      VALUES ('{v['a']}','{v['execution']}','{v['executor']}','{v['grant_b']}',2,'STARTED',gen_random_uuid(),'second',clock_timestamp()+interval '5 seconds',clock_timestamp()+interval '30 seconds','DESTINATION_IDEMPOTENCY','{{}}');""", role_a, error='23505')
    check('manual_plan_storage_supported', f"""INSERT INTO access.manual_preparations(org_id,preparation_id,referral_id,work_item_id,integration_id,verification_set_id,identity_decision_id,prepared_action,prepared_action_hash,safety_basis,safety_evidence,approved_by,approval_session_id,expires_at)
      VALUES ('{v['a']}','{v['prep']}','{v['ref_a']}','{v['work']}','{v['integration']}','{v['verifications']}','{v['decision']}','{{}}','{digest}','NEVER_STARTED','{{}}','{v['user_a']}','{v['session']}',clock_timestamp()+interval '30 minutes');""", role_a)
    check('manual_plan_immutable', "UPDATE access.manual_preparations SET prepared_action='{\"changed\":true}';", role_a, error='55000')
    check('unknown_effort_not_zero', f"INSERT INTO access.effort_sessions(org_id,case_id,referral_id,user_id,activity,measurement_kind,duration_seconds,method) VALUES ('{v['a']}','{v['case_a']}','{v['ref_a']}','{v['user_a']}','REVIEW','UNKNOWN',0,'test');", role_a, error='23514')
    check('session_revocation_storage', f"INSERT INTO access.session_revocations(org_id,user_id,session_id,reason_code) VALUES ('{v['a']}','{v['user_a']}','{v['session']}','staff_sign_out');", role_a)
    check('session_revocation_immutable', 'UPDATE access.session_revocations SET revoked_at=clock_timestamp();', role_a, error='55000')
    check('accepted_artifact_requires_scan_result', f"UPDATE access.raw_artifacts SET upload_state='ACCEPTED',content_hash='{digest}',actual_bytes=50,accepted_at=clock_timestamp(),accepted_bucket_name='access-accepted',accepted_object_path='{v['a']}/accepted.pdf',scanner_name='synthetic',scanner_version='1',scanner_definition_version='1',scanned_at=clock_timestamp(),detected_mime='application/pdf' WHERE artifact_id='{v['artifact']}';", role_a, error='23514')
    check('accepted_artifact_supported', f"UPDATE access.raw_artifacts SET upload_state='ACCEPTED',content_hash='{digest}',actual_bytes=50,accepted_at=clock_timestamp(),accepted_bucket_name='access-accepted',accepted_object_path='{v['a']}/accepted.pdf',scanner_name='synthetic',scanner_version='1',scanner_definition_version='1',scan_result='CLEAN',scanned_at=clock_timestamp(),detected_mime='application/pdf' WHERE artifact_id='{v['artifact']}';", role_a)
    check('accepted_artifact_hash_immutable', f"UPDATE access.raw_artifacts SET content_hash='{'b'*64}' WHERE artifact_id='{v['artifact']}';", role_a, error='55000')
finally:
    report = {'started_at': started, 'finished_at': datetime.now(timezone.utc).isoformat(),
              'scope': 'local reference DDL and storage security smoke checks; application acceptance not run',
              'host': '127.0.0.1', 'port': args.port, 'database': args.database,
              'postgresql_version': locals().get('version'), 'domain_tables': locals().get('table_count'),
              'schema_sha256': hashlib.sha256(Path('database/schema.sql').read_bytes()).hexdigest(),
              'passed': sum(c['status'] == 'PASS' for c in checks),
              'failed': sum(c['status'] == 'FAIL' for c in checks), 'checks': checks}
    Path(args.report).write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({k:report[k] for k in ['passed','failed','domain_tables','schema_sha256']}))
