#include "event_log.hpp"

namespace acm {

namespace {
constexpr int kEventSchemaVersion = 1;

json nullable(const std::optional<std::string>& value) {
    return value ? json(*value) : json(nullptr);
}
}  // namespace

std::int64_t EventLog::append(std::string_view event_type, const EventScope& scope, std::string_view entity_id,
                              const json& payload) {
    database_.execute(
        "INSERT INTO events (schema_version, event_type, occurred_at, project_id, conversation_id, actor_id, "
        "correlation_id, entity_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        kEventSchemaVersion, event_type, to_rfc3339(clock_()), scope.project_id, scope.conversation_id,
        scope.actor_id, scope.correlation_id, entity_id, payload.dump());
    return database_.last_insert_rowid();
}

json EventLog::read_after(std::int64_t after, std::int64_t limit) {
    json events = json::array();
    Statement rows = database_.query(
        "SELECT event_id, schema_version, event_type, occurred_at, project_id, conversation_id, actor_id, "
        "correlation_id, entity_id, payload FROM events WHERE event_id > ? ORDER BY event_id LIMIT ?",
        after, limit);
    while (rows.step()) {
        events.push_back({{"event_id", rows.integer(0)},
                          {"schema_version", rows.integer(1)},
                          {"event_type", rows.text(2)},
                          {"occurred_at", rows.text(3)},
                          {"project_id", nullable(rows.optional_text(4))},
                          {"conversation_id", nullable(rows.optional_text(5))},
                          {"actor_id", nullable(rows.optional_text(6))},
                          {"correlation_id", nullable(rows.optional_text(7))},
                          {"entity_id", rows.text(8)},
                          {"payload", json::parse(rows.text(9))}});
    }
    return events;
}

std::int64_t EventLog::watermark() {
    Statement row = database_.query("SELECT COALESCE(MAX(event_id), 0) FROM events");
    row.step();
    return row.integer(0);
}

}  // namespace acm
