// Append-only log of committed events. Writers append inside the business
// transaction; the console replays by monotonically increasing event_id.
#pragma once

#include "common.hpp"
#include "database.hpp"

namespace acm {

struct EventScope {
    std::optional<std::string> project_id;
    std::optional<std::string> conversation_id;
    std::optional<std::string> actor_id;
    std::optional<std::string> correlation_id;
};

class EventLog {
public:
    EventLog(Database& database, Clock clock) : database_(database), clock_(std::move(clock)) {}

    // Must be called inside the caller's open transaction.
    std::int64_t append(std::string_view event_type, const EventScope& scope, std::string_view entity_id,
                        const json& payload);

    // Events with event_id > `after`, oldest first, at most `limit`.
    json read_after(std::int64_t after, std::int64_t limit);

    // Highest committed event_id, 0 when the log is empty.
    std::int64_t watermark();

private:
    Database& database_;
    Clock clock_;
};

}  // namespace acm
