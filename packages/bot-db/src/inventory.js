// Reviewed local Bot database inventory.
//
// Every file in supabase/migrations is classified explicitly. Supporting and
// Bot migrations replay byte-for-byte; excluded files belong to the shared-host
// control plane and never run locally. Local additions follow the migrations
// they depend on. The ordered inventory is append-only: a database is current
// only when its recorded history equals this list exactly, so an entry must
// never be reordered, edited or removed once released.

export const BOT_DB_INVENTORY_FORMAT = 1;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SUPABASE_FILENAME_PATTERN = /^(\d{14})_[a-z0-9_]+\.sql$/;
const LOCAL_FILENAME_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
const KINDS = new Set(['supporting', 'bot', 'excluded']);

const entry = (filename, kind, sha256) => {
  const match = SUPABASE_FILENAME_PATTERN.exec(filename);
  if (!match || !KINDS.has(kind) || !SHA256_PATTERN.test(sha256)) {
    throw new TypeError(`Invalid Supabase migration inventory entry: ${filename}`);
  }
  return Object.freeze({
    name: `supabase:${filename.slice(0, -'.sql'.length)}`,
    source: 'supabase',
    version: match[1],
    filename,
    kind,
    sha256,
  });
};

const local = (filename, sha256) => {
  const match = LOCAL_FILENAME_PATTERN.exec(filename);
  if (!match || !SHA256_PATTERN.test(sha256)) {
    throw new TypeError(`Invalid local migration inventory entry: ${filename}`);
  }
  return Object.freeze({
    name: `local:${filename.slice(0, -'.sql'.length)}`,
    source: 'local',
    version: match[1],
    filename,
    kind: 'local',
    sha256,
  });
};

// Every hosted migration, in file order, with its reviewed classification.
export const SUPABASE_MIGRATION_INVENTORY = Object.freeze([
  entry("20260802195944_devryan_multi_user.sql", "supporting", "ed537f06b60a8254a02fac1754a286bbdf9dcef49d4ea5222f96a48f400f1351"),
  entry("20260803112512_classify_agent_test_users.sql", "supporting", "06bdd1133a2f3c869ef24ec1ae43ba50f45b6d5cfe0d4fa3abce5c7112ef68a1"),
  entry("20260803120000_admin_default_branch_root.sql", "excluded", "6d491ba11965e01aa82327919bd04a560da5703c9c92e2228a0a154cc0b8ee6d"),
  entry("20260803150000_settings_permission_matrix.sql", "excluded", "28aa8736f709f5d94ecd77ea293ca1306f72dbcd0271c5400204e2a628e61bcf"),
  entry("20260804090000_managed_project_metadata.sql", "excluded", "4b745581f9a53e62164f8f25797caaaa6fb16b1469c864a565a2178bdb3aca5e"),
  entry("20260804090001_admin_all_branches_root.sql", "excluded", "04c9818657ef68863291f26b8504914ffd2977d562a06d99000572c2ea09fe49"),
  entry("20260804100000_user_profile_github_account.sql", "excluded", "3b99448e0a42b493d8e2047331e9c5d6e04f5dd2226fda72059cdb6e86ae819e"),
  entry("20260804110000_real_worktree_visibility_grants.sql", "excluded", "f0e9063fd661d179a3d63828a9dde8c1bcbbacbbee8238b2e8bba0ad14b76807"),
  entry("20260804120000_github_account_reassignment.sql", "excluded", "c34a4767d43974c5c28141d60f4ae550bc25bb3b077140e9bd4d6b25fa032d5c"),
  entry("20260805090000_user_analytics_activity_index.sql", "excluded", "4e424bb349c4377369711d91058a9c4828e79a3b21198275c227c1211de9b727"),
  entry("20260805120000_user_policy_feature_overrides.sql", "excluded", "fba35ab2dba27e2af482b99fe5972de34dd22b52ec982a5e16ee2566fd569d73"),
  entry("20260806133832_add_browser_policy_capability.sql", "excluded", "4a8deb1f76fe69a3d4cc4c4f0f2086e05a93b2a76dfbaa0777e7278b792163ea"),
  entry("20260807100000_indefinite_user_analytics_retention.sql", "excluded", "4412e3d62d69d58ae765e2f70d0b258ba9119304693ec919b8486e50cebc2fcb"),
  entry("20260809190612_bug_reports.sql", "excluded", "26453d845d4825d3eef915a94e1a1ad878488cfb9cd3baa8eb8b2cdcdafb3cfb"),
  entry("20260810120000_clipboard_analytics_text.sql", "excluded", "ef98a341d91e4d69576c2b46d0576b49d605903a65b35e39aed7e2d9ccfa7218"),
  entry("20260810130000_managed_error_diagnostics.sql", "excluded", "6d8c2f8ac34a9da26182dc964d4ec03952692b8b1751590078206f98d5c89fbd"),
  entry("20260810182541_clear_managed_error_diagnostics.sql", "excluded", "d111451a4d78dad9d17d435ee9c4f413aec2c06d63a3d95bd5502a89111a8e90"),
  entry("20260812120000_client_error_diagnostics.sql", "excluded", "74422ca32b49ec641daca294e0d95b0896ff27182a75318bc387abe636bb5772"),
  entry("20260815141850_add_diagnostic_disposition.sql", "excluded", "e83e2eeeebe37701fa2cf7cab5f5cb04c0dbfc3073d14bce3d4b9dbaafd3daed"),
  entry("20260816120000_refine_error_diagnostic_classification.sql", "excluded", "8a1e53cd721a5514dbc0c97a7028cc63299c3b8b640c3d0577ecc3a64c35b610"),
  entry("20260818120000_refine_error_diagnostic_false_positives.sql", "excluded", "5ca71a34279e12337e6698a405755bc0e1c28b4272fcc7c0ac66c9befb4b651b"),
  entry("20260819113809_reset_managed_account_model_defaults.sql", "excluded", "dc70929541f0f2c148a4148b669b095660e0c9d7fc2f11ce77c257ee2401c558"),
  entry("20260822120000_production_bots.sql", "bot", "6856d46adcec8244db8bfab224a1d0271d6d55b1e339cd0ab2d52662e8c1efa9"),
  entry("20260823100000_bot_recovery_purge.sql", "bot", "9a88642e497616e17fb169d112ce05a24208d268de4ae21d0a6ffdd205e369eb"),
  entry("20260823150227_bot_capability_bindings.sql", "bot", "e5d5cc085c6af74072c6f526eb316eb57550175d06b37a81e5b695e08d97cd01"),
  entry("20260823202400_bot_profiles_and_publish.sql", "bot", "65f4459735aeb8a62fde8c40a3c79f807e98aa9c33cec68ac62268d838f173d7"),
  entry("20260824030000_bot_message_admission_timestamps.sql", "bot", "9e51c242d10bf6e22cbeb70118a42335474e9a59fed0641797bc245b69dc6968"),
  entry("20260824033000_bot_admission_schema_marker.sql", "bot", "f9a6c48082f2ace0aee287c2d7a81ad404777554d81c1e8ca584f78670e4f5a4"),
  entry("20260824040000_bot_revision_history.sql", "bot", "f50d48a48e40bb4486e33fb21d568da9330ad2a95062ae9147712e38cbc9978a"),
  entry("20260824120000_bots_shared_memory_team_tenancy.sql", "bot", "17a31b1d69022ffb9a88cec405a00c3e5b9e485f5663fe991174ab9417876d38"),
  entry("20260824213000_bot_complete_delete.sql", "bot", "aeba454c968e7879de3941a64376b07e76702204b650414151c2275d34ccb9cc"),
  entry("20260825120000_bot_shared_files.sql", "bot", "eda37add2d6981cd6f1af4ee3b15a227775d3ccbcd8ca91afffe297a23f84c4a"),
  entry("20260825190000_bot_approval_expiry.sql", "bot", "271abd0f1dbf78a7a1ebb2431fb91d2dc6fe7d4b29134891c5a3b811203a779b"),
  entry("20260826120000_bot_chat_latency.sql", "bot", "4167dd2258b8800a9598b0ae69567de5330de45091322f6b9aff4cc63b34be38"),
  entry("20260826130000_bot_two_phase_responses.sql", "bot", "be4275bbd24d4e492ee1e73e988c8dd23fe9803ece792ea688cf0d8033d369ea"),
  entry("20260826140000_bot_environment_secrets.sql", "bot", "55bce074d57d62419ea286dda3925ea56043eb69fa64f937e1e723ddd8a5a289"),
  entry("20260827100000_agent_agnostic_bots_program.sql", "bot", "fb3cd36348ecd69fc1974babc00f22c1a3849f8ed0ee8b2251bcd39c945e7b5d"),
  entry("20260827200000_refine_error_log_remediation.sql", "excluded", "5a4691921a0faccc501b6242c6ad9ddb976e1986b22d0e19db87cb634aed2eab"),
  entry("20260827230926_branch_preview_access.sql", "excluded", "54d7e50e03ed661e9b309da28f4f52405fc6ee5139bcd951259969191595c08f"),
  entry("20260828210316_bot_terminal_error_audit.sql", "bot", "0ebb33f659bdcb3b28e0bd212bf9de636eb6c77f9c03f2dbad19ee0ec3f42a1a"),
  entry("20260829120000_bot_acknowledgment_admission.sql", "bot", "edb8e2517083c344165d240a4bff3669a9c08df05aea86452bf674246c626a88"),
  entry("20260829130000_bot_contextual_acknowledgments.sql", "bot", "bba573ec92f73501a3746e12e7957f1903bffaf5b579bf7d07ff61325669fac4"),
  entry("20260830023917_purge_user_analytics.sql", "excluded", "9d2d5f4b93b2d0bb759b9221e86c5712f3f269532cc7d6ca3d21c18f2335700c"),
  entry("20260830123704_admin_clear_all_user_analytics.sql", "excluded", "937f7816b04e97dd0d8c71db68b1501814239703dc50a3f2e3bc78d03ab00702"),
  entry("20260830150000_bot_waiting_control.sql", "bot", "c53d146ca5218cb5e8973780dd199dcfc6e88c8ff6df6e46156ce8edb5bbdf47"),
  entry("20260830180651_bot_audit_clear.sql", "bot", "7d3c9267a22527fea9ae8e728c4d6defded6c6822b30cc281f058cd996ef3330"),
  entry("20260830210000_bot_safe_run_retry.sql", "bot", "b31f94b8419cf9f8dfb1ee60ef637a11c6a10b1bfb83a213beedff1137af7e1e"),
  entry("20260831002620_bot_telegram_transport.sql", "bot", "34dcc072f45eb1659578b767230f3e5886aa08bad8a2600deae20ecc6d5882fd"),
  entry("20260901120000_durable_bot_memory_extraction.sql", "bot", "26cca6c10b2dd3d08ea3f7ea643f1fa37df9ab547d7b2dcd0dcdb24e5c75e98a"),
  entry("20260901130000_bot_memory_extraction_conflict_recovery.sql", "bot", "37c2fe9ac13e27f0a3f1405c895249fe6c28b2276c2ce93dbb5664987e5c94be"),
  entry("20260901160000_bot_runtime_scope_and_audit_repair.sql", "bot", "de7793fafeee5c520891dea8147140b3e9a819af5b4ff868fecdfd9b7303197f"),
  entry("20260901230000_bot_memory_extraction_requeue.sql", "bot", "887809e28676ef5cafa0a2d05fb9fd150e844b7bb879adb2938a5518fc154262"),
  entry("20260902120000_bot_audit_resolution_and_read_only_retry.sql", "bot", "1f864e3fcc789d979fbb42563c07960b914ba2c567e7cb7f60f7174abbe4f886"),
  entry("20260903100000_bot_run_failure_stage_audit.sql", "bot", "0a1899ef152effb583bbe2d264d9668bcbeb5d782d551f8765c9d1e2100cd550"),
  entry("20260903110000_bot_memory_extraction_inline_claim.sql", "bot", "6c71eca5ad95cfbcfc29278fbe58cedd52306823fc7c116436a07a4b6b2b99b0"),
  entry("20260908182901_bot_memory_automatic_recovery.sql", "bot", "073f6e789bf3a64c83a1b15603983473b081d574c502abb7a7cf8dbb9cc30f8c"),
]);

export const LOCAL_MIGRATION_INVENTORY = Object.freeze([
  local('0001_local_identity.sql', '4913b0b741424107d033ebe29df1b3ae1db3829fd08e9e62f70e97cc2ebe8c77'),
]);

export const BOT_DB_BOOTSTRAP = Object.freeze({
  cluster: Object.freeze({ filename: 'bootstrap-cluster.sql', sha256: '03f06b16e20572c9a48c102479cb3d9dbc4d2cf6a39a62572c4e2835cb0ef276' }),
  database: Object.freeze({ filename: 'bootstrap-database.sql', sha256: '1d128312d066172bff6ff717b70216f58278ad8e0fb7c430e4029c54cc4e528b' }),
});

// The ordered list applied to a local Bot database. Append-only.
export const BOT_DB_MIGRATIONS = Object.freeze([
  ...SUPABASE_MIGRATION_INVENTORY.filter((migration) => migration.kind !== 'excluded'),
  ...LOCAL_MIGRATION_INVENTORY,
].map((migration, ordinal) => Object.freeze({ ...migration, ordinal })));

export const BOT_DB_SCHEMA_HEAD = BOT_DB_MIGRATIONS[BOT_DB_MIGRATIONS.length - 1].name;

// Hosted Bot schema markers whose exact migration prefix has been reviewed for
// cloud import. A marker identifies a prefix only where a migration rewrites
// it, so only listed markers are accepted as import sources.
export const REVIEWED_SOURCE_SCHEMAS = Object.freeze({
  '20260908182901': 'supabase:20260908182901_bot_memory_automatic_recovery',
});
