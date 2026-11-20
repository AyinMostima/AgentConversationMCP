#include "database.hpp"

#include <iterator>
#include <stdexcept>

namespace acm {

namespace {

[[noreturn]] void throw_sqlite(sqlite3* connection, const char* operation) {
    throw std::runtime_error(std::string("SQLite ") + operation + " failed: " + sqlite3_errmsg(connection));
}

// Ordered, append-only migrations tracked by PRAGMA user_version. Never edit
// or reorder an applied entry; add a new one so existing data migrates forward.
constexpr const char* kMigrations[] = {
    // 001 - projects, logical agents and paired session instances.
    R"sql(
    CREATE TABLE projects (
        project_id  TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        root_path   TEXT,
        created_at  TEXT NOT NULL
    );
    CREATE TABLE agents (
        agent_id      TEXT PRIMARY KEY,
        provider      TEXT NOT NULL,
        client_kind   TEXT NOT NULL,
        display_name  TEXT NOT NULL,
        created_at    TEXT NOT NULL
    );
    CREATE TABLE agent_sessions (
        session_id           TEXT PRIMARY KEY,
        agent_id             TEXT NOT NULL REFERENCES agents(agent_id),
        project_id           TEXT NOT NULL REFERENCES projects(project_id),
        label                TEXT NOT NULL,
        token_hash           TEXT NOT NULL UNIQUE,
        status               TEXT NOT NULL
            CHECK (status IN ('pending', 'requested', 'active', 'revoked', 'expired')),
        binding_version      INTEGER NOT NULL DEFAULT 1,
        pairing_expires_at   TEXT NOT NULL,
        claimed_client_kind  TEXT,
        claimed_cwd          TEXT,
        claimed_run_id       TEXT,
        external_session_id  TEXT,
        created_at           TEXT NOT NULL,
        requested_at         TEXT,
        approved_at          TEXT,
        revoked_at           TEXT,
        last_seen_at         TEXT
    );
    CREATE INDEX idx_agent_sessions_project ON agent_sessions(project_id, status);
    CREATE TABLE events (
        event_id         INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version   INTEGER NOT NULL,
        event_type       TEXT NOT NULL,
        occurred_at      TEXT NOT NULL,
        project_id       TEXT,
        conversation_id  TEXT,
        actor_id         TEXT,
        correlation_id   TEXT,
        entity_id        TEXT,
        payload          TEXT NOT NULL
    );
    )sql",
    // 002 - task conversations and which session instances may read or write them.
    R"sql(
    CREATE TABLE conversations (
        conversation_id  TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL REFERENCES projects(project_id),
        task_code        TEXT NOT NULL,
        title            TEXT NOT NULL,
        purpose          TEXT,
        status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'archived')),
        config_version   INTEGER NOT NULL DEFAULT 1,
        next_seq         INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL,
        UNIQUE (project_id, task_code)
    );
    CREATE TABLE conversation_members (
        conversation_id  TEXT NOT NULL REFERENCES conversations(conversation_id),
        session_id       TEXT NOT NULL REFERENCES agent_sessions(session_id),
        role             TEXT NOT NULL,
        can_read         INTEGER NOT NULL,
        can_write        INTEGER NOT NULL,
        added_at         TEXT NOT NULL,
        removed_at       TEXT,
        PRIMARY KEY (conversation_id, session_id)
    );
    CREATE INDEX idx_conversation_members_session ON conversation_members(session_id, removed_at);
    )sql",
    // 003 - messages with a per-conversation sequence and one receipt row per recipient.
    R"sql(
    CREATE TABLE messages (
        message_id           TEXT PRIMARY KEY,
        conversation_id      TEXT NOT NULL REFERENCES conversations(conversation_id),
        seq                  INTEGER NOT NULL,
        sender_kind          TEXT NOT NULL CHECK (sender_kind IN ('agent', 'operator', 'system')),
        sender_session_id    TEXT REFERENCES agent_sessions(session_id),
        kind                 TEXT NOT NULL
            CHECK (kind IN ('message', 'handoff', 'progress', 'artifact', 'decision', 'system')),
        body                 TEXT NOT NULL,
        payload              TEXT,
        reply_to_message_id  TEXT REFERENCES messages(message_id),
        directed             INTEGER NOT NULL,
        idempotency_key      TEXT,
        request_hash         TEXT,
        created_at           TEXT NOT NULL,
        UNIQUE (conversation_id, seq)
    );
    CREATE UNIQUE INDEX idx_messages_idempotency
        ON messages(sender_kind, COALESCE(sender_session_id, ''), idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    CREATE TABLE message_recipients (
        message_id       TEXT NOT NULL REFERENCES messages(message_id),
        session_id       TEXT NOT NULL REFERENCES agent_sessions(session_id),
        status           TEXT NOT NULL CHECK (status IN ('available', 'read', 'acknowledged')),
        read_at          TEXT,
        acknowledged_at  TEXT,
        PRIMARY KEY (message_id, session_id)
    );
    CREATE INDEX idx_message_recipients_inbox ON message_recipients(session_id, status);
    )sql",
    // 004 - progress reports and artifact references attached to timeline messages.
    R"sql(
    CREATE TABLE artifact_refs (
        artifact_id           TEXT PRIMARY KEY,
        conversation_id       TEXT NOT NULL REFERENCES conversations(conversation_id),
        project_id            TEXT NOT NULL REFERENCES projects(project_id),
        publisher_session_id  TEXT NOT NULL REFERENCES agent_sessions(session_id),
        message_id            TEXT NOT NULL REFERENCES messages(message_id),
        name                  TEXT NOT NULL,
        format                TEXT,
        direction             TEXT NOT NULL CHECK (direction IN ('input', 'output')),
        relative_path         TEXT NOT NULL,
        sha256                TEXT NOT NULL,
        size_bytes            INTEGER NOT NULL,
        row_count             INTEGER,
        unit                  TEXT,
        timezone              TEXT,
        summary               TEXT,
        version               INTEGER NOT NULL,
        created_at            TEXT NOT NULL
    );
    CREATE INDEX idx_artifact_refs_conversation ON artifact_refs(conversation_id, relative_path, version);
    CREATE TABLE progress_events (
        progress_id      TEXT PRIMARY KEY,
        message_id       TEXT NOT NULL REFERENCES messages(message_id),
        conversation_id  TEXT NOT NULL REFERENCES conversations(conversation_id),
        session_id       TEXT NOT NULL REFERENCES agent_sessions(session_id),
        stage            TEXT NOT NULL,
        run_state        TEXT NOT NULL
            CHECK (run_state IN ('running', 'waiting', 'completed', 'failed', 'cancelled')),
        source           TEXT NOT NULL
            CHECK (source IN ('agent_reported', 'adapter_observed', 'command_measured')),
        percent          REAL,
        count_done       INTEGER,
        count_total      INTEGER,
        summary          TEXT NOT NULL,
        created_at       TEXT NOT NULL
    );
    CREATE TABLE message_artifacts (
        message_id   TEXT NOT NULL REFERENCES messages(message_id),
        artifact_id  TEXT NOT NULL REFERENCES artifact_refs(artifact_id),
        PRIMARY KEY (message_id, artifact_id)
    );
    )sql",
    // 005 - collaboration surface: a goal per conversation, a shared task board,
    // per-member read cursors, forwarded-message provenance and agent proposals
    // for new conversations that an operator must approve.
    R"sql(
    ALTER TABLE conversations ADD COLUMN goal TEXT;
    ALTER TABLE conversations ADD COLUMN goal_updated_at TEXT;
    ALTER TABLE conversation_members ADD COLUMN read_seq INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE messages ADD COLUMN forwarded_from TEXT REFERENCES messages(message_id);
    CREATE TABLE tasks (
        task_id              TEXT PRIMARY KEY,
        conversation_id      TEXT NOT NULL REFERENCES conversations(conversation_id),
        number               INTEGER NOT NULL,
        title                TEXT NOT NULL,
        detail               TEXT,
        status               TEXT NOT NULL
            CHECK (status IN ('todo', 'doing', 'blocked', 'done', 'cancelled')),
        assignee_session_id  TEXT REFERENCES agent_sessions(session_id),
        created_by           TEXT REFERENCES agent_sessions(session_id),
        updated_by           TEXT REFERENCES agent_sessions(session_id),
        note                 TEXT,
        version              INTEGER NOT NULL DEFAULT 1,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL,
        UNIQUE (conversation_id, number)
    );
    CREATE INDEX idx_tasks_conversation ON tasks(conversation_id, status);
    CREATE TABLE conversation_proposals (
        proposal_id          TEXT PRIMARY KEY,
        project_id           TEXT NOT NULL REFERENCES projects(project_id),
        proposer_session_id  TEXT NOT NULL REFERENCES agent_sessions(session_id),
        task_code            TEXT NOT NULL,
        title                TEXT NOT NULL,
        purpose              TEXT,
        goal                 TEXT,
        member_session_ids   TEXT NOT NULL,
        status               TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
        conversation_id      TEXT REFERENCES conversations(conversation_id),
        created_at           TEXT NOT NULL,
        decided_at           TEXT
    );
    )sql",
    // 006 - default interconnection: installation settings, the kind of a
    // conversation (topic, lobby, direct) and whether a session takes part.
    R"sql(
    CREATE TABLE settings (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
    );
    ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'topic'
        CHECK (kind IN ('topic', 'lobby', 'direct'));
    ALTER TABLE agent_sessions ADD COLUMN linked INTEGER NOT NULL DEFAULT 1;
    )sql",
    // 007 - why a membership ended, so only what the link switch took away is
    // given back by it; service-opened conversations move to the reserved "@"
    // codes; read cursors that were pushed past the end are pulled back.
    R"sql(
    ALTER TABLE conversation_members ADD COLUMN removed_reason TEXT;
    UPDATE conversations SET task_code = '@lobby' WHERE kind = 'lobby';
    UPDATE conversations SET task_code = '@dm-' || lower(substr(task_code, 4)) WHERE kind = 'direct';
    UPDATE conversation_members SET read_seq = MIN(read_seq,
        (SELECT c.next_seq - 1 FROM conversations c WHERE c.conversation_id = conversation_members.conversation_id));
    )sql",
    // 008 - bot control: requests one session queues for the session that hosts
    // bots, and when a session last listened for them.
    R"sql(
    CREATE TABLE bot_requests (
        request_id            TEXT PRIMARY KEY,
        project_id            TEXT NOT NULL REFERENCES projects(project_id),
        requester_session_id  TEXT NOT NULL REFERENCES agent_sessions(session_id),
        host_session_id       TEXT NOT NULL REFERENCES agent_sessions(session_id),
        action                TEXT NOT NULL,
        bot                   TEXT,
        text                  TEXT,
        status                TEXT NOT NULL CHECK (status IN ('held', 'queued', 'taken', 'done', 'failed', 'rejected')),
        hold_reason           TEXT,
        result                TEXT,
        idempotency_key       TEXT NOT NULL,
        seen_by_requester     INTEGER NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL,
        taken_at              TEXT,
        finished_at           TEXT,
        UNIQUE (requester_session_id, idempotency_key)
    );
    CREATE INDEX bot_requests_by_host ON bot_requests (host_session_id, status, created_at);
    CREATE INDEX bot_requests_by_requester ON bot_requests (requester_session_id, created_at);
    ALTER TABLE agent_sessions ADD COLUMN host_seen_at TEXT;
    CREATE INDEX messages_by_sender_time ON messages (sender_session_id, created_at);
    )sql",
    // 009 - wake hooks: where to signal a session that work is waiting, and what
    // became of each signal.
    R"sql(
    CREATE TABLE wake_hooks (
        session_id       TEXT PRIMARY KEY REFERENCES agent_sessions(session_id),
        url              TEXT NOT NULL,
        key              TEXT NOT NULL,
        enabled          INTEGER NOT NULL DEFAULT 1,
        test_requested   INTEGER NOT NULL DEFAULT 0,
        last_attempt_at  TEXT,
        last_status      TEXT,
        last_detail      TEXT,
        last_ok_at       TEXT
    );
    CREATE TABLE wake_attempts (
        attempt_id   INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT NOT NULL REFERENCES agent_sessions(session_id),
        created_at   TEXT NOT NULL,
        reason       TEXT NOT NULL,
        status       TEXT NOT NULL,
        http_status  INTEGER,
        detail       TEXT
    );
    CREATE INDEX wake_attempts_by_session ON wake_attempts (session_id, created_at);
    )sql",
    // 010 - delivery through a wake hook: whether the signal carries the waiting
    // instructions themselves, and which signal carried a request.
    R"sql(
    ALTER TABLE wake_hooks ADD COLUMN include_text INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE bot_requests ADD COLUMN delivery_attempt_id INTEGER;
    )sql",
    // 011 - a session may be exempt from the flood limits (the bot host is, by
    // default), and each bridge reports how many tools it offers so a client
    // that still runs an older bridge can be recognised.
    R"sql(
    ALTER TABLE agent_sessions ADD COLUMN rate_exempt INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_sessions ADD COLUMN bridge_tools INTEGER;
    UPDATE agent_sessions SET rate_exempt = 1 WHERE agent_id = 'agt_grok';
    )sql",
    // 012 - what a wake signal has already announced, by row position rather than
    // by time, so work created in the same instant as a signal is neither missed
    // nor announced twice.
    R"sql(
    ALTER TABLE wake_hooks ADD COLUMN seen_request_rowid INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE wake_hooks ADD COLUMN seen_message_rowid INTEGER NOT NULL DEFAULT 0;
    )sql",
    // 013 - delivery into a client's own conversation: messages may be marked
    // urgent; each session records when its client last ran one of our hooks and
    // what those hooks have already put in front of the model; and what became of
    // every urgent delivery.
    R"sql(
    ALTER TABLE messages ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_sessions ADD COLUMN urgent_dispatch INTEGER NOT NULL DEFAULT 1;
    CREATE TABLE client_hooks (
        session_id      TEXT PRIMARY KEY REFERENCES agent_sessions(session_id),
        client          TEXT NOT NULL DEFAULT '',
        event           TEXT NOT NULL,
        seen_at         TEXT NOT NULL,
        client_session  TEXT,
        cwd             TEXT,
        runs            INTEGER NOT NULL DEFAULT 0,
        shown_rowid     INTEGER NOT NULL DEFAULT 0,
        urgent_rowid    INTEGER NOT NULL DEFAULT 0,
        watch_seen_at   TEXT,
        watch_session   TEXT
    );
    CREATE TABLE deliveries (
        delivery_id  INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT NOT NULL REFERENCES agent_sessions(session_id),
        created_at   TEXT NOT NULL,
        route        TEXT NOT NULL CHECK (route IN ('start', 'prompt', 'stop', 'watch', 'command')),
        status       TEXT NOT NULL CHECK (status IN ('running', 'ok', 'failed')),
        upto_rowid   INTEGER NOT NULL,
        messages     INTEGER NOT NULL,
        urgent       INTEGER NOT NULL,
        detail       TEXT
    );
    CREATE INDEX deliveries_by_session ON deliveries (session_id, created_at);
    )sql",
    // 014 - telling an out-of-date bridge from a current one: which sessions
    // come through a bridge at all (they registered themselves), and which
    // version of the tool contract that bridge offered when it started. A bridge
    // from before these columns reports neither.
    R"sql(
    ALTER TABLE agent_sessions ADD COLUMN self_enrolled INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_sessions ADD COLUMN bridge_contract INTEGER;
    UPDATE agent_sessions SET self_enrolled = 1 WHERE session_id IN (
        SELECT entity_id FROM events WHERE event_type = 'pairing.created' AND payload LIKE '%"self_enrolled":true%');
    )sql",
};

}  // namespace

Statement::Statement(sqlite3* connection, std::string_view sql) {
    if (sqlite3_prepare_v2(connection, sql.data(), static_cast<int>(sql.size()), &handle_, nullptr) != SQLITE_OK) {
        throw_sqlite(connection, "prepare");
    }
}

Statement::~Statement() {
    sqlite3_finalize(handle_);
}

void Statement::bind(int index, std::string_view value) {
    if (sqlite3_bind_text(handle_, index, value.data(), static_cast<int>(value.size()), SQLITE_TRANSIENT) !=
        SQLITE_OK) {
        throw_sqlite(sqlite3_db_handle(handle_), "bind text");
    }
}

void Statement::bind(int index, std::int64_t value) {
    if (sqlite3_bind_int64(handle_, index, value) != SQLITE_OK) {
        throw_sqlite(sqlite3_db_handle(handle_), "bind integer");
    }
}

void Statement::bind(int index, double value) {
    if (sqlite3_bind_double(handle_, index, value) != SQLITE_OK) {
        throw_sqlite(sqlite3_db_handle(handle_), "bind real");
    }
}

void Statement::bind(int index, std::nullptr_t) {
    if (sqlite3_bind_null(handle_, index) != SQLITE_OK) {
        throw_sqlite(sqlite3_db_handle(handle_), "bind null");
    }
}

bool Statement::step() {
    const int result = sqlite3_step(handle_);
    if (result == SQLITE_ROW) {
        return true;
    }
    if (result != SQLITE_DONE) {
        throw_sqlite(sqlite3_db_handle(handle_), "step");
    }
    return false;
}

bool Statement::is_null(int column) const {
    return sqlite3_column_type(handle_, column) == SQLITE_NULL;
}

std::string Statement::text(int column) const {
    const auto* bytes = sqlite3_column_text(handle_, column);
    return bytes == nullptr
               ? std::string()
               : std::string(reinterpret_cast<const char*>(bytes),
                             static_cast<std::size_t>(sqlite3_column_bytes(handle_, column)));
}

std::optional<std::string> Statement::optional_text(int column) const {
    return is_null(column) ? std::nullopt : std::optional<std::string>(text(column));
}

std::int64_t Statement::integer(int column) const {
    return sqlite3_column_int64(handle_, column);
}

std::optional<std::int64_t> Statement::optional_integer(int column) const {
    return is_null(column) ? std::nullopt : std::optional<std::int64_t>(integer(column));
}

std::optional<double> Statement::optional_real(int column) const {
    return is_null(column) ? std::nullopt : std::optional<double>(sqlite3_column_double(handle_, column));
}

Database::Database(const std::filesystem::path& file) {
    if (file.has_parent_path()) {
        std::filesystem::create_directories(file.parent_path());
    }
    // u8string keeps non-ASCII Windows paths intact; SQLite expects UTF-8.
    const auto utf8 = file.u8string();
    if (sqlite3_open_v2(reinterpret_cast<const char*>(utf8.c_str()), &connection_,
                        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nullptr) != SQLITE_OK) {
        const std::string reason = connection_ != nullptr ? sqlite3_errmsg(connection_) : "out of memory";
        sqlite3_close(connection_);
        throw std::runtime_error("cannot open database " + file.string() + ": " + reason);
    }
    sqlite3_busy_timeout(connection_, 5000);
    script("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    migrate();
}

Database::~Database() {
    sqlite3_close(connection_);
}

void Database::script(const char* sql) {
    char* message = nullptr;
    if (sqlite3_exec(connection_, sql, nullptr, nullptr, &message) != SQLITE_OK) {
        const std::string reason = message != nullptr ? message : "unknown error";
        sqlite3_free(message);
        throw std::runtime_error("SQLite exec failed: " + reason);
    }
}

int Database::schema_version() {
    Statement statement = query("PRAGMA user_version");
    statement.step();
    return static_cast<int>(statement.integer(0));
}

void Database::migrate() {
    const int applied = schema_version();
    const int known = static_cast<int>(std::size(kMigrations));
    if (applied > known) {
        throw std::runtime_error("database schema version " + std::to_string(applied) +
                                 " is newer than this build supports (" + std::to_string(known) + ")");
    }
    for (int index = applied; index < known; ++index) {
        // Each migration and its version bump commit together or not at all.
        transaction([&] {
            script(kMigrations[index]);
            script(("PRAGMA user_version = " + std::to_string(index + 1)).c_str());
        });
    }
}

}  // namespace acm
