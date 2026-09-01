begin;
set local role postgres;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

select ok((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
 where oid in ('public.bot_telegram_connections'::regclass,'public.bot_telegram_pairings'::regclass,
 'public.bot_telegram_inbox'::regclass,'public.bot_telegram_outbox'::regclass)), 'all Telegram records force RLS');
select ok(not has_table_privilege('authenticated', 'public.bot_telegram_connections', 'select'), 'members cannot read host transport metadata directly');
select ok(not has_table_privilege('anon', 'public.bot_telegram_inbox', 'select'), 'anonymous callers cannot read encrypted inbox');
select ok(not has_table_privilege('authenticated', 'public.bot_telegram_pairings', 'insert'), 'clients cannot forge pairings');
select ok(not has_table_privilege('authenticated', 'public.bot_telegram_outbox', 'update'), 'clients cannot redirect deliveries');
select ok(not has_function_privilege('authenticated','public.devryan_bot_telegram_confirm(uuid,uuid,uuid,uuid)','execute'), 'pairing confirmation is service-only');
select ok(not has_function_privilege('anon','public.devryan_bot_telegram_ingest(uuid,uuid,uuid,jsonb)','execute'), 'anonymous ingress cannot advance offsets');
select ok(has_table_privilege('service_role','public.bot_telegram_outbox','insert'), 'service role can enqueue deliveries');
select col_type_is('public','bot_telegram_inbox','request_kind','text','inbox scheduling kind is persisted metadata');
select col_type_is('public','bot_telegram_inbox','cancel_requested_at','timestamp with time zone','exact request cancellation intent survives restart');
select has_index('public','bot_telegram_inbox','bot_telegram_inbox_lane_idx','work lanes have a bounded active-row index');
select has_trigger('public','bot_telegram_inbox','bot_telegram_inbox_growth_quota','payload growth cannot bypass byte reservations');
select ok(not has_function_privilege('authenticated','public.devryan_bot_telegram_inbox_growth_quota()','execute'),'inbox growth accounting is service-only');

insert into auth.users(id,email) values ('a4000000-0000-4000-8000-000000000001','telegram-fixture@example.com');
insert into public.user_profiles(id,email,display_name,role) values ('a4000000-0000-4000-8000-000000000001','telegram-fixture@example.com','Telegram Test','admin');
insert into public.bots(id,name,title,tenancy,created_by) values ('b4000000-0000-4000-8000-000000000001','Telegram Bot','Telegram Bot','team','a4000000-0000-4000-8000-000000000001');
insert into public.bot_memberships(bot_id,user_id,role,assigned_by) values ('b4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000001','manager','a4000000-0000-4000-8000-000000000001');
insert into public.bot_channels(id,bot_id,owner_user_id) values ('c4000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000001');

set local role service_role;
insert into public.bot_telegram_connections(bot_id,generation,telegram_bot_id,username,credential_id)
 values ('b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','123456','example_bot','e4000000-0000-4000-8000-000000000001');
select is((select enabled from public.bot_telegram_connections where bot_id='b4000000-0000-4000-8000-000000000001'), false, 'Telegram is disabled by default');
select is(public.devryan_bot_telegram_lease('b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000002'),false,'disabled connections cannot poll');
update public.bot_telegram_connections set enabled=true where bot_id='b4000000-0000-4000-8000-000000000001';
select is(public.devryan_bot_telegram_lease('b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000002'),true,'first fenced owner acquires polling');
select is(public.devryan_bot_telegram_lease('b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000003'),false,'competing owner cannot take over a live lease');
select is(public.devryan_bot_telegram_ingest('b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000003','[]'),false,'stale owner cannot commit offsets');

insert into public.bot_telegram_pairings(id,bot_id,generation,user_id,channel_id,state,telegram_user_id,chat_id,expires_at)
values ('f4000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001','claimed','123','123',now()+interval '10 minutes');
select is(public.devryan_bot_telegram_confirm('b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000002'),false,'different DevRyan member cannot claim the candidate');
select is(public.devryan_bot_telegram_confirm('b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000001'),true,'intended active member confirms one private identity');
select is(public.devryan_bot_telegram_confirm('b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000001'),false,'confirmation is single-use');

select is(public.devryan_bot_telegram_ingest('b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000002',
 '[{"id":"f4000000-0000-4000-8000-000000000010","update_id":10,"message_id":"f4000000-0000-4000-8000-000000000011","pairing_id":"f4000000-0000-4000-8000-000000000001","user_id":"a4000000-0000-4000-8000-000000000001","channel_id":"c4000000-0000-4000-8000-000000000001","state":"received","request_kind":"voice","payload_envelope":{"ciphertext":"encrypted"}}]'),true,'authorized inbox row commits atomically');
select is((select update_offset from public.bot_telegram_connections where bot_id='b4000000-0000-4000-8000-000000000001'),11::bigint,'only persisted ingress advances acknowledgment');
select is((select request_kind from public.bot_telegram_inbox where id='f4000000-0000-4000-8000-000000000010'),'voice','ingest persists the server-classified scheduling lane');
update public.bot_telegram_inbox set cancel_requested_at=now() where id='f4000000-0000-4000-8000-000000000010';
select is(public.devryan_bot_telegram_ingest('b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000002',
 '[{"id":"f4000000-0000-4000-8000-000000000010","update_id":10,"message_id":"f4000000-0000-4000-8000-000000000011","state":"rejected","payload_envelope":{}}]'),true,'duplicate Telegram update is harmless');
select is((select count(*) from public.bot_telegram_inbox where bot_id='b4000000-0000-4000-8000-000000000001'),1::bigint,'duplicate update does not duplicate admission identity');
select is((select state from public.bot_telegram_inbox where id='f4000000-0000-4000-8000-000000000010'),'received','duplicate input cannot overwrite accepted payload');
select is((select request_kind from public.bot_telegram_inbox where id='f4000000-0000-4000-8000-000000000010'),'voice','duplicate updates cannot move an existing request into another lane');
select ok((select cancel_requested_at is not null from public.bot_telegram_inbox where id='f4000000-0000-4000-8000-000000000010'),'duplicate updates cannot clear cancellation intent');

insert into public.bot_telegram_outbox(id,bot_id,generation,pairing_id,user_id,channel_id,source_key,kind,state,payload_envelope,part_index)
values ('f4000000-0000-4000-8000-000000000030','b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001','run:voice-fixture','voice','synthesis_pending','{"ciphertext":"encrypted"}',1);
update public.bot_telegram_outbox set state='synthesizing' where id='f4000000-0000-4000-8000-000000000030' and state='synthesis_pending';
update public.bot_telegram_outbox set state='pending' where id='f4000000-0000-4000-8000-000000000030' and state='synthesizing';
update public.bot_telegram_outbox set state='sending' where id='f4000000-0000-4000-8000-000000000030' and state='pending' and part_index=0;
select is((select state from public.bot_telegram_outbox where id='f4000000-0000-4000-8000-000000000030'),'pending','stale text part progress cannot claim the later voice part');
select is((select part_index from public.bot_telegram_outbox where id='f4000000-0000-4000-8000-000000000030'),1,'separate synthesis preserves successful text progress');

-- Atomic capacity contracts: ordinary backlog cannot consume the command reserve.
insert into public.bot_telegram_inbox(id,bot_id,generation,update_id,pairing_id,user_id,channel_id,message_id,state,request_kind,payload_envelope)
select md5('telegram-normal-'||n::text)::uuid,'b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001',100+n,
 'f4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001',md5('telegram-normal-message-'||n::text)::uuid,'ready','message','{}'::jsonb
from generate_series(1,999) n;
select is(public.devryan_bot_telegram_ingest('b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000002',
 '[{"id":"f4000000-0000-4000-8000-000000001200","update_id":1200,"message_id":"e4000000-0000-4000-8000-000000001200","pairing_id":"f4000000-0000-4000-8000-000000000001","user_id":"a4000000-0000-4000-8000-000000000001","channel_id":"c4000000-0000-4000-8000-000000000001","state":"received","request_kind":"message","payload_envelope":{"ciphertext":"original-prompt"},"rejection_envelope":{"ciphertext":"identity-only"}},
 {"id":"f4000000-0000-4000-8000-000000001201","update_id":1201,"message_id":"e4000000-0000-4000-8000-000000001201","pairing_id":"f4000000-0000-4000-8000-000000000001","user_id":"a4000000-0000-4000-8000-000000000001","channel_id":"c4000000-0000-4000-8000-000000000001","state":"received","request_kind":"command","payload_envelope":{"ciphertext":"cancel"}}]'),true,'full normal queue still commits a control command and an explicit rejected outcome');
select is((select state from public.bot_telegram_inbox where update_id=1200),'quota_rejected','full normal queue never admits new work');
select is((select payload_envelope->>'ciphertext' from public.bot_telegram_inbox where update_id=1200),'identity-only','quota outcomes do not retain rejected prompt payloads');
select is((select state from public.bot_telegram_inbox where update_id=1201),'received','authenticated commands retain independent capacity');
select is((select update_offset from public.bot_telegram_connections where bot_id='b4000000-0000-4000-8000-000000000001'),1202::bigint,'both outcomes persist before acknowledging the batch');
insert into public.bot_telegram_inbox(id,bot_id,generation,update_id,pairing_id,user_id,channel_id,message_id,state,request_kind,payload_envelope)
select md5('telegram-control-'||n::text)::uuid,'b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001',1300+n,
 'f4000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001',md5('telegram-control-message-'||n::text)::uuid,'ready','command','{}'::jsonb
from generate_series(1,99) n;
select throws_ok($$update public.bot_telegram_inbox set payload_envelope=jsonb_build_object('ciphertext',repeat('x',190000))
 where id in (select id from public.bot_telegram_inbox where request_kind='command' limit 24)$$,
 'P0001','telegram_control_limit','growth after insertion still enforces the reserved control byte limit');
select is(public.devryan_bot_telegram_ingest('b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000002',
 '[{"id":"f4000000-0000-4000-8000-000000001400","update_id":1400,"message_id":"e4000000-0000-4000-8000-000000001400","pairing_id":"f4000000-0000-4000-8000-000000000001","user_id":"a4000000-0000-4000-8000-000000000001","channel_id":"c4000000-0000-4000-8000-000000000001","state":"received","request_kind":"command","payload_envelope":{}},
 {"id":"f4000000-0000-4000-8000-000000001401","update_id":1401,"message_id":"e4000000-0000-4000-8000-000000001401","state":"received","request_kind":"command","payload_envelope":{}}]'),true,'command flooding is bounded without weakening authentication');
select is((select error_code from public.bot_telegram_inbox where update_id=1400),'telegram_control_limit','the reserved control pool is itself bounded');
select is((select error_code from public.bot_telegram_inbox where update_id=1401),'telegram_access_revoked','anonymous commands cannot use reserved capacity');
insert into public.bot_telegram_inbox(id,bot_id,generation,update_id,message_id,state,payload_envelope)
select md5('telegram-terminal-'||n::text)::uuid,'b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001',10000+n,
 md5('telegram-terminal-message-'||n::text)::uuid,'rejected','{}'::jsonb from generate_series(1,3900) n;
select is(public.devryan_bot_telegram_ingest('b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000002',
 '[{"id":"f4000000-0000-4000-8000-000000001402","update_id":1402,"message_id":"e4000000-0000-4000-8000-000000001402","state":"rejected","payload_envelope":{}}]'),true,'terminal retention pressure still allows a new durable outcome');
select ok((select count(*)<=5000 from public.bot_telegram_inbox where bot_id='b4000000-0000-4000-8000-000000000001'),'inbox count retention is bounded');
select is((select count(*) from public.bot_telegram_inbox where state not in ('settled','rejected','quota_rejected')),1100::bigint,'retention never deletes normal or reserved active work');
delete from public.bot_telegram_inbox where id='f4000000-0000-4000-8000-000000001402';
select is(public.devryan_bot_telegram_ingest('b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000002',
 '[{"id":"f4000000-0000-4000-8000-000000001402","update_id":1402,"message_id":"e4000000-0000-4000-8000-000000001402","state":"rejected","payload_envelope":{}}]'),true,'replayed acknowledged updates remain harmless after terminal retention');
select is((select count(*) from public.bot_telegram_inbox where id='f4000000-0000-4000-8000-000000001402'),0::bigint,'an acknowledged pruned update is never resurrected');

set local role postgres;
insert into auth.users(id,email) values ('a4000000-0000-4000-8000-000000000002','telegram-admin@example.com');
insert into public.user_profiles(id,email,display_name,role)
values ('a4000000-0000-4000-8000-000000000002','telegram-admin@example.com','Telegram Admin','admin');
update public.user_profiles set status='suspended' where id='a4000000-0000-4000-8000-000000000001';
set local role service_role;
select is(public.devryan_bot_telegram_ingest('b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000002',
 '[{"id":"f4000000-0000-4000-8000-000000000020","update_id":2000,"message_id":"f4000000-0000-4000-8000-000000000021","pairing_id":"f4000000-0000-4000-8000-000000000001","user_id":"a4000000-0000-4000-8000-000000000001","channel_id":"c4000000-0000-4000-8000-000000000001","state":"received","payload_envelope":{"ciphertext":"encrypted"}}]'),true,'suspended sender is durably rejected instead of wedging polling');
select is((select state from public.bot_telegram_inbox where id='f4000000-0000-4000-8000-000000000020'),'rejected','database revalidates live membership at ingress');
update public.bot_telegram_connections set generation='d4000000-0000-4000-8000-000000000002' where bot_id='b4000000-0000-4000-8000-000000000001';
select is(public.devryan_bot_telegram_ingest('b4000000-0000-4000-8000-000000000001','d4000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000002','[]'),false,'old connection generation cannot acknowledge or admit');
select public.devryan_bot_telegram_prune();
select is((select error_code from public.bot_telegram_inbox where id='f4000000-0000-4000-8000-000000000010'),'telegram_connection_changed','old generations become non-executable');
delete from public.bot_telegram_connections where bot_id='b4000000-0000-4000-8000-000000000001';
select is((select count(*) from public.bot_telegram_pairings where bot_id='b4000000-0000-4000-8000-000000000001'),0::bigint,'transport deletion cascades linked identities');
select is((select count(*) from public.bot_telegram_inbox where bot_id='b4000000-0000-4000-8000-000000000001'),0::bigint,'transport deletion cascades encrypted inbox');
select is((select count(*) from public.bot_telegram_outbox where bot_id='b4000000-0000-4000-8000-000000000001'),0::bigint,'transport deletion cascades encrypted optional speech');
select * from finish();
rollback;
